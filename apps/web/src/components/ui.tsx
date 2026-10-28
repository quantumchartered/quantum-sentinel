import * as Tooltip from "@radix-ui/react-tooltip";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ApiError } from "../lib/api";
import { explainReason, STATE_TEXT } from "../lib/reasons";
import type { Origin, Recommendation } from "../lib/types";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "mock";
const TONES: Record<Tone, string> = {
  neutral: "border-line-strong text-ink-dim bg-panel-2",
  accent: "border-accent/40 text-accent-strong bg-accent/10",
  ok: "border-ok/40 text-ok bg-ok/10",
  warn: "border-warn/40 text-warn bg-warn/10",
  danger: "border-danger/40 text-danger bg-danger/10",
  mock: "border-mock/40 text-mock bg-mock/10",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase whitespace-nowrap", TONES[tone])}>
      {children}
    </span>
  );
}

export function OriginBadge({ origin }: { origin: Origin }) {
  if (origin === "MOCK_SCENARIO") return <Badge tone="mock" title="Simulated: Scenario Lab against Sentinel's in-memory MOCK provider. No Airwallex calls.">Mock scenario</Badge>;
  if (origin === "SANDBOX_SCENARIO") return <Badge tone="accent" title="Scenario Lab run against the Airwallex sandbox (simulated funds).">Sandbox scenario</Badge>;
  return <Badge tone="accent" title="Airwallex sandbox: test account, simulated funds.">Sandbox</Badge>;
}

export function RecBadge({ rec }: { rec: Recommendation | null }) {
  if (!rec) return <Badge>No decision</Badge>;
  return <Badge tone={rec === "WAIT" ? "warn" : rec === "REPLACE" ? "accent" : "danger"}>{rec}</Badge>;
}

export function StateBadge({ state }: { state: string }) {
  const tone: Tone = state === "RESOLVED" ? "ok" : state === "ESCALATED" ? "danger" : state === "AWAITING_APPROVAL" ? "accent" : "neutral";
  return <Badge tone={tone}>{STATE_TEXT[state] ?? state}</Badge>;
}

export function Button({ tone = "default", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" | "danger" | "ghost" }) {
  const styles = {
    default: "border-line-strong bg-panel-2 text-ink hover:border-ink-faint",
    primary: "border-accent bg-accent text-[#0b1220] hover:bg-accent-strong",
    danger: "border-danger/60 bg-danger/10 text-danger hover:bg-danger/20",
    ghost: "border-transparent bg-transparent text-ink-dim hover:text-ink",
  }[tone];
  return (
    <button
      {...props}
      className={cx("inline-flex items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50", styles, className)}
    />
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-line bg-panel", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold tracking-wide text-ink">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, right }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-dim">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function ErrorBox({ error, title = "Something went wrong" }: { error: Error | null; title?: string }) {
  if (!error) return null;
  const reasons = error instanceof ApiError ? error.reasons : [];
  return (
    <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      <p className="font-medium">{title}: {error.message}</p>
      {reasons.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-danger/90">
          {reasons.map((r) => (
            <li key={r}>{explainReason(r)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mt-2 text-sm text-ink-dim">{children}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-md bg-panel-2" />
      ))}
    </div>
  );
}

/** Evidence ID chip with the label the verifier checked. */
export function EvidenceChip({ id, note }: { id: string; note?: string }) {
  const kind = id.split(":")[0];
  const tone: Tone = kind === "obs" ? "accent" : kind === "ev" ? "warn" : "neutral";
  return (
    <Tooltip.Root delayDuration={150}>
      <Tooltip.Trigger asChild>
        <span tabIndex={0} className={cx("inline-flex cursor-default items-center rounded border px-1.5 py-px font-mono text-[11px]", TONES[tone])}>
          {id.length > 18 ? `${id.slice(0, 14)}…` : id}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={4} className="z-50 max-w-xs rounded-md border border-line-strong bg-panel-2 px-2 py-1 text-xs text-ink shadow-lg">
          <span className="font-mono">{id}</span>
          {note && <span className="block text-ink-dim">{note}</span>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-faint">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
