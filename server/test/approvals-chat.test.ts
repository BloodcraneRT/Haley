import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeFetch, lastToolResults, makeApp, ScriptedLlm, testConfig, text, toolUse, turn, type FetchCall } from "./helpers.js";

const SIGNING = "slack-signing-secret";
const PUBLIC = "https://haley.msp.example";
const MSP_TEAM = "TMSP0001";

function slackFake(users: Record<string, string> = { U0DANA: "dana@msp.example" }) {
  let ts = 0;
  return fakeFetch([
    [/slack\.com\/api\/auth\.test/, () => ({ ok: true, team_id: MSP_TEAM, team: "MSP" })],
    [/slack\.com\/api\/chat\.postMessage/, (c) => ({ ok: true, channel: c.json().channel, ts: `1700000000.${++ts}` })],
    [/slack\.com\/api\/chat\.update/, () => ({ ok: true })],
    [/slack\.com\/api\/views\.open/, () => ({ ok: true })],
    [/slack\.com\/api\/users\.info/, (c) => (users[c.json().user] ? { ok: true, user: { id: c.json().user, profile: { email: users[c.json().user] } } } : { ok: true, user: { profile: {} } })],
    [/hooks\.slack\.com\/actions/, () => ({ ok: true })],
  ]);
}

async function setup(llm: ScriptedLlm, net = slackFake(), opts: { title?: string } = {}) {
  const base = testConfig();
  const haley = await makeApp(llm, { channels: { ...base.channels, slackSigningSecret: SIGNING, publicUrl: PUBLIC } }, net.impl);
  const { app, store } = haley;
  const org = store.createOrg({ name: "Contoso", domain: "contoso.example", autonomy: "supervised" });
  store.createIntegration({ orgId: org.id, provider: "m365", label: "Contoso M365", mode: "sandbox", config: {} });
  const settings = await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { slackBotToken: "xoxb-1-msp", slackChannel: "C0APPROV" } });
  expect(settings.json()).toMatchObject({ slackConnected: true, slackTeamId: MSP_TEAM, slackChannel: "C0APPROV", interactivityUrl: `${PUBLIC}/hooks/slack/interactivity` });
  await app.inject({ method: "POST", url: "/api/technicians", payload: { name: "Dana Reyes", email: "dana@msp.example" } });
  const ticket = store.createTicket({
    orgId: org.id,
    title: opts.title ?? "Isaiah locked out",
    description: "Isaiah can't sign in",
    requesterName: "Grady Archie",
    requesterEmail: "grady.archie@contoso.example",
  });
  return { ...haley, net, org, ticket };
}

/** Sends a Slack interactivity request the way Slack signs it. */
async function slackPost(app: Awaited<ReturnType<typeof makeApp>>["app"], payload: unknown, secret = SIGNING) {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return app.inject({
    method: "POST",
    url: "/hooks/slack/interactivity",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    payload: body,
  });
}

const click = (actionId: string, button: "haley_approve" | "haley_reject" | "haley_changes", user = "U0DANA", team = MSP_TEAM) => ({
  type: "block_actions",
  team: { id: team },
  user: { id: user },
  trigger_id: "trig-1",
  response_url: "https://hooks.slack.com/actions/T/1/xyz",
  actions: [{ action_id: button, value: actionId }],
});

const submitModal = (actionId: string, decision: "reject" | "changes", note: string, user = "U0DANA") => ({
  type: "view_submission",
  team: { id: MSP_TEAM },
  user: { id: user },
  view: { callback_id: "haley_decide", private_metadata: JSON.stringify({ actionId, decision }), state: { values: { note: { value: { value: note } } } } },
});

async function until(check: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const posts = (calls: FetchCall[], method: string) => calls.filter((c) => c.url.includes(`/api/${method}`)).map((c) => c.json());
const ephemeral = (calls: FetchCall[]) => calls.filter((c) => c.url.includes("hooks.slack.com")).map((c) => c.json().text as string);

const RESET = () =>
  new ScriptedLlm(
    turn(text("Checking the account first."), toolUse("m365_get_user", { user: "isaiah.langer@contoso.example" })),
    turn(text("His manager asked; resetting."), toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })),
    turn(text("Done.")),
  );

describe("approval cards in Slack", () => {
  it("posts a card with the change, the reason and what Haley checked, and approving from Slack resumes the run", async () => {
    const { app, store, agent, approvalNotifier, net, ticket } = await setup(RESET());
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    await approvalNotifier.idle();

    const [pending] = store.listActions({ status: "pending_approval" });
    const [card] = posts(net.calls, "chat.postMessage");
    expect(card.channel).toBe("C0APPROV");
    const blocks = JSON.stringify(card.blocks);
    expect(blocks).toContain("Approval needed");
    expect(blocks).toContain("Reset password for isaiah.langer@contoso.example");
    expect(blocks).toContain("She checked");
    expect(blocks).toContain(`${PUBLIC}/tickets/${ticket.id}`);
    expect(blocks).toContain("Grady Archie");
    const buttons = card.blocks.find((b: { type: string }) => b.type === "actions").elements;
    expect(buttons.map((b: { action_id: string }) => b.action_id)).toEqual(["haley_approve", "haley_reject", "haley_changes", "haley_open"]);
    expect(buttons[0].value).toBe(pending.id);

    const res = await slackPost(app, click(pending.id, "haley_approve"));
    expect(res.statusCode).toBe(200);
    await until(() => store.getAction(pending.id)!.status !== "pending_approval");
    await agent.settled(run.id);
    await approvalNotifier.idle();

    expect(store.getAction(pending.id)).toMatchObject({ status: "executed", decided_by: "Dana Reyes" });
    expect(store.getRun(run.id)!.status).toBe("completed");
    // Dana was matched by her Slack profile email and linked for next time.
    expect(store.findTechnician({ slackUserId: "U0DANA" })?.name).toBe("Dana Reyes");
    const [update] = posts(net.calls, "chat.update");
    expect(update).toMatchObject({ channel: "C0APPROV", ts: "1700000000.1" });
    expect(JSON.stringify(update.blocks)).toContain("*Approved* by Dana Reyes");
    expect(update.blocks.some((b: { type: string }) => b.type === "actions")).toBe(false);
    // The temporary password never goes to Slack.
    const secret = store.revealActionSecrets(pending.id)!.temporaryPassword;
    expect(JSON.stringify(net.calls.map((c) => c.body))).not.toContain(secret);
  });

  it("asks for changes through a modal, and Haley gets the note", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })),
      turn(text("Understood: I'll ask his manager to confirm first.")),
    );
    const { app, store, agent, approvalNotifier, net, ticket } = await setup(llm);
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    const [pending] = store.listActions({ status: "pending_approval" });

    await slackPost(app, click(pending.id, "haley_changes"));
    await until(() => posts(net.calls, "views.open").length > 0);
    const [opened] = posts(net.calls, "views.open");
    expect(opened.trigger_id).toBe("trig-1");
    expect(JSON.parse(opened.view.private_metadata)).toEqual({ actionId: pending.id, decision: "changes" });
    expect(store.getAction(pending.id)!.status).toBe("pending_approval");

    // A note is required.
    const empty = await slackPost(app, submitModal(pending.id, "changes", " "));
    expect(empty.json()).toEqual({ response_action: "errors", errors: { note: "Say what should change." } });

    const done = await slackPost(app, submitModal(pending.id, "changes", "Confirm with his manager first"));
    expect(done.statusCode).toBe(200);
    expect(done.body).toBe("");
    await agent.settled(run.id);
    await approvalNotifier.idle();

    expect(store.getAction(pending.id)).toMatchObject({ status: "changes_requested", decided_by: "Dana Reyes", decision_note: "Confirm with his manager first" });
    const messages = JSON.stringify(store.getRunMessages(run.id));
    expect(messages).toContain("asked for changes before this can run");
    expect(messages).toContain("Confirm with his manager first");
    // The model saw it as a failed tool call with the technician's note.
    expect(lastToolResults(llm.requests[1])[0]).toMatchObject({ is_error: true });
    expect(JSON.stringify(posts(net.calls, "chat.update")[0].blocks)).toContain("*Changes requested* by Dana Reyes");
    expect(store.listAudit().some((a) => a.action === "action.changes_requested" && a.actor === "Dana Reyes")).toBe(true);
  });

  it("refuses people outside the directory, the wrong approver, other workspaces and bad signatures", async () => {
    const { app, store, agent, approvalNotifier, net, ticket, org } = await setup(
      new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })), turn(text("ok"))),
      slackFake({ U0DANA: "dana@msp.example", U0STRANGER: "someone@else.example", U0SAM: "sam@msp.example" }),
    );
    await app.inject({ method: "POST", url: "/api/technicians", payload: { name: "Sam Lee", email: "sam@msp.example" } });
    // Only Dana may approve password resets for this client.
    store.updateOrg(org.id, {
      settings: {
        policyRules: [{ id: "r", name: "Resets need Dana", enabled: true, tools: ["m365_reset_password"], risks: [], targets: [], departments: [], requesters: [], effect: "approve", approvers: ["Dana Reyes"], minAssurance: "directory" }],
      },
    });
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    const [pending] = store.listActions({ status: "pending_approval" });
    expect(JSON.stringify(posts(net.calls, "chat.postMessage")[0].blocks)).toContain("Only Dana Reyes can decide");

    expect((await slackPost(app, click(pending.id, "haley_approve"), "wrong-secret")).statusCode).toBe(401);

    await slackPost(app, click(pending.id, "haley_approve", "U0STRANGER"));
    await until(() => ephemeral(net.calls).length === 1);
    expect(ephemeral(net.calls)[0]).toContain("You're not set up as a technician in Haley");

    await slackPost(app, click(pending.id, "haley_approve", "U0SAM"));
    await until(() => ephemeral(net.calls).length === 2);
    expect(ephemeral(net.calls)[1]).toBe("Only Dana Reyes can decide this (client policy).");

    // A click from a client's workspace (same Slack app) is ignored entirely.
    await slackPost(app, click(pending.id, "haley_approve", "U0DANA", "TCLIENT1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getAction(pending.id)!.status).toBe("pending_approval");
    expect(store.findTechnician({ slackUserId: "U0DANA" })).toBeNull();

    // Decided in the dashboard first: the Slack click is told, and the card is updated.
    await agent.decideAction(pending.id, false, "Dana Reyes", "Not today");
    await slackPost(app, click(pending.id, "haley_approve"));
    await until(() => ephemeral(net.calls).length === 3);
    expect(ephemeral(net.calls)[2]).toBe("Already decided by Dana Reyes.");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    expect(JSON.stringify(posts(net.calls, "chat.update")[0].blocks)).toContain("*Rejected* by Dana Reyes");
  });

  it("keeps sensitive changes dashboard-only when the workspace says so", async () => {
    const { app, store, agent, approvalNotifier, net, ticket } = await setup(
      new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })), turn(text("ok"))),
    );
    expect((await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { chatApprovalMaxRisk: "write" } })).json()).toMatchObject({ chatApprovalMaxRisk: "write" });
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    const [pending] = store.listActions({ status: "pending_approval" });
    const [card] = posts(net.calls, "chat.postMessage");
    const buttons = card.blocks.find((b: { type: string }) => b.type === "actions").elements;
    expect(buttons.map((b: { text: { text: string } }) => b.text.text)).toEqual(["Approve in Haley"]);
    // A forged click is refused too.
    await slackPost(app, click(pending.id, "haley_approve"));
    await until(() => ephemeral(net.calls).length === 1);
    expect(ephemeral(net.calls)[0]).toContain("approved in the Haley dashboard");
    expect(store.getAction(pending.id)!.status).toBe("pending_approval");
  });

  it("posts escalations Haley makes, escapes ticket text, and stays quiet when a technician escalates", async () => {
    const { app, store, agent, approvalNotifier, net, ticket } = await setup(
      new ScriptedLlm(turn(toolUse("escalate_to_human", { reason: "Needs on-site work", handoffNote: "Laptop screen <cracked> & flickering" })), turn(text("Escalated."))),
      slackFake(),
      { title: "<!channel> help & <https://evil.example|click>" },
    );
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    const [notice] = posts(net.calls, "chat.postMessage");
    const body = JSON.stringify(notice.blocks);
    expect(body).toContain("Escalated to a technician");
    expect(body).toContain("&lt;!channel&gt; help &amp; &lt;https://evil.example|click&gt;");
    expect(body).not.toContain("<!channel>");

    const other = store.createTicket({ orgId: ticket.org_id, title: "Manual", description: "x", requesterEmail: "a@contoso.example" });
    await app.inject({ method: "PATCH", url: `/api/tickets/${other.id}`, payload: { status: "escalated" } });
    await approvalNotifier.idle();
    expect(posts(net.calls, "chat.postMessage")).toHaveLength(1);

    await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { escalationNotices: false } });
    store.updateTicket(other.id, { status: "in_progress" }, "tech");
    store.updateTicket(other.id, { status: "escalated" }, "haley");
    await approvalNotifier.idle();
    expect(posts(net.calls, "chat.postMessage")).toHaveLength(1);
  });

  it("validates settings, tests the channel, and never echoes the token", async () => {
    const net = fakeFetch([
      [/auth\.test/, (c) => (c.headers.authorization === "Bearer xoxb-good" ? { ok: true, team_id: MSP_TEAM, team: "MSP" } : { ok: false, error: "invalid_auth" })],
      [/chat\.postMessage/, (c) => (c.json().channel === "C0NOTIN" ? { ok: false, error: "not_in_channel" } : { ok: true, channel: c.json().channel, ts: "1.1" })],
    ]);
    const base = testConfig();
    const { app, store } = await makeApp(new ScriptedLlm(), { channels: { ...base.channels, slackSigningSecret: SIGNING, publicUrl: PUBLIC } }, net.impl);
    const bad = await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { slackBotToken: "xoxb-bad" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("invalid_auth");
    expect((await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { slackBotToken: "xoxp-user-token" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { slackChannel: "#general" } })).statusCode).toBe(400);

    const ok = await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { slackBotToken: "xoxb-good", slackChannel: "C0NOTIN" } });
    expect(ok.body).not.toContain("xoxb-good");
    expect(JSON.stringify(store.listAudit())).not.toContain("xoxb-good");
    const test = await app.inject({ method: "POST", url: "/api/approvals/test", payload: {} });
    expect(test.statusCode).toBe(400);
    expect(test.json().error).toContain("Invite the Haley app");

    const org = store.createOrg({ name: "Fabrikam" });
    expect((await app.inject({ method: "PATCH", url: `/api/orgs/${org.id}`, payload: { settings: { approvalSlackChannel: "C0FABRIK" } } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/approvals/test", payload: { orgId: org.id } })).json()).toEqual({ ok: true, channel: "C0FABRIK" });

    const removed = await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { slackBotToken: null } });
    expect(removed.json()).toMatchObject({ slackConnected: false, slackTeamId: "" });
  });

  it("lets the dashboard ask for changes, which needs a note", async () => {
    const { app, store, agent, approvalNotifier, ticket } = await setup(
      new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })), turn(text("ok"))),
    );
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    await approvalNotifier.idle();
    const [pending] = store.listActions({ status: "pending_approval" });
    expect((await app.inject({ method: "POST", url: `/api/actions/${pending.id}/request-changes`, payload: { note: "" } })).statusCode).toBe(400);
    const res = await app.inject({ method: "POST", url: `/api/actions/${pending.id}/request-changes`, headers: { "x-haley-user": "Dana Reyes" }, payload: { note: "Use the manager's request" } });
    expect(res.json()).toMatchObject({ status: "changes_requested", decided_by: "Dana Reyes" });
    await agent.settled(run.id);
    expect(store.listTicketEvents(ticket.id).some((e) => e.body.startsWith("Changes requested: Reset password"))).toBe(true);
  });
});
