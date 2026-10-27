/**
 * MOCK investigator: a deterministic, rule-based stand-in for Claude used when
 * no Anthropic credentials are configured (and in tests). It drives the same
 * tools and passes the same verifier as the real model, but writes no prose of
 * its own beyond templates. Runs are recorded with model "mock-investigator"
 * and the console labels them "MOCK AI".
 */
import { type Block, reply as scriptedReply, toolResults, toolUse } from "./fake-model.js";
import type { CreateParams, ModelClient, ModelMessage } from "./model.js";
import type { IncidentReport } from "./report.js";

export const MOCK_MODEL_ID = "mock-investigator";

/** No model is called, so no tokens are used or billed. */
const reply = (content: Block[]) => scriptedReply(content, undefined, { input_tokens: 0, output_tokens: 0 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

const REASON_TEXT: Record<string, string> = {
  replacement_would_risk_double_payment: "sending a replacement now could pay the supplier twice",
  deadline_passed_but_original_may_still_arrive: "the deadline has passed but the original can still arrive",
  "duplicate_fence:clear": "no other payment is pending for this invoice",
  "balance:sufficient": "the wallet covers the amount plus fees",
  "original:paid_not_final": "the provider reports PAID, which is not yet final",
  "original:cancelled_without_failure_reason": "the transfer was cancelled but no failure reason was captured",
  "original:failure_type_missing": "the failure has no recorded type",
  "original:failed_after_paid": "the transfer failed after having been PAID",
  "duplicate_fence:another_payment_blocks_obligation": "another payment is still pending for this invoice",
  "balance:unavailable": "the wallet balance could not be read",
  "risk:BANK_DETAIL_CHANGE_REQUEST": "the supplier asked to pay a different bank account",
  "risk:PROMPT_INJECTION_SUSPECTED": "a supplier message contains instructions aimed at the system",
};

function plain(reason: string): string {
  if (REASON_TEXT[reason]) return REASON_TEXT[reason]!;
  if (reason.startsWith("original:in_flight:")) return `the original transfer is still ${reason.split(":")[2]} at the provider`;
  if (reason.startsWith("original:confirmed_failed:")) return `the original transfer failed (${reason.split(":")[2]}) and was cancelled`;
  if (reason.startsWith("balance:insufficient")) return "the wallet does not cover the amount plus fees";
  return reason;
}

export function buildMockReport(params: CreateParams): IncidentReport {
  const last = (name: string): J => toolResults(params).filter((r) => r.name === name && !r.isError).at(-1)?.json as J;
  const ov = last("get_incident_overview");
  const policy = last("get_policy_assessment");
  const hist = last("get_transfer_history");
  const evidence = (last("list_evidence")?.evidence ?? []) as J[];
  const obs = (hist?.observations ?? []) as J[];
  const latest = obs.at(-1);
  const failed = obs.find((o) => o.failure?.type);
  const rec = policy.recommendation as IncidentReport["recommendation"];
  const untrusted = evidence.filter((e) => !e.trusted);
  const flags = (policy.risk_flags ?? []) as string[];

  const findings: IncidentReport["findings"] = [];
  if (latest) findings.push({ statement: `The original transfer's latest status at the provider is ${latest.status}.`, label: "provider_fact", evidence_ids: [latest.evidence_id], fact: { kind: "transfer_status", value: latest.status } });
  if (failed) findings.push({ statement: `A failure was captured: ${failed.failure.type}.`, label: "provider_fact", evidence_ids: [failed.evidence_id], fact: { kind: "failure_type", value: failed.failure.type } });
  findings.push({ statement: `The invoice amount owed is ${ov.obligation.amount_minor} minor units of ${ov.obligation.currency}.`, label: "internal_record", evidence_ids: [ov.obligation.evidence_id], fact: { kind: "amount_minor", value: ov.obligation.amount_minor } });
  for (const e of untrusted) findings.push({ statement: "The supplier sent a message about this payment (untrusted).", label: "unknown", evidence_ids: [e.evidence_id], fact: { kind: "none", value: "" } });

  const reasons = (policy.reasons as string[]).map(plain);
  const cite = [policy.evidence_id, ...(latest ? [latest.evidence_id] : [])];
  return {
    classification: flags.length ? "SUSPECTED_FRAUD" : rec === "WAIT" ? "DELAYED_IN_FLIGHT" : rec === "REPLACE" ? "FAILED_RETURNED" : failed ? "FAILED_UNKNOWN_CAUSE" : "OTHER",
    findings,
    contradictions: [],
    uncertainties: rec === "WAIT" ? ["The provider gives no settlement time for a transfer in flight."] : [],
    missing_info: [],
    risk_indicators: flags.length && untrusted.length ? [{ indicator: `Risk flags raised by code: ${flags.join(", ")}.`, evidence_ids: untrusted.map((e) => e.evidence_id) }] : [],
    options_considered: [{ action: rec, assessment: `Policy: ${reasons.join("; ")}.`, evidence_ids: [policy.evidence_id] }],
    recommendation: rec,
    explanation: [{ sentence: `Recommendation ${rec} because ${reasons.join(", ")}.`, evidence_ids: cite }],
  };
}

export class MockInvestigatorModel implements ModelClient {
  async createMessage(params: CreateParams): Promise<ModelMessage> {
    const seen = new Set(toolResults(params).filter((r) => !r.isError).map((r) => r.name));
    if (!seen.has("get_incident_overview") || !seen.has("get_policy_assessment") || !seen.has("list_evidence")) {
      return reply([toolUse("get_incident_overview", {}), toolUse("get_policy_assessment", {}), toolUse("list_evidence", {})]);
    }
    if (!seen.has("get_transfer_history")) {
      const ov = toolResults(params).find((r) => r.name === "get_incident_overview")!.json as J;
      const original = (ov.payments as J[]).find((p) => p.role === "ORIGINAL");
      return reply([toolUse("get_transfer_history", { payment_id: original!.payment_id })]);
    }
    const report = buildMockReport(params);
    const ov = toolResults(params).find((r) => r.name === "get_incident_overview")!.json as J;
    const proposeNow = report.recommendation === "REPLACE" && ov.incident.state === "RECOMMENDED" && !seen.has("propose_action");
    return reply([
      ...(proposeNow ? [toolUse("propose_action", { action: "REPLACE", rationale: "Policy allows a replacement after a confirmed failure.", evidence_ids: report.options_considered[0]!.evidence_ids })] : []),
      toolUse("submit_report", report),
    ]);
  }
}
