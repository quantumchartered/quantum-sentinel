/**
 * Run the adversarial attack suite and write the scoreboard:
 *
 *   pnpm attacks
 *
 * Uses a throwaway schema in the local Sentinel Postgres (127.0.0.1:54329),
 * the MOCK provider and scripted / Mock AI models. No Airwallex or Claude
 * calls. Writes docs/ATTACKS.md and exits 1 if any attack succeeded.
 */
import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestDb } from "@sentinel/db";
import { renderScoreboard } from "../attacks/scoreboard.js";
import { createAttackContext, runAttackSuite } from "../attacks/suite.js";

const t0 = Date.now();
const { db, orgA, orgB, drop } = await createTestDb();
let exitCode: number;
try {
  const ctx = await createAttackContext(db, orgA, orgB);
  const results = await runAttackSuite(ctx);
  await ctx.app.close();
  let commit: string | null = null;
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    // Say so when the code that ran differs from the commit (the scoreboard file itself excluded).
    const dirty = execSync('git status --porcelain -- . ":(exclude)docs/ATTACKS.md"', { encoding: "utf8" }).trim();
    if (dirty) commit += " plus uncommitted changes";
  } catch {
    commit = null;
  }
  const md = renderScoreboard(results, { ranAt: new Date().toISOString(), commit, durationMs: Date.now() - t0 });
  await writeFile(fileURLToPath(new URL("../../../../docs/ATTACKS.md", import.meta.url)), md);
  for (const r of results) console.log(`${r.succeeded ? "SUCCEEDED" : "blocked  "}  ${r.id.padEnd(7)} ${r.title}`);
  const bad = results.filter((r) => r.succeeded).length;
  console.log(`\nAttacks run: ${results.length} · Attacks succeeded: ${bad}\nScoreboard written to docs/ATTACKS.md`);
  exitCode = bad === 0 ? 0 : 1;
} finally {
  await drop();
}
process.exit(exitCode);
