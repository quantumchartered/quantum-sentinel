import {
  type ApprovalKeys,
  type BalanceSource,
  type Db,
  type ExecutionProvider,
  SafetyError,
  type UserRole,
  type UserRow,
  appendAudit,
  applyTransition,
  approveProposal,
  attemptManualResend,
  authenticateToken,
  evaluateIncident,
  executeReplacement,
  getIncident,
  ingestSupplierMessage,
  recheckResolvedIncidents,
  loadAuditChain,
  lockIncidentWithObligation,
  paymentsForObligation,
  proposeReplacement,
  runReconciliation,
  schema,
  syncLedgerForObligation,
  accountBalances,
  tryResolveIncident,
  verifyStoredAuditChain,
} from "@sentinel/db";
import { ESTIMATE_PRIORS, classifyFinality, estimate, foldObservations } from "@sentinel/policy";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { diffRevisions } from "../agent/diff.js";
import { runInvestigation } from "../agent/loop.js";
import type { ModelClient } from "../agent/model.js";
import type { IncidentReport } from "../agent/report.js";
import { LAB_EVENTS, SCENARIOS, applyLabEvent, createMockScenario, raceApprovals } from "../lab/scenarios.js";
import type { MockProvider } from "../lab/mock-provider.js";

export type Provider = ExecutionProvider & BalanceSource;

export interface ApiDeps {
  db: Db;
  keys: ApprovalKeys;
  /** Real Airwallex (SANDBOX) provider, or null when no keys are configured. */
  airwallex: Provider | null;
  /** One MOCK provider per organization (Scenario Lab MOCK mode). */
  mockProvider: (organizationId: string) => MockProvider;
  /** The investigator model and its id (real Claude or the MOCK investigator). */
  investigator: { model: ModelClient; modelId: string; label: "CLAUDE" | "MOCK AI" };
  now?: () => number;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRow;
  }
}

const READ: UserRole[] = ["OWNER", "APPROVER", "OPERATOR", "VIEWER"];
const OPERATE: UserRole[] = ["OWNER", "OPERATOR"];
const APPROVE: UserRole[] = ["OWNER", "APPROVER"];

class HttpError extends Error {
  readonly status: number;
  readonly reasons: string[];
  constructor(status: number, message: string, reasons: string[] = []) {
    super(message);
    this.status = status;
    this.reasons = reasons;
  }
}

const actorOf = (u: UserRow) => `user:${u.id}`;
const Id = z.object({ id: z.uuid() });

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;

  const providerFor = async (organizationId: string, incidentId: string): Promise<Provider> => {
    const inc = await getIncident(db, organizationId, incidentId);
    if (inc.origin === "MOCK_SCENARIO") return deps.mockProvider(organizationId);
    if (!deps.airwallex) throw new HttpError(503, "Airwallex sandbox is not configured (add keys to .env)");
    return deps.airwallex;
  };

  const guard = (roles: UserRole[]) => async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    const token = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    const user = token ? await authenticateToken(db, token) : null;
    if (!user) throw new HttpError(401, "sign in required");
    if (!roles.includes(user.role)) throw new HttpError(403, `role ${user.role} cannot do this`);
    req.user = user;
  };
  const u = (req: FastifyRequest) => req.user!;
  const org = (req: FastifyRequest) => req.user!.organizationId;

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, reasons: err.reasons });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid request", reasons: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    if (err instanceof SafetyError) {
      const status = /not found/.test(err.message) ? 404 : 409;
      return reply.code(status).send({ error: err.message, reasons: err.reasons });
    }
    const fe = err as { statusCode?: number; message?: string };
    if (fe.statusCode && fe.statusCode < 500) return reply.code(fe.statusCode).send({ error: fe.message ?? "bad request", reasons: [] });
    req.log.error(err);
    return reply.code(500).send({ error: "internal error", reasons: [] });
  });

  // ---------- reads ----------

  app.get("/api/me", { preHandler: guard(READ) }, async (req) => {
    const user = u(req);
    return { id: user.id, displayName: user.displayName, role: user.role, organizationId: user.organizationId };
  });

  app.get("/api/overview", { preHandler: guard(READ) }, async (req) => {
    const o = org(req);
    const byState = await db
      .select({ state: schema.incidents.state, n: sql<number>`count(*)::int` })
      .from(schema.incidents)
      .where(eq(schema.incidents.organizationId, o))
      .groupBy(schema.incidents.state);
    const audit = await verifyStoredAuditChain(db, o);
    const [runs] = await db
      .select({ n: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(cost_micro_usd),0)::text` })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.organizationId, o));
    const [blocked] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.organizationId, o), inArray(schema.auditEvents.eventType, ["resend.blocked", "execution.blocked", "approval.rejected_stale", "agent.proposal_blocked", "agent.unknown_tool"])));
    return {
      incidentsByState: Object.fromEntries(byState.map((r) => [r.state, r.n])),
      auditChain: audit,
      agentRuns: { count: runs?.n ?? 0, costMicroUsd: runs?.cost ?? "0" },
      unsafeActionsBlocked: blocked?.n ?? 0,
      modes: { airwallex: deps.airwallex ? "SANDBOX" : "NOT_CONFIGURED", investigator: deps.investigator.label, investigatorModel: deps.investigator.modelId },
    };
  });

  app.get("/api/incidents", { preHandler: guard(READ) }, async (req) => {
    const o = org(req);
    const rows = await db
      .select({ i: schema.incidents, ob: schema.obligations })
      .from(schema.incidents)
      .innerJoin(schema.obligations, and(eq(schema.obligations.id, schema.incidents.obligationId), eq(schema.obligations.organizationId, schema.incidents.organizationId)))
      .where(eq(schema.incidents.organizationId, o))
      .orderBy(desc(schema.incidents.updatedAt));
    return rows.map(({ i, ob }) => ({
      id: i.id,
      title: i.title ?? `${ob.supplierRef} ${ob.invoiceRef}`,
      origin: i.origin,
      state: i.state,
      recommendation: i.recommendation,
      riskFlags: i.riskFlags,
      amountMinor: ob.amountMinor.toString(),
      currency: ob.currency,
      supplierRef: ob.supplierRef,
      invoiceRef: ob.invoiceRef,
      dueAt: ob.dueAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    }));
  });

  app.get("/api/incidents/:id", { preHandler: guard(READ) }, async (req) => {
    const o = org(req);
    const { id } = Id.parse(req.params);
    const inc = await getIncident(db, o, id);
    const [ob] = await db.select().from(schema.obligations).where(and(eq(schema.obligations.organizationId, o), eq(schema.obligations.id, inc.obligationId)));
    const pays = await paymentsForObligation(db, o, inc.obligationId);
    const payments = await Promise.all(
      pays.map(async (p) => {
        const obs = p.providerTransferId
          ? await db
              .select()
              .from(schema.transferObservations)
              .where(and(eq(schema.transferObservations.organizationId, o), eq(schema.transferObservations.providerTransferId, p.providerTransferId)))
              .orderBy(asc(schema.transferObservations.id))
          : [];
        const h = foldObservations(
          obs.map((r) => ({
            source: r.source,
            eventId: r.providerEventId,
            rawStatus: r.rawStatus,
            observedAt: r.observedAt.toISOString(),
            failure: r.failureType || r.failureMessage || r.failureCode || r.failureReasonCodes.length ? { code: r.failureCode, message: r.failureMessage, type: r.failureType, reasonCodes: r.failureReasonCodes } : null,
          })),
        );
        return {
          id: p.id,
          role: p.role,
          state: p.state,
          blocking: p.blocking,
          requestId: p.requestId,
          providerTransferId: p.providerTransferId,
          amountMinor: p.amountMinor.toString(),
          currency: p.currency,
          failureType: p.failureType,
          providerStatus: h.status,
          finality: classifyFinality(h),
          failures: h.failures,
          observations: obs.map((r) => ({ id: `obs:${r.id}`, source: r.source, status: r.rawStatus, failureType: r.failureType, failureMessage: r.failureMessage, observedAt: r.observedAt.toISOString() })),
        };
      }),
    );
    const evidence = await db
      .select()
      .from(schema.evidence)
      .where(and(eq(schema.evidence.organizationId, o), eq(schema.evidence.incidentId, id)))
      .orderBy(asc(schema.evidence.capturedAt));
    const decisions = await db
      .select()
      .from(schema.decisions)
      .where(and(eq(schema.decisions.organizationId, o), eq(schema.decisions.incidentId, id)))
      .orderBy(asc(schema.decisions.decidedAt), asc(schema.decisions.incidentVersion));
    const proposals = await db
      .select()
      .from(schema.proposedActions)
      .where(and(eq(schema.proposedActions.organizationId, o), eq(schema.proposedActions.incidentId, id)))
      .orderBy(asc(schema.proposedActions.createdAt));
    const runs = await agentRunsWithDiffs(db, o, id);
    const [orgRow] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, o));
    return {
      incident: { ...inc, openedAt: inc.openedAt.toISOString(), updatedAt: inc.updatedAt.toISOString() },
      obligation: ob && { ...ob, amountMinor: ob.amountMinor.toString(), dueAt: ob.dueAt.toISOString() },
      payments,
      evidence: evidence.map((e) => ({ id: `ev:${e.id}`, kind: e.kind, source: e.source, ref: e.ref, trusted: e.trusted, content: e.content, capturedAt: e.capturedAt.toISOString() })),
      decisions: decisions.map((d) => ({ id: `dec:${d.id}`, version: d.incidentVersion, recommendation: d.recommendation, reasons: d.reasons, policyVersion: d.policyVersion, decidedAt: d.decidedAt.toISOString() })),
      proposals: proposals.map((p) => ({ id: p.id, incidentVersion: p.incidentVersion, proposedBy: p.proposedBy, facts: p.facts, createdAt: p.createdAt.toISOString(), current: inc.state === "AWAITING_APPROVAL" && p.incidentVersion === inc.version })),
      agentRuns: runs,
      ledger: Object.fromEntries(Object.entries(await accountBalances(db, o, inc.obligationId)).map(([k, v]) => [k, v.toString()])),
      estimate: ob ? costEstimate({ payments, obligation: ob, latest: decisions.at(-1)?.recommendation ?? null, feeMinor: orgRow?.replacementFeeMinor ?? 0n, now: deps.now?.() ?? Date.now() }) : null,
    };
  });

  /** Decision Replay: every timestamped thing that happened, so the client can rebuild "what was known" at any point. */
  app.get("/api/incidents/:id/replay", { preHandler: guard(READ) }, async (req) => {
    const o = org(req);
    const { id } = Id.parse(req.params);
    const inc = await getIncident(db, o, id);
    const pays = await paymentsForObligation(db, o, inc.obligationId);
    const transferIds = pays.map((p) => p.providerTransferId).filter((x): x is string => !!x);
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.organizationId, o),
          or(
            sql`${schema.auditEvents.payload}->>'incidentId' = ${id}`,
            sql`${schema.auditEvents.payload}->>'obligationId' = ${inc.obligationId}`,
            // Payment-level events (execution, failure confirmation) carry the payment id instead.
            pays.length ? inArray(sql`${schema.auditEvents.payload}->>'paymentId'`, pays.map((p) => p.id)) : sql`false`,
          ),
        ),
      )
      .orderBy(asc(schema.auditEvents.seq));
    const observations = transferIds.length
      ? await db
          .select()
          .from(schema.transferObservations)
          .where(and(eq(schema.transferObservations.organizationId, o), inArray(schema.transferObservations.providerTransferId, transferIds)))
          .orderBy(asc(schema.transferObservations.id))
      : [];
    const evidence = await db.select().from(schema.evidence).where(and(eq(schema.evidence.organizationId, o), eq(schema.evidence.incidentId, id)));
    const roleOf = new Map(pays.map((p) => [p.providerTransferId, p.role]));
    return {
      incidentId: id,
      origin: inc.origin,
      audit: audit.map((a) => ({ seq: a.seq, at: a.occurredAt, actor: a.actor, type: a.eventType, payload: a.payload, hash: a.hash })),
      observations: observations.map((r) => ({
        id: `obs:${r.id}`,
        at: r.observedAt.toISOString(),
        paymentRole: roleOf.get(r.providerTransferId) ?? null,
        providerTransferId: r.providerTransferId,
        source: r.source,
        status: r.rawStatus,
        failureType: r.failureType,
        failureMessage: r.failureMessage,
      })),
      evidence: evidence.map((e) => ({ id: `ev:${e.id}`, at: e.capturedAt.toISOString(), kind: e.kind, source: e.source, trusted: e.trusted })),
      agentRuns: await agentRunsWithDiffs(db, o, id),
    };
  });

  app.get("/api/approvals", { preHandler: guard(READ) }, async (req) => {
    const o = org(req);
    const rows = await db
      .select({ p: schema.proposedActions, i: schema.incidents })
      .from(schema.proposedActions)
      .innerJoin(schema.incidents, and(eq(schema.incidents.id, schema.proposedActions.incidentId), eq(schema.incidents.organizationId, schema.proposedActions.organizationId)))
      .where(and(eq(schema.proposedActions.organizationId, o), eq(schema.incidents.state, "AWAITING_APPROVAL"), sql`${schema.proposedActions.incidentVersion} = ${schema.incidents.version}`))
      .orderBy(asc(schema.proposedActions.createdAt));
    return rows.map(({ p, i }) => ({
      proposalId: p.id,
      incidentId: i.id,
      incidentTitle: i.title,
      origin: i.origin,
      proposedBy: p.proposedBy,
      proposedAt: p.createdAt.toISOString(),
      facts: p.facts,
      canApprove: p.proposedBy !== actorOf(u(req)) && APPROVE.includes(u(req).role),
    }));
  });

  app.get("/api/audit", { preHandler: guard(READ) }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const chain = await loadAuditChain(db, org(req));
    return chain.slice(-q.limit).reverse();
  });

  app.get("/api/audit/verify", { preHandler: guard(READ) }, async (req) => verifyStoredAuditChain(db, org(req)));

  /** Agent Activity: every investigator run in the organization, newest first. */
  app.get("/api/agent-runs", { preHandler: guard(READ) }, async (req) => {
    const o = org(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const rows = await db
      .select({ r: schema.agentRuns, title: schema.incidents.title, origin: schema.incidents.origin })
      .from(schema.agentRuns)
      .innerJoin(schema.incidents, and(eq(schema.incidents.id, schema.agentRuns.incidentId), eq(schema.incidents.organizationId, schema.agentRuns.organizationId)))
      .where(eq(schema.agentRuns.organizationId, o))
      .orderBy(desc(schema.agentRuns.finishedAt))
      .limit(q.limit);
    const totals = await db
      .select({
        status: schema.agentRuns.status,
        n: sql<number>`count(*)::int`,
        inputTokens: sql<string>`coalesce(sum(input_tokens),0)::text`,
        outputTokens: sql<string>`coalesce(sum(output_tokens),0)::text`,
        cost: sql<string>`coalesce(sum(cost_micro_usd),0)::text`,
      })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.organizationId, o))
      .groupBy(schema.agentRuns.status);
    return {
      totals: totals.map((t) => ({ status: t.status, runs: t.n, inputTokens: t.inputTokens, outputTokens: t.outputTokens, costMicroUsd: t.cost })),
      runs: rows.map(({ r, title, origin }) => {
        const report = r.report as IncidentReport | null;
        const v = r.verification as { ok: boolean; errors: unknown[]; warnings: unknown[] } | null;
        return {
          id: r.id,
          incidentId: r.incidentId,
          incidentTitle: title,
          origin,
          status: r.status,
          model: r.model,
          incidentVersion: r.incidentVersion,
          policyRecommendation: r.policyRecommendation,
          reportRecommendation: report?.recommendation ?? null,
          steps: r.steps,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          costMicroUsd: r.costMicroUsd.toString(),
          toolCalls: r.toolCalls,
          verification: v && { ok: v.ok, errors: v.errors.length, warnings: v.warnings.length },
          error: r.error,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt.toISOString(),
        };
      }),
    };
  });

  /** Reconciliation view: recent runs with findings, and the organization's ledger totals. */
  app.get("/api/reconciliation", { preHandler: guard(READ) }, async (req) => {
    const o = org(req);
    const runs = await db
      .select()
      .from(schema.reconciliationRuns)
      .where(eq(schema.reconciliationRuns.organizationId, o))
      .orderBy(desc(schema.reconciliationRuns.startedAt))
      .limit(20);
    const ledger = await db
      .select({ account: schema.ledgerEntries.account, currency: schema.ledgerEntries.currency, total: sql<string>`sum(amount_minor)::text`, lines: sql<number>`count(*)::int` })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.organizationId, o))
      .groupBy(schema.ledgerEntries.account, schema.ledgerEntries.currency)
      .orderBy(asc(schema.ledgerEntries.currency), asc(schema.ledgerEntries.account));
    const [transfers] = await db
      .select({ seen: sql<number>`count(distinct provider_transfer_id)::int` })
      .from(schema.transferObservations)
      .where(eq(schema.transferObservations.organizationId, o));
    const [linked] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.payments)
      .where(and(eq(schema.payments.organizationId, o), sql`${schema.payments.providerTransferId} is not null`));
    return {
      runs: runs.map((r) => ({ id: r.id, startedAt: r.startedAt.toISOString(), ok: r.ok, findings: r.findings })),
      ledger,
      providerTransfers: { seen: transfers?.seen ?? 0, linkedToPayments: linked?.n ?? 0 },
    };
  });

  // ---------- operator actions ----------

  app.post("/api/incidents/:id/evaluate", { preHandler: guard(OPERATE) }, async (req) => {
    const { id } = Id.parse(req.params);
    const provider = await providerFor(org(req), id);
    const e = await evaluateIncident(db, provider, org(req), id, { actor: actorOf(u(req)) });
    return { recommendation: e.decision.recommendation, reasons: e.decision.reasons, changed: e.changed, state: e.incident.state };
  });

  app.post("/api/incidents/:id/investigate", { preHandler: guard(OPERATE) }, async (req) => {
    const { id } = Id.parse(req.params);
    const r = await runInvestigation({ db, model: deps.investigator.model, organizationId: org(req), incidentId: id, config: { model: deps.investigator.modelId } });
    return { runId: r.runId, status: r.status, label: deps.investigator.label, report: r.report, verification: r.verification, costMicroUsd: r.costMicroUsd?.toString() ?? null, error: r.error };
  });

  app.post("/api/incidents/:id/resend", { preHandler: guard(OPERATE) }, async (req) => {
    const { id } = Id.parse(req.params);
    return attemptManualResend(db, await providerFor(org(req), id), org(req), id, actorOf(u(req)));
  });

  app.post("/api/incidents/:id/propose", { preHandler: guard(OPERATE) }, async (req) => {
    const { id } = Id.parse(req.params);
    return { proposalId: await proposeReplacement(db, org(req), id, actorOf(u(req))) };
  });

  app.post("/api/incidents/:id/supplier-messages", { preHandler: guard(OPERATE) }, async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ from: z.string().min(3).max(200), subject: z.string().max(300), body: z.string().min(1).max(10_000) }).parse(req.body);
    const inc = await getIncident(db, org(req), id);
    return ingestSupplierMessage(db, org(req), id, { ...body, receivedAt: new Date().toISOString(), synthetic: inc.origin === "MOCK_SCENARIO" }, actorOf(u(req)));
  });

  app.post("/api/incidents/:id/escalate", { preHandler: guard(OPERATE) }, async (req) => {
    const { id } = Id.parse(req.params);
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    await db.transaction(async (tx) => {
      const { incident } = await lockIncidentWithObligation(tx, org(req), id);
      await applyTransition(tx, org(req), incident, { type: "ESCALATE", reason }, actorOf(u(req)));
    });
    return { state: "ESCALATED" };
  });

  app.post("/api/incidents/:id/resolve", { preHandler: guard(OPERATE) }, async (req) => {
    const { id } = Id.parse(req.params);
    const r = await tryResolveIncident(db, org(req), id, actorOf(u(req)));
    if (r.resolved) await syncLedgerForObligation(db, org(req), (await getIncident(db, org(req), id)).obligationId);
    return r;
  });

  app.post("/api/reconcile", { preHandler: guard(OPERATE) }, async (req) => {
    // A late failure of a settled payment reopens its incident (escalated to a person) before the books are checked.
    const reopened = await recheckResolvedIncidents(db, org(req), actorOf(u(req)));
    for (const r of reopened) await syncLedgerForObligation(db, org(req), (await getIncident(db, org(req), r.incidentId)).obligationId);
    return { ...(await runReconciliation(db, org(req))), reopened };
  });

  // ---------- approver actions ----------

  app.post("/api/proposals/:id/approve", { preHandler: guard(APPROVE) }, async (req) => {
    const { id } = Id.parse(req.params);
    const o = org(req);
    const result = await approveProposal(db, o, { proposedActionId: id, approverId: actorOf(u(req)), keys: deps.keys, ...(deps.now ? { now: deps.now() } : {}) });
    if (!result.ok) return { approved: false, reasons: result.reasons };
    // Execute straight away; the background worker retries anything left PENDING or UNCERTAIN.
    const [p] = await db.select().from(schema.proposedActions).where(and(eq(schema.proposedActions.organizationId, o), eq(schema.proposedActions.id, id)));
    const provider = await providerFor(o, p!.incidentId);
    const execution = await executeReplacement(db, provider, o, result.executionId, { keys: deps.keys });
    return { approved: true, executionId: result.executionId, execution };
  });

  app.post("/api/proposals/:id/reject", { preHandler: guard(APPROVE) }, async (req) => {
    const { id } = Id.parse(req.params);
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    const o = org(req);
    const [p] = await db.select().from(schema.proposedActions).where(and(eq(schema.proposedActions.organizationId, o), eq(schema.proposedActions.id, id)));
    if (!p) throw new HttpError(404, "proposal not found");
    await db.transaction(async (tx) => {
      const { incident } = await lockIncidentWithObligation(tx, o, p.incidentId);
      if (incident.state !== "AWAITING_APPROVAL" || incident.version !== p.incidentVersion) throw new SafetyError("proposal is no longer current");
      await applyTransition(tx, o, incident, { type: "REJECT" }, actorOf(u(req)));
      await appendAudit(tx, o, { actor: actorOf(u(req)), eventType: "approval.rejected", payload: { incidentId: p.incidentId, proposedActionId: id, reason } });
    });
    return { rejected: true };
  });

  // ---------- Scenario Lab (MOCK mode) ----------

  app.get("/api/lab/scenarios", { preHandler: guard(READ) }, async () => ({ scenarios: SCENARIOS, events: LAB_EVENTS, modes: { MOCK: true, SANDBOX: false } }));

  app.post("/api/lab/scenarios", { preHandler: guard(OPERATE) }, async (req) => {
    const body = z.object({ scenario: z.enum(["A", "B", "C"]), mode: z.literal("MOCK") }).parse(req.body);
    const incidentId = await createMockScenario(db, deps.mockProvider(org(req)), org(req), body.scenario, actorOf(u(req)));
    const e = await evaluateIncident(db, deps.mockProvider(org(req)), org(req), incidentId, { actor: actorOf(u(req)) });
    return { incidentId, recommendation: e.decision.recommendation };
  });

  app.post("/api/lab/incidents/:id/events", { preHandler: guard(OPERATE) }, async (req) => {
    const { id } = Id.parse(req.params);
    const { event } = z.object({ event: z.enum(LAB_EVENTS) }).parse(req.body);
    await applyLabEvent(db, deps.mockProvider(org(req)), org(req), id, event, actorOf(u(req)));
    return { applied: event, label: "MOCK" };
  });

  app.post("/api/lab/incidents/:id/race", { preHandler: guard(OPERATE) }, async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ approvers: z.number().int().min(1).max(25).default(10), executors: z.number().int().min(1).max(25).default(10) }).parse(req.body ?? {});
    return raceApprovals(db, deps.mockProvider(org(req)), org(req), id, deps.keys, body);
  });
}

/**
 * Advisory arrival and cost estimate (illustrative priors). Computed on read and
 * never stored as a decision input: policy alone decides what is allowed.
 */
function costEstimate(p: {
  payments: { role: string; finality: ReturnType<typeof classifyFinality>; observations: { status: string; observedAt: string }[] }[];
  obligation: { amountMinor: bigint; currency: string; dueAt: Date };
  latest: string | null;
  feeMinor: bigint;
  now: number;
}) {
  const meta = { priorsVersion: ESTIMATE_PRIORS.version, label: ESTIMATE_PRIORS.label };
  if (p.payments.some((x) => x.role === "REPLACEMENT")) return { available: false as const, reason: "replacement_already_sent", ...meta };
  const original = p.payments.find((x) => x.role === "ORIGINAL");
  if (!original) return { available: false as const, reason: "no_original_payment", ...meta };
  const sentAt = original.observations.find((x) => x.status === "SENT" || x.status === "PROCESSING")?.observedAt;
  const hours = (ms: number) => Math.floor(ms / 3_600_000);
  const e = estimate({
    original: original.finality,
    hoursSinceSent: sentAt ? Math.max(0, hours(p.now - Date.parse(sentAt))) : null,
    hoursUntilDue: hours(p.obligation.dueAt.getTime() - p.now),
    amountMinor: p.obligation.amountMinor,
    currency: p.obligation.currency,
    replacementFeeMinor: p.feeMinor,
    replacementAllowed: p.latest === "REPLACE",
  });
  const json = JSON.parse(JSON.stringify(e, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as Record<string, unknown>;
  return { ...json, policyRecommendation: p.latest, priors: e.available ? { horizonHours: ESTIMATE_PRIORS.horizonHours, reviewDelayHours: ESTIMATE_PRIORS.reviewDelayHours, delayCostBpsPerDay: ESTIMATE_PRIORS.delayCostBpsPerDay } : undefined };
}

/** Agent runs for an incident, each with the diff from the previous completed run. */
async function agentRunsWithDiffs(db: Db, organizationId: string, incidentId: string) {
  const runs = await db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.organizationId, organizationId), eq(schema.agentRuns.incidentId, incidentId)))
    .orderBy(asc(schema.agentRuns.finishedAt));
  const decisions = await db
    .select()
    .from(schema.decisions)
    .where(and(eq(schema.decisions.organizationId, organizationId), eq(schema.decisions.incidentId, incidentId)))
    .orderBy(asc(schema.decisions.decidedAt));
  const reasonsAt = (t: Date) => [...decisions].reverse().find((d) => d.decidedAt <= t)?.reasons ?? [];
  let prev: (typeof runs)[number] | null = null;
  return runs.map((r) => {
    const report = r.report as IncidentReport | null;
    const diff =
      r.status === "COMPLETED" && prev
        ? diffRevisions(
            { report: prev.report as IncidentReport | null, reasons: reasonsAt(prev.finishedAt), recommendation: prev.policyRecommendation },
            { report, reasons: reasonsAt(r.finishedAt), recommendation: r.policyRecommendation },
          )
        : null;
    if (r.status === "COMPLETED") prev = r;
    return {
      id: r.id,
      status: r.status,
      model: r.model,
      incidentVersion: r.incidentVersion,
      policyRecommendation: r.policyRecommendation,
      steps: r.steps,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costMicroUsd: r.costMicroUsd.toString(),
      toolCalls: r.toolCalls,
      evidenceShown: r.evidenceShown,
      report,
      verification: r.verification,
      error: r.error,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt.toISOString(),
      diff,
    };
  });
}
