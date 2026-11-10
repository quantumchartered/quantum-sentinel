import type { FailureFacts, Finality } from "./transfer-history.js";

/**
 * The deterministic WAIT / REPLACE / ESCALATE rule. Code decides; the LLM only
 * explains (AGENTS.md §5–6). Every outcome carries machine-readable reason codes
 * so the UI and Decision Replay can show exactly why.
 */

export const POLICY_VERSION = "policy-2026-11-10.1";

/**
 * Airwallex's documented payout failure codes ("Transfer failure reasons"), as the
 * cause names the simulation docs map them from. The code is the precise provider
 * fact: in the sandbox every failure carries `details.type` INCORRECT_ROUTING
 * whatever the cause (verified 2026-11-10, fixtures/sandbox), while the code and
 * message match the documented table. Undocumented codes are not mapped.
 */
export const DOCUMENTED_FAILURE_CODES: Readonly<Record<string, string>> = {
  "90101": "INVALID_ACCOUNT_NAME_OR_NUMBER",
  "90201": "INVALID_BANK_OR_BRANCH_CODE",
  "90202": "INVALID_SWIFT_BIC_CODE",
  "90203": "INVALID_CORRESPONDENT_BANK_INFORMATION",
  "90204": "INVALID_BANK_INFORMATION",
  "90301": "BENEFICIARY_NAME_MISMATCH",
  "90302": "ACCOUNT_CURRENCY_MISMATCH",
  "90401": "INVALID_BENEFICIARY_DETAILS",
  "90402": "INVALID_SPECIAL_CHARACTER",
  "90501": "CHANNEL_POLICY",
  "90502": "TM_SUSPENDED",
  "90604": "INSUFFICIENT_FUNDS",
  "90701": "ACCOUNT_CLOSED",
  "90702": "ACCOUNT_INACTIVE_OR_DORMANT",
  "90703": "ACCOUNT_UNDER_RESTRICTION",
  "90801": "BENEFICIARY_REQUESTED",
  "90802": "BENEFICIARY_BANK_RETURNED",
  "91001": "RECALL_REQUESTED",
  "91002": "CLIENT_REQUESTED",
  "91101": "INVALID_PAYMENT_PURPOSE",
  "91401": "SYSTEM_ERROR",
  "91402": "CHANNEL_TIMEOUT",
  "99901": "UNABLE_TO_APPLY",
  "99902": "OTHER",
};

/** The cause of a failure: its documented code if it has one, otherwise its recorded type. */
export function failureCause(f: Pick<FailureFacts, "code" | "type"> | null | undefined): string | null {
  if (!f) return null;
  return (f.code ? DOCUMENTED_FAILURE_CODES[f.code] : undefined) ?? f.type ?? null;
}

/**
 * Failure types after which a replacement to the SAME beneficiary details may be
 * proposed. Every other documented type escalates to a person:
 * - wrong, closed, dormant, restricted or mismatched account details: re-sending
 *   would fail again, and correcting details is a bank-detail change;
 * - RECALL_REQUESTED / CLIENT_REQUESTED / BENEFICIARY_REQUESTED: someone stopped it on purpose;
 * - DUPLICATION_RETURN: the bank believes this was already paid;
 * - compliance and limits (TM_SUSPENDED, CHANNEL_POLICY, EXCEEDED_..., TRANSACTION_AMOUNT_NOT_COVERING_FEE);
 * - OTHER / UNABLE_TO_APPLY and anything undocumented: unknown cause.
 * BENEFICIARY_BANK_RETURNED is replaceable per the builder guide's Kit 3 flow; the
 * executor still re-checks the beneficiary's bank details before sending.
 */
export const REPLACEABLE_FAILURE_TYPES: ReadonlySet<string> = new Set([
  "BENEFICIARY_BANK_RETURNED",
  "CHANNEL_TIMEOUT",
  "SYSTEM_ERROR",
  "INSUFFICIENT_FUNDS",
]);

export type RiskFlag =
  /** Supplier asked to pay a different account. Always escalates (invariant 13). */
  | "BANK_DETAIL_CHANGE_REQUEST"
  /** Untrusted text tried to instruct the agent. */
  | "PROMPT_INJECTION_SUSPECTED"
  /** Beneficiary details at the provider differ from what the obligation was approved with. */
  | "BENEFICIARY_MISMATCH"
  /** Evidence sources contradict each other. */
  | "EVIDENCE_CONFLICT";

export interface DecisionInput {
  /** Finality of the original transfer, from the transfer history fold. */
  original: Finality;
  obligation: { amountMinor: bigint; currency: string; dueAt: string };
  /** Payments other than the original that still block the obligation (pending, uncertain, in flight or paid). */
  otherBlockingPayments: number;
  /** Fresh available balance in the obligation currency. null = could not read it. */
  availableMinor: bigint | null;
  /** Fee the replacement will cost, in the same currency. */
  replacementFeeMinor: bigint;
  /** Organisation policy: money that must stay in the wallet. */
  reserveFloorMinor: bigint;
  riskFlags: readonly RiskFlag[];
  now: string;
}

export type Decision =
  | { recommendation: "WAIT"; reasons: string[]; replacementAllowed: false }
  | { recommendation: "REPLACE"; reasons: string[]; replacementAllowed: true }
  | { recommendation: "ESCALATE"; reasons: string[]; replacementAllowed: false };

const escalate = (...reasons: string[]): Decision => ({ recommendation: "ESCALATE", reasons, replacementAllowed: false });

export function decide(input: DecisionInput): Decision {
  // 1. Risk flags win over everything, including a confirmed failure.
  if (input.riskFlags.length > 0) {
    return escalate(...input.riskFlags.map((f) => `risk:${f}`));
  }

  // 2. Finality of the original. Only a confirmed failure can ever unlock a replacement.
  const o = input.original;
  // We hold no provider record at all: we cannot tell whether money moved. A person must look.
  if (o.kind === "IN_FLIGHT" && o.status === null) return escalate("original:no_provider_record");
  switch (o.kind) {
    case "IN_FLIGHT":
    case "PAID_NOT_FINAL": {
      const overdue = Date.parse(input.now) > Date.parse(input.obligation.dueAt);
      return {
        recommendation: "WAIT",
        reasons: [
          o.kind === "PAID_NOT_FINAL" ? "original:paid_not_final" : `original:in_flight:${o.status ?? "unknown"}`,
          "replacement_would_risk_double_payment",
          ...(overdue ? ["deadline_passed_but_original_may_still_arrive"] : []),
        ],
        replacementAllowed: false,
      };
    }
    case "CANCELLED_WITHOUT_REASON":
      return escalate("original:cancelled_without_failure_reason");
    case "FAILED_AFTER_PAID":
      return escalate("original:failed_after_paid");
    case "CONFLICT":
      return escalate("original:conflicting_history", ...o.conflicts.map((c) => `conflict:${c}`));
    case "CONFIRMED_FAILED": {
      // Invariant 2: the failure's cause must be recorded (e.g. a bare "simulation" reason is not enough).
      const cause = failureCause(o.failure);
      if (!cause) return escalate("original:failure_type_missing");
      // Only some failures make re-sending the same payment to the same, unchanged beneficiary sensible.
      if (!REPLACEABLE_FAILURE_TYPES.has(cause)) return escalate(`original:failure_requires_review:${cause}`);
      break;
    }
  }

  // 3. Duplicate fence: nothing else may be pending or paid for this obligation.
  if (input.otherBlockingPayments > 0) {
    return escalate("duplicate_fence:another_payment_blocks_obligation");
  }

  // 4. Funds, including the fee and the reserve floor.
  if (input.availableMinor === null) return escalate("balance:unavailable");
  const needed = input.obligation.amountMinor + input.replacementFeeMinor + input.reserveFloorMinor;
  if (input.availableMinor < needed) {
    return escalate(`balance:insufficient:need_${needed}_have_${input.availableMinor}`);
  }

  return {
    recommendation: "REPLACE",
    reasons: [
      `original:confirmed_failed:${failureCause(o.failure) ?? "type_unknown"}`,
      "duplicate_fence:clear",
      "balance:sufficient",
    ],
    replacementAllowed: true,
  };
}
