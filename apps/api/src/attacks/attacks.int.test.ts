import { type Db, createTestDb } from "@sentinel/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTACKS, type AttackResult, createAttackContext, runAttackSuite } from "./suite.js";

let db: Db;
let drop: () => Promise<void>;
let results: AttackResult[] = [];

beforeAll(async () => {
  const t = await createTestDb();
  ({ db, drop } = t);
  const ctx = await createAttackContext(db, t.orgA, t.orgB);
  results = await runAttackSuite(ctx);
  await ctx.app.close();
}, 240_000);

afterAll(async () => drop?.());

describe("adversarial attack suite", () => {
  it("runs every attack in the catalogue", () => {
    expect(results).toHaveLength(ATTACKS.length);
    expect(ATTACKS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(results.map((r) => r.id)).size).toBe(results.length);
  });

  it("covers every threat class in AGENTS.md §12", () => {
    const ids = new Set(results.map((r) => r.id));
    // prompt injection, cross-tenant, repeated execution, simultaneous approvals, status change, beneficiary change,
    // timeout after execution, duplicate webhook, out-of-order webhook, malformed payload, oversized input, stale evidence, unknown tool
    for (const id of ["AI-01", "TEN-01", "PAY-05", "PAY-04", "APR-01", "APR-02", "PAY-06", "WH-03", "WH-04", "WH-06", "IN-01", "APR-03", "AI-03"]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it.each(ATTACKS.map((a) => [a.id, a.title]))("%s is blocked: %s", (id) => {
    const r = results.find((x) => x.id === id)!;
    expect(r.succeeded, `${r.id}: ${r.observed}`).toBe(false);
    expect(r.observed).not.toMatch(/HARNESS ERROR/);
  });
});
