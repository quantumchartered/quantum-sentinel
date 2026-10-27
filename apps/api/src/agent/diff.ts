import type { IncidentReport } from "./report.js";

/**
 * What changed between two investigations of the same incident, for Decision
 * Replay ("why did the recommendation change?"). Pure; works on reports and on
 * the deterministic reason codes recorded with each decision.
 */
export interface RevisionDiff {
  recommendation: { from: string | null; to: string; changed: boolean };
  reasons: { added: string[]; removed: string[] };
  /** Evidence cited now but not before - the new information. */
  newEvidence: string[];
  droppedEvidence: string[];
  findings: { added: string[]; removed: string[] };
}

function citedIds(r: IncidentReport | null): Set<string> {
  const out = new Set<string>();
  if (!r) return out;
  for (const list of [r.findings, r.explanation, r.options_considered, r.risk_indicators, r.contradictions]) {
    for (const item of list) for (const id of item.evidence_ids) out.add(id);
  }
  return out;
}

const minus = <T>(a: Iterable<T>, b: Set<T>) => [...a].filter((x) => !b.has(x));

export function diffRevisions(
  prev: { report: IncidentReport | null; reasons: string[]; recommendation: string | null },
  next: { report: IncidentReport | null; reasons: string[]; recommendation: string },
): RevisionDiff {
  const before = citedIds(prev.report);
  const after = citedIds(next.report);
  const prevFindings = new Set((prev.report?.findings ?? []).map((f) => f.statement));
  const nextFindings = new Set((next.report?.findings ?? []).map((f) => f.statement));
  return {
    recommendation: { from: prev.recommendation, to: next.recommendation, changed: prev.recommendation !== next.recommendation },
    reasons: { added: minus(next.reasons, new Set(prev.reasons)), removed: minus(prev.reasons, new Set(next.reasons)) },
    newEvidence: minus(after, before).sort(),
    droppedEvidence: minus(before, after).sort(),
    findings: { added: minus(nextFindings, prevFindings), removed: minus(prevFindings, nextFindings) },
  };
}
