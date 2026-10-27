/**
 * Operator integrity commands (no Airwallex calls):
 *
 *   pnpm audit:verify   recompute the tenant's audit hash chain; exit 1 if broken
 *   pnpm reconcile      run reconciliation invariants; exit 1 on any error finding
 */
import { createDb, migrate, runReconciliation, verifyStoredAuditChain } from "@sentinel/db";

const cmd = process.argv[2];
const url = process.env.DATABASE_URL;
const org = process.env.SENTINEL_ORGANIZATION_ID;
if (!url || !org) {
  console.error("DATABASE_URL and SENTINEL_ORGANIZATION_ID must be set (see .env.example)");
  process.exit(2);
}

const db = createDb({ connectionString: url, max: 2 });
try {
  await migrate(db);
  if (cmd === "audit:verify") {
    const r = await verifyStoredAuditChain(db, org);
    if (r.ok) console.log(`audit chain OK: ${r.entries} entries, head ${r.head}`);
    else console.error(`audit chain BROKEN at seq ${r.brokenAtSeq}: ${r.reason}`);
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === "reconcile") {
    const r = await runReconciliation(db, org);
    console.log(JSON.stringify({ runId: r.id, ok: r.ok, findings: r.findings }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    process.exitCode = r.ok ? 0 : 1;
  } else {
    console.error('Usage: ops.ts "audit:verify" | "reconcile"');
    process.exitCode = 2;
  }
} finally {
  await db.$client.end();
}
