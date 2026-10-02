import { describe, expect, it } from "vitest";
import { HuduApi, huduTools } from "../src/connectors/hudu/tools.js";
import { ItGlueApi, itGlueTools } from "../src/connectors/itglue/tools.js";
import { NinjaOneApi } from "../src/connectors/ninjaone/api.js";
import { ninjaOneTools } from "../src/connectors/ninjaone/tools.js";
import { parseRestConfig, RestApi, urlFor } from "../src/connectors/rest/tools.js";
import type { HaleyTool } from "../src/connectors/types.js";
import { fakeFetch, lastToolResults, makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

const ctx = { orgId: "o", runId: "r", ticketId: null };
const call = (tools: HaleyTool[], name: string, input: unknown) => {
  const tool = tools.find((candidate) => candidate.name === name)!;
  return tool.run(tool.input.parse(input), ctx) as Promise<any>;
};

describe("REST failed changes", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("rejects a failed %s and scrubs the echoed credential", async (method) => {
    const config = parseRestConfig({ name: "hr", baseUrl: "https://api.example.com", authValue: "Bearer secret-token-value" });
    const net = fakeFetch([[/.*/, () => Response.json({ message: "Rejected Bearer secret-token-value" }, { status: 422 })]]);
    const api = new RestApi(config, net.impl);
    await expect(api.call(method, urlFor(config, "/users/42"))).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/422.*\[redacted\]/) });
    await expect(api.call(method, urlFor(config, "/users/42"))).rejects.not.toThrow(/secret-token-value/);
  });

  it("records an upstream failure as failed and tells the model it is an error", async () => {
    const net = fakeFetch([[/.*/, (request) => request.method === "GET" ? { ok: true } : Response.json({ message: "Unavailable" }, { status: 500 })]]);
    const llm = new ScriptedLlm(
      turn(toolUse("api_hr_write", { method: "PATCH", path: "/users/42", body: { title: "CFO" } })),
      turn(text("The API change failed.")),
    );
    const { app, store, agent } = await makeApp(llm, {}, net.impl);
    try {
      const org = (await app.inject({ method: "POST", url: "/api/orgs", payload: { name: "Acme", autonomy: "autonomous" } })).json();
      const integration = await app.inject({ method: "POST", url: `/api/orgs/${org.id}/integrations`, payload: { provider: "rest", config: { name: "hr", baseUrl: "https://api.example.com", authValue: "secret", allowWrites: "true" } } });
      expect(integration.statusCode).toBe(200);
      const run = agent.startTaskRun(org.id, "Update title", "Update title", "tech");
      await agent.settled(run.id);
      expect(store.listActions({ runId: run.id })[0]).toMatchObject({ status: "failed", result: { error: expect.stringContaining("500") } });
      expect(lastToolResults(llm.requests[1])[0]).toMatchObject({ is_error: true, content: expect.stringContaining("500") });
    } finally {
      await app.close();
    }
  });

  it.each([
    { secret: "s".repeat(400), prefix: "Rejected " },
    { secret: "secret-token-value", prefix: "x".repeat(290) },
  ])("scrubs echoed credentials before shortening errors", async ({ secret, prefix }) => {
    const config = parseRestConfig({ name: "hr", baseUrl: "https://api.example.com", authValue: `Bearer ${secret}` });
    const net = fakeFetch([[/.*/, () => Response.json({ message: `${prefix}Bearer ${secret}` }, { status: 422 })]]);
    const failure = new RestApi(config, net.impl).call("PATCH", urlFor(config, "/users/42")).catch((error: Error) => error.message);
    const message = await failure;
    expect(message).toEqual(expect.stringContaining("422"));
    expect(message).not.toContain(secret.slice(0, 3));
  });

  it.each([String.raw`abc\defghijkl`, 'abc"defghijkl'])("redacts JSON-escaped credentials in errors and successful responses", async (secret) => {
    const config = parseRestConfig({ name: "hr", baseUrl: "https://api.example.com", authHeader: "X-Api-Key", authValue: secret });
    const net = fakeFetch([[/.*/, (request) => Response.json({ message: `Echoed ${secret}` }, { status: request.method === "GET" ? 200 : 422 })]]);
    const api = new RestApi(config, net.impl);
    await expect(api.call("PATCH", urlFor(config, "/users/42"))).rejects.toThrow(/\[redacted\]/);
    expect((await api.call("GET", urlFor(config, "/users/42"))).body).toEqual({ message: "Echoed [redacted]" });
  });
});

const ninjaFleet = (size: number, duplicates = false) => {
  const devices = Array.from({ length: size }, (_, index) => ({ id: index + 1, organizationId: 77, systemName: duplicates && (index === 0 || index === size - 1) ? "DUPLICATE" : `DEVICE-${index + 1}` }));
  const net = fakeFetch([
    [/oauth\/token/, () => ({ access_token: "t" })],
    [/organization\/77\/devices/, (request) => devices.filter((device) => device.id > Number(new URL(request.url).searchParams.get("after") ?? 0)).slice(0, 1000)],
    [/device\/\d+$/, (request) => devices.find((device) => device.id === Number(new URL(request.url).pathname.split("/").pop()))],
    [/volumes|os-patches|automation\/scripts/, () => []],
  ]);
  return { net, api: new NinjaOneApi({ host: "app.ninjarmm.com", clientId: "c", clientSecret: "s" }, net.impl) };
};

describe("NinjaOne complete device resolution", () => {
  it("rejects a fleet above the limit instead of returning a partial inventory", async () => {
    const { api } = ninjaFleet(5001);
    await expect(api.organizationDevices(77)).rejects.toThrow(/incomplete|limit/i);
  });

  it("accepts exactly the limit after an empty probe page", async () => {
    const { api, net } = ninjaFleet(5000);
    expect(await api.organizationDevices(77)).toHaveLength(5000);
    expect(net.calls.filter((request) => request.url.includes("/devices"))).toHaveLength(6);
  });

  it("rejects duplicate names across pages", async () => {
    const { api } = ninjaFleet(1001, true);
    await expect(call(ninjaOneTools(api, 77), "ninja_get_device", { device: "DUPLICATE" })).rejects.toThrow(/matches 2 devices/);
  });

  it("cannot start a script after a hidden duplicate makes the inventory incomplete", async () => {
    const { api, net } = ninjaFleet(5001, true);
    await expect(call(ninjaOneTools(api, 77), "ninja_run_script", { device: "DUPLICATE", script: "5" })).rejects.toThrow(/incomplete|limit/i);
    expect(net.calls.some((request) => request.url.includes("/script/run"))).toBe(false);
  });
});

describe("documentation connector pagination", () => {
  it.each(["articles", "assets"] as const)("reads Hudu %s beyond the first page", async (kind) => {
    const net = fakeFetch([[new RegExp(`/api/v1/${kind}`), (request) => {
      const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
      return { [kind]: page === 1 ? Array.from({ length: 25 }, (_, index) => ({ id: index + 1, company_id: 3, name: "First page" })) : [{ id: 26, company_id: 3, name: "Last page" }] };
    }]]);
    const api = new HuduApi({ baseUrl: "https://docs.example.com", apiKey: "k" }, net.impl);
    const result = await call(huduTools(api, 3), kind === "assets" ? "hudu_search_assets" : "hudu_search_articles", {});
    expect(result.count).toBe(26);
    expect(result[kind].some((item: { id: number }) => item.id === 26)).toBe(true);
    expect(net.calls).toHaveLength(2);
  });

  it.each([5000, 5001])("proves completeness or rejects a Hudu collection with %i assets", async (size) => {
    const net = fakeFetch([[/api\/v1\/assets/, (request) => {
      const start = (Number(new URL(request.url).searchParams.get("page") ?? 1) - 1) * 25;
      return { assets: Array.from({ length: Math.max(0, Math.min(25, size - start)) }, (_, index) => ({ id: start + index + 1, company_id: 3 })) };
    }]]);
    const result = call(huduTools(new HuduApi({ baseUrl: "https://docs.example.com", apiKey: "k" }, net.impl), 3), "hudu_search_assets", {});
    if (size === 5000) {
      const output = await result;
      expect(output.count).toBe(size);
      expect(output.truncated).toBe(true);
      expect(output.assets).toHaveLength(50);
    }
    else await expect(result).rejects.toThrow(/incomplete|limit/i);
    expect(net.calls).toHaveLength(201);
  });

  it("finds an IT Glue document whose name matches only on page two", async () => {
    const net = fakeFetch([[/relationships\/documents/, (request) => ({ data: new URL(request.url).searchParams.get("page[number]") === "2"
      ? [{ id: "1001", type: "documents", attributes: { "organization-id": 9, name: "VPN" } }]
      : Array.from({ length: 1000 }, (_, index) => ({ id: String(index + 1), type: "documents", attributes: { "organization-id": 9, name: "Printer" } })) })]]);
    const result = await call(itGlueTools(new ItGlueApi({ host: "api.itglue.com", apiKey: "k" }, net.impl), "9"), "itglue_search_documents", { search: "VPN" });
    expect(result.documents.map((document: { id: string }) => document.id)).toEqual(["1001"]);
    expect(net.calls).toHaveLength(2);
  });

  it.each([5000, 5001])("proves completeness or rejects an IT Glue collection with %i configurations", async (size) => {
    const net = fakeFetch([[/relationships\/configurations/, (request) => {
      const start = (Number(new URL(request.url).searchParams.get("page[number]") ?? 1) - 1) * 1000;
      return { data: Array.from({ length: Math.max(0, Math.min(1000, size - start)) }, (_, index) => ({ id: String(start + index + 1), type: "configurations", attributes: { "organization-id": 9 } })) };
    }]]);
    const result = call(itGlueTools(new ItGlueApi({ host: "api.itglue.com", apiKey: "k" }, net.impl), "9"), "itglue_list_configurations", {});
    if (size === 5000) {
      const output = await result;
      expect(output.count).toBe(size);
      expect(output.truncated).toBe(true);
      expect(output.configurations).toHaveLength(100);
    }
    else await expect(result).rejects.toThrow(/incomplete|limit/i);
    expect(net.calls).toHaveLength(6);
  });
});
