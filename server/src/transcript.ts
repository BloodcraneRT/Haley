import type { MessageParam } from "./agent/llm.js";
import type { Action } from "./types.js";

export type TranscriptStep =
  | { type: "context"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; toolUseId: string; tool: string; input: unknown; action: Action | null }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

/** Flattens a stored conversation into display steps for the run viewer. Thinking blocks are omitted. */
export function buildTranscript(messages: MessageParam[], actions: Action[]): TranscriptStep[] {
  const byToolUse = new Map(actions.map((a) => [a.tool_use_id, a]));
  const steps: TranscriptStep[] = [];
  messages.forEach((message, index) => {
    const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type === "text") {
        if (!block.text.trim()) continue;
        steps.push(message.role === "user" && index === 0 ? { type: "context", text: block.text } : { type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        steps.push({ type: "tool_call", toolUseId: block.id, tool: block.name, input: block.input, action: byToolUse.get(block.id) ?? null });
      } else if (block.type === "tool_result") {
        const content =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
        steps.push({ type: "tool_result", toolUseId: block.tool_use_id, content, isError: Boolean(block.is_error) });
      }
    }
  });
  return steps;
}
