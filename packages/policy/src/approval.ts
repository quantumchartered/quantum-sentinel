import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./canonical.js";

/**
 * Bound approvals (AGENTS.md §6.4). The signature covers exactly what the
 * approver saw. Any change to a bound field, expiry, or a reused approval
 * makes verification fail. Pure code; the secret is passed in.
 */

export const APPROVAL_TTL_MS = 15 * 60_000;

export interface ApprovalBinding {
  organizationId: string;
  incidentId: string;
  incidentVersion: number;
  actionType: "REPLACE";
  amountMinor: bigint;
  currency: string;
  beneficiaryId: string;
  /** Hash of the normalized beneficiary bank details the approver saw. */
  beneficiaryHash: string;
  originalPaymentId: string;
  /** Provider transfer status-history version of the original at approval time. */
  providerStateVersion: number;
  evidenceSetHash: string;
  policyVersion: string;
  approverId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SignedApproval {
  binding: ApprovalBinding;
  keyVersion: string;
  signature: string;
}

function mac(secret: string, binding: ApprovalBinding): string {
  return createHmac("sha256", secret)
    .update(canonicalJson({ ...binding }))
    .digest("hex");
}

export function signApproval(secret: string, keyVersion: string, binding: ApprovalBinding): SignedApproval {
  if (secret.length < 32) throw new Error("approval HMAC secret must be at least 32 characters");
  if (binding.expiresAt <= binding.issuedAt) throw new Error("approval must expire after it is issued");
  return { binding, keyVersion, signature: mac(secret, binding) };
}

/** The state the executor sees right before dispatch. Every field must equal the binding. */
export type CurrentFacts = Omit<ApprovalBinding, "approverId" | "nonce" | "issuedAt" | "expiresAt">;

export type ApprovalCheck = { ok: true } | { ok: false; reasons: string[] };

export function verifyApproval(
  secrets: Readonly<Record<string, string>>,
  approval: SignedApproval,
  current: CurrentFacts,
  nowMs: number,
): ApprovalCheck {
  const reasons: string[] = [];
  const secret = secrets[approval.keyVersion];
  if (!secret) {
    reasons.push("unknown_key_version");
  } else {
    const expected = Buffer.from(mac(secret, approval.binding), "hex");
    const given = /^[0-9a-f]{64}$/.test(approval.signature) ? Buffer.from(approval.signature, "hex") : Buffer.alloc(0);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) reasons.push("bad_signature");
  }
  if (nowMs >= approval.binding.expiresAt) reasons.push("expired");
  if (nowMs < approval.binding.issuedAt) reasons.push("not_yet_valid");
  for (const key of Object.keys(current) as (keyof CurrentFacts)[]) {
    if (current[key] !== approval.binding[key]) reasons.push(`changed:${key}`);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
