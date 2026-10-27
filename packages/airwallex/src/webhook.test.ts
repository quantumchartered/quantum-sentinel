import { describe, expect, it } from "vitest";
import { parseWebhookEvent, signWebhook, verifyWebhookSignature } from "./webhook.js";

const secret = "whsec_test";
const now = Date.parse("2026-10-27T12:00:00Z");
const body = JSON.stringify({
  id: "evt-1",
  name: "payout.transfer.failed",
  account_id: "acct_x",
  created_at: "2026-10-27T11:59:59+0000",
  version: "2026-08-21",
  data: {
    id: "t-1",
    request_id: "req-original-0001",
    status: "FAILED",
    transfer_amount: 25000,
    transfer_currency: "USD",
    failure: { message: "Returned", details: { type: "BENEFICIARY_BANK_RETURNED" } },
  },
});
const ts = String(now - 1000);
const sig = signWebhook(secret, ts, body);
const verify = (over: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) =>
  verifyWebhookSignature({ secret, timestampHeader: ts, signatureHeader: sig, rawBody: body, nowMs: now, ...over });

describe("verifyWebhookSignature", () => {
  it("accepts a correct signature over timestamp + raw body", () => {
    expect(verify()).toEqual({ ok: true, timestampMs: now - 1000 });
    expect(verify({ rawBody: Buffer.from(body) })).toMatchObject({ ok: true });
    expect(verify({ signatureHeader: sig.toUpperCase() })).toMatchObject({ ok: true });
  });

  it("rejects a tampered body, even a whitespace change", () => {
    expect(verify({ rawBody: body.replace("25000", "25001") })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify({ rawBody: JSON.stringify(JSON.parse(body), null, 1) })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered timestamp, wrong secret, and junk signatures", () => {
    expect(verify({ timestampHeader: String(now) })).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verify({ secret: "other" })).toMatchObject({ reason: "bad_signature" });
    expect(verify({ signatureHeader: "zz" })).toMatchObject({ reason: "bad_signature" });
    expect(verify({ signatureHeader: sig.slice(0, 10) })).toMatchObject({ reason: "bad_signature" });
  });

  it("rejects missing headers and malformed timestamps", () => {
    expect(verify({ signatureHeader: undefined })).toMatchObject({ reason: "missing_header" });
    expect(verify({ timestampHeader: undefined })).toMatchObject({ reason: "missing_header" });
    expect(verify({ timestampHeader: "2026-10-27" })).toMatchObject({ reason: "bad_timestamp" });
  });

  it("enforces age and future-skew windows after the signature check", () => {
    const old = String(now - 74 * 3600_000);
    expect(verify({ timestampHeader: old, signatureHeader: signWebhook(secret, old, body) })).toMatchObject({ reason: "stale" });
    const fut = String(now + 10 * 60_000);
    expect(verify({ timestampHeader: fut, signatureHeader: signWebhook(secret, fut, body) })).toMatchObject({ reason: "future" });
  });
});

describe("parseWebhookEvent", () => {
  it("extracts the envelope and the transfer from `data`", () => {
    const e = parseWebhookEvent(body);
    expect(e).toMatchObject({ eventId: "evt-1", name: "payout.transfer.failed", apiVersion: "2026-08-21" });
    expect(e.transfer?.failure?.details?.type).toBe("BENEFICIARY_BANK_RETURNED");
  });

  it("also accepts the generic `data.object` envelope", () => {
    const wrapped = JSON.parse(body);
    wrapped.data = { object: wrapped.data };
    expect(parseWebhookEvent(JSON.stringify(wrapped)).transfer?.id).toBe("t-1");
  });

  it("ignores data for non-transfer events", () => {
    expect(parseWebhookEvent(JSON.stringify({ id: "e", name: "balance.ga.top_up", data: { x: 1 } })).transfer).toBeNull();
  });

  it("fails closed on a transfer event without a valid transfer", () => {
    expect(() => parseWebhookEvent(JSON.stringify({ id: "e", name: "payout.transfer.paid", data: { id: "x" } }))).toThrow();
    expect(() => parseWebhookEvent("not json")).toThrow();
  });
});
