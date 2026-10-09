import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeFetch, makeApp, ScriptedLlm, testConfig, text, toolUse, turn, type FetchCall } from "./helpers.js";

const PUBLIC = "https://haley.msp.example";
const MSP_TEAM = "TMSP0001";
const RULE = (approvers: string[]) => ({
  id: "r",
  name: "Resets need approval",
  enabled: true,
  tools: ["m365_reset_password"],
  risks: [],
  targets: [],
  departments: [],
  requesters: [],
  effect: "approve" as const,
  approvers,
  minAssurance: "directory" as const,
});
const RESET = () => new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })), turn(text("ok")));
const posts = (calls: FetchCall[], method: string) => calls.filter((c) => c.url.includes(`/api/${method}`)).map((c) => c.json());

async function slackSetup(llm: ScriptedLlm) {
  let ts = 0;
  const net = fakeFetch([
    [/slack\.com\/api\/auth\.test/, () => ({ ok: true, team_id: MSP_TEAM, team: "MSP" })],
    [/slack\.com\/api\/conversations\.open/, (c) => ({ ok: true, channel: { id: `D-${c.json().users}` } })],
    [/slack\.com\/api\/chat\.postMessage/, (c) => ({ ok: true, channel: c.json().channel, ts: `1700000000.${++ts}` })],
    [/slack\.com\/api\/chat\.update/, () => ({ ok: true })],
  ]);
  const base = testConfig();
  const haley = await makeApp(llm, { channels: { ...base.channels, slackSigningSecret: "s", publicUrl: PUBLIC } }, net.impl);
  const { app, store } = haley;
  const org = store.createOrg({ name: "Contoso", domain: "contoso.example", autonomy: "supervised" });
  store.createIntegration({ orgId: org.id, provider: "m365", label: "Contoso M365", mode: "sandbox", config: {} });
  await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { slackBotToken: "xoxb-1-msp", slackChannel: "C0APPROV" } });
  const dana = store.createTechnician({ name: "Dana Reyes", email: "dana@msp.example" });
  store.updateTechnician(dana.id, { slackUserId: "U0DANA" });
  const sam = store.createTechnician({ name: "Sam Lee", email: "sam@msp.example" });
  store.updateTechnician(sam.id, { slackUserId: "U0SAM" });
  store.createTechnician({ name: "Priya Patel" });
  const ticket = store.createTicket({ orgId: org.id, title: "Isaiah locked out", description: "x", requesterName: "Grady Archie", requesterEmail: "grady.archie@contoso.example" });
  const park = async () => {
    const run = haley.agent.startTicketRun(ticket.id, "tech");
    await haley.agent.settled(run.id);
    await haley.approvalNotifier.idle();
    return { run, pending: store.listActions({ status: "pending_approval" })[0] };
  };
  return { ...haley, net, org, ticket, park };
}

describe("approver DMs in Slack", () => {
  it("sends the card to each named approver directly and updates it when the change is decided", async () => {
    const { app, store, agent, approvalNotifier, net, org, park } = await slackSetup(RESET());
    store.updateOrg(org.id, { settings: { policyRules: [RULE(["Dana Reyes", "Priya Patel"])] } });
    const { run, pending } = await park();

    expect(posts(net.calls, "conversations.open")).toEqual([{ users: "U0DANA" }]);
    const cards = posts(net.calls, "chat.postMessage");
    expect(cards.map((c) => c.channel)).toEqual(["C0APPROV", "D-U0DANA"]);
    expect(JSON.stringify(cards[1].blocks)).toContain("Only Dana Reyes, Priya Patel can decide");
    // Priya has no chat account, so the settings page says she can't be messaged.
    expect((await app.inject({ url: "/api/approvals/settings" })).json().approversWithoutChat).toEqual(["Priya Patel"]);

    await agent.decideAction(pending.id, true, "Dana Reyes");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    expect(posts(net.calls, "chat.update").map((u) => u.channel).sort()).toEqual(["C0APPROV", "D-U0DANA"]);
    await app.close();
  });

  it("doesn't DM when anyone can approve, or when the workspace turns it off", async () => {
    const first = await slackSetup(RESET());
    await first.park();
    expect(posts(first.net.calls, "conversations.open")).toEqual([]);
    await first.app.close();

    const second = await slackSetup(RESET());
    second.store.updateOrg(second.org.id, { settings: { policyRules: [RULE(["Dana Reyes"])] } });
    await second.app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { dmApprovers: false } });
    await second.park();
    expect(posts(second.net.calls, "conversations.open")).toEqual([]);
    await second.app.close();
  });
});

describe("approval reminders", () => {
  it("reminds once under the card and in the approvers' DMs, and never for decided changes", async () => {
    const { app, store, agent, approvalNotifier, net, org, park } = await slackSetup(RESET());
    store.updateOrg(org.id, { settings: { policyRules: [RULE(["Dana Reyes"])] } });
    const { run, pending } = await park();

    // Off by default.
    approvalNotifier.remind(Date.now() + 3 * 3_600_000);
    await approvalNotifier.idle();
    expect(store.getAction(pending.id)).not.toHaveProperty("reminded_at", expect.any(String));
    expect(posts(net.calls, "chat.postMessage")).toHaveLength(2);

    expect((await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { reminderMinutes: 45 } })).statusCode).toBe(400);
    await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { reminderMinutes: 30 } });
    // Not yet.
    approvalNotifier.remind(Date.now() + 10 * 60_000);
    await approvalNotifier.idle();
    expect(posts(net.calls, "chat.postMessage")).toHaveLength(2);

    approvalNotifier.remind(Date.now() + 31 * 60_000);
    await approvalNotifier.idle();
    const sent = posts(net.calls, "chat.postMessage").slice(2);
    const thread = sent.find((m) => m.thread_ts)!;
    expect(thread).toMatchObject({ channel: "C0APPROV", thread_ts: "1700000000.1" });
    expect(thread.text).toMatch(/^⏰ Still waiting for approval \(3\d min\): Reset password for isaiah\.langer@contoso\.example · https:\/\/haley\.msp\.example\/tickets\//);
    expect(sent.filter((m) => m.channel === "D-U0DANA")).toHaveLength(1);
    expect(store.listAudit({ limit: 20 }).some((a) => a.action === "approval.reminded")).toBe(true);

    // Only once.
    approvalNotifier.remind(Date.now() + 90 * 60_000);
    await approvalNotifier.idle();
    expect(posts(net.calls, "chat.postMessage")).toHaveLength(2 + sent.length);

    // On decision, cards and DMs update; the reminder line doesn't.
    await agent.decideAction(pending.id, false, "Dana Reyes", "No");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    expect(posts(net.calls, "chat.update")).toHaveLength(3);
    await app.close();
  });

  it("reminds the assigned technician when anyone can approve", async () => {
    const { app, store, approvalNotifier, scheduler, net, ticket, park } = await slackSetup(RESET());
    store.updateTicket(ticket.id, { assignee: "Sam Lee" }, "tech");
    await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { reminderMinutes: 15 } });
    const { pending } = await park();
    // The scheduler's tick sends it.
    await scheduler.tick(Date.now() + 16 * 60_000);
    await approvalNotifier.idle();
    expect(posts(net.calls, "conversations.open")).toEqual([{ users: "U0SAM" }]);
    expect(store.getAction(pending.id)!.status).toBe("pending_approval");
    await app.close();
  });
});

// ---------------------------------------------------------------- Teams

const APP_ID = "bot-app-id";
const MSP_TENANT = "aaaaaaaa-0000-0000-0000-000000000001";
const DANA_AAD = "11111111-1111-1111-1111-111111111111";
const SERVICE = "https://smba.example/teams/";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", endorsements: ["msteams"] };
function jwt(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function teamsSetup(dmStatus: number) {
  let n = 0;
  const net = fakeFetch([
    [/openidconfiguration/, () => ({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" })],
    [/well-known\/keys/, () => ({ keys: [jwk] })],
    [/login\.microsoftonline\.com/, () => ({ access_token: "bot-token", expires_in: 3600 })],
    [/smba\.example\/teams\/v3\/conversations\/[^/]+\/members\//, () => ({ email: "dana@msp.example", objectId: DANA_AAD })],
    [/smba\.example\/teams\/v3\/conversations$/, () => (dmStatus === 200 ? { id: "a:dm-dana" } : new Response(JSON.stringify({ error: { code: "Forbidden" } }), { status: dmStatus }))],
    [/smba\.example\/teams\/v3\/conversations\/[^/]+\/activities/, (c) => (c.method === "PUT" ? {} : { id: `activity-${++n}` })],
  ]);
  const base = testConfig();
  // Two runs that each park a password reset.
  const llm = new ScriptedLlm(
    turn(toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })),
    turn(toolUse("m365_reset_password", { user: "adele.vance@contoso.example" })),
    turn(text("ok")),
    turn(text("ok")),
  );
  const haley = await makeApp(llm, { channels: { ...base.channels, teamsAppId: APP_ID, teamsAppPassword: "pw", teamsTenantId: MSP_TENANT, publicUrl: PUBLIC } }, net.impl);
  const { app, store } = haley;
  const org = store.createOrg({ name: "Contoso", domain: "contoso.example", autonomy: "supervised" });
  store.createIntegration({ orgId: org.id, provider: "m365", label: "Contoso M365", mode: "sandbox", config: {} });
  store.createTechnician({ name: "Dana Reyes", email: "dana@msp.example" });
  store.updateOrg(org.id, { settings: { policyRules: [RULE(["Dana Reyes"])] } });
  const nowS = Math.floor(Date.now() / 1000);
  const token = jwt({ iss: "https://api.botframework.com", aud: APP_ID, exp: nowS + 600, nbf: nowS - 10, serviceurl: SERVICE });
  await app.inject({
    method: "POST",
    url: "/hooks/teams/messages",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: {
      channelId: "msteams",
      serviceUrl: SERVICE,
      type: "message",
      id: "m1",
      text: "<at>Haley</at> approvals here",
      from: { id: "29:dana", name: "Dana", aadObjectId: DANA_AAD },
      conversation: { id: "19:approvals@thread.tacv2", conversationType: "channel", tenantId: MSP_TENANT },
    },
  });
  const ticket = store.createTicket({ orgId: org.id, title: "Isaiah locked out", description: "x", requesterName: "Grady Archie", requesterEmail: "grady.archie@contoso.example" });
  const run = haley.agent.startTicketRun(ticket.id, "tech");
  await haley.agent.settled(run.id);
  await haley.approvalNotifier.idle();
  return { ...haley, net };
}

describe("approver DMs in Teams", () => {
  it("opens a 1:1 chat with the approver and sends the card there", async () => {
    const { app, net } = await teamsSetup(200);
    const open = net.calls.find((c) => /v3\/conversations$/.test(c.url))!;
    expect(open.json()).toMatchObject({ bot: { id: `28:${APP_ID}` }, members: [{ id: DANA_AAD }], tenantId: MSP_TENANT, isGroup: false });
    const dm = net.calls.find((c) => c.url.includes("/conversations/a%3Adm-dana/activities"))!;
    expect(JSON.stringify(dm.json())).toContain("Approval needed");
    await app.close();
  });

  it("falls back to the channel card when Dana doesn't have the app, and says so once", async () => {
    const { app, store, net, agent, approvalNotifier } = await teamsSetup(403);
    expect(net.calls.filter((c) => c.url.includes("/conversations/19%3Aapprovals%40thread.tacv2/activities") && c.method === "POST").length).toBeGreaterThanOrEqual(1);
    expect(store.listAudit({ limit: 30 }).filter((a) => a.action === "approvals.dm_unavailable")).toHaveLength(1);
    // A second change the same day isn't audited again.
    const ticket = store.createTicket({ orgId: store.listOrgs()[0].id, title: "Another reset", description: "x", requesterName: "Grady Archie", requesterEmail: "grady.archie@contoso.example" });
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    expect(store.listActions({ status: "pending_approval" })).toHaveLength(2);
    expect(net.calls.filter((c) => /v3\/conversations$/.test(c.url))).toHaveLength(2);
    expect(store.listAudit({ limit: 30 }).filter((a) => a.action === "approvals.dm_unavailable")).toHaveLength(1);
    await app.close();
  });
});
