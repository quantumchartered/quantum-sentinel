import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface DbOptions {
  connectionString: string;
  /** Isolated schema (used by integration tests). */
  searchPath?: string;
  max?: number;
}

export function createDb(opts: DbOptions): Db {
  if (/:5432\//.test(opts.connectionString) && !process.env.SENTINEL_ALLOW_PORT_5432) {
    // Port 5432 on this machine belongs to another project; refuse rather than touch it.
    throw new Error("Refusing DATABASE_URL on port 5432; Sentinel's Postgres listens on 54329");
  }
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    ...(opts.searchPath ? { options: `-c search_path=${opts.searchPath}` } : {}),
  });
  return drizzle(pool, { schema }) as Db;
}

/** Apply migrations/*.sql in order, once each, under an advisory lock. */
export async function migrate(db: Db): Promise<string[]> {
  const client = await db.$client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(MIGRATIONS_DIR + file, "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => undefined);
    client.release();
  }
  return applied;
}
