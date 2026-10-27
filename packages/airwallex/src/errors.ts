import { ErrorBodySchema } from "./schemas.js";

export class AirwallexConfigError extends Error {
  override name = "AirwallexConfigError";
}

/** The provider answered with a non-2xx status. The outcome is known: it was rejected. */
export class AirwallexApiError extends Error {
  override name = "AirwallexApiError";
  readonly status: number;
  readonly code: string | undefined;
  readonly source: string | undefined;
  readonly traceId: string | undefined;
  readonly details: unknown;

  constructor(status: number, body: unknown, path: string) {
    const parsed = ErrorBodySchema.safeParse(body);
    const b = parsed.success ? parsed.data : {};
    super(`Airwallex ${status} on ${path}: ${b.code ?? "unknown_error"}${b.message ? ` - ${b.message}` : ""}`);
    this.status = status;
    this.code = b.code;
    this.source = b.source;
    this.traceId = b.trace_id;
    this.details = b.details;
  }
}

/**
 * We do not know whether a mutating request took effect (network error,
 * timeout, or 5xx after sending). Callers must reconcile, never blindly
 * create a new resource.
 */
export class AirwallexUncertainOutcomeError extends Error {
  override name = "AirwallexUncertainOutcomeError";
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`Outcome of ${path} is unknown; reconcile before acting again`, { cause });
    this.path = path;
  }
}

/** Response did not match the documented contract. Fail closed. */
export class AirwallexContractError extends Error {
  override name = "AirwallexContractError";
  readonly path: string;
  readonly issues: unknown;
  constructor(path: string, issues: unknown) {
    super(`Response from ${path} does not match the expected contract`);
    this.path = path;
    this.issues = issues;
  }
}

/**
 * The docs spell the duplicate-request error several ways:
 * `request_id_duplicate` (legacy and transfer reference), `duplicate_request_id`
 * (since 2025-04-25), `duplicate_request` (issuing). All mean: an earlier
 * request with this ID exists, so reconcile with it.
 */
const DUPLICATE_CODES = new Set(["request_id_duplicate", "duplicate_request_id", "duplicate_request"]);

export function isDuplicateRequestError(err: unknown): err is AirwallexApiError {
  return err instanceof AirwallexApiError && err.code !== undefined && DUPLICATE_CODES.has(err.code);
}

/** 409 `request_pending`: the same request_id is still being processed. */
export function isRequestPendingError(err: unknown): err is AirwallexApiError {
  return err instanceof AirwallexApiError && err.status === 409 && err.code === "request_pending";
}

export function isInsufficientFundsError(err: unknown): err is AirwallexApiError {
  return err instanceof AirwallexApiError && err.code === "balance_insufficient";
}
