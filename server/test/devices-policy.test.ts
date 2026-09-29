import { describe, expect, it } from "vitest";
import { accountMatches, applyRails, applyRules, decide, toolMatches, type Decision, type Requester } from "../src/agent/policy.js";
import { signConsentState, verifyConsentState } from "../src/routes/m365Onboarding.js";
import type { PolicyRule } from "../src/types.js";
import { fakeFetch, lastToolResults, makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

const rule = (r: Partial<PolicyRule> & Pick<PolicyRule, "effect">): PolicyRule => ({
  id: "r1",
  name: "test rule",
  enabled: true,
  tools: [],
  risks: [],
  targets: [],
  departments: [],
  requesters: [],
  approvers: [],
  minAssurance: "directory",
  ...r,
});

const chatUser: Requester = { email: "megan.bowen@contoso.example", assurance: "chat", authorized: false };
const ctx = (over: Partial<Parameters<typeof applyRules>[2]> = {}) => ({
  tool: "m365_sync_device",
  risk: "write" as const,
  targets: ["megan.bowen@contoso.example"],
  departments: [],
  requester: chatUser,
  ...over,
});

describe("client policy rules", () => {
  it("matches tool globs and account patterns", () => {
    expect(toolMatches("m365_*_device", "m365_wipe_device")).toBe(true);
    expect(toolMatches("m365_*_device", "m365_get_bitlocker_key")).toBe(false);
    expect(toolMatches("gws.*", "gwsXreset")).toBe(false);
    expect(accountMatches("*@contoso.example", "Megan.Bowen@contoso.example")).toBe(true);
    expect(accountMatches("@contoso.example", "megan@contoso.example")).toBe(true);
    expect(accountMatches("@contoso.example", "megan@evilcontoso.example")).toBe(false);
    expect(accountMatches("ceo@contoso.example", "cfo@contoso.example")).toBe(false);
  });

  it("deny blocks, approve routes to named approvers, and the first match wins", () => {
    const run: Decision = { outcome: "run", reason: "", code: "ok" };
    const rules = [
      rule({ id: "a", name: "No device changes for execs", effect: "deny", tools: ["m365_*_device"], targets: ["ceo@contoso.example"] }),
      rule({ id: "b", name: "Finance approvals", effect: "approve", departments: ["finance"], approvers: ["Jordan"] }),
    ];
    expect(applyRules(run, rules, ctx({ targets: ["ceo@contoso.example"] }))).toMatchObject({ outcome: "block", reason: expect.stringContaining("No device changes") });
    expect(applyRules(run, rules, ctx({ departments: ["finance"] }))).toMatchObject({ outcome: "approve", approvers: ["Jordan"] });
    expect(applyRules(run, rules, ctx({ departments: ["sales"] }))).toBe(run);
    // Disabled rules are ignored; approve rules never loosen a block.
    expect(applyRules(run, [{ ...rules[0], enabled: false }], ctx({ targets: ["ceo@contoso.example"] }))).toBe(run);
    const blocked: Decision = { outcome: "block", reason: "read-only", code: "read_only" };
    expect(applyRules(blocked, [rules[1]], ctx({ departments: ["finance"] }))).toBe(blocked);
  });

  it("allow waives trust-based approvals only, and only with enough identity", () => {
    const allow = rule({ effect: "allow", tools: ["m365_sync_device"], minAssurance: "chat" });
    const supervised = decide({
      autonomy: "supervised",
      risk: "write",
      grantsAccess: false,
      requester: chatUser,
      targets: ["megan.bowen@contoso.example"],
      protectedTargets: [],
      changesLastHour: 0,
      maxChangesPerHour: 20,
      selfServiceToday: 0,
      maxSelfServicePerDay: 3,
    });
    expect(supervised.code).toBe("supervised");
    expect(applyRules(supervised, [allow], ctx())).toMatchObject({ outcome: "run", reason: expect.stringContaining("Allowed by") });
    // Not enough identity for this rule.
    expect(applyRules(supervised, [allow], ctx({ requester: { ...chatUser, assurance: "email" } }))).toBe(supervised);
    // Protected accounts, rate limits and weak identity are never waived.
    for (const code of ["protected", "rate_limit", "unverified", "weak_identity", "self_service_limit"] as const) {
      const base: Decision = { outcome: "approve", reason: code, code };
      expect(applyRules(base, [allow], ctx())).toBe(base);
    }
  });

  it("hard rails escalate but never relax", () => {
    const run: Decision = { outcome: "run", reason: "", code: "ok" };
    const tech: Requester = { email: null, assurance: "technician", authorized: true };
    expect(applyRails(run, "technician_only", null, [], tech)).toMatchObject({ outcome: "approve", code: "rail" });
    // self_only: the owner may self-serve; anyone else (even an authorized approver) needs a technician.
    expect(applyRails(run, "self_only", null, ["megan.bowen@contoso.example"], chatUser)).toBe(run);
    const manager: Requester = { email: "boss@contoso.example", assurance: "chat", authorized: true };
    expect(applyRails(run, "self_only", null, ["megan.bowen@contoso.example"], manager)).toMatchObject({ outcome: "approve" });
    expect(applyRails(run, "self_only", null, ["megan.bowen@contoso.example"], tech)).toBe(run);
    expect(applyRails(run, undefined, "admin group", [], tech)).toMatchObject({ outcome: "approve", reason: "admin group" });
    const blocked: Decision = { outcome: "block", reason: "x", code: "rule" };
    expect(applyRails(blocked, "technician_only", "g", [], tech)).toBe(blocked);
  });
});

async function contoso(llm: ScriptedLlm, autonomy: "supervised" | "autonomous" | "unattended" = "unattended") {
  const haley = await makeApp(llm);
  await haley.app.inject({ method: "POST", url: "/api/demo" });
  const org = haley.store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
  haley.store.updateOrg(org.id, { autonomy });
  return { ...haley, org };
}

describe("Intune device tools", () => {
  it("looks up a device with its installed apps", async () => {
    const llm = new ScriptedLlm(turn(toolUse("m365_get_device", { device: "con-lt-022", includeApps: true })), turn(text("Found it.")));
    const { store, agent, org } = await contoso(llm, "supervised");
    const run = agent.startTaskRun(org.id, "Check Isaiah's laptop", "Check Isaiah's laptop", "tech");
    await agent.settled(run.id);
    const [result] = lastToolResults(llm.requests[1]);
    const device = JSON.parse(result.content);
    expect(device).toMatchObject({ deviceName: "CON-LT-022", complianceState: "noncompliant", model: expect.any(String), serialNumber: expect.any(String) });
    expect(device.freeStorageGB).toBeLessThan(10);
    expect(device.installedApps.map((a: { name: string }) => a.name)).toContain("Adobe Acrobat Reader DC");
    expect(store.listActions({ runId: run.id })[0].status).toBe("executed");
  });

  it("gives a verified owner their own BitLocker key privately, never to the model", async () => {
    const llm = new ScriptedLlm(turn(toolUse("m365_get_bitlocker_key", { device: "CON-LT-022" })), turn(text("Sent your recovery key.")));
    const { app, store, agent, org } = await contoso(llm);
    const res = await app.inject({
      method: "POST",
      url: "/api/simulate",
      payload: { orgId: org.id, email: "isaiah.langer@contoso.example", name: "Isaiah", text: "My laptop is asking for a BitLocker recovery key" },
    });
    await agent.settled(res.json().runId);
    const [action] = store.listActions({ runId: res.json().runId });
    expect(action).toMatchObject({ tool: "m365_get_bitlocker_key", status: "executed", has_secrets: true });
    const secrets = store.revealActionSecrets(action.id)!;
    expect(secrets.recoveryKey).toMatch(/^\d{6}(-\d{6}){7} \(key ID [0-9a-f]{8}\)$/);
    const [result] = lastToolResults(llm.requests[1]);
    expect(result.content).toContain("sent privately");
    expect(JSON.stringify(llm.requests)).not.toContain(secrets.recoveryKey.slice(0, 20));
  });

  it("won't hand someone else's BitLocker key to a requester without a technician", async () => {
    const llm = new ScriptedLlm(turn(toolUse("m365_get_bitlocker_key", { device: "CON-LT-022" })), turn(text("Asked IT.")));
    const { app, store, agent, org } = await contoso(llm);
    // Even an authorized approver can't get another person's key on their own.
    store.updateOrg(org.id, { settings: { ...org.settings, authorizedRequesters: ["grady.archie@contoso.example"] } });
    const res = await app.inject({
      method: "POST",
      url: "/api/simulate",
      payload: { orgId: org.id, email: "grady.archie@contoso.example", name: "Grady", text: "Isaiah's laptop wants a BitLocker key" },
    });
    await agent.settled(res.json().runId);
    const [action] = store.listActions({ runId: res.json().runId });
    expect(action).toMatchObject({ status: "pending_approval", policy_reason: expect.stringContaining("Only the account's owner") });
  });

  it("always asks a technician before wiping or retiring, even on a technician's task", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("m365_wipe_device", { device: "CON-LT-009" }), toolUse("m365_sync_device", { device: "CON-LT-014" })),
      turn(text("Waiting on the wipe.")),
    );
    const { store, agent, org } = await contoso(llm);
    const run = agent.startTaskRun(org.id, "Wipe Pradeep's old laptop and sync Megan's", "Wipe Pradeep's old laptop and sync Megan's", "tech");
    await agent.settled(run.id);
    const actions = store.listActions({ runId: run.id });
    expect(actions.find((a) => a.tool === "m365_wipe_device")).toMatchObject({ status: "pending_approval", policy_reason: expect.stringContaining("always needs a technician") });
    expect(actions.find((a) => a.tool === "m365_sync_device")!.status).toBe("executed");
    await agent.decideAction(actions.find((a) => a.tool === "m365_wipe_device")!.id, true, "Jordan");
    await agent.settled(run.id);
    const m365 = store.listIntegrations(org.id).find((i) => i.provider === "m365")!;
    const devices = store.getIntegrationState<{ devices: Array<{ deviceName: string }> }>(m365.id)!.devices;
    expect(devices.map((d) => d.deviceName)).not.toContain("CON-LT-009");
  });

  it("runs an Intune remediation on a device", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("m365_list_remediations", {})),
      turn(toolUse("m365_run_remediation", { device: "CON-LT-014", remediation: "Clear Teams cache" })),
      turn(text("Started.")),
    );
    const { app, store, agent, org } = await contoso(llm);
    const res = await app.inject({
      method: "POST",
      url: "/api/simulate",
      payload: { orgId: org.id, email: "megan.bowen@contoso.example", name: "Megan", text: "Teams keeps crashing" },
    });
    await agent.settled(res.json().runId);
    const action = store.listActions({ runId: res.json().runId }).find((a) => a.tool === "m365_run_remediation")!;
    expect(action.status).toBe("executed");
    expect(action.result).toMatchObject({ remediation: "Clear Teams cache" });
  });

  it("makes adding someone to an admin group wait for a technician", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("m365_add_group_member", { user: "megan.bowen@contoso.example", group: "Global Admins (break-glass)" })),
      turn(text("Waiting.")),
    );
    const { store, agent, org } = await contoso(llm);
    const run = agent.startTaskRun(org.id, "Make Megan an admin", "Make Megan an admin", "tech");
    await agent.settled(run.id);
    expect(store.listActions({ runId: run.id })[0]).toMatchObject({ status: "pending_approval", policy_reason: expect.stringContaining("grants admin rights") });
  });
});

describe("client rules end to end", () => {
  it("blocks with a deny rule and routes approvals to named technicians", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("m365_restart_device", { device: "CON-LT-014" }), toolUse("m365_set_auto_reply", { user: "lynne.robbins@contoso.example", enabled: true })),
      turn(text("One blocked, one waiting.")),
    );
    const { app, store, agent, org } = await contoso(llm);
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/orgs/${org.id}`,
      payload: {
        settings: {
          policyRules: [
            { name: "No remote restarts", effect: "deny", tools: ["m365_restart_device"] },
            { name: "Finance needs the controller's sign-off", effect: "approve", departments: ["Finance"], approvers: ["Jordan"] },
          ],
        },
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().settings.policyRules[0].id).toMatch(/^rule_/);

    const run = agent.startTaskRun(org.id, "Restart Megan's laptop and turn on Lynne's out of office", "Restart Megan's laptop and turn on Lynne's out of office", "tech");
    await agent.settled(run.id);
    const actions = store.listActions({ runId: run.id });
    expect(actions.find((a) => a.tool === "m365_restart_device")).toMatchObject({ status: "blocked", policy_reason: expect.stringContaining("No remote restarts") });
    const ooo = actions.find((a) => a.tool === "m365_set_auto_reply")!;
    expect(ooo).toMatchObject({ status: "pending_approval", approvers: ["Jordan"] });

    const wrong = await app.inject({ method: "POST", url: `/api/actions/${ooo.id}/approve`, headers: { "x-haley-user": "Sam" }, payload: {} });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toContain("Jordan");
    const right = await app.inject({ method: "POST", url: `/api/actions/${ooo.id}/approve`, headers: { "x-haley-user": "jordan" }, payload: {} });
    expect(right.statusCode).toBe(200);
    await agent.settled(run.id);
    expect(store.getAction(ooo.id)!.status).toBe("executed");
  });

  it("lets an allow rule skip the sign-off for low-risk self-service in supervised mode", async () => {
    const llm = new ScriptedLlm(turn(toolUse("m365_sync_device", { device: "CON-LT-014" })), turn(text("Synced.")));
    const { app, store, agent, org } = await contoso(llm, "supervised");
    await app.inject({
      method: "PATCH",
      url: `/api/orgs/${org.id}`,
      payload: { settings: { policyRules: [{ name: "Device syncs are fine", effect: "allow", tools: ["m365_sync_device"], minAssurance: "chat" }] } },
    });
    const res = await app.inject({ method: "POST", url: "/api/simulate", payload: { orgId: org.id, email: "megan.bowen@contoso.example", name: "Megan", text: "Company portal says my laptop isn't compliant" } });
    await agent.settled(res.json().runId);
    expect(store.listActions({ runId: res.json().runId })[0]).toMatchObject({ status: "executed", policy_reason: expect.stringContaining("Allowed by") });
  });

  it("rejects malformed rules", async () => {
    const { app, org } = await contoso(new ScriptedLlm());
    const res = await app.inject({ method: "PATCH", url: `/api/orgs/${org.id}`, payload: { settings: { policyRules: [{ name: "x", effect: "maybe" }] } } });
    expect(res.statusCode).toBe(400);
  });
});

describe("Microsoft 365 onboarding", () => {
  const TENANT = "11111111-2222-3333-4444-555555555555";

  it("signs consent state and rejects tampering or expiry", () => {
    const key = Buffer.alloc(32, 7);
    const token = signConsentState(key, { orgId: "org_1", expiresAt: Date.now() + 60_000, nonce: "n" });
    expect(verifyConsentState(key, token)?.orgId).toBe("org_1");
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ orgId: "org_2", expiresAt: Date.now() + 60_000, nonce: "n" })).toString("base64url");
    expect(verifyConsentState(key, `${forged}.${mac}`)).toBeNull();
    expect(verifyConsentState(Buffer.alloc(32, 8), token)).toBeNull();
    expect(verifyConsentState(key, `${payload}.${mac}`, Date.now() + 120_000)).toBeNull();
  });

  it("connects a client through admin consent and pre-fills settings from discovery", async () => {
    const graph = fakeFetch([
      [/oauth2\/v2\.0\/token/, () => ({ access_token: "tok", expires_in: 3600 })],
      [/\/organization/, () => ({ value: [{ id: TENANT, displayName: "Fabrikam", verifiedDomains: [{ name: "fabrikam.com" }, { name: "fabrikam.onmicrosoft.com" }] }] })],
      [/\/subscribedSkus/, () => ({ value: [{ skuId: "s1", skuPartNumber: "SPE_E3", prepaidUnits: { enabled: 10 }, consumedUnits: 7 }] })],
      [/\/users\?/, () => ({ value: [{ id: "u1", userPrincipalName: "ann@fabrikam.com", accountEnabled: true, assignedLicenses: [{ skuId: "s1" }] }] })],
      [/managedDevices/, () => ({ value: [{ id: "d1", deviceName: "FAB-1", complianceState: "noncompliant", lastSyncDateTime: "2020-01-01T00:00:00Z", userPrincipalName: "ann@fabrikam.com" }] })],
      [/\/directoryRoles/, () => ({ value: [{ displayName: "Global Administrator", members: [{ userPrincipalName: "Admin@fabrikam.com", displayName: "Admin" }] }, { displayName: "Directory Readers", members: [{ userPrincipalName: "reader@fabrikam.com" }] }] })],
    ]);
    const { app, store } = await makeApp(new ScriptedLlm(), { m365App: { clientId: "msp-app-id", clientSecret: "msp-secret" } }, graph.impl);
    const org = store.createOrg({ name: "Fabrikam", domain: "fabrikam.com" });

    const info = await app.inject({ method: "GET", url: "/api/m365/onboarding" });
    expect(info.json()).toMatchObject({ mspAppConfigured: true, redirectUri: expect.stringMatching(/\/hooks\/m365\/consent$/) });
    const consent = await app.inject({ method: "POST", url: `/api/orgs/${org.id}/m365/consent` });
    const url = new URL(consent.json().url);
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/organizations/v2.0/adminconsent");
    expect(url.searchParams.get("client_id")).toBe("msp-app-id");
    const state = url.searchParams.get("state")!;

    const back = await app.inject({ method: "GET", url: `/hooks/m365/consent?admin_consent=True&tenant=${TENANT}&state=${encodeURIComponent(state)}` });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toContain(`/clients/${org.id}?m365=connected`);

    const [integration] = store.listIntegrations(org.id);
    expect(integration).toMatchObject({ provider: "m365", mode: "live", status: "connected" });
    expect(store.getIntegrationConfig(integration.id)).toEqual({ tenantId: TENANT, authMode: "msp_app" });
    const token = graph.calls.find((c) => c.url.includes("oauth2/v2.0/token"))!;
    expect(token.url).toContain(`/${TENANT}/`);
    expect(token.body).toContain("client_id=msp-app-id");

    const discovery = (await app.inject({ method: "GET", url: `/api/integrations/${integration.id}/discovery` })).json();
    expect(discovery).toMatchObject({
      organization: "Fabrikam",
      users: { total: 1, licensed: 1 },
      devices: { total: 1, noncompliant: 1, staleOver30Days: 1 },
      suggestions: { emailDomains: ["fabrikam.com"], teamsTenantId: TENANT, protectedAccounts: ["admin@fabrikam.com"] },
    });

    const applied = await app.inject({ method: "POST", url: `/api/orgs/${org.id}/m365/apply-discovery`, payload: { emailDomains: true, teamsTenantId: true, protectedAccounts: true } });
    expect(applied.json().settings).toMatchObject({ emailDomains: ["fabrikam.com"], teamsTenantId: TENANT, protectedAccounts: ["admin@fabrikam.com"] });
    expect(store.listAudit().map((a) => a.action)).toEqual(expect.arrayContaining(["m365.consent_granted", "m365.discovery_applied"]));
  });

  it("refuses forged or declined consent and needs the MSP app configured", async () => {
    const { app, store } = await makeApp(new ScriptedLlm(), { m365App: { clientId: "id", clientSecret: "s" } });
    const org = store.createOrg({ name: "Fabrikam" });
    const forged = await app.inject({ method: "GET", url: `/hooks/m365/consent?admin_consent=True&tenant=${TENANT}&state=abc.def` });
    expect(forged.headers.location).toContain("m365=error");
    const state = new URL((await app.inject({ method: "POST", url: `/api/orgs/${org.id}/m365/consent` })).json().url).searchParams.get("state")!;
    const declined = await app.inject({ method: "GET", url: `/hooks/m365/consent?error=access_denied&error_description=AADSTS65004%3A+User+declined&state=${encodeURIComponent(state)}` });
    expect(declined.headers.location).toContain(`/clients/${org.id}?m365=error`);
    expect(store.listIntegrations(org.id)).toHaveLength(0);

    const gdap = await app.inject({ method: "POST", url: `/api/orgs/${org.id}/m365/consent`, payload: { tenant: "Fabrikam.onmicrosoft.com" } });
    expect(gdap.json().url).toMatch(/^https:\/\/login\.microsoftonline\.com\/fabrikam\.onmicrosoft\.com\/v2\.0\/adminconsent\?/);
    expect((await app.inject({ method: "POST", url: `/api/orgs/${org.id}/m365/consent`, payload: { tenant: "not a tenant/../x" } })).statusCode).toBe(400);

    const bare = await makeApp(new ScriptedLlm());
    const other = bare.store.createOrg({ name: "X" });
    expect((await bare.app.inject({ method: "POST", url: `/api/orgs/${other.id}/m365/consent` })).statusCode).toBe(400);
  });

  it("discovers a sandbox tenant too", async () => {
    const { app, store, org } = await contoso(new ScriptedLlm());
    const integration = store.listIntegrations(org.id).find((i) => i.provider === "m365")!;
    const res = await app.inject({ method: "POST", url: `/api/integrations/${integration.id}/discover` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      admins: expect.arrayContaining([expect.objectContaining({ role: "Global Administrator", userPrincipalName: "grady.archie@contoso.example" })]),
      suggestions: { emailDomains: ["contoso.example"] },
    });
  });
});
