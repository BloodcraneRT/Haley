import { describe, expect, it } from "vitest";
import { nextOccurrence } from "../src/scheduler.js";
import { slaFor } from "../src/sla.js";
import { DEFAULT_ORG_SETTINGS, type Ticket } from "../src/types.js";
import { lastToolResults, makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

const HOUR = 3_600_000;

describe("SLA", () => {
  const base = {
    priority: "high",
    created_at: "2026-09-01T00:00:00.000Z",
    first_response_at: null,
    resolved_at: null,
  } as unknown as Ticket;
  const t0 = Date.parse(base.created_at);

  it("tracks pending, at-risk, breached and met timers", () => {
    // high: 60 min response, 480 min resolution
    expect(slaFor(base, DEFAULT_ORG_SETTINGS.sla, t0 + 10 * 60_000)).toMatchObject({ response: "pending", resolution: "pending" });
    expect(slaFor(base, DEFAULT_ORG_SETTINGS.sla, t0 + 50 * 60_000).response).toBe("at_risk");
    expect(slaFor(base, DEFAULT_ORG_SETTINGS.sla, t0 + 2 * HOUR)).toMatchObject({ response: "breached", resolution: "pending" });
    const answered = { ...base, first_response_at: "2026-09-01T00:30:00.000Z", resolved_at: "2026-09-01T09:00:00.000Z" };
    expect(slaFor(answered, DEFAULT_ORG_SETTINGS.sla, t0 + 24 * HOUR)).toMatchObject({ response: "met", resolution: "breached" });
    expect(slaFor(base, DEFAULT_ORG_SETTINGS.sla).resolutionDue).toBe("2026-09-01T08:00:00.000Z");
  });

  it("stamps first response (not auto-acks) and resolution on tickets", async () => {
    const { store } = await makeApp();
    const org = store.createOrg({ name: "Acme" });
    const t = store.createTicket({ orgId: org.id, title: "x" });
    store.addTicketEvent(t.id, "reply", "haley", "Got it", { auto: true });
    expect(store.getTicket(t.id)!.first_response_at).toBeNull();
    store.addTicketEvent(t.id, "reply", "haley", "Fixed it");
    expect(store.getTicket(t.id)!.first_response_at).not.toBeNull();
    store.setTicketStatus(t.id, "resolved", "tech");
    expect(store.getTicket(t.id)!.resolved_at).not.toBeNull();
    store.setTicketStatus(t.id, "in_progress", "tech");
    expect(store.getTicket(t.id)!.resolved_at).toBeNull();
  });
});

describe("scheduler", () => {
  it("computes the next occurrence and skips missed runs", () => {
    const now = Date.parse("2026-09-10T12:00:00Z");
    expect(nextOccurrence("2026-09-10T09:00:00Z", "daily", now)).toBe("2026-09-11T09:00:00.000Z");
    expect(nextOccurrence("2026-08-01T09:00:00Z", "weekly", now)).toBe("2026-09-12T09:00:00.000Z");
    expect(nextOccurrence("2026-08-15T09:00:00Z", "monthly", now)).toBe("2026-09-15T09:00:00.000Z");
    expect(nextOccurrence("2026-09-10T09:00:00Z", "once", now)).toBeNull();
  });

  it("fires due recurring tasks, advances them, and skips paused clients", async () => {
    const llm = new ScriptedLlm(turn(text("Weekly review done.")));
    const { app, store, agent, scheduler } = await makeApp(llm);
    const org = store.createOrg({ name: "Acme" });
    const res = await app.inject({
      method: "POST",
      url: "/api/schedules",
      payload: { orgId: org.id, title: "Weekly security review", instruction: "Review MFA gaps", cadence: "weekly", startAt: new Date(Date.now() - 60_000).toISOString() },
    });
    const schedule = res.json();
    const tick = await scheduler.tick();
    expect(tick.started).toHaveLength(1);
    await agent.settled(tick.started[0].runId);
    expect(store.getRun(tick.started[0].runId)).toMatchObject({ kind: "task", status: "completed", title: "Weekly security review" });
    const after = store.getSchedule(schedule.id)!;
    expect(after.enabled).toBe(true);
    expect(Date.parse(after.next_run_at!)).toBeGreaterThan(Date.now() + 6 * 24 * HOUR);

    store.updateOrg(org.id, { settings: { paused: true } });
    store.updateSchedule(schedule.id, { next_run_at: new Date(Date.now() - 1000).toISOString() });
    const pausedTick = await scheduler.tick();
    expect(pausedTick.started).toHaveLength(0);
    expect(pausedTick.skipped[0].reason).toMatch(/paused/);
  });

  it("lets Haley schedule a one-off follow-up that runs on the ticket with its requester's authority", async () => {
    const runAt = new Date(Date.now() + 2 * HOUR).toISOString();
    const llm = new ScriptedLlm(
      turn(toolUse("schedule_follow_up", { runAt, instruction: "Remove Alex from the Accounts Payable Mailbox group." })),
      turn(text("Added temporary access; removal scheduled.")),
      turn(toolUse("m365_remove_group_member", { user: "alex.wilber@contoso.example", group: "Accounts Payable Mailbox" })),
      turn(text("Removed.")),
    );
    const { app, store, agent, scheduler } = await makeApp(llm);
    await app.inject({ method: "POST", url: "/api/demo" });
    const ticket = store.listTickets().find((t) => t.title.startsWith("Add Alex"))!;
    const first = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(first.id);
    const [schedule] = store.listSchedules({ ticketId: ticket.id });
    expect(schedule).toMatchObject({ cadence: "once", created_by: "haley", next_run_at: runAt });

    expect((await scheduler.tick()).started).toHaveLength(0);
    const tick = await scheduler.tick(Date.now() + 3 * HOUR);
    expect(tick.started).toHaveLength(1);
    const followUp = store.getRun(tick.started[0].runId)!;
    expect(followUp).toMatchObject({ ticket_id: ticket.id, instruction: expect.stringContaining("Remove Alex") });
    await agent.settled(followUp.id);
    expect(llm.requests[2].messages[0].content).toContain("follow-up you scheduled earlier");
    // Contoso is supervised, and the dashboard-entered ticket carries technician authority: still needs approval.
    expect(store.listActions({ runId: followUp.id })[0].status).toBe("pending_approval");
    expect(store.getSchedule(schedule.id)!.enabled).toBe(false);
  });

  it("rejects follow-ups in the past", async () => {
    const llm = new ScriptedLlm(turn(toolUse("schedule_follow_up", { runAt: "2020-01-01T00:00:00Z", instruction: "Check again" })), turn(text("ok")));
    const { app, store, agent } = await makeApp(llm);
    await app.inject({ method: "POST", url: "/api/demo" });
    const run = agent.startTicketRun(store.listTickets()[0].id, "tech");
    await agent.settled(run.id);
    expect(lastToolResults(llm.requests[1])[0]).toMatchObject({ is_error: true, content: expect.stringContaining("future") });
  });

  it("escalates tickets that breach their resolution SLA", async () => {
    const { store, scheduler } = await makeApp();
    const org = store.createOrg({ name: "Acme" });
    const t = store.createTicket({ orgId: org.id, title: "Urgent thing", priority: "urgent" });
    expect((await scheduler.tick()).escalated).toHaveLength(0);
    const tick = await scheduler.tick(Date.now() + 5 * HOUR);
    expect(tick.escalated).toEqual([t.id]);
    expect(store.getTicket(t.id)).toMatchObject({ status: "escalated", assignee: "unassigned", sla_escalated: true });
    expect((await scheduler.tick(Date.now() + 6 * HOUR)).escalated).toHaveLength(0);
  });
});

describe("Temporary Access Pass", () => {
  it("issues a TAP in self-service and delivers it privately", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("m365_issue_temporary_access_pass", { user: "megan.bowen@contoso.example" })),
      turn(text("Issued a TAP.")),
    );
    const { app, store, agent } = await makeApp(llm);
    await app.inject({ method: "POST", url: "/api/demo" });
    const contoso = store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
    store.updateOrg(contoso.id, { autonomy: "unattended" });
    const res = await app.inject({
      method: "POST",
      url: "/api/simulate",
      payload: { orgId: contoso.id, email: "megan.bowen@contoso.example", name: "Megan", text: "New phone, can't do MFA" },
    });
    await agent.settled(res.json().runId);
    const action = store.listActions({ runId: res.json().runId })[0];
    expect(action).toMatchObject({ tool: "m365_issue_temporary_access_pass", status: "executed", has_secrets: true });
    const pass = store.revealActionSecrets(action.id)!.temporaryAccessPass;
    expect(pass).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
    const [result] = lastToolResults(llm.requests[1]);
    expect(result.content).toContain("sent privately");
    expect(result.content).not.toContain(pass);
  });
});

describe("client report", () => {
  it("summarizes tickets, automation, SLA and time saved", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("reply_to_requester", { message: "Fixed" }), toolUse("update_ticket", { status: "resolved", category: "email" })),
      turn(text("done")),
    );
    const { app, store, agent } = await makeApp(llm);
    await app.inject({ method: "POST", url: "/api/demo" });
    const contoso = store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
    const [ticket] = store.listTickets({ orgId: contoso.id });
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    const other = store.listTickets({ orgId: contoso.id }).find((t) => t.id !== ticket.id)!;
    store.addTicketEvent(other.id, "comment", "Jordan", "I'll take this one");
    store.setTicketStatus(other.id, "resolved", "Jordan");

    const report = (await app.inject({ url: `/api/orgs/${contoso.id}/report?days=30&minutesPerTicket=30` })).json();
    expect(report.tickets).toMatchObject({ opened: 3, resolved: 2, resolvedByHaleyAlone: 1, automationRate: 50 });
    expect(report.tickets.byChannel).toEqual([{ name: "portal", count: 3 }]);
    expect(report.sla.responseCompliance).toBe(100);
    expect(report.timeSaved.hours).toBe(0.5);
    expect(report.timeSaved.assumptions).toContain("30 technician minutes");
  });
});
