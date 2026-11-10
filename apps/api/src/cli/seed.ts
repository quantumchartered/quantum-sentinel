/**
 * Local demo setup (no Airwallex calls):
 *
 *   pnpm seed:demo              create one user per role, print each token ONCE
 *   pnpm seed:demo --to-file    give the tenant's demo users new tokens and write them
 *                               to .local/demo-tokens.json (git-ignored), printing none
 *
 * Creates the demo tenant (SENTINEL_ORGANIZATION_ID, or prints a new id to add
 * to .env). Only token hashes are stored. Without --to-file, re-running creates
 * additional users; old tokens keep working. With --to-file, existing users keep
 * their identity and their old tokens stop working.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDb, createUser, migrate, rotateUserToken, schema } from "@sentinel/db";
import { and, asc, eq, isNull } from "drizzle-orm";

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
const toFile = process.argv.includes("--to-file");
const DEMO_USERS = [
  ["Olivia Owner", "OWNER"],
  ["Omar Operator", "OPERATOR"],
  ["Ada Approver", "APPROVER"],
  ["Vic Viewer", "VIEWER"],
] as const;

const db = createDb({ connectionString: url, max: 2 });
try {
  await migrate(db);
  await db.insert(schema.organizations).values({ id: orgId, name: "Sandbox Business" }).onConflictDoNothing();
  if (toFile) {
    const tokens: Record<string, string> = {};
    for (const [displayName, role] of DEMO_USERS) {
      const [existing] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.organizationId, orgId), eq(schema.users.role, role), isNull(schema.users.disabledAt)))
        .orderBy(asc(schema.users.createdAt))
        .limit(1);
      tokens[role] = existing ? await rotateUserToken(db, orgId, existing.id, "seed") : (await createUser(db, orgId, { displayName, role }, "seed")).token;
    }
    const file = fileURLToPath(new URL("../../../../.local/demo-tokens.json", import.meta.url));
    await mkdir(fileURLToPath(new URL("../../../../.local/", import.meta.url)), { recursive: true });
    await writeFile(file, JSON.stringify({ organizationId: orgId, tokens, note: "Local demo sign-in tokens. Do not commit." }, null, 2) + "\n", { mode: 0o600 });
    console.log(`Tenant ${orgId}: sign-in tokens for ${Object.keys(tokens).join(", ")} written to .local/demo-tokens.json (not printed).`);
  } else {
    console.log(`Tenant ${orgId} ready.\n\nSign-in tokens (shown once - keep them out of Git and chat):`);
    for (const [displayName, role] of DEMO_USERS) {
      const { token } = await createUser(db, orgId, { displayName, role }, "seed");
      console.log(`  ${role.padEnd(8)} ${displayName.padEnd(14)} ${token}`);
    }
  }
} finally {
  await db.$client.end();
}
