import { randomUUID } from "node:crypto";
import {
  type Currency,
  CurrencySchema,
  type Money,
  majorToMinor,
  minorToMajor,
} from "@sentinel/contracts";
import {
  AirwallexContractError,
  AirwallexUncertainOutcomeError,
  isDuplicateRequestError,
  isRequestPendingError,
} from "./errors.js";
import { AirwallexHttp, type AirwallexHttpOptions } from "./http.js";
import {
  BalancesSchema,
  GlobalAccountListSchema,
  GlobalAccountSchema,
  KNOWN_TRANSFER_STATUSES,
  type KnownTransferStatus,
  type RawTransfer,
  RequestIdSchema,
  TransferListSchema,
  TransferSchema,
} from "./schemas.js";
import { z } from "zod";

/** A fresh request_id for a NEW payment attempt. Never call this to "retry". */
export function newRequestId(): string {
  return randomUUID(); // 36 chars, inside the documented 10-50 range
}

export interface NormalizedFailure {
  /** Where the failure facts came from in the payload. */
  shape: "failure_object" | "legacy_fields";
  code: string | null;
  message: string | null;
  /** e.g. BENEFICIARY_BANK_RETURNED */
  type: string | null;
  reasonCodes: string[];
}

export interface TransferSnapshot {
  providerTransferId: string;
  requestId: string;
  /** Raw provider status string, exactly as received. */
  rawStatus: string;
  /** Known status, or UNKNOWN which callers must treat as blocking. */
  status: KnownTransferStatus | "UNKNOWN";
  amount: Money;
  feeAmountMinor: bigint | null;
  feeCurrency: string | null;
  beneficiaryId: string | null;
  failure: NormalizedFailure | null;
  updatedAt: string | null;
  raw: RawTransfer;
}

function nonEmpty(s: string | null | undefined): string | null {
  return s === undefined || s === null || s === "" ? null : s;
}

export function normalizeFailure(t: RawTransfer): NormalizedFailure | null {
  const f = t.failure;
  if (f && (f.code || f.message || f.details?.type || f.details?.reason_codes?.length)) {
    return {
      shape: "failure_object",
      code: nonEmpty(f.code),
      message: nonEmpty(f.message),
      type: nonEmpty(f.details?.type),
      reasonCodes: f.details?.reason_codes ?? [],
    };
  }
  if (nonEmpty(t.failure_type) || nonEmpty(t.failure_reason)) {
    return {
      shape: "legacy_fields",
      code: null,
      message: nonEmpty(t.failure_reason),
      type: nonEmpty(t.failure_type),
      reasonCodes: [],
    };
  }
  return null;
}

export function normalizeTransfer(t: RawTransfer): TransferSnapshot {
  const currency = CurrencySchema.safeParse(t.transfer_currency);
  if (!currency.success) {
    throw new AirwallexContractError("transfer", `unsupported transfer_currency ${t.transfer_currency}`);
  }
  const status = (KNOWN_TRANSFER_STATUSES as readonly string[]).includes(t.status)
    ? (t.status as KnownTransferStatus)
    : "UNKNOWN";
  const feeCurrency = nonEmpty(t.fee_currency);
  const feeCur = feeCurrency ? CurrencySchema.safeParse(feeCurrency) : undefined;
  return {
    providerTransferId: t.id,
    requestId: t.request_id,
    rawStatus: t.status,
    status,
    amount: { amountMinor: majorToMinor(t.transfer_amount, currency.data), currency: currency.data },
    feeAmountMinor:
      t.fee_amount !== undefined && feeCur?.success ? majorToMinor(t.fee_amount, feeCur.data) : null,
    feeCurrency,
    beneficiaryId: nonEmpty(t.beneficiary_id),
    failure: normalizeFailure(t),
    updatedAt: nonEmpty(t.updated_at),
    raw: t,
  };
}

export interface CreateTransferInput {
  requestId: string;
  beneficiaryId: string;
  amount: Money;
  sourceCurrency: Currency;
  transferMethod: "LOCAL" | "SWIFT";
  reason: string;
  reference: string;
}

export interface CreateTransferResult {
  transfer: TransferSnapshot;
  /** True when Airwallex reported the request_id as already used and we reconciled to the existing transfer. */
  reconciled: boolean;
}

export interface CurrentBalance {
  currency: Currency;
  availableMinor: bigint;
  pendingMinor: bigint;
  reservedMinor: bigint;
}

/**
 * Typed Airwallex sandbox client. Converts major units to minor units at this
 * boundary only. Sandbox simulation calls live in ./simulation.ts.
 */
export class AirwallexClient {
  readonly http: AirwallexHttp;

  constructor(options: AirwallexHttpOptions | AirwallexHttp) {
    this.http = options instanceof AirwallexHttp ? options : new AirwallexHttp(options);
  }

  async getTransfer(id: string): Promise<TransferSnapshot> {
    const raw = await this.http.request(TransferSchema, {
      method: "GET",
      path: `/api/v1/transfers/${encodeURIComponent(id)}`,
      retry: "read",
    });
    return normalizeTransfer(raw);
  }

  /** Reconciliation lookup: the transfer (if any) created with this request_id. */
  async findTransferByRequestId(requestId: string): Promise<TransferSnapshot | null> {
    // `page=0` lifts the default 30-day window per the List Transfers reference.
    const list = await this.http.request(TransferListSchema, {
      method: "GET",
      path: "/api/v1/transfers",
      retry: "read",
      query: { request_id: requestId, page: "0" },
    });
    const matches = list.items.filter((t) => t.request_id === requestId);
    if (matches.length > 1) {
      throw new AirwallexContractError("/api/v1/transfers", `request_id ${requestId} matched ${matches.length} transfers`);
    }
    return matches[0] ? normalizeTransfer(matches[0]) : null;
  }

  /**
   * Create a transfer. Retries reuse the identical body and request_id. If
   * Airwallex reports the request_id as already used, we look up that transfer
   * and return it only if it matches this exact intent; otherwise we throw.
   */
  async createTransfer(input: CreateTransferInput): Promise<CreateTransferResult> {
    RequestIdSchema.parse(input.requestId);
    if (input.amount.amountMinor <= 0n) throw new RangeError("transfer amount must be positive");
    const path = "/api/v1/transfers/create";
    const body = JSON.stringify({
      request_id: input.requestId,
      beneficiary_id: input.beneficiaryId,
      transfer_amount: minorToMajor(input.amount.amountMinor, input.amount.currency),
      transfer_currency: input.amount.currency,
      source_currency: input.sourceCurrency,
      transfer_method: input.transferMethod,
      reason: input.reason,
      reference: input.reference,
    });
    try {
      const raw = await this.http.request(TransferSchema, { method: "POST", path, retry: "keyed", body });
      return { transfer: this.assertMatches(normalizeTransfer(raw), input), reconciled: false };
    } catch (err) {
      if (isDuplicateRequestError(err) || isRequestPendingError(err) || err instanceof AirwallexUncertainOutcomeError) {
        const existing = await this.findTransferByRequestId(input.requestId);
        if (existing) return { transfer: this.assertMatches(existing, input), reconciled: true };
        // Still unknown (e.g. timeout before the provider stored it). Caller keeps the lock and retries later.
        if (err instanceof AirwallexUncertainOutcomeError) throw err;
        throw new AirwallexUncertainOutcomeError(path, err);
      }
      throw err;
    }
  }

  private assertMatches(t: TransferSnapshot, input: CreateTransferInput): TransferSnapshot {
    const ok =
      t.requestId === input.requestId &&
      t.amount.currency === input.amount.currency &&
      t.amount.amountMinor === input.amount.amountMinor &&
      (t.beneficiaryId === null || t.beneficiaryId === input.beneficiaryId);
    if (!ok) {
      throw new AirwallexContractError(
        "/api/v1/transfers/create",
        `provider transfer ${t.providerTransferId} does not match the requested intent`,
      );
    }
    return t;
  }

  async getCurrentBalances(): Promise<CurrentBalance[]> {
    const rows = await this.http.request(BalancesSchema, {
      method: "GET",
      path: "/api/v1/balances/current",
      retry: "read",
      query: { account_type: "cash" },
    });
    const out: CurrentBalance[] = [];
    for (const r of rows) {
      const c = CurrencySchema.safeParse(r.currency);
      if (!c.success) continue; // currencies outside our allowlist are ignored, not guessed
      out.push({
        currency: c.data,
        availableMinor: r.available_amount === undefined ? 0n : majorToMinor(r.available_amount, c.data),
        pendingMinor: r.pending_amount === undefined ? 0n : majorToMinor(r.pending_amount, c.data),
        reservedMinor: r.reserved_amount === undefined ? 0n : majorToMinor(r.reserved_amount, c.data),
      });
    }
    return out;
  }

  async listGlobalAccounts(): Promise<z.infer<typeof GlobalAccountListSchema>["items"]> {
    const res = await this.http.request(GlobalAccountListSchema, {
      method: "GET",
      path: "/api/v1/global_accounts",
      retry: "read",
    });
    return res.items;
  }

  async createGlobalAccount(input: {
    requestId: string;
    countryCode: string;
    currency: Currency;
    transferMethod: "LOCAL" | "SWIFT";
  }): Promise<z.infer<typeof GlobalAccountSchema>> {
    RequestIdSchema.parse(input.requestId);
    return this.http.request(GlobalAccountSchema, {
      method: "POST",
      path: "/api/v1/global_accounts/create",
      retry: "keyed",
      body: JSON.stringify({
        request_id: input.requestId,
        country_code: input.countryCode,
        required_features: [{ currency: input.currency, transfer_method: input.transferMethod }],
      }),
    });
  }

  /** Returns the generated schema as-is; it drives beneficiary payload construction. */
  async generateBeneficiarySchema(params: {
    bank_country_code: string;
    account_currency: Currency;
    transfer_method: "LOCAL" | "SWIFT";
    entity_type: "COMPANY" | "PERSONAL";
    local_clearing_system?: string;
  }): Promise<unknown> {
    const { json } = await this.http.requestRaw({
      method: "POST",
      path: "/api/v1/beneficiary_api_schemas/generate",
      retry: "read", // schema generation has no side effects
      body: JSON.stringify({ ...params, type: "BANK_ACCOUNT" }),
    });
    return json;
  }

  /**
   * Read a beneficiary (`GET /api/v1/beneficiaries/{id}`, listed in the official
   * changelog). Returned raw until a sandbox fixture pins its shape.
   */
  async getBeneficiary(id: string): Promise<unknown> {
    const { json } = await this.http.requestRaw({
      method: "GET",
      path: `/api/v1/beneficiaries/${encodeURIComponent(id)}`,
      retry: "read",
    });
    return json;
  }

  /**
   * Create a beneficiary. No documented dedup key, so it is never retried
   * automatically; an ambiguous failure throws AirwallexUncertainOutcomeError.
   * The response is returned raw until a sandbox fixture pins its shape.
   */
  async createBeneficiary(body: Record<string, unknown>): Promise<unknown> {
    const { json } = await this.http.requestRaw({
      method: "POST",
      path: "/api/v1/beneficiaries/create",
      retry: "unkeyed",
      body: JSON.stringify(body),
    });
    return json;
  }
}
