import { randomBytes } from "node:crypto";
import type { LlmClient, LlmRequest, ModelResponse, Part, StopReason } from "../src/ai/types.js";
import { buildApp } from "../src/app.js";
import { loadConfig, type HaleyConfig } from "../src/config.js";

type StepResult = { content: Part[]; stop_reason?: StopReason };
type Step = (req: LlmRequest) => StepResult | Promise<StepResult>;

let counter = 0;

export function toolUse(name: string, input: unknown, id = `toolu_${++counter}`): Part {
  return { type: "tool_call", id, name, input };
}

export function text(t: string): Part {
  return { type: "text", text: t };
}

/** A fake model that replays scripted turns and records every request it received. */
export class ScriptedLlm implements LlmClient {
  readonly label = "scripted";
  readonly requests: LlmRequest[] = [];
  private readonly steps: Step[];

  constructor(...steps: Step[]) {
    this.steps = steps;
  }

  async create(req: LlmRequest): Promise<ModelResponse> {
    // Snapshot: the runner keeps appending to the same array.
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error("ScriptedLlm ran out of steps");
    const { content, stop_reason } = await step(req);
    return {
      parts: content,
      stopReason: stop_reason ?? (content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn"),
      model: "scripted",
      provider: "test",
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  }
}

export const turn =
  (...content: Part[]): Step =>
  () => ({ content });

export function testConfig(overrides: Partial<HaleyConfig> = {}): HaleyConfig {
  return {
    ...loadConfig({ HALEY_SECRET_KEY: randomBytes(32).toString("hex") }),
    dbPath: ":memory:",
    ...overrides,
  };
}

export async function makeApp(
  /** null: use the real model registry (profiles), as production does. */
  llm: LlmClient | null = new ScriptedLlm(),
  overrides: Partial<HaleyConfig> = {},
  fetchImpl?: typeof fetch,
  mailTransport?: { sendMail(options: Record<string, unknown>): Promise<unknown> },
) {
  return buildApp({ config: testConfig(overrides), llm: llm ?? undefined, fetchImpl, mailTransport });
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  json: () => any;
}

/** A fetch stand-in that records calls and answers from a list of URL routes. */
export function fakeFetch(routes: Array<[RegExp, (call: FetchCall) => unknown]>) {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === "string" ? init.body : init.body ? String(init.body) : "";
    const call: FetchCall = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body,
      json: () => JSON.parse(body),
    };
    calls.push(call);
    const route = routes.find(([re]) => re.test(url));
    if (!route) return new Response(JSON.stringify({ error: `no route for ${url}` }), { status: 404 });
    const out = route[1](call);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  return { impl, calls };
}

/** The tool results in the most recent user turn the model was sent. */
export function lastToolResults(req: LlmRequest) {
  const last = req.messages[req.messages.length - 1];
  return last.parts
    .filter((p): p is Extract<Part, { type: "tool_result" }> => p.type === "tool_result")
    .map((p) => ({ tool_use_id: p.toolCallId, content: p.content, is_error: p.isError }));
}

/** The first user message's text: the context Haley was given. */
export function firstUserText(req: LlmRequest): string {
  return req.messages[0].parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
}
