/**
 * Run one live investigation with Claude for an existing incident:
 *
 *   pnpm investigate <incidentId>
 *
 * Needs DATABASE_URL, SENTINEL_ORGANIZATION_ID and Anthropic credentials
 * (ANTHROPIC_API_KEY or an `ant auth login` profile). ANTHROPIC_MODEL and
 * ANTHROPIC_EFFORT are optional. This spends API credits.
 */
import { createDb, migrate } from "@sentinel/db";
import { DEFAULT_INVESTIGATION_CONFIG, runInvestigation } from "../agent/loop.js";
import { anthropicModelClient } from "../agent/model.js";

const incidentId = process.argv[2];
const url = process.env.DATABASE_URL;
const org = process.env.SENTINEL_ORGANIZATION_ID;
if (!incidentId || !url || !org) {
  console.error("Usage: pnpm investigate <incidentId>  (needs DATABASE_URL and SENTINEL_ORGANIZATION_ID)");
  process.exit(2);
}
const effort = process.env.ANTHROPIC_EFFORT as (typeof DEFAULT_INVESTIGATION_CONFIG)["effort"] | undefined;

const db = createDb({ connectionString: url, max: 4 });
try {
  await migrate(db);
  const r = await runInvestigation({
    db,
    model: anthropicModelClient(),
    organizationId: org,
    incidentId,
    config: { ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}), ...(effort ? { effort } : {}) },
  });
  console.log(
    JSON.stringify(
      { runId: r.runId, status: r.status, policy: r.policyRecommendation, report: r.report, verification: r.verification, steps: r.steps, costMicroUsd: r.costMicroUsd, error: r.error },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
  process.exitCode = r.status === "COMPLETED" ? 0 : 1;
} finally {
  await db.$client.end();
}
