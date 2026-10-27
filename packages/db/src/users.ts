import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { appendAudit } from "./audit.js";
import type { Db } from "./client.js";
import { type UserRole, users } from "./schema.js";

export type UserRow = typeof users.$inferSelect;

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** Create a user and return its bearer token. The token is shown once; only its hash is stored. */
export async function createUser(db: Db, organizationId: string, input: { displayName: string; role: UserRole }, actor = "system") {
  const id = randomUUID();
  const token = `sst_${randomBytes(32).toString("base64url")}`;
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ id, organizationId, displayName: input.displayName, role: input.role, tokenSha256: hashToken(token) });
    await appendAudit(tx, organizationId, { actor, eventType: "user.created", payload: { userId: id, displayName: input.displayName, role: input.role } });
  });
  return { id, token };
}

export async function authenticateToken(db: Db, token: string): Promise<UserRow | null> {
  if (!/^sst_[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [u] = await db.select().from(users).where(and(eq(users.tokenSha256, hashToken(token)), isNull(users.disabledAt)));
  return u ?? null;
}
