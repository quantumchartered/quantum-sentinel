import { useCallback, useEffect } from "react";
import { Link, useParams } from "react-router";
import { ConfirmDialog } from "../components/dialog";
import { CostEstimateCard } from "../components/estimate";
import { Badge, Button, Card, ErrorBox, EvidenceChip, KV, Loading, OriginBadge, RecBadge, StateBadge, cx } from "../components/ui";
import { api, useAction, useResource } from "../lib/api";
import { formatMicroUsd, formatMoney, formatTime, relativeTime, shortId } from "../lib/format";
import { explainReason, FINALITY_TEXT } from "../lib/reasons";
import type { AgentRun, Evidence, IncidentDetail, Me, Payment } from "../lib/types";

const LABEL_TONE: Record<string, "accent" | "neutral" | "mock" | "warn"> = {
  provider_fact: "accent",
  internal_record: "neutral",
  synthetic_fixture: "mock",
  ai_interpretation: "warn",
  unknown: "neutral",
};

function Recommendation({ d, me, onDone }: { d: IncidentDetail; me: Me; onDone: () => void }) {
  const inc = d.incident;
  const decision = d.decisions.at(-1);
  const canOperate = me.role === "OWNER" || me.role === "OPERATOR";
  const id = inc.id;

  const evaluate = useAction(useCallback(() => api<{ recommendation: string; changed: boolean }>(`/api/incidents/${id}/evaluate`, { method: "POST" }), [id]));
  const investigate = useAction(useCallback(() => api<{ status: string }>(`/api/incidents/${id}/investigate`, { method: "POST" }), [id]));
  const resend = useAction(useCallback(() => api<{ blocked: boolean; reasons?: string[] }>(`/api/incidents/${id}/resend`, { method: "POST" }), [id]));
  const propose = useAction(useCallback(() => api<{ proposalId: string }>(`/api/incidents/${id}/propose`, { method: "POST" }), [id]));
  const resolve = useAction(useCallback(() => api<{ resolved: boolean; reason?: string }>(`/api/incidents/${id}/resolve`, { method: "POST" }), [id]));
  const anyError = evaluate.error ?? investigate.error ?? resend.error ?? propose.error ?? resolve.error;
  const live = !["RESOLVED", "ESCALATED"].includes(inc.state);
  // A person's escalation, or a reopen after resolution, overrides the last policy decision on screen.
  const shown = inc.state === "ESCALATED" ? "ESCALATE" : decision?.recommendation;
  const superseded = !!decision && shown !== decision.recommendation;

  // Results of earlier clicks describe an earlier decision; drop them when the decision changes.
  const decisionId = decision?.id;
  const resets = [evaluate.reset, investigate.reset, resend.reset, propose.reset, resolve.reset];
  useEffect(() => {
    for (const r of resets) r();
  }, [decisionId]); // only when the decision itself changes

  return (
    <Card title="Recommendation" actions={decision && <span className="text-xs text-ink-faint">Decided by code · {decision.policyVersion}</span>}>
      {!decision ? (
        <p className="text-sm text-ink-dim">No decision yet. Re-evaluate to run the policy.</p>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="shrink-0">
            <p
              className={cx(
                "text-3xl font-semibold tracking-tight",
                shown === "WAIT" ? "text-warn" : shown === "REPLACE" ? "text-accent-strong" : "text-danger",
              )}
            >
              {shown}
            </p>
            <p className="mt-1 text-xs text-ink-faint">{superseded ? `since ${formatTime(inc.updatedAt)}` : `since ${formatTime(decision.decidedAt)}`}</p>
          </div>
          <ul className={cx("flex-1 space-y-1.5 text-sm", superseded ? "text-ink-dim" : "text-ink")}>
            {superseded && <li className="text-xs uppercase tracking-wide text-ink-faint">Earlier policy decision: {decision.recommendation}</li>}
            {decision.reasons.map((r) => (
              <li key={r} className="flex gap-2">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
                <span>{explainReason(r)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {inc.riskFlags.length > 0 && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <p className="font-medium">Payment blocked by risk flags. Only a person can clear this.</p>
          <p className="mt-0.5 text-danger/90">{inc.riskFlags.map((f) => explainReason(`risk:${f}`)).join(" ")}</p>
        </div>
      )}
      {inc.state === "ESCALATED" && inc.escalationReason && <p className="mt-3 text-sm text-ink-dim">Escalated: {explainReason(inc.escalationReason)}</p>}
      {inc.state === "RESOLVED" && (
        <p className="mt-3 text-sm text-ok">
          Resolved. Settled by the {inc.settledBy?.toLowerCase()} payment. Original transfer: {inc.originalFate}.
        </p>
      )}

      {canOperate && live && (
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button onClick={() => evaluate.run()} disabled={evaluate.pending}>
            {evaluate.pending ? "Evaluating…" : "Re-evaluate"}
          </Button>
          <Button onClick={() => investigate.run()} disabled={investigate.pending}>
            {investigate.pending ? "Investigating…" : "Run investigator"}
          </Button>
          <Button tone="danger" onClick={() => resend.run()} disabled={resend.pending} title="Ask policy to send a replacement right now">
            Resend anyway
          </Button>
          {inc.state === "RECOMMENDED" && inc.recommendation === "REPLACE" && (
            <Button tone="primary" onClick={() => propose.run()} disabled={propose.pending}>
              Propose replacement
            </Button>
          )}
          {inc.state === "MONITORING" && (
            <Button tone="primary" onClick={() => resolve.run()} disabled={resolve.pending}>
              Check and resolve
            </Button>
          )}
          <ConfirmDialog
            trigger={<Button tone="ghost">Escalate…</Button>}
            title="Escalate to a person"
            confirmLabel="Escalate"
            tone="danger"
            reasonLabel="Why are you escalating?"
            onConfirm={async (reason) => {
              await api(`/api/incidents/${id}/escalate`, { method: "POST", body: { reason } });
              onDone();
            }}
          >
            The incident stops here. No payment will be made until someone reopens it with new evidence.
          </ConfirmDialog>
        </div>
      )}

      <div className="mt-3 space-y-2" aria-live="polite">
        {resend.result &&
          (resend.result.blocked ? (
            <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
              <p className="font-medium">Resend blocked by policy. No money moved.</p>
              <ul className="mt-1 list-disc pl-5">
                {resend.result.reasons?.map((r) => <li key={r}>{explainReason(r)}</li>)}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-ink-dim">Policy allows a replacement. Use “Propose replacement”; a human approver must sign off.</p>
          ))}
        {propose.result && (
          <p className="text-sm text-accent-strong">
            Proposal created. <Link className="underline" to="/approvals">Open the Approval Center</Link>.
          </p>
        )}
        {resolve.result && !resolve.result.resolved && <p className="text-sm text-warn">Not resolved yet: {resolve.result.reason}</p>}
        {evaluate.result && <p className="text-sm text-ink-dim">{evaluate.result.changed ? "Policy re-ran with new facts." : "No material change since the last decision."}</p>}
        <ErrorBox error={anyError} title="Action failed" />
      </div>
    </Card>
  );
}

function AiAnalysis({ runs, currentRecommendation }: { runs: AgentRun[]; currentRecommendation: string | null }) {
  const run = runs.at(-1);
  if (!run) {
    return (
      <Card title="AI investigation">
        <p className="text-sm text-ink-dim">No investigation yet. “Run investigator” reads the evidence and explains the decision. It cannot move money.</p>
      </Card>
    );
  }
  const mock = run.model === "mock-investigator";
  const r = run.report;
  return (
    <Card
      title="AI investigation"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={mock ? "mock" : "accent"}>{mock ? "Mock AI" : run.model}</Badge>
          {run.status === "COMPLETED" ? (
            <Badge tone="ok">Verified</Badge>
          ) : (
            <Badge tone={run.status === "AI_UNAVAILABLE" ? "warn" : "danger"}>{run.status.replaceAll("_", " ").toLowerCase()}</Badge>
          )}
        </div>
      }
    >
      {run.status === "AI_UNAVAILABLE" && <p className="text-sm text-warn">AI analysis unavailable. The deterministic decision above still applies.</p>}
      {currentRecommendation && run.policyRecommendation !== currentRecommendation && (
        <p className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          Out of date: this analysis explains the earlier {run.policyRecommendation} decision. Run the investigator again.
        </p>
      )}
      {run.error && run.status !== "AI_UNAVAILABLE" && <p className="mb-3 text-sm text-ink-dim">{run.error}</p>}

      {run.diff?.recommendation.changed && (
        <div className="mb-4 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-sm">
          <p className="font-medium text-accent-strong">
            Changed from {run.diff.recommendation.from} to {run.diff.recommendation.to}
          </p>
          {run.diff.reasons.added.length > 0 && <p className="mt-1 text-ink-dim">Because: {run.diff.reasons.added.map(explainReason).join(" ")}</p>}
          {run.diff.newEvidence.length > 0 && (
            <p className="mt-1 flex flex-wrap items-center gap-1 text-ink-dim">
              New evidence: {run.diff.newEvidence.map((e) => <EvidenceChip key={e} id={e} />)}
            </p>
          )}
        </div>
      )}

      {r && (
        <div className="space-y-4">
          <div>
            <h3 className="text-xs uppercase tracking-wide text-ink-faint">Explanation</h3>
            {r.explanation.map((s, i) => (
              <p key={i} className="mt-1 text-sm text-ink">
                {s.sentence} <span className="inline-flex flex-wrap gap-1 align-middle">{s.evidence_ids.map((e) => <EvidenceChip key={e} id={e} />)}</span>
              </p>
            ))}
          </div>
          <div>
            <h3 className="text-xs uppercase tracking-wide text-ink-faint">Findings</h3>
            <ul className="mt-1 space-y-2">
              {r.findings.map((f, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={LABEL_TONE[f.label] ?? "neutral"}>{f.label.replaceAll("_", " ")}</Badge>
                  <span className="text-ink">{f.statement}</span>
                  <span className="inline-flex flex-wrap gap-1">{f.evidence_ids.map((e) => <EvidenceChip key={e} id={e} />)}</span>
                </li>
              ))}
            </ul>
          </div>
          {r.risk_indicators.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wide text-ink-faint">Risk indicators</h3>
              {r.risk_indicators.map((x, i) => (
                <p key={i} className="mt-1 text-sm text-danger">
                  {x.indicator} <span className="inline-flex gap-1 align-middle">{x.evidence_ids.map((e) => <EvidenceChip key={e} id={e} />)}</span>
                </p>
              ))}
            </div>
          )}
          {r.uncertainties.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wide text-ink-faint">Uncertain</h3>
              <ul className="mt-1 list-disc pl-5 text-sm text-ink-dim">{r.uncertainties.map((u) => <li key={u}>{u}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {run.verification && !run.verification.ok && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <p className="font-medium">The grounding verifier rejected this report:</p>
          <ul className="mt-1 list-disc pl-5">{run.verification.errors.slice(0, 6).map((e, i) => <li key={i}>{e.code.replaceAll("_", " ").toLowerCase()}: {e.detail}</li>)}</ul>
        </div>
      )}
      <p className="mt-4 text-xs text-ink-faint">
        {run.steps} steps · {run.toolCalls.length} tool calls · {mock ? "no API cost" : `${formatMicroUsd(run.costMicroUsd)} (${run.inputTokens + run.outputTokens} tokens)`} · {relativeTime(run.finishedAt)}
      </p>
    </Card>
  );
}

function PaymentCard({ p }: { p: Payment }) {
  return (
    <div className="rounded-md border border-line bg-panel-2/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-ink">{p.role === "ORIGINAL" ? "Original transfer" : "Replacement transfer"}</p>
        <div className="flex flex-wrap gap-2">
          <Badge tone={p.finality.kind === "CONFIRMED_FAILED" ? "danger" : p.finality.kind === "PAID_NOT_FINAL" ? "ok" : "warn"}>{FINALITY_TEXT[p.finality.kind]}</Badge>
          <Badge tone={p.blocking ? "accent" : "neutral"} title="Whether this payment still blocks any new payment for the invoice">
            {p.blocking ? "Holds the payment lock" : "Lock released"}
          </Badge>
        </div>
      </div>
      <KV
        items={[
          ["Amount", <span className="tabular-nums">{formatMoney(p.amountMinor, p.currency)}</span>],
          ["Provider status", p.providerStatus ?? "unknown"],
          ["Request id", <span className="font-mono text-xs">{p.requestId}</span>],
        ]}
      />
      {p.observations.length > 0 && (
        <ol className="mt-3 border-l border-line pl-4">
          {p.observations.map((o) => (
            <li key={o.id} className="relative pb-2 text-sm last:pb-0">
              <span aria-hidden className={cx("absolute top-1.5 -left-[21px] h-2 w-2 rounded-full", o.status === "FAILED" ? "bg-danger" : o.status === "PAID" ? "bg-ok" : "bg-ink-faint")} />
              <span className="font-medium text-ink">{o.status}</span>
              {o.failureType && <span className="text-danger"> · {o.failureType}</span>}
              <span className="text-ink-faint"> · {o.source} · {formatTime(o.observedAt)}</span> <EvidenceChip id={o.id} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EvidenceItem({ e }: { e: Evidence }) {
  const isMessage = typeof e.content.body === "string";
  return (
    <li className="rounded-md border border-line bg-panel-2/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={LABEL_TONE[e.kind] ?? "neutral"}>{e.kind.replaceAll("_", " ")}</Badge>
        {!e.trusted && <Badge tone="warn" title="External text. Treated as data, never as instructions.">Untrusted</Badge>}
        <span className="text-sm text-ink-dim">{e.source}</span>
        <span className="ml-auto"><EvidenceChip id={e.id} /></span>
      </div>
      {isMessage ? (
        <div className="mt-2 text-sm">
          <p className="text-ink-dim">
            From <span className="text-ink">{String(e.content.from)}</span> · {String(e.content.subject)}
          </p>
          <blockquote className="mt-1 border-l-2 border-warn/50 pl-3 whitespace-pre-wrap text-ink">{String(e.content.body)}</blockquote>
        </div>
      ) : (
        <pre className="mt-2 overflow-x-auto text-xs text-ink-dim">{JSON.stringify(e.content, null, 2)}</pre>
      )}
    </li>
  );
}

const LAB_BUTTONS: [string, string][] = [
  ["ORIGINAL_FAILED_BANK_RETURN", "Original fails: bank return"],
  ["ORIGINAL_PAID", "Original reports PAID"],
  ["REPLACEMENT_PAID", "Replacement reaches PAID"],
  ["SUPPLIER_FRAUD_EMAIL", "Supplier: new bank details"],
  ["WALLET_LOW", "Wallet balance drops"],
  ["BENEFICIARY_CHANGED_AT_PROVIDER", "Beneficiary changed at provider"],
];

const LAB_BUTTONS_RESOLVED: [string, string][] = [["REPLACEMENT_RETURNED_AFTER_PAID", "Paid replacement returned later"]];

function LabControls({ id, resolved }: { id: string; resolved: boolean }) {
  const ev = useAction(useCallback((event: string) => api(`/api/lab/incidents/${id}/events`, { method: "POST", body: { event } }), [id]));
  return (
    <Card title={<span className="flex items-center gap-2">Scenario Lab controls <Badge tone="mock">Simulated</Badge></span>}>
      <p className="mb-3 text-sm text-ink-dim">
        {resolved
          ? "Resolved incidents are re-checked: PAID can still fail. Simulate a late return of the payment that settled this invoice."
          : "Inject new information as the MOCK provider. Then re-evaluate to see the decision change."}
      </p>
      <div className="flex flex-wrap gap-2">
        {(resolved ? LAB_BUTTONS_RESOLVED : LAB_BUTTONS).map(([event, label]) => (
          <Button key={event} onClick={() => ev.run(event)} disabled={ev.pending}>
            {label}
          </Button>
        ))}
      </div>
      <div className="mt-2">
        <ErrorBox error={ev.error} title="Event refused" />
      </div>
    </Card>
  );
}

export function IncidentWorkspace({ me }: { me: Me }) {
  const { id } = useParams();
  const res = useResource<IncidentDetail>(id ? `/api/incidents/${id}` : null);
  const d = res.data;

  if (res.error && !d) return <ErrorBox error={res.error} title="Could not load this incident" />;
  if (!d) return <Loading label="Loading incident" />;
  const inc = d.incident;
  const current = d.proposals.find((p) => p.current);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-ink-faint">
            <Link to="/incidents" className="hover:text-ink">Incidents</Link> / {shortId(inc.id)}
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{inc.title ?? `${d.obligation.supplierRef} ${d.obligation.invoiceRef}`}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <OriginBadge origin={inc.origin} />
            <StateBadge state={inc.state} />
            <RecBadge rec={inc.recommendation} />
            <span className="text-sm text-ink-dim">
              {formatMoney(d.obligation.amountMinor, d.obligation.currency)} to {d.obligation.supplierRef} · invoice {d.obligation.invoiceRef} · due {formatTime(d.obligation.dueAt)}
            </span>
          </div>
        </div>
        <Link to={`/incidents/${inc.id}/replay`} className="rounded-md border border-accent/50 px-3 py-1.5 text-sm font-medium text-accent-strong hover:bg-accent/10">
          Decision Replay
        </Link>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Recommendation d={d} me={me} onDone={() => void res.reload()} />
          {current && (
            <div className="rounded-lg border border-accent/40 bg-accent/5 px-4 py-3 text-sm">
              A replacement of {formatMoney(String(current.facts.amountMinor), String(current.facts.currency))} is waiting for approval.{" "}
              <Link className="font-medium text-accent-strong underline" to="/approvals">Review in the Approval Center</Link>
            </div>
          )}
          <AiAnalysis runs={d.agentRuns} currentRecommendation={d.decisions.at(-1)?.recommendation ?? null} />
          <Card title="Payments for this invoice">
            <div className="space-y-3">{d.payments.map((p) => <PaymentCard key={p.id} p={p} />)}</div>
          </Card>
        </div>
        <div className="min-w-0 space-y-4">
          {inc.origin === "MOCK_SCENARIO" && (me.role === "OWNER" || me.role === "OPERATOR") && (inc.state === "RESOLVED" ? inc.settledBy === "REPLACEMENT" : !(inc.state === "ESCALATED" && inc.settledBy)) && (
            <LabControls id={inc.id} resolved={inc.state === "RESOLVED"} />
          )}
          {d.estimate && <CostEstimateCard e={d.estimate} currency={d.obligation.currency} />}
          <Card title={`Evidence (${d.evidence.length})`}>
            {d.evidence.length === 0 ? <p className="text-sm text-ink-dim">No evidence attached.</p> : <ul className="space-y-3">{d.evidence.map((e) => <EvidenceItem key={e.id} e={e} />)}</ul>}
          </Card>
          <Card title="Books for this invoice">
            {Object.keys(d.ledger).length === 0 ? (
              <p className="text-sm text-ink-dim">Posted when the incident resolves.</p>
            ) : (
              <KV items={Object.entries(d.ledger).map(([k, v]) => [k.split(":")[0]!.replaceAll("_", " ").toLowerCase(), <span className="tabular-nums">{formatMoney(v, k.split(":")[1]!)}</span>])} />
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
