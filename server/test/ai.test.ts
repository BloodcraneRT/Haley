import { describe, expect, it } from "vitest";
import { AnthropicLlm } from "../src/ai/anthropic.js";
import { OpenAICompatibleLlm, toOpenAIMessages } from "../src/ai/openai.js";
import type { ChatMessage } from "../src/ai/types.js";
import { fakeFetch, makeApp, type FetchCall } from "./helpers.js";

/** A fake chat-completions server that answers with scripted assistant messages. */
function openAiServer(script: Array<Record<string, unknown> | number>, host = "api.openai.com") {
  const queue = [...script];
  return fakeFetch([
    [
      new RegExp(host.replace(/\./g, "\\.")),
      () => {
        const next = queue.shift();
        if (next === undefined) return new Response(JSON.stringify({ error: { message: "script exhausted" } }), { status: 500 });
        if (typeof next === "number") return new Response(JSON.stringify({ error: { message: `status ${next}` } }), { status: next });
        const hasCalls = Array.isArray(next.tool_calls) && next.tool_calls.length > 0;
        return {
          model: "served-model",
          choices: [{ message: { role: "assistant", ...next }, finish_reason: hasCalls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        };
      },
    ],
  ]);
}

const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

describe("OpenAI-compatible adapter", () => {
  it("converts tool calls and results to chat-completions messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "text", text: "checking" }, { type: "tool_call", id: "c1", name: "lookup", input: { q: 1 } }] },
      { role: "user", parts: [{ type: "tool_result", toolCallId: "c1", content: "nope", isError: true }] },
    ];
    expect(toOpenAIMessages("sys", messages)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "checking", tool_calls: [call("c1", "lookup", { q: 1 })] },
      { role: "tool", tool_call_id: "c1", content: "ERROR: nope" },
    ]);
  });

  it("parses tool calls, tolerates missing ids and bad JSON, and reports auth failures", async () => {
    const server = fakeFetch([
      [
        /ok\.example/,
        () => ({
          choices: [
            {
              finish_reason: "stop", // some servers say stop even with tool calls
              message: { content: null, tool_calls: [{ type: "function", function: { name: "a", arguments: "{bad" } }, { function: { name: "b", arguments: { x: 1 } } }] },
            },
          ],
        }),
      ],
      [/denied\.example/, () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 })],
    ]);
    const llm = new OpenAICompatibleLlm({ provider: "vllm", model: "m", endpoint: "http://ok.example/v1/chat/completions" }, server.impl);
    const res = await llm.create({ system: "s", messages: [], tools: [] });
    expect(res.stopReason).toBe("tool_use");
    expect(res.parts).toEqual([
      { type: "tool_call", id: expect.stringMatching(/^call_/), name: "a", input: { __invalid_json: "{bad" } },
      { type: "tool_call", id: expect.stringMatching(/^call_/), name: "b", input: { x: 1 } },
    ]);
    expect(server.calls[0].headers.authorization).toBeUndefined();
    const denied = new OpenAICompatibleLlm({ provider: "openai", model: "m", endpoint: "http://denied.example/v1/chat/completions", apiKey: "k" }, server.impl);
    await expect(denied.create({ system: "s", messages: [], tools: [] })).rejects.toThrow(/authentication failed.*invalid key/);
  });
});

describe("Anthropic adapter", () => {
  function fakeAnthropic(capture: unknown[]) {
    return {
      beta: {
        messages: {
          stream: (params: unknown) => {
            capture.push(params);
            return {
              finalMessage: async () => ({
                model: "claude-opus-5",
                stop_reason: "end_turn",
                content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "done" }],
                usage: { input_tokens: 5, output_tokens: 2 },
              }),
            };
          },
        },
      },
    } as never;
  }

  it("replays its own turns natively and converts other providers' turns", async () => {
    const capture: Array<{ messages: Array<{ content: unknown }> }> = [];
    const llm = new AnthropicLlm({ model: "claude-opus-5" }, fakeAnthropic(capture));
    const native = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "x", input: {} }];
    const res = await llm.create({
      system: "s",
      tools: [],
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        { role: "assistant", parts: [{ type: "tool_call", id: "toolu_1", name: "x", input: {} }], native: { provider: "anthropic", model: "claude-opus-5", content: native } },
        { role: "user", parts: [{ type: "tool_result", toolCallId: "toolu_1", content: "ok", isError: false }] },
        { role: "assistant", parts: [{ type: "tool_call", id: "call.abc:1", name: "y", input: {} }] },
        { role: "user", parts: [{ type: "tool_result", toolCallId: "call.abc:1", content: "ok", isError: false }] },
      ],
    });
    const sent = capture[0].messages;
    expect(sent[1].content).toBe(native);
    expect(sent[3].content).toEqual([{ type: "tool_use", id: "call_abc_1", name: "y", input: {} }]);
    expect(sent[4].content).toEqual([{ type: "tool_result", tool_use_id: "call_abc_1", content: "ok", is_error: false }]);
    expect(res).toMatchObject({ parts: [{ type: "text", text: "done" }], stopReason: "end_turn", provider: "anthropic" });
    expect(res.native?.content).toHaveLength(2);
  });
});

describe("model profiles", () => {
  async function setup(fetchImpl: typeof fetch) {
    const haley = await makeApp(null, {}, fetchImpl);
    await haley.app.inject({ method: "POST", url: "/api/demo" });
    return haley;
  }

  it("bootstraps a Claude default and never returns API keys", async () => {
    const { app, store } = await setup(fakeFetch([]).impl);
    const [bootstrap] = (await app.inject({ url: "/api/models" })).json();
    expect(bootstrap).toMatchObject({ provider: "anthropic", is_default: true, has_key: false });
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { name: "GPT", provider: "openai", model: "gpt-x", apiKey: "sk-secret-123" },
    });
    expect(created.json()).toMatchObject({ has_key: true, is_default: false });
    expect(JSON.stringify((await app.inject({ url: "/api/models" })).json())).not.toContain("sk-secret-123");
    const raw = store.db.prepare("SELECT api_key_sealed FROM model_profiles WHERE name = 'GPT'").get() as { api_key_sealed: string };
    expect(raw.api_key_sealed).not.toContain("sk-secret-123");
    expect((await app.inject({ method: "DELETE", url: `/api/models/${bootstrap.id}` })).statusCode).toBe(409);
    const needsUrl = await app.inject({ method: "POST", url: "/api/models", payload: { name: "Azure", provider: "azure_openai", model: "dep" } });
    expect(needsUrl.statusCode).toBe(400);
  });

  it("runs Haley end to end on an OpenAI-compatible model", async () => {
    const server = openAiServer([
      { content: "Looking up Isaiah.", tool_calls: [call("call_1", "m365_get_user", { user: "isaiah.langer@contoso.example" })] },
      { content: "Isaiah's account is enabled; no MFA registered." },
    ]);
    const { app, store, agent } = await setup(server.impl);
    const gpt = (await app.inject({ method: "POST", url: "/api/models", payload: { name: "GPT", provider: "openai", model: "gpt-x", apiKey: "sk-1", isDefault: true } })).json();
    expect(gpt.is_default).toBe(true);

    const ticket = store.listTickets().find((t) => t.title.startsWith("Isaiah"))!;
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);

    expect(store.getRun(run.id)!.error).toBe("");
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", model: "openai/served-model", summary: expect.stringContaining("no MFA") });
    const [first, second] = server.calls.map((c: FetchCall) => c.json());
    expect(server.calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(server.calls[0].headers.authorization).toBe("Bearer sk-1");
    expect(first.messages[0]).toMatchObject({ role: "system" });
    expect(first.tools.find((t: { function: { name: string } }) => t.function.name === "m365_reset_password").function.parameters.type).toBe("object");
    const toolMsg = second.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(JSON.parse(toolMsg.content).userPrincipalName).toBe("isaiah.langer@contoso.example");
  });

  it("falls back to the next model when one fails, and honors per-client models", async () => {
    const primary = openAiServer([503, 503], "primary.example");
    const backup = openAiServer([{ content: "Handled by the backup." }, { content: "Handled by the backup again." }], "backup.example");
    const local = openAiServer([{ content: "Handled locally." }], "localhost");
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("primary.example")) return primary.impl(url, init);
      if (u.includes("backup.example")) return backup.impl(url, init);
      return local.impl(url, init);
    }) as typeof fetch;
    const { app, store, agent } = await setup(fetchImpl);
    const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/models", payload }).then((r) => r.json());
    const backupModel = await post({ name: "Backup", provider: "openai_compatible", baseUrl: "https://backup.example/v1", model: "b" });
    await post({ name: "Primary", provider: "openai_compatible", baseUrl: "https://primary.example/v1", model: "p", fallbackId: backupModel.id, isDefault: true });
    const ollama = await post({ name: "Local Qwen", provider: "ollama", model: "qwen3:32b" });

    const [contosoTicket] = store.listTickets().filter((t) => t.title.startsWith("Isaiah"));
    const run = agent.startTicketRun(contosoTicket.id, "tech");
    await agent.settled(run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", model: "openai_compatible/served-model", summary: "Handled by the backup." });
    expect(primary.calls).toHaveLength(1);

    const acme = store.listOrgs().find((o) => o.name.startsWith("Acme"))!;
    await app.inject({ method: "PATCH", url: `/api/orgs/${acme.id}`, payload: { settings: { modelProfileId: ollama.id } } });
    const acmeTicket = store.listTickets({ orgId: acme.id })[0];
    const acmeRun = agent.startTicketRun(acmeTicket.id, "tech");
    await agent.settled(acmeRun.id);
    expect(store.getRun(acmeRun.id)).toMatchObject({ summary: "Handled locally.", model: "ollama/served-model" });
    expect(local.calls[0].url).toBe("http://localhost:11434/v1/chat/completions");

    const bad = await app.inject({ method: "PATCH", url: `/api/orgs/${acme.id}`, payload: { settings: { modelProfileId: "mdl_nope" } } });
    expect(bad.statusCode).toBe(400);
  });

  it("builds Azure OpenAI deployment URLs with the api-key header", async () => {
    const server = fakeFetch([[/contoso-ai\.openai\.azure\.com/, () => ({ choices: [{ message: { content: "ok", tool_calls: [call("c", "ping", {})] }, finish_reason: "tool_calls" }] })]]);
    const { app } = await setup(server.impl);
    const azure = (
      await app.inject({
        method: "POST",
        url: "/api/models",
        payload: { name: "Azure", provider: "azure_openai", baseUrl: "https://contoso-ai.openai.azure.com", model: "gpt-deploy", apiKey: "az-key", options: { apiVersion: "2025-01-01" } },
      })
    ).json();
    const test = (await app.inject({ method: "POST", url: `/api/models/${azure.id}/test` })).json();
    expect(test).toMatchObject({ ok: true, toolCalling: true });
    expect(server.calls[0].url).toBe("https://contoso-ai.openai.azure.com/openai/deployments/gpt-deploy/chat/completions?api-version=2025-01-01");
    expect(server.calls[0].headers["api-key"]).toBe("az-key");
  });

  it("continues a run on a different provider after an approval pause", async () => {
    const first = openAiServer([{ content: "Resetting.", tool_calls: [call("call_r", "m365_reset_password", { user: "isaiah.langer@contoso.example" })] }], "first.example");
    const second = openAiServer([{ content: "Reset done by the second model." }], "second.example");
    const fetchImpl = (async (url: string | URL, init?: RequestInit) =>
      (String(url).includes("first.example") ? first : second).impl(url, init)) as typeof fetch;
    const { app, store, agent } = await setup(fetchImpl);
    const a = (await app.inject({ method: "POST", url: "/api/models", payload: { name: "A", provider: "openai_compatible", baseUrl: "https://first.example/v1", model: "a", isDefault: true } })).json();
    const b = (await app.inject({ method: "POST", url: "/api/models", payload: { name: "B", provider: "openai_compatible", baseUrl: "https://second.example/v1", model: "b" } })).json();
    const ticket = store.listTickets().find((t) => t.title.startsWith("Isaiah"))!;
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    const [pending] = store.listActions({ status: "pending_approval" });
    await app.inject({ method: "PATCH", url: `/api/models/${b.id}`, payload: { isDefault: true } });
    await agent.decideAction(pending.id, true, "Jordan");
    await agent.settled(run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", summary: "Reset done by the second model." });
    const sent = second.calls[0].json();
    const assistant = sent.messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistant.tool_calls[0]).toMatchObject({ id: "call_r", function: { name: "m365_reset_password" } });
    expect(sent.messages.find((m: { role: string }) => m.role === "tool").content).toContain("held for a technician");
    expect(a.id).not.toBe(b.id);
  });
});
