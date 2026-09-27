import { describe, expect, it } from "vitest";
import type { ExternalComment, ExternalTicket, PsaAdapter, PsaConnection } from "../src/psa/types.js";
import type { TicketStatus } from "../src/types.js";
import { makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

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
