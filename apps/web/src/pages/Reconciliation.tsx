import { useCallback } from "react";
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader } from "../components/ui";
import { api, useAction, useResource } from "../lib/api";
import { formatMoney, formatTime, shortId } from "../lib/format";
import type { Me, ReconciliationView } from "../lib/types";

const FINDING_TEXT: Record<string, string> = {
  JOURNAL_UNBALANCED: "A journal does not sum to zero.",
  OBLIGATION_OVERPAID: "More was paid against an invoice than it was for.",
  UNMATCHED_PROVIDER_TRANSFER: "The provider reports a transfer that no Sentinel payment owns.",
  PAYMENT_WITHOUT_PROVIDER_EVIDENCE: "A payment says it was sent, but there is no provider evidence for it.",
  PAYMENT_OUTCOME_UNCERTAIN: "A send's outcome is unknown. Its invoice stays locked until it is reconciled.",
  RESOLVED_BUT_PAYABLE_OPEN: "An incident is resolved but its invoice still shows money owed.",
};

const ACCOUNT_TEXT: Record<string, string> = {
  WALLET: "Wallet",
  IN_TRANSIT: "In transit",
  SUPPLIER_PAYABLE: "Owed to suppliers",
  EXPENSE: "Expense",
};

export function ReconciliationPage({ me }: { me: Me }) {
  const res = useResource<ReconciliationView>("/api/reconciliation");
  const run = useAction(useCallback(() => api<{ id: string; ok: boolean }>("/api/reconcile", { method: "POST" }), []));
  const canRun = me.role === "OWNER" || me.role === "OPERATOR";
  const d = res.data;
  const latest = d?.runs[0];

  return (
    <>
      <PageHeader
        title="Reconciliation"
        subtitle="Checks the books against every provider transfer Sentinel has seen. It flags gaps and never repairs or invents a settlement."
        right={
          canRun && (
            <Button tone="primary" disabled={run.pending} onClick={() => void run.run()}>
              {run.pending ? "Reconciling…" : "Run reconciliation"}
            </Button>
          )
        }
      />
      <ErrorBox error={res.error ?? run.error} title="Reconciliation" />
      {!d && !res.error ? (
        <Loading label="Loading reconciliation" />
      ) : d ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <Card
              title="Latest run"
              actions={latest && (latest.ok ? <Badge tone="ok">No errors</Badge> : <Badge tone="danger">Needs a person</Badge>)}
            >
              {!latest ? (
                <Empty title="Not run yet">{canRun ? "Run reconciliation to check the books." : "An operator can run it."}</Empty>
              ) : (
                <>
                  <p className="mb-3 text-sm text-ink-dim">Run {shortId(latest.id)} at {formatTime(latest.startedAt)}</p>
                  {latest.findings.length === 0 ? (
                    <p className="text-sm text-ok">Every journal balances and every provider transfer belongs to a payment.</p>
                  ) : (
                    <ul className="space-y-2">
                      {latest.findings.map((f, i) => (
                        <li key={i} className="rounded-md border border-line px-3 py-2 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={f.severity === "error" ? "danger" : "warn"}>{f.severity}</Badge>
                            <span className="font-mono text-xs text-ink">{f.code}</span>
                          </div>
                          <p className="mt-1 text-ink-dim">{FINDING_TEXT[f.code] ?? f.code}</p>
                          <p className="mt-1 break-all font-mono text-xs text-ink-faint">
                            {Object.entries(f.detail).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </Card>
            {d.runs.length > 1 && (
              <Card title="Earlier runs">
                <ul className="divide-y divide-line text-sm">
                  {d.runs.slice(1).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="text-ink-dim">{formatTime(r.startedAt)}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-ink-faint">{r.findings.length} findings</span>
                        {r.ok ? <Badge tone="ok">OK</Badge> : <Badge tone="danger">Errors</Badge>}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
          <div className="min-w-0 space-y-4">
            <Card title="Provider transfers">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-ink-faint">Seen from the provider</dt>
                <dd className="tabular-nums">{d.providerTransfers.seen}</dd>
                <dt className="text-ink-faint">Linked to a payment</dt>
                <dd className="tabular-nums">{d.providerTransfers.linkedToPayments}</dd>
              </dl>
            </Card>
            <Card title="Ledger (all invoices)">
              {d.ledger.length === 0 ? (
                <p className="text-sm text-ink-dim">Nothing posted yet. Journals are posted when an incident resolves.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Ledger balance per account and currency</caption>
                  <thead className="text-xs text-ink-faint">
                    <tr>
                      <th scope="col" className="pb-1 font-normal">Account</th>
                      <th scope="col" className="pb-1 text-right font-normal">Lines</th>
                      <th scope="col" className="pb-1 text-right font-normal">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.ledger.map((l) => (
                      <tr key={`${l.account}:${l.currency}`} className="border-t border-line">
                        <th scope="row" className="py-1.5 font-medium">{ACCOUNT_TEXT[l.account] ?? l.account}</th>
                        <td className="py-1.5 text-right tabular-nums text-ink-dim">{l.lines}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatMoney(l.total, l.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-3 text-xs text-ink-faint">Double entry: debits are positive and credits negative, so each currency's balances sum to zero.</p>
            </Card>
          </div>
        </div>
      ) : null}
    </>
  );
}
