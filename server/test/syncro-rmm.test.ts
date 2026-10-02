import { describe, expect, it } from "vitest";
import { decide } from "../src/agent/policy.js";
import { buildConnector, validateProviderConfig } from "../src/connectors/registry.js";
import { parseAllowedScripts } from "../src/connectors/syncro/tools.js";
import { MAX_ALERT_TICKETS_PER_POLL } from "../src/monitoring/syncroAlerts.js";
import { fakeFetch, lastToolResults, makeApp, ScriptedLlm, text, toolUse, turn, type FetchCall } from "./helpers.js";

const OURS = 77;
const OTHER = 88;
const asset = (id: number, name: string, customer: number, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  customer_id: customer,
  contact_id: customer === OURS ? 9 : null,
  asset_type: "Syncro Device",
  asset_serial: `SN${id}`,
  properties: { os_name: "Windows 11 Pro", api_key: "should-not-leak" },
  rmm_store: { triggers: { low_hd_space_triggered: "true", agent_offline_triggered: "false" } },
  ...extra,
});

/** A Syncro account with one device for our customer and one for another customer. */
function syncro(alerts: () => Array<Record<string, unknown>> = () => []) {
  return fakeFetch([
    [/\/customer_assets\/501\/patches/, () => ({
      installed_patches: [{ kb: "KB1", title: "Defender update", status: "Recently Installed" }],
      available_patches: [
        { kb: "KB2", title: "Cumulative update", category: "Security Updates", status: "Missing Patches" },
        { kb: "KB3", title: ".NET update", category: "Updates", status: "Failed Patches" },
      ],
      available_patches_meta: { total_entries: 2 },
    })],
    [/\/customer_assets\/501\/installed_applications/, () => ({ installed_applications: [{ name: "Google Chrome", vendor: "Google LLC", version: "123" }], meta: { total_pages: 1 } })],
    [/\/customer_assets\/501(\?|$)/, () => ({ asset: asset(501, "CON-LT-014", OURS) })],
    [/\/customer_assets\/502(\?|$)/, () => ({ asset: asset(502, "OTHER-PC", OTHER) })],
    [/\/customer_assets\/assets_by_contact\/9/, () => ({ assets: [asset(501, "CON-LT-014", OURS)], meta: { total_pages: 1 } })],
    [/\/customer_assets\?/, (call) => {
      const q = new URL(call.url).searchParams;
      const all = [asset(501, "CON-LT-014", OURS), asset(503, "CON-DT-002", OURS, { rmm_store: { triggers: {} } })];
      const query = q.get("query")?.toLowerCase();
      return { assets: Number(q.get("customer_id")) === OURS ? all.filter((a) => !query || a.name.toLowerCase().includes(query)) : [], meta: { total_pages: 1 } };
    }],
    [/\/contacts\?/, () => ({ contacts: [{ id: 9, name: "Megan Bowen", email: "megan.bowen@contoso.example", customer_id: OURS }], meta: { total_pages: 1 } })],
    [/\/rmm_alerts\/\d+\/mute/, () => ({ success: true })],
    [/\/rmm_alerts\/(\d+)$/, (call: FetchCall) => {
      const id = Number(/rmm_alerts\/(\d+)/.exec(call.url)![1]);
      if (call.method === "DELETE") return { success: "true" };
      const found = alerts().find((a) => a.id === id) ?? { id, customer_id: id === 999 ? OTHER : OURS, created_at: "2026-10-01T00:00:00Z" };
      return { rmm_alert: found };
    }],
    [/\/rmm_alerts\?/, (call) => {
      const after = new URL(call.url).searchParams.get("created_after");
      return { rmm_alerts: alerts().filter((a) => !after || Date.parse(String(a.created_at)) > Date.parse(after)), meta: { total_pages: 1 } };
    }],
    [/\/rmm\/public_scripts\/\d+\/schedule/, () => ({ message: "Ok, script scheduled." })],
  ]);
}

/** An instant written the way Syncro does, e.g. 2026-10-01T03:04:05.000-07:00. */
const withOffset = (ms: number) => new Date(ms - 7 * 3_600_000).toISOString().replace("Z", "-07:00");

const CONFIG = { subdomain: "yourmsp", apiKey: "syncro-token-secret", customerId: String(OURS), scripts: "4001: Clear print spooler\n4002 - Wipe user profile" };

async function connectorFor(net: ReturnType<typeof syncro>, config: Record<string, string> = CONFIG) {
  const haley = await makeApp(new ScriptedLlm(), {}, net.impl);
  const org = haley.store.createOrg({ name: "Contoso" });
  const integration = haley.store.createIntegration({ orgId: org.id, provider: "syncro_rmm", label: "Syncro", mode: "live", config });
  const connector = buildConnector(haley.store, integration, net.impl);
  const tool = (name: string) => connector.tools.find((t) => t.name === name)!;
  const ctx = { orgId: org.id, runId: "r", ticketId: null };
  return { ...haley, connector, tool, ctx };
}

describe("SyncroMSP RMM connector", () => {
  it("validates its configuration", () => {
    expect(validateProviderConfig("syncro_rmm", CONFIG)).toBeNull();
    expect(validateProviderConfig("syncro_rmm", { ...CONFIG, subdomain: "evil.example.com/x" })).toMatch(/subdomain/);
    expect(validateProviderConfig("syncro_rmm", { ...CONFIG, customerId: "abc" })).toMatch(/customer ID/);
    expect(validateProviderConfig("syncro_rmm", { ...CONFIG, scripts: "clear spooler" })).toMatch(/script line/);
    expect(validateProviderConfig("syncro_rmm", { ...CONFIG, alertTickets: "yes" })).toMatch(/true or false/);
    expect(parseAllowedScripts("4001: Clear print spooler\n\n4003\n4001, duplicate")).toEqual([
      { id: 4001, name: "Clear print spooler" },
      { id: 4003, name: "Script 4003" },
    ]);
  });

  it("lists and inspects only this customer's devices, with health flags and patch status", async () => {
    const net = syncro();
    const { tool, ctx } = await connectorFor(net);
    const list = (await tool("syncro_list_devices").run({ withIssuesOnly: true }, ctx)) as { devices: Array<{ name: string; healthIssues: string[] }> };
    expect(list.devices).toEqual([expect.objectContaining({ name: "CON-LT-014", healthIssues: ["Low disk space"] })]);
    expect(net.calls[0].headers.authorization).toBe("Bearer syncro-token-secret");
    expect(net.calls[0].url).toContain("https://yourmsp.syncromsp.com/api/v1/customer_assets?customer_id=77");

    const byUser = (await tool("syncro_list_devices").run({ user: "megan.bowen@contoso.example" }, ctx)) as { devices: unknown[] };
    expect(byUser.devices).toHaveLength(1);

    const device = (await tool("syncro_get_device").run({ device: "con-lt-014" }, ctx)) as Record<string, any>;
    expect(device).toMatchObject({ id: 501, assignedTo: { email: "megan.bowen@contoso.example" }, patches: { missing: 1, failed: 1 } });
    expect(device.properties).toContain("Windows 11 Pro");
    expect(device.properties).not.toContain("should-not-leak");

    await expect(tool("syncro_get_device").run({ device: "502" }, ctx)).rejects.toThrow(/isn't one of this client's/);
    const apps = (await tool("syncro_list_software").run({ device: "501", search: "chrome" }, ctx)) as { count: number };
    expect(apps.count).toBe(1);
  });

  it("runs only allowed scripts, and only on this customer's devices", async () => {
    const net = syncro();
    const { tool, ctx } = await connectorFor(net);
    const run = tool("syncro_run_script");
    expect(run.risk).toBe("write");
    expect(await run.guard!({ device: "CON-LT-014", script: "Clear print spooler" })).toBeNull();
    expect(await run.guard!({ device: "CON-LT-014", script: "4002" })).toMatch(/technician reviews/);
    await expect(run.guard!({ device: "CON-LT-014", script: "9999" })).rejects.toThrow(/isn't one of the Syncro scripts/);
    expect(await run.resolveTargets!({ device: "501", script: "4001" })).toEqual(["megan.bowen@contoso.example"]);

    await expect(run.run({ device: "502", script: "4001" }, ctx)).rejects.toThrow(/isn't one of this client's/);
    expect(await run.run({ device: "CON-LT-014", script: "4001", variables: { service: "Spooler" } }, ctx)).toMatchObject({ queued: true, scriptId: 4001 });
    const post = net.calls.find((c) => c.url.includes("/public_scripts/501/schedule"))!;
    expect(post.json()).toEqual({ script_id: 4001, run_type: "now", freq: "once", script_options: { runtime_variables: { service: "Spooler" } } });
  });

  it("lists, mutes and clears only this customer's alerts", async () => {
    const alerts = [
      { id: 11, customer_id: OURS, asset_id: 501, computer_name: "CON-LT-014", description: "Low hd space", created_at: "2026-10-01T10:00:00Z" },
      { id: 12, customer_id: OTHER, asset_id: 502, computer_name: "OTHER-PC", description: "Offline", created_at: "2026-10-01T11:00:00Z" },
    ];
    const net = syncro(() => alerts);
    const { tool, ctx } = await connectorFor(net);
    const listed = (await tool("syncro_list_alerts").run({}, ctx)) as { alerts: Array<{ id: number }> };
    expect(listed.alerts.map((a) => a.id)).toEqual([11]);
    await expect(tool("syncro_clear_alert").run({ alertId: 12, reason: "not ours" }, ctx)).rejects.toThrow(/isn't for this client/);
    expect(await tool("syncro_mute_alert").run({ alertId: 11, duration: "1-day" }, ctx)).toMatchObject({ muted: true });
    expect(net.calls.some((c) => c.method === "POST" && c.url.includes("/rmm_alerts/11/mute?mute_for=1-day"))).toBe(true);
    expect(await tool("syncro_clear_alert").run({ alertId: 11, reason: "Cleaned temp files" }, ctx)).toMatchObject({ cleared: true });
    expect(net.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/rmm_alerts/11"))).toBe(true);
    expect(net.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/rmm_alerts/12"))).toBe(false);
  });

  it("refuses redirects instead of sending the token on", async () => {
    const net = fakeFetch([[/./, () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })]]);
    const { tool, ctx } = await connectorFor(net as ReturnType<typeof syncro>);
    await expect(tool("syncro_list_devices").run({}, ctx)).rejects.toThrow(/redirect/);
    expect(net.calls).toHaveLength(1);
  });
});

describe("monitoring-alert policy", () => {
  const base = { grantsAccess: false, targets: [], protectedTargets: [], changesLastHour: 0, maxChangesPerHour: 30, selfServiceToday: 0, maxSelfServicePerDay: 3 };
  const monitoring = { email: null, assurance: "none" as const, authorized: false, monitoring: true };

  it("runs routine fixes in unattended mode but still asks for sensitive ones", () => {
    expect(decide({ ...base, autonomy: "unattended", risk: "write", requester: monitoring }).outcome).toBe("run");
    expect(decide({ ...base, autonomy: "unattended", risk: "destructive", requester: monitoring })).toMatchObject({ outcome: "approve", code: "sensitive" });
    expect(decide({ ...base, autonomy: "unattended", risk: "write", grantsAccess: true, requester: monitoring })).toMatchObject({ outcome: "approve" });
    expect(decide({ ...base, autonomy: "unattended", risk: "write", requester: monitoring, changesLastHour: 30 })).toMatchObject({ code: "rate_limit" });
    expect(decide({ ...base, autonomy: "supervised", risk: "write", requester: monitoring }).outcome).toBe("approve");
    // Without the monitoring flag, an unverified requester still waits.
    expect(decide({ ...base, autonomy: "unattended", risk: "write", requester: { ...monitoring, monitoring: false } })).toMatchObject({ code: "unverified" });
  });
});

describe("alert-driven tickets", () => {
  async function setup(llm: ScriptedLlm, alerts: Array<Record<string, unknown>>, config: Record<string, string> = { ...CONFIG, alertTickets: "true" }) {
    const net = syncro(() => alerts);
    const haley = await makeApp(llm, {}, net.impl);
    await haley.app.inject({ method: "POST", url: "/api/demo" });
    const org = haley.store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
    haley.store.updateOrg(org.id, { autonomy: "unattended" });
    haley.store.createIntegration({ orgId: org.id, provider: "syncro_rmm", label: "Syncro", mode: "live", config });
    return { ...haley, net, org };
  }

  it("opens a ticket per new alert for this customer and lets Haley fix and clear it", async () => {
    const start = Date.now();
    const at = (min: number) => new Date(start + min * 60_000).toISOString();
    const alerts: Array<Record<string, unknown>> = [
      { id: 1, customer_id: OURS, asset_id: 501, computer_name: "CON-LT-014", description: "Low hd space", formatted_output: "C: has 2% free", created_at: at(-120) },
    ];
    const llm = new ScriptedLlm(
      turn(toolUse("syncro_run_script", { device: "CON-LT-014", script: "4001" }), toolUse("syncro_clear_alert", { alertId: 21, reason: "Freed space with the cleanup script" })),
      turn(text("Ran the cleanup and cleared the alert.")),
    );
    const { scheduler, store, agent, org, net } = await setup(llm, alerts);

    // The first check only sets the starting point: the existing alert isn't ticketed.
    await scheduler.tick(start);
    expect(store.listTickets({ orgId: org.id }).filter((t) => t.channel === "monitoring")).toHaveLength(0);

    alerts.push(
      // Syncro's own format: local time with an offset.
      { id: 21, customer_id: OURS, asset_id: 501, computer_name: "CON-LT-014", description: "Low hd space", formatted_output: "C: has 1% free", created_at: withOffset(start + 60_000) },
      { id: 22, customer_id: OTHER, asset_id: 502, computer_name: "OTHER-PC", description: "Offline", created_at: at(1) },
      { id: 23, customer_id: OURS, asset_id: 503, computer_name: "CON-DT-002", description: "Service stopped", created_at: at(1), ticket_number: 4410 },
    );
    // Too soon: checks run every two minutes.
    await scheduler.tick(start + 60_000);
    expect(store.listTickets({ orgId: org.id }).filter((t) => t.channel === "monitoring")).toHaveLength(0);

    await scheduler.tick(start + 3 * 60_000);
    const tickets = store.listTickets({ orgId: org.id }).filter((t) => t.channel === "monitoring");
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ title: "CON-LT-014: Low hd space", requester_email: "", assurance: "none" });
    expect(tickets[0].description).toContain("alert #21");
    const run = store.listRuns({ ticketId: tickets[0].id })[0];
    await agent.settled(run.id);

    // Unattended: the allowed script and the alert clear ran without a technician.
    const results = lastToolResults(llm.requests[1]);
    expect(results.map((r) => r.is_error)).toEqual([false, false]);
    expect(net.calls.some((c) => c.url.includes("/public_scripts/501/schedule"))).toBe(true);
    expect(net.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/rmm_alerts/21"))).toBe(true);
    expect(llm.requests[0].system).toContain("monitoring alert");

    // A repeat of the same alert notes the open ticket instead of opening another.
    alerts.push({ id: 24, customer_id: OURS, asset_id: 501, computer_name: "CON-LT-014", description: "Low HD space", created_at: at(4) });
    store.updateTicket(tickets[0].id, { status: "in_progress" }, "haley");
    await scheduler.tick(start + 6 * 60_000);
    expect(store.listTickets({ orgId: org.id }).filter((t) => t.channel === "monitoring")).toHaveLength(1);
    expect(store.listTicketEvents(tickets[0].id).some((e) => e.body.includes("#24"))).toBe(true);
  });

  it("caps tickets per check, and does nothing while off or paused", async () => {
    const start = Date.now();
    const alerts: Array<Record<string, unknown>> = [];
    const { scheduler, store, org } = await setup(new ScriptedLlm(...Array.from({ length: 20 }, () => turn(text("Looked.")))), alerts);
    store.updateOrg(org.id, { autonomy: "supervised" });
    await scheduler.tick(start);
    for (let i = 0; i < 8; i++) {
      alerts.push({ id: 100 + i, customer_id: OURS, asset_id: 600 + i, computer_name: `PC-${i}`, description: "Offline", created_at: new Date(start + 60_000 + i).toISOString() });
    }
    await scheduler.tick(start + 3 * 60_000);
    expect(store.listTickets({ orgId: org.id }).filter((t) => t.channel === "monitoring")).toHaveLength(MAX_ALERT_TICKETS_PER_POLL);
    await scheduler.tick(start + 6 * 60_000);
    expect(store.listTickets({ orgId: org.id }).filter((t) => t.channel === "monitoring")).toHaveLength(8);

    store.updateOrg(org.id, { settings: { paused: true } });
    alerts.push({ id: 200, customer_id: OURS, asset_id: 700, computer_name: "PC-X", description: "Offline", created_at: new Date(start + 7 * 60_000).toISOString() });
    await scheduler.tick(start + 9 * 60_000);
    expect(store.listTickets({ orgId: org.id }).filter((t) => t.channel === "monitoring")).toHaveLength(8);
  });

  it("leaves alerts alone unless alert tickets are turned on", async () => {
    const start = Date.now();
    const alerts = [{ id: 5, customer_id: OURS, asset_id: 501, computer_name: "CON-LT-014", description: "Offline", created_at: new Date(start + 60_000).toISOString() }];
    const { scheduler, store, org, net } = await setup(new ScriptedLlm(), alerts, CONFIG);
    await scheduler.tick(start);
    await scheduler.tick(start + 3 * 60_000);
    expect(store.listTickets({ orgId: org.id }).filter((t) => t.channel === "monitoring")).toHaveLength(0);
    expect(net.calls.filter((c) => c.url.includes("rmm_alerts"))).toHaveLength(0);
  });
});
