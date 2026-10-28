/** Shapes returned by apps/api (see src/http/api.ts). Money is always an integer-minor-units string. */

export type Role = "OWNER" | "APPROVER" | "OPERATOR" | "VIEWER";
export type Recommendation = "WAIT" | "REPLACE" | "ESCALATE";
export type IncidentState = "OPEN" | "INVESTIGATING" | "RECOMMENDED" | "AWAITING_APPROVAL" | "EXECUTING" | "MONITORING" | "RESOLVED" | "ESCALATED";
export type Origin = "SANDBOX" | "SANDBOX_SCENARIO" | "MOCK_SCENARIO";

export interface Me {
  id: string;
  displayName: string;
  role: Role;
  organizationId: string;
}

export interface Overview {
  incidentsByState: Partial<Record<IncidentState, number>>;
  auditChain: { ok: true; entries: number; head: string } | { ok: false; brokenAtSeq: number; reason: string };
  agentRuns: { count: number; costMicroUsd: string };
  unsafeActionsBlocked: number;
  modes: { airwallex: "SANDBOX" | "NOT_CONFIGURED"; investigator: "CLAUDE" | "MOCK AI"; investigatorModel: string };
}

export interface IncidentListItem {
  id: string;
  title: string;
  origin: Origin;
  state: IncidentState;
  recommendation: Recommendation | null;
  riskFlags: string[];
  amountMinor: string;
  currency: string;
  supplierRef: string;
  invoiceRef: string;
  dueAt: string;
  updatedAt: string;
}

export interface Finality {
  kind: "IN_FLIGHT" | "PAID_NOT_FINAL" | "CONFIRMED_FAILED" | "CANCELLED_WITHOUT_REASON" | "FAILED_AFTER_PAID" | "CONFLICT";
  status?: string | null;
  failure?: { type: string | null; message: string | null } | null;
  conflicts?: string[];
}

export interface Payment {
  id: string;
  role: "ORIGINAL" | "REPLACEMENT";
  state: string;
  blocking: boolean;
  requestId: string;
  providerTransferId: string | null;
  amountMinor: string;
  currency: string;
  failureType: string | null;
  providerStatus: string | null;
  finality: Finality;
  observations: { id: string; source: string; status: string; failureType: string | null; failureMessage: string | null; observedAt: string }[];
}

export interface Evidence {
  id: string;
  kind: string;
  source: string;
  ref: string | null;
  trusted: boolean;
  content: Record<string, unknown>;
  capturedAt: string;
}

export interface DecisionRow {
  id: string;
  version: number;
  recommendation: Recommendation;
  reasons: string[];
  policyVersion: string;
  decidedAt: string;
}

export interface Finding {
  statement: string;
  label: string;
  evidence_ids: string[];
  fact: { kind: string; value: string };
}

export interface Report {
  classification: string;
  findings: Finding[];
  contradictions: { description: string; evidence_ids: string[] }[];
  uncertainties: string[];
  missing_info: string[];
  risk_indicators: { indicator: string; evidence_ids: string[] }[];
  options_considered: { action: Recommendation; assessment: string; evidence_ids: string[] }[];
  recommendation: Recommendation;
  explanation: { sentence: string; evidence_ids: string[] }[];
}

export interface Verification {
  ok: boolean;
  errors: { code: string; where: string; detail: string }[];
  warnings: { code: string; where: string; detail: string }[];
  detectedContradictions: string[];
}

export interface RevisionDiff {
  recommendation: { from: string | null; to: string; changed: boolean };
  reasons: { added: string[]; removed: string[] };
  newEvidence: string[];
  droppedEvidence: string[];
  findings: { added: string[]; removed: string[] };
}

export interface AgentRun {
  id: string;
  status: string;
  model: string;
  incidentVersion: number;
  policyRecommendation: Recommendation;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: string;
  toolCalls: { step: number; name: string; ok: boolean; summary: string }[];
  report: Report | null;
  verification: Verification | null;
  error: string | null;
  startedAt: string;
  finishedAt: string;
  diff: RevisionDiff | null;
}

export interface IncidentDetail {
  incident: {
    id: string;
    title: string | null;
    origin: Origin;
    state: IncidentState;
    recommendation: Recommendation | null;
    version: number;
    riskFlags: string[];
    escalationReason: string | null;
    originalFate: string | null;
    settledBy: string | null;
    openedAt: string;
    updatedAt: string;
  };
  obligation: { id: string; supplierRef: string; invoiceRef: string; amountMinor: string; currency: string; beneficiaryId: string; beneficiaryHash: string; dueAt: string };
  payments: Payment[];
  evidence: Evidence[];
  decisions: DecisionRow[];
  proposals: { id: string; incidentVersion: number; proposedBy: string; facts: Record<string, unknown>; createdAt: string; current: boolean }[];
  agentRuns: AgentRun[];
  ledger: Record<string, string>;
}

export interface ApprovalItem {
  proposalId: string;
  incidentId: string;
  incidentTitle: string | null;
  origin: Origin;
  proposedBy: string;
  proposedAt: string;
  facts: {
    amountMinor: string;
    currency: string;
    beneficiaryId: string;
    beneficiaryHash: string;
    originalPaymentId: string;
    providerStateVersion: number;
    evidenceSetHash: string;
    incidentVersion: number;
    policyVersion: string;
  };
  canApprove: boolean;
}

export interface AuditEntry {
  seq: number;
  occurredAt: string;
  actor: string;
  eventType: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface ReplayData {
  incidentId: string;
  origin: Origin;
  audit: { seq: number; at: string; actor: string; type: string; payload: Record<string, unknown>; hash: string }[];
  observations: { id: string; at: string; paymentRole: "ORIGINAL" | "REPLACEMENT" | null; providerTransferId: string; source: string; status: string; failureType: string | null; failureMessage: string | null }[];
  evidence: { id: string; at: string; kind: string; source: string; trusted: boolean }[];
  agentRuns: AgentRun[];
}
