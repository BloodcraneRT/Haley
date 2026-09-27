import { randomBytes } from "node:crypto";
import type { LlmClient, LlmRequest, Message } from "../src/agent/llm.js";
import { buildApp } from "../src/app.js";
import { loadConfig, type HaleyConfig } from "../src/config.js";

type Block = Message["content"][number];
type StepResult = { content: Array<Record<string, unknown>>; stop_reason?: Message["stop_reason"] };
type Step = (req: LlmRequest) => StepResult | Promise<StepResult>;

let counter = 0;

export function toolUse(name: string, input: unknown, id = `toolu_${++counter}`) {
  return { type: "tool_use", id, name, input };
}

export function text(t: string) {
  return { type: "text", text: t, citations: null };
}

/** A fake model that replays scripted turns and records every request it received. */
export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly steps: Step[];

  constructor(...steps: Step[]) {
    this.steps = steps;
  }

  async create(req: LlmRequest): Promise<Message> {
    // Snapshot: the runner keeps appending to the same array.
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error("ScriptedLlm ran out of steps");
    const { content, stop_reason } = await step(req);
    return {
      id: `msg_${++counter}`,
      type: "message",
      role: "assistant",
      model: "scripted",
      content: content as unknown as Block[],
      stop_reason: stop_reason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    } as unknown as Message;
  }
}

export const turn =
  (...content: Array<Record<string, unknown>>): Step =>
  () => ({ content });

export function testConfig(overrides: Partial<HaleyConfig> = {}): HaleyConfig {
  return {
    ...loadConfig({ HALEY_SECRET_KEY: randomBytes(32).toString("hex") }),
    dbPath: ":memory:",
    ...overrides,
  };
}

export async function makeApp(
  llm: LlmClient = new ScriptedLlm(),
  overrides: Partial<HaleyConfig> = {},
  fetchImpl?: typeof fetch,
  mailTransport?: { sendMail(options: Record<string, unknown>): Promise<unknown> },
) {
  return buildApp({ config: testConfig(overrides), llm, fetchImpl, mailTransport });
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

/** The tool_result blocks in the most recent user turn the model was sent. */
export function lastToolResults(req: LlmRequest) {
  const last = req.messages[req.messages.length - 1];
  if (typeof last.content === "string") return [];
  return last.content.filter((b) => b.type === "tool_result") as Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
}
