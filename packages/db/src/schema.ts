import type { IncidentState, Recommendation, RiskFlag } from "@sentinel/policy";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bigserial,
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Typed mirror of migrations/*.sql. The SQL files are the source of truth for constraints. */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  replacementFeeMinor: bigint("replacement_fee_minor", { mode: "bigint" }).notNull().default(0n),
  reserveFloorMinor: bigint("reserve_floor_minor", { mode: "bigint" }).notNull().default(0n),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const providerEvents = pgTable("provider_events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  provider: text("provider").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  eventName: text("event_name").notNull(),
  providerAccountId: text("provider_account_id"),
  providerCreatedAt: text("provider_created_at"),
  apiVersion: text("api_version"),
  rawBody: bytea("raw_body").notNull(),
  bodySha256: text("body_sha256").notNull(),
  signatureTimestamp: bigint("signature_timestamp", { mode: "number" }).notNull(),
  parseError: text("parse_error"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookRejections = pgTable("webhook_rejections", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  reason: text("reason").notNull(),
  bodySha256: text("body_sha256").notNull(),
  bodyBytes: integer("body_bytes").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transferObservations = pgTable("transfer_observations", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  providerTransferId: text("provider_transfer_id").notNull(),
  source: text("source").$type<"webhook" | "poll" | "create" | "reconcile">().notNull(),
  providerEventId: text("provider_event_id"),
  rawStatus: text("raw_status").notNull(),
  failureCode: text("failure_code"),
  failureMessage: text("failure_message"),
  failureType: text("failure_type"),
  failureReasonCodes: text("failure_reason_codes").array().notNull(),
  snapshot: jsonb("snapshot").notNull(),
  dedupKey: text("dedup_key").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const providerOperations = pgTable("provider_operations", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  kind: text("kind").notNull(),
  requestId: text("request_id"),
  requestBody: jsonb("request_body").notNull(),
  bodySha256: text("body_sha256").notNull(),
  outcome: text("outcome").$type<"PENDING" | "SUCCEEDED" | "REJECTED" | "UNCERTAIN">().notNull(),
  response: jsonb("response"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- T2 safety core (migrations/0002_t2_safety_core.sql) ----

export const obligations = pgTable("obligations", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  supplierRef: text("supplier_ref").notNull(),
  invoiceRef: text("invoice_ref").notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  currency: text("currency").notNull(),
  beneficiaryId: text("beneficiary_id").notNull(),
  beneficiaryHash: text("beneficiary_hash").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PaymentState = "INTENDED" | "DISPATCHED" | "UNCERTAIN" | "FAILED_CONFIRMED" | "NOT_SENT";

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  role: text("role").$type<"ORIGINAL" | "REPLACEMENT">().notNull(),
  predecessorPaymentId: uuid("predecessor_payment_id"),
  requestId: text("request_id").notNull(),
  providerTransferId: text("provider_transfer_id"),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  currency: text("currency").notNull(),
  beneficiaryId: text("beneficiary_id").notNull(),
  state: text("state").$type<PaymentState>().notNull(),
  blocking: boolean("blocking").generatedAlwaysAs(sql`state NOT IN ('FAILED_CONFIRMED', 'NOT_SENT')`),
  failureType: text("failure_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const incidents = pgTable("incidents", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  obligationId: uuid("obligation_id").notNull(),
  originalPaymentId: uuid("original_payment_id").notNull(),
  state: text("state").$type<IncidentState>().notNull(),
  recommendation: text("recommendation").$type<Recommendation>(),
  version: integer("version").notNull().default(0),
  riskFlags: text("risk_flags").array().$type<RiskFlag[]>().notNull(),
  escalationReason: text("escalation_reason"),
  originalFate: text("original_fate"),
  settledBy: text("settled_by").$type<"ORIGINAL" | "REPLACEMENT">(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EvidenceKind = "provider_fact" | "internal_record" | "synthetic_fixture" | "ai_interpretation" | "unknown";

export const evidence = pgTable("evidence", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  incidentId: uuid("incident_id").notNull(),
  kind: text("kind").$type<EvidenceKind>().notNull(),
  source: text("source").notNull(),
  ref: text("ref"),
  trusted: boolean("trusted").notNull(),
  content: jsonb("content").notNull(),
  contentHash: text("content_hash").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
});

export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  incidentId: uuid("incident_id").notNull(),
  incidentVersion: integer("incident_version").notNull(),
  policyVersion: text("policy_version").notNull(),
  recommendation: text("recommendation").$type<Recommendation>().notNull(),
  reasons: text("reasons").array().notNull(),
  inputs: jsonb("inputs").notNull(),
  evidenceSetHash: text("evidence_set_hash").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
});

export const proposedActions = pgTable("proposed_actions", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  incidentId: uuid("incident_id").notNull(),
  incidentVersion: integer("incident_version").notNull(),
  actionType: text("action_type").$type<"REPLACE">().notNull(),
  facts: jsonb("facts").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  incidentId: uuid("incident_id").notNull(),
  proposedActionId: uuid("proposed_action_id").notNull(),
  binding: jsonb("binding").notNull(),
  keyVersion: text("key_version").notNull(),
  signature: text("signature").notNull(),
  approverId: text("approver_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ExecutionStatus = "PENDING" | "CLAIMED" | "SUCCEEDED" | "UNCERTAIN" | "REJECTED" | "BLOCKED";

export const executions = pgTable("executions", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  approvalId: uuid("approval_id").notNull(),
  paymentId: uuid("payment_id").notNull(),
  status: text("status").$type<ExecutionStatus>().notNull(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  providerResponse: jsonb("provider_response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  seq: bigint("seq", { mode: "number" }).notNull(),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
  occurredAt: text("occurred_at").notNull(),
  actor: text("actor").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
});
