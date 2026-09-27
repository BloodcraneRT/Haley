import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sign } from "../src/channels/chat.js";
import { stripQuotedReply, ticketNumberFromSubject, verifyEmailSender } from "../src/channels/email.js";
import { verifySlackSignature } from "../src/channels/slack.js";
import type { ChannelConfig } from "../src/config.js";
import { fakeFetch, makeApp, ScriptedLlm, testConfig, text, toolUse, turn, type FetchCall, firstUserText, lastToolResults } from "./helpers.js";

const channels = (patch: Partial<ChannelConfig>): ChannelConfig => ({ ...testConfig().channels, ...patch });

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("channel helpers", () => {
  it("verifies Slack signatures with a replay window", () => {
    const body = '{"type":"event_callback"}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", "s3cret").update(`v0:${ts}:${body}`).digest("hex")}`;
    expect(verifySlackSignature("s3cret", ts, sig, body)).toBe(true);
    expect(verifySlackSignature("other", ts, sig, body)).toBe(false);
    expect(verifySlackSignature("s3cret", ts, sig, `${body} `)).toBe(false);
    expect(verifySlackSignature("s3cret", String(Number(ts) - 600), sig, body)).toBe(false);
  });

  it("only trusts email with DMARC pass or aligned DKIM", () => {
    expect(verifyEmailSender({ from: "a@acme.example", subject: "", text: "", authenticationResults: "mx.example; spf=pass; dkim=pass header.d=acme.example; dmarc=pass" }).verified).toBe(true);
    expect(verifyEmailSender({ from: "a@acme.example", subject: "", text: "", authenticationResults: "dkim=pass header.d=mail.acme.example" }).verified).toBe(false);
    expect(verifyEmailSender({ from: "a@mail.acme.example", subject: "", text: "", authenticationResults: "dkim=pass header.d=acme.example" }).verified).toBe(true);
    expect(verifyEmailSender({ from: "a@acme.example", subject: "", text: "", authenticationResults: "dkim=pass header.d=evil.example; dmarc=fail" }).verified).toBe(false);
    expect(verifyEmailSender({ from: "a@acme.example", subject: "", text: "" }).verified).toBe(false);
  });

  it("threads and cleans up email replies", () => {
    expect(ticketNumberFromSubject("Re: [#1004] Printer")).toBe(1004);
    expect(ticketNumberFromSubject("RE: [Haley #77] x")).toBe(77);
    expect(ticketNumberFromSubject("Printer #1004")).toBeUndefined();
    expect(stripQuotedReply("Still broken.\n\nOn Mon, Sep 1, 2026 Haley wrote:\n> old")).toBe("Still broken.");
  });
});

describe("Slack", () => {
  const SECRET = "slack-signing";

  function slackRequest(payload: unknown) {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      method: "POST" as const,
      url: "/hooks/slack/events",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`,
      },
    };
  }

  const dm = (text: string, ts: string, extra: Record<string, unknown> = {}) => ({
    type: "event_callback",
    team_id: "T1",
    event_id: `Ev${ts}`,
    event: { type: "message", channel_type: "im", channel: "D1", user: "U1", text, ts, ...extra },
  });

  async function setup(llm: ScriptedLlm) {
    const slack = fakeFetch([
      [/users\.info/, () => ({ ok: true, user: { real_name: "Sam Chen", profile: { email: "sam@acme-health.example" } } })],
      [/chat\.postMessage/, () => ({ ok: true, ts: "1.1" })],
    ]);
    const haley = await makeApp(llm, { channels: channels({ slackSigningSecret: SECRET }) }, slack.impl);
    const { store } = haley;
    const org = store.createOrg({ name: "Acme Health", domain: "acme-health.example", autonomy: "unattended" });
    store.createIntegration({ orgId: org.id, provider: "google", label: "Acme GWS", mode: "sandbox", config: {} });
    const slackInt = store.createIntegration({ orgId: org.id, provider: "slack", label: "Acme Slack", mode: "live", config: { botToken: "xoxb-1" } });
    store.setIntegrationState(slackInt.id, { teamId: "T1", team: "Acme" });
    const posts = () => slack.calls.filter((c) => c.url.includes("chat.postMessage")).map((c) => c.json());
    return { ...haley, org, posts };
  }

  it("rejects unsigned events and answers the URL verification challenge", async () => {
    const { app } = await setup(new ScriptedLlm());
    const unsigned = await app.inject({ method: "POST", url: "/hooks/slack/events", payload: { type: "url_verification", challenge: "c" } });
    expect(unsigned.statusCode).toBe(401);
    const challenge = await app.inject(slackRequest({ type: "url_verification", challenge: "abc" }));
    expect(challenge.json()).toEqual({ challenge: "abc" });
  });

  it("resolves a self-service password reset end to end and sends the password only by DM", async () => {
    const llm = new ScriptedLlm(
      turn(text("Resetting Sam's own password."), toolUse("gws_reset_password", { email: "sam@acme-health.example" })),
      turn(toolUse("reply_to_requester", { message: "Done! I sent your temporary password in this chat." }), toolUse("update_ticket", { status: "resolved" })),
      turn(text("Self-service reset for Sam; password delivered by Slack DM.")),
    );
    const { app, agent, store, posts } = await setup(llm);
    expect((await app.inject(slackRequest(dm("I forgot my password", "100.1")))).statusCode).toBe(200);

    const ticket = await waitFor(() => store.listTickets()[0]);
    expect(ticket).toMatchObject({ channel: "slack", assurance: "chat", requester_email: "sam@acme-health.example", title: "I forgot my password" });
    const [run] = store.listRuns({ ticketId: ticket.id });
    await agent.settled(run.id);

    expect(store.getRun(run.id)!.status).toBe("completed");
    const [action] = store.listActions({ runId: run.id }).filter((a) => a.tool === "gws_reset_password");
    expect(action).toMatchObject({ status: "executed", decided_by: null });
    const password = store.revealActionSecrets(action.id)!.temporaryPassword;

    const sent = posts();
    expect(sent.map((p) => p.channel)).toEqual(["D1", "D1", "D1"]);
    expect(sent.every((p) => p.thread_ts === "100.1")).toBe(true);
    expect(sent[0].text).toContain("ticket #");
    expect(sent[1].text).toContain(password);
    expect(sent[2].text).toContain("temporary password in this chat");
    expect(JSON.stringify(llm.requests)).not.toContain(password);
    expect(JSON.stringify(llm.requests)).toContain("sent privately to the requester");
    expect(store.getTicket(ticket.id)!.status).toBe("resolved");
    expect(store.listAudit().map((a) => a.action)).toContain("secret.delivered");
  });

  it("queues a follow-up when the requester writes while Haley is working", async () => {
    let appRef: Awaited<ReturnType<typeof setup>>["app"] | null = null;
    const llm = new ScriptedLlm(
      async () => {
        // The requester adds detail mid-run (top-level DM, not in the thread).
        await appRef!.inject(slackRequest(dm("Also my Drive is empty", "100.2")));
        return { content: [text("Looking.")] };
      },
      turn(text("Second pass: checked Drive too.")),
    );
    const { app, agent, store } = await setup(llm);
    appRef = app;
    await app.inject(slackRequest(dm("Email is weird", "100.1")));
    const ticket = await waitFor(() => store.listTickets()[0]);
    const firstRun = store.listRuns({ ticketId: ticket.id })[0];
    await agent.settled(firstRun.id);
    const runs = await waitFor(() => {
      const r = store.listRuns({ ticketId: ticket.id });
      return r.length === 2 ? r : null;
    });
    await agent.settled(runs[0].id);
    expect(store.listTickets()).toHaveLength(1);
    expect(store.listTicketEvents(ticket.id).some((e) => e.kind === "comment" && e.body === "Also my Drive is empty")).toBe(true);
    expect(firstUserText(llm.requests[1])).toContain("Also my Drive is empty");
    expect(store.getTicket(ticket.id)!.needs_followup).toBe(false);
  });

  it("treats guests as unverified", async () => {
    const llm = new ScriptedLlm(turn(toolUse("gws_reset_password", { email: "sam@acme-health.example" })));
    const slack = fakeFetch([
      [/users\.info/, () => ({ ok: true, user: { real_name: "Sam", is_restricted: true, profile: { email: "sam@acme-health.example" } } })],
      [/chat\.postMessage/, () => ({ ok: true })],
    ]);
    const { app, agent, store } = await makeApp(llm, { channels: channels({ slackSigningSecret: SECRET }) }, slack.impl);
    const org = store.createOrg({ name: "Acme", domain: "acme-health.example", autonomy: "unattended" });
    store.createIntegration({ orgId: org.id, provider: "google", label: "g", mode: "sandbox", config: {} });
    const s = store.createIntegration({ orgId: org.id, provider: "slack", label: "s", mode: "live", config: { botToken: "x" } });
    store.setIntegrationState(s.id, { teamId: "T1" });
    await app.inject(slackRequest(dm("reset me", "5.5")));
    const ticket = await waitFor(() => store.listTickets()[0]);
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);
    expect(ticket.assurance).toBe("none");
    expect(store.listActions({ status: "pending_approval" })).toHaveLength(1);
  });
});

describe("email", () => {
  it("opens tickets, threads replies by subject tag, and never auto-resets on email identity", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const llm = new ScriptedLlm(
      turn(toolUse("gws_reset_password", { email: "priya@acme-health.example" })),
      turn(text("Waiting on approval.")),
    );
    const { app, agent, store } = await makeApp(
      llm,
      { channels: channels({ emailHookSecret: "hook", smtpUrl: "", smtpFrom: "IT <it@msp.example>" }) },
      undefined,
      { sendMail: async (m) => void sent.push(m) },
    );
    const org = store.createOrg({ name: "Acme", domain: "acme-health.example", autonomy: "unattended" });
    store.createIntegration({ orgId: org.id, provider: "google", label: "g", mode: "sandbox", config: {} });

    const mail = {
      from: "priya@acme-health.example",
      fromName: "Priya Nair",
      subject: "Locked out",
      text: "I can't log in",
      messageId: "<m1@acme>",
      authenticationResults: "dkim=pass header.d=acme-health.example; dmarc=pass",
    };
    expect((await app.inject({ method: "POST", url: "/hooks/email?key=wrong", payload: mail })).statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: "/hooks/email?key=hook", payload: mail });
    const { ticketId, ticketNumber, runId } = res.json();
    await agent.settled(runId);

    expect(store.getTicket(ticketId)).toMatchObject({ channel: "email", assurance: "email" });
    const [pending] = store.listActions({ status: "pending_approval" });
    expect(pending.policy_reason).toMatch(/stronger identity than email/);
    expect(sent[0]).toMatchObject({ to: '"Priya Nair" <priya@acme-health.example>', subject: `Re: [#${ticketNumber}] Locked out`, inReplyTo: "<m1@acme>" });
    expect(String(sent.at(-1)!.text)).toContain("quick sign-off");

    const reply = await app.inject({
      method: "POST",
      url: "/hooks/email",
      headers: { "x-haley-hook-secret": "hook" },
      payload: { ...mail, subject: `RE: [#${ticketNumber}] Locked out`, text: "Any update?\n\nOn Mon Haley wrote:\n> hi", messageId: "<m2@acme>" },
    });
    expect(reply.json()).toMatchObject({ ticketId, created: false, runId: null });
    expect(store.listTicketEvents(ticketId).some((e) => e.kind === "comment" && e.body === "Any update?")).toBe(true);
    expect(store.getTicket(ticketId)!.needs_followup).toBe(true);
  });
});

describe("Microsoft Teams", () => {
  const APP_ID = "bot-app-id";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", endorsements: ["msteams"] };

  const jwt = (claims: Record<string, unknown>) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
    return `${header}.${payload}.${sig}`;
  };
  const now = () => Math.floor(Date.now() / 1000);
  const goodClaims = { iss: "https://api.botframework.com", aud: APP_ID, exp: now() + 600, nbf: now() - 10, serviceurl: "https://smba.example/teams/" };

  async function setup(llm: ScriptedLlm) {
    const net = fakeFetch([
      [/openidconfiguration/, () => ({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" })],
      [/well-known\/keys/, () => ({ keys: [jwk] })],
      [/login\.microsoftonline\.com\/botframework\.com/, () => ({ access_token: "bot-token", expires_in: 3600 })],
      [/smba\.example/, () => ({ id: "reply-1" })],
    ]);
    const haley = await makeApp(llm, { channels: channels({ teamsAppId: APP_ID, teamsAppPassword: "pw" }) }, net.impl);
    const { store } = haley;
    const org = store.createOrg({ name: "Contoso", domain: "contoso.example", autonomy: "unattended", settings: { teamsTenantId: "tenant-1" } });
    const m365 = store.createIntegration({ orgId: org.id, provider: "m365", label: "M365", mode: "sandbox", config: {} });
    // Build the sandbox tenant, then look up Isaiah's object id as Teams would send it.
    await haley.app.inject({ method: "POST", url: `/api/integrations/${m365.id}/test` });
    const state = store.getIntegrationState<{ users: Array<{ id: string; userPrincipalName: string }> }>(m365.id)!;
    const isaiah = state.users.find((u) => u.userPrincipalName.startsWith("isaiah"))!;
    const activity = (text: string, claims = goodClaims) => ({
      method: "POST" as const,
      url: "/hooks/teams/messages",
      headers: { authorization: `Bearer ${jwt(claims)}`, "content-type": "application/json" },
      payload: {
        type: "message",
        id: "a1",
        channelId: "msteams",
        serviceUrl: "https://smba.example/teams/",
        text,
        from: { id: "29:1", name: "Isaiah Langer", aadObjectId: isaiah.id },
        conversation: { id: "a:conv1", conversationType: "personal", tenantId: "tenant-1" },
      },
    });
    const replies = () => net.calls.filter((c: FetchCall) => c.url.includes("smba.example")).map((c) => c.json().text as string);
    return { ...haley, org, activity, replies, net };
  }

  it("rejects forged, misaddressed and expired tokens", async () => {
    const { app, activity } = await setup(new ScriptedLlm());
    const cases = [
      { ...goodClaims, aud: "someone-else" },
      { ...goodClaims, iss: "https://evil.example" },
      { ...goodClaims, exp: now() - 3600 },
      { ...goodClaims, serviceurl: "https://evil.example/" },
    ];
    for (const claims of cases) expect((await app.inject(activity("hi", claims))).statusCode).toBe(401);
    const tampered = activity("hi");
    tampered.headers.authorization = tampered.headers.authorization.slice(0, -4) + "AAAA";
    expect((await app.inject(tampered)).statusCode).toBe(401);
  });

  it("maps the Entra identity to the directory and fixes the user's own account", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("m365_revoke_sessions", { user: "isaiah.langer@contoso.example" })),
      turn(text("Signed Isaiah out everywhere.")),
    );
    const { app, agent, store, replies, activity } = await setup(llm);
    expect((await app.inject(activity("I think someone has my login"))).statusCode).toBe(202);
    const ticket = await waitFor(() => store.listTickets()[0]);
    expect(ticket).toMatchObject({ channel: "teams", assurance: "directory", requester_email: "isaiah.langer@contoso.example" });
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);
    expect(store.listActions().find((a) => a.tool === "m365_revoke_sessions")).toMatchObject({ status: "executed" });
    expect(replies()[0]).toContain(`#${ticket.number}`);
  });
});

describe("chat bridge, simulator and controls", () => {
  it("accepts signed chat messages and posts signed replies to the callback", async () => {
    const net = fakeFetch([[/bridge\.example/, () => ({ ok: true })]]);
    const llm = new ScriptedLlm(turn(toolUse("reply_to_requester", { message: "On it" })), turn(text("done")));
    const { app, agent, store } = await makeApp(llm, { channels: channels({ chatWebhookSecret: "chat-secret" }) }, net.impl);
    store.createOrg({ name: "Acme", domain: "acme.example" });
    const payload = JSON.stringify({ threadId: "t1", user: { email: "jo@acme.example", name: "Jo" }, text: "VPN down", callbackUrl: "https://bridge.example/cb" });
    const bad = await app.inject({ method: "POST", url: "/hooks/chat", payload, headers: { "content-type": "application/json", "x-haley-signature": "sha256=00" } });
    expect(bad.statusCode).toBe(401);
    const res = await app.inject({
      method: "POST",
      url: "/hooks/chat",
      payload,
      headers: { "content-type": "application/json", "x-haley-signature": sign("chat-secret", payload) },
    });
    await agent.settled(res.json().runId);
    const posted = net.calls.filter((c) => c.url.includes("bridge.example"));
    expect(posted.map((c) => c.json().text)).toEqual([expect.stringContaining("Hi Jo"), "On it"]);
    expect(posted.every((c) => c.headers["x-haley-signature"] === sign("chat-secret", c.body))).toBe(true);
    expect(store.listTickets()[0]).toMatchObject({ channel: "chat", assurance: "none" });
  });

  it("lets technicians simulate an end user and respects the kill switch", async () => {
    const llm = new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "megan.bowen@contoso.example" })), turn(text("done")));
    const { app, agent, store } = await makeApp(llm);
    await app.inject({ method: "POST", url: "/api/demo" });
    const contoso = store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
    await app.inject({ method: "PATCH", url: `/api/orgs/${contoso.id}`, payload: { autonomy: "unattended" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/simulate",
      payload: { orgId: contoso.id, email: "megan.bowen@contoso.example", name: "Megan Bowen", text: "Forgot my password" },
    });
    const { runId, ticketId, threadId } = res.json();
    await agent.settled(runId);
    const action = store.listActions({ runId }).find((a) => a.tool === "m365_reset_password")!;
    expect(action.status).toBe("executed");
    expect(store.listTicketEvents(ticketId).some((e) => e.kind === "action" && e.body.startsWith("Sent the sign-in credential privately"))).toBe(true);

    await app.inject({ method: "PATCH", url: `/api/orgs/${contoso.id}`, payload: { settings: { paused: true } } });
    const paused = await app.inject({
      method: "POST",
      url: "/api/simulate",
      payload: { orgId: contoso.id, email: "alex.wilber@contoso.example", name: "Alex", text: "New problem" },
    });
    expect(paused.json().runId).toBeNull();
    expect(store.getTicket(paused.json().ticketId)!.assignee).toBe("unassigned");
    const resumed = await app.inject({ method: "POST", url: `/api/tickets/${ticketId}/run`, payload: {} });
    expect(resumed.statusCode).toBe(409);
    expect(store.listAudit().map((a) => a.action)).toContain("org.haley_paused");
    expect(threadId).toMatch(/^sim-/);
  });

  it("stops auto-starting Haley for a requester who floods new tickets", async () => {
    const llm = new ScriptedLlm(...Array.from({ length: 10 }, () => turn(text("ok"))));
    const { app, agent, store } = await makeApp(llm);
    const org = store.createOrg({ name: "Acme", domain: "acme.example" });
    const send = (i: number) =>
      app.inject({ method: "POST", url: "/api/simulate", payload: { orgId: org.id, email: "spam@acme.example", text: `issue ${i}`, threadId: `t${i}` } });
    for (let i = 0; i < 10; i++) {
      const res = (await send(i)).json();
      await agent.settled(res.runId);
    }
    const eleventh = (await send(10)).json();
    expect(eleventh.runId).toBeNull();
    expect(store.getTicket(eleventh.ticketId)!.assignee).toBe("unassigned");
    expect(store.listAudit().map((a) => a.action)).toContain("intake.throttled");
  });

  it("plan mode simulates every change and reports what the live policy would do", async () => {
    const llm = new ScriptedLlm(
      turn(
        toolUse("m365_get_user", { user: "alex.wilber@contoso.example" }),
        toolUse("m365_add_group_member", { user: "alex.wilber@contoso.example", group: "Accounts Payable Mailbox" }),
        toolUse("reply_to_requester", { message: "Done" }),
      ),
      turn(text("Plan: add Alex to AP (needs approval).")),
    );
    const { app, agent, store } = await makeApp(llm);
    await app.inject({ method: "POST", url: "/api/demo" });
    const ticket = store.listTickets().find((t) => t.title.startsWith("Add Alex"))!;
    const run = (await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/run`, payload: { mode: "plan" } })).json();
    await agent.settled(run.id);

    expect(store.getRun(run.id)).toMatchObject({ mode: "plan", status: "completed" });
    const actions = store.listActions({ runId: run.id });
    expect(actions.map((a) => [a.tool, a.status])).toEqual([
      ["m365_get_user", "executed"],
      ["m365_add_group_member", "planned"],
      ["reply_to_requester", "planned"],
    ]);
    expect(store.listTicketEvents(ticket.id).some((e) => e.kind === "reply")).toBe(false);
    expect(store.getTicket(ticket.id)!.status).toBe("new");
    const results = lastToolResults(llm.requests[1]);
    expect(results[1].content).toContain("would wait for technician approval");
  });
});
