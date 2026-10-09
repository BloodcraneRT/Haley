import Anthropic from "@anthropic-ai/sdk";
import { imagePlaceholder, LlmError, withoutImages, type ChatMessage, type LlmClient, type LlmRequest, type ModelResponse, type Part, type StopReason } from "./types.js";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;

export interface AnthropicOptions {
  model: string;
  /** Empty: resolve credentials from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, `ant auth login`). */
  apiKey?: string;
  baseUrl?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Server-side refusal fallbacks (Claude API only; turn off behind Bedrock/Vertex/Foundry or a proxy). */
  fallbacks?: boolean;
  /** Whether this model reads images; when false, images are sent as text placeholders. Default true. */
  vision?: boolean;
}

const STOP: Record<string, StopReason> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
  pause_turn: "pause_turn",
  model_context_window_exceeded: "context_exceeded",
};

/** Claude requires tool ids matching ^[a-zA-Z0-9_-]+$; ids minted by other providers may not. */
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

function toAnthropic(message: ChatMessage, model: string): BetaMessageParam {
  // Replay Claude's own turn untouched (thinking blocks included) when continuing on the same model.
  if (message.role === "assistant" && message.native?.provider === "anthropic" && message.native.model === model) {
    return { role: "assistant", content: message.native.content as BetaContentBlock[] } as BetaMessageParam;
  }
  const content = message.parts.map((p) => {
    if (p.type === "text") return { type: "text" as const, text: p.text };
    if (p.type === "image") {
      return p.data
        ? { type: "image" as const, source: { type: "base64" as const, media_type: p.mediaType, data: p.data } }
        : { type: "text" as const, text: imagePlaceholder(p.name, "not shown again here") };
    }
    if (p.type === "tool_call") return { type: "tool_use" as const, id: safeId(p.id), name: p.name, input: p.input };
    return { type: "tool_result" as const, tool_use_id: safeId(p.toolCallId), content: p.content, is_error: p.isError };
  });
  return { role: message.role, content } as BetaMessageParam;
}

function toParts(content: BetaContentBlock[]): Part[] {
  const parts: Part[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push({ type: "text", text: block.text });
    else if (block.type === "tool_use") parts.push({ type: "tool_call", id: block.id, name: block.name, input: block.input });
  }
  return parts;
}

/** Claude through the Anthropic SDK: adaptive thinking, streaming, prompt caching and refusal fallbacks. */
export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;
  readonly label: string;

  constructor(
    private readonly options: AnthropicOptions,
    client?: Anthropic,
  ) {
    this.client =
      client ??
      new Anthropic({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      });
    this.label = `anthropic/${options.model}`;
  }

  async create({ system, messages, tools }: LlmRequest): Promise<ModelResponse> {
    const model = this.options.model;
    // Tool inputs are validated with zod by the runner before anything executes,
    // which is what eager input streaming requires of the client.
    const apiTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool["input_schema"],
      eager_input_streaming: true,
    }));
    let parseFailures = 0;
    for (;;) {
      const stream = this.client.beta.messages.stream({
        model,
        max_tokens: this.options.maxTokens ?? 32000,
        thinking: { type: "adaptive" },
        output_config: { effort: this.options.effort ?? "high" },
        // System prompt and tools are stable per org, so cache them; top-level
        // cache_control also caches the growing conversation between turns.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        cache_control: { type: "ephemeral" },
        tools: apiTools,
        messages: (this.options.vision === false ? withoutImages(messages) : messages).map((m) => toAnthropic(m, model)),
        ...(this.options.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      try {
        const message = await stream.finalMessage();
        const usage = message.usage;
        return {
          parts: toParts(message.content),
          stopReason: STOP[message.stop_reason ?? "end_turn"] ?? "end_turn",
          model: message.model,
          provider: "anthropic",
          native: { provider: "anthropic", model, content: message.content },
          usage: {
            inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
            outputTokens: usage?.output_tokens ?? 0,
          },
        };
      } catch (err) {
        // With eager input streaming, a tool input that is not parseable JSON rejects here.
        // Re-issue that turn a couple of times; real API errors are translated and propagate.
        if (err instanceof Anthropic.APIError || parseFailures++ >= 2) throw describeAnthropicError(err, this.label);
      }
    }
  }
}

export function describeAnthropicError(err: unknown, label: string): LlmError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new LlmError(`${label}: authentication failed. Check the API key for this model.`, false, 401);
  }
  if (err instanceof Anthropic.RateLimitError) return new LlmError(`${label}: rate limited.`, true, 429);
  if (err instanceof Anthropic.BadRequestError) return new LlmError(`${label} rejected the request: ${err.message}`, false, 400);
  if (err instanceof Anthropic.APIConnectionError) return new LlmError(`${label}: could not reach the API.`, true);
  if (err instanceof Anthropic.APIError) return new LlmError(`${label} error ${err.status ?? ""}: ${err.message}`, (err.status ?? 500) >= 500, err.status);
  // Missing credentials surface as a plain Error from the client before any request is sent.
  return new LlmError(`${label}: ${err instanceof Error ? err.message : String(err)}`, false);
}
