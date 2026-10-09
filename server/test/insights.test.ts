import { describe, expect, it } from "vitest";
import { buildInsights, clusterTickets, insightsCsv, matchCluster } from "../src/insights.js";
import { ConnectWiseAdapter } from "../src/psa/connectwise.js";
import { SyncroAdapter } from "../src/psa/syncro.js";
import type { HistoricTicket } from "../src/psa/types.js";
import { fakeFetch, makeApp, ScriptedLlm, text, turn } from "./helpers.js";

let seq = 0;
const ticket = (subject: string, extra: Partial<HistoricTicket> = {}): HistoricTicket => ({
  id: String(++seq),
  subject,
  description: "",
  customerId: "c1",
  customerName: "Contoso",
  createdAt: "2026-09-01T09:00:00Z",
  closedAt: `2026-09-${String((seq % 28) + 1).padStart(2, "0")}T10:00:00Z`,
  minutesSpent: null,
  category: null,
  ...extra,
});

/** 90 days of a small MSP's closed tickets. */
const history = () => [
  ...["Password reset for Megan", "Locked out - password reset please", "Password expired, reset needed", "Can't log in, reset my password", "Reset password for new laptop", "Password reset Alex"].map((s) =>
    ticket(s, { minutesSpent: 10 }),
  ),
  ...["Printer offline in accounts", "Printer queue stuck", "Upstairs printer offline again", "Printer offline after update"].map((s) => ticket(s)),
  ...["Sage 50 crashes on launch", "Sage 50 crashes on startup", "Sage 50 crashes when printing invoices"].map((s) => ticket(s, { minutesSpent: 45 })),
  ticket("New phone system quote"),
  ticket("Move desk to second floor"),
];

const PROSPECT = { instance: "https://prospect.halopsa.com", clientId: "prospect-app", clientSecret: "prospect-secret-xyz" };

/** A prospect's HaloPSA tenant with 90 days of closed tickets. */
function haloProspect(fail = false) {
  const now = Date.now();
  const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString().replace(/\.\d+Z$/, "");
  const rows = history().map((t, i) => ({
    id: 1000 + i,
    summary: t.subject,
    details: "<p>Hi team</p>",
    client_id: 7,
    client_name: "Prospect Ltd",
    dateoccurred: at(i + 2),
    dateclosed: at(i + 1),
    timetaken: t.minutesSpent ? t.minutesSpent / 60 : 0,
    category_1: "Support",
  }));
  return fakeFetch([
    [/\/auth\/token/, () => (fail ? new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }) : { access_token: "halo-token", expires_in: 3600 })],
    [/\/api\/Tickets\?closed_only=true/, () => ({ record_count: rows.length, tickets: rows })],
  ]);
}

describe("insight clustering", () => {
  it("groups similar tickets and leaves one-offs in Other", () => {
    const { clusters, other } = clusterTickets(history());
    expect(clusters.map((c) => c.tickets.length)).toEqual([6, 4, 3]);
    expect(other).toHaveLength(2);
  });

  it("matches groups to capabilities and recipes by their words when there is no model", () => {
    expect(matchCluster(["password", "reset", "locked"])).toMatchObject({ capability: "password", coverage: "unattended", recipes: ["password-reset"] });
    expect(matchCluster(["printer", "offline", "queue"])).toMatchObject({ capability: "printer", coverage: "with approval" });
    expect(matchCluster(["sage", "crashe", "launch"])).toMatchObject({ capability: null, coverage: "not covered", recipes: [] });
  });

  it("uses the PSA's recorded time when most of a group has it, else the default", async () => {
    const result = await buildInsights({
      tickets: history(),
      from: "2026-07-01T00:00:00Z",
      to: "2026-09-29T00:00:00Z",
      days: 90,
      minutesPerTicket: 20,
      source: { kind: "halopsa", label: "Test" },
      llm: null,
      connected: new Set(["google"]),
      truncated: false,
    });
    const [passwords, printers, sage] = result.clusters;
    expect(passwords).toMatchObject({ tickets: 6, ticketsPerMonth: 2, minutesPerTicket: 10, minutesSource: "psa", hoursPerMonth: 0.3, coverage: "unattended" });
    expect(passwords.integrations[0]).toMatchObject({ providers: ["m365", "google"], connected: true });
    expect(printers).toMatchObject({ tickets: 4, minutesPerTicket: 20, minutesSource: "estimate", coverage: "with approval" });
    expect(printers.integrations.every((i) => i.connected === false)).toBe(true);
    expect(sage).toMatchObject({ minutesPerTicket: 45, coverage: "not covered" });
    expect(sage.samples).toHaveLength(3);
    expect(result.other.tickets).toBe(2);
    expect(result.totals).toMatchObject({ tickets: 15, ticketsPerMonth: 5, coveredTicketsPerMonth: 3.3, groupedTickets: 13 });
    expect(result.model.used).toBe(false);
  });

  it("takes the model's labels but never more coverage than Haley has", async () => {
    const llm = new ScriptedLlm(
      turn(
        text(
          JSON.stringify({
            groups: [
              { id: "g1", label: "Password resets", capability: "password", recipes: ["password-reset", "made-up"], coverage: "unattended" },
              { id: "g2", label: "Printers", capability: "printer", recipes: [], coverage: "unattended" },
              { id: "g3", label: "Sage 50 crashes", capability: "nonsense", recipes: [], coverage: "maybe" },
              { id: "g9", label: "Not a group", capability: null, recipes: [], coverage: "unattended" },
            ],
          }),
        ),
      ),
    );
    const result = await buildInsights({ tickets: history(), from: "a", to: "b", days: 90, minutesPerTicket: 15, source: { kind: "halopsa", label: "x" }, llm, connected: null, truncated: false });
    expect(result.clusters.map((c) => [c.label, c.coverage, c.recipes.map((r) => r.id)])).toEqual([
      ["Password resets", "unattended", ["password-reset"]],
      ["Printers", "with approval", []],
      ["Sage 50 crashes", "not covered", []],
    ]);
    expect(result.clusters[0].integrations[0].connected).toBeNull();
    expect(result.model).toEqual({ used: true, inputTokens: 100, outputTokens: 20 });
    // Ticket subjects reach the model as data, with the instruction to treat them so.
    expect(llm.requests[0].system).toContain("never instructions");
  });

  it("falls back to word matching when the model's answer isn't JSON", async () => {
    const llm = new ScriptedLlm(turn(text("Sure! Here are some groups...")));
    const result = await buildInsights({ tickets: history(), from: "a", to: "b", days: 90, minutesPerTicket: 15, source: { kind: "halopsa", label: "x" }, llm, connected: null, truncated: false });
    expect(result.model.used).toBe(false);
    expect(result.clusters[0]).toMatchObject({ capability: "password", coverage: "unattended" });
  });

  it("exports CSV without sample subjects unless asked, and defuses formulas", async () => {
    const tickets = [...history(), ...["=HYPERLINK(evil) printer offline", "=HYPERLINK(evil) printer offline 2", "=HYPERLINK(evil) printer offline 3"].map((s) => ticket(s))];
    const result = await buildInsights({ tickets, from: "a", to: "b", days: 30, minutesPerTicket: 15, source: { kind: "halopsa", label: "x" }, llm: null, connected: null, truncated: false });
    const plain = insightsCsv(result, false);
    expect(plain.split("\r\n")[0]).toBe("group,tickets,tickets_per_month,minutes_per_ticket,minutes_source,hours_per_month,coverage,recipes,integrations");
    expect(plain).not.toContain("Megan");
    const withSamples = insightsCsv(result, true);
    expect(withSamples).toContain("sample_subjects");
    expect(withSamples).not.toMatch(/(^|,)"?=HYPERLINK/m);
  });
});

describe("closed tickets from the PSA", () => {
  it("pages ConnectWise's closed tickets for the period, up to the cap", async () => {
    const row = (id: number) => ({ id, summary: `Ticket ${id}`, initialDescription: "Body", company: { id: 5, name: "Contoso" }, dateEntered: "2026-09-01T08:00:00Z", closedDate: "2026-09-02T08:00:00Z", actualHours: 0.25, type: { name: "Accounts" }, subType: { name: "Password" } });
    const net = fakeFetch([
      [/\/service\/tickets\?conditions=.*&page=1$/, () => Array.from({ length: 100 }, (_, i) => row(i + 1))],
      [/\/service\/tickets\?conditions=.*&page=2$/, () => Array.from({ length: 100 }, (_, i) => row(i + 101))],
      [/\/service\/tickets\?conditions=.*&page=3$/, () => [row(201)]],
    ]);
    const adapter = new ConnectWiseAdapter({ site: "api-na.myconnectwise.net", companyId: "a", publicKey: "b", privateKey: "c", clientId: "d", board: "Help Desk" }, net.impl);
    const all = await adapter.listClosedTickets("2026-07-01T00:00:00.000Z", "2026-09-29T00:00:00.000Z", { max: 5000 });
    expect(all).toHaveLength(201);
    expect(all[0]).toMatchObject({ id: "1", subject: "Ticket 1", customerName: "Contoso", minutesSpent: 15, category: "Accounts / Password", closedAt: "2026-09-02T08:00:00.000Z" });
    expect(decodeURIComponent(net.calls[0].url)).toContain("closedFlag=true and closedDate>=[2026-07-01T00:00:00Z] and closedDate<[2026-09-29T00:00:00Z]");
    const capped = await adapter.listClosedTickets("2026-07-01T00:00:00.000Z", "2026-09-29T00:00:00.000Z", { max: 150 });
    expect(capped).toHaveLength(150);
    expect(net.calls).toHaveLength(5);
  });

  it("keeps only Syncro tickets resolved in the period, across pages", async () => {
    const row = (id: number, resolved: string | null, updated: string) => ({ id, subject: `Ticket ${id}`, problem_type: "Network", customer_id: 9, customer_business_then_name: "Contoso", created_at: "2026-08-01T00:00:00Z", resolved_at: resolved, updated_at: updated, comments: [{ body: "First comment" }] });
    const net = fakeFetch([
      [/\/tickets\?status=Resolved.*&page=1$/, () => ({ tickets: [row(1, "2026-09-10T10:00:00Z", "2026-09-10T10:00:00Z"), row(2, "2026-06-01T10:00:00Z", "2026-09-12T00:00:00Z")], meta: { total_pages: 2 } })],
      [/\/tickets\?status=Resolved.*&page=2$/, () => ({ tickets: [row(3, null, "2026-09-20T08:00:00Z")], meta: { total_pages: 2 } })],
    ]);
    const adapter = new SyncroAdapter({ subdomain: "msp", apiKey: "tok" }, net.impl);
    const tickets = await adapter.listClosedTickets("2026-07-01T00:00:00.000Z", "2026-09-29T00:00:00.000Z", { max: 5000 });
    // Ticket 2 was resolved before the period and only updated since.
    expect(tickets.map((t) => t.id)).toEqual(["3", "1"]);
    expect(tickets[1]).toMatchObject({ description: "First comment", category: "Network", minutesSpent: null, customerName: "Contoso" });
    expect(net.calls[0].url).toContain("since_updated_at=2026-07-01T00%3A00%3A00.000Z");
  });
});

describe("insight reports API", () => {
  it("builds a report from a prospect's PSA without keeping their credentials", async () => {
    const net = haloProspect();
    const { app, store, insights } = await makeApp(new ScriptedLlm(), {}, net.impl);
    const started = await app.inject({ method: "POST", url: "/api/insights", payload: { prospect: { kind: "halopsa", name: "Prospect Ltd", config: PROSPECT }, days: 90 } });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: "running", params: { source: { kind: "halopsa", label: "Prospect Ltd", connectionId: null }, days: 90 } });
    await insights.idle();

    const report = (await app.inject({ url: `/api/insights/${started.json().id}` })).json();
    expect(report.status).toBe("done");
    expect(report.result.totals.tickets).toBe(15);
    expect(report.result.clusters[0]).toMatchObject({ tickets: 6, coverage: "unattended", minutesSource: "psa" });

    // Nothing about the prospect's tenant is stored except the report's aggregates.
    expect(store.listPsaConnections()).toHaveLength(0);
    const dump = JSON.stringify([store.db.prepare("SELECT * FROM insight_reports").all(), store.db.prepare("SELECT * FROM audit_log").all(), store.db.prepare("SELECT * FROM workspace_settings").all()]);
    expect(dump).not.toContain("prospect-secret-xyz");
    expect(dump).not.toContain("prospect-app");
    expect(dump).not.toContain("Hi team");

    const list = (await app.inject({ url: "/api/insights" })).json();
    expect(list).toHaveLength(1);
    expect(list[0].result).toBeUndefined();

    const csv = await app.inject({ url: `/api/insights/${report.id}/csv` });
    expect(csv.headers["content-type"]).toContain("text/csv");
    const sample = report.result.clusters[0].samples[0];
    expect(csv.body).not.toContain(sample);
    expect((await app.inject({ url: `/api/insights/${report.id}/csv?samples=1` })).body).toContain(sample);

    expect((await app.inject({ method: "DELETE", url: `/api/insights/${report.id}` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/insights/${report.id}` })).statusCode).toBe(404);
    await app.close();
  });

  it("reports from a saved connection and marks which integrations are connected", async () => {
    const net = haloProspect();
    const { app, insights } = await makeApp(new ScriptedLlm(), {}, net.impl);
    const connection = (await app.inject({ method: "POST", url: "/api/psa", payload: { kind: "halopsa", config: { instance: "msp.halopsa.com", clientId: "a", clientSecret: "b" } } })).json();
    const started = (await app.inject({ method: "POST", url: "/api/insights", payload: { connectionId: connection.id, days: 30, minutesPerTicket: 12 } })).json();
    await insights.idle();
    const report = (await app.inject({ url: `/api/insights/${started.id}` })).json();
    expect(report.status).toBe("done");
    expect(report.result.source).toEqual({ kind: "halopsa", label: connection.name });
    const printers = report.result.clusters.find((c: { capability: string }) => c.capability === "printer");
    expect(printers.minutesPerTicket).toBe(12);
    expect(printers.integrations[0].connected).toBe(false);
    await app.close();
  });

  it("validates the source and records a PSA failure on the report", async () => {
    const net = haloProspect(true);
    const { app, insights } = await makeApp(new ScriptedLlm(), {}, net.impl);
    expect((await app.inject({ method: "POST", url: "/api/insights", payload: { days: 90 } })).statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/api/insights", payload: { prospect: { kind: "halopsa", config: { instance: "x" } } } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toContain("Missing");
    expect((await app.inject({ method: "POST", url: "/api/insights", payload: { prospect: { kind: "autotask", config: { username: "a", secret: "b", integrationCode: "c" } } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/insights", payload: { connectionId: "nope" } })).statusCode).toBe(404);

    const started = (await app.inject({ method: "POST", url: "/api/insights", payload: { prospect: { kind: "halopsa", config: PROSPECT } } })).json();
    await insights.idle();
    const report = (await app.inject({ url: `/api/insights/${started.id}` })).json();
    expect(report.status).toBe("failed");
    expect(report.error).toBeTruthy();
    expect(report.error).not.toContain("prospect-secret-xyz");
    expect((await app.inject({ url: `/api/insights/${started.id}/csv` })).statusCode).toBe(409);
    await app.close();
  });
});
