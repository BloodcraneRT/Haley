import { describe, expect, it } from "vitest";
import type { ExternalComment, ExternalTicket, PsaAdapter, PsaConnection } from "../src/psa/types.js";
import type { TicketStatus } from "../src/types.js";
import { DynamicsAdapter } from "../src/psa/dynamics.js";
import { SyncroAdapter } from "../src/psa/syncro.js";
import { fakeFetch, makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

/** An in-memory PSA that behaves like a real one: tickets, comments with ids, statuses, customers. */
class FakePsa implements PsaAdapter {
  readonly kind = "syncro" as const;
  tickets = new Map<string, ExternalTicket>();
  private seq = 100;
  private clock = Date.parse("2026-09-27T10:00:00Z");

  private tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  async test() {
    return "Connected to Fake PSA";
  }
  async listCustomers() {
    return [
      { id: "c1", name: "Contoso Ltd", domains: ["contoso.example"] },
      { id: "c2", name: "Unknown Co", domains: ["unknown.example"] },
    ];
  }
  async listUpdatedTickets(since: string | null) {
    return [...this.tickets.values()].filter((t) => !since || t.updatedAt > since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }
  async getTicket(id: string) {
    return this.tickets.get(id)!;
  }
  async addComment(ticketId: string, comment: { body: string; public: boolean }) {
    const t = this.tickets.get(ticketId)!;
    const c: ExternalComment = { id: `cm${++this.seq}`, body: comment.body, author: "API", fromCustomer: false, public: comment.public, createdAt: this.tick() };
    t.comments.push(c);
    t.updatedAt = c.createdAt;
    return c.id;
  }
  async setStatus(ticketId: string, status: TicketStatus) {
    const t = this.tickets.get(ticketId)!;
    t.status = status;
    t.externalStatus = status;
    t.updatedAt = this.tick();
  }
  async createTicket(input: { customerId: string; subject: string; description: string; requesterEmail: string | null }) {
    const id = `t${++this.seq}`;
    this.open(id, input.customerId, input.subject, input.description, input.requesterEmail ?? "");
    return { id, number: String(5000 + this.seq) };
  }

  open(id: string, customerId: string, subject: string, description: string, email: string) {
    this.tickets.set(id, {
      id,
      number: id.replace(/\D/g, ""),
      subject,
      description,
      customerId,
      customerName: customerId === "c1" ? "Contoso Ltd" : "Unknown Co",
      requesterEmail: email,
      requesterName: "Megan Bowen",
      status: "new",
      externalStatus: "New",
      priority: "normal",
      updatedAt: this.tick(),
      comments: [],
    });
  }
  customerSays(id: string, body: string) {
    const t = this.tickets.get(id)!;
    t.comments.push({ id: `cm${++this.seq}`, body, author: "Megan Bowen", fromCustomer: true, public: true, createdAt: this.tick() });
    t.updatedAt = this.tick();
  }
  techSays(id: string, body: string) {
    const t = this.tickets.get(id)!;
    t.comments.push({ id: `cm${++this.seq}`, body, author: "Jordan (tech)", fromCustomer: false, public: false, createdAt: this.tick() });
    t.updatedAt = this.tick();
  }
  closeUpstream(id: string) {
    const t = this.tickets.get(id)!;
    t.status = "resolved";
    t.externalStatus = "Resolved";
    t.updatedAt = this.tick();
  }
}

async function setup(llm: ScriptedLlm) {
  const fake = new FakePsa();
  const haley = await makeApp(llm, {}, undefined, undefined, () => fake);
  await haley.app.inject({ method: "POST", url: "/api/demo" });
  const contoso = haley.store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
  const connection = (await haley.app.inject({ method: "POST", url: "/api/psa", payload: { kind: "syncro", config: { subdomain: "msp", apiKey: "syncro-secret-xyz" } } })).json() as PsaConnection;
  return { ...haley, fake, contoso, connection };
}

describe("PSA sync", () => {
  it("suggests customer mappings by domain and only imports mapped customers", async () => {
    const { app, fake, contoso, connection, psa, store } = await setup(new ScriptedLlm());
    expect(connection).toMatchObject({ status: "connected", status_detail: "Connected to Fake PSA" });
    const customers = (await app.inject({ url: `/api/psa/${connection.id}/customers` })).json();
    expect(customers).toEqual([
      expect.objectContaining({ id: "c1", suggestedOrgId: contoso.id, orgId: null }),
      expect.objectContaining({ id: "c2", suggestedOrgId: null }),
    ]);
    fake.open("t1", "c2", "Printer", "Broken", "x@unknown.example");
    const result = await psa.sync(connection.id);
    expect(result).toMatchObject({ imported: 0, unmappedCustomers: ["Unknown Co"] });
    expect(store.listTickets({ search: "Printer" })).toHaveLength(0);
  });

  it("imports a ticket, lets Haley work it, and syncs replies, notes, comments and status both ways", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("reply_to_requester", { message: "Checking your mailbox now." }), toolUse("add_internal_note", { note: "Exchange is degraded." })),
      turn(text("Waiting on the Exchange incident.")),
      turn(toolUse("reply_to_requester", { message: "Thanks, that confirms it." }), toolUse("update_ticket", { status: "resolved" })),
      turn(text("Resolved.")),
    );
    const { app, fake, contoso, connection, psa, store, agent } = await setup(llm);
    await app.inject({ method: "PUT", url: `/api/psa/${connection.id}/mapping`, payload: { c1: contoso.id } });
    fake.open("t1", "c1", "Email slow", "Outlook takes minutes to send", "megan.bowen@contoso.example");

    expect(await psa.sync(connection.id)).toMatchObject({ imported: 1, errors: [] });
    const ticket = store.listTickets({ search: "Email slow" })[0];
    expect(ticket).toMatchObject({ channel: "syncro", assurance: "none", requester_email: "megan.bowen@contoso.example" });
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);

    // Ack and Haley's reply went out as public comments; nothing echoes back as a customer message.
    const upstream = () => fake.tickets.get("t1")!.comments;
    expect(upstream().filter((c) => c.public).map((c) => c.body)).toEqual([expect.stringContaining("I'm Haley"), "Checking your mailbox now."]);
    await psa.sync(connection.id);
    const internal = upstream().filter((c) => !c.public).map((c) => c.body);
    expect(internal.some((b) => b.includes("Exchange is degraded."))).toBe(true);
    expect(internal.some((b) => b.includes("Checking your mailbox now."))).toBe(false);
    expect(fake.tickets.get("t1")!.status).toBe("in_progress");
    const commentsBefore = store.listTicketEvents(ticket.id).filter((e) => e.kind === "comment").length;
    await psa.sync(connection.id);
    expect(store.listTicketEvents(ticket.id).filter((e) => e.kind === "comment").length).toBe(commentsBefore);

    // A customer reply wakes Haley; a technician's internal note doesn't.
    fake.techSays("t1", "Looked at the mail flow, all fine on our side.");
    fake.customerSays("t1", "It's only happening for external recipients.");
    const pulled = await psa.sync(connection.id);
    expect(pulled.commentsImported).toBe(2);
    const events = store.listTicketEvents(ticket.id);
    expect(events.find((e) => e.body.startsWith("Looked at the mail flow"))!.meta).toMatchObject({ fromTechnician: true });
    const runs = store.listRuns({ ticketId: ticket.id });
    expect(runs).toHaveLength(2);
    await agent.settled(runs[0].id);
    expect(store.getTicket(ticket.id)!.status).toBe("resolved");
    await psa.sync(connection.id);
    expect(fake.tickets.get("t1")!.status).toBe("resolved");
  });

  it("resolves the Haley ticket when a technician closes it in the PSA", async () => {
    const llm = new ScriptedLlm(turn(text("Looking into it.")));
    const { app, fake, contoso, connection, psa, store, agent } = await setup(llm);
    await app.inject({ method: "PUT", url: `/api/psa/${connection.id}/mapping`, payload: { c1: contoso.id } });
    fake.open("t9", "c1", "VPN", "Can't connect", "megan.bowen@contoso.example");
    await psa.sync(connection.id);
    const ticket = store.listTickets({ search: "VPN" })[0];
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);
    fake.closeUpstream("t9");
    const result = await psa.sync(connection.id);
    expect(result.statusUpdates).toBeGreaterThanOrEqual(1);
    expect(store.getTicket(ticket.id)!.status).toBe("resolved");
  });

  it("exports tickets that start in Haley so the PSA has a record, mirroring the conversation", async () => {
    const llm = new ScriptedLlm(turn(toolUse("reply_to_requester", { message: "Reset done." })), turn(text("Done.")));
    const { app, fake, contoso, connection, psa, store, agent } = await setup(llm);
    await app.inject({ method: "PUT", url: `/api/psa/${connection.id}/mapping`, payload: { c1: contoso.id } });
    const sim = (
      await app.inject({ method: "POST", url: "/api/simulate", payload: { orgId: contoso.id, email: "alex.wilber@contoso.example", name: "Alex", text: "Locked out" } })
    ).json();
    await agent.settled(sim.runId);
    const result = await psa.sync(connection.id);
    expect(result.exported).toBeGreaterThanOrEqual(1);
    const link = store.listTicketLinks({ ticketId: sim.ticketId })[0];
    const upstream = fake.tickets.get(link.external_id)!;
    expect(upstream.subject).toContain(`[Haley #${sim.ticketNumber}]`);
    await psa.sync(connection.id);
    expect(upstream.comments.every((c) => !c.public)).toBe(true);
    expect(upstream.comments.map((c) => c.body).join("\n")).toContain("Reset done.");
    const detail = (await app.inject({ url: `/api/tickets/${sim.ticketId}` })).json();
    expect(detail.psaLinks).toEqual([expect.objectContaining({ kind: "syncro", externalId: link.external_id, externalNumber: link.external_number })]);
    await app.inject({ method: "PATCH", url: `/api/psa/${connection.id}`, payload: { enabled: false } });
    expect(await psa.sync(connection.id)).toMatchObject({ skipped: expect.stringContaining("paused") });
    // Demo tickets created before the connection existed are not exported.
    const demoTicket = store.listTickets({ orgId: contoso.id }).find((t) => t.title.startsWith("Isaiah"))!;
    expect(store.listTicketLinks({ ticketId: demoTicket.id })).toHaveLength(0);
  });

  it("keeps credentials sealed and requires the provider's fields", async () => {
    const { app, store, connection } = await setup(new ScriptedLlm());
    expect(JSON.stringify((await app.inject({ url: "/api/psa" })).json())).not.toContain("syncro-secret-xyz");
    const raw = store.db.prepare("SELECT config_sealed FROM psa_connections").get() as { config_sealed: string };
    expect(raw.config_sealed).not.toContain("syncro-secret-xyz");
    const missing = await app.inject({ method: "POST", url: "/api/psa", payload: { kind: "syncro", config: {} } });
    expect(missing.statusCode).toBe(400);
    expect(connection.kind).toBe("syncro");
  });
});

describe("PSAs that don't notify customers", () => {
  it("records the reply on the PSA ticket and also emails the requester", async () => {
    const fake = Object.assign(new FakePsa(), { notifiesCustomer: false });
    const sent: Array<Record<string, unknown>> = [];
    const { app, store, psa, agent } = await makeApp(new ScriptedLlm(turn(text("On it."))), {}, undefined, { sendMail: async (m) => void sent.push(m) }, () => fake);
    await app.inject({ method: "POST", url: "/api/demo" });
    const contoso = store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
    const connection = (await app.inject({ method: "POST", url: "/api/psa", payload: { kind: "dynamics", config: { orgUrl: "https://x.crm.dynamics.com", tenantId: "t", clientId: "c", clientSecret: "s" } } })).json();
    await app.inject({ method: "PUT", url: `/api/psa/${connection.id}/mapping`, payload: { c1: contoso.id } });
    fake.open("t1", "c1", "Teams crashing", "Every morning", "megan.bowen@contoso.example");
    await psa.sync(connection.id);
    const ticket = store.listTickets({ search: "Teams crashing" })[0];
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);
    expect(fake.tickets.get("t1")!.comments.some((c) => c.public && c.body.includes("I'm Haley"))).toBe(true);
    expect(sent[0]).toMatchObject({ to: expect.stringContaining("megan.bowen@contoso.example") });
    const ack = store.listTicketEvents(ticket.id).find((e) => e.kind === "reply")!;
    expect((ack.meta.delivery as { detail: string }).detail).toMatch(/ticket #.* and Emailed/);
  });
});

describe("SyncroMSP adapter", () => {
  const syncro = () => {
    const posted: Array<{ url: string; body: any }> = [];
    const net = fakeFetch([
      [/\/customers\?page=1/, () => ({ customers: [{ id: 7, business_name: "Contoso Ltd", email: "billing@contoso.example", contacts: [{ email: "megan@contoso.example" }, { email: "x@gmail.com" }] }], meta: { total_pages: 2, total_entries: 2 } })],
      [/\/customers\?page=2/, () => ({ customers: [{ id: 8, business_name: "Gone", disabled: true }], meta: { total_pages: 2 } })],
      [/\/tickets\?since_updated_at=/, () => ({ tickets: [{ id: 55, updated_at: "2026-09-27T10:00:00Z" }], meta: { total_pages: 1 } })],
      [/\/tickets\/55\/comments/, () => ({
        comments: [
          { id: 1, body: "Outlook is slow", tech: "Megan", user_id: null, hidden: false, created_at: "2026-09-27T09:00:00Z" },
          { id: 2, body: "Checking mail flow", tech: "Jordan", user_id: 3, hidden: true, created_at: "2026-09-27T09:05:00Z" },
          { id: 3, body: "Still slow", tech: "Megan", user_id: null, hidden: false, created_at: "2026-09-27T09:10:00Z" },
        ],
        meta: { total_pages: 1 },
      })],
      [/\/tickets\/55$/, (c) => (c.method === "PUT" ? (posted.push({ url: c.url, body: c.json() }), { ticket: {} }) : { ticket: { id: 55, number: 1234, subject: "Email slow", status: "Customer Reply", priority: "1 High", customer_id: 7, customer_business_then_name: "Contoso Ltd", updated_at: "2026-09-27T10:00:00Z", contact: { name: "Megan Bowen", email: "Megan@Contoso.example" } } })],
      [/\/tickets\/55\/comment$/, (c) => (posted.push({ url: c.url, body: c.json() }), { comment: { id: 99 } })],
      [/\/contacts\?customer_id=7/, () => ({ contacts: [{ id: 41, email: "megan@contoso.example" }], meta: { total_pages: 1 } })],
      [/\/tickets$/, (c) => (posted.push({ url: c.url, body: c.json() }), { ticket: { id: 77, number: 1300 } })],
    ]);
    return { adapter: new SyncroAdapter({ subdomain: "acme-msp", apiKey: "tok" }, net.impl, () => Date.parse("2026-09-27T12:00:00Z")), net, posted };
  };

  it("pages customers, derives business domains, and skips disabled ones", async () => {
    const { adapter, net } = syncro();
    expect(await adapter.listCustomers()).toEqual([{ id: "7", name: "Contoso Ltd", domains: ["contoso.example"] }]);
    expect(net.calls[0].url).toBe("https://acme-msp.syncromsp.com/api/v1/customers?page=1");
    expect(net.calls[0].headers.authorization).toBe("Bearer tok");
  });

  it("maps tickets and tells customer comments from technician ones", async () => {
    const { adapter, net } = syncro();
    const [t] = await adapter.listUpdatedTickets(null);
    expect(net.calls[0].url).toContain(`since_updated_at=${encodeURIComponent("2026-09-20T12:00:00.000Z")}`);
    expect(t).toMatchObject({
      id: "55",
      number: "1234",
      description: "Outlook is slow",
      customerId: "7",
      requesterEmail: "megan@contoso.example",
      status: "in_progress",
      externalStatus: "Customer Reply",
      priority: "high",
    });
    expect(t.comments.map((c) => [c.id, c.fromCustomer, c.public])).toEqual([
      ["1", false, true],
      ["2", false, false],
      ["3", true, true],
    ]);
  });

  it("posts comments, statuses and new tickets in Syncro's shapes", async () => {
    const { adapter, posted } = syncro();
    expect(await adapter.addComment("55", { body: "Fixed!", public: true })).toBe("99");
    expect(posted[0].body).toMatchObject({ body: "Fixed!", hidden: false, do_not_email: false, tech: "Haley" });
    await adapter.addComment("55", { body: "note", public: false });
    expect(posted[1].body).toMatchObject({ hidden: true, do_not_email: true });
    await adapter.setStatus("55", "waiting_on_customer");
    expect(posted[2].body).toEqual({ status: "Waiting on Customer" });
    const created = await adapter.createTicket({ customerId: "7", subject: "[Haley #1] Hi", description: "d", requesterEmail: "megan@contoso.example", priority: "urgent" });
    expect(created).toEqual({ id: "77", number: "1300" });
    expect(posted[3].body).toMatchObject({ customer_id: 7, contact_id: 41, status: "New", priority: "0 Urgent", problem_type: "Other" });
  });
});

describe("Dynamics 365 adapter", () => {
  const CASE = "11111111-2222-3333-4444-555555555555";
  const ACCOUNT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const incident = {
    incidentid: CASE,
    ticketnumber: "CAS-01042",
    title: "VPN drops",
    description: "<p>VPN disconnects&nbsp;every hour</p>",
    statecode: 0,
    statuscode: 3,
    "statuscode@OData.Community.Display.V1.FormattedValue": "Waiting for Details",
    prioritycode: 1,
    modifiedon: "2026-09-27T10:00:00Z",
    _customerid_value: "cccccccc-0000-0000-0000-000000000001",
    "_customerid_value@Microsoft.Dynamics.CRM.lookuplogicalname": "contact",
    customerid_contact: { fullname: "Sam Chen", emailaddress1: "Sam@Acme.example", _parentcustomerid_value: ACCOUNT },
    primarycontactid: null,
    customerid_account: null,
  };

  function dynamics() {
    let throttled = false;
    const net = fakeFetch([
      [/login\.microsoftonline\.com\/tenant-1/, () => ({ access_token: "dyn-token", expires_in: 3599 })],
      [/\/WhoAmI/, () => ({ UserId: "app-user" })],
      [/\/accounts\?/, () => ({ value: [{ accountid: ACCOUNT, name: "Acme", websiteurl: "https://www.acme.example/", emailaddress1: "info@acme.example" }] })],
      [/\/incidents\?\$select=.*modifiedon gt/, (c) => {
        if (!throttled) {
          throttled = true;
          return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "retry-after": "1" } });
        }
        expect(c.headers.prefer).toContain("odata.maxpagesize=100");
        return { value: [incident] };
      }],
      [/\/annotations\?\$select=annotationid,subject/, () => ({ value: [{ annotationid: "n1", subject: "Called user", notetext: "Asked for logs", createdon: "2026-09-27T09:00:00Z", "_createdby_value@OData.Community.Display.V1.FormattedValue": "Jordan" }] })],
      [/\/emails\?/, () => ({ value: [{ activityid: "e1", subject: "RE: VPN", description: "<div>It happened again</div>", createdon: "2026-09-27T09:30:00Z", sender: "sam@acme.example" }] })],
      [/\/annotations\?\$select=annotationid$/, () => ({ annotationid: "n2" })],
      [/\/incidents\(.*\)\?\$select=statecode$/, () => ({ statecode: 0 })],
      [/\/CloseIncident/, () => new Response(null, { status: 204 })],
      [/\/incidents\([0-9a-f-]+\)$/, () => new Response(null, { status: 204 })],
      [/\/contacts\?/, () => ({ value: [{ contactid: "c0ffee00-0000-0000-0000-000000000001" }] })],
      [/\/incidents\?\$select=incidentid,ticketnumber/, () =>
        new Response(null, { status: 204, headers: { "OData-EntityId": `https://acme.crm.dynamics.com/api/data/v9.2/incidents(${CASE})` } })],
    ]);
    const adapter = new DynamicsAdapter(
      { orgUrl: "https://acme.crm.dynamics.com/", tenantId: "tenant-1", clientId: "app", clientSecret: "s" },
      net.impl,
      () => Date.parse("2026-09-27T12:00:00Z"),
      async () => {},
    );
    return { adapter, net };
  }

  it("authenticates as an application user with the environment scope", async () => {
    const { adapter, net } = dynamics();
    expect(await adapter.test()).toContain("app-user");
    expect(new URLSearchParams(net.calls[0].body).get("scope")).toBe("https://acme.crm.dynamics.com/.default");
    expect(net.calls[1].headers).toMatchObject({ authorization: "Bearer dyn-token", "odata-version": "4.0", "odata-maxversion": "4.0" });
    expect(await adapter.listCustomers()).toEqual([{ id: ACCOUNT, name: "Acme", domains: ["acme.example"] }]);
  });

  it("maps cases, notes and incoming emails, retrying once when throttled", async () => {
    const { adapter, net } = dynamics();
    const [t] = await adapter.listUpdatedTickets(null);
    expect(net.calls.filter((c) => c.url.includes("modifiedon gt")).length).toBe(2);
    expect(t).toMatchObject({
      id: CASE,
      number: "CAS-01042",
      description: "VPN disconnects every hour",
      customerId: ACCOUNT,
      requesterEmail: "sam@acme.example",
      status: "waiting_on_customer",
      priority: "high",
    });
    expect(t.comments).toEqual([
      expect.objectContaining({ id: "note:n1", fromCustomer: false, public: false, author: "Jordan" }),
      expect.objectContaining({ id: "email:e1", fromCustomer: true, body: "It happened again" }),
    ]);
  });

  it("adds notes, resolves and reactivates cases, and creates cases bound to the account", async () => {
    const { adapter, net } = dynamics();
    expect(await adapter.addComment(CASE, { body: "Fixed", public: true })).toBe("note:n2");
    const note = net.calls.find((c) => c.url.endsWith("/annotations?$select=annotationid"))!;
    expect(note.json()).toMatchObject({ notetext: "Fixed", "objectid_incident@odata.bind": `/incidents(${CASE})` });
    expect(note.headers.prefer).toBe("return=representation");

    await adapter.setStatus(CASE, "resolved");
    const close = net.calls.find((c) => c.url.endsWith("/CloseIncident"))!.json();
    expect(close).toEqual({
      IncidentResolution: { "@odata.type": "Microsoft.Dynamics.CRM.incidentresolution", subject: "Resolved by Haley", "incidentid@odata.bind": `/incidents(${CASE})` },
      Status: 5,
    });
    await adapter.setStatus(CASE, "waiting_on_customer");
    const patch = net.calls.find((c) => c.method === "PATCH")!;
    expect(patch.json()).toEqual({ statecode: 0, statuscode: 3 });
    expect(patch.headers["if-match"]).toBe("*");

    const created = await adapter.createTicket({ customerId: ACCOUNT, subject: "[Haley #9] Printer", description: "d", requesterEmail: "o'neil@acme.example", priority: "urgent" });
    expect(created).toEqual({ id: CASE, number: CASE });
    expect(net.calls.find((c) => c.url.includes("/contacts?"))!.url).toContain("o''neil@acme.example");
    expect(net.calls.find((c) => c.url.includes("/incidents?$select=incidentid,ticketnumber"))!.json()).toMatchObject({
      prioritycode: 1,
      "customerid_account@odata.bind": `/accounts(${ACCOUNT})`,
      "primarycontactid@odata.bind": "/contacts(c0ffee00-0000-0000-0000-000000000001)",
    });
  });
});

describe("PSA errors", () => {
  it("returns a readable 502 when the PSA can't be reached", async () => {
    const net = fakeFetch([[/syncromsp\.com/, () => new Response(JSON.stringify({ error: "Not authorized." }), { status: 401 })]]);
    const { app } = await makeApp(new ScriptedLlm(), {}, net.impl);
    const connection = (await app.inject({ method: "POST", url: "/api/psa", payload: { kind: "syncro", config: { subdomain: "msp", apiKey: "bad" } } })).json();
    expect(connection).toMatchObject({ status: "error", status_detail: expect.stringContaining("Not authorized") });
    const customers = await app.inject({ url: `/api/psa/${connection.id}/customers` });
    expect(customers.statusCode).toBe(502);
    expect(customers.json().error).toContain("Not authorized");
  });
});
