import { type Canonicalizable, canonicalJson, sha256Hex } from "./canonical.js";

/**
 * Tamper-evident audit log: each entry's hash covers its content and the
 * previous entry's hash. Editing, deleting or reordering any entry breaks
 * every later hash. (It cannot detect truncation of the newest entries on its
 * own; exported checkpoints cover that, see SECURITY notes.)
 */

export const GENESIS_HASH = "0".repeat(64);

export interface AuditContent {
  organizationId: string;
  seq: number;
  occurredAt: string;
  actor: string;
  eventType: string;
  payload: Canonicalizable;
}

export interface AuditEntry extends AuditContent {
  prevHash: string;
  hash: string;
}

export function hashAuditEntry(prevHash: string, content: AuditContent): string {
  return sha256Hex(`${prevHash}\n${canonicalJson({ ...content })}`);
}

export function nextAuditEntry(prev: AuditEntry | null, content: Omit<AuditContent, "seq">): AuditEntry {
  const seq = prev ? prev.seq + 1 : 1;
  const prevHash = prev ? prev.hash : GENESIS_HASH;
  const full: AuditContent = { ...content, seq };
  return { ...full, prevHash, hash: hashAuditEntry(prevHash, full) };
}

export type ChainCheck = { ok: true; entries: number; head: string } | { ok: false; brokenAtSeq: number; reason: string };

/** Entries must be one organization's chain, in seq order. */
export function verifyAuditChain(entries: readonly AuditEntry[]): ChainCheck {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i + 1) return { ok: false, brokenAtSeq: e.seq, reason: `expected seq ${i + 1}` };
    if (e.prevHash !== prevHash) return { ok: false, brokenAtSeq: e.seq, reason: "prev_hash mismatch" };
    const { prevHash: _p, hash, ...content } = e;
    if (hashAuditEntry(prevHash, content) !== hash) return { ok: false, brokenAtSeq: e.seq, reason: "content hash mismatch" };
    prevHash = hash;
  }
  return { ok: true, entries: entries.length, head: prevHash };
}
