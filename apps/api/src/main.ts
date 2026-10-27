import { AirwallexClient } from "@sentinel/airwallex";
import { createDb, migrate } from "@sentinel/db";
import { loadConfig } from "./config.js";
import { pollOnce } from "./poller.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const db = createDb({ connectionString: config.DATABASE_URL });
await migrate(db);

const client = new AirwallexClient({
  clientId: config.AIRWALLEX_CLIENT_ID,
  apiKey: config.AIRWALLEX_API_KEY,
  apiVersion: config.AIRWALLEX_API_VERSION,
});

const app = buildServer({
  db,
  organizationId: config.SENTINEL_ORGANIZATION_ID,
  webhookSecret: config.AIRWALLEX_WEBHOOK_SECRET,
  logger: true,
});
await app.listen({ port: config.PORT, host: config.HOST });

let polling = false;
const timer = setInterval(async () => {
  if (polling) return; // never overlap polls
  polling = true;
  try {
    const r = await pollOnce(db, client, config.SENTINEL_ORGANIZATION_ID);
    if (r.newObservations || r.errors.length) app.log.info(r, "poll");
  } catch (err) {
    app.log.error(err, "poll failed");
  } finally {
    polling = false;
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
