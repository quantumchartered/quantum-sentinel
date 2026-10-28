import { Link } from "react-router";
import { Badge, Empty, ErrorBox, Loading, OriginBadge, PageHeader, RecBadge, StateBadge } from "../components/ui";
import { useResource } from "../lib/api";
import { formatMoney, relativeTime } from "../lib/format";
import type { IncidentListItem } from "../lib/types";

export function IncidentList() {
  const list = useResource<IncidentListItem[]>("/api/incidents");
  return (
    <>
      <PageHeader title="Incidents" subtitle="Each incident is one supplier invoice whose payment has a problem." />
      <ErrorBox error={list.error} title="Could not load incidents" />
      {!list.data && !list.error ? (
        <Loading />
      ) : list.data?.length === 0 ? (
        <Empty title="No incidents yet">
          Open the <Link className="text-accent" to="/lab">Scenario Lab</Link> to start a sandbox or mock scenario.
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-panel text-left text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-4 py-2 font-medium">Incident</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Recommendation</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.data?.map((i) => (
                <tr key={i.id} className="hover:bg-panel/60">
                  <td className="px-4 py-3">
                    <Link to={`/incidents/${i.id}`} className="font-medium text-ink hover:text-accent-strong">
                      {i.title}
                    </Link>
                    {i.riskFlags.length > 0 && (
                      <span className="ml-2">
                        <Badge tone="danger">Risk flagged</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3"><OriginBadge origin={i.origin} /></td>
                  <td className="px-4 py-3"><StateBadge state={i.state} /></td>
                  <td className="px-4 py-3"><RecBadge rec={i.recommendation} /></td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatMoney(i.amountMinor, i.currency)}</td>
                  <td className="px-4 py-3 text-right text-ink-faint">{relativeTime(i.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
