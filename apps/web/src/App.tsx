import * as Tooltip from "@radix-ui/react-tooltip";
import { useEffect, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router";
import { Badge, Button, cx } from "./components/ui";
import { getToken, setToken, useResource } from "./lib/api";
import type { Me, Overview } from "./lib/types";
import { ApprovalCenter } from "./pages/ApprovalCenter";
import { AuditLog } from "./pages/AuditLog";
import { DecisionReplay } from "./pages/DecisionReplay";
import { IncidentList } from "./pages/IncidentList";
import { IncidentWorkspace } from "./pages/IncidentWorkspace";
import { OverviewPage } from "./pages/Overview";
import { ScenarioLab } from "./pages/ScenarioLab";
import { SignIn } from "./pages/SignIn";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/incidents", label: "Incidents" },
  { to: "/approvals", label: "Approval Center" },
  { to: "/lab", label: "Scenario Lab" },
  { to: "/audit", label: "Audit log" },
];

function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const overview = useResource<Overview>("/api/overview");
  const modes = overview.data?.modes;
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="border-b border-line bg-panel md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center justify-between px-4 py-4 md:block">
          <div>
            <p className="text-sm font-semibold tracking-wide text-ink">Quantum Sentinel</p>
            <p className="text-xs text-ink-faint">Payment operations</p>
          </div>
          <Button tone="ghost" className="md:hidden" aria-expanded={menuOpen} aria-controls="nav" onClick={() => setMenuOpen((o) => !o)}>
            Menu
          </Button>
        </div>
        <nav id="nav" aria-label="Main" className={cx("px-2 pb-3 md:block", menuOpen ? "block" : "hidden")}>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end ?? false}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                cx("block rounded-md px-3 py-2 text-sm transition-colors", isActive ? "bg-panel-2 text-ink" : "text-ink-dim hover:bg-panel-2/60 hover:text-ink")
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 md:px-8">
          <div className="flex flex-wrap items-center gap-2" aria-label="Environment">
            {modes ? (
              <>
                <Badge tone={modes.airwallex === "SANDBOX" ? "accent" : "mock"} title="Airwallex connection">
                  {modes.airwallex === "SANDBOX" ? "Airwallex sandbox" : "Airwallex not connected: mock only"}
                </Badge>
                <Badge tone={modes.investigator === "CLAUDE" ? "accent" : "mock"} title={`Investigator model: ${modes.investigatorModel}`}>
                  {modes.investigator === "CLAUDE" ? `Claude: ${modes.investigatorModel}` : "Mock AI (no API key)"}
                </Badge>
                <Badge>Sandbox only: no real money</Badge>
              </>
            ) : (
              <span className="text-xs text-ink-faint">Checking environment…</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-ink-dim">
              {me.displayName} <span className="text-ink-faint">· {me.role.toLowerCase()}</span>
            </span>
            <Button tone="ghost" onClick={onSignOut}>
              Sign out
            </Button>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 md:px-8">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/incidents" element={<IncidentList />} />
            <Route path="/incidents/:id" element={<IncidentWorkspace me={me} />} />
            <Route path="/incidents/:id/replay" element={<DecisionReplay />} />
            <Route path="/approvals" element={<ApprovalCenter me={me} />} />
            <Route path="/lab" element={<ScenarioLab me={me} />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="*" element={<p className="text-ink-dim">Page not found.</p>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Authed({ onSignOut }: { onSignOut: () => void }) {
  const me = useResource<Me>("/api/me");
  if (me.error) return <SignIn error={me.error} onSignedIn={() => void me.reload()} />;
  if (!me.data) return <p className="p-8 text-ink-dim">Signing in…</p>;
  return <Shell me={me.data} onSignOut={onSignOut} />;
}

export function App() {
  const [token, setTok] = useState<string | null>(getToken());
  useEffect(() => {
    const out = () => {
      setToken(null);
      setTok(null);
    };
    window.addEventListener("sentinel:signed-out", out);
    return () => window.removeEventListener("sentinel:signed-out", out);
  }, []);

  return (
    <Tooltip.Provider>
      <BrowserRouter>
        {token ? (
          <Authed
            onSignOut={() => {
              setToken(null);
              setTok(null);
            }}
          />
        ) : (
          <SignIn onSignedIn={() => setTok(getToken())} />
        )}
      </BrowserRouter>
    </Tooltip.Provider>
  );
}
