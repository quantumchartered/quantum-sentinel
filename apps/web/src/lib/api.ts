import { useCallback, useEffect, useRef, useState } from "react";

/** Sign-in token lives in sessionStorage only: closing the tab signs you out. */
const TOKEN_KEY = "sentinel.token";

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: stay signed out */
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly reasons: string[];
  constructor(status: number, message: string, reasons: string[]) {
    super(message);
    this.status = status;
    this.reasons = reasons;
  }
}

export async function api<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, `Unexpected response from the API (${res.status})`, []);
    }
  }
  if (!res.ok) {
    const j = (json ?? {}) as { error?: string; reasons?: string[] };
    if (res.status === 401) window.dispatchEvent(new Event("sentinel:signed-out"));
    throw new ApiError(res.status, j.error ?? `Request failed (${res.status})`, j.reasons ?? []);
  }
  return json as T;
}

/** Fires after any successful mutation so every visible screen re-reads its data. */
const REFRESH = "sentinel:refresh";
export const announceChange = () => window.dispatchEvent(new Event(REFRESH));

export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e as Error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
    const onRefresh = () => void load();
    window.addEventListener(REFRESH, onRefresh);
    return () => window.removeEventListener(REFRESH, onRefresh);
  }, [load]);

  return { data, error, loading, reload: load };
}

/** A mutation with pending / result / error state. Announces a change on success. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [result, setResult] = useState<R | null>(null);
  const run = useCallback(
    async (...args: A) => {
      setPending(true);
      setError(null);
      try {
        const r = await fn(...args);
        setResult(r);
        announceChange();
        return r;
      } catch (e) {
        setError(e as Error);
        return null;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  return { run, pending, error, result, reset: () => (setError(null), setResult(null)) };
}
