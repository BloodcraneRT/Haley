import { describe, expect, it } from "vitest";
import { HuduApi, huduBase, huduTools } from "../src/connectors/hudu/tools.js";
import { stripSecrets, validatePublicHttpsUrl } from "../src/connectors/http.js";
import { ItGlueApi, itglueHost, itGlueTools } from "../src/connectors/itglue/tools.js";
import { ninjaHost, NinjaOneApi } from "../src/connectors/ninjaone/api.js";
import { ninjaOneTools } from "../src/connectors/ninjaone/tools.js";
import { checkPath, parseRestConfig, RestApi, restTools } from "../src/connectors/rest/tools.js";
import type { HaleyTool } from "../src/connectors/types.js";
import { fakeFetch, makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

const ctx = { orgId: "o", runId: "r", ticketId: null };
const tool = (tools: HaleyTool[], name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};
/** Runs a tool the way the runner does: parse the input with its schema first. */
const call = (tools: HaleyTool[], name: string, input: unknown) => {
  const t = tool(tools, name);
  return t.run(t.input.parse(input), ctx) as Promise<any>;
};
const noContent = () => new Response(null, { status: 204 });

// ------------------------------------------------------------------ NinjaOne

const ORG = 77;
const laptop = {
  id: 101,
  organizationId: ORG,
  systemName: "ACME-LT-01",
  displayName: "Pat's laptop",
  nodeClass: "WINDOWS_WORKSTATION",
  offline: false,
  lastContact: 1_790_000_000.5,
  assignedOwnerUid: "owner-uid",
  lastLoggedInUser: "ACME\\pat",
  os: { name: "Windows 11 Pro", buildNumber: "22631", needsReboot: true, lastBootTime: 1_789_000_000 },
  system: { manufacturer: "Dell", model: "Latitude 7440", serialNumber: "SN101" },
};
const otherOrgDevice = { id: 202, organizationId: 88, systemName: "OTHER-SRV-01" };

function ninjaFetch() {
  return fakeFetch([
    [/\/ws\/oauth\/token$/, () => ({ access_token: "tok", token_type: "bearer", expires_in: 3600 })],
    [/\/v2\/organization\/77\/devices(\?|$)/, () => [{ ...laptop, os: undefined }, { id: 103, organizationId: ORG, systemName: "ACME-SRV-01", offline: true }]],
    [/\/v2\/organization\/77\/end-users$/, () => [{ uid: "owner-uid", email: "Pat@acme.example", organizationId: ORG }]],
    [/\/v2\/organization\/77$/, () => ({ id: ORG, name: "Acme" })],
    [/\/v2\/device\/101\/volumes$/, () => [{ driveLetter: "C:", capacity: 256 * 1024 ** 3, freeSpace: 4 * 1024 ** 3, fileSystem: "NTFS" }]],
    [/\/v2\/device\/101\/os-patches/, () => [{ name: "2026-09 Cumulative Update", kbNumber: "KB5099999", severity: "CRITICAL" }]],
    [/\/v2\/device\/101\/script\/run$/, noContent],
    [/\/v2\/device\/101\/reboot\/NORMAL$/, noContent],
    [/\/v2\/device\/101$/, () => laptop],
    [/\/v2\/device\/202/, () => otherOrgDevice],
    [
      /\/v2\/alerts/,
      () => [
        { uid: "a1", deviceId: 101, severity: "MAJOR", subject: "Disk C: below 5%", createTime: 1_790_000_100 },
        { uid: "a2", deviceId: 202, severity: "CRITICAL", subject: "Other client's server down", createTime: 1_790_000_200 },
      ],
    ],
    [
      /\/v2\/automation\/scripts/,
      () => [
        { id: 5, name: "Clear print spooler", language: "powershell", active: true },
        { id: 6, name: "Wipe user profile", language: "powershell", active: true },
        { id: 7, name: "Old script", active: false },
      ],
    ],
  ]);
}

describe("NinjaOne connector", () => {
  it("maps regions to known instances only", () => {
    expect(ninjaHost("eu")).toBe("eu.ninjarmm.com");
    expect(ninjaHost("")).toBe("app.ninjarmm.com");
    expect(ninjaHost("https://oc.ninjarmm.com/")).toBe("oc.ninjarmm.com");
    expect(() => ninjaHost("evil.example.com")).toThrow(/Unknown NinjaOne region/);
  });

  it("gets a client-credentials token and stays inside the client's organization", async () => {
    const fake = ninjaFetch();
    const api = new NinjaOneApi({ host: ninjaHost("eu"), clientId: "cid", clientSecret: "csecret" }, fake.impl);
    const tools = ninjaOneTools(api, ORG);

    const device = await call(tools, "ninja_get_device", { device: "acme-lt-01" });
    expect(device).toMatchObject({ id: 101, name: "ACME-LT-01", os: { name: "Windows 11 Pro", needsReboot: true }, volumes: [{ name: "C:", freeGB: 4 }] });
    expect(device.pendingPatches.count).toBe(1);

    const token = fake.calls.find((c) => c.url.endsWith("/ws/oauth/token"))!;
    expect(token.url).toBe("https://eu.ninjarmm.com/ws/oauth/token");
    expect(token.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({
      grant_type: "client_credentials",
      client_id: "cid",
      client_secret: "csecret",
      scope: "monitoring management",
    });
    expect(fake.calls.filter((c) => c.url.endsWith("/ws/oauth/token"))).toHaveLength(1);
    expect(fake.calls.find((c) => c.url.includes("/v2/device/101"))!.headers.authorization).toBe("Bearer tok");

    // A device id from another NinjaOne organization is refused, for reads and for actions.
    await expect(call(tools, "ninja_get_device", { device: "202" })).rejects.toThrow(/isn't in this client's NinjaOne organization/);
    await expect(call(tools, "ninja_run_script", { device: "202", script: "Clear print spooler" })).rejects.toThrow(/isn't in this client's/);
    await expect(call(tools, "ninja_reboot_device", { device: "202" })).rejects.toThrow(/isn't in this client's/);
    expect(fake.calls.some((c) => c.method === "POST" && c.url.includes("/v2/device/202"))).toBe(false);
    // The failed lookup makes target resolution throw, so the runner sends the call to a technician.
    await expect(tool(tools, "ninja_run_script").resolveTargets!({ device: "202", script: "5" })).rejects.toThrow();

    const alerts = await call(tools, "ninja_list_alerts", {});
    expect(alerts.map((a: { uid: string }) => a.uid)).toEqual(["a1"]);
    expect(decodeURIComponent(fake.calls.find((c) => c.url.includes("/v2/alerts"))!.url.replace(/\+/g, " "))).toContain("df=org = 77");

    const list = await call(tools, "ninja_list_devices", { offlineOnly: true });
    expect(list.devices.map((d: { name: string }) => d.name)).toEqual(["ACME-SRV-01"]);
  });

  it("runs an existing script with the documented request shape", async () => {
    const fake = ninjaFetch();
    const tools = ninjaOneTools(new NinjaOneApi({ host: "app.ninjarmm.com", clientId: "c", clientSecret: "s" }, fake.impl), ORG);
    const run = tool(tools, "ninja_run_script");
    expect(run.risk).toBe("write");
    const input = run.input.parse({ device: "ACME-LT-01", script: "Clear print spooler", parameters: "-Force" });
    expect(run.describe!(input)).toBe('Run NinjaOne script "Clear print spooler" on ACME-LT-01 with parameters "-Force"');
    // The device owner is the account the call affects.
    expect(await run.resolveTargets!(input)).toEqual(["pat@acme.example"]);
    expect(await run.guard!(input)).toBeNull();
    expect(await run.guard!(run.input.parse({ device: "ACME-LT-01", script: "Wipe user profile" }))).toMatch(/technician reviews/);
    await expect(call(tools, "ninja_run_script", { device: "ACME-LT-01", script: "Old script" })).rejects.toThrow(/No active NinjaOne script/);

    const result = await run.run(input, ctx);
    expect(result).toMatchObject({ started: true, deviceId: 101, scriptId: 5 });
    const post = fake.calls.find((c) => c.url.endsWith("/v2/device/101/script/run"))!;
    expect(post.method).toBe("POST");
    expect(post.json()).toEqual({ type: "SCRIPT", id: 5, parameters: "-Force", runAs: "system" });
  });

  it("only ever sends a normal reboot, as a destructive action", async () => {
    const fake = ninjaFetch();
    const tools = ninjaOneTools(new NinjaOneApi({ host: "app.ninjarmm.com", clientId: "c", clientSecret: "s" }, fake.impl), ORG);
    const reboot = tool(tools, "ninja_reboot_device");
    expect(reboot.risk).toBe("destructive");
    // A "mode" the model makes up is dropped by the schema.
    await call(tools, "ninja_reboot_device", { device: "101", mode: "FORCED", reason: "Pending updates" });
    const posts = fake.calls.filter((c) => c.method === "POST" && c.url.includes("/reboot/"));
    expect(posts.map((c) => c.url)).toEqual(["https://app.ninjarmm.com/v2/device/101/reboot/NORMAL"]);
    expect(posts[0].json()).toEqual({ reason: "Pending updates" });
  });
});

// ------------------------------------------------------------------ IT Glue

describe("IT Glue connector", () => {
  const doc = (id: string, org: number, extra: Record<string, unknown> = {}) => ({
    id,
    type: "documents",
    attributes: { "organization-id": org, name: `VPN setup ${id}`, "updated-at": "2026-01-01T00:00:00Z", "resource-url": `https://x.itglue.com/${org}/docs/${id}`, ...extra },
  });

  function itgFetch() {
    return fakeFetch([
      [/\/organizations\/9\/relationships\/documents\/55$/, () => ({
        data: doc("55", 9, {
          password: "hunter2",
          sections: [
            { attributes: { "resource-type": "Document::Text", content: "<p>Install the <b>client</b>.</p>", sort: 1, "api-key": "abc" } },
            { attributes: { "resource-type": "Document::Heading", content: "Overview", level: 2, sort: 0 } },
          ],
        }),
      })],
      [/\/organizations\/9\/relationships\/documents\/56$/, () => ({ data: doc("56", 10) })],
      [/\/organizations\/9\/relationships\/documents/, () => ({ data: [doc("55", 9), doc("60", 10), { ...doc("61", 9), attributes: { ...doc("61", 9).attributes, name: "Printer notes" } }] })],
      [/\/organizations\/9\/relationships\/configurations/, () => ({
        data: [
          { id: "1", type: "configurations", attributes: { "organization-id": 9, name: "ACME-FW-01", "primary-ip": "10.0.0.1", "serial-number": "FW1", "configuration-type-name": "Firewall" } },
          { id: "2", type: "configurations", attributes: { "organization-id": 10, name: "OTHER-FW-01" } },
        ],
      })],
    ]);
  }

  it("reads documents and configurations for the client's organization only", async () => {
    const fake = itgFetch();
    const api = new ItGlueApi({ host: itglueHost("eu"), apiKey: "ITG.key" }, fake.impl);
    const tools = itGlueTools(api, "9");

    const search = await call(tools, "itglue_search_documents", { search: "vpn" });
    expect(search.documents.map((d: { id: string }) => d.id)).toEqual(["55"]);
    const listCall = fake.calls[0];
    expect(listCall.url).toContain("https://api.eu.itglue.com/organizations/9/relationships/documents");
    expect(listCall.headers["x-api-key"]).toBe("ITG.key");
    expect(decodeURIComponent(listCall.url)).toContain("filter[document_folder_id]=null");

    const full = await call(tools, "itglue_get_document", { id: "55" });
    expect(full.content).toBe("## Overview\n\nInstall the client.");
    expect(JSON.stringify(full)).not.toMatch(/hunter2|password|abc/);
    await expect(call(tools, "itglue_get_document", { id: "56" })).rejects.toThrow(/isn't in this client's IT Glue organization/);

    const configs = await call(tools, "itglue_list_configurations", {});
    expect(configs.configurations.map((c: { name: string }) => c.name)).toEqual(["ACME-FW-01"]);
    expect(fake.calls.some((c) => /password/i.test(c.url))).toBe(false);
  });

  it("never calls a password endpoint and validates ids", async () => {
    const fake = itgFetch();
    const api = new ItGlueApi({ host: "api.itglue.com", apiKey: "k" }, fake.impl);
    await expect(api.get("/organizations/9/relationships/passwords")).rejects.toThrow(/doesn't read IT Glue passwords/);
    expect(fake.calls).toHaveLength(0);
    expect(() => tool(itGlueTools(api, "9"), "itglue_get_document").input.parse({ id: "../passwords" })).toThrow();
    expect(() => itglueHost("evil.example.com")).toThrow(/Unknown IT Glue region/);
  });
});

// ------------------------------------------------------------------ Hudu

describe("Hudu connector", () => {
  function huduFetch() {
    return fakeFetch([
      [/\/api\/v1\/articles\/10$/, () => ({ article: { id: 10, name: "Someone else's", company_id: 4, content: "<p>x</p>" } })],
      [/\/api\/v1\/articles\/11$/, () => ({ article: { id: 11, name: "VPN", company_id: 3, content: "<h2>VPN</h2><p>Use <i>FortiClient</i>&nbsp;7.</p>" } })],
      [/\/api\/v1\/articles/, () => ({
        articles: [
          { id: 11, name: "VPN", company_id: 3, content: "<p>Use FortiClient</p>" },
          { id: 10, name: "VPN (other client)", company_id: 4 },
          { id: 12, name: "Global VPN article", company_id: null },
          { id: 13, name: "Draft", company_id: 3, draft: true },
        ],
      })],
      [/\/api\/v1\/assets/, () => ({
        assets: [
          {
            id: 1,
            name: "ACME-FW-01",
            company_id: 3,
            asset_type: "Firewall",
            password: "top-secret",
            fields: [
              { label: "Admin Password", value: "hunter2" },
              { label: "WiFi PSK passphrase", value: "psk-value" },
              { label: "Management IP", value: "10.0.0.1" },
            ],
          },
          { id: 2, name: "OTHER-FW", company_id: 4, fields: [] },
        ],
      })],
    ]);
  }

  it("normalizes and validates the base URL", () => {
    expect(huduBase("https://docs.acme-msp.com/api/v1/")).toBe("https://docs.acme-msp.com");
    expect(() => huduBase("http://docs.acme-msp.com")).toThrow(/https/);
    expect(() => huduBase("https://192.168.1.10")).toThrow(/IP address/);
  });

  it("searches the client's company only and strips password fields", async () => {
    const fake = huduFetch();
    const tools = huduTools(new HuduApi({ baseUrl: huduBase("https://docs.acme-msp.com"), apiKey: "hudu-key" }, fake.impl), 3);

    const articles = await call(tools, "hudu_search_articles", { search: "vpn" });
    expect(articles.articles.map((a: { id: number }) => a.id)).toEqual([11]);
    const url = new URL(fake.calls[0].url);
    expect(url.origin + url.pathname).toBe("https://docs.acme-msp.com/api/v1/articles");
    expect(url.searchParams.get("company_id")).toBe("3");
    expect(url.searchParams.get("search")).toBe("vpn");
    expect(fake.calls[0].headers["x-api-key"]).toBe("hudu-key");

    expect((await call(tools, "hudu_get_article", { id: 11 })).content).toBe("VPN\nUse FortiClient 7.");
    await expect(call(tools, "hudu_get_article", { id: 10 })).rejects.toThrow(/isn't one of this client's/);

    const assets = await call(tools, "hudu_search_assets", { search: "fw" });
    expect(assets.assets).toHaveLength(1);
    expect(assets.assets[0].fields).toEqual([{ label: "Management IP", value: "10.0.0.1" }]);
    expect(JSON.stringify(assets)).not.toMatch(/hunter2|psk-value|top-secret/);
    expect(fake.calls.some((c) => /password/i.test(c.url))).toBe(false);
  });

  it("strips credential-looking keys but keeps look-alikes", () => {
    expect(
      stripSecrets({ name: "a", password: "x", otp_secret: "y", "api-key": "z", apiToken: "t", userPin: "1", pinned: true, footprint: 3, bypass: "ok", nested: [{ passcode: "p", ok: 1 }] }),
    ).toEqual({ name: "a", pinned: true, footprint: 3, bypass: "ok", nested: [{ ok: 1 }] });
  });
});

// ------------------------------------------------------------------ generic REST

describe("generic REST connector", () => {
  const base = { name: "hr", baseUrl: "https://api.example.com/v1", authValue: "Bearer s3cr3t-token-value" };

  it("rejects unsafe base URLs", () => {
    for (const url of [
      "http://api.example.com",
      "https://localhost/api",
      "https://localhost./api",
      "https://app.localhost",
      "https://10.1.2.3",
      "https://169.254.169.254/latest/meta-data",
      "https://127.0.0.1",
      "https://2130706433",
      "https://[::1]",
      "https://user:pw@api.example.com",
      "https://metadata.google.internal",
      "https://intranet",
      "ftp://api.example.com",
      "https://api.example.com/?x=1",
    ]) {
      expect(() => validatePublicHttpsUrl(url), url).toThrow();
    }
    expect(validatePublicHttpsUrl("https://api.example.com/v1").host).toBe("api.example.com");
  });

  it("validates the name and header", () => {
    expect(() => parseRestConfig({ ...base, name: "Bad-Name" })).toThrow(/Name must be/);
    expect(() => parseRestConfig({ ...base, name: "a_very_long_name_over_20" })).toThrow(/Name must be/);
    expect(() => parseRestConfig({ ...base, authHeader: "Host" })).toThrow(/can't be used/);
    expect(() => parseRestConfig({ ...base, authValue: "x\r\nEvil: 1" })).toThrow(/line breaks/);
    expect(parseRestConfig(base)).toMatchObject({ authHeader: "Authorization", allowWrites: false, allowedPaths: [] });
  });

  it("rejects paths that escape the base URL or the allowed prefixes", async () => {
    for (const path of ["../etc/passwd", "/v1/../admin", "/users/%2e%2e/admin", "//evil.com/x", "https://evil.com/x", "/https://evil.com", "/users\\..\\x", "/users?x=1", "/users/./x", "users"]) {
      expect(() => checkPath(path), path).toThrow();
    }
    const fake = fakeFetch([[/.*/, () => ({ ok: true })]]);
    const tools = restTools(new RestApi(parseRestConfig({ ...base, allowedPaths: "/users, /groups/" }), fake.impl));
    await expect(call(tools, "api_hr_get", { path: "/admin/keys" })).rejects.toThrow(/isn't allowed/);
    await expect(call(tools, "api_hr_get", { path: "/usersX" })).rejects.toThrow(/isn't allowed/);
    await expect(call(tools, "api_hr_get", { path: "//evil.com/users" })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
    await call(tools, "api_hr_get", { path: "/users/42", query: { expand: "manager" } });
    await call(tools, "api_hr_get", { path: "/groups" });
    expect(fake.calls.map((c) => c.url)).toEqual(["https://api.example.com/v1/users/42?expand=manager", "https://api.example.com/v1/groups"]);
  });

  it("sends the auth header but never returns it", async () => {
    const fake = fakeFetch([[/\/echo$/, (c) => ({ youSent: c.headers, token: "s3cr3t-token-value" })]]);
    const tools = restTools(new RestApi(parseRestConfig({ ...base, authHeader: "X-Api-Key", authValue: "Bearer s3cr3t-token-value" }), fake.impl));
    const out = await call(tools, "api_hr_get", { path: "/echo" });
    expect(fake.calls[0].headers["x-api-key"]).toBe("Bearer s3cr3t-token-value");
    expect(out.status).toBe(200);
    expect(JSON.stringify(out)).not.toContain("s3cr3t-token-value");
    expect(JSON.stringify(out)).toContain("[redacted]");
  });

  it("only exposes writes when allowed, with DELETE as a destructive tool", async () => {
    expect(restTools(new RestApi(parseRestConfig(base))).map((t) => t.name)).toEqual(["api_hr_get"]);
    const fake = fakeFetch([[/.*/, (c) => ({ method: c.method })]]);
    const tools = restTools(new RestApi(parseRestConfig({ ...base, allowWrites: "true" }), fake.impl));
    expect(tools.map((t) => [t.name, t.risk])).toEqual([
      ["api_hr_get", "read"],
      ["api_hr_write", "write"],
      ["api_hr_delete", "destructive"],
    ]);
    const write = tool(tools, "api_hr_write");
    expect(write.describe!(write.input.parse({ method: "PATCH", path: "/users/42", body: { title: "CFO" } }))).toBe('PATCH api.example.com/v1/users/42 with {"title":"CFO"}');
    expect(() => write.input.parse({ method: "DELETE", path: "/users/42" })).toThrow();
    const del = tool(tools, "api_hr_delete");
    expect(del.describe!({ path: "/users/42" })).toBe("DELETE api.example.com/v1/users/42");
    await call(tools, "api_hr_write", { method: "POST", path: "/users", body: { name: "New" } });
    await call(tools, "api_hr_delete", { path: "/users/42" });
    expect(fake.calls.map((c) => [c.method, c.body])).toEqual([
      ["POST", '{"name":"New"}'],
      ["DELETE", ""],
    ]);
  });

  it("refuses redirects instead of following them", async () => {
    const seen: RequestInit[] = [];
    const impl = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 302, headers: { location: "https://evil.example.net/steal" } });
    }) as unknown as typeof fetch;
    const tools = restTools(new RestApi(parseRestConfig(base), impl));
    await expect(call(tools, "api_hr_get", { path: "/users" })).rejects.toThrow(/redirect \(302 to https:\/\/evil\.example\.net\/steal\)/);
    expect(seen[0].redirect).toBe("manual");
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("truncates large responses to about 20 KB", async () => {
    const big = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `User number ${i}`, email: `user${i}@example.com` }));
    const fake = fakeFetch([[/.*/, () => big]]);
    const out = await call(restTools(new RestApi(parseRestConfig(base), fake.impl)), "api_hr_get", { path: "/users" });
    expect(out.truncated).toBe(true);
    expect(typeof out.body).toBe("string");
    expect(out.body.length).toBeLessThanOrEqual(20_000);

    const small = await call(restTools(new RestApi(parseRestConfig(base), fakeFetch([[/.*/, () => big.slice(0, 3)]]).impl)), "api_hr_get", { path: "/users" });
    expect(small).toMatchObject({ truncated: false, body: big.slice(0, 3) });
  });
});

// ------------------------------------------------------------------ end to end

describe("connectors in the app", () => {
  it("rejects unsafe or malformed config when connecting", async () => {
    const { app } = await makeApp(new ScriptedLlm());
    const org = (await app.inject({ method: "POST", url: "/api/orgs", payload: { name: "Acme" } })).json();
    const connect = (provider: string, config: Record<string, string>) =>
      app.inject({ method: "POST", url: `/api/orgs/${org.id}/integrations`, payload: { provider, config } });
    const rest = await connect("rest", { name: "hr", baseUrl: "http://10.0.0.5/api", authValue: "k" });
    expect(rest.statusCode).toBe(400);
    expect(rest.json().error ?? rest.body).toMatch(/https/);
    expect((await connect("ninjaone", { clientId: "c", clientSecret: "s", region: "evil.com", organizationId: "1" })).statusCode).toBe(400);
    expect((await connect("hudu", { baseUrl: "https://localhost", apiKey: "k", companyId: "3" })).statusCode).toBe(400);
    expect((await connect("itglue", { apiKey: "k", organizationId: "abc" })).statusCode).toBe(400);
  });

  it("holds a NinjaOne script run for approval under the supervised policy", async () => {
    const fake = ninjaFetch();
    const llm = new ScriptedLlm(
      turn(text("Clearing the stuck print queue on Pat's laptop."), toolUse("ninja_run_script", { device: "ACME-LT-01", script: "Clear print spooler" })),
      turn(text("Queued; waiting for the run to finish.")),
    );
    const { app, store, agent } = await makeApp(llm, {}, fake.impl);
    const org = (await app.inject({ method: "POST", url: "/api/orgs", payload: { name: "Acme", domain: "acme.example", autonomy: "supervised" } })).json();
    const connected = await app.inject({
      method: "POST",
      url: `/api/orgs/${org.id}/integrations`,
      payload: { provider: "ninjaone", config: { clientId: "c", clientSecret: "s", region: "app", organizationId: String(ORG) } },
    });
    expect(connected.json()).toMatchObject({ status: "connected", status_detail: expect.stringContaining('organization "Acme" has 2 devices (1 offline)') });

    const run = agent.startTaskRun(org.id, "Pat's printing is stuck", "Pat's printing is stuck", "tech");
    await agent.settled(run.id);
    const [action] = store.listActions({ runId: run.id });
    expect(action).toMatchObject({
      tool: "ninja_run_script",
      status: "pending_approval",
      description: 'Run NinjaOne script "Clear print spooler" on ACME-LT-01',
      policy_reason: expect.stringContaining("Supervised"),
    });
    expect(fake.calls.some((c) => c.url.includes("/script/run"))).toBe(false);

    await agent.decideAction(action.id, true, "Jordan");
    await agent.settled(run.id);
    expect(store.listActions({ runId: run.id })[0].status).toBe("executed");
    expect(fake.calls.filter((c) => c.url.endsWith("/v2/device/101/script/run")).map((c) => c.json())).toEqual([{ type: "SCRIPT", id: 5, runAs: "system" }]);
  });
});
