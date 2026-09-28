import { randomUUID } from "node:crypto";
import { LlmError, type ChatMessage, type LlmClient, type LlmRequest, type ModelResponse, type Part, type StopReason } from "./types.js";

export interface OpenAICompatibleOptions {
  /** Shown in errors and the dashboard, e.g. "openai/gpt-5" or "ollama/qwen3". */
  provider: string;
  model: string;
  /** Full URL of the chat completions endpoint. */
  endpoint: string;
  apiKey?: string;
  /** "bearer" (OpenAI and most compatible servers) or "api-key" (Azure OpenAI). */
  authHeader?: "bearer" | "api-key";
  maxTokens?: number;
  /** Newer OpenAI models take max_completion_tokens; most compatible servers take max_tokens. */
  tokenParam?: "max_tokens" | "max_completion_tokens";
  temperature?: number;
  /** OpenAI reasoning models: low | medium | high. */
  reasoningEffort?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

type Json = Record<string, any>;

const FINISH: Record<string, StopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

/** Converts neutral messages to chat-completions messages (tool results become role "tool" messages). */
export function toOpenAIMessages(system: string, messages: ChatMessage[]): Json[] {
  const out: Json[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      const calls = message.parts.filter((p) => p.type === "tool_call") as Array<Extract<Part, { type: "tool_call" }>>;
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
          : {}),
      });
      continue;
    }
    const text: string[] = [];
    for (const part of message.parts) {
      if (part.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: part.toolCallId, content: part.isError ? `ERROR: ${part.content}` : part.content });
      } else if (part.type === "text") {
        text.push(part.text);
      }
    }
    if (text.length) out.push({ role: "user", content: text.join("\n\n") });
  }
  return out;
}

function parseArguments(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw; // some servers (e.g. Ollama) already send objects
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Let the runner's schema validation report it back to the model.
    return { __invalid_json: raw };
  }
}

/**
 * Any server speaking the OpenAI chat-completions protocol with function calling: OpenAI, Azure OpenAI,
 * Google Gemini (OpenAI-compatible endpoint), Mistral, Groq, Together, OpenRouter, DeepSeek, xAI, and
 * self-hosted open models through Ollama, vLLM, LM Studio or a LiteLLM gateway.
 */
export class OpenAICompatibleLlm implements LlmClient {
  readonly label: string;

  constructor(
    private readonly options: OpenAICompatibleOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.label = `${options.provider}/${options.model}`;
  }

  async create({ system, messages, tools }: LlmRequest): Promise<ModelResponse> {
    const o = this.options;
    const body: Json = {
      model: o.model,
      messages: toOpenAIMessages(system, messages),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      tool_choice: "auto",
      [o.tokenParam ?? "max_tokens"]: o.maxTokens ?? 8192,
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      ...(o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {}),
    };
    if (!tools.length) delete body.tools, delete body.tool_choice;

    const headers: Record<string, string> = { "content-type": "application/json", ...o.extraHeaders };
    if (o.apiKey) {
      if (o.authHeader === "api-key") headers["api-key"] = o.apiKey;
      else headers.authorization = `Bearer ${o.apiKey}`;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(o.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 600_000),
      });
    } catch (err) {
      throw new LlmError(`${this.label}: could not reach ${new URL(o.endpoint).host} (${err instanceof Error ? err.message : String(err)}).`, true);
    }
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const detail = data?.error?.message ?? data?.message ?? res.statusText;
      const auth = res.status === 401 || res.status === 403;
      throw new LlmError(
        auth ? `${this.label}: authentication failed (${detail}). Check the API key for this model.` : `${this.label} error ${res.status}: ${detail}`,
        res.status === 429 || res.status >= 500,
        res.status,
      );
    }

    const choice = data.choices?.[0];
    if (!choice) throw new LlmError(`${this.label} returned no choices.`, true);
    const message = choice.message ?? {};
    const parts: Part[] = [];
    if (typeof message.content === "string" && message.content.trim()) parts.push({ type: "text", text: message.content });
    for (const call of message.tool_calls ?? []) {
      parts.push({
        type: "tool_call",
        id: call.id || `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        name: call.function?.name ?? "",
        input: parseArguments(call.function?.arguments),
      });
    }
    const hasCalls = parts.some((p) => p.type === "tool_call");
    return {
      parts,
      // Some servers report "stop" even when they returned tool calls.
      stopReason: hasCalls ? "tool_use" : (FINISH[choice.finish_reason] ?? "end_turn"),
      model: data.model ?? o.model,
      provider: o.provider,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
    };
  }
}
