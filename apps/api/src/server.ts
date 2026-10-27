import { type Db, recordWebhook } from "@sentinel/db";
import Fastify, { type FastifyInstance } from "fastify";

export interface ServerDeps {
  db: Db;
  organizationId: string;
  webhookSecret: string;
  now?: () => number;
  logger?: boolean;
}

/** Airwallex webhook bodies are small; anything bigger is refused before hashing. */
export const WEBHOOK_BODY_LIMIT = 256 * 1024;

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger
      ? { redact: ["req.headers.authorization", "req.headers.x-signature", "req.headers.x-api-key"] }
      : false,
    bodyLimit: WEBHOOK_BODY_LIMIT,
  });
  const now = deps.now ?? Date.now;

  // Keep the exact bytes: the signature covers the raw body, so we must not parse-and-reserialize.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.get("/health", async () => ({ ok: true }));

  app.post("/webhooks/airwallex", async (req, reply) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    // A DB error throws -> 500 -> Airwallex retries. We only answer 200 once the event is durably stored.
    const result = await recordWebhook(deps.db, {
      organizationId: deps.organizationId,
      secret: deps.webhookSecret,
      rawBody,
      timestampHeader: header("x-timestamp"),
      signatureHeader: header("x-signature"),
      nowMs: now(),
    });
    if (result.outcome === "rejected") {
      req.log.warn({ reason: result.reason }, "webhook rejected");
      return reply.code(401).send({ error: "invalid_signature" });
    }
    return reply.code(200).send({ received: true, outcome: result.outcome });
  });

  return app;
}
