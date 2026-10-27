import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /** The single sandbox tenant for the demo; created by `pnpm seed:demo`. */
  SENTINEL_ORGANIZATION_ID: z.uuid(),
  // Airwallex sandbox: optional. Without keys the console runs Scenario Lab in MOCK mode only.
  AIRWALLEX_CLIENT_ID: optional,
  AIRWALLEX_API_KEY: optional,
  AIRWALLEX_API_VERSION: optional,
  AIRWALLEX_WEBHOOK_SECRET: optional,
  // Bound approvals. Without it a random per-process key is used (approvals die on restart: safe, not convenient).
  APPROVAL_HMAC_SECRET: optional,
  // Investigator: "claude" needs Anthropic credentials; "mock" is the labelled deterministic stand-in.
  SENTINEL_INVESTIGATOR: z.enum(["claude", "mock"]).optional(),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: optional,
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
  if (parsed.data.APPROVAL_HMAC_SECRET && parsed.data.APPROVAL_HMAC_SECRET.length < 32) {
    throw new Error("APPROVAL_HMAC_SECRET must be at least 32 characters");
  }
  return parsed.data;
}
