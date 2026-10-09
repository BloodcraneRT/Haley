import { describe, expect, it } from "vitest";
import { makeApp, ScriptedLlm, text, turn } from "./helpers.js";

async function setup(llm = new ScriptedLlm()) {
  const haley = await makeApp(llm);
  const org = haley.store.createOrg({ name: "Contoso", domain: "contoso.example" });
  const ticket = haley.store.createTicket({
    orgId: org.id,
    title: "Printer offline",
    description: "The 2nd floor printer says offline",
    requesterName: "Megan Bowen",
    requesterEmail: "megan.bowen@contoso.example",
    channel: "email",
  });
  // Megan follows up; then a technician picks it up.
  haley.store.addTicketEvent(ticket.id, "comment", "Megan Bowen", "Still offline this morning", { channel: "email", fromRequester: true });
  return { ...haley, org, ticket };
}

const codes = (res: { json: () => { issues: Array<{ code: string }> } }) => res.json().issues.map((i) => i.code);

describe("checks before closing a ticket", () => {
  it("flags an unanswered requester and a missing resolution note, then clears as the technician works", async () => {
    const { app, ticket } = await setup();
    let res = await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/qa` });
    expect(res.json()).toMatchObject({ mode: "warn", modelChecked: false });
    expect(codes(res)).toEqual(["no_reply", "no_resolution_note"]);
    expect(res.json().issues[0].text).toBe("Megan Bowen hasn't had a reply since their last message.");

    await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/comments`, payload: { body: "Power-cycled the printer and re-added the queue." } });
    expect(codes(await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/qa` }))).toEqual(["no_reply"]);

    // A promise in the reply, with nothing after it, is a hint (it never blocks).
    await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/comments`, payload: { kind: "reply", body: "It's back online. I'll check back tomorrow to make sure it stays up." } });
    res = await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/qa` });
    expect(res.json().issues).toEqual([{ code: "unkept_promise", level: "hint", text: expect.stringContaining("I'll check back tomorrow") }]);
    await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/comments`, payload: { body: "Checked: still online." } });
    expect(codes(await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/qa` }))).toEqual([]);
  });

  it("doesn't ask for a reply on monitoring tickets, and counts Haley's summary as the note", async () => {
    const { app, store, org } = await setup();
    const alert = store.createTicket({ orgId: org.id, title: "Disk low on SRV01", channel: "monitoring" });
    expect(codes(await app.inject({ method: "POST", url: `/api/tickets/${alert.id}/qa` }))).toEqual(["no_resolution_note"]);
    store.addTicketEvent(alert.id, "agent_note", "haley", "Waiting for technician approval on 1 action.", { runId: "run_x" });
    expect(codes(await app.inject({ method: "POST", url: `/api/tickets/${alert.id}/qa` }))).toEqual(["no_resolution_note"]);
    store.addTicketEvent(alert.id, "agent_note", "haley", "Cleared 12 GB of temp files; 40% free now.", { runId: "run_x", summary: true });
    expect(codes(await app.inject({ method: "POST", url: `/api/tickets/${alert.id}/qa` }))).toEqual([]);
  });

  it("requires a reason to close despite warnings when the workspace says so, and audits it", async () => {
    const { app, store, ticket } = await setup();
    // Warn (default): closing isn't blocked.
    const other = store.createTicket({ orgId: ticket.org_id, title: "x", requesterEmail: "a@contoso.example", channel: "email" });
    expect((await app.inject({ method: "PATCH", url: `/api/tickets/${other.id}`, payload: { status: "resolved" } })).statusCode).toBe(200);

    expect((await app.inject({ method: "PATCH", url: "/api/helpdesk/settings", payload: { qaBeforeClose: "require" } })).json()).toMatchObject({ qaBeforeClose: "require" });
    const blocked = await app.inject({ method: "PATCH", url: `/api/tickets/${ticket.id}`, payload: { status: "closed" } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain("hasn't had a reply");
    expect(store.getTicket(ticket.id)!.status).not.toBe("closed");

    const forced = await app.inject({ method: "PATCH", url: `/api/tickets/${ticket.id}`, headers: { "x-haley-user": "Dana" }, payload: { status: "closed", qaOverride: "Answered by phone" } });
    expect(forced.statusCode).toBe(200);
    expect(store.listAudit().find((a) => a.action === "ticket.qa_override")).toMatchObject({ actor: "Dana", detail: { issues: ["no_reply", "no_resolution_note"], reason: "Answered by phone" } });

    // Other edits are never checked.
    expect((await app.inject({ method: "PATCH", url: `/api/tickets/${other.id}`, payload: { priority: "high" } })).statusCode).toBe(200);
    await app.inject({ method: "PATCH", url: "/api/helpdesk/settings", payload: { qaBeforeClose: "off" } });
    expect((await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/qa` })).json()).toEqual({ mode: "off", issues: [], modelChecked: false });
    expect((await app.inject({ method: "PATCH", url: "/api/helpdesk/settings", payload: { qaBeforeClose: "always" } })).statusCode).toBe(400);
  });

  it("adds the model's findings when turned on, bills them as QA, and ignores answers it can't read", async () => {
    const llm = new ScriptedLlm(turn(text('Sure: {"issues": ["The note doesn\'t say which driver fixed it."]}')), turn(text("not json at all")));
    const { app, store, ticket } = await setup(llm);
    await app.inject({ method: "PATCH", url: "/api/helpdesk/settings", payload: { qaModelCheck: true } });
    const res = await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/qa` });
    expect(res.json()).toMatchObject({ modelChecked: true });
    expect(res.json().issues.at(-1)).toEqual({ code: "model", level: "hint", text: "The note doesn't say which driver fixed it." });
    expect(String(llm.requests[0].messages[0].parts[0].type === "text" && llm.requests[0].messages[0].parts[0].text)).toContain("Still offline this morning");
    expect(store.db.prepare("SELECT purpose FROM model_usage").all()).toEqual([{ purpose: "qa" }]);

    const unreadable = await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/qa` });
    expect(unreadable.json()).toMatchObject({ modelChecked: false });
    expect(codes(unreadable)).toEqual(["no_reply", "no_resolution_note"]);
  });

  it("audits assignee changes", async () => {
    const { app, store, ticket } = await setup();
    await app.inject({ method: "PATCH", url: `/api/tickets/${ticket.id}`, headers: { "x-haley-user": "Dana" }, payload: { assignee: "Sam Lee" } });
    expect(store.listAudit().find((a) => a.action === "ticket.assigned")).toMatchObject({ actor: "Dana", detail: { from: "haley", to: "Sam Lee" } });
  });
});
