import { describe, expect, it, vi } from "vitest";
import { contractInForce } from "../src/psa/tools.js";
import { fakeFetch, lastToolResults, makeApp, ScriptedLlm, text, toolUse, turn, type FetchCall } from "./helpers.js";

describe("Syncro webhook", () => {
  it("syncs Syncro connections and checks alerts on a valid delivery, ignoring the payload", async () => {
    const haley = await makeApp(new ScriptedLlm(), { apiToken: "api-token" });
    const { app, store, psa, syncroWebhook } = haley;
    const auth = { authorization: "Bearer api-token" };
    try {
      const syncro = store.createPsaConnection({ kind: "syncro", name: "Syncro", config: { subdomain: "acme", apiKey: "k" } });
      const halo = store.createPsaConnection({ kind: "halopsa", name: "Halo", config: { instance: "x.halopsa.com", clientId: "c", clientSecret: "s" } });
      const sync = vi.spyOn(psa, "sync").mockResolvedValue({} as never);

      // The URL needs the API token; the hook itself is authenticated only by its secret.
      expect((await app.inject({ method: "GET", url: "/api/syncro/webhook" })).statusCode).toBe(401);
      const { url } = (await app.inject({ method: "GET", url: "/api/syncro/webhook", headers: auth })).json();
      expect(url).toMatch(/\/hooks\/syncro\/[0-9a-f]{48}$/);
      const path = new URL(url).pathname;

      expect((await app.inject({ method: "POST", url: "/hooks/syncro/not-the-secret", payload: {} })).statusCode).toBe(404);
      expect(sync).not.toHaveBeenCalled();

      // Syncro may post a form or anything else; the body is never read.
      const first = await app.inject({ method: "POST", url: path, payload: "event=ticket_updated&ticket_id=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
      expect(first.json()).toEqual({ ok: true, sync: "started" });
      await syncroWebhook.idle();
      expect(sync.mock.calls.map((c) => c[0])).toEqual([syncro.id]);
      expect(sync.mock.calls.map((c) => c[0])).not.toContain(halo.id);

      // A burst collapses into one trailing sync.
      expect((await app.inject({ method: "POST", url: path, payload: { ticket: { id: 1 } } })).json().sync).toBe("queued");
      expect((await app.inject({ method: "POST", url: path })).json().sync).toBe("queued");

      // Rotating the secret retires the old URL.
      const rotated = (await app.inject({ method: "POST", url: "/api/syncro/webhook/rotate", headers: auth })).json();
      expect(rotated.url).not.toBe(url);
      expect((await app.inject({ method: "POST", url: path })).statusCode).toBe(404);
      expect(store.listAudit().some((a) => a.action === "syncro.webhook_rotated")).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  });

  it("forces an alert check for clients with alert tickets on, between the regular checks", async () => {
    const start = Date.now();
    const alerts: Array<Record<string, unknown>> = [];
    const net = fakeFetch([
      [/\/rmm_alerts\?/, (call) => {
        const after = new URL(call.url).searchParams.get("created_after");
        return { rmm_alerts: alerts.filter((a) => !after || Date.parse(String(a.created_at)) > Date.parse(after)), meta: { total_pages: 1 } };
      }],
    ]);
    const { app, store, scheduler, syncroWebhook } = await makeApp(new ScriptedLlm(turn(text("Looked."))), {}, net.impl);
    try {
      const org = store.createOrg({ name: "Contoso" });
      store.createIntegration({ orgId: org.id, provider: "syncro_rmm", label: "Syncro", mode: "live", config: { subdomain: "acme", apiKey: "k", customerId: "77", alertTickets: "true" } });
      await scheduler.tick(start);
      alerts.push({ id: 1, customer_id: 77, asset_id: 5, computer_name: "PC-1", description: "Offline", created_at: new Date(Date.now() + 1000).toISOString() });
      // The regular check wouldn't run again for two minutes; the webhook does it now.
      const { url } = (await app.inject({ method: "GET", url: "/api/syncro/webhook" })).json();
      await app.inject({ method: "POST", url: new URL(url).pathname });
      await syncroWebhook.idle();
      expect(store.listTickets({ orgId: org.id }).filter((t) => t.channel === "monitoring")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe("PSA tools: saved replies, contracts and appointments", () => {
  function syncroApi() {
    return fakeFetch([
      [/\/canned_responses\?query=/, () => ({
        canned_responses: [{ id: 1, title: "Password reset done", subject: "Your password", body: "Hi [first name], your password has been reset.", category_name: "Accounts" }],
      })],
      [/\/contracts\?page=1/, () => ({
        contracts: [
          { id: 10, customer_id: 7, name: "Managed Services Gold", status: "Active", start_date: "2026-01-01", end_date: "2026-12-31", description: "Remote support", non_billable_product_ids: [3], product_price_overrides: [{ product_id: 3, blacklisted: false }] },
          { id: 11, customer_id: 7, name: "Old block hours", status: "Expired", start_date: "2024-01-01", end_date: "2024-12-31" },
          { id: 12, customer_id: 99, name: "Someone else's contract", status: "Active" },
        ],
        meta: { total_pages: 1 },
      })],
      [/\/appointments$/, () => ({ appointment: { id: 501 } })],
    ]);
  }

  it("works for a ticket linked to the client's Syncro connection", async () => {
    const net = syncroApi();
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const llm = new ScriptedLlm(
      turn(
        toolUse("psa_find_canned_response", { query: "password reset" }),
        toolUse("psa_list_contracts", {}),
        toolUse("psa_book_appointment", { summary: "On-site: replace printer", startAt: soon, durationMinutes: 90, notes: "Printer fuser failed" }),
      ),
      turn(text("Booked.")),
    );
    const { agent, store } = await makeApp(llm, {}, net.impl);
    const org = store.createOrg({ name: "Contoso" });
    store.updateOrg(org.id, { autonomy: "autonomous" });
    const connection = store.createPsaConnection({ kind: "syncro", name: "Syncro", config: { subdomain: "acme-msp", apiKey: "tok" } });
    store.updatePsaConnection(connection.id, { customerMap: { "7": org.id } });
    const ticket = store.createTicket({ orgId: org.id, title: "Printer broken", requesterEmail: "megan@contoso.example" });
    store.createTicketLink({ ticketId: ticket.id, connectionId: connection.id, externalId: "55", externalNumber: "1234", lastStatus: "new" });

    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    const [canned, contracts, booked] = lastToolResults(llm.requests[1]);
    expect(JSON.parse(canned.content).responses[0]).toMatchObject({ title: "Password reset done", category: "Accounts" });
    const listed = JSON.parse(contracts.content).contracts;
    expect(listed.map((c: { name: string; inForce: boolean }) => [c.name, c.inForce])).toEqual([
      ["Managed Services Gold", true],
      ["Old block hours", false],
    ]);
    expect(JSON.parse(booked.content)).toMatchObject({ booked: true, appointmentId: "501", linkedToPsaTicket: true });

    const post = net.calls.find((c: FetchCall) => c.url.endsWith("/appointments"))!.json();
    expect(post).toMatchObject({ summary: "On-site: replace printer", customer_id: 7, ticket_id: 55, email_customer: false, do_not_email: true });
    expect(Date.parse(post.end_at) - Date.parse(post.start_at)).toBe(90 * 60_000);
    expect(post.description).toContain("Printer fuser failed");
    expect(store.listTicketEvents(ticket.id).some((e) => e.body.includes("Booked \"On-site: replace printer\""))).toBe(true);
  });

  it("gates booking by policy and isn't offered to clients the PSA doesn't map", async () => {
    const net = syncroApi();
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const llm = new ScriptedLlm(turn(toolUse("psa_book_appointment", { summary: "On-site visit", startAt: soon })), turn(text("Waiting.")), turn(text("No PSA tools.")));
    const { agent, store } = await makeApp(llm, {}, net.impl);
    const org = store.createOrg({ name: "Contoso" });
    const other = store.createOrg({ name: "Unmapped" });
    const connection = store.createPsaConnection({ kind: "syncro", name: "Syncro", config: { subdomain: "acme-msp", apiKey: "tok" } });
    store.updatePsaConnection(connection.id, { customerMap: { "7": org.id } });

    // Supervised (the default): the booking waits for a technician.
    const run = agent.startTaskRun(org.id, "Book visit", "Book an on-site visit", "tech");
    await agent.settled(run.id);
    expect(store.listActions({ runId: run.id })).toMatchObject([{ tool: "psa_book_appointment", status: "pending_approval" }]);
    expect(net.calls.some((c) => c.url.endsWith("/appointments"))).toBe(false);

    const unmapped = agent.startTaskRun(other.id, "Check", "Anything?", "tech");
    await agent.settled(unmapped.id);
    const offered = llm.requests.at(-1)!.tools.map((t) => t.name);
    expect(offered.some((n) => n.startsWith("psa_"))).toBe(false);
  });

  it("judges whether a contract is in force", () => {
    const today = "2026-10-02";
    expect(contractInForce({ status: "Active", startDate: "2026-01-01", endDate: "2026-12-31" }, today)).toBe(true);
    expect(contractInForce({ status: "Active", startDate: "2026-11-01", endDate: null }, today)).toBe(false);
    expect(contractInForce({ status: "Active", startDate: null, endDate: "2026-09-30" }, today)).toBe(false);
    expect(contractInForce({ status: "Opportunity", startDate: null, endDate: null }, today)).toBe(false);
    expect(contractInForce({ status: "", startDate: null, endDate: null }, today)).toBe(true);
  });
});
