import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AirwallexClient } from "@sentinel/airwallex";
import {
  type ApprovalKeys,
  airwallexExecutionProvider,
  createDb,
  executeReplacement,
  getIncident,
  migrate,
  recheckResolvedIncidents,
  schema,
  syncLedgerForObligation,
} from "@sentinel/db";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { MOCK_MODEL_ID, MockInvestigatorModel } from "./agent/mock-investigator.js";
import { DEFAULT_MODEL, anthropicModelClient } from "./agent/model.js";
import { bootstrapDemo } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import type { ApiDeps, Provider } from "./http/api.js";
import { MockProvider } from "./lab/mock-provider.js";
import { pollOnce } from "./poller.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const db = createDb({ connectionString: config.DATABASE_URL });
await migrate(db);
if (config.SENTINEL_DEMO_BOOTSTRAP === "1") {
  const tokensFile = config.SENTINEL_DEMO_TOKENS_FILE ?? fileURLToPath(new URL("../../../.local/demo-tokens.json", import.meta.url));
  const r = await bootstrapDemo(db, config.SENTINEL_ORGANIZATION_ID, tokensFile);
  console.log(r === "created" ? `Demo users created; sign-in tokens written to ${tokensFile}` : "Demo tenant already has users; tokens unchanged");
}

const airwallexClient =
  config.AIRWALLEX_CLIENT_ID && config.AIRWALLEX_API_KEY
    ? new AirwallexClient({ clientId: config.AIRWALLEX_CLIENT_ID, apiKey: config.AIRWALLEX_API_KEY, apiVersion: config.AIRWALLEX_API_VERSION })
    : null;
const airwallex: Provider | null = airwallexClient ? { ...airwallexExecutionProvider(airwallexClient) } : null;

const keyVersion = config.APPROVAL_HMAC_SECRET ? "env-1" : "ephemeral";
const keySecret = config.APPROVAL_HMAC_SECRET ?? randomBytes(32).toString("hex");
const keys: ApprovalKeys = { current: { version: keyVersion, secret: keySecret }, all: { [keyVersion]: keySecret } };

const useClaude = config.SENTINEL_INVESTIGATOR === "claude" || (config.SENTINEL_INVESTIGATOR !== "mock" && !!config.ANTHROPIC_API_KEY);
const investigator: ApiDeps["investigator"] = useClaude
  ? { model: anthropicModelClient(), modelId: config.ANTHROPIC_MODEL ?? DEFAULT_MODEL, label: "CLAUDE" }
  : { model: new MockInvestigatorModel(), modelId: MOCK_MODEL_ID, label: "MOCK AI" };

const mockProviders = new Map<string, MockProvider>();
const mockProvider = (org: string) => {
  let p = mockProviders.get(org);
  if (!p) mockProviders.set(org, (p = new MockProvider(db, org)));
  return p;
};

const app = buildServer({
  db,
  organizationId: config.SENTINEL_ORGANIZATION_ID,
  webhookSecret: config.AIRWALLEX_WEBHOOK_SECRET ?? null,
  logger: true,
  api: { keys, airwallex, mockProvider, investigator },
  webRoot: fileURLToPath(new URL("../../web/dist/", import.meta.url)),
});
await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(
  { airwallex: airwallex ? "SANDBOX" : "NOT_CONFIGURED (Scenario Lab MOCK only)", investigator: investigator.label, approvalKey: keys.current.version },
  "Quantum Sentinel ready",
);
if (!config.APPROVAL_HMAC_SECRET) app.log.warn("APPROVAL_HMAC_SECRET not set: using an ephemeral key; pending approvals become invalid on restart");

let busy = false;
const timer = setInterval(async () => {
  if (busy) return; // never overlap
  busy = true;
  try {
    // 1. Backup poller (sandbox only).
    if (airwallexClient) {
      const r = await pollOnce(db, airwallexClient, config.SENTINEL_ORGANIZATION_ID);
      if (r.newObservations || r.errors.length) app.log.info(r, "poll");
    }
    // 2. Executor worker: retry PENDING executions and UNCERTAIN ones whose lease expired.
    const due = await db
      .select({ e: schema.executions, i: schema.incidents })
      .from(schema.executions)
      .innerJoin(schema.approvals, eq(schema.approvals.id, schema.executions.approvalId))
      .innerJoin(schema.incidents, eq(schema.incidents.id, schema.approvals.incidentId))
      .where(or(eq(schema.executions.status, "PENDING"), and(inArray(schema.executions.status, ["CLAIMED", "UNCERTAIN"]), lt(schema.executions.leaseUntil, new Date()))));
    for (const { e, i } of due) {
      const provider = i.origin === "MOCK_SCENARIO" ? mockProvider(i.organizationId) : airwallex;
      if (!provider) continue;
      const r = await executeReplacement(db, provider, i.organizationId, e.id, { keys });
      app.log.info({ executionId: e.id, status: r.status }, "executor");
    }
    // 3. A resolved incident whose settling payment later failed (PAID can still fail) reopens and escalates.
    const orgs = await db.selectDistinct({ id: schema.incidents.organizationId }).from(schema.incidents).where(eq(schema.incidents.state, "RESOLVED"));
    for (const { id: org } of orgs) {
      for (const r of await recheckResolvedIncidents(db, org)) {
        await syncLedgerForObligation(db, org, (await getIncident(db, org, r.incidentId)).obligationId);
        app.log.warn(r, "resolved incident reopened and escalated");
      }
    }
  } catch (err) {
    app.log.error(err, "worker tick failed");
  } finally {
    busy = false;
  }
}, config.POLL_INTERVAL_MS);

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  await db.$client.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
