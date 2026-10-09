import type { ChatMessage } from "./ai/types.js";
import type { Action } from "./types.js";

export type TranscriptStep =
  | { type: "context"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; toolUseId: string; tool: string; input: unknown; action: Action | null }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

/** Flattens a stored conversation into display steps for the run viewer. Provider-internal reasoning is omitted. */
export function buildTranscript(messages: ChatMessage[], actions: Action[]): TranscriptStep[] {
  const byToolUse = new Map(actions.map((a) => [a.tool_use_id, a]));
  const steps: TranscriptStep[] = [];
  messages.forEach((message, index) => {
    for (const part of message.parts ?? []) {
      if (part.type === "text") {
        if (!part.text.trim()) continue;
        steps.push(message.role === "user" && index === 0 ? { type: "context", text: part.text } : { type: "text", text: part.text });
      } else if (part.type === "tool_call") {
        steps.push({ type: "tool_call", toolUseId: part.id, tool: part.name, input: part.input, action: byToolUse.get(part.id) ?? null });
      } else if (part.type === "image") {
        steps.push({ type: "context", text: `[Attached image: ${part.name}]` });
      } else {
        steps.push({ type: "tool_result", toolUseId: part.toolCallId, content: part.content, isError: part.isError });
      }
    }
  });
  return steps;
}
