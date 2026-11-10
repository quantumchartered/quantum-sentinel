/**
 * Scenario A on the REAL Airwallex sandbox, driven through the product's own
 * functions (the same ones the console calls). Simulated funds and a synthetic
 * supplier; every provider status is read back from Airwallex, never assumed.
 *
 *   original transfer -> SENT -> WAIT, "resend anyway" blocked
 *   -> simulated bank return (FAILED, auto-cancelled) -> REPLACE
 *   -> proposal -> bound approval by a second person -> executor sends the
 *      replacement with a new request_id -> SENT -> PAID -> resolved, books, audit.
 */
import type { AirwallexClient } from "@sentinel/airwallex";
import { AirwallexSimulation } from "@sentinel/airwallex/simulation";
import type { Money } from "@sentinel/contracts";
import {
  type ApprovalKeys,
  type Db,
  airwallexExecutionProvider,
  approveProposal,
  attemptManualResend,
  createObligation,
  evaluateIncident,
  executeReplacement,
  getIncident,
  ingestSupplierMessage,
  openIncident,
  paymentsForObligation,
  proposeReplacement,
  recordTransferSnapshot,
  registerOriginalPayment,
  runReconciliation,
  schema,
  syncLedgerForObligation,
  tryResolveIncident,
  verifyStoredAuditChain,
} from "@sentinel/db";
import { newRequestId } from "@sentinel/airwallex";
import { and, eq } from "drizzle-orm";
import { runInvestigation } from "../agent/loop.js";
import type { ModelClient } from "../agent/model.js";

export interface SandboxScenarioDeps {
  db: Db;
  client: AirwallexClient;
  organizationId: string;
  beneficiaryId: string;
  amount: Money;
  keys: ApprovalKeys;
  investigator: { model: ModelClient; modelId: string };
  log: (line: string) => void;
}

const CHASER = {
  from: "accounts@northwind.example",
  subject: "Payment not received",
  body: "Hello, the due date for this invoice was two days ago and we have not received the funds. Could you check? Regards, Accounts, Northwind (SYNTHETIC)",
};

/** Read the transfer back until `until` matches or time runs out, recording every new state. */
async function follow(d: SandboxScenarioDeps, transferId: string, until: (status: string) => boolean, seconds = 30): Promise<string> {
  const started = Date.now();
  let last = "";
  for (;;) {
    const snap = await d.client.getTransfer(transferId);
    const sig = `${snap.rawStatus}|${JSON.stringify(snap.failure)}`;
    if (sig !== last) {
      last = sig;
      await recordTransferSnapshot(d.db, d.organizationId, snap, "poll");
      d.log(`    provider: ${snap.rawStatus}${snap.failure ? ` failure ${snap.failure.code ?? ""} ${snap.failure.message ?? ""} (type ${snap.failure.type ?? "-"})` : ""}`);
    }
    if (until(snap.rawStatus)) return snap.rawStatus;
    if (Date.now() - started > seconds * 1000) return snap.rawStatus;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function userActor(d: SandboxScenarioDeps, role: "OPERATOR" | "APPROVER", fallback: string): Promise<string> {
  const [u] = await d.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.organizationId, d.organizationId), eq(schema.users.role, role)))
    .limit(1);
  return u ? `user:${u.id}` : fallback;
}

export async function runSandboxScenarioA(d: SandboxScenarioDeps): Promise<{ incidentId: string; ok: boolean }> {
  const sim = new AirwallexSimulation(d.client);
  const provider = airwallexExecutionProvider(d.client);
  const operator = await userActor(d, "OPERATOR", "cli:operator");
  const approver = await userActor(d, "APPROVER", "cli:approver");
  const invoiceRef = `INV-SBX-${Date.now().toString(36).toUpperCase()}`;
  const fail = (msg: string): never => {
    throw new Error(`Scenario A stopped: ${msg}`);
  };

  d.log("1. Invoice and original transfer (SANDBOX)");
  const beneficiaryHash = await provider.getBeneficiaryHash(d.beneficiaryId);
  const obligationId = await createObligation(
    d.db,
    d.organizationId,
    { supplierRef: "northwind", invoiceRef, amount: d.amount, beneficiaryId: d.beneficiaryId, beneficiaryHash, dueAt: new Date(Date.now() - 2 * 86_400_000) },
    operator,
  );
  const requestId = newRequestId();
  const { transfer } = await d.client.createTransfer({
    requestId,
    beneficiaryId: d.beneficiaryId,
    amount: d.amount,
    sourceCurrency: d.amount.currency,
    transferMethod: "LOCAL",
    reason: "goods_purchased",
    reference: invoiceRef,
  });
  const originalId = transfer.providerTransferId;
  await recordTransferSnapshot(d.db, d.organizationId, transfer, "create");
  await registerOriginalPayment(d.db, d.organizationId, { obligationId, requestId, providerTransferId: originalId }, operator);
  d.log(`    original ${originalId} ${transfer.rawStatus} request_id=${requestId}`);

  d.log("2. Simulate SENT: the money has left, the supplier says it has not arrived");
  await sim.transitionTransfer(originalId, "SENT");
  if ((await follow(d, originalId, (s) => s === "SENT")) !== "SENT") fail("original did not reach SENT");
  const incidentId = await openIncident(d.db, d.organizationId, obligationId, operator, {
    origin: "SANDBOX_SCENARIO",
    title: `Delayed supplier payment (sandbox) - ${invoiceRef}`,
  });
  await ingestSupplierMessage(d.db, d.organizationId, incidentId, { ...CHASER, subject: `${invoiceRef} payment not received`, receivedAt: new Date().toISOString(), synthetic: true }, operator);

  d.log("3. Policy decides");
  const e1 = await evaluateIncident(d.db, provider, d.organizationId, incidentId, { actor: operator });
  d.log(`    ${e1.decision.recommendation}: ${e1.decision.reasons.join(", ")}`);
  if (e1.decision.recommendation !== "WAIT") fail(`expected WAIT, got ${e1.decision.recommendation}`);
  const inv1 = await runInvestigation({ db: d.db, model: d.investigator.model, organizationId: d.organizationId, incidentId, config: { model: d.investigator.modelId } });
  d.log(`    investigator (${d.investigator.modelId}): ${inv1.status}`);

  d.log('4. Operator clicks "Resend anyway"');
  const resend = await attemptManualResend(d.db, provider, d.organizationId, incidentId, operator);
  d.log(`    ${resend.blocked ? `BLOCKED: ${resend.reasons.join(", ")}` : "allowed?!"}`);
  if (!resend.blocked) fail("resend was not blocked while the original is in flight");

  d.log("5. New evidence: simulate a bank return (FAILED, auto-cancelled by Airwallex)");
  await sim.transitionTransfer(originalId, "FAILED", "BENEFICIARY_BANK_RETURNED");
  await follow(d, originalId, (s) => s === "CANCELLED");

  d.log("6. Policy decides again");
  const e2 = await evaluateIncident(d.db, provider, d.organizationId, incidentId, { actor: operator });
  d.log(`    ${e2.decision.recommendation}: ${e2.decision.reasons.join(", ")}`);
  if (e2.decision.recommendation !== "REPLACE") fail(`expected REPLACE, got ${e2.decision.recommendation}`);
  const inv2 = await runInvestigation({ db: d.db, model: d.investigator.model, organizationId: d.organizationId, incidentId, config: { model: d.investigator.modelId } });
  d.log(`    investigator: ${inv2.status}`);

  d.log("7. Proposal, bound approval by a second person, executor sends the replacement");
  const proposals = await d.db
    .select({ id: schema.proposedActions.id, incidentVersion: schema.proposedActions.incidentVersion })
    .from(schema.proposedActions)
    .where(and(eq(schema.proposedActions.organizationId, d.organizationId), eq(schema.proposedActions.incidentId, incidentId)));
  const current = (await getIncident(d.db, d.organizationId, incidentId)).version;
  const proposalId = proposals.find((p) => p.incidentVersion === current)?.id ?? (await proposeReplacement(d.db, d.organizationId, incidentId, operator));
  const approval = await approveProposal(d.db, d.organizationId, { proposedActionId: proposalId, approverId: approver, keys: d.keys });
  if (!approval.ok) fail(`approval refused: ${approval.reasons.join(", ")}`);
  const exec = await executeReplacement(d.db, provider, d.organizationId, approval.ok ? approval.executionId : "", { keys: d.keys });
  d.log(`    execution ${exec.status}`);
  if (exec.status !== "SUCCEEDED") fail(`execution ${exec.status}`);
  const replacement = (await paymentsForObligation(d.db, d.organizationId, obligationId)).find((p) => p.role === "REPLACEMENT");
  if (!replacement?.providerTransferId) fail("no replacement transfer recorded");
  d.log(`    replacement ${replacement!.providerTransferId} request_id=${replacement!.requestId} (original used ${requestId})`);

  d.log("8. Simulate the replacement SENT, then PAID");
  const repId = replacement!.providerTransferId!;
  await follow(d, repId, () => true, 1);
  await sim.transitionTransfer(repId, "SENT");
  await follow(d, repId, (s) => s === "SENT");
  await sim.transitionTransfer(repId, "PAID");
  if ((await follow(d, repId, (s) => s === "PAID")) !== "PAID") fail("replacement did not reach PAID");

  d.log("9. Resolve with the original's fate, post the books, reconcile, verify the audit chain");
  const resolved = await tryResolveIncident(d.db, d.organizationId, incidentId, operator);
  if (!resolved.resolved) fail(`not resolved: ${resolved.reason}`);
  await syncLedgerForObligation(d.db, d.organizationId, obligationId);
  const inc = await getIncident(d.db, d.organizationId, incidentId);
  d.log(`    ${inc.state}: settled by ${inc.settledBy}; original ${inc.originalFate}`);
  const rec = await runReconciliation(d.db, d.organizationId);
  d.log(`    reconciliation ${rec.ok ? "OK" : "FINDINGS"}${rec.findings.length ? `: ${rec.findings.map((f) => f.code).join(", ")}` : ""}`);
  const audit = await verifyStoredAuditChain(d.db, d.organizationId);
  d.log(`    audit chain ${audit.ok ? `verified (${audit.entries} entries)` : `BROKEN at ${audit.brokenAtSeq}`}`);
  return { incidentId, ok: rec.ok && audit.ok };
}
