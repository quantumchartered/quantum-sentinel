import type { Finality } from "./transfer-history.js";

/**
 * The deterministic WAIT / REPLACE / ESCALATE rule. Code decides; the LLM only
 * explains (AGENTS.md §5–6). Every outcome carries machine-readable reason codes
 * so the UI and Decision Replay can show exactly why.
 */

export const POLICY_VERSION = "policy-2026-10-27.1";

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
    case "CONFIRMED_FAILED":
      break;
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
      `original:confirmed_failed:${o.failure.type ?? "type_unknown"}`,
      "duplicate_fence:clear",
      "balance:sufficient",
    ],
    replacementAllowed: true,
  };
}
