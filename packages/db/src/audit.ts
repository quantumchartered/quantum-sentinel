import {
  type AuditEntry,
  type Canonicalizable,
  type ChainCheck,
  canonicalJson,
  nextAuditEntry,
  verifyAuditChain,
} from "@sentinel/policy";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { auditEvents } from "./schema.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Append to the tenant's hash chain inside the caller's transaction, so the
 * audit entry commits (or rolls back) together with the change it records.
 * The organization row lock serializes appends per tenant.
 */
export async function appendAudit(
  tx: Tx,
  organizationId: string,
  entry: { actor: string; eventType: string; payload: Canonicalizable; occurredAt?: string },
): Promise<AuditEntry> {
  await tx.execute(sql`SELECT 1 FROM organizations WHERE id = ${organizationId} FOR UPDATE`);
  const [last] = await tx
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.organizationId, organizationId))
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  // Normalize through canonical JSON so what we hash is exactly what jsonb stores and returns.
  const payload = JSON.parse(canonicalJson(entry.payload)) as Canonicalizable;
  const next = nextAuditEntry(last ? toEntry(last) : null, {
    organizationId,
    occurredAt: entry.occurredAt ?? new Date().toISOString(),
    actor: entry.actor,
    eventType: entry.eventType,
    payload,
  });
  await tx.insert(auditEvents).values({
    organizationId,
    seq: next.seq,
    prevHash: next.prevHash,
    hash: next.hash,
    occurredAt: next.occurredAt,
    actor: next.actor,
    eventType: next.eventType,
    payload: next.payload,
  });
  return next;
}

function toEntry(r: typeof auditEvents.$inferSelect): AuditEntry {
  return {
    organizationId: r.organizationId,
    seq: r.seq,
    prevHash: r.prevHash,
    hash: r.hash,
    occurredAt: r.occurredAt,
    actor: r.actor,
    eventType: r.eventType,
    payload: r.payload as Canonicalizable,
  };
}

export async function loadAuditChain(db: Db | Tx, organizationId: string): Promise<AuditEntry[]> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.organizationId, organizationId))
    .orderBy(asc(auditEvents.seq));
  return rows.map(toEntry);
}

export async function verifyStoredAuditChain(db: Db, organizationId: string): Promise<ChainCheck> {
  return verifyAuditChain(await loadAuditChain(db, organizationId));
}

export async function auditEventsFor(db: Db, organizationId: string, eventType: string): Promise<AuditEntry[]> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.organizationId, organizationId), eq(auditEvents.eventType, eventType)))
    .orderBy(asc(auditEvents.seq));
  return rows.map(toEntry);
}
