import { Badge, ErrorBox, Loading, PageHeader } from "../components/ui";
import { useResource } from "../lib/api";
import { actorLabel, formatTime } from "../lib/format";
import type { AuditEntry, Overview } from "../lib/types";

export function AuditLog() {
  const log = useResource<AuditEntry[]>("/api/audit?limit=200");
  const verify = useResource<Overview["auditChain"]>("/api/audit/verify");
  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Append-only and hash-chained: each entry's hash covers the previous one, so any edit, deletion or reordering is detected."
        right={
          verify.data ? (
            verify.data.ok ? (
              <Badge tone="ok">Chain verified · {verify.data.entries} entries</Badge>
            ) : (
              <Badge tone="danger">Broken at entry {verify.data.brokenAtSeq}: {verify.data.reason}</Badge>
            )
          ) : (
            <Badge>Verifying…</Badge>
          )
        }
      />
      <ErrorBox error={log.error ?? verify.error} title="Could not load the audit log" />
      {!log.data && !log.error ? (
        <Loading />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-panel text-left text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">Event</th>
                <th className="px-3 py-2 font-medium">Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {log.data?.map((e) => (
                <tr key={e.seq} className="align-top hover:bg-panel/60">
                  <td className="px-3 py-2 tabular-nums text-ink-faint">{e.seq}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-dim">{formatTime(e.occurredAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-dim">{actorLabel(e.actor)}</td>
                  <td className="px-3 py-2">
                    <span className="font-medium text-ink">{e.eventType}</span>
                    <details className="mt-0.5">
                      <summary className="cursor-pointer text-xs text-ink-faint">payload</summary>
                      <pre className="mt-1 max-w-xl overflow-x-auto text-xs text-ink-dim">{JSON.stringify(e.payload, null, 2)}</pre>
                    </details>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-ink-faint" title={`prev ${e.prevHash}`}>
                    {e.hash.slice(0, 12)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
