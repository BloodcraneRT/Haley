import { describe, expect, it } from "vitest";
import { rankTechnicians, suggestTechnician } from "../src/dispatch.js";
import { fakeFetch, makeApp, ScriptedLlm, testConfig, text, toolUse, turn } from "./helpers.js";

async function setup(llm = new ScriptedLlm(), fetchImpl?: typeof fetch, channels = {}) {
  const base = testConfig();
  const haley = await makeApp(llm, { channels: { ...base.channels, ...channels } }, fetchImpl);
  const { store } = haley;
  const org = store.createOrg({ name: "Contoso", domain: "contoso.example" });
  for (const name of ["Dana Reyes", "Sam Lee", "Priya Patel"]) store.createTechnician({ name, email: `${name.split(" ")[0].toLowerCase()}@msp.example` });
  const past = (title: string, category: string, by: string, orgId = org.id) => {
    const t = store.createTicket({ orgId, title, description: title, category, requesterEmail: "x@contoso.example" });
    store.updateTicket(t.id, { status: "resolved" }, by);
    return t;
  };
  return { ...haley, org, past };
}

describe("dispatch suggestions", () => {
  it("prefers who fixed similar tickets for this client, explains why, and breaks ties by load", async () => {
    const { store, org, past } = await setup();
    past("Printer offline on floor 2", "printing", "Dana Reyes");
    past("Floor 2 printer offline again", "printing", "dana reyes");
    past("VPN drops every hour", "network", "Sam Lee");
    past("Outlook search broken", "email", "Sam Lee");
    // Haley's own resolutions and people outside the directory don't count.
    past("Printer offline in reception", "printing", "haley");
    past("Printer offline in lab", "printing", "Contractor Bob");

    const ticket = store.createTicket({ orgId: org.id, title: "Printer offline floor 2", description: "the floor 2 printer is offline", category: "printing" });
    const ranked = rankTechnicians(store, ticket);
    expect(ranked[0].technician.name).toBe("Dana Reyes");
    expect(ranked[0].reasons).toEqual(["resolved 2 similar tickets", "resolved 2 tickets for Contoso lately", "nothing open now"]);
    expect(ranked.map((c) => c.technician.name)).toEqual(["Dana Reyes", "Sam Lee", "Priya Patel"]);

    // With no history to go on, the one with fewer open tickets wins.
    const fresh = store.createTicket({ orgId: org.id, title: "New laptop setup", category: "devices" });
    for (let i = 0; i < 2; i++) store.updateTicket(store.createTicket({ orgId: org.id, title: `busy ${i}` }).id, { assignee: "Priya Patel" }, "tech");
    const busyRank = rankTechnicians(store, fresh);
    expect(busyRank.at(-1)!.technician.name).toBe("Priya Patel");
    expect(busyRank.at(-1)!.reasons).toContain("2 open now");
  });

  it("suggests nobody when the directory is empty or everyone is inactive", async () => {
    const haley = await makeApp();
    const org = haley.store.createOrg({ name: "Solo" });
    const ticket = haley.store.createTicket({ orgId: org.id, title: "x" });
    expect(suggestTechnician(haley.store, ticket)).toBeNull();
    const t = haley.store.createTechnician({ name: "Gone" });
    haley.store.updateTechnician(t.id, { active: false });
    expect(suggestTechnician(haley.store, ticket)).toBeNull();
  });

  it("stores a suggestion when Haley escalates, assigns it when the workspace says so, and lists options on demand", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("escalate_to_human", { reason: "Printer hardware fault", handoffNote: "Paper jam sensor" })),
      turn(text("Escalated.")),
      turn(toolUse("escalate_to_human", { reason: "Printer hardware fault", handoffNote: "Again" })),
      turn(text("Escalated.")),
    );
    const { app, store, agent, org, past } = await setup(llm);
    past("Printer jammed on floor 2", "printing", "Dana Reyes");
    const a = store.createTicket({ orgId: org.id, title: "Printer jammed floor 2", description: "printer jammed" });
    await agent.settled(agent.startTicketRun(a.id, "tech").id);
    expect(store.getTicket(a.id)).toMatchObject({ status: "escalated", assignee: "unassigned", suggested_assignee: { name: "Dana Reyes", reasons: expect.arrayContaining(["resolved 1 similar ticket"]) } });

    await app.inject({ method: "PATCH", url: "/api/helpdesk/settings", payload: { autoAssignOnEscalation: "suggested" } });
    const b = store.createTicket({ orgId: org.id, title: "Printer jammed again on floor 2", description: "printer jammed" });
    await agent.settled(agent.startTicketRun(b.id, "tech").id);
    expect(store.getTicket(b.id)).toMatchObject({ status: "escalated", assignee: "Dana Reyes" });
    expect(store.listAudit().find((x) => x.action === "ticket.auto_assigned")).toMatchObject({ target: b.id, detail: { to: "Dana Reyes" } });

    const options = (await app.inject({ url: `/api/tickets/${b.id}/assignee-suggestions` })).json();
    expect(options).toHaveLength(3);
    expect(options[0]).toMatchObject({ name: "Dana Reyes", reasons: expect.arrayContaining(["1 open now"]) });

    // A technician setting a ticket to escalated by hand doesn't trigger a suggestion.
    const c = store.createTicket({ orgId: org.id, title: "Printer jammed", description: "printer jammed" });
    await app.inject({ method: "PATCH", url: `/api/tickets/${c.id}`, payload: { status: "escalated" } });
    expect(store.getTicket(c.id)!.suggested_assignee).toBeNull();
  });

  it("names (and @mentions) the suggested technician in the Slack escalation notice", async () => {
    const net = fakeFetch([
      [/auth\.test/, () => ({ ok: true, team_id: "TMSP", team: "MSP" })],
      [/chat\.postMessage/, (c) => ({ ok: true, channel: c.json().channel, ts: "1.1" })],
    ]);
    const llm = new ScriptedLlm(turn(toolUse("escalate_to_human", { reason: "Needs hands on", handoffNote: "Printer" })), turn(text("Escalated.")));
    const { app, store, agent, org, past, approvalNotifier } = await setup(llm, net.impl, { slackSigningSecret: "s" });
    await app.inject({ method: "PUT", url: "/api/approvals/settings", payload: { slackBotToken: "xoxb-1", slackChannel: "C0APPROV" } });
    store.updateTechnician(store.findTechnician({ name: "Dana Reyes" })!.id, { slackUserId: "U0DANA" });
    past("Printer jammed on floor 2", "printing", "Dana Reyes");
    const t = store.createTicket({ orgId: org.id, title: "Printer jammed floor 2", description: "printer jammed" });
    await agent.settled(agent.startTicketRun(t.id, "tech").id);
    await approvalNotifier.idle();
    const notice = net.calls.find((c) => c.url.includes("chat.postMessage"))!.json();
    expect(JSON.stringify(notice.blocks)).toContain("Suggested: <@U0DANA> (resolved 1 similar ticket");
  });
});
