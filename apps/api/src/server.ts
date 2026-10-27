import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import { type Db, recordWebhook } from "@sentinel/db";
import Fastify, { type FastifyInstance } from "fastify";
import { type ApiDeps, registerApi } from "./http/api.js";

export interface ServerDeps {
  db: Db;
  organizationId: string;
  /** Webhook endpoint answers 503 until a subscription secret is configured. */
  webhookSecret: string | null;
  now?: () => number;
  logger?: boolean;
  /** Operator API (omit to run the webhook receiver only). */
  api?: Omit<ApiDeps, "db">;
  /** Built console (apps/web/dist) to serve at "/", if present. */
  webRoot?: string;
}

/** Airwallex webhook bodies are small; anything bigger is refused before hashing. */
export const WEBHOOK_BODY_LIMIT = 256 * 1024;

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger
      ? { redact: ["req.headers.authorization", "req.headers.x-signature", "req.headers.x-api-key"] }
      : false,
    bodyLimit: WEBHOOK_BODY_LIMIT,
  });
  const now = deps.now ?? Date.now;

  // Webhooks keep the exact bytes (the signature covers the raw body); every other route gets parsed JSON.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    if (req.url.startsWith("/webhooks/")) return done(null, body);
    if ((body as Buffer).length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch {
      done(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }), undefined);
    }
  });
  app.setReplySerializer((payload) => JSON.stringify(payload, bigintSafe));

  app.get("/health", async () => ({ ok: true }));

  app.post("/webhooks/airwallex", async (req, reply) => {
    if (!deps.webhookSecret) return reply.code(503).send({ error: "webhook secret not configured" });
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

  if (deps.api) registerApi(app, { ...deps.api, db: deps.db });

  if (deps.webRoot && existsSync(deps.webRoot)) {
    app.register(fastifyStatic, { root: deps.webRoot, wildcard: false });
    // Client-side routes fall back to the console's index.html.
    app.setNotFoundHandler((req, reply) =>
      req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/webhooks/")
        ? reply.sendFile("index.html")
        : reply.code(404).send({ error: "not found" }),
    );
  }

  return app;
}
