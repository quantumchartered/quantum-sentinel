import { useState } from "react";
import { Link } from "react-router";
import { ConfirmDialog } from "../components/dialog";
import { Badge, Button, Card, Empty, ErrorBox, KV, Loading, OriginBadge, PageHeader } from "../components/ui";
import { ApiError, api, announceChange, useResource } from "../lib/api";
import { actorLabel, formatMoney, formatTime, shortId } from "../lib/format";
import { explainReason } from "../lib/reasons";
import type { ApprovalItem, Me } from "../lib/types";

type ApproveResult =
  | { approved: false; reasons: string[] }
  | { approved: true; executionId: string; execution: { status: string; providerTransferId?: string; reasons?: string[]; error?: string } };

function Outcome({ r }: { r: ApproveResult }) {
  if (!r.approved)
    return (
      <div role="alert" className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
        <p className="font-medium">Approval refused. Nothing was sent.</p>
        <ul className="mt-1 list-disc pl-5">{r.reasons.map((x) => <li key={x}>{explainReason(x)}</li>)}</ul>
      </div>
    );
  const e = r.execution;
  const ok = e.status === "SUCCEEDED";
  return (
    <div role="status" className={`mt-3 rounded-md border px-3 py-2 text-sm ${ok ? "border-ok/40 bg-ok/10 text-ok" : "border-warn/40 bg-warn/10 text-warn"}`}>
      <p className="font-medium">
        {ok ? "Approved and sent. The replacement was created with a new request id." : `Approved. Execution: ${e.status.toLowerCase()}.`}
      </p>
      {e.reasons && <ul className="mt-1 list-disc pl-5">{e.reasons.map((x) => <li key={x}>{explainReason(x)}</li>)}</ul>}
    </div>
  );
}

function ApprovalCard({ item, me, onOutcome }: { item: ApprovalItem; me: Me; onOutcome: (r: ApproveResult) => void }) {
  const [result, setLocal] = useState<ApproveResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const setResult = (r: ApproveResult) => (setLocal(r), onOutcome(r));
  const f = item.facts;
  const money = formatMoney(f.amountMinor, f.currency);
  const isApprover = me.role === "APPROVER" || me.role === "OWNER";

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      announceChange();
    } catch (e) {
      setError(e as Error);
      if (e instanceof ApiError && e.status === 409) announceChange();
    }
  };

  return (
    <Card title={<span className="tabular-nums">Replace payment · {money}</span>} actions={<OriginBadge origin={item.origin} />}>
      <p className="mb-4 text-sm text-ink-dim">
        <Link to={`/incidents/${item.incidentId}`} className="text-accent hover:text-accent-strong">
          {item.incidentTitle ?? shortId(item.incidentId)}
        </Link>{" "}
        · proposed by {actorLabel(item.proposedBy)} · {formatTime(item.proposedAt)}
      </p>
      <h3 className="mb-2 text-xs uppercase tracking-wide text-ink-faint">You are signing exactly these facts</h3>
      <KV
        items={[
          ["Amount", <span className="font-medium tabular-nums">{money}</span>],
          ["Beneficiary", <span className="font-mono text-xs">{f.beneficiaryId}</span>],
          ["Bank details hash", <span className="font-mono text-xs">{f.beneficiaryHash.slice(0, 16)}…</span>],
          ["Replaces payment", <span className="font-mono text-xs">{shortId(f.originalPaymentId)}</span>],
          ["Provider state version", f.providerStateVersion],
          ["Evidence set hash", <span className="font-mono text-xs">{f.evidenceSetHash.slice(0, 16)}…</span>],
          ["Incident version", f.incidentVersion],
          ["Policy", f.policyVersion],
        ]}
      />
      <p className="mt-3 text-xs text-ink-faint">
        If any of these change before the payment is sent (new evidence, a status update, different bank details), your approval becomes invalid. It also expires 15
        minutes after you approve. The executor re-checks everything with the provider before sending.
      </p>

      {isApprover && !result && (
        <div className="mt-4 flex flex-wrap gap-2">
          {item.canApprove ? (
            <ConfirmDialog
              trigger={<Button tone="primary">Approve and send…</Button>}
              title={`Send ${money}?`}
              confirmLabel="Approve and send"
              onConfirm={() => act(async () => setResult(await api<ApproveResult>(`/api/proposals/${item.proposalId}/approve`, { method: "POST" })))}
            >
              This creates one replacement transfer to beneficiary <span className="font-mono">{f.beneficiaryId}</span>. Sandbox only: simulated funds.
            </ConfirmDialog>
          ) : (
            <Badge tone="warn" title="Four-eyes rule">
              You proposed this. Another approver must sign.
            </Badge>
          )}
          <ConfirmDialog
            trigger={<Button tone="danger">Reject…</Button>}
            title="Reject this proposal"
            confirmLabel="Reject"
            tone="danger"
            reasonLabel="Reason (kept in the audit log)"
            onConfirm={(reason) => act(() => api(`/api/proposals/${item.proposalId}/reject`, { method: "POST", body: { reason } }))}
          >
            The incident goes back to investigation. Nothing is sent.
          </ConfirmDialog>
        </div>
      )}
      {!isApprover && <p className="mt-4 text-sm text-ink-dim">Only approvers can sign. You are signed in as {me.role.toLowerCase()}.</p>}
      {result && <p className="mt-3 text-sm text-ink-dim">Decision recorded. See “Just decided” above.</p>}
      <div className="mt-3">
        <ErrorBox error={error} title="Could not complete" />
      </div>
    </Card>
  );
}

export function ApprovalCenter({ me }: { me: Me }) {
  const q = useResource<ApprovalItem[]>("/api/approvals");
  // Decisions made on this page stay visible after their card leaves the queue.
  const [recent, setRecent] = useState<{ item: ApprovalItem; result: ApproveResult }[]>([]);
  return (
    <>
      <PageHeader title="Approval Center" subtitle="Replacement payments wait here for a human. Code has already checked them; you decide." />
      <ErrorBox error={q.error} title="Could not load approvals" />
      {recent.length > 0 && (
        <section aria-label="Just decided" className="mb-6 space-y-2">
          {recent.map(({ item, result }) => (
            <div key={item.proposalId} className="rounded-lg border border-line bg-panel px-4 py-3">
              <p className="text-sm text-ink">
                <Link to={`/incidents/${item.incidentId}`} className="text-accent hover:text-accent-strong">
                  {item.incidentTitle ?? shortId(item.incidentId)}
                </Link>{" "}
                · {formatMoney(item.facts.amountMinor, item.facts.currency)}
              </p>
              <Outcome r={result} />
            </div>
          ))}
        </section>
      )}
      {!q.data && !q.error ? (
        <Loading />
      ) : q.data?.length === 0 ? (
        <Empty title="Nothing waiting for approval">Proposals appear here when policy allows a replacement and someone proposes it.</Empty>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {q.data?.map((item) => (
            <ApprovalCard key={item.proposalId} item={item} me={me} onOutcome={(result) => setRecent((r) => [{ item, result }, ...r])} />
          ))}
        </div>
      )}
    </>
  );
}
