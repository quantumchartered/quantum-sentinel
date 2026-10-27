import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { type Db, appendAudit, getIncident, latestDecision, schema } from "@sentinel/db";
import type { Recommendation } from "@sentinel/policy";
import { type CreateParams, DEFAULT_MODEL, type ModelClient, costMicroUsd } from "./model.js";
import { SYSTEM_PROMPT, initialUserMessage } from "./prompt.js";
import { EvidenceRegistry } from "./registry.js";
import { type IncidentReport, IncidentReportSchema } from "./report.js";
import { TOOL_DEFINITIONS, ToolInputs, executeTool } from "./tools.js";
import { type Verification, verifyReport } from "./verifier.js";

export interface InvestigationConfig {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Model calls per run. */
  maxSteps: number;
  /** Total output tokens per run (across steps). */
  maxOutputTokens: number;
  timeoutMs: number;
  /** submit_report attempts before the run is marked REPORT_REJECTED. */
  maxReportAttempts: number;
  /** Server-side refusal fallback (Claude API only). */
  serverFallbacks: boolean;
}

export const DEFAULT_INVESTIGATION_CONFIG: InvestigationConfig = {
  model: DEFAULT_MODEL,
  effort: "medium",
  maxSteps: 12,
  maxOutputTokens: 60_000,
  timeoutMs: 180_000,
  maxReportAttempts: 3,
  serverFallbacks: true,
};

export type RunStatus = "COMPLETED" | "REPORT_REJECTED" | "REFUSED" | "AI_UNAVAILABLE" | "LIMIT_EXCEEDED" | "NO_REPORT";

export interface ToolCallRecord {
  step: number;
  name: string;
  input: unknown;
  ok: boolean;
  /** Short result summary (full results are reproducible from the event store). */
  summary: string;
}

export interface InvestigationResult {
  runId: string;
  status: RunStatus;
  policyRecommendation: Recommendation;
  report: IncidentReport | null;
  verification: Verification | null;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: bigint | null;
  toolCalls: ToolCallRecord[];
  error: string | null;
}

/**
 * One bounded investigation (steps, output tokens, wall time). The model only
 * sees tool results; the deterministic decision must already exist. Whatever
 * happens - refusal, outage, garbage output - the run is recorded and the
 * deterministic decision and every safety check stay in force.
 */
export async function runInvestigation(deps: {
  db: Db;
  model: ModelClient;
  organizationId: string;
  incidentId: string;
  config?: Partial<InvestigationConfig>;
  now?: () => number;
}): Promise<InvestigationResult> {
  const cfg = { ...DEFAULT_INVESTIGATION_CONFIG, ...deps.config };
  const now = deps.now ?? Date.now;
  const started = now();
  const { db, organizationId: org, incidentId } = deps;
  const runId = randomUUID();

  const incident = await getIncident(db, org, incidentId);
  const decision = await latestDecision(db, org, incidentId);
  if (!decision) throw new Error("evaluate the incident before investigating: no deterministic decision recorded");
  const policyRecommendation = decision.recommendation;

  const registry = new EvidenceRegistry();
  const toolCalls: ToolCallRecord[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: initialUserMessage(incidentId) }];
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reportAttempts = 0;
  let nudged = false;
  let lastReport: IncidentReport | null = null;
  let lastVerification: Verification | null = null;

  const finish = async (status: RunStatus, error: string | null = null): Promise<InvestigationResult> => {
    const cost = costMicroUsd(cfg.model, inputTokens, outputTokens);
    const accepted = status === "COMPLETED";
    await db.transaction(async (tx) => {
      await tx.insert(schema.agentRuns).values({
        id: runId,
        organizationId: org,
        incidentId,
        incidentVersion: incident.version,
        model: cfg.model,
        status,
        steps,
        inputTokens,
        outputTokens,
        costMicroUsd: cost ?? 0n,
        toolCalls,
        evidenceShown: registry.all().map((e) => ({ id: e.id, label: e.label, trusted: e.trusted })),
        report: lastReport,
        verification: lastVerification,
        policyRecommendation,
        error: error ?? (cost === null ? `no price known for ${cfg.model}; cost recorded as 0` : null),
        startedAt: new Date(started),
      });
      await appendAudit(tx, org, {
        actor: `agent:${runId}`,
        eventType: "agent.run",
        payload: {
          incidentId,
          runId,
          status,
          model: cfg.model,
          steps,
          policyRecommendation,
          reportRecommendation: lastReport?.recommendation ?? null,
          accepted,
          verifierErrors: lastVerification?.errors.map((e) => e.code) ?? [],
        },
      });
    });
    return {
      runId,
      status,
      policyRecommendation,
      report: lastReport,
      verification: lastVerification,
      steps,
      inputTokens,
      outputTokens,
      costMicroUsd: cost,
      toolCalls,
      error,
    };
  };

  const ctx = { db, organizationId: org, incidentId, runId, registry };

  while (steps < cfg.maxSteps) {
    if (now() - started > cfg.timeoutMs) return finish("LIMIT_EXCEEDED", "wall-clock limit reached");
    if (outputTokens > cfg.maxOutputTokens) return finish("LIMIT_EXCEEDED", "output-token budget reached");
    steps++;

    const params: CreateParams = {
      model: cfg.model,
      max_tokens: 16_000,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages,
      output_config: { effort: cfg.effort },
      ...(cfg.serverFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await deps.model.createMessage(params);
    } catch (err) {
      // Outage, auth, rate limit, network: the deterministic engine carries on without AI analysis.
      const msg = err instanceof Anthropic.APIError ? `${err.constructor.name} ${err.status ?? ""}`.trim() : err instanceof Error ? err.message : String(err);
      return finish("AI_UNAVAILABLE", `AI analysis unavailable: ${msg}`);
    }
    inputTokens += response.usage.input_tokens ?? 0;
    outputTokens += response.usage.output_tokens ?? 0;

    if (response.stop_reason === "refusal") return finish("REFUSED", "model declined the request");
    if (response.stop_reason === "max_tokens") return finish("LIMIT_EXCEEDED", "response hit max_tokens");

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });

    if (toolUses.length === 0) {
      if (nudged) return finish("NO_REPORT", "model stopped without submitting a report");
      nudged = true;
      messages.push({ role: "user", content: "Please finish by calling submit_report with the complete report." });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of toolUses) {
      const record = (ok: boolean, summary: string) => toolCalls.push({ step: steps, name: call.name, input: call.input, ok, summary: summary.slice(0, 300) });

      if (call.name === "submit_report") {
        reportAttempts++;
        const parsed = IncidentReportSchema.safeParse(call.input);
        if (!parsed.success) {
          record(false, "report failed schema validation");
          results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Report does not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
        } else {
          lastReport = parsed.data;
          lastVerification = verifyReport(parsed.data, registry, policyRecommendation);
          if (lastVerification.ok) {
            record(true, "report accepted by verifier");
            return finish("COMPLETED");
          }
          record(false, `verifier rejected: ${lastVerification.errors.map((e) => e.code).join(", ")}`);
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            is_error: true,
            content: `The verifier rejected the report. Fix these and resubmit:\n${lastVerification.errors.map((e) => `- ${e.where}: ${e.code} (${e.detail})`).join("\n")}`,
          });
        }
        if (reportAttempts >= cfg.maxReportAttempts) return finish("REPORT_REJECTED", "report failed verification after the maximum attempts");
        continue;
      }

      if (!(call.name in ToolInputs)) {
        // An attempt to use a capability that does not exist (e.g. "execute_transfer") is refused and recorded.
        record(false, "unknown tool refused");
        await db.transaction((tx) =>
          appendAudit(tx, org, { actor: `agent:${runId}`, eventType: "agent.unknown_tool", payload: { incidentId, tool: call.name.slice(0, 100) } }),
        );
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `There is no tool named "${call.name}". Available tools: ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}.` });
        continue;
      }

      try {
        const out = await executeTool(ctx, call.name as keyof typeof ToolInputs, call.input);
        const text = JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        record(true, call.name === "propose_action" ? `propose_action -> ${(out as { status?: string }).status ?? "?"}` : `${text.length} chars`);
        results.push({ type: "tool_result", tool_use_id: call.id, content: text });
      } catch (err) {
        record(false, err instanceof Error ? err.message : "tool failed");
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Tool error: ${err instanceof Error ? err.message.slice(0, 500) : "failed"}` });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return finish("LIMIT_EXCEEDED", `step limit (${cfg.maxSteps}) reached`);
}
