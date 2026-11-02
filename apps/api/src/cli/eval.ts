/**
 * Run the evaluation matrix and write EVAL.md:
 *
 *   pnpm eval            Mock AI investigator (no API cost)
 *   pnpm eval --live     Claude investigator (needs Anthropic credentials; spends credits)
 *
 * Uses a throwaway schema in the local Sentinel Postgres and the MOCK provider.
 * Exits 1 if any case fails.
 */
import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestDb } from "@sentinel/db";
import { MOCK_MODEL_ID, MockInvestigatorModel } from "../agent/mock-investigator.js";
import { DEFAULT_MODEL, anthropicModelClient } from "../agent/model.js";
import { renderEval, runEval, summarize } from "../eval/run.js";

const live = process.argv.includes("--live");
const investigator = live
  ? { model: anthropicModelClient(), modelId: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL, label: "Claude (live)" }
  : { model: new MockInvestigatorModel(), modelId: MOCK_MODEL_ID, label: "Mock AI" };

const { db, orgA, drop } = await createTestDb();
let code: number;
try {
  const results = await runEval(db, orgA, investigator);
  let commit: string | null = null;
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    if (execSync('git status --porcelain -- . ":(exclude)EVAL.md"', { encoding: "utf8" }).trim()) commit += " plus uncommitted changes";
  } catch {
    commit = null;
  }
  const md = renderEval(results, { ranAt: new Date().toISOString(), commit, investigator: investigator.label, model: investigator.modelId });
  await writeFile(fileURLToPath(new URL("../../../../EVAL.md", import.meta.url)), md);
  for (const r of results) {
    console.log(`${r.pass ? "pass" : "FAIL"}  ${r.case.id}  ${r.case.title}${r.outcome ? `  -> ${r.outcome.decision}/${r.outcome.finalState}` : ""}${r.error ? `  ERROR ${r.error}` : ""}`);
  }
  const s = summarize(results);
  console.log(`\n${s.passed}/${s.cases} cases pass · unsafe blocked ${s.unsafeBlocked}/${s.unsafeAttempts} · duplicates prevented ${s.duplicatesPrevented}\nWritten to EVAL.md`);
  code = s.passed === s.cases ? 0 : 1;
} finally {
  await drop();
}
process.exit(code);
