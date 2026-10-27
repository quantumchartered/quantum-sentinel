import { AirwallexClient, AirwallexHttp, signWebhook } from "@sentinel/airwallex";
import { type Db, createTestDb, loadTransferHistory, schema } from "@sentinel/db";
import { classifyFinality } from "@sentinel/policy";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listOpenTransferIds, pollOnce } from "./poller.js";
import { WEBHOOK_BODY_LIMIT, buildServer } from "./server.js";

const SECRET = "whsec_api_test";
const NOW = Date.parse("2026-10-27T12:00:00Z");
let db: Db;
let org: string;
let drop: () => Promise<void>;
let app: FastifyInstance;

beforeAll(async () => {
  const t = await createTestDb();
  ({ db, drop } = t);
  org = t.orgA;
  app = buildServer({ db, organizationId: org, webhookSecret: SECRET, now: () => NOW });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await drop?.();
});

const transfer = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  request_id: `req-${id}-000000`,
  status: "SENT",
  transfer_amount: 25000,
  transfer_currency: "USD",
  ...over,
});

function post(event: unknown, opts: { secret?: string; mutate?: (s: string) => string } = {}) {
  const body = JSON.stringify(event);
  const ts = String(NOW - 1000);
  return app.inject({
    method: "POST",
    url: "/webhooks/airwallex",
    headers: {
      "content-type": "application/json",
      "x-timestamp": ts,
      "x-signature": signWebhook(opts.secret ?? SECRET, ts, body),
    },
    payload: opts.mutate ? opts.mutate(body) : body,
  });
}

const failed = (id: string) => ({
  id: `evt-failed-${id}`,
  name: "payout.transfer.failed",
  created_at: "2026-10-27T11:59:59+0000",
  data: transfer(id, {
    status: "FAILED",
    failure: { message: "Returned by beneficiary bank", details: { type: "BENEFICIARY_BANK_RETURNED" } },
  }),
});

describe("POST /webhooks/airwallex", () => {
  it("200 only after the verified event is stored", async () => {
    const res = await post(failed("tr-1"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "accepted" });
    const rows = await db.select().from(schema.providerEvents).where(eq(schema.providerEvents.providerEventId, "evt-failed-tr-1"));
    expect(rows).toHaveLength(1);
  });

  it("signature is checked over the exact raw bytes (reformatted JSON is rejected)", async () => {
    const res = await post(failed("tr-2"), { mutate: (s) => JSON.stringify(JSON.parse(s), null, 2) });
    expect(res.statusCode).toBe(401);
  });

  it("wrong secret -> 401 and nothing trusted", async () => {
    const res = await post(failed("tr-3"), { secret: "forged" });
    expect(res.statusCode).toBe(401);
    expect((await loadTransferHistory(db, org, "tr-3")).observations).toHaveLength(0);
  });

  it("double delivery (retries, double-click on resend in the dashboard) -> both 200, one event", async () => {
    const [a, b] = await Promise.all([post(failed("tr-4")), post(failed("tr-4"))]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().outcome, b.json().outcome].sort()).toEqual(["accepted", "duplicate"]);
  });

  it("oversized bodies are refused before any processing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/airwallex",
      headers: { "content-type": "application/json", "x-timestamp": String(NOW), "x-signature": "00" },
      payload: "x".repeat(WEBHOOK_BODY_LIMIT + 1),
    });
    expect(res.statusCode).toBe(413);
  });
});

/** AirwallexClient backed by a scripted fake API (no network). */
function fakeClient(byId: Record<string, unknown>) {
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/authentication/login") {
      return new Response(JSON.stringify({ token: "t", expires_at: new Date(NOW + 1_800_000).toISOString() }), { status: 201 });
    }
    const id = decodeURIComponent(u.pathname.split("/").pop()!);
    const body = byId[id];
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('{"code":"not_found"}', { status: 404 });
  }) as unknown as typeof fetch;
  return new AirwallexClient(new AirwallexHttp({ clientId: "c", apiKey: "k", fetch: fetchImpl, now: () => NOW, sleep: async () => {} }));
}

describe("backup poller", () => {
  it("a poll that only sees bare CANCELLED never erases the FAILED reason from the webhook", async () => {
    await post({ id: "evt-sent-tr-5", name: "payout.transfer.sent", data: transfer("tr-5") });
    await post(failed("tr-5"));
    const client = fakeClient({ "tr-5": transfer("tr-5", { status: "CANCELLED", failure: {} }) });
    const r = await pollOnce(db, client, org, ["tr-5"]);
    expect(r).toMatchObject({ polled: 1, newObservations: 1, errors: [] });
    const h = await loadTransferHistory(db, org, "tr-5");
    expect(h.status).toBe("CANCELLED");
    expect(classifyFinality(h)).toMatchObject({ kind: "CONFIRMED_FAILED", failure: { type: "BENEFICIARY_BANK_RETURNED" } });
  });

  it("re-polling an unchanged transfer adds nothing", async () => {
    const client = fakeClient({ "tr-5": transfer("tr-5", { status: "CANCELLED", failure: {} }) });
    expect(await pollOnce(db, client, org, ["tr-5"])).toMatchObject({ newObservations: 0 });
  });

  it("polls only transfers that are not yet CANCELLED, and reports per-transfer errors", async () => {
    await post({ id: "evt-sent-tr-6", name: "payout.transfer.sent", data: transfer("tr-6") });
    const open = await listOpenTransferIds(db, org);
    expect(open).toContain("tr-6");
    expect(open).not.toContain("tr-5");
    const r = await pollOnce(db, fakeClient({}), org, ["tr-6"]);
    expect(r.errors[0]).toMatchObject({ providerTransferId: "tr-6" });
  });
});
