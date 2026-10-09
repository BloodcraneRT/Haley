import { describe, expect, it } from "vitest";
import { suggestTechnician } from "../src/dispatch.js";
import { matchOwner } from "../src/psa/owners.js";
import type { ExternalTicket, PsaAdapter, PsaConnection, PsaOwner } from "../src/psa/types.js";
import type { WorkingHours } from "../src/types.js";
import { isWorking, nextOn } from "../src/workingHours.js";
import { fakeFetch, makeApp, ScriptedLlm } from "./helpers.js";

// Monday 12 October 2026, 09:00 in Chicago (CDT, UTC-5).
const MON_9AM_CHICAGO = Date.parse("2026-10-12T14:00:00Z");
const weekdays = (start: string, end: string): WorkingHours["days"] => Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [[start, end]]]));

describe("working hours", () => {
  const chicago = (days: WorkingHours["days"], awayUntil: string | null = null): WorkingHours => ({ tz: "America/Chicago", days, awayUntil });

  it("is on within a range in the technician's own time zone", () => {
    expect(isWorking(null, MON_9AM_CHICAGO)).toBe(true);
    expect(isWorking(chicago(weekdays("08:00", "17:00")), MON_9AM_CHICAGO)).toBe(true);
    expect(isWorking(chicago(weekdays("13:00", "17:00")), MON_9AM_CHICAGO)).toBe(false);
    // 09:00 in Chicago is 15:00 in London: the same instant, a different local time.
    expect(isWorking({ tz: "Europe/London", days: weekdays("08:00", "12:00"), awayUntil: null }, MON_9AM_CHICAGO)).toBe(false);
    expect(nextOn(chicago(weekdays("13:00", "17:00")), MON_9AM_CHICAGO)).toBe("today 13:00");
  });

  it("handles overnight ranges, weekends and time away", () => {
    // Sunday 22:00 to Monday 10:00 covers Monday 09:00.
    expect(isWorking(chicago({ sun: [["22:00", "10:00"]] }), MON_9AM_CHICAGO)).toBe(true);
    expect(isWorking(chicago({ sat: [["09:00", "12:00"]] }), MON_9AM_CHICAGO)).toBe(false);
    expect(nextOn(chicago({ sat: [["09:00", "12:00"]] }), MON_9AM_CHICAGO)).toBe("Sat 09:00");
    const away = chicago(weekdays("08:00", "17:00"), "2026-10-13");
    expect(isWorking(away, MON_9AM_CHICAGO)).toBe(false);
    expect(nextOn(away, MON_9AM_CHICAGO)).toBe("Wed 08:00");
  });
});

describe("dispatch and working hours", () => {
  async function setup() {
    const haley = await makeApp(new ScriptedLlm());
    const org = haley.store.createOrg({ name: "Contoso", domain: "contoso.example" });
    const dana = haley.store.createTechnician({ name: "Dana Reyes", email: "dana@msp.example" });
    const sam = haley.store.createTechnician({ name: "Sam Lee", email: "sam@msp.example" });
    const past = haley.store.createTicket({ orgId: org.id, title: "Printer offline floor 2", category: "printing" });
    haley.store.updateTicket(past.id, { status: "resolved" }, "Dana Reyes");
    return { ...haley, org, dana, sam };
  }

  it("leaves out technicians who are off, and says who is next on when everyone is", async () => {
    const { app, store, org, dana, sam } = await setup();
    const ticket = store.createTicket({ orgId: org.id, title: "Floor 2 printer offline", category: "printing" });
    expect(suggestTechnician(store, ticket, MON_9AM_CHICAGO)!.name).toBe("Dana Reyes");

    store.updateTechnician(dana.id, { workingHours: { tz: "America/Chicago", days: weekdays("13:00", "17:00"), awayUntil: null } });
    expect(suggestTechnician(store, ticket, MON_9AM_CHICAGO)).toMatchObject({ name: "Sam Lee" });

    store.updateTechnician(sam.id, { workingHours: { tz: "America/Chicago", days: {}, awayUntil: "2026-12-31" } });
    expect(suggestTechnician(store, ticket, MON_9AM_CHICAGO)).toMatchObject({
      name: "Dana Reyes",
      offNow: true,
      reasons: expect.arrayContaining(["nobody is working now; Dana Reyes is next on today 13:00"]),
    });
    await app.close();
  });

  it("never auto-assigns to someone who is off, but still suggests them", async () => {
    const { app, store, org, dana, sam } = await setup();
    for (const t of [dana, sam]) store.updateTechnician(t.id, { workingHours: { tz: "UTC", days: {}, awayUntil: "2099-01-01" } });
    await app.inject({ method: "PATCH", url: "/api/helpdesk/settings", payload: { autoAssignOnEscalation: "suggested" } });
    const ticket = store.createTicket({ orgId: org.id, title: "Floor 2 printer offline", category: "printing" });
    store.updateTicket(ticket.id, { status: "escalated" }, "haley");
    expect(store.getTicket(ticket.id)).toMatchObject({ suggested_assignee: { name: "Dana Reyes", offNow: true } });
    expect(store.getTicket(ticket.id)!.assignee).not.toBe("Dana Reyes");
    await app.close();
  });

  it("validates hours and PSA ids on the technicians API, and shows who is off", async () => {
    const { app, store, dana, sam } = await setup();
    const bad = await app.inject({ method: "PATCH", url: `/api/technicians/${dana.id}`, payload: { workingHours: { tz: "Mars/Olympus", days: {} } } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/technicians/${dana.id}`, payload: { workingHours: { tz: "UTC", days: { mon: [["9am", "5pm"]] } } } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "PATCH", url: `/api/technicians/${dana.id}`, payload: { workingHours: { tz: "UTC", days: {}, awayUntil: "2099-01-01" } } });
    expect(ok.json().working_hours).toEqual({ tz: "UTC", days: {}, awayUntil: "2099-01-01" });
    const list = (await app.inject({ url: "/api/technicians" })).json().technicians;
    expect(list.find((t: { name: string }) => t.name === "Dana Reyes")).toMatchObject({ working: false });

    const psa = store.createPsaConnection({ kind: "syncro", name: "Syncro", config: { subdomain: "x", apiKey: "y" }, options: {} });
    expect((await app.inject({ method: "PATCH", url: `/api/technicians/${dana.id}`, payload: { psaRefs: { nope: "1" } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/technicians/${dana.id}`, payload: { psaRefs: { [psa.id]: "77" } } })).json().psa_refs).toEqual({ [psa.id]: "77" });
    expect((await app.inject({ method: "PATCH", url: `/api/technicians/${sam.id}`, payload: { psaRefs: { [psa.id]: "77" } } })).statusCode).toBe(409);
    // An empty value removes it.
    expect((await app.inject({ method: "PATCH", url: `/api/technicians/${dana.id}`, payload: { psaRefs: { [psa.id]: "" } } })).json().psa_refs).toEqual({});
    await app.close();
  });
});

/** A PSA with one ticket whose owner the test controls; records owner changes sent to it. */
class OwnerPsa implements PsaAdapter {
  kind = "syncro" as const;
  owner: PsaOwner | null = { id: "77", name: "Dana R.", email: "DANA@msp.example" };
  readonly setOwnerCalls: Array<[string, string]> = [];
  private ticket = (): ExternalTicket => ({
    id: "ext1",
    number: "1001",
    subject: "Printer offline",
    description: "",
    customerId: "c1",
    customerName: "Contoso",
    requesterEmail: "megan@contoso.example",
    requesterName: "Megan",
    status: "in_progress",
    externalStatus: "In Progress",
    priority: "normal",
    updatedAt: new Date().toISOString(),
    comments: [],
    owner: this.owner,
  });
  test = async () => "ok";
  listCustomers = async () => [];
  listUpdatedTickets = async () => [this.ticket()];
  getTicket = async () => this.ticket();
  addComment = async () => "note";
  setStatus = async () => {};
  createTicket = async () => ({ id: "x", number: "x" });
  setOwner = async (ticketId: string, ownerId: string) => {
    this.setOwnerCalls.push([ticketId, ownerId]);
    this.owner = { id: ownerId, name: `Member ${ownerId}`, email: null };
  };
}

describe("PSA ticket owners", () => {
  async function setup() {
    const fake = new OwnerPsa();
    const haley = await makeApp(new ScriptedLlm(), {}, undefined, undefined, () => fake);
    const { app, store } = haley;
    const org = store.createOrg({ name: "Contoso", domain: "contoso.example" });
    const dana = store.createTechnician({ name: "Dana Reyes", email: "dana@msp.example" });
    const sam = store.createTechnician({ name: "Sam Lee", email: "sam@msp.example" });
    store.createTechnician({ name: "Priya Patel" });
    const connection = (await app.inject({ method: "POST", url: "/api/psa", payload: { kind: "syncro", config: { subdomain: "msp", apiKey: "k" }, options: { mirrorNotes: false } } })).json() as PsaConnection;
    const ticket = store.createTicket({ orgId: org.id, title: "Printer offline", channel: "syncro" });
    store.createTicketLink({ ticketId: ticket.id, connectionId: connection.id, externalId: "ext1", externalNumber: "1001", seenCommentIds: [], lastStatus: "in_progress" });
    return { ...haley, fake, connection, ticket, dana, sam };
  }

  it("matches owners by PSA id, then email, then name, and remembers the PSA id", async () => {
    const { app, store, connection, dana } = await setup();
    expect(matchOwner(store, connection.id, { id: "77", name: "Someone", email: "dana@MSP.example" })!.name).toBe("Dana Reyes");
    expect(store.getTechnician(dana.id)!.psa_refs).toEqual({ [connection.id]: "77" });
    // Now the id alone is enough, whatever the name says.
    expect(matchOwner(store, connection.id, { id: "77", name: "D. Reyes", email: null })!.name).toBe("Dana Reyes");
    expect(matchOwner(store, connection.id, { id: "99", name: "priya patel", email: null })!.name).toBe("Priya Patel");
    expect(matchOwner(store, connection.id, { id: "100", name: "Contractor Bob", email: null })).toBeNull();
    await app.close();
  });

  it("assigns from the PSA owner, keeps assignments made in Haley, and sends them back when asked", async () => {
    const { app, store, psa, fake, connection, ticket, sam } = await setup();
    await psa.sync(connection.id);
    expect(store.getTicket(ticket.id)!.assignee).toBe("Dana Reyes");
    expect(store.getTicketLink(ticket.id, connection.id)!.last_owner).toBe("77");

    // Reassigned in Haley; the PSA owner hasn't changed, so the sync leaves it alone and sends nothing back.
    await app.inject({ method: "PATCH", url: `/api/tickets/${ticket.id}`, payload: { assignee: "Sam Lee" } });
    await psa.sync(connection.id);
    expect(store.getTicket(ticket.id)!.assignee).toBe("Sam Lee");
    expect(fake.setOwnerCalls).toEqual([]);

    // Sending assignments back: Priya has no PSA id, so it's noted rather than sent.
    await app.inject({ method: "PATCH", url: `/api/psa/${connection.id}`, payload: { options: { syncOwner: true } } });
    await app.inject({ method: "PATCH", url: `/api/tickets/${ticket.id}`, payload: { assignee: "Priya Patel" } });
    expect((await psa.sync(connection.id)).ownersNotSent).toEqual(["Priya Patel"]);
    expect(fake.setOwnerCalls).toEqual([]);

    await app.inject({ method: "PATCH", url: `/api/technicians/${sam.id}`, payload: { psaRefs: { [connection.id]: "88" } } });
    await app.inject({ method: "PATCH", url: `/api/tickets/${ticket.id}`, payload: { assignee: "Sam Lee" } });
    await psa.sync(connection.id);
    expect(fake.setOwnerCalls).toEqual([["ext1", "88"]]);
    await psa.sync(connection.id);
    expect(fake.setOwnerCalls).toHaveLength(1);
    expect(store.getTicket(ticket.id)!.assignee).toBe("Sam Lee");

    // Reassigned in the PSA: Haley follows.
    fake.owner = { id: "77", name: "Dana R.", email: null };
    await psa.sync(connection.id);
    expect(store.getTicket(ticket.id)!.assignee).toBe("Dana Reyes");
    await app.close();
  });

  it("credits the PSA owner when a ticket is closed in the PSA", async () => {
    const { app, store, psa, connection, ticket } = await setup();
    await psa.sync(connection.id);
    store.updateTicket(ticket.id, { status: "resolved" }, connection.name);
    const next = store.createTicket({ orgId: ticket.org_id, title: "Printer offline again" });
    expect(suggestTechnician(store, next)!.reasons).toContain("resolved 1 similar ticket");
    expect(suggestTechnician(store, next)!.name).toBe("Dana Reyes");
    await app.close();
  });
});

describe("owners in each PSA", () => {
  it("ConnectWise: owner member with email (looked up once), and owner changes as a JSON patch", async () => {
    const { ConnectWiseAdapter } = await import("../src/psa/connectwise.js");
    const net = fakeFetch([
      [/\/service\/tickets\/5\/notes/, () => []],
      [/\/service\/tickets\/5$/, (c) => (c.method === "PATCH" ? { id: 5 } : { id: 5, summary: "x", status: { name: "In Progress" }, owner: { id: 31, identifier: "dreyes", name: "Dana Reyes" }, _info: {} })],
      [/\/system\/members\/31\?/, () => ({ id: 31, firstName: "Dana", lastName: "Reyes", officeEmail: "Dana@MSP.example" })],
    ]);
    const cw = new ConnectWiseAdapter({ site: "api-na.myconnectwise.net", companyId: "a", publicKey: "b", privateKey: "c", clientId: "d", board: "Help Desk" }, net.impl);
    expect((await cw.getTicket("5")).owner).toEqual({ id: "31", name: "Dana Reyes", email: "dana@msp.example" });
    await cw.getTicket("5");
    expect(net.calls.filter((c) => c.url.includes("/system/members/"))).toHaveLength(1);
    await cw.setOwner("5", "31");
    expect(net.calls.at(-1)!.json()).toEqual([{ op: "replace", path: "owner", value: { id: 31 } }]);
  });

  it("HaloPSA: the agent (0 is unassigned), and agent_id on update", async () => {
    const { HaloAdapter } = await import("../src/psa/halopsa.js");
    let agent = 12;
    const net = fakeFetch([
      [/\/auth\/token/, () => ({ access_token: "t", expires_in: 3600 })],
      [/\/api\/Tickets\/9\?includedetails=true$/, () => ({ id: 9, summary: "x", status_id: 2, agent_id: agent, agent_name: "Dana" })],
      [/\/api\/Actions\?ticket_id=9/, () => ({ actions: [] })],
      [/\/api\/Status$/, () => [{ id: 2, name: "In Progress" }]],
      [/\/api\/Agent\/12$/, () => ({ id: 12, name: "Dana Reyes", email: "dana@msp.example" })],
      [/\/api\/Tickets$/, () => [{ id: 9 }]],
    ]);
    const halo = new HaloAdapter({ instance: "https://msp.halopsa.com", clientId: "a", clientSecret: "b" }, net.impl);
    expect((await halo.getTicket("9")).owner).toEqual({ id: "12", name: "Dana Reyes", email: "dana@msp.example" });
    agent = 0;
    expect((await halo.getTicket("9")).owner).toBeNull();
    await halo.setOwner("9", "12");
    expect(net.calls.at(-1)!.json()).toEqual([{ id: 9, agent_id: 12 }]);
  });

  it("Syncro: user_id with the included user, and user_id on update", async () => {
    const { SyncroAdapter } = await import("../src/psa/syncro.js");
    const net = fakeFetch([
      [/\/tickets\/3\/comments/, () => ({ comments: [], meta: { total_pages: 1 } })],
      [/\/tickets\/3$/, (c) => (c.method === "PUT" ? { ticket: { id: 3 } } : { ticket: { id: 3, subject: "x", status: "In Progress", customer_id: 1, user_id: 44, user: { id: 44, full_name: "Dana Reyes", email: "dana@msp.example" } } })],
    ]);
    const syncro = new SyncroAdapter({ subdomain: "msp", apiKey: "k" }, net.impl);
    expect((await syncro.getTicket("3")).owner).toEqual({ id: "44", name: "Dana Reyes", email: "dana@msp.example" });
    await syncro.setOwner("3", "44");
    expect(net.calls.at(-1)!.json()).toEqual({ user_id: 44 });
  });

  it("Autotask: the assigned resource, and assigning with the resource's default role", async () => {
    const { AutotaskAdapter } = await import("../src/psa/autotask.js");
    const net = fakeFetch([
      [/\/Tickets\/7$/, () => ({ item: { id: 7, title: "x", status: 1, companyID: 2, assignedResourceID: 29, lastActivityDate: "2026-10-01T00:00:00Z" } })],
      [/\/TicketNotes\/query$/, () => ({ items: [], pageDetails: {} })],
      [/entityInformation\/fields$/, () => ({ fields: [] })],
      [/\/Companies\/2$/, () => ({ item: { id: 2, companyName: "Contoso" } })],
      [/\/Resources\/29$/, () => ({ item: { id: 29, firstName: "Dana", lastName: "Reyes", email: "dana@msp.example" } })],
      [/\/ResourceServiceDeskRoles\/query$/, () => ({ items: [{ roleID: 5, isDefault: false }, { roleID: 8, isDefault: true }], pageDetails: {} })],
      [/\/Tickets$/, () => ({ itemId: 7 })],
    ]);
    const at = new AutotaskAdapter({ username: "u", secret: "s", integrationCode: "i", zoneUrl: "https://webservices2.autotask.net/atservicesrest/v1.0" }, net.impl);
    expect((await at.getTicket("7")).owner).toEqual({ id: "29", name: "Dana Reyes", email: "dana@msp.example" });
    await at.setOwner("7", "29");
    expect(net.calls.at(-1)!.json()).toEqual({ id: 7, assignedResourceID: 29, assignedResourceRoleID: 8 });
  });

  it("Dynamics: a user owner with their email; cases owned by a team have none", async () => {
    const { DynamicsAdapter } = await import("../src/psa/dynamics.js");
    const CASE = "11111111-1111-1111-1111-111111111111";
    const USER = "22222222-2222-2222-2222-222222222222";
    let ownerType = "systemuser";
    const net = fakeFetch([
      [/login\.microsoftonline\.com/, () => ({ access_token: "t", expires_in: 3600 })],
      [/\/incidents\(1111.*\$select=/, () => ({ incidentid: CASE, title: "x", statecode: 0, statuscode: 1, _ownerid_value: USER, "_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname": ownerType })],
      [/\/annotations\?/, () => ({ value: [] })],
      [/\/emails\?/, () => ({ value: [] })],
      [/\/systemusers\(2222/, () => ({ fullname: "Dana Reyes", internalemailaddress: "dana@msp.example" })],
      [/\/incidents\(1111[^?]*$/, () => new Response(null, { status: 204 })],
    ]);
    const dyn = new DynamicsAdapter({ orgUrl: "https://contoso.crm.dynamics.com", tenantId: "t", clientId: "c", clientSecret: "s" }, net.impl);
    expect((await dyn.getTicket(CASE)).owner).toEqual({ id: USER, name: "Dana Reyes", email: "dana@msp.example" });
    ownerType = "team";
    expect((await dyn.getTicket(CASE)).owner).toBeNull();
    await dyn.setOwner(CASE, USER);
    expect(net.calls.at(-1)!.json()).toEqual({ "ownerid@odata.bind": `/systemusers(${USER})` });
  });
});
