/**
 * Incident lifecycle (PLAN.md §4), pure and deterministic:
 * OPEN → INVESTIGATING → RECOMMENDED → AWAITING_APPROVAL → EXECUTING → MONITORING → RESOLVED / ESCALATED.
 * Guards that need data (e.g. "original fate recorded") are explicit event fields,
 * so the rule is visible in code and the caller cannot skip it.
 */

export type IncidentState =
  | "OPEN"
  | "INVESTIGATING"
  | "RECOMMENDED"
  | "AWAITING_APPROVAL"
  | "EXECUTING"
  | "MONITORING"
  | "RESOLVED"
  | "ESCALATED";

export type Recommendation = "WAIT" | "REPLACE" | "ESCALATE";

export type IncidentEvent =
  | { type: "START_INVESTIGATION" }
  | { type: "RECOMMEND"; recommendation: Recommendation }
  | { type: "REQUEST_APPROVAL" }
  | { type: "ACKNOWLEDGE_WAIT" }
  | { type: "APPROVE" }
  | { type: "REJECT" }
  | { type: "APPROVAL_INVALIDATED"; reason: string }
  | { type: "NEW_EVIDENCE" }
  | { type: "DISPATCHED" }
  | { type: "DISPATCH_UNCERTAIN" }
  | { type: "ESCALATE"; reason: string }
  | {
      type: "RESOLVE";
      /** What happened to the original transfer, e.g. "RETURNED: BENEFICIARY_BANK_RETURNED". */
      originalFate: string | null;
      /** Which payment satisfied the obligation. */
      settledBy: "ORIGINAL" | "REPLACEMENT" | null;
      /** Any payment still uncertain or in flight blocks resolution. */
      openPaymentUncertainty: boolean;
    }
  | { type: "REOPEN"; reason: string };

export interface IncidentSnapshot {
  state: IncidentState;
  recommendation: Recommendation | null;
  version: number;
}

export type TransitionResult =
  | { ok: true; next: IncidentSnapshot }
  | { ok: false; reason: string };

const TERMINAL: ReadonlySet<IncidentState> = new Set(["RESOLVED", "ESCALATED"]);

function to(s: IncidentSnapshot, state: IncidentState, recommendation = s.recommendation): TransitionResult {
  return { ok: true, next: { state, recommendation, version: s.version + 1 } };
}

const deny = (reason: string): TransitionResult => ({ ok: false, reason });

export function transitionIncident(s: IncidentSnapshot, e: IncidentEvent): TransitionResult {
  // Escalation is always possible from a live incident: safety beats progress.
  if (e.type === "ESCALATE") {
    return TERMINAL.has(s.state) ? deny(`incident already ${s.state}`) : to(s, "ESCALATED", "ESCALATE");
  }
  // New material evidence sends a live incident back to investigation (old approvals die with the version bump).
  if (e.type === "NEW_EVIDENCE") {
    if (s.state === "EXECUTING") return deny("evidence during execution is reconciled by the executor, not re-investigated");
    if (TERMINAL.has(s.state)) return deny("terminal incident: use REOPEN");
    return to(s, "INVESTIGATING", null);
  }

  switch (s.state) {
    case "OPEN":
      if (e.type === "START_INVESTIGATION") return to(s, "INVESTIGATING");
      break;
    case "INVESTIGATING":
      if (e.type === "RECOMMEND") {
        if (e.recommendation === "ESCALATE") return to(s, "ESCALATED", "ESCALATE");
        return to(s, "RECOMMENDED", e.recommendation);
      }
      break;
    case "RECOMMENDED":
      if (e.type === "REQUEST_APPROVAL") {
        if (s.recommendation !== "REPLACE") return deny("only a REPLACE recommendation needs payment approval");
        return to(s, "AWAITING_APPROVAL");
      }
      if (e.type === "ACKNOWLEDGE_WAIT") {
        if (s.recommendation !== "WAIT") return deny("nothing to acknowledge: recommendation is not WAIT");
        return to(s, "MONITORING");
      }
      break;
    case "AWAITING_APPROVAL":
      if (e.type === "APPROVE") return to(s, "EXECUTING");
      if (e.type === "REJECT" || e.type === "APPROVAL_INVALIDATED") return to(s, "INVESTIGATING", null);
      break;
    case "EXECUTING":
      // Uncertain dispatch also moves to MONITORING: the payment lock stays held until reconciled.
      if (e.type === "DISPATCHED" || e.type === "DISPATCH_UNCERTAIN") return to(s, "MONITORING");
      break;
    case "MONITORING":
      if (e.type === "RESOLVE") {
        if (!e.originalFate) return deny("cannot resolve: the original transfer's fate is not recorded");
        if (!e.settledBy) return deny("cannot resolve: no payment has settled the obligation");
        if (e.openPaymentUncertainty) return deny("cannot resolve: a payment outcome is still uncertain");
        return to(s, "RESOLVED");
      }
      break;
    case "RESOLVED":
    case "ESCALATED":
      if (e.type === "REOPEN") return to(s, "INVESTIGATING", null);
      break;
  }
  return deny(`${e.type} is not allowed in state ${s.state}`);
}

export function isTerminal(state: IncidentState): boolean {
  return TERMINAL.has(state);
}
