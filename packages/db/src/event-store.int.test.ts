import { type TransferSnapshot, TransferSchema, normalizeTransfer, signWebhook } from "@sentinel/airwallex";
import { classifyFinality } from "@sentinel/policy";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, createDb } from "./client.js";
import { loadTransferHistory, recordTransferSnapshot, recordWebhook } from "./event-store.js";
import { providerEvents, providerOperations, transferObservations, webhookRejections } from "./schema.js";
import { createTestDb } from "./testing.js";
import { randomUUID } from "node:crypto";

const SECRET = "whsec_integration";
const NOW = Date.parse("2026-10-27T12:00:00Z");
let db: Db;
let orgA: string;
let orgB: string;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ db, orgA, orgB, drop } = await createTestDb());
});

afterAll(async () => {
  await drop?.();
});

const transferBody = (over: Record<string, unknown> = {}) => ({
  id: "tr-0001",
  request_id: "req-original-0001",
  status: "SENT",
  transfer_amount: 25000,
  transfer_currency: "USD",
  ...over,
});

function delivery(event: Record<string, unknown>, opts: { secret?: string; org?: string } = {}) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const ts = String(NOW - 500);
  return {
    organizationId: opts.org ?? orgA,
    secret: SECRET,
    rawBody,
    timestampHeader: ts,
    signatureHeader: signWebhook(opts.secret ?? SECRET, ts, rawBody),
    nowMs: NOW,
  };
}

const failedEvent = (transferId: string, eventId = `evt-failed-${transferId}`) => ({
  id: eventId,
  name: "payout.transfer.failed",
  created_at: "2026-10-27T11:59:59+0000",
  version: "2026-08-21",
  data: transferBody({
    id: transferId,
    status: "FAILED",
    failure: { message: "Returned by beneficiary bank", details: { type: "BENEFICIARY_BANK_RETURNED" } },
  }),
});

const snapshot = (over: Record<string, unknown>): TransferSnapshot => normalizeTransfer(TransferSchema.parse(transferBody(over)));

describe("webhook ingestion (real Postgres)", () => {
  it("accepts a signed FAILED event and records the failure facts", async () => {
    const res = await recordWebhook(db, delivery(failedEvent("tr-a1")));
    expect(res).toMatchObject({ outcome: "accepted", providerTransferId: "tr-a1" });
    const h = await loadTransferHistory(db, orgA, "tr-a1");
    expect(h.failures[0]).toMatchObject({ type: "BENEFICIARY_BANK_RETURNED", source: "webhook" });
  });

  it("stores exactly one event when the same delivery arrives 10 times concurrently", async () => {
    const d = delivery(failedEvent("tr-a2"));
    const results = await Promise.all(Array.from({ length: 10 }, () => recordWebhook(db, d)));
    expect(results.filter((r) => r.outcome === "accepted")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(9);
    const rows = await db.select().from(transferObservations).where(sql`provider_transfer_id = 'tr-a2'`);
    expect(rows).toHaveLength(1);
  });

  it("rejects a bad signature, stores no evidence, and logs the attempt", async () => {
    const before = (await db.select().from(webhookRejections)).length;
    const res = await recordWebhook(db, delivery(failedEvent("tr-a3"), { secret: "attacker" }));
    expect(res).toEqual({ outcome: "rejected", reason: "bad_signature" });
    expect(await db.select().from(providerEvents).where(sql`provider_event_id = 'evt-failed-tr-a3'`)).toHaveLength(0);
    expect((await db.select().from(webhookRejections)).length).toBe(before + 1);
  });

  it("keeps a validly signed but unexpected payload as raw evidence without trusting it", async () => {
    const bad = { id: "evt-weird", name: "payout.transfer.paid", data: { id: "only-an-id" } };
    expect(await recordWebhook(db, delivery(bad))).toMatchObject({ outcome: "accepted_unparsed" });
    expect(await recordWebhook(db, delivery(bad))).toMatchObject({ outcome: "duplicate" });
    const [row] = await db.select().from(providerEvents).where(sql`event_name = 'unknown'`);
    expect(row?.parseError).toBeTruthy();
  });
});

describe("FAILED flips to CANCELLED in seconds (persisted)", () => {
  it("webhook FAILED then a bare CANCELLED poll: failure retained, CONFIRMED_FAILED", async () => {
    await recordTransferSnapshot(db, orgA, snapshot({ id: "tr-b1", status: "SENT" }), "poll");
    await recordWebhook(db, delivery(failedEvent("tr-b1")));
    await recordTransferSnapshot(db, orgA, snapshot({ id: "tr-b1", status: "CANCELLED", failure: {} }), "poll");
    const h = await loadTransferHistory(db, orgA, "tr-b1");
    expect(h.status).toBe("CANCELLED");
    expect(classifyFinality(h)).toMatchObject({ kind: "CONFIRMED_FAILED", failure: { type: "BENEFICIARY_BANK_RETURNED" } });
  });

  it("bare CANCELLED poll first, FAILED webhook later: same result", async () => {
    await recordTransferSnapshot(db, orgA, snapshot({ id: "tr-b2", status: "SENT" }), "poll");
    await recordTransferSnapshot(db, orgA, snapshot({ id: "tr-b2", status: "CANCELLED" }), "poll");
    expect(classifyFinality(await loadTransferHistory(db, orgA, "tr-b2")).kind).toBe("CANCELLED_WITHOUT_REASON");
    await recordWebhook(db, delivery(failedEvent("tr-b2")));
    expect(classifyFinality(await loadTransferHistory(db, orgA, "tr-b2")).kind).toBe("CONFIRMED_FAILED");
  });

  it("missed webhook and only bare CANCELLED polls never count as a confirmed failure", async () => {
    await recordTransferSnapshot(db, orgA, snapshot({ id: "tr-b3", status: "SENT" }), "poll");
    await recordTransferSnapshot(db, orgA, snapshot({ id: "tr-b3", status: "CANCELLED" }), "poll");
    expect(classifyFinality(await loadTransferHistory(db, orgA, "tr-b3")).kind).toBe("CANCELLED_WITHOUT_REASON");
  });
});

describe("database guarantees", () => {
  it("evidence tables are append-only", async () => {
    // Drizzle wraps driver errors; the Postgres message is on `cause`.
    const appendOnly = { cause: { message: expect.stringMatching(/append-only/) } };
    await expect(db.execute(sql`UPDATE transfer_observations SET failure_type = NULL`)).rejects.toMatchObject(appendOnly);
    await expect(db.execute(sql`DELETE FROM transfer_observations`)).rejects.toMatchObject(appendOnly);
    await expect(db.execute(sql`DELETE FROM provider_events`)).rejects.toMatchObject(appendOnly);
  });

  it("history is tenant-scoped", async () => {
    await recordWebhook(db, delivery(failedEvent("tr-c1")));
    const other = await loadTransferHistory(db, orgB, "tr-c1");
    expect(other.observations).toHaveLength(0);
    expect(classifyFinality(other)).toEqual({ kind: "IN_FLIGHT", status: null });
  });

  it("a request_id can be bound to only one operation per tenant", async () => {
    const op = (id: string) => ({
      id,
      organizationId: orgA,
      kind: "transfer.create",
      requestId: "req-unique-000001",
      requestBody: {},
      bodySha256: "0".repeat(64),
      outcome: "PENDING" as const,
    });
    await db.insert(providerOperations).values(op(randomUUID()));
    await expect(db.insert(providerOperations).values(op(randomUUID()))).rejects.toThrow();
    // Another tenant may coincidentally use the same id.
    await db.insert(providerOperations).values({ ...op(randomUUID()), organizationId: orgB });
  });

  it("refuses the other project's Postgres port", () => {
    expect(() => createDb({ connectionString: "postgres://x:y@127.0.0.1:5432/z" })).toThrow(/54329/);
  });
});
