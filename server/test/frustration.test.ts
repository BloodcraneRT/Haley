import { describe, expect, it } from "vitest";
import { frustrationSignals } from "../src/frustration.js";
import { firstUserText, makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

const calm = { repeatTickets: 1, haleyResolvedBefore: false, slaBreached: false };

describe("frustration signals", () => {
  it("scores explainable cues and ignores calm or happy messages", () => {
    expect(frustrationSignals("Hi, Outlook won't open this morning.", calm)).toEqual({ score: 0, reasons: [] });
    expect(frustrationSignals("Thanks, it works!!", { ...calm, haleyResolvedBefore: true })).toEqual({ score: 1, reasons: ["repeated exclamation marks"] });
    // A calm "still not working" after Haley's fix is one signal, so it goes back to her.
    expect(frustrationSignals("It's still not working after the reset.", { ...calm, haleyResolvedBefore: true })).toEqual({ score: 1, reasons: ["says Haley's earlier fix didn't hold"] });
    const angry = frustrationSignals("This is the THIRD TIME this week and it's still broken. Unacceptable!!", calm);
    expect(angry.score).toBeGreaterThanOrEqual(3);
    expect(angry.reasons).toEqual(expect.arrayContaining(["says it's happened several times", "strong language", "repeated exclamation marks"]));
    expect(frustrationSignals("WHY IS NOTHING WORKING TODAY", calm).reasons).toContain("writing in capitals");
    expect(frustrationSignals("printer again", { repeatTickets: 4, haleyResolvedBefore: false, slaBreached: true })).toEqual({ score: 2, reasons: ["4 tickets in a week", "past the SLA target"] });
  });
});

async function setup(llm: ScriptedLlm) {
  const haley = await makeApp(llm);
  const org = haley.store.createOrg({ name: "Contoso", domain: "contoso.example", settings: { vipRequesters: ["ceo@contoso.example"] } });
  haley.store.createIntegration({ orgId: org.id, provider: "m365", label: "M365", mode: "sandbox", config: {} });
  return { ...haley, org };
}

describe("needs-care flags", () => {
  it("flags a frustrated requester, tells Haley, and lets a technician clear it", async () => {
    const llm = new ScriptedLlm(turn(text("Looking into it.")));
    const { app, store, agent, org } = await setup(llm);
    const sim = await app.inject({
      method: "POST",
      url: "/api/simulate",
      payload: { orgId: org.id, email: "megan.bowen@contoso.example", name: "Megan", text: "Third time this week my VPN dropped. This is ridiculous!!" },
    });
    const ticket = store.getTicket(sim.json().ticketId)!;
    expect(ticket.flags.frustrated).toMatchObject({ confirmed: false, reason: expect.stringContaining("several times") });
    await agent.settled(sim.json().runId);
    expect(firstUserText(llm.requests[0])).toContain("The requester seems frustrated");

    const list = (await app.inject({ url: "/api/tickets?flag=frustrated" })).json();
    expect(list.map((t: { id: string }) => t.id)).toEqual([ticket.id]);
    expect((await app.inject({ method: "DELETE", url: `/api/tickets/${ticket.id}/flags/frustrated` })).json().flags).toEqual({});
    expect((await app.inject({ url: "/api/tickets?flag=frustrated" })).json()).toEqual([]);
    expect(store.listAudit().map((a) => a.action)).toEqual(expect.arrayContaining(["ticket.flagged_frustrated", "ticket.flag_cleared"]));
  });

  it("raises a VIP's priority and says so to Haley and in the snapshot", async () => {
    const llm = new ScriptedLlm(turn(text("On it.")));
    const { app, store, agent, org } = await setup(llm);
    const sim = await app.inject({ method: "POST", url: "/api/simulate", payload: { orgId: org.id, email: "ceo@contoso.example", name: "Pat", text: "Teams keeps logging me out" } });
    const ticket = store.getTicket(sim.json().ticketId)!;
    expect(ticket).toMatchObject({ priority: "high", flags: { vip: true } });
    await agent.settled(sim.json().runId);
    expect(firstUserText(llm.requests[0])).toContain("The requester is a VIP for this client");
    const snapshot = (await app.inject({ url: `/api/tickets/${ticket.id}/requester` })).json();
    expect(snapshot.flags).toEqual(expect.arrayContaining([{ level: "info", text: "VIP for this client" }]));
  });

  it("hands a frustrated requester to a technician when Haley's fix didn't hold, but lets a calm one go back to her", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("update_ticket", { status: "resolved" }), toolUse("reply_to_requester", { message: "Reset your VPN profile; it should work now." })),
      turn(text("Resolved.")),
      // The calm reopen gets another pass.
      turn(text("Taking another look.")),
    );
    const { app, store, agent, org } = await setup(llm);
    const send = (textBody: string, threadId?: string) =>
      app.inject({ method: "POST", url: "/api/simulate", payload: { orgId: org.id, email: "megan.bowen@contoso.example", name: "Megan", text: textBody, threadId } });

    const first = (await send("My VPN won't connect")).json();
    await agent.settled(first.runId);
    expect(store.getTicket(first.ticketId)!.status).toBe("resolved");

    const calm = (await send("It's still not connecting, sorry.", first.threadId)).json();
    expect(calm.runId).toBeTruthy();
    await agent.settled(calm.runId);

    store.updateTicket(first.ticketId, { status: "resolved" }, "haley");
    const angry = (await send("It's STILL not working!! This is ridiculous.", first.threadId)).json();
    expect(angry.runId).toBeNull();
    const ticket = store.getTicket(first.ticketId)!;
    expect(ticket).toMatchObject({ status: "escalated", assignee: "unassigned" });
    expect(ticket.flags.frustrated).toBeTruthy();
    const events = store.listTicketEvents(ticket.id);
    expect(events.find((e) => e.kind === "escalation")!.body).toContain("says Haley's earlier fix didn't hold");
    await new Promise((r) => setTimeout(r, 10));
    expect(store.listTicketEvents(ticket.id).at(-1)).toMatchObject({ kind: "reply", body: expect.stringContaining("passed it to one of our technicians") });
  });

  it("lets the optional model check confirm or clear the flag, billed as sentiment", async () => {
    const llm = new ScriptedLlm(turn(text('{"frustrated": false, "reason": "just emphatic"}')), turn(text('{"frustrated": true, "reason": "angry about repeat outages"}')));
    const { app, store, org, frustration } = await setup(llm);
    await app.inject({ method: "PATCH", url: "/api/helpdesk/settings", payload: { sentimentModelCheck: true } });
    const a = store.createTicket({ orgId: org.id, title: "Urgent!!", description: "Need this asap, third time asking!!", requesterEmail: "a@contoso.example" });
    await frustration.idle();
    expect(store.getTicket(a.id)!.flags.frustrated).toBeUndefined();
    const b = store.createTicket({ orgId: org.id, title: "Down again", description: "Fed up, this is the third time!!", requesterEmail: "b@contoso.example" });
    await frustration.idle();
    expect(store.getTicket(b.id)!.flags.frustrated).toMatchObject({ confirmed: true, reason: "angry about repeat outages" });
    expect(store.db.prepare("SELECT DISTINCT purpose FROM model_usage").all()).toEqual([{ purpose: "sentiment" }]);
  });
});
