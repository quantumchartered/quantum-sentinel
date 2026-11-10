import { randomUUID } from "node:crypto";
import type { CurrentBalance } from "@sentinel/airwallex";
import type { Money } from "@sentinel/contracts";
import {
  type Canonicalizable,
  type CurrentFacts,
  type Decision,
  type DecisionInput,
  type IncidentEvent,
  POLICY_VERSION,
  type RiskFlag,
  canonicalJson,
  classifyFinality,
  failureCause,
  decide,
  detectSupplierTextSignals,
  evidenceSetHash,
  sha256Hex,
  transitionIncident,
} from "@sentinel/policy";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { type Tx, appendAudit } from "./audit.js";
import type { Db } from "./client.js";
import { loadTransferHistory } from "./event-store.js";
import {
  type EvidenceKind,
  type IncidentOrigin,
  decisions,
  evidence,
  incidents,
  obligations,
  organizations,
  payments,
  proposedActions,
  transferObservations,
} from "./schema.js";

export class SafetyError extends Error {
  override name = "SafetyError";
  readonly reasons: string[];
  constructor(message: string, reasons: string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.reasons = reasons;
  }
}

export type IncidentRow = typeof incidents.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type ObligationRow = typeof obligations.$inferSelect;

/** Hash of the beneficiary's bank details as the provider reports them. */
export function beneficiaryDetailsHash(bankDetails: unknown): string {
  if (!bankDetails || typeof bankDetails !== "object") throw new SafetyError("beneficiary bank details missing");
  return sha256Hex(canonicalJson(bankDetails as Canonicalizable));
}

// ---------- tenant-scoped loaders (organizationId is always required) ----------

async function one<T>(rows: T[], what: string): Promise<T> {
  const r = rows[0];
  if (!r) throw new SafetyError(`${what} not found`);
  return r;
}

export async function lockObligation(tx: Tx, organizationId: string, obligationId: string): Promise<ObligationRow> {
  return one(
    await tx
      .select()
      .from(obligations)
      .where(and(eq(obligations.organizationId, organizationId), eq(obligations.id, obligationId)))
      .for("update"),
    "obligation",
  );
}

export async function lockIncident(tx: Tx, organizationId: string, incidentId: string): Promise<IncidentRow> {
  return one(
    await tx
      .select()
      .from(incidents)
      .where(and(eq(incidents.organizationId, organizationId), eq(incidents.id, incidentId)))
      .for("update"),
    "incident",
  );
}

export async function getIncident(db: Db | Tx, organizationId: string, incidentId: string): Promise<IncidentRow> {
  return one(
    await db.select().from(incidents).where(and(eq(incidents.organizationId, organizationId), eq(incidents.id, incidentId))),
    "incident",
  );
}

export async function getPayment(db: Db | Tx, organizationId: string, paymentId: string): Promise<PaymentRow> {
  return one(
    await db.select().from(payments).where(and(eq(payments.organizationId, organizationId), eq(payments.id, paymentId))),
    "payment",
  );
}

export async function paymentsForObligation(db: Db | Tx, organizationId: string, obligationId: string): Promise<PaymentRow[]> {
  return db
    .select()
    .from(payments)
    .where(and(eq(payments.organizationId, organizationId), eq(payments.obligationId, obligationId)))
    .orderBy(asc(payments.createdAt));
}

/**
 * Lock order everywhere: obligation, then incident. Callers that touch both
 * use `lockIncidentWithObligation` so two transactions can never deadlock.
 */
export async function lockIncidentWithObligation(tx: Tx, organizationId: string, incidentId: string) {
  const peek = await getIncident(tx, organizationId, incidentId);
  const obligation = await lockObligation(tx, organizationId, peek.obligationId);
  const incident = await lockIncident(tx, organizationId, incidentId);
  return { obligation, incident };
}

// ---------- setup ----------

export async function createObligation(
  db: Db,
  organizationId: string,
  input: { supplierRef: string; invoiceRef: string; amount: Money; beneficiaryId: string; beneficiaryHash: string; dueAt: Date },
  actor = "system",
): Promise<string> {
  if (input.amount.amountMinor <= 0n) throw new SafetyError("obligation amount must be positive");
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(obligations).values({
      id,
      organizationId,
      supplierRef: input.supplierRef,
      invoiceRef: input.invoiceRef,
      amountMinor: input.amount.amountMinor,
      currency: input.amount.currency,
      beneficiaryId: input.beneficiaryId,
      beneficiaryHash: input.beneficiaryHash,
      dueAt: input.dueAt,
    });
    await appendAudit(tx, organizationId, {
      actor,
      eventType: "obligation.created",
      payload: { obligationId: id, supplierRef: input.supplierRef, invoiceRef: input.invoiceRef, amountMinor: input.amount.amountMinor, currency: input.amount.currency },
    });
  });
  return id;
}

/** Record the transfer that was already sent for this obligation (the one that "did not arrive"). */
export async function registerOriginalPayment(
  db: Db,
  organizationId: string,
  input: { obligationId: string; requestId: string; providerTransferId: string },
  actor = "system",
): Promise<string> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    const ob = await lockObligation(tx, organizationId, input.obligationId);
    await tx.insert(payments).values({
      id,
      organizationId,
      obligationId: ob.id,
      role: "ORIGINAL",
      requestId: input.requestId,
      providerTransferId: input.providerTransferId,
      amountMinor: ob.amountMinor,
      currency: ob.currency,
      beneficiaryId: ob.beneficiaryId,
      state: "DISPATCHED",
    });
    await appendAudit(tx, organizationId, {
      actor,
      eventType: "payment.original_registered",
      payload: { paymentId: id, obligationId: ob.id, providerTransferId: input.providerTransferId, requestId: input.requestId },
    });
  });
  return id;
}

export async function openIncident(
  db: Db,
  organizationId: string,
  obligationId: string,
  actor = "system",
  opts: { origin?: IncidentOrigin; title?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    const ob = await lockObligation(tx, organizationId, obligationId);
    const [original] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.organizationId, organizationId), eq(payments.obligationId, ob.id), eq(payments.role, "ORIGINAL")));
    if (!original) throw new SafetyError("no original payment registered for this obligation");
    await tx.insert(incidents).values({
      id,
      organizationId,
      obligationId: ob.id,
      originalPaymentId: original.id,
      state: "OPEN",
      riskFlags: [],
      origin: opts.origin ?? "SANDBOX",
      title: opts.title ?? null,
    });
    await appendAudit(tx, organizationId, { actor, eventType: "incident.opened", payload: { incidentId: id, obligationId: ob.id, origin: opts.origin ?? "SANDBOX" } });
  });
  return id;
}

// ---------- evidence ----------

export interface EvidenceInput {
  kind: EvidenceKind;
  source: string;
  ref?: string;
  /** Supplier emails and other external text are untrusted. */
  trusted: boolean;
  content: Canonicalizable;
}

export async function addEvidence(db: Db, organizationId: string, incidentId: string, input: EvidenceInput, actor = "system"): Promise<string> {
  const id = randomUUID();
  const content = JSON.parse(canonicalJson(input.content)) as Canonicalizable;
  const contentHash = sha256Hex(canonicalJson(content));
  await db.transaction(async (tx) => {
    const inc = await lockIncident(tx, organizationId, incidentId);
    await tx.insert(evidence).values({
      id,
      organizationId,
      incidentId: inc.id,
      kind: input.kind,
      source: input.source,
      ref: input.ref ?? null,
      trusted: input.trusted,
      content,
      contentHash,
    });
    await appendAudit(tx, organizationId, {
      actor,
      eventType: "evidence.added",
      payload: { incidentId, evidenceId: id, kind: input.kind, source: input.source, trusted: input.trusted, contentHash },
    });
  });
  return id;
}

export async function evidenceSetHashFor(db: Db | Tx, organizationId: string, incidentId: string): Promise<string> {
  const rows = await db
    .select({ id: evidence.id, contentHash: evidence.contentHash })
    .from(evidence)
    .where(and(eq(evidence.organizationId, organizationId), eq(evidence.incidentId, incidentId)));
  return evidenceSetHash(rows);
}

/**
 * Record a deterministic risk flag (e.g. bank-detail change found in a supplier
 * email by the rule engine). Flags only ever accumulate; they block payment
 * through decide() and cannot be approved away.
 */
export async function flagRisk(
  db: Db,
  organizationId: string,
  incidentId: string,
  flag: RiskFlag,
  evidenceId: string,
  actor = "system",
): Promise<void> {
  await db.transaction(async (tx) => {
    const { incident } = await lockIncidentWithObligation(tx, organizationId, incidentId);
    if (incident.riskFlags.includes(flag)) return;
    await tx
      .update(incidents)
      .set({ riskFlags: [...incident.riskFlags, flag], updatedAt: new Date() })
      .where(and(eq(incidents.organizationId, organizationId), eq(incidents.id, incidentId)));
    await appendAudit(tx, organizationId, { actor, eventType: "risk.flagged", payload: { incidentId, flag, evidenceId } });
    // A live incident goes back to investigation so any pending approval dies with the version bump.
    const refreshed = await lockIncident(tx, organizationId, incidentId);
    const r = transitionIncident(refreshed, { type: "NEW_EVIDENCE" });
    if (r.ok) await applyTransition(tx, organizationId, refreshed, { type: "NEW_EVIDENCE" }, actor);
  });
}

/**
 * A message from the supplier (email, chat). Stored as UNTRUSTED evidence and
 * screened by deterministic code, which raises risk flags before any model
 * reads the text. The model can never clear a flag.
 */
export async function ingestSupplierMessage(
  db: Db,
  organizationId: string,
  incidentId: string,
  msg: { from: string; subject: string; body: string; receivedAt: string; synthetic: boolean },
  actor = "intake",
): Promise<{ evidenceId: string; flags: RiskFlag[] }> {
  const evidenceId = await addEvidence(
    db,
    organizationId,
    incidentId,
    {
      kind: msg.synthetic ? "synthetic_fixture" : "unknown",
      source: "supplier-message",
      ref: msg.from,
      trusted: false,
      content: { from: msg.from, subject: msg.subject, body: msg.body, receivedAt: msg.receivedAt },
    },
    actor,
  );
  const signals = detectSupplierTextSignals(`${msg.subject}
${msg.body}`);
  for (const flag of signals.flags) await flagRisk(db, organizationId, incidentId, flag, evidenceId, "text-screen");
  if (signals.flags.length) {
    await db.transaction((tx) =>
      appendAudit(tx, organizationId, {
        actor: "text-screen",
        eventType: "supplier_message.screened",
        payload: { incidentId, evidenceId, flags: signals.flags, excerpts: signals.matches.map((m) => m.excerpt) },
      }),
    );
  }
  return { evidenceId, flags: signals.flags };
}

// ---------- transitions ----------

/** Apply one lifecycle event to a row the caller has locked. Throws if the machine refuses it. */
export async function applyTransition(tx: Tx, organizationId: string, incident: IncidentRow, event: IncidentEvent, actor: string): Promise<IncidentRow> {
  const r = transitionIncident(incident, event);
  if (!r.ok) throw new SafetyError(r.reason, [r.reason]);
  const extra: Partial<IncidentRow> = {};
  if (event.type === "ESCALATE") extra.escalationReason = event.reason;
  if (event.type === "RECOMMEND" && event.recommendation === "ESCALATE") extra.escalationReason = "policy recommended escalation";
  if (event.type === "RESOLVE") {
    extra.originalFate = event.originalFate;
    extra.settledBy = event.settledBy;
  }
  const [updated] = await tx
    .update(incidents)
    .set({ state: r.next.state, recommendation: r.next.recommendation, version: r.next.version, updatedAt: new Date(), ...extra })
    .where(and(eq(incidents.organizationId, organizationId), eq(incidents.id, incident.id), eq(incidents.version, incident.version)))
    .returning();
  if (!updated) throw new SafetyError("incident changed concurrently");
  await appendAudit(tx, organizationId, {
    actor,
    eventType: "incident.transition",
    payload: { incidentId: incident.id, from: incident.state, to: r.next.state, version: r.next.version, event: event as unknown as Canonicalizable },
  });
  return updated;
}

// ---------- original payment finality ----------

export async function providerStateVersion(db: Db | Tx, organizationId: string, providerTransferId: string | null): Promise<number> {
  if (!providerTransferId) return 0;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transferObservations)
    .where(and(eq(transferObservations.organizationId, organizationId), eq(transferObservations.providerTransferId, providerTransferId)));
  return r?.n ?? 0;
}

/**
 * Move a payment to FAILED_CONFIRMED (releasing the fence) only when its history
 * shows a confirmed failure WITH a known cause (documented code or type). Anything weaker keeps it blocking.
 */
export async function syncPaymentFinality(tx: Tx, organizationId: string, payment: PaymentRow) {
  const history = await loadTransferHistory(tx, organizationId, payment.providerTransferId ?? "");
  const finality = classifyFinality(history);
  const cause = finality.kind === "CONFIRMED_FAILED" ? failureCause(finality.failure) : null;
  if (finality.kind === "CONFIRMED_FAILED" && cause && (payment.state === "DISPATCHED" || payment.state === "UNCERTAIN")) {
    await tx
      .update(payments)
      .set({ state: "FAILED_CONFIRMED", failureType: cause })
      .where(and(eq(payments.organizationId, organizationId), eq(payments.id, payment.id)));
    await appendAudit(tx, organizationId, {
      actor: "system",
      eventType: "payment.failure_confirmed",
      payload: { paymentId: payment.id, providerTransferId: payment.providerTransferId, failureType: cause, failureCode: finality.failure.code },
    });
  }
  return { history, finality };
}

// ---------- evaluation (code decides) ----------

export interface BalanceSource {
  getCurrentBalances(): Promise<CurrentBalance[]>;
}

export interface Evaluation {
  decision: Decision;
  incident: IncidentRow;
  changed: boolean;
  inputs: DecisionInput;
}

async function readAvailable(provider: BalanceSource, currency: string): Promise<bigint | null> {
  try {
    const rows = await provider.getCurrentBalances();
    return rows.find((b) => b.currency === currency)?.availableMinor ?? 0n;
  } catch {
    return null; // fail closed: decide() escalates on an unknown balance
  }
}

async function gatherInputs(tx: Tx, organizationId: string, incident: IncidentRow, obligation: ObligationRow, available: bigint | null, now: Date) {
  const original = await getPayment(tx, organizationId, incident.originalPaymentId);
  const { finality } = await syncPaymentFinality(tx, organizationId, original);
  const blockingOthers = (await paymentsForObligation(tx, organizationId, obligation.id)).filter((p) => p.blocking && p.id !== original.id).length;
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId));
  const inputs: DecisionInput = {
    original: finality,
    obligation: { amountMinor: obligation.amountMinor, currency: obligation.currency, dueAt: obligation.dueAt.toISOString() },
    otherBlockingPayments: blockingOthers,
    availableMinor: available,
    replacementFeeMinor: org?.replacementFeeMinor ?? 0n,
    reserveFloorMinor: org?.reserveFloorMinor ?? 0n,
    riskFlags: incident.riskFlags,
    now: now.toISOString(),
  };
  return { inputs, original };
}

/**
 * Run the deterministic policy for an incident and record the decision. The
 * recommendation only changes (and the incident only transitions) when the
 * material inputs change, so periodic re-evaluation never churns approvals.
 */
export async function evaluateIncident(
  db: Db,
  provider: BalanceSource,
  organizationId: string,
  incidentId: string,
  opts: { now?: Date; actor?: string } = {},
): Promise<Evaluation> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "policy-engine";
  const peek = await getIncident(db, organizationId, incidentId);
  const peekObligation = await one(
    await db.select().from(obligations).where(and(eq(obligations.organizationId, organizationId), eq(obligations.id, peek.obligationId))),
    "obligation",
  );
  const available = await readAvailable(provider, peekObligation.currency); // HTTP outside the transaction

  return db.transaction(async (tx) => {
    const { obligation, incident: locked } = await lockIncidentWithObligation(tx, organizationId, incidentId);
    let incident = locked;
    const { inputs, original } = await gatherInputs(tx, organizationId, incident, obligation, available, now);
    const decision = decide(inputs);
    const evHash = await evidenceSetHashFor(tx, organizationId, incidentId);
    const stateVersion = await providerStateVersion(tx, organizationId, original.providerTransferId);
    const material = {
      recommendation: decision.recommendation,
      reasons: decision.reasons,
      evidenceSetHash: evHash,
      providerStateVersion: stateVersion,
      riskFlags: [...inputs.riskFlags],
    };

    const [last] = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), eq(decisions.incidentId, incidentId)))
      .orderBy(desc(decisions.decidedAt), desc(decisions.incidentVersion))
      .limit(1);
    const lastMaterial = last ? (last.inputs as { material?: unknown }).material : undefined;
    const unchanged = last && canonicalJson(lastMaterial as Canonicalizable) === canonicalJson(material as unknown as Canonicalizable);

    // Past the decision phase (approved / executing / monitoring a replacement) we only report.
    const replacementExists = (await paymentsForObligation(tx, organizationId, obligation.id)).some((p) => p.role === "REPLACEMENT");
    if (unchanged || replacementExists || incident.state === "EXECUTING" || incident.state === "RESOLVED" || incident.state === "ESCALATED") {
      return { decision, incident, changed: false, inputs };
    }

    if (incident.state === "OPEN") incident = await applyTransition(tx, organizationId, incident, { type: "START_INVESTIGATION" }, actor);
    else if (incident.state !== "INVESTIGATING") incident = await applyTransition(tx, organizationId, incident, { type: "NEW_EVIDENCE" }, actor);
    incident = await applyTransition(tx, organizationId, incident, { type: "RECOMMEND", recommendation: decision.recommendation }, actor);

    const serializableInputs = {
      material,
      original: inputs.original as unknown as Canonicalizable,
      obligation: inputs.obligation,
      otherBlockingPayments: inputs.otherBlockingPayments,
      availableMinor: inputs.availableMinor,
      replacementFeeMinor: inputs.replacementFeeMinor,
      reserveFloorMinor: inputs.reserveFloorMinor,
      now: inputs.now,
    };
    await tx.insert(decisions).values({
      id: randomUUID(),
      organizationId,
      incidentId,
      incidentVersion: incident.version,
      policyVersion: POLICY_VERSION,
      recommendation: decision.recommendation,
      reasons: decision.reasons,
      inputs: JSON.parse(canonicalJson(serializableInputs as Canonicalizable)),
      evidenceSetHash: evHash,
    });
    await appendAudit(tx, organizationId, {
      actor,
      eventType: "decision.recorded",
      payload: { incidentId, version: incident.version, recommendation: decision.recommendation, reasons: decision.reasons, policyVersion: POLICY_VERSION },
    });
    return { decision, incident, changed: true, inputs };
  });
}

/**
 * Operator clicks "Resend anyway". This never creates a payment: if policy
 * forbids replacement it is blocked and audited; if allowed, the caller must go
 * through propose -> bound approval -> executor.
 */
export async function attemptManualResend(
  db: Db,
  provider: BalanceSource,
  organizationId: string,
  incidentId: string,
  actor: string,
  now = new Date(),
): Promise<{ blocked: true; reasons: string[] } | { blocked: false; next: "REQUEST_APPROVAL" }> {
  const peek = await getIncident(db, organizationId, incidentId);
  const ob = await one(
    await db.select().from(obligations).where(and(eq(obligations.organizationId, organizationId), eq(obligations.id, peek.obligationId))),
    "obligation",
  );
  const available = await readAvailable(provider, ob.currency);
  return db.transaction(async (tx) => {
    const { obligation, incident } = await lockIncidentWithObligation(tx, organizationId, incidentId);
    const { inputs } = await gatherInputs(tx, organizationId, incident, obligation, available, now);
    const d = decide(inputs);
    if (!d.replacementAllowed) {
      await appendAudit(tx, organizationId, { actor, eventType: "resend.blocked", payload: { incidentId, reasons: d.reasons } });
      return { blocked: true as const, reasons: d.reasons };
    }
    await appendAudit(tx, organizationId, { actor, eventType: "resend.routed_to_approval", payload: { incidentId } });
    return { blocked: false as const, next: "REQUEST_APPROVAL" as const };
  });
}

// ---------- proposal ----------

export async function currentApprovalFacts(tx: Tx, organizationId: string, incident: IncidentRow, obligation: ObligationRow, beneficiaryHash: string): Promise<CurrentFacts> {
  const original = await getPayment(tx, organizationId, incident.originalPaymentId);
  return {
    organizationId,
    incidentId: incident.id,
    incidentVersion: incident.version,
    actionType: "REPLACE",
    amountMinor: obligation.amountMinor,
    currency: obligation.currency,
    beneficiaryId: obligation.beneficiaryId,
    beneficiaryHash,
    originalPaymentId: original.id,
    providerStateVersion: await providerStateVersion(tx, organizationId, original.providerTransferId),
    evidenceSetHash: await evidenceSetHashFor(tx, organizationId, incident.id),
    policyVersion: POLICY_VERSION,
  };
}

export function factsToJson(f: CurrentFacts) {
  return { ...f, amountMinor: f.amountMinor.toString() };
}

export function factsFromJson(j: unknown): CurrentFacts {
  const o = j as Record<string, unknown>;
  return { ...(o as unknown as CurrentFacts), amountMinor: BigInt(o.amountMinor as string) };
}

/** Freeze the exact REPLACE action for the approver. Only allowed right after a REPLACE decision. */
export async function proposeReplacement(db: Db, organizationId: string, incidentId: string, actor: string): Promise<string> {
  return db.transaction(async (tx) => {
    const { obligation, incident: locked } = await lockIncidentWithObligation(tx, organizationId, incidentId);
    if (locked.state !== "RECOMMENDED" || locked.recommendation !== "REPLACE") {
      throw new SafetyError(`cannot propose a replacement in state ${locked.state} (${locked.recommendation ?? "no recommendation"})`);
    }
    const incident = await applyTransition(tx, organizationId, locked, { type: "REQUEST_APPROVAL" }, actor);
    const facts = await currentApprovalFacts(tx, organizationId, incident, obligation, obligation.beneficiaryHash);
    const id = randomUUID();
    await tx.insert(proposedActions).values({ id, organizationId, incidentId, incidentVersion: incident.version, actionType: "REPLACE", facts: factsToJson(facts), proposedBy: actor });
    await appendAudit(tx, organizationId, { actor, eventType: "action.proposed", payload: { incidentId, proposedActionId: id, facts: factsToJson(facts) } });
    return id;
  });
}

export async function latestDecision(db: Db, organizationId: string, incidentId: string) {
  const [d] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.organizationId, organizationId), eq(decisions.incidentId, incidentId)))
    .orderBy(desc(decisions.incidentVersion))
    .limit(1);
  return d ?? null;
}

export async function otherPayments(db: Db | Tx, organizationId: string, obligationId: string, excludeId: string) {
  return db
    .select()
    .from(payments)
    .where(and(eq(payments.organizationId, organizationId), eq(payments.obligationId, obligationId), ne(payments.id, excludeId)));
}
