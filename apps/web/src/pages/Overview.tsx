import { Link } from "react-router";
import { Badge, Card, Empty, ErrorBox, Loading, OriginBadge, PageHeader, RecBadge, StateBadge } from "../components/ui";
import { useResource } from "../lib/api";
import { formatMicroUsd, formatMoney, relativeTime } from "../lib/format";
import type { IncidentListItem, Overview } from "../lib/types";

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-dim">{hint}</p>}
    </div>
  );
}

export function OverviewPage() {
  const ov = useResource<Overview>("/api/overview");
  const list = useResource<IncidentListItem[]>("/api/incidents");
  const s = ov.data?.incidentsByState ?? {};
  const open = Object.entries(s)
    .filter(([k]) => k !== "RESOLVED" && k !== "ESCALATED")
    .reduce((n, [, v]) => n + (v ?? 0), 0);

  return (
    <>
      <PageHeader title="Overview" subtitle="Supplier payments that need attention, and what Sentinel has done about them." />
      <ErrorBox error={ov.error ?? list.error} title="Could not load the overview" />
      {!ov.data ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Open incidents" value={open} />
          <Stat label="Awaiting approval" value={s.AWAITING_APPROVAL ?? 0} />
          <Stat label="Escalated" value={s.ESCALATED ?? 0} hint="Handed to a person" />
          <Stat label="Unsafe actions blocked" value={ov.data.unsafeActionsBlocked} hint="Resends, stale approvals, bad tools" />
          <Stat
            label="AI investigations"
            value={ov.data.agentRuns.count}
            hint={ov.data.modes.investigator === "CLAUDE" ? `${formatMicroUsd(ov.data.agentRuns.costMicroUsd)} spent` : "Mock AI: no API cost"}
          />
        </div>
      )}

      {ov.data && (
        <div className="mt-3">
          {ov.data.auditChain.ok ? (
            <Badge tone="ok">Audit chain verified · {ov.data.auditChain.entries} entries</Badge>
          ) : (
            <Badge tone="danger">Audit chain broken at entry {ov.data.auditChain.brokenAtSeq}</Badge>
          )}
        </div>
      )}

      <div className="mt-8">
        <Card title="Recent incidents" actions={<Link className="text-sm text-accent hover:text-accent-strong" to="/incidents">All incidents</Link>}>
          {!list.data ? (
            <Loading />
          ) : list.data.length === 0 ? (
            <Empty title="No incidents yet">
              Start one from the <Link className="text-accent" to="/lab">Scenario Lab</Link> to see Sentinel investigate a stuck supplier payment.
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {list.data.slice(0, 6).map((i) => (
                <li key={i.id}>
                  <Link to={`/incidents/${i.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 hover:text-accent-strong">
                    <span className="min-w-0 flex-1 truncate font-medium">{i.title}</span>
                    <OriginBadge origin={i.origin} />
                    <StateBadge state={i.state} />
                    <RecBadge rec={i.recommendation} />
                    <span className="w-36 text-right tabular-nums text-ink-dim">{formatMoney(i.amountMinor, i.currency)}</span>
                    <span className="w-20 text-right text-xs text-ink-faint">{relativeTime(i.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
