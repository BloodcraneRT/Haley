import { describe, expect, it } from "vitest";
import { SentinelOneApi, sentinelOneBase } from "../src/connectors/sentinelone/api.js";
import { sentinelOneTools } from "../src/connectors/sentinelone/tools.js";
import { buildConnector, validateProviderConfig } from "../src/connectors/registry.js";
import { AlertTickets } from "../src/monitoring/alerts.js";
import { sentinelOneAlertSource } from "../src/monitoring/sentinelOneAlerts.js";
import { fakeFetch, makeApp, ScriptedLlm, text, turn } from "./helpers.js";

const CONSOLE = "https://usea1-msp.sentinelone.net";
const SITE = "111";
const ctx = { orgId: "o", runId: "r", ticketId: null };

const threat = (id: string, extra: Record<string, unknown> = {}, info: Record<string, unknown> = {}) => ({
  id,
  threatInfo: {
    threatName: "evil.exe",
    classification: "Malware",
    confidenceLevel: "malicious",
    mitigationStatus: "not_mitigated",
    analystVerdict: "undefined",
    incidentStatus: "unresolved",
    createdAt: new Date().toISOString(),
    filePath: "C:\\Users\\megan\\Downloads\\evil.exe",
    sha1: "abc123",
    detectionType: "static",
    ...info,
  },
  agentRealtimeInfo: { agentId: "900", agentComputerName: "MEGAN-LT", siteId: SITE },
  agentDetectionInfo: { agentLastLoggedInUserName: "megan" },
  ...extra,
});

/** A SentinelOne console whose threats the test sets; only site 111's are returned for a site filter. */
function console1(state: { threats: ReturnType<typeof threat>[] }) {
  return fakeFetch([
    [/\/web\/api\/v2\.1\/sites\?/, () => ({ data: { sites: [{ id: SITE, name: "Contoso", activeLicenses: 12 }] } })],
    [/\/web\/api\/v2\.1\/agents\?/, (c) => {
      const url = new URL(c.url);
      const agents = [{ id: "900", computerName: "MEGAN-LT", siteId: SITE, networkStatus: "connected", infected: true, activeThreats: 1 }];
      return { data: url.searchParams.get("ids") && url.searchParams.get("ids") !== "900" ? [] : agents, pagination: { nextCursor: null } };
    }],
    [/\/web\/api\/v2\.1\/threats\?/, (c) => {
      const url = new URL(c.url);
      const ids = url.searchParams.get("ids")?.split(",");
      return { data: state.threats.filter((t) => !ids || ids.includes(t.id)), pagination: { nextCursor: null } };
    }],
    [/\/web\/api\/v2\.1\/(threats\/(incident|analyst-verdict|mitigate\/[a-z-]+)|agents\/actions\/(dis)?connect)$/, () => ({ data: { affected: 1 } })],
  ]);
}

describe("SentinelOne connector", () => {
  it("only talks to SentinelOne consoles, over https", () => {
    expect(sentinelOneBase("usea1-msp.sentinelone.net")).toBe("https://usea1-msp.sentinelone.net/web/api/v2.1");
    expect(sentinelOneBase("https://usgov.s1gov.net/")).toBe("https://usgov.s1gov.net/web/api/v2.1");
    expect(() => sentinelOneBase("https://evil.example")).toThrow("SentinelOne console URL");
    expect(() => sentinelOneBase("http://usea1-msp.sentinelone.net")).toThrow();
    expect(validateProviderConfig("sentinelone", { consoleUrl: CONSOLE, apiToken: "t", siteId: "abc" })).toBe("SentinelOne site ID must be a number.");
    expect(validateProviderConfig("sentinelone", { consoleUrl: CONSOLE, apiToken: "t", siteId: "111", alertTickets: "maybe" })).toContain("true or false");
    expect(validateProviderConfig("sentinelone", { consoleUrl: CONSOLE, apiToken: "t", siteId: "111" })).toBeNull();
  });

  it("tests the connection and scopes every read to the client's site", async () => {
    const net = console1({ threats: [threat("5001")] });
    const { store } = await makeApp(new ScriptedLlm());
    const org = store.createOrg({ name: "Contoso", domain: "contoso.example" });
    const integration = store.createIntegration({ orgId: org.id, provider: "sentinelone", label: "S1", mode: "live", config: { consoleUrl: CONSOLE, apiToken: "s1-token", siteId: SITE } });
    const connector = buildConnector(store, integration, net.impl);
    expect(await connector.test()).toBe('Connected to usea1-msp.sentinelone.net; site "Contoso" has 1 devices and 1 unresolved threat.');
    for (const c of net.calls) {
      expect(c.headers.authorization).toBe("ApiToken s1-token");
      expect(new URL(c.url).searchParams.get("siteIds")).toBe(SITE);
    }
    const list = connector.tools.find((t) => t.name === "s1_list_threats")!;
    expect(await list.run({ unresolvedOnly: true }, ctx)).toEqual([expect.objectContaining({ id: "5001", name: "evil.exe", device: "MEGAN-LT", mitigation: "not_mitigated", sha1: "abc123" })]);
  });

  it("acts only on this site's threats and devices, with the site in every action's filter", async () => {
    const state = { threats: [threat("5001")] };
    const net = console1(state);
    const tools = sentinelOneTools(new SentinelOneApi({ consoleUrl: CONSOLE, apiToken: "t" }, SITE, net.impl));
    const tool = (name: string) => tools.find((t) => t.name === name)!;

    await tool("s1_mitigate_threat").run({ threatId: "5001", action: "quarantine" }, ctx);
    const mitigate = net.calls.find((c) => c.url.endsWith("/threats/mitigate/quarantine"))!;
    expect(mitigate.json()).toEqual({ filter: { ids: ["5001"], siteIds: [SITE] } });

    await tool("s1_update_threat").run({ threatId: "5001", incidentStatus: "resolved", verdict: "false_positive" }, ctx);
    expect(net.calls.find((c) => c.url.endsWith("/threats/analyst-verdict"))!.json()).toEqual({ filter: { ids: ["5001"], siteIds: [SITE] }, data: { analystVerdict: "false_positive" } });
    expect(net.calls.find((c) => c.url.endsWith("/threats/incident"))!.json().data).toEqual({ incidentStatus: "resolved" });

    // A threat that isn't on this site is refused before anything is sent.
    const before = net.calls.filter((c) => c.method === "POST").length;
    await expect(tool("s1_mitigate_threat").run({ threatId: "7777", action: "kill" }, ctx)).rejects.toThrow("isn't on this client's SentinelOne site");
    await expect(tool("s1_disconnect_device").run({ device: "OTHER-PC", reason: "x" }, ctx)).rejects.toThrow('No device "OTHER-PC"');
    expect(net.calls.filter((c) => c.method === "POST").length).toBe(before);

    await tool("s1_disconnect_device").run({ device: "megan-lt", reason: "Ransomware" }, ctx);
    expect(net.calls.at(-1)!.json()).toEqual({ filter: { ids: ["900"], siteIds: [SITE] } });
  });

  it("rates the tools so containment always needs approval and network isolation a technician", () => {
    const tools = sentinelOneTools(new SentinelOneApi({ consoleUrl: CONSOLE, apiToken: "t" }, SITE, fakeFetch([]).impl));
    const by = Object.fromEntries(tools.map((t) => [t.name, { risk: t.risk, rail: t.rail ?? null }]));
    expect(by).toEqual({
      s1_list_devices: { risk: "read", rail: null },
      s1_get_device: { risk: "read", rail: null },
      s1_list_threats: { risk: "read", rail: null },
      s1_get_threat: { risk: "read", rail: null },
      s1_update_threat: { risk: "write", rail: null },
      s1_mitigate_threat: { risk: "destructive", rail: null },
      s1_disconnect_device: { risk: "destructive", rail: "technician_only" },
      s1_reconnect_device: { risk: "destructive", rail: null },
    });
  });
});

describe("SentinelOne threat tickets", () => {
  it("opens a ticket for each new threat, adds repeats to it, and skips resolved ones", async () => {
    const state = { threats: [] as ReturnType<typeof threat>[] };
    const net = console1(state);
    const { app, store, agent } = await makeApp(new ScriptedLlm(turn(text("Triaging.")), turn(text("Triaging."))));
    const org = store.createOrg({ name: "Contoso", domain: "contoso.example" });
    store.createIntegration({ orgId: org.id, provider: "sentinelone", label: "S1", mode: "live", config: { consoleUrl: CONSOLE, apiToken: "t", siteId: SITE, alertTickets: "true" } });
    const alerts = new AlertTickets(store, agent, [sentinelOneAlertSource(net.impl)]);

    // The first check only sets the starting point.
    state.threats = [threat("4000", {}, { createdAt: new Date(Date.now() - 3_600_000).toISOString() })];
    expect((await alerts.poll(Date.now(), true)).created).toEqual([]);

    state.threats = [
      threat("5001"),
      threat("5002", {}, { incidentStatus: "resolved", sha1: "zzz" }),
      threat("5003", { agentRealtimeInfo: { agentId: "901", agentComputerName: "SAM-PC", siteId: SITE } }, { threatName: "miner.exe", sha1: "def456", classification: "PUA" }),
    ];
    const first = await alerts.poll(Date.now() + 1000, true);
    expect(first.created).toHaveLength(2);
    const tickets = store.listTickets({ orgId: org.id }).filter((t) => t.channel === "monitoring");
    const megan = tickets.find((t) => t.title.startsWith("MEGAN-LT"))!;
    expect(megan).toMatchObject({ title: "MEGAN-LT: Malware evil.exe", requester_name: "SentinelOne" });
    expect(megan.channel_ref).toMatchObject({ source: "sentinelone", threatId: "5001", agentId: "900" });
    expect(megan.description).toContain("Mitigation status: not_mitigated");
    expect(megan.description).toContain("Don't kill, quarantine, roll back or disconnect anything without a technician's approval.");

    // The same file detected again on the same device goes on the open ticket.
    state.threats = [threat("5004")];
    const again = await alerts.poll(Date.now() + 2000, true);
    expect(again).toMatchObject({ created: [], updated: [megan.id] });
    for (const t of tickets) {
      const run = store.listRuns({ ticketId: t.id })[0];
      if (run) await agent.settled(run.id);
    }
    await app.close();
  });
});
