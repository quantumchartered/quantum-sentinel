/** Plain-English text for the deterministic policy's reason codes (packages/policy/src/decide.ts). */

const EXACT: Record<string, string> = {
  replacement_would_risk_double_payment: "Sending a replacement now could pay the supplier twice.",
  deadline_passed_but_original_may_still_arrive: "The deadline has passed, but the original can still arrive.",
  "duplicate_fence:clear": "No other payment is pending for this invoice.",
  "duplicate_fence:another_payment_blocks_obligation": "Another payment is still pending for this invoice.",
  "balance:sufficient": "The wallet covers the amount plus fees.",
  "balance:unavailable": "The wallet balance could not be read.",
  "original:paid_not_final": "The provider reports PAID, which can still fail later.",
  "original:cancelled_without_failure_reason": "The transfer was cancelled but no failure reason was captured.",
  "original:failure_type_missing": "The failure has no recorded type, so it is not proof of what happened.",
  "original:failed_after_paid": "The transfer failed after it had been PAID.",
  "original:conflicting_history": "The transfer's history is contradictory.",
  "risk:BANK_DETAIL_CHANGE_REQUEST": "The supplier asked to pay a different bank account.",
  "risk:PROMPT_INJECTION_SUSPECTED": "A supplier message contains instructions aimed at the system.",
  "risk:BENEFICIARY_MISMATCH": "The beneficiary's bank details differ from what was approved.",
  "risk:EVIDENCE_CONFLICT": "Evidence sources contradict each other (for example the supplier says the money arrived).",
  "original:no_provider_record": "Sentinel holds no provider record of the original transfer, so it cannot tell whether money moved.",
  four_eyes_approver_is_proposer: "You proposed this payment, so someone else must approve it.",
};

export function explainReason(code: string): string {
  if (EXACT[code]) return EXACT[code]!;
  if (code.startsWith("original:in_flight:")) return `The original transfer is still ${code.split(":")[2]} at the provider.`;
  if (code.startsWith("original:failure_requires_review:")) return `The original failed with ${code.split(":")[2]?.replaceAll("_", " ").toLowerCase()}; re-sending to the same details is not safe, so a person must review.`;
  if (code.startsWith("original:confirmed_failed:")) return `The original failed (${code.split(":")[2]?.replaceAll("_", " ").toLowerCase()}) and was cancelled.`;
  const insufficient = /^balance:insufficient:need_(\d+)_have_(\d+)$/.exec(code);
  if (insufficient) return `The wallet does not cover the amount plus fees (needs ${insufficient[1]}, has ${insufficient[2]} minor units).`;
  if (code === "four_eyes:approver_is_proposer") return EXACT.four_eyes_approver_is_proposer!;
  const reopened = /^(settled_payment_failed_after_paid|second_payment_paid|unsettled_payment_was_paid|payment_history_conflict):(ORIGINAL|REPLACEMENT)(?::(.+))?$/.exec(code);
  if (reopened) {
    const which = reopened[2] === "ORIGINAL" ? "original" : "replacement";
    if (reopened[1] === "settled_payment_failed_after_paid") return `The ${which} payment that settled this invoice failed after PAID (${(reopened[3] ?? "type unknown").replaceAll("_", " ").toLowerCase()}). The invoice is unpaid again.`;
    if (reopened[1] === "second_payment_paid") return `The ${which} payment also shows PAID: the supplier may have been paid twice.`;
    if (reopened[1] === "unsettled_payment_was_paid") return `The ${which} payment now shows it was PAID before it failed. The replacement assumed it never was, so a person must check whether the supplier was paid twice.`;
    return `The ${which} payment's history is contradictory.`;
  }
  if (code.startsWith("reopened: ")) return `Reopened after resolution. ${code.slice(10).split(", ").map(explainReason).join(" ")}`;
  if (code.startsWith("changed:")) return `Approval invalid: ${code.slice(8)} changed since the approver saw it.`;
  if (code.startsWith("approval:")) return explainReason(code.slice(9));
  if (code.startsWith("policy:")) return explainReason(code.slice(7));
  return code.replaceAll("_", " ");
}

export const STATE_TEXT: Record<string, string> = {
  OPEN: "Open",
  INVESTIGATING: "Investigating",
  RECOMMENDED: "Recommendation ready",
  AWAITING_APPROVAL: "Awaiting approval",
  EXECUTING: "Executing",
  MONITORING: "Monitoring",
  RESOLVED: "Resolved",
  ESCALATED: "Escalated to a person",
};

export const FINALITY_TEXT: Record<string, string> = {
  IN_FLIGHT: "In flight: may still arrive",
  PAID_NOT_FINAL: "Paid (not final)",
  CONFIRMED_FAILED: "Confirmed failed",
  CANCELLED_WITHOUT_REASON: "Cancelled, reason unknown",
  FAILED_AFTER_PAID: "Failed after PAID",
  CONFLICT: "Conflicting history",
};
