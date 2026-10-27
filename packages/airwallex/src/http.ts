import {
  AirwallexApiError,
  AirwallexConfigError,
  AirwallexContractError,
  AirwallexUncertainOutcomeError,
} from "./errors.js";
import { LoginResponseSchema } from "./schemas.js";
import type { z } from "zod";

/** The only host this adapter will ever talk to. Production is unreachable by construction. */
export const SANDBOX_BASE_URL = "https://api.sandbox.airwallex.com";

/**
 * How a request may be retried:
 * - `read`: idempotent GET; retry on network errors, 429 and 5xx.
 * - `keyed`: mutation carrying a provider-deduplicated `request_id`; retry with
 *   the identical body (Airwallex deduplicates for 7 days).
 * - `unkeyed`: mutation without a documented dedup key; never retried. Any
 *   ambiguous failure surfaces as AirwallexUncertainOutcomeError.
 */
export type RetryClass = "read" | "keyed" | "unkeyed";

export interface AirwallexHttpOptions {
  clientId: string;
  apiKey: string;
  baseUrl?: string;
  /** Sent as `x-api-version` when set. */
  apiVersion?: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Refresh the token this long before `expires_at`. */
  refreshSkewMs?: number;
  timeoutMs?: number;
}

export interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  retry: RetryClass;
  query?: Record<string, string | undefined>;
  /** Pre-serialized JSON body; serialized once so retries send identical bytes. */
  body?: string;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class AirwallexHttp {
  readonly baseUrl: string;
  private readonly opts: Required<Omit<AirwallexHttpOptions, "apiVersion" | "baseUrl">> & {
    apiVersion: string | undefined;
  };
  private token: { value: string; expiresAtMs: number } | undefined;
  private inflightLogin: Promise<string> | undefined;

  constructor(options: AirwallexHttpOptions) {
    const baseUrl = (options.baseUrl ?? SANDBOX_BASE_URL).replace(/\/+$/, "");
    if (baseUrl !== SANDBOX_BASE_URL) {
      throw new AirwallexConfigError(`Refusing non-sandbox Airwallex base URL: ${baseUrl}`);
    }
    if (!options.clientId || !options.apiKey) {
      throw new AirwallexConfigError("AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY are required");
    }
    this.baseUrl = baseUrl;
    this.opts = {
      clientId: options.clientId,
      apiKey: options.apiKey,
      apiVersion: options.apiVersion,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      now: options.now ?? Date.now,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      maxAttempts: options.maxAttempts ?? 3,
      refreshSkewMs: options.refreshSkewMs ?? 5 * 60_000,
      timeoutMs: options.timeoutMs ?? 20_000,
    };
  }

  /** Cached bearer token; concurrent callers share a single login. */
  async getToken(): Promise<string> {
    const t = this.token;
    if (t && this.opts.now() < t.expiresAtMs - this.opts.refreshSkewMs) return t.value;
    this.inflightLogin ??= this.login().finally(() => {
      this.inflightLogin = undefined;
    });
    return this.inflightLogin;
  }

  invalidateToken(): void {
    this.token = undefined;
  }

  private async login(): Promise<string> {
    const path = "/api/v1/authentication/login";
    const res = await this.withRetries("read", path, () =>
      this.send(path, {
        method: "POST",
        headers: { "x-client-id": this.opts.clientId, "x-api-key": this.opts.apiKey },
      }),
    );
    const body = LoginResponseSchema.safeParse(res.json);
    if (!body.success) throw new AirwallexContractError(path, body.error.issues);
    const expiresAtMs = Date.parse(body.data.expires_at);
    if (Number.isNaN(expiresAtMs)) throw new AirwallexContractError(path, "unparseable expires_at");
    this.token = { value: body.data.token, expiresAtMs };
    return body.data.token;
  }

  async request<T extends z.ZodType>(schema: T, req: RequestOptions): Promise<z.infer<T>> {
    const { json } = await this.requestRaw(req);
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new AirwallexContractError(req.path, parsed.error.issues);
    return parsed.data;
  }

  async requestRaw(req: RequestOptions): Promise<{ status: number; json: unknown; text: string }> {
    const url = new URL(this.baseUrl + req.path);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const target = url.pathname + url.search;

    let reauthed = false;
    for (;;) {
      const token = await this.getToken();
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (this.opts.apiVersion) headers["x-api-version"] = this.opts.apiVersion;
      if (req.body !== undefined) headers["content-type"] = "application/json";
      try {
        return await this.withRetries(req.retry, req.path, () =>
          this.send(target, {
            method: req.method,
            headers,
            ...(req.body !== undefined ? { body: req.body } : {}),
          }),
        );
      } catch (err) {
        // An expired/revoked token is rejected before any side effect, so one re-login is safe.
        if (!reauthed && err instanceof AirwallexApiError && err.status === 401) {
          reauthed = true;
          this.invalidateToken();
          continue;
        }
        throw err;
      }
    }
  }

  private async withRetries(
    retry: RetryClass,
    path: string,
    attempt: () => Promise<{ status: number; json: unknown; text: string }>,
  ): Promise<{ status: number; json: unknown; text: string }> {
    const max = retry === "unkeyed" ? 1 : this.opts.maxAttempts;
    let lastErr: unknown;
    for (let i = 0; i < max; i++) {
      if (i > 0) await this.opts.sleep(Math.min(4_000, 250 * 2 ** (i - 1)));
      try {
        const res = await attempt();
        if (res.status >= 200 && res.status < 300) return res;
        const apiErr = new AirwallexApiError(res.status, res.json, path);
        if (!RETRYABLE_STATUS.has(res.status)) throw apiErr;
        lastErr = apiErr;
      } catch (err) {
        if (err instanceof AirwallexApiError && !RETRYABLE_STATUS.has(err.status)) throw err;
        lastErr = err;
      }
    }
    // Retries exhausted (or not allowed). For a mutation a 5xx/network error is ambiguous.
    const definitelyRejected =
      lastErr instanceof AirwallexApiError && lastErr.status === 429;
    if (retry !== "read" && !definitelyRejected) throw new AirwallexUncertainOutcomeError(path, lastErr);
    throw lastErr;
  }

  private async send(
    target: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; json: unknown; text: string }> {
    const res = await this.opts.fetch(this.baseUrl + target, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    const text = await res.text();
    let json: unknown = undefined;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: res.status, json, text };
  }
}
