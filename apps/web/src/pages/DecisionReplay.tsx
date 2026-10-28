import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Badge, Button, Card, ErrorBox, EvidenceChip, KV, Loading, OriginBadge, cx } from "../components/ui";
import { useResource } from "../lib/api";
import { actorLabel, formatTime, shortId } from "../lib/format";
import { explainReason, STATE_TEXT } from "../lib/reasons";
import type { AgentRun, ReplayData } from "../lib/types";

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "mock";

interface Frame {
  key: string;
  at: string;
  order: number;
  key_moment: boolean;
  title: string;
  detail?: string;
  actor?: string;
  tone: Tone;
  // State contributions
  state?: string;
  recommendation?: string;
  reasons?: string[];
  provider?: { role: string; status: string; failureType: string | null };
  evidenceId?: string;
  runId?: string;
}

const P = (p: Record<string, unknown>, k: string) => (p[k] === undefined || p[k] === null ? "" : String(p[k]));

function describe(a: ReplayData["audit"][number]): Omit<Frame, "key" | "at" | "order"> {
  const p = a.payload;
  switch (a.type) {
    case "obligation.created":
      return { title: "Invoice recorded", detail: `${P(p, "supplierRef")} ${P(p, "invoiceRef")}`, tone: "neutral", key_moment: true, actor: a.actor };
    case "payment.original_registered":
      return { title: "Original transfer registered", tone: "neutral", key_moment: false, actor: a.actor };
    case "incident.opened":
      return { title: "Incident opened", tone: "neutral", key_moment: true, actor: a.actor, state: "OPEN" };
    case "incident.transition":
      return { title: `State: ${STATE_TEXT[P(p, "to")] ?? P(p, "to")}`, detail: `from ${STATE_TEXT[P(p, "from")] ?? P(p, "from")}`, tone: P(p, "to") === "ESCALATED" ? "danger" : "neutral", key_moment: ["AWAITING_APPROVAL", "EXECUTING", "RESOLVED", "ESCALATED"].includes(P(p, "to")), actor: a.actor, state: P(p, "to") };
    case "decision.recorded":
      return {
        title: `Decision: ${P(p, "recommendation")}`,
        detail: ((p.reasons as string[]) ?? []).map(explainReason).join(" "),
        tone: P(p, "recommendation") === "REPLACE" ? "accent" : P(p, "recommendation") === "WAIT" ? "warn" : "danger",
        key_moment: true,
        actor: a.actor,
        recommendation: P(p, "recommendation"),
        reasons: (p.reasons as string[]) ?? [],
      };
    case "evidence.added":
      return { title: `Evidence added: ${P(p, "source")}`, detail: p.trusted === false ? "Untrusted external text" : undefined, tone: p.trusted === false ? "warn" : "neutral", key_moment: true, actor: a.actor, evidenceId: `ev:${P(p, "evidenceId")}` };
    case "risk.flagged":
      return { title: `Risk flag raised by code`, detail: explainReason(`risk:${P(p, "flag")}`), tone: "danger", key_moment: true, actor: a.actor };
    case "supplier_message.screened":
      return { title: "Supplier message screened", detail: ((p.flags as string[]) ?? []).join(", "), tone: "warn", key_moment: false, actor: a.actor };
    case "resend.blocked":
      return { title: "“Resend anyway” blocked", detail: ((p.reasons as string[]) ?? []).map(explainReason).join(" "), tone: "warn", key_moment: true, actor: a.actor };
    case "agent.run":
      return { title: `AI investigation ${p.accepted ? "verified" : P(p, "status").toLowerCase().replaceAll("_", " ")}`, detail: p.reportRecommendation ? `Report recommends ${P(p, "reportRecommendation")}` : undefined, tone: p.accepted ? "ok" : "danger", key_moment: true, actor: a.actor, runId: P(p, "runId") };
    case "agent.proposal_blocked":
      return { title: "AI proposal blocked by policy", detail: P(p, "reason"), tone: "warn", key_moment: true, actor: a.actor };
    case "agent.unknown_tool":
      return { title: `AI tried a tool that does not exist: ${P(p, "tool")}`, detail: "Refused and recorded.", tone: "danger", key_moment: true, actor: a.actor };
    case "agent.suggestion":
      return { title: `AI suggested ${P(p, "action")}`, tone: "neutral", key_moment: false, actor: a.actor };
    case "action.proposed":
      return { title: "Replacement proposed", detail: "Exact amount, beneficiary and evidence frozen for approval.", tone: "accent", key_moment: true, actor: a.actor };
    case "approval.granted":
      return { title: "Approved with a bound signature", tone: "ok", key_moment: true, actor: a.actor };
    case "approval.rejected_stale":
      return { title: "Approval refused: facts changed", detail: ((p.reasons as string[]) ?? []).map(explainReason).join(" "), tone: "warn", key_moment: true, actor: a.actor };
    case "approval.rejected":
      return { title: "Approver rejected the proposal", detail: P(p, "reason"), tone: "warn", key_moment: true, actor: a.actor };
    case "execution.revalidated":
      return { title: "Executor re-checked everything with the provider", tone: "neutral", key_moment: false, actor: a.actor };
    case "execution.succeeded":
      return { title: "Replacement sent", detail: `request ${P(p, "requestId")}`, tone: "ok", key_moment: true, actor: a.actor };
    case "execution.uncertain":
      return { title: "Send outcome uncertain: lock kept", tone: "warn", key_moment: true, actor: a.actor };
    case "execution.blocked":
      return { title: "Execution blocked at the last check", detail: ((p.reasons as string[]) ?? []).map(explainReason).join(" "), tone: "danger", key_moment: true, actor: a.actor };
    case "execution.rejected":
      return { title: "Provider rejected the replacement", tone: "danger", key_moment: true, actor: a.actor };
    case "payment.failure_confirmed":
      return { title: `Failure confirmed: ${P(p, "failureType")}`, detail: "Payment lock released for this invoice.", tone: "accent", key_moment: true, actor: a.actor };
    case "lab.event":
      return { title: `Simulated: ${P(p, "event").replaceAll("_", " ").toLowerCase()}`, tone: "mock", key_moment: true, actor: a.actor };
    default:
      return { title: a.type, tone: "neutral", key_moment: false, actor: a.actor };
  }
}

function buildFrames(d: ReplayData): Frame[] {
  const frames: Frame[] = [];
  for (const a of d.audit) frames.push({ key: `a${a.seq}`, at: a.at, order: a.seq, ...describe(a) });
  for (const o of d.observations) {
    frames.push({
      key: o.id,
      at: o.at,
      order: 0,
      key_moment: true,
      title: `Provider: ${o.paymentRole === "REPLACEMENT" ? "replacement" : "original"} ${o.status}`,
      detail: o.failureType ? `${o.failureType}${o.failureMessage ? ` · ${o.failureMessage}` : ""}` : `via ${o.source}`,
      tone: o.status === "FAILED" ? "danger" : o.status === "PAID" ? "ok" : "neutral",
      provider: { role: o.paymentRole ?? "ORIGINAL", status: o.status, failureType: o.failureType },
      evidenceId: o.id,
    });
  }
  return frames.sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || x.order - y.order);
}

const DOT: Record<Tone, string> = {
  neutral: "bg-ink-faint",
  accent: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  mock: "bg-mock",
};

function Snapshot({ frames, index, runs }: { frames: Frame[]; index: number; runs: AgentRun[] }) {
  const upto = frames.slice(0, index + 1);
  const last = <K extends keyof Frame>(k: K) => [...upto].reverse().find((f) => f[k] !== undefined)?.[k];
  const decisions = upto.filter((f) => f.recommendation);
  const current = decisions.at(-1);
  const previous = decisions.at(-2);
  const providers = new Map<string, NonNullable<Frame["provider"]>>();
  for (const f of upto) if (f.provider) providers.set(f.provider.role, f.provider);
  const known = upto.filter((f) => f.evidenceId).map((f) => f.evidenceId!);
  const frame = frames[index]!;
  const run = frame.runId ? runs.find((r) => r.id === frame.runId) : undefined;

  return (
    <div className="space-y-4">
      <Card title="At this moment">
        <KV
          items={[
            ["Time", formatTime(frame.at)],
            ["Incident state", STATE_TEXT[String(last("state") ?? "OPEN")] ?? String(last("state"))],
            ["Recommendation", current ? <Badge tone={current.recommendation === "REPLACE" ? "accent" : current.recommendation === "WAIT" ? "warn" : "danger"}>{current.recommendation}</Badge> : "none yet"],
            ...[...providers.entries()].map(([role, p]): [string, React.ReactNode] => [`${role === "ORIGINAL" ? "Original" : "Replacement"} at provider`, `${p.status}${p.failureType ? ` · ${p.failureType}` : ""}`]),
            ["Evidence known", `${known.length} items`],
          ]}
        />
        {current?.reasons && (
          <div className="mt-4">
            <h3 className="text-xs uppercase tracking-wide text-ink-faint">Why (decided by code)</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink">{current.reasons.map((r) => <li key={r}>{explainReason(r)}</li>)}</ul>
          </div>
        )}
        {previous && current && previous.recommendation !== current.recommendation && (
          <div className="mt-4 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-sm">
            <p className="font-medium text-accent-strong">
              Decision changed: {previous.recommendation} → {current.recommendation}
            </p>
            <p className="mt-1 text-ink-dim">
              New since the last decision: {current.reasons!.filter((r) => !previous.reasons!.includes(r)).map(explainReason).join(" ") || "same reasons"}
            </p>
          </div>
        )}
      </Card>
      {run && (
        <Card title="What the AI saw and said">
          <p className="text-sm text-ink-dim">
            {run.model === "mock-investigator" ? "Mock AI" : run.model} · {run.steps} steps · {(run as unknown as { evidenceShown?: unknown[] }).evidenceShown?.length ?? 0} evidence items shown · status {run.status.toLowerCase()}
          </p>
          {run.report?.explanation.map((s, i) => (
            <p key={i} className="mt-2 text-sm text-ink">
              {s.sentence} <span className="inline-flex flex-wrap gap-1 align-middle">{s.evidence_ids.map((e) => <EvidenceChip key={e} id={e} />)}</span>
            </p>
          ))}
          {run.diff && run.diff.newEvidence.length > 0 && (
            <p className="mt-3 flex flex-wrap items-center gap-1 text-sm text-ink-dim">
              Newly cited: {run.diff.newEvidence.map((e) => <EvidenceChip key={e} id={e} />)}
            </p>
          )}
        </Card>
      )}
      <Card title="Evidence known at this point">
        {known.length === 0 ? <p className="text-sm text-ink-dim">Nothing yet.</p> : <div className="flex flex-wrap gap-1">{known.map((e) => <EvidenceChip key={e} id={e} />)}</div>}
      </Card>
    </div>
  );
}

export function DecisionReplay() {
  const { id } = useParams();
  const res = useResource<ReplayData>(id ? `/api/incidents/${id}/replay` : null);
  const [everything, setEverything] = useState(false);
  const all = useMemo(() => (res.data ? buildFrames(res.data) : []), [res.data]);
  const frames = useMemo(() => (everything ? all : all.filter((f) => f.key_moment)), [all, everything]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => setIndex((i) => Math.min(Math.max(i, 0), Math.max(frames.length - 1, 0))), [frames.length]);
  useEffect(() => {
    if (!playing) return;
    if (index >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIndex((i) => i + 1), 900);
    return () => clearTimeout(t);
  }, [playing, index, frames.length]);

  if (res.error) return <ErrorBox error={res.error} title="Could not load the replay" />;
  if (!res.data) return <Loading label="Loading replay" />;
  // Snapshot state must include hidden frames too, so compute it over `all` up to the selected frame.
  const selected = frames[index];
  const allIndex = selected ? all.findIndex((f) => f.key === selected.key) : -1;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs text-ink-faint">
            <Link to={`/incidents/${id}`} className="hover:text-ink">Incident {shortId(id ?? "")}</Link> / Decision Replay
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Decision Replay</h1>
          <p className="mt-1 text-sm text-ink-dim">Every step, rebuilt from the tamper-evident audit log and the provider event store.</p>
        </div>
        <OriginBadge origin={res.data.origin} />
      </div>

      {all.length === 0 ? (
        <p className="text-ink-dim">Nothing has happened yet.</p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3">
            <Button onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} aria-label="Previous step">
              ‹ Prev
            </Button>
            <Button tone="primary" onClick={() => (index >= frames.length - 1 ? (setIndex(0), setPlaying(true)) : setPlaying((p) => !p))}>
              {playing ? "Pause" : index >= frames.length - 1 ? "Replay from start" : "Play"}
            </Button>
            <Button onClick={() => setIndex((i) => Math.min(frames.length - 1, i + 1))} disabled={index >= frames.length - 1} aria-label="Next step">
              Next ›
            </Button>
            <input
              type="range"
              min={0}
              max={Math.max(frames.length - 1, 0)}
              value={index}
              onChange={(e) => (setPlaying(false), setIndex(Number(e.target.value)))}
              aria-label="Timeline position"
              className="min-w-40 flex-1 accent-[var(--color-accent)]"
            />
            <span className="text-sm tabular-nums text-ink-dim">
              {index + 1} / {frames.length}
            </span>
            <label className="flex items-center gap-2 text-sm text-ink-dim">
              <input type="checkbox" checked={everything} onChange={(e) => setEverything(e.target.checked)} />
              Show every event
            </label>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <ol className="max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-panel p-2" aria-label="Timeline">
              {frames.map((f, i) => (
                <li key={f.key}>
                  <button
                    type="button"
                    onClick={() => (setPlaying(false), setIndex(i))}
                    aria-current={i === index ? "step" : undefined}
                    className={cx(
                      "flex w-full gap-3 rounded-md px-3 py-2 text-left transition-colors",
                      i === index ? "bg-panel-2 ring-1 ring-accent/50" : i < index ? "opacity-90 hover:bg-panel-2/60" : "opacity-45 hover:bg-panel-2/60",
                    )}
                  >
                    <span aria-hidden className={cx("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", DOT[f.tone])} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{f.title}</span>
                      {f.detail && <span className="block text-xs text-ink-dim">{f.detail}</span>}
                      <span className="block text-[11px] text-ink-faint">
                        {formatTime(f.at)}
                        {f.actor ? ` · ${actorLabel(f.actor)}` : " · provider"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="min-w-0">{allIndex >= 0 && <Snapshot frames={all} index={allIndex} runs={res.data.agentRuns} />}</div>
          </div>
        </>
      )}
    </>
  );
}
