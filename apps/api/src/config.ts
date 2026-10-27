import { z } from "zod";

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  AIRWALLEX_CLIENT_ID: z.string().min(1),
  AIRWALLEX_API_KEY: z.string().min(1),
  AIRWALLEX_API_VERSION: z.string().optional(),
  AIRWALLEX_WEBHOOK_SECRET: z.string().min(1),
  /** The single sandbox tenant for the demo; created by `pnpm seed`. */
  SENTINEL_ORGANIZATION_ID: z.uuid(),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("127.0.0.1"),
  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Validates env without ever echoing secret values into errors. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Missing or invalid configuration: ${fields.join(", ")} (see .env.example)`);
  }
  return parsed.data;
}
