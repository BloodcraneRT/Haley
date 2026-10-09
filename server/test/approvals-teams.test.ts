import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeFetch, makeApp, ScriptedLlm, testConfig, text, toolUse, turn, type FetchCall } from "./helpers.js";

const APP_ID = "bot-app-id";
const MSP_TENANT = "aaaaaaaa-0000-0000-0000-000000000001";
const CLIENT_TENANT = "bbbbbbbb-0000-0000-0000-000000000002";
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
const now = () => Math.floor(Date.now() / 1000);
const claims = () => ({ iss: "https://api.botframework.com", aud: APP_ID, exp: now() + 600, nbf: now() - 10, serviceurl: SERVICE });

async function setup(llm: ScriptedLlm, members: Record<string, { email: string; objectId: string }> = { "29:dana": { email: "dana@msp.example", objectId: DANA_AAD } }) {
  let n = 0;
  const net = fakeFetch([
    [/openidconfiguration/, () => ({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" })],
    [/well-known\/keys/, () => ({ keys: [jwk] })],
    [/login\.microsoftonline\.com/, () => ({ access_token: "bot-token", expires_in: 3600 })],
    [/smba\.example\/teams\/v3\/conversations\/[^/]+\/members\//, (c) => members[decodeURIComponent(c.url.split("/members/")[1])] ?? { email: "someone@else.example", objectId: "22222222-2222-2222-2222-222222222222" }],
    [/smba\.example\/teams\/v3\/conversations\/[^/]+\/activities/, (c) => (c.method === "PUT" ? {} : { id: `activity-${++n}` })],
    [/asm\.skype\.com/, () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
    [/sharepoint\.com/, () => new Response(new TextEncoder().encode("Event ID 1000: OUTLOOK.EXE crashed"))],
    [/evil\.example/, () => new Response("x")],
  ]);
  const base = testConfig();
  const haley = await makeApp(
    llm,
    { channels: { ...base.channels, teamsAppId: APP_ID, teamsAppPassword: "pw", teamsTenantId: MSP_TENANT, publicUrl: "https://haley.msp.example" } },
    net.impl,
  );
  const { app, store } = haley;
  const org = store.createOrg({ name: "Contoso", domain: "contoso.example", autonomy: "supervised" });
  store.createIntegration({ orgId: org.id, provider: "m365", label: "Contoso M365", mode: "sandbox", config: {} });
  await app.inject({ method: "POST", url: "/api/technicians", payload: { name: "Dana Reyes", email: "dana@msp.example" } });
  const ticket = store.createTicket({ orgId: org.id, title: "Isaiah locked out", description: "x", requesterName: "Grady Archie", requesterEmail: "grady.archie@contoso.example" });
  const post = (activity: Record<string, unknown>, token = jwt(claims())) =>
    app.inject({ method: "POST", url: "/hooks/teams/messages", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { channelId: "msteams", serviceUrl: SERVICE, ...activity } });
  const sent = (method: "POST" | "PUT") => net.calls.filter((c: FetchCall) => c.url.includes("/activities") && c.method === method).map((c) => c.json());
  return { ...haley, net, org, ticket, post, sent };
}

const register = (from = "29:dana", tenantId = MSP_TENANT, conversationType = "channel") => ({
  type: "message",
  id: "m1",
  text: "<at>Haley</at> approvals here",
  from: { id: from, name: "Dana", aadObjectId: from === "29:dana" ? DANA_AAD : "33333333-3333-3333-3333-333333333333" },
  conversation: { id: "19:approvals@thread.tacv2", conversationType, tenantId },
});

const invoke = (actionId: string, verb: string, note = "", tenantId = MSP_TENANT) => ({
  type: "invoke",
  name: "adaptiveCard/action",
  id: "i1",
  from: { id: "29:dana", name: "Dana", aadObjectId: DANA_AAD },
  conversation: { id: "19:approvals@thread.tacv2", conversationType: "channel", tenantId },
  value: { action: { type: "Action.Execute", verb, data: { actionId, note } } },
});

const RESET = () => new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })), turn(text("Okay.")));

describe("approval cards in Teams", () => {
  it("registers a channel only for directory technicians in the MSP's tenant", async () => {
    const { store, post, sent } = await setup(new ScriptedLlm());
    // A stranger in the MSP tenant is told no.
    expect((await post(register("29:stranger"))).statusCode).toBe(202);
    expect(store.getApprovalSettings().teamsConversation).toBeNull();
    expect(sent("POST")[0].text).toContain("Only technicians in the Haley directory");
    // From a client's tenant, it's an ordinary message, not a registration.
    await post(register("29:dana", CLIENT_TENANT));
    expect(store.getApprovalSettings().teamsConversation).toBeNull();
    // Not in a 1:1 chat with the bot.
    await post(register("29:dana", MSP_TENANT, "personal"));
    expect(store.getApprovalSettings().teamsConversation).toBeNull();

    expect((await post(register())).statusCode).toBe(202);
    expect(store.getApprovalSettings().teamsConversation).toMatchObject({ conversationId: "19:approvals@thread.tacv2", serviceUrl: SERVICE, registeredBy: "Dana Reyes" });
    expect(sent("POST").at(-1)!.text).toContain("I'll post approval cards here");
    expect(store.findTechnician({ teamsAadId: DANA_AAD })?.name).toBe("Dana Reyes");
    expect(store.listTickets().filter((t) => t.channel === "teams")).toHaveLength(0);
  });

  it("posts an adaptive card, and asking for changes from it needs a note and refreshes the card", async () => {
    const { store, agent, approvalNotifier, ticket, post, sent } = await setup(RESET());
    await post(register());
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    const [pending] = store.listActions({ status: "pending_approval" });

    const card = sent("POST").at(-1)!.attachments[0];
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content.actions.map((a: { verb?: string; type: string }) => a.verb ?? a.type)).toEqual(["approve", "reject", "changes", "Action.OpenUrl"]);
    expect(card.content.actions[0].data).toEqual({ actionId: pending.id });
    expect(JSON.stringify(card.content.body)).toContain("Reset password for isaiah.langer@contoso.example");

    const noNote = await post(invoke(pending.id, "changes"));
    expect(noNote.json()).toMatchObject({ type: "application/vnd.microsoft.activity.message", value: expect.stringContaining("Type what should change") });
    expect(store.getAction(pending.id)!.status).toBe("pending_approval");

    const res = await post(invoke(pending.id, "changes", "Ask his manager first"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ statusCode: 200, type: "application/vnd.microsoft.card.adaptive" });
    expect(JSON.stringify(res.json().value.body)).toContain("Changes requested by Dana Reyes");
    expect(res.json().value.actions.every((a: { type: string }) => a.type === "Action.OpenUrl")).toBe(true);
    expect(store.getAction(pending.id)).toMatchObject({ status: "changes_requested", decided_by: "Dana Reyes", decision_note: "Ask his manager first" });
    await agent.settled(run.id);
    await approvalNotifier.idle();
    // The posted card is updated in place too.
    const [update] = sent("PUT");
    expect(update.id).toBe("activity-2");
    expect(JSON.stringify(update.attachments[0].content.body)).toContain("Changes requested by Dana Reyes");
  });

  it("refuses other tenants, people outside the directory, decided actions and forged tokens", async () => {
    const { store, agent, approvalNotifier, ticket, post } = await setup(RESET(), {
      "29:dana": { email: "dana@msp.example", objectId: DANA_AAD },
    });
    await post(register());
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    const [pending] = store.listActions({ status: "pending_approval" });

    expect((await post(invoke(pending.id, "approve"), "not.a.jwt")).statusCode).toBe(401);
    expect((await post(invoke(pending.id, "approve", "", CLIENT_TENANT))).json().value).toContain("MSP's own Teams");
    const stranger = { ...invoke(pending.id, "approve"), from: { id: "29:stranger", aadObjectId: "33333333-3333-3333-3333-333333333333" } };
    expect((await post(stranger)).json().value).toContain("not set up as a technician");
    expect(store.getAction(pending.id)!.status).toBe("pending_approval");

    await agent.decideAction(pending.id, true, "Jordan");
    expect((await post(invoke(pending.id, "approve"))).json().value).toBe("Already decided by Jordan.");
    await agent.settled(run.id);
  });

  it("approves from the card and the run carries on", async () => {
    const { store, agent, approvalNotifier, ticket, post } = await setup(RESET());
    await post(register());
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    const [pending] = store.listActions({ status: "pending_approval" });
    const res = await post(invoke(pending.id, "approve"));
    expect(JSON.stringify(res.json().value.body)).toContain("Approved by Dana Reyes");
    await agent.settled(run.id);
    expect(store.getAction(pending.id)).toMatchObject({ status: "executed", decided_by: "Dana Reyes" });
    expect(store.getRun(run.id)!.status).toBe("completed");
  });
});

describe("attachments from Teams", () => {
  it("downloads pasted images with the bot token and shared files from SharePoint, and nothing from elsewhere", async () => {
    const { store, agent, post, net } = await setup(new ScriptedLlm(turn(text("Looking."))));
    store.createOrg({ name: "Fabrikam", domain: "fabrikam.example", settings: { teamsTenantId: CLIENT_TENANT } });
    const res = await post({
      type: "message",
      id: "m9",
      text: "",
      from: { id: "29:joe", name: "Joe", aadObjectId: "44444444-4444-4444-4444-444444444444" },
      conversation: { id: "a:joe", conversationType: "personal", tenantId: CLIENT_TENANT },
      attachments: [
        { contentType: "text/html", content: "<div>ignored</div>" },
        { contentType: "image/png", contentUrl: "https://us-api.asm.skype.com/v1/objects/0-abc/views/imgo", name: "pasted.png" },
        { contentType: "application/vnd.microsoft.teams.file.download.info", name: "crash.log", content: { downloadUrl: "https://fabrikam.sharepoint.com/x?tempauth=1", fileType: "log" } },
        { contentType: "image/png", contentUrl: "https://evil.example/steal.png", name: "evil.png" },
      ],
    });
    expect(res.statusCode).toBe(202);
    const ticket = await (async () => {
      for (let i = 0; i < 200; i++) {
        const t = store.listTickets().find((x) => x.channel === "teams");
        if (t && store.listRuns({ ticketId: t.id })[0]) return t;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("no ticket");
    })();
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);
    expect(store.listAttachments(ticket.id).map((a) => [a.filename, a.kind])).toEqual([["pasted.png", "image"], ["crash.log", "text"], ["evil.png", "other"]]);
    expect(net.calls.find((c) => c.url.includes("asm.skype.com"))!.headers.authorization).toBe("Bearer bot-token");
    expect(net.calls.find((c) => c.url.includes("sharepoint.com"))!.headers.authorization).toBeUndefined();
    expect(net.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });
});
