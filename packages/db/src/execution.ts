import { randomBytes, randomUUID } from "node:crypto";
import {
  AirwallexApiError,
  AirwallexUncertainOutcomeError,
  type CreateTransferInput,
  type CreateTransferResult,
  type CurrentBalance,
  type TransferSnapshot,
  newRequestId,
} from "@sentinel/airwallex";
import { CurrencySchema, money } from "@sentinel/contracts";
import {
  APPROVAL_TTL_MS,
  type ApprovalBinding,
  type Canonicalizable,
  type SignedApproval,
  classifyFinality,
  decide,
  signApproval,
  verifyApproval,
} from "@sentinel/policy";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { appendAudit, type Tx } from "./audit.js";
import type { Db } from "./client.js";
import { loadTransferHistory, recordTransferSnapshot } from "./event-store.js";
import {
  SafetyError,
  applyTransition,
  currentApprovalFacts,
  factsFromJson,
  getIncident,
  getPayment,
  lockIncidentWithObligation,
  otherPayments,
  paymentsForObligation,
} from "./incidents.js";
import { approvals, executions, organizations, payments, proposedActions } from "./schema.js";

/** Everything the executor needs from the provider. AirwallexClient satisfies it. */
export interface ExecutionProvider {
  getTransfer(id: string): Promise<TransferSnapshot>;
  findTransferByRequestId(requestId: string): Promise<TransferSnapshot | null>;
  createTransfer(input: CreateTransferInput): Promise<CreateTransferResult>;
  getCurrentBalances(): Promise<CurrentBalance[]>;
  /** Hash of the beneficiary's bank details as the provider holds them right now. */
  getBeneficiaryHash(beneficiaryId: string): Promise<string>;
}

export interface ApprovalKeys {
  current: { version: string; secret: string };
  /** All versions still accepted when verifying. */
  all: Readonly<Record<string, string>>;
}

function bindingToJson(b: ApprovalBinding) {
  return { ...b, amountMinor: b.amountMinor.toString() };
}
function bindingFromJson(j: unknown): ApprovalBinding {
  const o = j as Record<string, unknown>;
  return { ...(o as unknown as ApprovalBinding), amountMinor: BigInt(o.amountMinor as string) };
}

export type ApproveResult =
  | { ok: true; approvalId: string; executionId: string; replacementPaymentId: string }
  | { ok: false; reasons: string[] };

/**
 * A human approves a frozen proposal. In ONE transaction (obligation + incident
 * locked): re-derive the current facts, sign the binding, verify it against
 * those facts, consume the proposal (unique), create the replacement payment
 * (the partial unique index refuses it unless the original released the
 * fence), and queue an execution. Nothing is sent to the provider here.
 */
export async function approveProposal(
  db: Db,
  organizationId: string,
  input: { proposedActionId: string; approverId: string; keys: ApprovalKeys; now?: number },
): Promise<ApproveResult> {
  const now = input.now ?? Date.now();
  const [proposal] = await db
    .select()
    .from(proposedActions)
    .where(and(eq(proposedActions.organizationId, organizationId), eq(proposedActions.id, input.proposedActionId)));
  if (!proposal) return { ok: false, reasons: ["proposal_not_found"] };

  return db.transaction(async (tx) => {
    const { obligation, incident } = await lockIncidentWithObligation(tx, organizationId, proposal.incidentId);
    if (incident.state !== "AWAITING_APPROVAL") return { ok: false, reasons: [`incident_not_awaiting_approval:${incident.state}`] };
    // Four-eyes: whoever proposed the payment cannot also approve it.
    if (proposal.proposedBy === input.approverId) return { ok: false, reasons: ["four_eyes:approver_is_proposer"] };

    const proposed = factsFromJson(proposal.facts);
    const binding: ApprovalBinding = {
      ...proposed,
      approverId: input.approverId,
      nonce: randomBytes(16).toString("hex"),
      issuedAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
    };
    const signed = signApproval(input.keys.current.secret, input.keys.current.version, binding);
    const current = await currentApprovalFacts(tx, organizationId, incident, obligation, obligation.beneficiaryHash);
    const check = verifyApproval(input.keys.all, signed, current, now);
    if (!check.ok) {
      await applyTransition(tx, organizationId, incident, { type: "APPROVAL_INVALIDATED", reason: check.reasons.join(",") }, input.approverId);
      await appendAudit(tx, organizationId, {
        actor: input.approverId,
        eventType: "approval.rejected_stale",
        payload: { incidentId: incident.id, proposedActionId: proposal.id, reasons: check.reasons },
      });
      return { ok: false, reasons: check.reasons };
    }

    const approvalId = randomUUID();
    await tx.insert(approvals).values({
      id: approvalId,
      organizationId,
      incidentId: incident.id,
      proposedActionId: proposal.id,
      binding: bindingToJson(binding),
      keyVersion: signed.keyVersion,
      signature: signed.signature,
      approverId: input.approverId,
      expiresAt: new Date(binding.expiresAt),
    });

    const replacementPaymentId = randomUUID();
    const requestId = newRequestId(); // different from the original's, as the guide requires
    try {
      await tx.insert(payments).values({
        id: replacementPaymentId,
        organizationId,
        obligationId: obligation.id,
        role: "REPLACEMENT",
        predecessorPaymentId: binding.originalPaymentId,
        requestId,
        amountMinor: binding.amountMinor,
        currency: binding.currency,
        beneficiaryId: binding.beneficiaryId,
        state: "INTENDED",
      });
    } catch (err) {
      // payments_one_blocking_per_obligation: the original still blocks. Fail closed.
      throw new SafetyError("duplicate fence: another payment still blocks this obligation", ["duplicate_fence"], { cause: err });
    }
    const executionId = randomUUID();
    await tx.insert(executions).values({ id: executionId, organizationId, approvalId, paymentId: replacementPaymentId, status: "PENDING" });
    await applyTransition(tx, organizationId, incident, { type: "APPROVE" }, input.approverId);
    await appendAudit(tx, organizationId, {
      actor: input.approverId,
      eventType: "approval.granted",
      payload: { incidentId: incident.id, approvalId, executionId, replacementPaymentId, requestId, binding: bindingToJson(binding) as unknown as Canonicalizable },
    });
    return { ok: true, approvalId, executionId, replacementPaymentId };
  });
}

export type ExecuteResult =
  | { status: "NOT_CLAIMED" }
  | { status: "SUCCEEDED"; providerTransferId: string; reconciled: boolean }
  | { status: "UNCERTAIN" }
  | { status: "REJECTED"; error: string }
  | { status: "BLOCKED"; reasons: string[] };

/**
 * Outbox executor. Claims the execution with a lease, re-validates EVERYTHING
 * against fresh provider data, then calls createTransfer with the payment's
 * stable request_id. No database transaction is held across the HTTP call.
 */
export async function executeReplacement(
  db: Db,
  provider: ExecutionProvider,
  organizationId: string,
  executionId: string,
  opts: { keys: ApprovalKeys; now?: () => number; leaseMs?: number },
): Promise<ExecuteResult> {
  const now = opts.now ?? Date.now;
  const leaseMs = opts.leaseMs ?? 120_000;

  // 1. Claim. Exactly one worker wins; an expired lease or an UNCERTAIN outcome can be re-claimed.
  const [claimed] = await db
    .update(executions)
    .set({ status: "CLAIMED", leaseUntil: new Date(now() + leaseMs), attempts: sql`${executions.attempts} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(executions.organizationId, organizationId),
        eq(executions.id, executionId),
        or(
          eq(executions.status, "PENDING"),
          and(inArray(executions.status, ["CLAIMED", "UNCERTAIN"]), lt(executions.leaseUntil, new Date(now()))),
        ),
      ),
    )
    .returning();
  if (!claimed) return { status: "NOT_CLAIMED" };

  const payment = await getPayment(db, organizationId, claimed.paymentId);
  const [approval] = await db.select().from(approvals).where(and(eq(approvals.organizationId, organizationId), eq(approvals.id, claimed.approvalId)));
  if (!approval) throw new SafetyError("approval row missing for execution");
  const transferInput: CreateTransferInput = {
    requestId: payment.requestId,
    beneficiaryId: payment.beneficiaryId,
    amount: money(payment.amountMinor, CurrencySchema.parse(payment.currency)),
    sourceCurrency: CurrencySchema.parse(payment.currency),
    transferMethod: "LOCAL",
    reason: "goods_purchased",
    reference: `REPLACEMENT ${payment.id.slice(0, 8)}`,
  };

  // 2. A previous attempt may have reached the provider. Look before doing anything else.
  if (payment.state === "UNCERTAIN" || claimed.attempts > 1) {
    try {
      const existing = await provider.findTransferByRequestId(payment.requestId);
      if (existing) return finishSuccess(db, organizationId, claimed.id, payment.id, existing, true);
    } catch (err) {
      return finishUncertain(db, organizationId, claimed.id, payment.id, err, now, leaseMs);
    }
  }

  // 3. Re-validate against fresh provider data (invariant 5) before any money moves.
  const reasons: string[] = [];
  let beneficiaryHash = "";
  let available: bigint | null = null;
  try {
    const incident0 = await getIncident(db, organizationId, approval.incidentId);
    const original = await getPayment(db, organizationId, incident0.originalPaymentId);
    if (original.providerTransferId) {
      await recordTransferSnapshot(db, organizationId, await provider.getTransfer(original.providerTransferId), "poll");
    }
    beneficiaryHash = await provider.getBeneficiaryHash(payment.beneficiaryId);
    available = (await provider.getCurrentBalances()).find((b) => b.currency === payment.currency)?.availableMinor ?? 0n;
  } catch (err) {
    reasons.push(`revalidation_read_failed:${err instanceof Error ? err.message : String(err)}`);
  }

  const verdict = await db.transaction(async (tx) => {
    const { obligation, incident } = await lockIncidentWithObligation(tx, organizationId, approval.incidentId);
    if (incident.state !== "EXECUTING") reasons.push(`incident_not_executing:${incident.state}`);
    const original = await getPayment(tx, organizationId, incident.originalPaymentId);
    const finality = classifyFinality(await loadTransferHistory(tx, organizationId, original.providerTransferId ?? ""));
    if (finality.kind !== "CONFIRMED_FAILED") reasons.push(`original_no_longer_confirmed_failed:${finality.kind}`);
    if (original.state !== "FAILED_CONFIRMED") reasons.push(`original_state:${original.state}`);

    // The incident moved one version (APPROVE) since the approver saw it.
    const facts = await currentApprovalFacts(tx, organizationId, { ...incident, version: incident.version - 1 }, obligation, beneficiaryHash);
    const signed: SignedApproval = { binding: bindingFromJson(approval.binding), keyVersion: approval.keyVersion, signature: approval.signature };
    const check = verifyApproval(opts.keys.all, signed, facts, now());
    if (!check.ok) reasons.push(...check.reasons.map((r) => `approval:${r}`));

    const others = (await otherPayments(tx, organizationId, obligation.id, payment.id)).filter((p) => p.blocking && p.id !== original.id);
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId));
    const d = decide({
      original: finality,
      obligation: { amountMinor: obligation.amountMinor, currency: obligation.currency, dueAt: obligation.dueAt.toISOString() },
      otherBlockingPayments: others.length,
      availableMinor: available,
      replacementFeeMinor: org?.replacementFeeMinor ?? 0n,
      reserveFloorMinor: org?.reserveFloorMinor ?? 0n,
      riskFlags: incident.riskFlags,
      now: new Date(now()).toISOString(),
    });
    if (!d.replacementAllowed) reasons.push(...d.reasons.map((r) => `policy:${r}`));

    if (reasons.length) {
      const fence = await releaseOrHold(tx, organizationId, claimed.id, payment.id);
      if (fence === "held") reasons.push("fence_held:another_attempt_may_still_send");
      await tx
        .update(executions)
        .set({ status: "BLOCKED", lastError: reasons.join("; "), updatedAt: new Date() })
        .where(and(eq(executions.id, claimed.id), sql`${executions.status} <> 'SUCCEEDED'`));
      if (incident.state === "EXECUTING") {
        await applyTransition(tx, organizationId, incident, { type: "ESCALATE", reason: `execution blocked: ${reasons.join("; ")}` }, "executor");
      }
      await appendAudit(tx, organizationId, { actor: "executor", eventType: "execution.blocked", payload: { executionId: claimed.id, paymentId: payment.id, reasons, fence } });
      return "blocked" as const;
    }
    await appendAudit(tx, organizationId, { actor: "executor", eventType: "execution.revalidated", payload: { executionId: claimed.id, paymentId: payment.id } });
    return "go" as const;
  });
  if (verdict === "blocked") return { status: "BLOCKED", reasons };

  // 4. Send. Same request_id on every attempt; the adapter reconciles duplicates.
  try {
    const { transfer, reconciled } = await provider.createTransfer(transferInput);
    return finishSuccess(db, organizationId, claimed.id, payment.id, transfer, reconciled);
  } catch (err) {
    if (err instanceof AirwallexUncertainOutcomeError) return finishUncertain(db, organizationId, claimed.id, payment.id, err, now, leaseMs);
    if (err instanceof AirwallexApiError) return finishRejected(db, organizationId, claimed.id, payment.id, err);
    // Anything unexpected after we may have sent: treat as uncertain, keep the fence.
    return finishUncertain(db, organizationId, claimed.id, payment.id, err, now, leaseMs);
  }
}

async function finishSuccess(db: Db, org: string, executionId: string, paymentId: string, transfer: TransferSnapshot, reconciled: boolean): Promise<ExecuteResult> {
  await db.transaction(async (tx) => {
    const payment = await getPayment(tx, org, paymentId);
    if (transfer.requestId !== payment.requestId || transfer.amount.amountMinor !== payment.amountMinor) {
      throw new SafetyError("provider transfer does not match the approved payment");
    }
    await tx.update(payments).set({ state: "DISPATCHED", providerTransferId: transfer.providerTransferId }).where(and(eq(payments.organizationId, org), eq(payments.id, paymentId)));
    await tx.update(executions).set({ status: "SUCCEEDED", providerResponse: transfer.raw, lastError: null, updatedAt: new Date() }).where(eq(executions.id, executionId));
    await recordTransferSnapshot(tx, org, transfer, reconciled ? "reconcile" : "create");
    await transitionIncidentForPayment(tx, org, payment, { type: "DISPATCHED" });
    await appendAudit(tx, org, {
      actor: "executor",
      eventType: "execution.succeeded",
      payload: { executionId, paymentId, providerTransferId: transfer.providerTransferId, requestId: transfer.requestId, reconciled },
    });
  });
  return { status: "SUCCEEDED", providerTransferId: transfer.providerTransferId, reconciled };
}

async function finishUncertain(db: Db, org: string, executionId: string, paymentId: string, err: unknown, now: () => number, leaseMs: number): Promise<ExecuteResult> {
  await db.transaction(async (tx) => {
    // The payment keeps blocking: we might have paid.
    await tx.update(payments).set({ state: "UNCERTAIN" }).where(and(eq(payments.organizationId, org), eq(payments.id, paymentId), inArray(payments.state, ["INTENDED", "UNCERTAIN"])));
    await tx
      .update(executions)
      .set({ status: "UNCERTAIN", lastError: err instanceof Error ? err.message : String(err), leaseUntil: new Date(now() + Math.min(leaseMs, 60_000)), updatedAt: new Date() })
      .where(eq(executions.id, executionId));
    const payment = await getPayment(tx, org, paymentId);
    await transitionIncidentForPayment(tx, org, payment, { type: "DISPATCH_UNCERTAIN" });
    await appendAudit(tx, org, { actor: "executor", eventType: "execution.uncertain", payload: { executionId, paymentId, error: err instanceof Error ? err.message : String(err) } });
  });
  return { status: "UNCERTAIN" };
}

async function finishRejected(db: Db, org: string, executionId: string, paymentId: string, err: AirwallexApiError): Promise<ExecuteResult> {
  await db.transaction(async (tx) => {
    // A definite provider rejection means no transfer exists under this request_id right now:
    // release this payment (if no other attempt can still send it) and escalate the incident.
    const fence = await releaseOrHold(tx, org, executionId, paymentId);
    await tx
      .update(executions)
      .set({ status: "REJECTED", lastError: err.message, updatedAt: new Date() })
      .where(and(eq(executions.id, executionId), sql`${executions.status} <> 'SUCCEEDED'`));
    const payment = await getPayment(tx, org, paymentId);
    await transitionIncidentForPayment(tx, org, payment, { type: "ESCALATE", reason: `provider rejected replacement: ${err.code ?? err.status}` });
    await appendAudit(tx, org, { actor: "executor", eventType: "execution.rejected", payload: { executionId, paymentId, code: err.code ?? null, status: err.status, fence } });
  });
  return { status: "REJECTED", error: err.message };
}

/**
 * Release the replacement's duplicate fence (NOT_SENT, which is terminal) only when no
 * other attempt can still reach the provider, i.e. this execution has been claimed once.
 * After a re-claim, the earlier worker may not be dead: its lease expired, but it can
 * still be about to send, or have sent. Then the payment keeps blocking as UNCERTAIN and
 * a person decides; a later success or lookup by request_id settles it.
 * Found by model checking: spec/RESULTS.md, row "pre-fix".
 */
async function releaseOrHold(tx: Tx, org: string, executionId: string, paymentId: string): Promise<"released" | "held"> {
  // Row lock: a concurrent claim (which increments attempts) waits for this transaction.
  const [row] = await tx
    .select({ attempts: executions.attempts })
    .from(executions)
    .where(and(eq(executions.organizationId, org), eq(executions.id, executionId)))
    .for("update");
  const open = and(eq(payments.organizationId, org), eq(payments.id, paymentId), inArray(payments.state, ["INTENDED", "UNCERTAIN"]));
  if (row?.attempts === 1) {
    await tx.update(payments).set({ state: "NOT_SENT" }).where(open);
    return "released";
  }
  await tx.update(payments).set({ state: "UNCERTAIN" }).where(open);
  return "held";
}

async function transitionIncidentForPayment(
  tx: Tx,
  org: string,
  payment: { obligationId: string },
  event: { type: "DISPATCHED" } | { type: "DISPATCH_UNCERTAIN" } | { type: "ESCALATE"; reason: string },
) {
  const [row] = await tx.execute<{ id: string }>(
    sql`SELECT id FROM incidents WHERE organization_id = ${org} AND obligation_id = ${payment.obligationId} AND state = 'EXECUTING' LIMIT 1`,
  ).then((r) => r.rows);
  if (!row) return; // already moved on (e.g. reclaimed UNCERTAIN execution)
  const { incident } = await lockIncidentWithObligation(tx, org, row.id);
  if (incident.state === "EXECUTING") await applyTransition(tx, org, incident, event, "executor");
}

/** Close the incident when the obligation is settled AND the original's fate is recorded. */
export async function tryResolveIncident(db: Db, organizationId: string, incidentId: string, actor = "reconciler"): Promise<{ resolved: boolean; reason?: string }> {
  return db.transaction(async (tx) => {
    const { obligation, incident } = await lockIncidentWithObligation(tx, organizationId, incidentId);
    if (incident.state !== "MONITORING") return { resolved: false, reason: `state ${incident.state}` };
    const all = await paymentsForObligation(tx, organizationId, obligation.id);
    const original = all.find((p) => p.id === incident.originalPaymentId)!;
    const replacement = all.find((p) => p.role === "REPLACEMENT" && p.state === "DISPATCHED");
    const status = async (p: typeof original | undefined) =>
      p?.providerTransferId ? (await loadTransferHistory(tx, organizationId, p.providerTransferId)).status : null;

    let settledBy: "ORIGINAL" | "REPLACEMENT" | null = null;
    let originalFate: string | null = null;
    if (replacement && (await status(replacement)) === "PAID") {
      settledBy = "REPLACEMENT";
      originalFate = original.state === "FAILED_CONFIRMED" ? `RETURNED: ${original.failureType}` : null;
    } else if (!replacement && (await status(original)) === "PAID") {
      settledBy = "ORIGINAL";
      originalFate = "PAID";
    }
    const openPaymentUncertainty = all.some((p) => p.state === "UNCERTAIN" || p.state === "INTENDED");
    const r = await applyTransition(tx, organizationId, incident, { type: "RESOLVE", originalFate, settledBy, openPaymentUncertainty }, actor).then(
      () => ({ resolved: true }),
      (err: unknown) => ({ resolved: false, reason: err instanceof Error ? err.message : String(err) }),
    );
    return r;
  });
}
