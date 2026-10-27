/**
 * MOCK model for tests only: a scripted stand-in for Claude that returns
 * Messages-API-shaped responses. It never calls the network.
 */
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { CreateParams, ModelClient, ModelMessage } from "./model.js";

export type Block = Anthropic.Beta.BetaContentBlock;

export function toolUse(name: string, input: unknown): Block {
  return { type: "tool_use", id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`, name, input } as unknown as Block;
}

export function text(t: string): Block {
  return { type: "text", text: t, citations: null } as unknown as Block;
}

export function reply(content: Block[], stop: string = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"): ModelMessage {
  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1_200, output_tokens: 300 },
  } as unknown as ModelMessage;
}

/** Every tool result the model has received so far, decoded, with the tool name that produced it. */
export function toolResults(params: CreateParams): { name: string; json: unknown; isError: boolean; text: string }[] {
  const names = new Map<string, string>();
  const out: { name: string; json: unknown; isError: boolean; text: string }[] = [];
  for (const m of params.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as unknown as Record<string, unknown>[]) {
      if (b.type === "tool_use") names.set(String(b.id), String(b.name));
      if (b.type === "tool_result") {
        const t = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        let json: unknown;
        try {
          json = JSON.parse(t);
        } catch {
          json = null;
        }
        out.push({ name: names.get(String(b.tool_use_id)) ?? "?", json, isError: b.is_error === true, text: t });
      }
    }
  }
  return out;
}

export type Turn = (params: CreateParams) => ModelMessage | Error;

export class ScriptedModel implements ModelClient {
  readonly calls: CreateParams[] = [];
  private readonly turns: Turn[];
  constructor(turns: Turn[]) {
    this.turns = [...turns];
  }
  async createMessage(params: CreateParams): Promise<ModelMessage> {
    this.calls.push(params);
    const turn = this.turns.shift();
    if (!turn) throw new Error("ScriptedModel: script exhausted");
    const r = turn(params);
    if (r instanceof Error) throw r;
    return r;
  }
}
