import { describe, expect, it } from "vitest";
import { EvidenceRegistry } from "./registry.js";
import type { IncidentReport } from "./report.js";
import { IncidentReportSchema } from "./report.js";
import { detectContradictions, verifyReport } from "./verifier.js";

function registry() {
  const r = new EvidenceRegistry();
  r.add({ id: "obs:1", label: "provider_fact", trusted: true, summary: "orig SENT", facts: { providerTransferId: "orig", transferStatus: "SENT", sequence: 1 } });
  r.add({
    id: "obs:2",
    label: "provider_fact",
    trusted: true,
    summary: "orig FAILED",
    facts: { providerTransferId: "orig", transferStatus: "FAILED", failureType: "BENEFICIARY_BANK_RETURNED", sequence: 2 },
  });
  r.add({ id: "obs:3", label: "provider_fact", trusted: true, summary: "orig CANCELLED", facts: { providerTransferId: "orig", transferStatus: "CANCELLED", sequence: 3 } });
  r.add({ id: "ob:1", label: "internal_record", trusted: true, summary: "obligation", facts: { amountMinor: "2500000", currency: "USD" } });
  r.add({ id: "ev:email", label: "unknown", trusted: false, summary: "We have not received the funds.", facts: {} });
  r.add({ id: "dec:1", label: "internal_record", trusted: true, summary: "policy REPLACE", facts: {} });
  return r;
}

const good: IncidentReport = {
  classification: "FAILED_RETURNED",
  findings: [
    { statement: "The original transfer failed with a bank return.", label: "provider_fact", evidence_ids: ["obs:2"], fact: { kind: "failure_type", value: "BENEFICIARY_BANK_RETURNED" } },
    { statement: "It is now cancelled at the provider.", label: "provider_fact", evidence_ids: ["obs:3"], fact: { kind: "transfer_status", value: "CANCELLED" } },
    { statement: "We owe USD 25,000.00.", label: "internal_record", evidence_ids: ["ob:1"], fact: { kind: "amount_minor", value: "2500000" } },
    { statement: "The supplier reports non-receipt, consistent with the return.", label: "ai_interpretation", evidence_ids: ["ev:email", "obs:2"], fact: { kind: "none", value: "" } },
  ],
  contradictions: [],
  uncertainties: ["Exact refund timing is not shown."],
  missing_info: [],
  risk_indicators: [],
  options_considered: [
    { action: "REPLACE", assessment: "Original confirmed failed; policy allows replacement.", evidence_ids: ["obs:2", "dec:1"] },
    { action: "WAIT", assessment: "Nothing left to wait for.", evidence_ids: ["obs:3"] },
  ],
  recommendation: "REPLACE",
  explanation: [{ sentence: "The original was returned by the beneficiary bank, so a replacement is safe.", evidence_ids: ["obs:2", "dec:1"] }],
};

const mutate = (f: (r: IncidentReport) => void) => {
  const r = structuredClone(good);
  f(r);
  return verifyReport(IncidentReportSchema.parse(r), registry(), "REPLACE");
};
const codes = (v: ReturnType<typeof verifyReport>) => v.errors.map((e) => e.code);

describe("grounding verifier", () => {
  it("accepts a grounded report that agrees with policy", () => {
    expect(verifyReport(good, registry(), "REPLACE")).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects an uncited explanation sentence", () => {
    expect(codes(mutate((r) => (r.explanation[0]!.evidence_ids = [])))).toContain("UNCITED_CLAIM");
  });

  it("rejects an invented evidence ID", () => {
    expect(codes(mutate((r) => (r.findings[0]!.evidence_ids = ["obs:999"])))).toContain("UNKNOWN_EVIDENCE_ID");
  });

  it("rejects a provider_fact backed only by the supplier's email", () => {
    const c = codes(mutate((r) => (r.findings[1] = { ...r.findings[1]!, evidence_ids: ["ev:email"] })));
    expect(c).toEqual(expect.arrayContaining(["UNTRUSTED_SUPPORT", "LABEL_MISMATCH"]));
  });

  it("rejects a wrong failure type or amount", () => {
    expect(codes(mutate((r) => (r.findings[0]!.fact.value = "RECALL_REQUESTED")))).toContain("FACT_UNSUPPORTED");
    expect(codes(mutate((r) => (r.findings[2]!.fact.value = "2500001")))).toContain("FACT_UNSUPPORTED");
  });

  it("rejects a stale status claim (SENT when the latest observation is CANCELLED)", () => {
    const v = mutate((r) => (r.findings[1] = { ...r.findings[1]!, evidence_ids: ["obs:1"], fact: { kind: "transfer_status", value: "SENT" } }));
    expect(codes(v)).toContain("STALE_STATUS");
  });

  it("rejects a recommendation that overrides the deterministic policy", () => {
    const v = verifyReport({ ...good, recommendation: "REPLACE" }, registry(), "WAIT");
    expect(codes(v)).toContain("RECOMMENDATION_OVERRIDES_POLICY");
  });

  it("a contradiction must cite both sources", () => {
    expect(codes(mutate((r) => (r.contradictions = [{ description: "x", evidence_ids: ["ev:email"] }])))).toContain("CONTRADICTION_NEEDS_TWO_SOURCES");
  });

  it("detects supplier 'not received' vs provider PAID, and warns if the report omits it", () => {
    const r = new EvidenceRegistry();
    r.add({ id: "obs:p", label: "provider_fact", trusted: true, summary: "PAID", facts: { providerTransferId: "t", transferStatus: "PAID", sequence: 1 } });
    r.add({ id: "ev:e", label: "unknown", trusted: false, summary: "We have not received anything", facts: {} });
    expect(detectContradictions(r)).toHaveLength(1);
    const report: IncidentReport = {
      ...good,
      findings: [{ statement: "Paid.", label: "provider_fact", evidence_ids: ["obs:p"], fact: { kind: "transfer_status", value: "PAID" } }],
      options_considered: [{ action: "WAIT", assessment: "Paid at provider.", evidence_ids: ["obs:p"] }],
      recommendation: "WAIT",
      explanation: [{ sentence: "Paid.", evidence_ids: ["obs:p"] }],
    };
    const v = verifyReport(report, r, "WAIT");
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).toContain("CONTRADICTION_NOT_REPORTED");
  });
});
