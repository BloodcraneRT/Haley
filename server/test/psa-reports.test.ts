import { describe, expect, it } from "vitest";
import { AutotaskAdapter } from "../src/psa/autotask.js";
import { DynamicsAdapter } from "../src/psa/dynamics.js";
import { fieldShapes, probePsa } from "../src/psa/probe.js";
import { fakeFetch, makeApp, ScriptedLlm } from "./helpers.js";

const FROM = "2026-07-01T00:00:00.000Z";
const TO = "2026-09-29T00:00:00.000Z";

describe("closed tickets from Autotask", () => {
  const AT = "https://webservices2.autotask.net/atservicesrest/v1.0";
  const row = (id: number, completedDate: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Ticket ${id}`,
    description: "Printer offline",
    companyID: 7,
    createDate: "2026-08-01T09:00:00Z",
    completedDate,
    status: 5,
    issueType: 3,
    ...extra,
  });

  function autotask(pages: unknown[][]) {
    const net = fakeFetch([
      [/\/Tickets\/entityInformation\/fields$/, () => ({
        fields: [
          { name: "status", isPickList: true, picklistValues: [{ value: "1", label: "New", isActive: true }, { value: "5", label: "Complete", isActive: true }] },
          { name: "issueType", isPickList: true, picklistValues: [{ value: "3", label: "Printing", isActive: true }] },
        ],
      })],
      [/\/Tickets\/query$/, () => ({ items: pages[0], pageDetails: { nextPageUrl: pages.length > 1 ? `${AT}/Tickets/query/next?paging=2` : null } })],
      [/\/Tickets\/query\/next\?paging=2$/, () => ({ items: pages[1], pageDetails: { nextPageUrl: null } })],
      [/\/Companies\/7$/, () => ({ item: { id: 7, companyName: "Contoso" } })],
    ]);
    return { adapter: new AutotaskAdapter({ username: "u", secret: "s", integrationCode: "i", zoneUrl: AT }, net.impl), net };
  }

  it("queries completed tickets in the period by completedDate, with names and categories from Autotask", async () => {
    const { adapter, net } = autotask([[row(1, "2026-09-10T10:00:00Z"), row(2, "2026-09-12T10:00:00")], [row(3, "2026-08-01T08:00:00Z")]]);
    const tickets = await adapter.listClosedTickets(FROM, TO, { max: 5000 });
    expect(tickets.map((t) => t.id)).toEqual(["2", "1", "3"]);
    expect(tickets[0]).toMatchObject({ subject: "Ticket 2", customerName: "Contoso", category: "Printing", minutesSpent: null, closedAt: "2026-09-12T10:00:00.000Z" });
    const query = net.calls.find((c) => c.url.endsWith("/Tickets/query"))!;
    expect(query.json().filter).toEqual([
      { op: "eq", field: "status", value: 5 },
      { op: "gte", field: "completedDate", value: FROM },
      { op: "lt", field: "completedDate", value: TO },
    ]);
    // The company is looked up once.
    expect(net.calls.filter((c) => c.url.endsWith("/Companies/7"))).toHaveLength(1);
  });

  it("stops paging at the cap", async () => {
    const { adapter, net } = autotask([[row(1, "2026-09-10T10:00:00Z"), row(2, "2026-09-11T10:00:00Z")], [row(3, "2026-09-12T10:00:00Z")]]);
    expect(await adapter.listClosedTickets(FROM, TO, { max: 2 })).toHaveLength(2);
    expect(net.calls.some((c) => c.url.includes("paging=2"))).toBe(false);
  });
});

describe("closed cases from Dynamics", () => {
  const ORG = "https://contoso.crm.dynamics.com";
  const incident = (id: string, resolutions: unknown[], extra: Record<string, unknown> = {}) => ({
    incidentid: id,
    title: `Case ${id.slice(0, 4)}`,
    description: "<p>Outlook <b>keeps</b> crashing</p>",
    createdon: "2026-09-01T08:00:00Z",
    modifiedon: "2026-09-20T08:00:00Z",
    _customerid_value: "acc-1",
    "casetypecode@OData.Community.Display.V1.FormattedValue": "Problem",
    customerid_account: { name: "Contoso" },
    Incident_IncidentResolutions: resolutions,
    ...extra,
  });
  const id = (n: number) => `0000000${n}-0000-0000-0000-000000000000`;

  function dynamics(pages: unknown[][]) {
    const net = fakeFetch([
      [/login\.microsoftonline\.com/, () => ({ access_token: "tok", expires_in: 3600 })],
      [/\/incidents\?\$select=.*statecode eq 1/, () => ({ value: pages[0], "@odata.nextLink": pages.length > 1 ? `${ORG}/api/data/v9.2/incidents?$skiptoken=2` : undefined })],
      [/\/incidents\?\$skiptoken=2$/, () => ({ value: pages[1] })],
    ]);
    return { adapter: new DynamicsAdapter({ orgUrl: ORG, tenantId: "t", clientId: "c", clientSecret: "s" }, net.impl), net };
  }

  it("uses the resolution's close time and time spent, and keeps only cases resolved in the period", async () => {
    const { adapter, net } = dynamics([
      [
        incident(id(1), [{ actualend: "2026-09-15T10:00:00Z", timespent: 30 }, { actualend: "2026-09-18T10:00:00Z", timespent: 15 }]),
        // Resolved before the period, only modified since.
        incident(id(2), [{ actualend: "2026-06-20T10:00:00Z", timespent: 60 }]),
      ],
      [incident(id(3), [], { modifiedon: "2026-08-02T08:00:00Z" })],
    ]);
    const cases = await adapter.listClosedTickets(FROM, TO, { max: 5000 });
    expect(cases.map((c) => c.id)).toEqual([id(1), id(3)]);
    expect(cases[0]).toMatchObject({ closedAt: "2026-09-18T10:00:00.000Z", minutesSpent: 45, customerName: "Contoso", category: "Problem", description: "Outlook keeps crashing" });
    // No resolution activity: modifiedon stands in, and the time is unknown.
    expect(cases[1]).toMatchObject({ closedAt: "2026-08-02T08:00:00.000Z", minutesSpent: null });
    const url = decodeURIComponent(net.calls.find((c) => c.url.includes("/incidents?"))!.url);
    expect(url).toContain(`$filter=statecode eq 1 and modifiedon ge ${FROM}`);
    expect(url).toContain("Incident_IncidentResolutions($select=actualend,timespent)");
  });

  it("stops paging at the cap", async () => {
    const { adapter, net } = dynamics([[incident(id(1), [{ actualend: "2026-09-15T10:00:00Z" }])], [incident(id(2), [{ actualend: "2026-09-16T10:00:00Z" }])]]);
    expect(await adapter.listClosedTickets(FROM, TO, { max: 1 })).toHaveLength(1);
    expect(net.calls.some((c) => c.url.includes("skiptoken"))).toBe(false);
  });
});

describe("PSA probe", () => {
  it("reports field names, types and fill counts, never values", () => {
    const shapes = fieldShapes(
      [
        { subject: "Megan's laptop", minutesSpent: 10, owner: { name: "Dana", email: null }, comments: [{ body: "secret text" }] },
        { subject: "", minutesSpent: null, owner: { name: "Sam", email: "sam@msp.example" }, comments: [] },
      ],
      ["comments"],
    );
    expect(shapes).toEqual(
      expect.arrayContaining([
        { field: "subject", types: ["string"], filled: 1, total: 2 },
        { field: "minutesSpent", types: ["null", "number"], filled: 1, total: 2 },
        { field: "owner.email", types: ["null", "string"], filled: 1, total: 2 },
        { field: "comments", types: ["array"], filled: 1, total: 2 },
        { field: "comments[].body", types: ["string"], filled: 1, total: 1 },
      ]),
    );
    const text = JSON.stringify(shapes);
    for (const value of ["Megan", "Dana", "sam@msp.example", "secret text"]) expect(text).not.toContain(value);
  });

  it("runs from the API on a saved connection, read-only and audited", async () => {
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString().replace(/\.\d+Z$/, "");
    const net = fakeFetch([
      [/\/auth\/token/, () => ({ access_token: "halo-token", expires_in: 3600 })],
      [/\/api\/Ticket[s]?\?.*closed_only=true/, () => ({ record_count: 1, tickets: [{ id: 42, summary: "VPN drops", details: "Every hour", client_id: 7, client_name: "Contoso", dateoccurred: at(3), dateclosed: at(2), timetaken: 0.5 }] })],
      [/\/api\/Client\?/, () => ({ record_count: 1, clients: [{ id: 7, name: "Contoso" }] })],
      [/\/api\/Tickets\/42\?includedetails=true$/, () => ({ id: 42, summary: "VPN drops", details: "Every hour", client_id: 7, client_name: "Contoso", status_id: 9, dateoccurred: at(3), lastactiondate: at(2) })],
      [/\/api\/Actions\?ticket_id=42/, () => ({ record_count: 0, actions: [] })],
      [/\/api\/Attachment\?ticket_id=42/, () => ({ attachments: [{ id: 5, filename: "shot.png", filesize: 10 }] })],
      [/\/api\/Status$/, () => [{ id: 9, name: "Closed" }]],
    ]);
    const { app, store } = await makeApp(new ScriptedLlm(), {}, net.impl);
    const connection = (await app.inject({ method: "POST", url: "/api/psa", payload: { kind: "halopsa", config: { instance: "msp.halopsa.com", clientId: "a", clientSecret: "b" } } })).json();
    const before = net.calls.length;
    const probe = (await app.inject({ method: "POST", url: `/api/psa/${connection.id}/probe` })).json();
    expect(probe.steps.map((s: { method: string; ok: boolean }) => [s.method, s.ok])).toEqual([
      ["test", true],
      ["listClosedTickets", true],
      ["getTicket", true],
      ["listTimeEntries", true],
      ["listAttachments", true],
    ]);
    expect(JSON.stringify(probe)).not.toContain("shot.png");
    const closed = probe.steps[1];
    expect(closed.fields).toEqual(expect.arrayContaining([{ field: "minutesSpent", types: ["number"], filled: 1, total: 1 }]));
    expect(JSON.stringify(probe)).not.toContain("VPN drops");
    // Only reads.
    expect(net.calls.slice(before).every((c) => c.method === "GET" || c.url.includes("/auth/token"))).toBe(true);
    expect(store.listAudit({ limit: 5 }).some((a) => a.action === "psa.probed")).toBe(true);
    await app.close();
  });

  it("marks newer report queries as preview until verified", async () => {
    const { app } = await makeApp(new ScriptedLlm());
    const providers = (await app.inject({ url: "/api/psa/providers" })).json() as Array<{ id: string; insights?: boolean; preview?: string[] }>;
    expect(providers.filter((p) => p.insights).map((p) => p.id).sort()).toEqual(["autotask", "connectwise", "dynamics", "halopsa", "syncro"]);
    expect(providers.every((p) => !p.insights || p.preview?.includes("insights"))).toBe(true);
    await app.close();
  });
});

describe("probePsa", () => {
  it("records a failing step without stopping or throwing", async () => {
    const adapter = {
      kind: "syncro",
      test: async () => "Connected",
      listClosedTickets: async () => {
        throw new Error("Syncro GET /tickets failed (403)");
      },
    } as never;
    const steps = await probePsa(adapter);
    expect(steps.map((s) => [s.method, s.ok, s.detail])).toEqual([
      ["test", true, "Connected"],
      ["listClosedTickets", false, "Syncro GET /tickets failed (403)"],
    ]);
  });
});
