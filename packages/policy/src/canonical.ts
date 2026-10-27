import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted, bigint as a decimal string tagged so
 * it can never collide with a plain string, undefined fields dropped. Used for
 * everything we hash or sign (approvals, audit entries, evidence sets).
 */
export type Canonicalizable =
  | string
  | number
  | boolean
  | null
  | bigint
  | undefined
  | readonly Canonicalizable[]
  | { readonly [k: string]: Canonicalizable };

export function canonicalJson(value: Canonicalizable): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number cannot be canonicalized");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as { readonly [k: string]: Canonicalizable };
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  throw new TypeError(`cannot canonicalize ${typeof value}`);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Order-independent hash of a set of evidence items (id + content hash). */
export function evidenceSetHash(items: readonly { id: string; contentHash: string }[]): string {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256Hex(canonicalJson(sorted.map((i) => [i.id, i.contentHash])));
}
