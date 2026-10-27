import Anthropic from "@anthropic-ai/sdk";

export type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ModelMessage = Anthropic.Beta.BetaMessage;

/** The only thing the investigator needs from Claude. Tests inject a scripted fake. */
export interface ModelClient {
  createMessage(params: CreateParams): Promise<ModelMessage>;
}

/** Real client. Credentials resolve from the environment (ANTHROPIC_API_KEY etc.); the key never leaves the server. */
export function anthropicModelClient(client: Anthropic = new Anthropic()): ModelClient {
  return { createMessage: (params) => client.beta.messages.create(params) };
}

export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Prices in US cents per million tokens (first-party API, cached 2026-10-06 in
 * the Claude API skill). $1 / MTok == 1 micro-USD per token, so
 * micro-USD = tokens * cents / 100.
 */
const PRICES_CENTS_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 400, output: 2000 },
  "claude-sonnet-5-5": { input: 200, output: 1000 },
  "claude-haiku-5-5": { input: 10, output: 50 },
  // Deterministic MOCK investigator (no LLM call).
  "mock-investigator": { input: 0, output: 0 },
};

/** Cost of a run in micro-USD (rounded up), or null when the model has no known price. */
export function costMicroUsd(model: string, inputTokens: number, outputTokens: number): bigint | null {
  const p = PRICES_CENTS_PER_MTOK[model];
  if (!p) return null;
  const cents100 = BigInt(inputTokens) * BigInt(p.input) + BigInt(outputTokens) * BigInt(p.output);
  return (cents100 + 99n) / 100n;
}
