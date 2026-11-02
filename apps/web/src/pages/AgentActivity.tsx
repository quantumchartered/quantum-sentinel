import { Link } from "react-router";
import { Badge, Card, Empty, ErrorBox, Loading, OriginBadge, PageHeader, RecBadge } from "../components/ui";
import { useResource } from "../lib/api";
import { formatMicroUsd, formatTime, shortId } from "../lib/format";
import type { AgentActivity } from "../lib/types";

const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = {
  COMPLETED: "ok",
  REPORT_REJECTED: "danger",
  REFUSED: "warn",
  AI_UNAVAILABLE: "warn",
  LIMIT_EXCEEDED: "danger",
  NO_REPORT: "danger",
};

const sum = (xs: string[]) => xs.reduce((s, x) => s + BigInt(x), 0n).toString();

export function AgentActivityPage() {
  const res = useResource<AgentActivity>("/api/agent-runs?limit=100");
  const d = res.data;
  const totalRuns = d?.totals.reduce((s, t) => s + t.runs, 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Agent Activity"
        subtitle="Every investigator run: the read-only tools it called, what the grounding verifier found, tokens and cost. Measured from stored runs, nothing estimated."
      />
      <ErrorBox error={res.error} title="Could not load agent activity" />
      {!d && !res.error ? (
        <Loading label="Loading agent activity" />
      ) : d && d.runs.length === 0 ? (
        <Empty title="No investigator runs yet">Open an incident and choose "Run AI investigation", or start a scenario in the Scenario Lab.</Empty>
      ) : d ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Runs" value={String(totalRuns)} />
            <Stat label="Completed and verified" value={String(d.totals.find((t) => t.status === "COMPLETED")?.runs ?? 0)} />
            <Stat label="Tokens (in / out)" value={`${sum(d.totals.map((t) => t.inputTokens))} / ${sum(d.totals.map((t) => t.outputTokens))}`} />
            <Stat label="Model cost" value={formatMicroUsd(sum(d.totals.map((t) => t.costMicroUsd)))} />
          </div>
          {d.totals.some((t) => t.status !== "COMPLETED") && (
            <p className="text-sm text-ink-dim">
              Not completed:{" "}
              {d.totals
                .filter((t) => t.status !== "COMPLETED")
                .map((t) => `${t.runs} ${t.status.toLowerCase().replaceAll("_", " ")}`)
                .join(", ")}
              . A rejected or failed run never changes a decision: policy keeps running without it.
            </p>
          )}
          <ul className="space-y-3">
            {d.runs.map((r) => (
              <li key={r.id}>
                <Card
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <Link to={`/incidents/${r.incidentId}`} className="hover:underline">{r.incidentTitle ?? shortId(r.incidentId)}</Link>
                      <OriginBadge origin={r.origin} />
                      <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status.replaceAll("_", " ")}</Badge>
                    </span>
                  }
                  actions={<span className="text-xs text-ink-faint">{formatTime(r.finishedAt)}</span>}
                >
                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                      <dt className="text-ink-faint">Model</dt>
                      <dd className="min-w-0 break-words font-mono text-xs leading-5">{r.model}</dd>
                      <dt className="text-ink-faint">Policy said</dt>
                      <dd><RecBadge rec={r.policyRecommendation} /></dd>
                      <dt className="text-ink-faint">Agent said</dt>
                      <dd>{r.reportRecommendation ? <RecBadge rec={r.reportRecommendation} /> : <span className="text-ink-dim">no report</span>}</dd>
                      <dt className="text-ink-faint">Verifier</dt>
                      <dd>
                        {r.verification ? (
                          r.verification.ok ? (
                            <Badge tone="ok">Passed · {r.verification.warnings} warnings</Badge>
                          ) : (
                            <Badge tone="danger">{r.verification.errors} errors</Badge>
                          )
                        ) : (
                          <span className="text-ink-dim">not run</span>
                        )}
                      </dd>
                      <dt className="text-ink-faint">Steps</dt>
                      <dd className="tabular-nums">{r.steps}</dd>
                      <dt className="text-ink-faint">Tokens</dt>
                      <dd className="tabular-nums">{r.inputTokens} in / {r.outputTokens} out</dd>
                      <dt className="text-ink-faint">Cost</dt>
                      <dd className="tabular-nums">{formatMicroUsd(r.costMicroUsd)}</dd>
                    </dl>
                    <div className="min-w-0">
                      <p className="mb-1 text-xs uppercase tracking-wide text-ink-faint">Tool calls ({r.toolCalls.length})</p>
                      {r.toolCalls.length === 0 ? (
                        <p className="text-sm text-ink-dim">None.</p>
                      ) : (
                        <ol className="space-y-1 text-sm">
                          {r.toolCalls.map((t, i) => (
                            <li key={i} className="flex min-w-0 gap-2">
                              <span className="w-5 shrink-0 text-right tabular-nums text-ink-faint">{t.step}</span>
                              <span className={t.ok ? "font-mono text-xs leading-5 text-ink" : "font-mono text-xs leading-5 text-danger"}>{t.name}</span>
                              <span className="min-w-0 truncate text-ink-dim" title={t.summary}>{t.summary}</span>
                            </li>
                          ))}
                        </ol>
                      )}
                      {r.error && <p className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger">{r.error}</p>}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}
