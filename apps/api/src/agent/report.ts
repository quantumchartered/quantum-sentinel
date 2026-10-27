import { z } from "zod";

/**
 * The investigator's structured incident report (AGENTS.md §5). Every factual
 * element carries evidence IDs; the grounding verifier checks them. Kept flat
 * and fully required so it also works as a `strict: true` tool schema.
 */

export const EVIDENCE_LABELS = ["provider_fact", "internal_record", "synthetic_fixture", "ai_interpretation", "unknown"] as const;
export const ACTIONS = ["WAIT", "REPLACE", "ESCALATE"] as const;
export const CLASSIFICATIONS = [
  "DELAYED_IN_FLIGHT",
  "FAILED_RETURNED",
  "FAILED_UNKNOWN_CAUSE",
  "PAID_DISPUTED",
  "SUSPECTED_FRAUD",
  "INSUFFICIENT_FUNDS",
  "CONFLICTING_EVIDENCE",
  "OTHER",
] as const;
/** Machine-checkable predicate attached to a finding ("none" for pure interpretation). */
export const FACT_KINDS = ["transfer_status", "failure_type", "amount_minor", "none"] as const;

const EvidenceIds = z.array(z.string().min(1).max(100)).max(20);
const Text = (max: number) => z.string().min(1).max(max);

export const FindingSchema = z.strictObject({
  statement: Text(400),
  label: z.enum(EVIDENCE_LABELS),
  evidence_ids: EvidenceIds,
  fact: z.strictObject({ kind: z.enum(FACT_KINDS), value: z.string().max(100) }),
});

export const IncidentReportSchema = z.strictObject({
  classification: z.enum(CLASSIFICATIONS),
  findings: z.array(FindingSchema).min(1).max(20),
  contradictions: z.array(z.strictObject({ description: Text(400), evidence_ids: EvidenceIds })).max(10),
  uncertainties: z.array(Text(300)).max(10),
  missing_info: z.array(Text(300)).max(10),
  risk_indicators: z.array(z.strictObject({ indicator: Text(300), evidence_ids: EvidenceIds })).max(10),
  options_considered: z
    .array(z.strictObject({ action: z.enum(ACTIONS), assessment: Text(400), evidence_ids: EvidenceIds }))
    .min(1)
    .max(3),
  recommendation: z.enum(ACTIONS),
  explanation: z.array(z.strictObject({ sentence: Text(400), evidence_ids: EvidenceIds })).min(1).max(8),
});
export type IncidentReport = z.infer<typeof IncidentReportSchema>;

const ids = { type: "array", items: { type: "string" } } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** JSON Schema for the `submit_report` tool (mirrors IncidentReportSchema; Zod re-validates). */
export const INCIDENT_REPORT_JSON_SCHEMA = obj({
  classification: { type: "string", enum: [...CLASSIFICATIONS] },
  findings: {
    type: "array",
    items: obj({
      statement: { type: "string" },
      label: { type: "string", enum: [...EVIDENCE_LABELS] },
      evidence_ids: ids,
      fact: obj({ kind: { type: "string", enum: [...FACT_KINDS] }, value: { type: "string" } }),
    }),
  },
  contradictions: { type: "array", items: obj({ description: { type: "string" }, evidence_ids: ids }) },
  uncertainties: { type: "array", items: { type: "string" } },
  missing_info: { type: "array", items: { type: "string" } },
  risk_indicators: { type: "array", items: obj({ indicator: { type: "string" }, evidence_ids: ids }) },
  options_considered: {
    type: "array",
    items: obj({ action: { type: "string", enum: [...ACTIONS] }, assessment: { type: "string" }, evidence_ids: ids }),
  },
  recommendation: { type: "string", enum: [...ACTIONS] },
  explanation: { type: "array", items: obj({ sentence: { type: "string" }, evidence_ids: ids }) },
});
