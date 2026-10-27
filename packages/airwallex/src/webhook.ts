import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { type RawTransfer, TransferSchema } from "./schemas.js";

/**
 * Airwallex webhook verification (official docs, "Listen for webhook events"):
 * x-signature = hex(HMAC-SHA256(secret, x-timestamp + raw body)), x-timestamp
 * in Unix milliseconds. Verify BEFORE parsing JSON, over the exact raw bytes.
 */

export type VerifyResult =
  | { ok: true; timestampMs: number }
  | { ok: false; reason: "missing_header" | "bad_timestamp" | "stale" | "future" | "bad_signature" };

export interface VerifyInput {
  secret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: Buffer | string;
  nowMs: number;
  /**
   * How old a delivery may be. Airwallex retries for ~3 days and the docs do not
   * say whether x-timestamp is renewed on retry, so the default accepts that
   * window; event-id deduplication is what stops replays from being applied twice.
   */
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
}

export function signWebhook(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return createHmac("sha256", secret).update(timestamp).update(rawBody).digest("hex");
}

export function verifyWebhookSignature(input: VerifyInput): VerifyResult {
  const { timestampHeader: ts, signatureHeader: sig } = input;
  if (!ts || !sig || !input.secret) return { ok: false, reason: "missing_header" };
  if (!/^\d{10,16}$/.test(ts)) return { ok: false, reason: "bad_timestamp" };

  const expected = Buffer.from(signWebhook(input.secret, ts, input.rawBody), "hex");
  const given = /^[0-9a-f]+$/i.test(sig) ? Buffer.from(sig, "hex") : Buffer.alloc(0);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  const timestampMs = Number(ts);
  const maxAge = input.maxAgeMs ?? 73 * 60 * 60_000;
  const maxFuture = input.maxFutureSkewMs ?? 5 * 60_000;
  if (input.nowMs - timestampMs > maxAge) return { ok: false, reason: "stale" };
  if (timestampMs - input.nowMs > maxFuture) return { ok: false, reason: "future" };
  return { ok: true, timestampMs };
}

const EnvelopeSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  account_id: z.string().optional(),
  created_at: z.string().optional(),
  version: z.string().optional(),
  data: z.unknown(),
});

export interface ParsedWebhookEvent {
  eventId: string;
  name: string;
  accountId: string | null;
  createdAt: string | null;
  /** API schema version of the payload, NOT an ordering sequence. */
  apiVersion: string | null;
  /** Present for payout.transfer.* events. */
  transfer: RawTransfer | null;
}

/**
 * Parse an already-verified body. The Payouts webhook reference puts the
 * transfer directly in `data`; the generic envelope page describes
 * `data.object`. Both are accepted; anything else for a payout.transfer.*
 * event is a contract error.
 */
export function parseWebhookEvent(rawBody: Buffer | string): ParsedWebhookEvent {
  const json: unknown = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  const env = EnvelopeSchema.parse(json);
  let transfer: RawTransfer | null = null;
  if (env.name.startsWith("payout.transfer.") && !env.name.startsWith("payout.transfer.funding.")) {
    const data = env.data as Record<string, unknown> | null | undefined;
    const candidate = data && typeof data === "object" && "object" in data ? data.object : data;
    transfer = TransferSchema.parse(candidate);
  }
  return {
    eventId: env.id,
    name: env.name,
    accountId: env.account_id ?? null,
    createdAt: env.created_at ?? null,
    apiVersion: env.version ?? null,
    transfer,
  };
}
