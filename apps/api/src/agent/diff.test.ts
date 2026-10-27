import { describe, expect, it } from "vitest";
import { diffRevisions } from "./diff.js";
import type { IncidentReport } from "./report.js";

const base: IncidentReport = {
  classification: "DELAYED_IN_FLIGHT",
  findings: [{ statement: "Transfer is SENT.", label: "provider_fact", evidence_ids: ["obs:1"], fact: { kind: "transfer_status", value: "SENT" } }],
  contradictions: [],
  uncertainties: [],
  missing_info: [],
  risk_indicators: [],
  options_considered: [{ action: "WAIT", assessment: "In flight.", evidence_ids: ["dec:a"] }],
  recommendation: "WAIT",
  explanation: [{ sentence: "Wait.", evidence_ids: ["dec:a", "obs:1"] }],
};

describe("revision diff", () => {
  it("explains WAIT -> REPLACE by the new evidence and reason codes", () => {
    const next: IncidentReport = {
      ...base,
      classification: "FAILED_RETURNED",
      findings: [{ statement: "Transfer failed with a bank return.", label: "provider_fact", evidence_ids: ["obs:2"], fact: { kind: "failure_type", value: "BENEFICIARY_BANK_RETURNED" } }],
      options_considered: [{ action: "REPLACE", assessment: "Confirmed failure.", evidence_ids: ["dec:b"] }],
      recommendation: "REPLACE",
      explanation: [{ sentence: "Replace.", evidence_ids: ["dec:b", "obs:2"] }],
    };
    const d = diffRevisions(
      { report: base, reasons: ["original:in_flight:SENT", "replacement_would_risk_double_payment"], recommendation: "WAIT" },
      { report: next, reasons: ["original:confirmed_failed:BENEFICIARY_BANK_RETURNED", "duplicate_fence:clear", "balance:sufficient"], recommendation: "REPLACE" },
    );
    expect(d.recommendation).toEqual({ from: "WAIT", to: "REPLACE", changed: true });
    expect(d.newEvidence).toEqual(["dec:b", "obs:2"]);
    expect(d.droppedEvidence).toEqual(["dec:a", "obs:1"]);
    expect(d.reasons.added).toContain("original:confirmed_failed:BENEFICIARY_BANK_RETURNED");
    expect(d.reasons.removed).toContain("replacement_would_risk_double_payment");
    expect(d.findings).toEqual({ added: ["Transfer failed with a bank return."], removed: ["Transfer is SENT."] });
  });

  it("first investigation has nothing to compare against", () => {
    const d = diffRevisions({ report: null, reasons: [], recommendation: null }, { report: base, reasons: ["x"], recommendation: "WAIT" });
    expect(d.recommendation.changed).toBe(true);
    expect(d.newEvidence).toEqual(["dec:a", "obs:1"]);
  });
});
