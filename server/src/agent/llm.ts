import Anthropic from "@anthropic-ai/sdk";
import type { HaleyConfig } from "../config.js";

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type Message = Anthropic.Beta.BetaMessage;
export type ToolParam = Anthropic.Beta.BetaTool;

export interface LlmRequest {
  system: string;
  messages: MessageParam[];
  tools: ToolParam[];
}

/** The one call the agent makes. Swappable so tests can script the model. */
export interface LlmClient {
  create(request: LlmRequest): Promise<Message>;
}

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(
    private readonly config: Pick<HaleyConfig, "model" | "fallbacks" | "effort">,
    client?: Anthropic,
  ) {
    // Resolves credentials from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
    this.client = client ?? new Anthropic();
  }

  async create({ system, messages, tools }: LlmRequest): Promise<Message> {
    // Tool inputs are validated with zod by the runner before anything executes,
    // which is what eager input streaming requires of the client.
    const streamedTools = tools.map((t) => ({ ...t, eager_input_streaming: true }));
    let parseFailures = 0;
    for (;;) {
      const stream = this.client.beta.messages.stream({
        model: this.config.model,
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        output_config: { effort: this.config.effort },
        // System prompt and tools are stable per org, so cache them; top-level
        // cache_control also caches the growing conversation between turns.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        cache_control: { type: "ephemeral" },
        tools: streamedTools,
        messages,
        ...(this.config.fallbacks
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      });
      try {
        return await stream.finalMessage();
      } catch (err) {
        // With eager input streaming, a tool input that is not parseable JSON rejects here.
        // Re-issue that turn a couple of times; real API errors propagate.
        if (err instanceof Anthropic.APIError || parseFailures++ >= 2) throw err;
      }
    }
  }
}

export function describeLlmError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Claude API authentication failed. Set ANTHROPIC_API_KEY (or run `ant auth login`) on the Haley server.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude API rate limit reached. Try again shortly.";
  if (err instanceof Anthropic.BadRequestError) return `Claude API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API (network error).";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`;
  // Missing credentials surface as a plain Error from the client before any request is sent.
  return `Claude request failed: ${err instanceof Error ? err.message : String(err)}`;
}
