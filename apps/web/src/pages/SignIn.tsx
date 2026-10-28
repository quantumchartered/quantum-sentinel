import { type FormEvent, useState } from "react";
import { Button, ErrorBox } from "../components/ui";
import { api, setToken } from "../lib/api";
import type { Me } from "../lib/types";

export function SignIn({ onSignedIn, error: initialError }: { onSignedIn: () => void; error?: Error }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<Error | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setToken(value.trim());
    try {
      await api<Me>("/api/me");
      onSignedIn();
    } catch (err) {
      setToken(null);
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <form onSubmit={submit} className="w-full max-w-md rounded-lg border border-line bg-panel p-6">
        <p className="text-sm font-semibold tracking-wide text-ink">Quantum Sentinel</p>
        <h1 className="mt-1 text-xl font-semibold text-ink">Sign in to the operator console</h1>
        <p className="mt-2 text-sm text-ink-dim">
          Paste a sign-in token created by <code className="font-mono text-ink">pnpm seed:demo</code>. Your role (owner, operator, approver or viewer) decides
          what you can do. Sandbox only: no real money moves.
        </p>
        <label htmlFor="token" className="mt-5 block text-sm font-medium text-ink">
          Sign-in token
        </label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="sst_…"
          className="mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-faint"
        />
        <div className="mt-4">
          <ErrorBox error={error} title="Could not sign in" />
        </div>
        <Button tone="primary" type="submit" className="mt-4 w-full" disabled={busy || value.trim().length < 10}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="mt-3 text-xs text-ink-faint">The token stays in this browser tab only and is cleared when you close it.</p>
      </form>
    </div>
  );
}
