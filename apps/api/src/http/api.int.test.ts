import { randomUUID } from "node:crypto";
import { money } from "@sentinel/contracts";
import {
  type ApprovalKeys,
  type Db,
  beneficiaryDetailsHash,
  createObligation,
  createTestDb,
  createUser,
  openIncident,
  registerOriginalPayment,
} from "@sentinel/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK_MODEL_ID, MockInvestigatorModel } from "../agent/mock-investigator.js";
import { MockProvider } from "../lab/mock-provider.js";
import { buildServer } from "../server.js";

let db: Db;
let org: string;
let orgB: string;
let drop: () => Promise<void>;
let app: FastifyInstance;
const tokens: Record<string, string> = {};
const KEYS: ApprovalKeys = { current: { version: "t1", secret: "k".repeat(48) }, all: { t1: "k".repeat(48) } };

beforeAll(async () => {
  const t = await createTestDb();
  ({ db, drop, orgB } = t);
  org = t.orgA;
  for (const [name, role] of [["owner", "OWNER"], ["operator", "OPERATOR"], ["approver", "APPROVER"], ["viewer", "VIEWER"]] as const) {
    tokens[name] = (await createUser(db, org, { displayName: name, role })).token;
  }
  tokens.intruder = (await createUser(db, orgB, { displayName: "intruder", role: "OWNER" })).token;
  const mocks = new Map<string, MockProvider>();
  app = buildServer({
    db,
    organizationId: org,
    webhookSecret: null,
    api: {
      keys: KEYS,
      airwallex: null,
      mockProvider: (o) => mocks.get(o) ?? mocks.set(o, new MockProvider(db, o)).get(o)!,
      investigator: { model: new MockInvestigatorModel(), modelId: MOCK_MODEL_ID, label: "MOCK AI" },
    },
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await drop?.();
});

async function call(who: string | null, method: "GET" | "POST", url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

describe("authentication and roles", () => {
  it("requires a valid bearer token", async () => {
    expect((await call(null, "GET", "/api/incidents")).status).toBe(401);
    tokens.forged = "sst_" + "A".repeat(43);
    expect((await call("forged", "GET", "/api/incidents")).status).toBe(401);
    expect((await call("viewer", "GET", "/api/me")).json).toMatchObject({ role: "VIEWER" });
  });

  it("viewers can read but not act; operators cannot approve", async () => {
    const { json } = await call("operator", "POST", "/api/lab/scenarios", { scenario: "A", mode: "MOCK" });
    expect((await call("viewer", "GET", `/api/incidents/${json.incidentId}`)).status).toBe(200);
    expect((await call("viewer", "POST", `/api/incidents/${json.incidentId}/evaluate`)).status).toBe(403);
    expect((await call("operator", "POST", `/api/proposals/${randomUUID()}/approve`)).status).toBe(403);
  });

  it("rejects malformed input with 400", async () => {
    expect((await call("operator", "POST", "/api/lab/scenarios", { scenario: "Z", mode: "MOCK" })).status).toBe(400);
    expect((await call("operator", "GET", "/api/incidents/not-a-uuid")).status).toBe(400);
  });
});

describe("Scenario A over HTTP (MOCK provider, MOCK AI)", () => {
  it("WAIT, blocked resend, bank return, REPLACE proposed by the agent, approved, paid, resolved, books balance", async () => {
    const created = await call("operator", "POST", "/api/lab/scenarios", { scenario: "A", mode: "MOCK" });
    expect(created).toMatchObject({ status: 200, json: { recommendation: "WAIT" } });
    const id = created.json.incidentId as string;

    const inv1 = await call("operator", "POST", `/api/incidents/${id}/investigate`);
    expect(inv1.json).toMatchObject({ status: "COMPLETED", label: "MOCK AI", report: { recommendation: "WAIT" } });

    const resend = await call("operator", "POST", `/api/incidents/${id}/resend`);
    expect(resend.json).toMatchObject({ blocked: true });
    expect(resend.json.reasons).toContain("replacement_would_risk_double_payment");

    // Advisory estimate: labelled, WAIT cheapest, REPLACE forbidden rather than priced.
    const est1 = (await call("viewer", "GET", `/api/incidents/${id}`)).json.estimate;
    expect(est1).toMatchObject({ available: true, label: "ILLUSTRATIVE PRIORS", cheapestAllowed: "WAIT", policyRecommendation: "WAIT" });
    expect(est1.costs.find((c: { action: string }) => c.action === "REPLACE")).toEqual({ action: "REPLACE", allowed: false, reason: "forbidden_by_policy" });

    await call("operator", "POST", `/api/lab/incidents/${id}/events`, { event: "ORIGINAL_FAILED_BANK_RETURN" });
    expect((await call("operator", "POST", `/api/incidents/${id}/evaluate`)).json).toMatchObject({ recommendation: "REPLACE", changed: true });
    const est2 = (await call("viewer", "GET", `/api/incidents/${id}`)).json.estimate;
    expect(est2).toMatchObject({ available: true, originalArrivalBps: 0, cheapestAllowed: "REPLACE", policyRecommendation: "REPLACE" });
    const inv2 = await call("operator", "POST", `/api/incidents/${id}/investigate`);
    expect(inv2.json).toMatchObject({ status: "COMPLETED", report: { recommendation: "REPLACE" } });

    const queue = await call("approver", "GET", "/api/approvals");
    const item = queue.json.find((q: { incidentId: string }) => q.incidentId === id);
    expect(item).toMatchObject({ origin: "MOCK_SCENARIO", canApprove: true, facts: { amountMinor: "2500000", currency: "USD" } });
    expect(item.proposedBy).toMatch(/^agent:/);

    const approved = await call("approver", "POST", `/api/proposals/${item.proposalId}/approve`);
    expect(approved.json).toMatchObject({ approved: true, execution: { status: "SUCCEEDED" } });
    expect((await call("approver", "POST", `/api/proposals/${item.proposalId}/approve`)).json).toMatchObject({ approved: false });

    expect((await call("operator", "POST", `/api/incidents/${id}/resolve`)).json).toMatchObject({ resolved: false });
    await call("operator", "POST", `/api/lab/incidents/${id}/events`, { event: "REPLACEMENT_PAID" });
    expect((await call("operator", "POST", `/api/incidents/${id}/resolve`)).json).toEqual({ resolved: true });

    const detail = (await call("viewer", "GET", `/api/incidents/${id}`)).json;
    expect(detail.incident).toMatchObject({ state: "RESOLVED", originalFate: "RETURNED: BENEFICIARY_BANK_RETURNED", origin: "MOCK_SCENARIO" });
    expect(detail.payments.map((p: { role: string; providerStatus: string }) => [p.role, p.providerStatus])).toEqual([
      ["ORIGINAL", "CANCELLED"],
      ["REPLACEMENT", "PAID"],
    ]);
    expect(detail.estimate).toMatchObject({ available: false, reason: "replacement_already_sent" });
    expect(detail.ledger).toMatchObject({ "WALLET:USD": "-2500000", "SUPPLIER_PAYABLE:USD": "0" });
    expect(detail.agentRuns.at(-1).diff.recommendation).toEqual({ from: "WAIT", to: "REPLACE", changed: true });

    const replay = (await call("viewer", "GET", `/api/incidents/${id}/replay`)).json;
    const types = replay.audit.map((a: { type: string }) => a.type);
    expect(types).toEqual(expect.arrayContaining(["incident.opened", "decision.recorded", "resend.blocked", "action.proposed", "approval.granted", "execution.succeeded"]));
    expect(replay.observations.some((o: { status: string; failureType: string }) => o.status === "FAILED" && o.failureType === "BENEFICIARY_BANK_RETURNED")).toBe(true);
    expect((await call("viewer", "GET", "/api/audit/verify")).json).toMatchObject({ ok: true });
  });
});

describe("After resolution: PAID can still fail", () => {
  async function resolvedScenarioA(): Promise<string> {
    const { json } = await call("operator", "POST", "/api/lab/scenarios", { scenario: "A", mode: "MOCK" });
    const id = json.incidentId as string;
    await call("operator", "POST", `/api/lab/incidents/${id}/events`, { event: "ORIGINAL_FAILED_BANK_RETURN" });
    await call("operator", "POST", `/api/incidents/${id}/evaluate`);
    const { json: p } = await call("operator", "POST", `/api/incidents/${id}/propose`);
    expect((await call("approver", "POST", `/api/proposals/${p.proposalId}/approve`)).json).toMatchObject({ approved: true });
    await call("operator", "POST", `/api/lab/incidents/${id}/events`, { event: "REPLACEMENT_PAID" });
    expect((await call("operator", "POST", `/api/incidents/${id}/resolve`)).json).toEqual({ resolved: true });
    return id;
  }

  it("a late return of the settling replacement reopens and escalates; nothing is re-sent and the payable reopens", async () => {
    const id = await resolvedScenarioA();
    expect((await call("operator", "POST", `/api/lab/incidents/${id}/events`, { event: "REPLACEMENT_RETURNED_AFTER_PAID" })).status).toBe(200);
    const d = (await call("viewer", "GET", `/api/incidents/${id}`)).json;
    expect(d.incident.state).toBe("ESCALATED");
    expect(d.incident.escalationReason).toContain("settled_payment_failed_after_paid:REPLACEMENT:BENEFICIARY_BANK_RETURNED");
    // The returned replacement still blocks the invoice: only a person can decide what happens next.
    expect(d.payments.find((p: { role: string }) => p.role === "REPLACEMENT")).toMatchObject({ blocking: true, finality: { kind: "FAILED_AFTER_PAID" } });
    expect(d.ledger).toMatchObject({ "SUPPLIER_PAYABLE:USD": "-2500000", "WALLET:USD": "0", "IN_TRANSIT:USD": "0" });
    expect((await call("operator", "POST", `/api/incidents/${id}/propose`)).status).toBe(409);
    expect((await call("operator", "POST", `/api/incidents/${id}/resend`)).json).toMatchObject({ blocked: true });
    const replay = (await call("viewer", "GET", `/api/incidents/${id}/replay`)).json;
    expect(replay.audit.map((x: { type: string }) => x.type)).toContain("incident.reopened");
    // Re-checking again changes nothing.
    expect((await call("operator", "POST", "/api/reconcile")).json.reopened.map((r: { incidentId: string }) => r.incidentId)).not.toContain(id);
  });

  it("reconciliation reopens a resolved incident when the replaced original turns out to have been PAID", async () => {
    const id = await resolvedScenarioA();
    // A late PAID for the returned original: it was paid before it failed, which the replacement assumed it never was.
    await call("operator", "POST", `/api/lab/incidents/${id}/events`, { event: "ORIGINAL_PAID" });
    expect((await call("viewer", "GET", `/api/incidents/${id}`)).json.incident.state).toBe("RESOLVED");
    const rec = (await call("operator", "POST", "/api/reconcile")).json;
    expect(rec.reopened).toContainEqual({ incidentId: id, reasons: ["unsettled_payment_was_paid:ORIGINAL"] });
    expect((await call("viewer", "GET", `/api/incidents/${id}`)).json.incident.state).toBe("ESCALATED");
  });
});

describe("Scenario B and C over HTTP", () => {
  it("B: 10 racing approvals and executors produce one approval and one provider transfer", async () => {
    const { json } = await call("operator", "POST", "/api/lab/scenarios", { scenario: "B", mode: "MOCK" });
    expect(json.recommendation).toBe("REPLACE");
    expect((await call("operator", "POST", `/api/incidents/${json.incidentId}/propose`)).status).toBe(200);
    const race = await call("operator", "POST", `/api/lab/incidents/${json.incidentId}/race`, { approvers: 10, executors: 10 });
    expect(race.json).toMatchObject({ label: "MOCK", approvalAttempts: 10, approvalsGranted: 1, providerTransfersCreated: 1, replacementPayments: 1 });
  });

  it("C: the fraud email escalates on creation and no replacement can be proposed", async () => {
    const { json } = await call("operator", "POST", "/api/lab/scenarios", { scenario: "C", mode: "MOCK" });
    expect(json.recommendation).toBe("ESCALATE");
    const detail = (await call("viewer", "GET", `/api/incidents/${json.incidentId}`)).json;
    expect(detail.incident.riskFlags.sort()).toEqual(["BANK_DETAIL_CHANGE_REQUEST", "PROMPT_INJECTION_SUSPECTED"]);
    expect(detail.evidence.filter((e: { trusted: boolean }) => !e.trusted)).toHaveLength(2);
    const propose = await call("operator", "POST", `/api/incidents/${json.incidentId}/propose`);
    expect(propose.status).toBe(409);
  });

  it("four-eyes: an owner cannot approve the proposal they made", async () => {
    const { json } = await call("owner", "POST", "/api/lab/scenarios", { scenario: "B", mode: "MOCK" });
    const { json: p } = await call("owner", "POST", `/api/incidents/${json.incidentId}/propose`);
    expect((await call("owner", "GET", "/api/approvals")).json.find((a: { proposalId: string }) => a.proposalId === p.proposalId).canApprove).toBe(false);
    expect((await call("owner", "POST", `/api/proposals/${p.proposalId}/approve`)).json).toEqual({ approved: false, reasons: ["four_eyes:approver_is_proposer"] });
    expect((await call("approver", "POST", `/api/proposals/${p.proposalId}/approve`)).json).toMatchObject({ approved: true });
  });

  it("an approver can reject; the incident goes back to investigation", async () => {
    const { json } = await call("operator", "POST", "/api/lab/scenarios", { scenario: "B", mode: "MOCK" });
    const { json: p } = await call("operator", "POST", `/api/incidents/${json.incidentId}/propose`);
    expect((await call("approver", "POST", `/api/proposals/${p.proposalId}/reject`, { reason: "Supplier confirmed by phone it was received." })).json).toEqual({ rejected: true });
    expect((await call("viewer", "GET", `/api/incidents/${json.incidentId}`)).json.incident.state).toBe("INVESTIGATING");
  });
});

describe("isolation and guard rails", () => {
  it("another tenant sees nothing and cannot approve", async () => {
    const { json } = await call("operator", "POST", "/api/lab/scenarios", { scenario: "B", mode: "MOCK" });
    const { json: p } = await call("operator", "POST", `/api/incidents/${json.incidentId}/propose`);
    expect((await call("intruder", "GET", `/api/incidents/${json.incidentId}`)).status).toBe(404);
    expect((await call("intruder", "GET", "/api/incidents")).json).toEqual([]);
    expect((await call("intruder", "POST", `/api/proposals/${p.proposalId}/approve`)).json).toEqual({ approved: false, reasons: ["proposal_not_found"] });
  });

  it("Lab events cannot be applied to real sandbox incidents, and sandbox actions need keys", async () => {
    const obligationId = await createObligation(db, org, {
      supplierRef: "real",
      invoiceRef: `R-${randomUUID().slice(0, 6)}`,
      amount: money(1000n, "USD"),
      beneficiaryId: "b",
      beneficiaryHash: beneficiaryDetailsHash({ a: 1 }),
      dueAt: new Date(),
    });
    await registerOriginalPayment(db, org, { obligationId, requestId: `req-${randomUUID()}`.slice(0, 40), providerTransferId: `real-${randomUUID()}` });
    const id = await openIncident(db, org, obligationId);
    expect((await call("operator", "POST", `/api/lab/incidents/${id}/events`, { event: "ORIGINAL_PAID" })).status).toBe(409);
    expect((await call("operator", "POST", `/api/incidents/${id}/evaluate`)).status).toBe(503);
  });

  it("Agent Activity and Reconciliation are read-only views scoped to the tenant", async () => {
    const { json } = await call("operator", "POST", "/api/lab/scenarios", { scenario: "A", mode: "MOCK" });
    await call("operator", "POST", `/api/incidents/${json.incidentId}/investigate`);
    const runs = (await call("viewer", "GET", "/api/agent-runs")).json;
    const mine = runs.runs.find((r: { incidentId: string }) => r.incidentId === json.incidentId);
    expect(mine).toMatchObject({ status: "COMPLETED", model: "mock-investigator", origin: "MOCK_SCENARIO", reportRecommendation: "WAIT", policyRecommendation: "WAIT", verification: { ok: true, errors: 0 } });
    expect(mine.toolCalls.length).toBeGreaterThan(0);
    expect(runs.totals.find((t: { status: string }) => t.status === "COMPLETED").runs).toBeGreaterThan(0);
    expect((await call("intruder", "GET", "/api/agent-runs")).json).toEqual({ totals: [], runs: [] });

    expect((await call("viewer", "POST", "/api/reconcile")).status).toBe(403);
    const run = (await call("operator", "POST", "/api/reconcile")).json;
    const view = (await call("viewer", "GET", "/api/reconciliation")).json;
    expect(view.runs[0]).toMatchObject({ id: run.id, ok: run.ok });
    expect(view.providerTransfers.seen).toBeGreaterThan(0);
    expect(view.ledger.length).toBeGreaterThan(0);
    expect((await call("intruder", "GET", "/api/reconciliation")).json).toEqual({ runs: [], ledger: [], providerTransfers: { seen: 0, linkedToPayments: 0 } });
  });

  it("overview reports modes honestly", async () => {
    expect((await call("viewer", "GET", "/api/overview")).json.modes).toEqual({ airwallex: "NOT_CONFIGURED", investigator: "MOCK AI", investigatorModel: "mock-investigator" });
  });
});
