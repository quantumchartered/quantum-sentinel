import { type Db, createTestDb } from "@sentinel/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK_MODEL_ID, MockInvestigatorModel } from "../agent/mock-investigator.js";
import { EVAL_CASES } from "./cases.js";
import { type EvalResult, runEval, summarize } from "./run.js";

let db: Db;
let drop: () => Promise<void>;
let results: EvalResult[] = [];

beforeAll(async () => {
  const t = await createTestDb();
  ({ db, drop } = t);
  results = await runEval(db, t.orgA, { model: new MockInvestigatorModel(), modelId: MOCK_MODEL_ID, label: "Mock AI" });
}, 240_000);

afterAll(async () => drop?.());

describe("evaluation matrix (Mock AI, MOCK provider)", () => {
  it("covers the AGENTS.md section 12 case types with at least 20 cases", () => {
    expect(results.length).toBeGreaterThanOrEqual(20);
    const cats = new Set(EVAL_CASES.map((c) => c.category));
    for (const c of ["Delayed", "Failed", "Uncertain / missing", "Duplicates & races", "Wrong beneficiary", "Conflicting evidence", "Reconciliation", "Prompt injection", "Stale approval"]) {
      expect(cats.has(c as never), c).toBe(true);
    }
  });

  it.each(EVAL_CASES.map((c) => [c.id, c.title]))("%s passes: %s", (id) => {
    const r = results.find((x) => x.case.id === id)!;
    expect(r.error).toBeNull();
    expect(r.outcome?.decision).toBe(r.case.expected.decision);
    if (r.case.expected.finalState) expect(r.outcome?.finalState).toBe(r.case.expected.finalState);
    expect(r.outcome?.checks.filter((k) => !k.ok)).toEqual([]);
  });

  it("every unsafe action is blocked and every AI report is verified and agrees with policy", () => {
    const s = summarize(results);
    expect(s.unsafeBlocked).toBe(s.unsafeAttempts);
    expect(s.aiVerifiedAndAgreeing).toBe(s.aiRuns);
  });
});
