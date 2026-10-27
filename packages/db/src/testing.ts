import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { type Db, createDb, migrate } from "./client.js";
import { organizations } from "./schema.js";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://sentinel:sentinel_local_dev@127.0.0.1:54329/sentinel";

/** A migrated, throwaway schema in the local Sentinel Postgres, plus two tenants. */
export async function createTestDb(): Promise<{ db: Db; orgA: string; orgB: string; drop: () => Promise<void> }> {
  const schemaName = `t_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = createDb({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.execute(sql.raw(`CREATE SCHEMA ${schemaName}`));
  const db = createDb({ connectionString: TEST_DATABASE_URL, searchPath: schemaName, max: 20 });
  await migrate(db);
  const orgA = randomUUID();
  const orgB = randomUUID();
  await db.insert(organizations).values([
    { id: orgA, name: "Sandbox Business A" },
    { id: orgB, name: "Sandbox Business B" },
  ]);
  return {
    db,
    orgA,
    orgB,
    drop: async () => {
      await db.$client.end();
      await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await admin.$client.end();
    },
  };
}
