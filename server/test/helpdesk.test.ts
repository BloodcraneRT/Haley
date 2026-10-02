import { describe, expect, it } from "vitest";
import { defineTool, type HaleyTool } from "../src/connectors/types.js";
import { INCIDENT_MIN_TICKETS } from "../src/incidents.js";
import { requesterSnapshot } from "../src/snapshot.js";
import { z } from "zod";
import { firstUserText, makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

async function contoso(llm = new ScriptedLlm()) {
  const haley = await makeApp(llm);
  await haley.app.inject({ method: "POST", url: "/api/demo" });
  const org = haley.store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
  return { ...haley, org };
}

const readTool = (name: string, result: unknown | (() => Promise<unknown>)): HaleyTool =>
  defineTool({ name, description: name, input: z.any(), risk: "read", run: async () => (typeof result === "function" ? (result as () => Promise<unknown>)() : result) });

describe("requester snapshot", () => {
  it("shows the requester's Microsoft 365 account, Intune devices and other tickets", async () => {
    const { app, store, org } = await contoso();
    const email = "isaiah.langer@contoso.example";
    const older = store.createTicket({ orgId: org.id, title: "Printer jam", requesterEmail: email });
    const ticket = store.createTicket({ orgId: org.id, title: "Laptop slow", requesterEmail: email });
    const snap = (await app.inject({ method: "GET", url: `/api/tickets/${ticket.id}/requester` })).json();
    expect(snap.account).toMatchObject({ source: "Microsoft 365", name: "Isaiah Langer", enabled: true, department: "Finance" });
    expect(snap.devices).toEqual([expect.objectContaining({ source: "Intune", name: "CON-LT-022", issues: expect.arrayContaining([expect.stringMatching(/Not compliant/), expect.stringMatching(/No check-in for 9 days/)]) })]);
    expect(snap.flags.map((f: { text: string }) => f.text)).toEqual(expect.arrayContaining([expect.stringMatching(/device has issues: CON-LT-022/)]));
    expect(snap.recentTickets.map((t: { id: string }) => t.id)).toEqual([older.id]);
    expect(snap.unavailable).toEqual([]);

    const stranger = store.createTicket({ orgId: org.id, title: "Hi", requesterEmail: "nobody@contoso.example" });
    const unknown = (await app.inject({ method: "GET", url: `/api/tickets/${stranger.id}/requester` })).json();
    expect(unknown.account).toBeNull();
    expect(unknown.unavailable.map((u: { source: string }) => u.source)).toContain("Microsoft 365");
  });

  it("flags blocked accounts, missing MFA and unhealthy devices, and survives a failing source", async () => {
    const { store, org } = await contoso();
    const ticket = store.createTicket({ orgId: org.id, title: "Can't sign in", requesterEmail: "sam@contoso.example" });
    const now = Date.parse("2026-10-02T12:00:00Z");
    const tools = new Map<string, HaleyTool>([
      ["m365_get_user", readTool("m365_get_user", { displayName: "Sam", accountEnabled: false, licenses: [], groups: [{ displayName: "Sales" }], mfaMethods: [{ type: "password" }] })],
      [
        "m365_list_devices",
        readTool("m365_list_devices", [
          { id: "d1", deviceName: "SAM-LT", operatingSystem: "Windows", osVersion: "11", complianceState: "compliant", lastSyncDateTime: "2026-10-01T12:00:00Z", freeStorageSpaceInBytes: 5, totalStorageSpaceInBytes: 100, isEncrypted: false },
        ]),
      ],
      ["syncro_list_devices", readTool("syncro_list_devices", () => Promise.reject(new Error("Syncro returned 401")))],
    ]);
    const snap = await requesterSnapshot(store, ticket, tools, now);
    expect(snap.flags.map((f) => f.text)).toEqual(
      expect.arrayContaining(["Sign-in is blocked (account disabled)", "No MFA method registered", "No license assigned", expect.stringMatching(/SAM-LT/)]),
    );
    expect(snap.devices[0].issues).toEqual(["Low disk (5% free)", "Not encrypted"]);
    expect(snap.unavailable).toEqual([{ source: "Syncro", error: "Syncro returned 401" }]);
  });
});

describe("similar tickets", () => {
  it("finds past tickets about the same thing, with how they were fixed, and matching articles", async () => {
    const { app, store, org, agent } = await contoso(new ScriptedLlm(turn(text("Recreated the Outlook profile; fixed."))));
    const past = store.createTicket({ orgId: org.id, title: "Outlook keeps disconnecting", requesterEmail: "a@contoso.example" });
    await agent.settled(agent.startTicketRun(past.id, "tech").id);
    store.updateTicket(past.id, { status: "resolved" }, "haley");
    store.createTicket({ orgId: org.id, title: "New starter laptop", requesterEmail: "b@contoso.example" });
    store.saveArticle({ orgId: org.id, title: "Outlook profile rebuild", body: "Steps to rebuild an Outlook profile when it won't connect.", tags: [], source: "manual" });
    const ticket = store.createTicket({ orgId: org.id, title: "Outlook not connecting", description: "Outlook says disconnected", requesterEmail: "c@contoso.example" });

    const similar = (await app.inject({ method: "GET", url: `/api/tickets/${ticket.id}/similar` })).json();
    expect(similar.tickets).toEqual([expect.objectContaining({ id: past.id, status: "resolved", resolution: "Recreated the Outlook profile; fixed.", matched: expect.arrayContaining(["outlook"]) })]);
    expect(similar.articles.map((a: { title: string }) => a.title)).toContain("Outlook profile rebuild");
  });
});

describe("incidents (likely outages)", () => {
  it("groups several people's tickets about one problem, tells Haley, and lets a technician message and resolve them all", async () => {
    const llm = new ScriptedLlm(turn(text("Known outage; told the user.")));
    // A fresh client: the demo workspace has its own recent Outlook/Exchange tickets that would join.
    const { app, store, agent } = await makeApp(llm);
    const org = store.createOrg({ name: "Fabrikam", domain: "contoso.example" });
    const report = (email: string, title: string) => store.createTicket({ orgId: org.id, title, requesterEmail: email, channel: "email" });
    const a = report("megan.bowen@contoso.example", "Outlook not connecting");
    report("megan.bowen@contoso.example", "Unrelated: new monitor please");
    const b = report("isaiah.langer@contoso.example", "Outlook disconnected since 9am");
    expect(store.listIncidents({ orgId: org.id })).toHaveLength(0);
    const c = report("diego.siciliani@contoso.example", "Can't get email in Outlook");

    const [incident] = store.listIncidents({ orgId: org.id, status: "open" });
    expect(incident).toMatchObject({ title: "Can't get email in Outlook", created_by: "haley" });
    expect(store.listIncidentTickets(incident.id).map((t) => t.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(INCIDENT_MIN_TICKETS).toBe(3);

    // A later report joins the open incident.
    const d = report("lynne.robbins@contoso.example", "Outlook won't load mail");
    expect(store.getTicket(d.id)!.incident_id).toBe(incident.id);

    // Haley is told it's a shared problem.
    await agent.settled(agent.startTicketRun(d.id, "tech").id);
    expect(firstUserText(llm.requests[0])).toContain("<incident>");

    const list = (await app.inject({ method: "GET", url: "/api/incidents?status=open" })).json();
    expect(list[0]).toMatchObject({ id: incident.id, ticketCount: 4, people: 4, org_name: "Fabrikam" });

    const sent = (await app.inject({ method: "POST", url: `/api/incidents/${incident.id}/message`, headers: { "x-haley-user": "Jordan" }, payload: { message: "We're aware Outlook is down and are working on it." } })).json();
    expect(sent.sent).toBe(4);
    expect(store.listTicketEvents(a.id).some((e) => e.kind === "reply" && e.author === "Jordan" && e.meta.incidentBroadcast)).toBe(true);

    const resolved = (await app.inject({ method: "POST", url: `/api/incidents/${incident.id}/resolve`, payload: { message: "Outlook is back." } })).json();
    expect(resolved).toMatchObject({ resolvedTickets: 4, incident: { status: "resolved" } });
    expect([a, b, c, d].map((t) => store.getTicket(t.id)!.status)).toEqual(["resolved", "resolved", "resolved", "resolved"]);
    expect(store.listAudit().map((x) => x.action)).toEqual(expect.arrayContaining(["incident.detected", "incident.messaged", "incident.resolved"]));
  });

  it("needs several people, and lets a technician dismiss a false match", async () => {
    const { app, store } = await makeApp();
    const org = store.createOrg({ name: "Fabrikam" });
    for (let i = 0; i < 3; i++) store.createTicket({ orgId: org.id, title: `VPN down again (${i})`, requesterEmail: "megan.bowen@contoso.example" });
    expect(store.listIncidents({ orgId: org.id })).toHaveLength(0);

    store.createTicket({ orgId: org.id, title: "VPN won't connect", requesterEmail: "isaiah.langer@contoso.example" });
    const [incident] = store.listIncidents({ orgId: org.id, status: "open" });
    expect(incident).toBeDefined();
    const dismissed = (await app.inject({ method: "POST", url: `/api/incidents/${incident.id}/dismiss` })).json();
    expect(dismissed.status).toBe("dismissed");
    expect(store.listIncidentTickets(incident.id)).toHaveLength(0);
  });
});

describe("technician copilot", () => {
  it("drafts a reply from the ticket's context without tools, and bills the call to the client", async () => {
    const llm = new ScriptedLlm(turn(text("Hi Megan, I've reset your Outlook profile. [Confirm time] works for a quick check?")), turn(text("- Problem: Outlook")));
    const { app, store, org } = await contoso(llm);
    const ticket = store.createTicket({ orgId: org.id, title: "Outlook asks for password again", description: "It keeps prompting since this morning", requesterName: "Megan", requesterEmail: "megan.bowen@contoso.example" });
    store.addTicketEvent(ticket.id, "agent_note", "Jordan", "Checked: account active, MFA fine.");

    const res = await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/assist`, headers: { "x-haley-user": "Jordan" }, payload: { mode: "draft_reply", instruction: "Offer a call this afternoon" } });
    expect(res.json()).toMatchObject({ mode: "draft_reply", text: expect.stringContaining("reset your Outlook profile") });
    const req = llm.requests[0];
    expect(req.tools).toEqual([]);
    expect(req.system).toContain("assistant mode");
    const context = firstUserText(req);
    expect(context).toContain("Outlook asks for password again");
    expect(context).toContain("Checked: account active, MFA fine.");
    expect(context).toContain("Offer a call this afternoon");
    expect(context).toContain("Draft the reply");

    // Nothing was sent or changed.
    expect(store.listTicketEvents(ticket.id).filter((e) => e.kind === "reply")).toHaveLength(0);
    expect(store.listRuns({ ticketId: ticket.id })).toHaveLength(0);

    // Billed to the client like any other model call.
    const usage = (await app.inject({ method: "GET", url: "/api/usage" })).json();
    expect(usage.clients.find((c: { orgId: string }) => c.orgId === org.id).modelCalls).toBe(1);
    expect(store.listAudit().some((a) => a.action === "ticket.assist" && a.actor === "Jordan")).toBe(true);

    await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/assist`, payload: { mode: "summarize" } });
    expect(firstUserText(llm.requests[1])).toContain("Summarize this ticket");
    expect((await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/assist`, payload: { mode: "write_poem" } })).statusCode).toBe(400);

    store.updateOrg(org.id, { settings: { paused: true } });
    expect((await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/assist`, payload: { mode: "next_steps" } })).statusCode).toBe(409);
  });
});

describe("end-user status page", () => {
  const form = (body: Record<string, string>) => ({ payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

  async function setup(llm = new ScriptedLlm(), assurance: "email" | "chat" = "email") {
    const sent: Array<Record<string, unknown>> = [];
    const haley = await makeApp(llm, {}, undefined, { sendMail: async (m) => void sent.push(m) });
    const org = haley.store.createOrg({ name: "Fabrikam", domain: "fabrikam.example" });
    const ticket = haley.store.createTicket({
      orgId: org.id,
      title: "Printer <offline> on 2nd floor",
      description: "The printer shows offline",
      requesterName: "Pat",
      requesterEmail: "pat@fabrikam.example",
      channel: assurance === "email" ? "email" : "chat",
      assurance,
    });
    const { url } = (await haley.app.inject({ method: "GET", url: `/api/tickets/${ticket.id}/status-link` })).json();
    return { ...haley, org, ticket, sent, path: new URL(url).pathname };
  }

  it("shows status and the public conversation only, with escaping and private headers", async () => {
    const { app, store, ticket, path } = await setup();
    store.addTicketEvent(ticket.id, "reply", "haley", "I've restarted the print queue.");
    store.addTicketEvent(ticket.id, "agent_note", "haley", "INTERNAL: the printer's admin password is on the sticky note");
    const res = await app.inject({ method: "GET", url: path });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.body).toContain("Printer &#60;offline&#62; on 2nd floor");
    expect(res.body).toContain("I&#39;ve restarted the print queue.");
    expect(res.body).not.toContain("INTERNAL");
    expect(res.body).not.toContain("<offline>");
    // The original request is shown as the requester's first message.
    expect(res.body).toContain("The printer shows offline");

    // Forged, altered or expired links show nothing.
    expect((await app.inject({ method: "GET", url: `${path}x` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: path.replace(ticket.id, "tkt_someoneelse") })).statusCode).toBe(404);
    expect(store.verifyStatusToken(store.statusToken(ticket.id, 1000, Date.now() - 5000))).toBeNull();
  });

  it("lets the requester reply (Haley continues on an email ticket), confirm a fix, or say it's still broken", async () => {
    const llm = new ScriptedLlm(turn(text("Looking at the new detail.")), turn(text("Back on it.")));
    const { app, store, agent, ticket, path } = await setup(llm);
    const replied = await app.inject({ method: "POST", url: `${path}/reply`, ...form({ message: "It's the HP on the left" }) });
    expect(replied.statusCode).toBe(303);
    expect(replied.headers.location).toContain("done=reply");
    const comment = store.listTicketEvents(ticket.id).find((e) => e.kind === "comment" && e.body === "It's the HP on the left")!;
    expect(comment.meta).toMatchObject({ fromRequester: true, statusPage: true });
    const run = store.listRuns({ ticketId: ticket.id })[0];
    expect(run).toBeDefined();
    await agent.settled(run.id);

    // Resolved → "No, still having the problem" reopens it for Haley.
    store.updateTicket(ticket.id, { status: "resolved" }, "haley");
    await app.inject({ method: "POST", url: `${path}/reopen` });
    expect(store.getTicket(ticket.id)!.status).toBe("in_progress");
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);

    // Resolved → "Yes, it's fixed" closes it as confirmed, keeping the original resolve time.
    store.updateTicket(ticket.id, { status: "resolved" }, "haley");
    const resolvedAt = store.getTicket(ticket.id)!.resolved_at;
    await app.inject({ method: "POST", url: `${path}/confirm` });
    const closed = store.getTicket(ticket.id)!;
    expect(closed).toMatchObject({ status: "closed", resolved_at: resolvedAt });
    expect(closed.resolution_confirmed_at).not.toBeNull();
  });

  it("doesn't let a forwarded link act with a chat requester's stronger identity", async () => {
    const { app, store, ticket, path } = await setup(new ScriptedLlm(), "chat");
    await app.inject({ method: "POST", url: `${path}/reply`, ...form({ message: "please reset my password" }) });
    const comment = store.listTicketEvents(ticket.id).find((e) => e.body === "please reset my password")!;
    expect(comment.meta.untrustedContinuation).toBe(true);
    expect(store.listRuns({ ticketId: ticket.id })).toHaveLength(0);
    // Confirming does nothing unless the ticket is resolved.
    await app.inject({ method: "POST", url: `${path}/confirm` });
    expect(store.getTicket(ticket.id)!.resolution_confirmed_at).toBeNull();
  });

  it("includes the link in email replies", async () => {
    const llm = new ScriptedLlm(turn(toolUse("reply_to_requester", { message: "I've restarted the print queue." })), turn(text("Done.")));
    const { agent, ticket, sent } = await setup(llm);
    await agent.settled(agent.startTicketRun(ticket.id, "tech").id);
    const body = String(sent.at(-1)?.text ?? "");
    expect(body).toContain("I've restarted the print queue.");
    expect(body).toMatch(/See or reply to this request: http:\/\/localhost:\d+\/t\/tkt_\w+\.\w+\.[\w-]+/);
  });
});
