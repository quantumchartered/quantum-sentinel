import { randomUUID } from "node:crypto";
import { type Canonicalizable, classifyFinality } from "@sentinel/policy";
import { and, eq, sql } from "drizzle-orm";
import { type Tx, appendAudit } from "./audit.js";
import type { Db } from "./client.js";
import { loadTransferHistory } from "./event-store.js";
import { incidents, ledgerEntries, obligations, payments, reconciliationRuns, transferObservations } from "./schema.js";

export type LedgerAccount = "WALLET" | "IN_TRANSIT" | "SUPPLIER_PAYABLE" | "EXPENSE";

interface Line {
  account: LedgerAccount;
  /** Debit positive, credit negative. */
  amountMinor: bigint;
}

/**
 * Post one balanced journal, idempotently: the journal key identifies the
 * business event, so posting it again inserts nothing. The database rejects an
 * unbalanced journal at commit.
 */
export async function postJournal(
  tx: Tx,
  organizationId: string,
  journal: { key: string; currency: string; memo: string; obligationId?: string; paymentId?: string; lines: Line[] },
): Promise<boolean> {
  const total = journal.lines.reduce((s, l) => s + l.amountMinor, 0n);
  if (total !== 0n) throw new Error(`journal ${journal.key} does not balance (${total})`);
  const inserted = await tx
    .insert(ledgerEntries)
    .values(
      journal.lines.map((l, i) => ({
        organizationId,
        journalKey: journal.key,
        lineNo: i + 1,
        account: l.account,
        currency: journal.currency,
        amountMinor: l.amountMinor,
        obligationId: journal.obligationId ?? null,
        paymentId: journal.paymentId ?? null,
        memo: journal.memo,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: ledgerEntries.id });
  return inserted.length > 0;
}

type PaymentLike = { id: string; obligationId: string; amountMinor: bigint; currency: string };

export const journals = {
  /** We owe the supplier. */
  accrue: (ob: { id: string; amountMinor: bigint; currency: string }) => ({
    key: `obligation:${ob.id}:accrued`,
    currency: ob.currency,
    memo: "invoice accrued",
    obligationId: ob.id,
    lines: [
      { account: "EXPENSE" as const, amountMinor: ob.amountMinor },
      { account: "SUPPLIER_PAYABLE" as const, amountMinor: -ob.amountMinor },
    ],
  }),
  /** Money left the wallet towards the provider. */
  dispatched: (p: PaymentLike) => ({
    key: `payment:${p.id}:dispatched`,
    currency: p.currency,
    memo: "transfer dispatched",
    obligationId: p.obligationId,
    paymentId: p.id,
    lines: [
      { account: "IN_TRANSIT" as const, amountMinor: p.amountMinor },
      { account: "WALLET" as const, amountMinor: -p.amountMinor },
    ],
  }),
  /** Provider reports PAID: the liability is discharged. */
  paid: (p: PaymentLike) => ({
    key: `payment:${p.id}:paid`,
    currency: p.currency,
    memo: "transfer paid",
    obligationId: p.obligationId,
    paymentId: p.id,
    lines: [
      { account: "SUPPLIER_PAYABLE" as const, amountMinor: p.amountMinor },
      { account: "IN_TRANSIT" as const, amountMinor: -p.amountMinor },
    ],
  }),
  /** PAID, then failed (a late return): the payable reopens and the money is back in the wallet. */
  paidReversed: (p: PaymentLike) => ({
    key: `payment:${p.id}:paid_reversed`,
    currency: p.currency,
    memo: "paid transfer failed later and was returned",
    obligationId: p.obligationId,
    paymentId: p.id,
    lines: [
      { account: "WALLET" as const, amountMinor: p.amountMinor },
      { account: "SUPPLIER_PAYABLE" as const, amountMinor: -p.amountMinor },
    ],
  }),
  /** Confirmed failure: funds come back to the wallet. (Fees are not modelled yet.) */
  returned: (p: PaymentLike) => ({
    key: `payment:${p.id}:returned`,
    currency: p.currency,
    memo: "transfer failed and returned",
    obligationId: p.obligationId,
    paymentId: p.id,
    lines: [
      { account: "WALLET" as const, amountMinor: p.amountMinor },
      { account: "IN_TRANSIT" as const, amountMinor: -p.amountMinor },
    ],
  }),
};

/**
 * Bring the ledger in line with what is KNOWN for one obligation. Only provider
 * facts move money between accounts: dispatch needs a provider transfer id,
 * PAID needs an observed PAID, a return needs a confirmed failure.
 */
export async function syncLedgerForObligation(db: Db, organizationId: string, obligationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [ob] = await tx.select().from(obligations).where(and(eq(obligations.organizationId, organizationId), eq(obligations.id, obligationId)));
    if (!ob) throw new Error("obligation not found");
    await postJournal(tx, organizationId, journals.accrue(ob));
    const pays = await tx.select().from(payments).where(and(eq(payments.organizationId, organizationId), eq(payments.obligationId, obligationId)));
    for (const p of pays) {
      if (!p.providerTransferId) continue; // never sent (or unknown): nothing moved that we can prove
      await postJournal(tx, organizationId, journals.dispatched(p));
      const h = await loadTransferHistory(tx, organizationId, p.providerTransferId);
      if (p.state === "FAILED_CONFIRMED") await postJournal(tx, organizationId, journals.returned(p));
      else if (h.status === "PAID" && classifyFinality(h).kind === "PAID_NOT_FINAL") await postJournal(tx, organizationId, journals.paid(p));
      else if (classifyFinality(h).kind === "FAILED_AFTER_PAID") {
        await postJournal(tx, organizationId, journals.paid(p));
        await postJournal(tx, organizationId, journals.paidReversed(p));
      }
    }
  });
}

export async function accountBalances(db: Db | Tx, organizationId: string, obligationId?: string): Promise<Record<string, bigint>> {
  const rows = await db
    .select({ account: ledgerEntries.account, currency: ledgerEntries.currency, total: sql<string>`sum(${ledgerEntries.amountMinor})::text` })
    .from(ledgerEntries)
    .where(obligationId ? and(eq(ledgerEntries.organizationId, organizationId), eq(ledgerEntries.obligationId, obligationId)) : eq(ledgerEntries.organizationId, organizationId))
    .groupBy(ledgerEntries.account, ledgerEntries.currency);
  return Object.fromEntries(rows.map((r) => [`${r.account}:${r.currency}`, BigInt(r.total)]));
}

export interface Finding {
  severity: "error" | "warning";
  code: string;
  detail: Canonicalizable;
}

/**
 * Reconciliation invariants (AGENTS.md §6.11). Reports; never repairs, never
 * invents a settlement. Any error finding means a human must look.
 */
export async function runReconciliation(db: Db, organizationId: string): Promise<{ id: string; ok: boolean; findings: Finding[] }> {
  const findings: Finding[] = [];

  // 1. Ledger: every journal balances (also enforced at commit) and no payable is over-paid.
  const unbalanced = await db.execute<{ journal_key: string; total: string }>(sql`
    SELECT journal_key, sum(amount_minor)::text AS total FROM ledger_entries
     WHERE organization_id = ${organizationId} GROUP BY journal_key, currency HAVING sum(amount_minor) <> 0`);
  for (const r of unbalanced.rows) findings.push({ severity: "error", code: "JOURNAL_UNBALANCED", detail: { journalKey: r.journal_key, total: r.total } });

  const overpaid = await db.execute<{ obligation_id: string; total: string }>(sql`
    SELECT obligation_id, sum(amount_minor)::text AS total FROM ledger_entries
     WHERE organization_id = ${organizationId} AND account = 'SUPPLIER_PAYABLE' AND obligation_id IS NOT NULL
     GROUP BY obligation_id HAVING sum(amount_minor) > 0`);
  for (const r of overpaid.rows) findings.push({ severity: "error", code: "OBLIGATION_OVERPAID", detail: { obligationId: r.obligation_id, excessMinor: r.total } });

  // 2. Every provider transfer we have seen belongs to exactly one payment.
  const seen = await db
    .selectDistinct({ id: transferObservations.providerTransferId })
    .from(transferObservations)
    .where(eq(transferObservations.organizationId, organizationId));
  const known = new Set(
    (await db.select({ id: payments.providerTransferId }).from(payments).where(eq(payments.organizationId, organizationId))).map((r) => r.id),
  );
  for (const { id } of seen) if (!known.has(id)) findings.push({ severity: "error", code: "UNMATCHED_PROVIDER_TRANSFER", detail: { providerTransferId: id } });

  // 3. Payments that claim to be sent but have no provider evidence, or are still uncertain.
  for (const p of await db.select().from(payments).where(eq(payments.organizationId, organizationId))) {
    if (p.state === "DISPATCHED" && p.providerTransferId) {
      const h = await loadTransferHistory(db, organizationId, p.providerTransferId);
      if (h.observations.length === 0) findings.push({ severity: "error", code: "PAYMENT_WITHOUT_PROVIDER_EVIDENCE", detail: { paymentId: p.id } });
    }
    if (p.state === "UNCERTAIN") findings.push({ severity: "warning", code: "PAYMENT_OUTCOME_UNCERTAIN", detail: { paymentId: p.id, requestId: p.requestId } });
  }

  // 4. A resolved incident must have a fully settled payable.
  const resolved = await db.select().from(incidents).where(and(eq(incidents.organizationId, organizationId), eq(incidents.state, "RESOLVED")));
  for (const inc of resolved) {
    const b = await accountBalances(db, organizationId, inc.obligationId);
    const payable = Object.entries(b).filter(([k]) => k.startsWith("SUPPLIER_PAYABLE")).reduce((s, [, v]) => s + v, 0n);
    if (payable !== 0n) findings.push({ severity: "error", code: "RESOLVED_BUT_PAYABLE_OPEN", detail: { incidentId: inc.id, payableMinor: payable } });
  }

  const ok = !findings.some((f) => f.severity === "error");
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(reconciliationRuns).values({ id, organizationId, ok, findings: JSON.parse(JSON.stringify(findings, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) });
    await appendAudit(tx, organizationId, { actor: "reconciler", eventType: "reconciliation.run", payload: { runId: id, ok, findingCodes: findings.map((f) => f.code) } });
  });
  return { id, ok, findings };
}
