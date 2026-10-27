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

    await call("operator", "POST", `/api/lab/incidents/${id}/events`, { event: "ORIGINAL_FAILED_BANK_RETURN" });
    expect((await call("operator", "POST", `/api/incidents/${id}/evaluate`)).json).toMatchObject({ recommendation: "REPLACE", changed: true });
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
    expect(detail.ledger).toMatchObject({ "WALLET:USD": "-2500000", "SUPPLIER_PAYABLE:USD": "0" });
    expect(detail.agentRuns.at(-1).diff.recommendation).toEqual({ from: "WAIT", to: "REPLACE", changed: true });

    const replay = (await call("viewer", "GET", `/api/incidents/${id}/replay`)).json;
    const types = replay.audit.map((a: { type: string }) => a.type);
    expect(types).toEqual(expect.arrayContaining(["incident.opened", "decision.recorded", "resend.blocked", "action.proposed", "approval.granted", "execution.succeeded"]));
    expect(replay.observations.some((o: { status: string; failureType: string }) => o.status === "FAILED" && o.failureType === "BENEFICIARY_BANK_RETURNED")).toBe(true);
    expect((await call("viewer", "GET", "/api/audit/verify")).json).toMatchObject({ ok: true });
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

  it("overview reports modes honestly", async () => {
    expect((await call("viewer", "GET", "/api/overview")).json.modes).toEqual({ airwallex: "NOT_CONFIGURED", investigator: "MOCK AI", investigatorModel: "mock-investigator" });
  });
});
