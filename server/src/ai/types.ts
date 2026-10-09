/**
 * Provider-neutral conversation format. The runner stores and reasons about these; each provider adapter
 * converts to and from its own wire format, so any model with tool calling can drive Haley.
 */

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type Part =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; isError: boolean }
  /**
   * A picture from the requester (a screenshot). Stored conversations keep only the attachment id; the runner
   * fills in `data` (base64) just before a model call, for the few most recent images.
   */
  | { type: "image"; name: string; mediaType: ImageMediaType; attachmentId?: string; data?: string };

export interface NativeContent {
  provider: string;
  model: string;
  /** The assistant turn exactly as the provider returned it (e.g. Claude's thinking blocks), replayed only to the same model. */
  content: unknown;
}

export interface ChatMessage {
  role: "user" | "assistant";
  parts: Part[];
  native?: NativeContent;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input (type "object"). */
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn" | "context_exceeded";

export interface ModelResponse {
  parts: Part[];
  stopReason: StopReason;
  /** The model that actually served the turn (fallbacks may differ from the one requested). */
  model: string;
  provider: string;
  native?: NativeContent;
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

/** One model call. Swappable so any provider (or a test script) can drive the agent. */
export interface LlmClient {
  readonly label: string;
  create(request: LlmRequest): Promise<ModelResponse>;
}

/** An error that says which model failed, so fallbacks and run errors are readable. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** What a model that can't see an image (or an image not loaded for this call) gets instead. */
export const imagePlaceholder = (name: string, why = "this model can't read images") => `[Image "${name}" attached; ${why}.]`;

/** Replaces image parts with text placeholders, for models without vision. */
export function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.parts.some((p) => p.type === "image")
      ? { ...m, parts: m.parts.map((p) => (p.type === "image" ? { type: "text" as const, text: imagePlaceholder(p.name) } : p)) }
      : m,
  );
}

export const textOf = (parts: Part[]) =>
  parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();

export const toolCallsOf = (parts: Part[]) => parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call");
