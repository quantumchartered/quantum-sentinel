import { createHash } from "node:crypto";
import {
  type RawTransfer,
  type TransferSnapshot,
  normalizeFailure,
  parseWebhookEvent,
  verifyWebhookSignature,
} from "@sentinel/airwallex";
import {
  type TransferHistory,
  type TransferObservation,
  foldObservations,
  observationDedupKey,
} from "@sentinel/policy";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { providerEvents, transferObservations, webhookRejections } from "./schema.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export type WebhookOutcome =
  | { outcome: "accepted"; eventId: string; providerTransferId: string | null }
  | { outcome: "accepted_unparsed"; eventId: string | null; error: string }
  | { outcome: "duplicate"; eventId: string }
  | { outcome: "rejected"; reason: string };

export interface WebhookInput {
  organizationId: string;
  secret: string;
  rawBody: Buffer;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  nowMs: number;
}

/**
 * Verify, persist and deduplicate one webhook delivery in a single transaction.
 * Only after this commits may the HTTP handler answer 200.
 * - Bad signature: recorded in webhook_rejections, nothing trusted.
 * - Same event id again: no new rows ("duplicate").
 * - Valid signature but unexpected payload: raw body stored with parse_error, no observation.
 */
export async function recordWebhook(db: Db, input: WebhookInput): Promise<WebhookOutcome> {
  const bodySha256 = sha256(input.rawBody);
  const v = verifyWebhookSignature({
    secret: input.secret,
    timestampHeader: input.timestampHeader,
    signatureHeader: input.signatureHeader,
    rawBody: input.rawBody,
    nowMs: input.nowMs,
  });
  if (!v.ok) {
    await db.insert(webhookRejections).values({
      organizationId: input.organizationId,
      reason: v.reason,
      bodySha256,
      bodyBytes: input.rawBody.length,
    });
    return { outcome: "rejected", reason: v.reason };
  }

  let parsed: ReturnType<typeof parseWebhookEvent> | null = null;
  let parseError: string | null = null;
  try {
    parsed = parseWebhookEvent(input.rawBody);
  } catch (err) {
    parseError = err instanceof Error ? err.message.slice(0, 2000) : "unparseable";
  }
  // Without a parseable id we key the event by its body hash so redeliveries still dedupe.
  const eventId = parsed?.eventId ?? `unparsed:${bodySha256}`;

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(providerEvents)
      .values({
        organizationId: input.organizationId,
        provider: "airwallex",
        providerEventId: eventId,
        eventName: parsed?.name ?? "unknown",
        providerAccountId: parsed?.accountId ?? null,
        providerCreatedAt: parsed?.createdAt ?? null,
        apiVersion: parsed?.apiVersion ?? null,
        rawBody: input.rawBody,
        bodySha256,
        signatureTimestamp: v.timestampMs,
        parseError,
      })
      .onConflictDoNothing()
      .returning({ id: providerEvents.id });
    if (inserted.length === 0) return { outcome: "duplicate", eventId } as const;
    if (!parsed) return { outcome: "accepted_unparsed", eventId: null, error: parseError ?? "unparseable" } as const;
    if (parsed.transfer) {
      await insertObservation(tx, input.organizationId, parsed.transfer, {
        source: "webhook",
        eventId: parsed.eventId,
      });
    }
    return { outcome: "accepted", eventId: parsed.eventId, providerTransferId: parsed.transfer?.id ?? null } as const;
  });
}

/** Record a snapshot from a poll, a create response or a reconciliation lookup. */
export async function recordTransferSnapshot(
  db: Db,
  organizationId: string,
  snapshot: TransferSnapshot,
  source: "poll" | "create" | "reconcile",
): Promise<boolean> {
  return insertObservation(db, organizationId, snapshot.raw, { source, eventId: null });
}

async function insertObservation(
  tx: Db | Tx,
  organizationId: string,
  raw: RawTransfer,
  meta: { source: TransferObservation["source"]; eventId: string | null },
): Promise<boolean> {
  const f = normalizeFailure(raw);
  const failure = f ? { code: f.code, message: f.message, type: f.type, reasonCodes: f.reasonCodes } : null;
  const dedupKey = observationDedupKey({
    source: meta.source,
    eventId: meta.eventId,
    rawStatus: raw.status,
    observedAt: "",
    failure,
  });
  const rows = await tx
    .insert(transferObservations)
    .values({
      organizationId,
      providerTransferId: raw.id,
      source: meta.source,
      providerEventId: meta.eventId,
      rawStatus: raw.status,
      failureCode: failure?.code ?? null,
      failureMessage: failure?.message ?? null,
      failureType: failure?.type ?? null,
      failureReasonCodes: failure?.reasonCodes ?? [],
      snapshot: raw,
      dedupKey,
    })
    .onConflictDoNothing()
    .returning({ id: transferObservations.id });
  return rows.length > 0;
}

/** Rebuild what we know about a transfer, in the order we learned it. */
export async function loadTransferHistory(
  db: Db,
  organizationId: string,
  providerTransferId: string,
): Promise<TransferHistory> {
  const rows = await db
    .select()
    .from(transferObservations)
    .where(
      and(
        eq(transferObservations.organizationId, organizationId),
        eq(transferObservations.providerTransferId, providerTransferId),
      ),
    )
    .orderBy(asc(transferObservations.id));
  return foldObservations(
    rows.map((r) => ({
      source: r.source,
      eventId: r.providerEventId,
      rawStatus: r.rawStatus,
      observedAt: r.observedAt.toISOString(),
      failure:
        r.failureCode || r.failureMessage || r.failureType || r.failureReasonCodes.length
          ? { code: r.failureCode, message: r.failureMessage, type: r.failureType, reasonCodes: r.failureReasonCodes }
          : null,
    })),
  );
}
