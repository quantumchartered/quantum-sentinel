import {
  bigint,
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
