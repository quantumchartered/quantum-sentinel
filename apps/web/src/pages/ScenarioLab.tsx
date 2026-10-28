import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Badge, Button, Card, ErrorBox, KV, Loading, PageHeader, RecBadge, StateBadge } from "../components/ui";
import { api, useAction, useResource } from "../lib/api";
import { relativeTime } from "../lib/format";
import type { IncidentListItem, Me } from "../lib/types";

interface LabInfo {
  scenarios: Record<"A" | "B" | "C", { title: string; summary: string }>;
  modes: { MOCK: boolean; SANDBOX: boolean };
}

const STEPS: Record<"A" | "B" | "C", string[]> = {
  A: [
    "Starts with the original SENT and a supplier chaser: policy says WAIT.",
    "Try “Resend anyway”: policy blocks it and explains why.",
    "Inject “Original fails: bank return”, then re-evaluate: REPLACE.",
    "Run the investigator; it proposes. Approve in the Approval Center.",
    "Inject “Replacement reaches PAID”, then check and resolve.",
  ],
  B: [
    "Starts with the original already failed: policy says REPLACE.",
    "Propose the replacement, then fire the race below.",
    "Ten approvers and ten executors race; exactly one transfer is sent.",
  ],
  C: [
    "Starts with a failed original and an email asking to pay a new account.",
    "Code flags it before any AI reads it: ESCALATE, payment blocked.",
    "Run the investigator: it cites the email as a risk, and cannot override.",
  ],
};

function RaceRunner({ incidents }: { incidents: IncidentListItem[] }) {
  const ready = incidents.filter((i) => i.origin === "MOCK_SCENARIO" && i.state === "AWAITING_APPROVAL");
  const [target, setTarget] = useState("");
  const race = useAction(
    useCallback(
      (id: string) =>
        api<{ approvalAttempts: number; approvalsGranted: number; executionAttempts: number; executionsThatSent: number; providerTransfersCreated: number; replacementPayments: number }>(
          `/api/lab/incidents/${id}/race`,
          { method: "POST", body: { approvers: 10, executors: 10 } },
        ),
      [],
    ),
  );
  const chosen = target || ready[0]?.id || "";
  return (
    <Card title={<span className="flex items-center gap-2">Race test (Scenario B) <Badge tone="mock">Simulated</Badge></span>}>
      {ready.length === 0 ? (
        <p className="text-sm text-ink-dim">Needs a mock incident awaiting approval. Start Scenario B and propose the replacement first.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm text-ink-dim">
              Incident
              <select value={chosen} onChange={(e) => setTarget(e.target.value)} className="mt-1 block rounded-md border border-line-strong bg-bg px-2 py-1.5 text-sm text-ink">
                {ready.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title}
                  </option>
                ))}
              </select>
            </label>
            <Button tone="primary" onClick={() => race.run(chosen)} disabled={race.pending || !chosen}>
              {race.pending ? "Racing…" : "Fire 10 approvals + 10 executors at once"}
            </Button>
          </div>
          {race.result && (
            <div className="mt-4">
              <KV
                items={[
                  ["Approval attempts", race.result.approvalAttempts],
                  ["Approvals granted", <span className="font-semibold text-ok">{race.result.approvalsGranted}</span>],
                  ["Execution attempts", race.result.executionAttempts],
                  ["Transfers sent to the provider", <span className="font-semibold text-ok">{race.result.providerTransfersCreated}</span>],
                  ["Replacement payments in the books", race.result.replacementPayments],
                ]}
              />
            </div>
          )}
        </>
      )}
      <div className="mt-2">
        <ErrorBox error={race.error} title="Race refused" />
      </div>
    </Card>
  );
}

export function ScenarioLab({ me }: { me: Me }) {
  const info = useResource<LabInfo>("/api/lab/scenarios");
  const list = useResource<IncidentListItem[]>("/api/incidents");
  const navigate = useNavigate();
  const canRun = me.role === "OWNER" || me.role === "OPERATOR";
  const start = useAction(useCallback((scenario: string) => api<{ incidentId: string }>("/api/lab/scenarios", { method: "POST", body: { scenario, mode: "MOCK" } }), []));
  const labIncidents = (list.data ?? []).filter((i) => i.origin !== "SANDBOX");

  return (
    <>
      <PageHeader
        title="Scenario Lab"
        subtitle="Run the demo scenarios end to end. Mock mode simulates Airwallex inside Sentinel; nothing leaves this machine."
        right={
          <div className="flex gap-2">
            <Badge tone="mock">Mock mode: available</Badge>
            <Badge title="Needs Airwallex sandbox keys in .env">Sandbox mode: needs keys</Badge>
          </div>
        }
      />
      <ErrorBox error={info.error ?? start.error} title="Scenario Lab" />
      {!info.data ? (
        <Loading />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {(["A", "B", "C"] as const).map((k) => (
            <Card key={k} title={`${k} · ${info.data!.scenarios[k].title}`}>
              <p className="text-sm text-ink-dim">{info.data!.scenarios[k].summary}</p>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink">
                {STEPS[k].map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <Button
                tone="primary"
                className="mt-4"
                disabled={!canRun || start.pending}
                onClick={async () => {
                  const r = await start.run(k);
                  if (r) navigate(`/incidents/${r.incidentId}`);
                }}
                title={canRun ? undefined : "Operators and owners can start scenarios"}
              >
                Start in mock mode
              </Button>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <RaceRunner incidents={list.data ?? []} />
        <Card title="Lab incidents">
          {labIncidents.length === 0 ? (
            <p className="text-sm text-ink-dim">None yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {labIncidents.slice(0, 8).map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
                  <Link to={`/incidents/${i.id}`} className="min-w-0 flex-1 truncate text-sm text-ink hover:text-accent-strong">
                    {i.title}
                  </Link>
                  <StateBadge state={i.state} />
                  <RecBadge rec={i.recommendation} />
                  <span className="text-xs text-ink-faint">{relativeTime(i.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
