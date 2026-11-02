import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Db, createUser, schema } from "@sentinel/db";
import { eq } from "drizzle-orm";

/**
 * Local demo bootstrap (opt-in with SENTINEL_DEMO_BOOTSTRAP=1, used by Docker
 * Compose and the end-to-end tests): make sure the tenant exists and, if it
 * has no users yet, create one per role. Tokens are written to a local file
 * (git-ignored), never to logs.
 */
export async function bootstrapDemo(db: Db, organizationId: string, tokensFile: string): Promise<"created" | "existing"> {
  await db.insert(schema.organizations).values({ id: organizationId, name: "Sandbox Business" }).onConflictDoNothing();
  const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.organizationId, organizationId)).limit(1);
  if (existing.length) return "existing";
  const tokens: Record<string, string> = {};
  for (const [displayName, role] of [
    ["Olivia Owner", "OWNER"],
    ["Omar Operator", "OPERATOR"],
    ["Ada Approver", "APPROVER"],
    ["Vic Viewer", "VIEWER"],
  ] as const) {
    tokens[role] = (await createUser(db, organizationId, { displayName, role }, "bootstrap")).token;
  }
  await mkdir(dirname(tokensFile), { recursive: true });
  await writeFile(tokensFile, JSON.stringify({ organizationId, tokens, note: "Local demo sign-in tokens. Do not commit." }, null, 2) + "\n", { mode: 0o600 });
  return "created";
}
