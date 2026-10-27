import type { Recommendation } from "@sentinel/policy";
import type { EvidenceRegistry } from "./registry.js";
import type { IncidentReport } from "./report.js";

/**
 * Grounding verifier (AGENTS.md §5, advanced feature 1). Pure code. A report is
 * accepted only with zero errors. Checks:
 *  - every finding, explanation sentence, option, risk and contradiction cites
 *    at least one evidence ID, and every cited ID was shown to the model this run;
 *  - labels are honest: a provider_fact cites provider evidence, a
 *    synthetic_fixture cites synthetic evidence, untrusted text alone never
 *    supports a provider_fact or internal_record;
 *  - machine-checkable claims (status, failure type, amount) match the cited evidence,
 *    and a status claim matches the LATEST known status of that transfer;
 *  - the recommendation equals the deterministic policy decision (the model
 *    explains; it cannot override code).
 * Contradictions between sources found by code are reported alongside.
 */

export interface VerificationIssue {
  code: string;
  where: string;
  detail: string;
}

export interface Verification {
  ok: boolean;
  errors: VerificationIssue[];
  warnings: VerificationIssue[];
  /** Contradictions detected deterministically from the evidence itself. */
  detectedContradictions: string[];
}

export function verifyReport(report: IncidentReport, registry: EvidenceRegistry, policyRecommendation: Recommendation): Verification {
  const errors: VerificationIssue[] = [];
  const warnings: VerificationIssue[] = [];
  const err = (code: string, where: string, detail: string) => errors.push({ code, where, detail });

  const checkCitations = (where: string, ids: readonly string[]) => {
    if (ids.length === 0) err("UNCITED_CLAIM", where, "no evidence_ids");
    for (const id of ids) if (!registry.has(id)) err("UNKNOWN_EVIDENCE_ID", where, `"${id}" was not shown to the model in this run`);
    return ids.map((id) => registry.get(id)).filter((x) => x !== undefined);
  };

  report.findings.forEach((f, i) => {
    const where = `findings[${i}]`;
    const cited = checkCitations(where, f.evidence_ids);
    if (cited.length === 0) return;

    const trusted = cited.filter((c) => c.trusted);
    if ((f.label === "provider_fact" || f.label === "internal_record") && trusted.length === 0) {
      err("UNTRUSTED_SUPPORT", where, `${f.label} supported only by untrusted text`);
    }
    if (f.label === "provider_fact" && !cited.some((c) => c.label === "provider_fact")) {
      err("LABEL_MISMATCH", where, "provider_fact must cite provider evidence");
    }
    if (f.label === "synthetic_fixture" && !cited.some((c) => c.label === "synthetic_fixture")) {
      err("LABEL_MISMATCH", where, "synthetic_fixture must cite synthetic evidence");
    }
    if (f.label !== "synthetic_fixture" && f.label !== "ai_interpretation" && f.label !== "unknown" && cited.every((c) => c.label === "synthetic_fixture")) {
      err("LABEL_MISMATCH", where, "claim rests only on synthetic evidence but is not labelled synthetic_fixture");
    }

    const v = f.fact.value.trim();
    switch (f.fact.kind) {
      case "transfer_status": {
        const support = cited.filter((c) => c.facts.transferStatus === v);
        if (support.length === 0) {
          err("FACT_UNSUPPORTED", where, `no cited evidence shows status ${v}`);
          break;
        }
        const transferId = support[0]!.facts.providerTransferId;
        const latest = transferId ? registry.latestStatus(transferId) : undefined;
        if (latest && latest !== v) err("STALE_STATUS", where, `claims ${v} but the latest observation of ${transferId} is ${latest}`);
        break;
      }
      case "failure_type":
        if (!cited.some((c) => c.facts.failureType === v)) err("FACT_UNSUPPORTED", where, `no cited evidence shows failure type ${v}`);
        break;
      case "amount_minor":
        if (!cited.some((c) => c.facts.amountMinor === v.replace(/\s.*$/, ""))) err("FACT_UNSUPPORTED", where, `no cited evidence shows amount ${v}`);
        break;
      case "none":
        if (f.label === "provider_fact") warnings.push({ code: "UNCHECKED_PROVIDER_FACT", where, detail: "provider_fact without a checkable predicate" });
        break;
    }
  });

  report.explanation.forEach((s, i) => checkCitations(`explanation[${i}]`, s.evidence_ids));
  report.options_considered.forEach((o, i) => checkCitations(`options_considered[${i}]`, o.evidence_ids));
  report.risk_indicators.forEach((r, i) => checkCitations(`risk_indicators[${i}]`, r.evidence_ids));
  report.contradictions.forEach((c, i) => {
    checkCitations(`contradictions[${i}]`, c.evidence_ids);
    if (c.evidence_ids.length < 2) err("CONTRADICTION_NEEDS_TWO_SOURCES", `contradictions[${i}]`, "a contradiction must cite both sides");
  });

  if (report.recommendation !== policyRecommendation) {
    err("RECOMMENDATION_OVERRIDES_POLICY", "recommendation", `report says ${report.recommendation}; deterministic policy says ${policyRecommendation}`);
  }

  // Contradictions code can see on its own: untrusted text vs provider facts.
  const detected = detectContradictions(registry);
  if (detected.length && report.contradictions.length === 0) {
    warnings.push({ code: "CONTRADICTION_NOT_REPORTED", where: "contradictions", detail: detected.join("; ") });
  }

  return { ok: errors.length === 0, errors, warnings, detectedContradictions: detected };
}

/** Supplier says "not received" while the provider says PAID, or claims the money arrived while it failed. */
export function detectContradictions(registry: EvidenceRegistry): string[] {
  const out: string[] = [];
  const items = registry.all();
  const supplierText = items.filter((i) => !i.trusted);
  const transferIds = new Set(items.map((i) => i.facts.providerTransferId).filter((x): x is string => !!x));
  for (const t of transferIds) {
    const latest = registry.latestStatus(t);
    for (const s of supplierText) {
      const text = s.summary.toLowerCase();
      if (latest === "PAID" && /\b(not|never|haven't|have not|hasn't|has not)\b.{0,20}\b(received|arrived|got)\b/.test(text)) {
        out.push(`${s.id} says funds not received but ${t} is PAID at the provider`);
      }
      if ((latest === "FAILED" || latest === "CANCELLED") && /\b(received|arrived)\b/.test(text) && !/\bnot\b/.test(text)) {
        out.push(`${s.id} says funds arrived but ${t} is ${latest} at the provider`);
      }
    }
  }
  return out;
}
