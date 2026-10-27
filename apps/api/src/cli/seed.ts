/**
 * Local demo setup (no Airwallex calls):
 *
 *   pnpm seed:demo
 *
 * Creates the demo tenant (SENTINEL_ORGANIZATION_ID, or prints a new id to add
 * to .env) and one user per role, printing each sign-in token ONCE. Only token
 * hashes are stored. Re-running creates additional users; old tokens keep working.
 */
import { randomUUID } from "node:crypto";
import { createDb, createUser, migrate, schema } from "@sentinel/db";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set (see .env.example)");
  process.exit(2);
}
const orgId = process.env.SENTINEL_ORGANIZATION_ID;
if (!orgId) {
  console.log(`Add this line to .env, then run "pnpm seed:demo" again:\nSENTINEL_ORGANIZATION_ID=${randomUUID()}`);
  process.exit(0);
}

const db = createDb({ connectionString: url, max: 2 });
try {
  await migrate(db);
  await db.insert(schema.organizations).values({ id: orgId, name: "Sandbox Business" }).onConflictDoNothing();
  console.log(`Tenant ${orgId} ready.\n\nSign-in tokens (shown once - keep them out of Git and chat):`);
  for (const [displayName, role] of [
    ["Olivia Owner", "OWNER"],
    ["Omar Operator", "OPERATOR"],
    ["Ada Approver", "APPROVER"],
    ["Vic Viewer", "VIEWER"],
  ] as const) {
    const { token } = await createUser(db, orgId, { displayName, role }, "seed");
    console.log(`  ${role.padEnd(8)} ${displayName.padEnd(14)} ${token}`);
  }
} finally {
  await db.$client.end();
}
