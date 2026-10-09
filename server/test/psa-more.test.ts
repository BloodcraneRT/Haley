import { describe, expect, it } from "vitest";
import { AutotaskAdapter } from "../src/psa/autotask.js";
import { ConnectWiseAdapter, fromConnectWisePriority, fromConnectWiseStatus } from "../src/psa/connectwise.js";
import { HaloAdapter, fromHaloStatus } from "../src/psa/halopsa.js";
import { fakeFetch, makeApp, ScriptedLlm, text, turn } from "./helpers.js";

const NOW = () => Date.parse("2026-09-27T12:00:00Z");
const SINCE = "2026-09-27T09:00:00.000Z";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
/** The error a promise rejects with (fails the test if it resolves). */
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a failure"); }, (e: Error) => e);

describe("ConnectWise PSA adapter", () => {
  // Shapes follow the ConnectWise Manage 3.0 OpenAPI schema (Ticket, ServiceNote, BoardStatus, PatchOperation).
  const ticket = (id: number, lastUpdated: string, extra: Record<string, unknown> = {}) => ({
    id,
    summary: `Ticket ${id}`,
    board: { id: 1, name: "Help Desk" },
    status: { id: 11, name: "In Progress" },
    priority: { id: 2, name: "Priority 2 - Quick Response" },
    company: { id: 250, identifier: "Contoso", name: "Contoso Ltd" },
    contactName: "Megan Bowen",
    contactEmailAddress: "Megan.Bowen@Contoso.example",
    closedFlag: false,
    _info: { lastUpdated, dateEntered: "2026-09-26T08:00:00Z" },
    ...extra,
  });
  const filler = Array.from({ length: 98 }, (_, i) => ticket(600 + i, "2026-09-27T09:00:00Z"));

  function connectwise(overrides: Record<string, string> = {}) {
    const net = fakeFetch([
      [/\/system\/info$/, () => ({ version: "v2026.1", isCloud: true })],
      [/\/service\/boards\?conditions=/, () => [{ id: 1, name: "Help Desk" }]],
      [/\/service\/boards\/1\/statuses/, () => [
        { id: 10, name: "New" },
        { id: 11, name: "In Progress" },
        { id: 12, name: "Waiting Customer" },
        { id: 13, name: ">Closed", closedStatus: true },
        { id: 14, name: "Resolved", inactive: true },
      ]],
      [/\/company\/companies\?.*&page=1$/, () => [
        { id: 250, name: "Contoso Ltd", website: "https://www.contoso.example/" },
        ...Array.from({ length: 99 }, (_, i) => ({ id: 300 + i, name: `Co ${i}` })),
      ]],
      [/\/company\/companies\?.*&page=2$/, () => [{ id: 999, identifier: "Fabrikam", name: "", website: "fabrikam.example" }]],
      [/\/service\/tickets\?conditions=.*&page=1$/, () => [ticket(501, "2026-09-27T10:30:00Z"), ...filler, ticket(502, "2026-09-27T10:00:00Z", { status: { id: 12, name: "Waiting Customer" } })]],
      [/\/service\/tickets\?conditions=.*&page=2$/, () => [ticket(503, "2026-09-27T11:00:00Z", { status: { id: 13, name: ">Closed" }, closedFlag: true })]],
      [/\/service\/tickets\/502\/notes\?/, () => [
        { id: 3, text: "Still broken for external recipients", detailDescriptionFlag: true, contact: { id: 77, name: "Megan Bowen" }, dateCreated: "2026-09-27T09:40:00Z" },
        { id: 1, text: "Outlook takes minutes to send", detailDescriptionFlag: true, contact: { id: 77, name: "Megan Bowen" }, dateCreated: "2026-09-27T09:00:00Z" },
        { id: 2, text: "Checked mail flow", internalAnalysisFlag: true, member: { id: 5, identifier: "jordan", name: "Jordan Tech" }, dateCreated: "2026-09-27T09:20:00Z" },
      ]],
      [/\/service\/tickets\/\d+\/notes\?/, () => []],
      [/\/service\/tickets\/502\/notes$/, (c) => ({ id: c.json().internalAnalysisFlag ? 9002 : 9001, ...c.json() })],
      [/\/service\/tickets\/502\?fields=/, () => ({ id: 502, board: { id: 1, name: "Help Desk" }, status: { id: 10, name: "New" } })],
      [/\/service\/tickets\/502$/, (c) => (c.method === "PATCH" ? { id: 502 } : ticket(502, "2026-09-27T10:00:00Z"))],
      [/\/service\/priorities/, () => [
        { id: 1, name: "Priority 1 - Emergency Response" },
        { id: 2, name: "Priority 2 - Quick Response" },
        { id: 3, name: "Priority 3 - Normal Response" },
      ]],
      [/\/service\/tickets$/, () => ({ id: 777 })],
    ]);
    const adapter = new ConnectWiseAdapter(
      { site: "https://api-na.myconnectwise.net/", companyId: "acme", publicKey: "pub", privateKey: "priv-secret", clientId: "client-guid", board: "Help Desk", ...overrides },
      net.impl,
      NOW,
    );
    return { adapter, net };
  }

  it("authenticates with API member keys and the clientId header, and checks the board", async () => {
    const { adapter, net } = connectwise();
    expect(await adapter.test()).toBe('Connected to api-na.myconnectwise.net (ConnectWise PSA v2026.1); tickets go to the "Help Desk" board.');
    expect(net.calls[0].url).toBe("https://api-na.myconnectwise.net/v4_6_release/apis/3.0/system/info");
    expect(net.calls[0].headers.authorization).toBe(`Basic ${Buffer.from("acme+pub:priv-secret").toString("base64")}`);
    expect(net.calls[0].headers.clientid).toBe("client-guid");
    expect(decodeURIComponent(net.calls[1].url)).toContain('conditions=name="Help Desk"');
  });

  it("pages companies and derives domains from websites", async () => {
    const { adapter, net } = connectwise();
    const customers = await adapter.listCustomers();
    expect(customers).toHaveLength(101);
    expect(customers[0]).toEqual({ id: "250", name: "Contoso Ltd", domains: ["contoso.example"] });
    expect(customers[100]).toEqual({ id: "999", name: "Fabrikam", domains: ["fabrikam.example"] });
    expect(net.calls.map((c) => c.url.slice(-19))).toEqual(["pageSize=100&page=1", "pageSize=100&page=2"]);
    expect(decodeURIComponent(net.calls[0].url)).toContain("conditions=deletedFlag=false");
  });

  it("lists changed tickets on the board oldest first, past the cursor, with notes as comments", async () => {
    const { adapter, net } = connectwise({ importBoards: "Alerts" });
    const tickets = await adapter.listUpdatedTickets(SINCE);
    const list = decodeURIComponent(net.calls[0].url);
    expect(list).toContain('conditions=lastUpdated > [2026-09-27T09:00:00Z] and (board/name="Help Desk" or board/name="Alerts")');
    expect(list).toContain("orderBy=id asc");
    expect(tickets.map((t) => [t.id, t.updatedAt, t.status])).toEqual([
      ["502", "2026-09-27T10:00:00.000Z", "waiting_on_customer"],
      ["501", "2026-09-27T10:30:00.000Z", "in_progress"],
      ["503", "2026-09-27T11:00:00.000Z", "closed"],
    ]);
    const t = tickets[0];
    expect(t).toMatchObject({
      number: "502",
      subject: "Ticket 502",
      description: "Outlook takes minutes to send",
      customerId: "250",
      customerName: "Contoso Ltd",
      requesterEmail: "megan.bowen@contoso.example",
      requesterName: "Megan Bowen",
      externalStatus: "Waiting Customer",
      priority: "high",
    });
    // The description note is never a new customer message; a later contact note is; member notes never are.
    expect(t.comments.map((c) => [c.id, c.fromCustomer, c.public, c.author])).toEqual([
      ["1", false, true, "Megan Bowen"],
      ["2", false, false, "Jordan Tech"],
      ["3", true, true, "Megan Bowen"],
    ]);
    const first = await connectwise().adapter.listUpdatedTickets(null);
    expect(first).toHaveLength(101);
  });

  it("gets one ticket with its notes", async () => {
    const { adapter } = connectwise();
    const t = await adapter.getTicket("502");
    expect(t.comments).toHaveLength(3);
    expect(t.status).toBe("in_progress");
    await expect(adapter.getTicket("50 2")).rejects.toThrow(/Not a ConnectWise ticket id/);
  });

  it("adds Discussion and Internal notes, moves board statuses by id, and creates tickets on the board", async () => {
    const { adapter, net } = connectwise();
    expect(adapter.notifiesCustomer).toBe(false);
    expect(await adapter.addComment("502", { body: "Fixed!", public: true })).toBe("9001");
    expect(await adapter.addComment("502", { body: "note", public: false })).toBe("9002");
    const notes = net.calls.filter((c) => c.method === "POST" && c.url.endsWith("/502/notes")).map((c) => c.json());
    expect(notes[0]).toEqual({ text: "Fixed!", detailDescriptionFlag: true, internalAnalysisFlag: false, resolutionFlag: false, processNotifications: false });
    expect(notes[1]).toMatchObject({ detailDescriptionFlag: false, internalAnalysisFlag: true, processNotifications: false });

    await adapter.setStatus("502", "waiting_on_customer");
    await adapter.setStatus("502", "resolved");
    await adapter.setStatus("502", "new"); // already New: no PATCH
    const patches = net.calls.filter((c) => c.method === "PATCH").map((c) => c.json());
    expect(patches).toEqual([[{ op: "replace", path: "status", value: { id: 12 } }], [{ op: "replace", path: "status", value: { id: 13 } }]]);
    expect(net.calls.filter((c) => c.url.includes("/statuses")).length).toBe(1);

    const created = await adapter.createTicket({ customerId: "250", subject: "x".repeat(150), description: "d", requesterEmail: "megan@contoso.example", priority: "urgent" });
    expect(created).toEqual({ id: "777", number: "777" });
    expect(net.calls.find((c) => c.method === "POST" && c.url.endsWith("/service/tickets"))!.json()).toEqual({
      summary: "x".repeat(100),
      initialDescription: "d",
      board: { name: "Help Desk" },
      company: { id: 250 },
      contactEmailAddress: "megan@contoso.example",
      priority: { id: 1 },
    });
  });

  it("uses configured status names and lets the board notify contacts when asked", async () => {
    const { adapter, net } = connectwise({ statusResolved: "Resolved", statusWaiting: "Nope", emailContacts: "yes" });
    expect(adapter.notifiesCustomer).toBe(true);
    await adapter.addComment("502", { body: "Hi", public: true });
    expect(net.calls.at(-1)!.json().processNotifications).toBe(true);
    // "Resolved" is inactive on this board, so the fallback names apply.
    await adapter.setStatus("502", "closed");
    expect(net.calls.at(-1)!.json()).toEqual([{ op: "replace", path: "status", value: { id: 13 } }]);
    await adapter.setStatus("502", "waiting_on_customer");
    expect(net.calls.at(-1)!.json()).toEqual([{ op: "replace", path: "status", value: { id: 12 } }]);
  });

  it("explains authentication and server failures", async () => {
    const net = fakeFetch([[/myconnectwise/, () => json(401, { code: "Unauthorized", message: "Authentication failed." })]]);
    const adapter = new ConnectWiseAdapter({ site: "api-eu.myconnectwise.net", companyId: "a", publicKey: "b", privateKey: "very-secret", clientId: "c", board: "B" }, net.impl);
    const err = await failure(adapter.listCustomers());
    expect(err.message).toMatch(/^ConnectWise GET \/company\/companies failed \(401\): Authentication failed\. Check the company ID/);
    expect(err.message).not.toContain("very-secret");
    const down = fakeFetch([[/myconnectwise/, () => json(500, { code: "InvalidObject", message: "Ticket object is invalid", errors: [{ message: "Board is required" }] })]]);
    const err2 = await failure(
      new ConnectWiseAdapter({ site: "api-eu.myconnectwise.net", companyId: "a", publicKey: "b", privateKey: "c", clientId: "c", board: "B" }, down.impl).createTicket({
        customerId: "1",
        subject: "s",
        description: "d",
        requesterEmail: null,
        priority: "normal",
      }),
    );
    expect(err2.message).toBe("ConnectWise POST /service/tickets failed (500): Ticket object is invalid Board is required");
  });

  it("maps stock status and priority names", () => {
    expect(["New", "Assigned", "Waiting on Client", "Customer Updated", "Completed", ">Closed"].map((s) => fromConnectWiseStatus(s))).toEqual([
      "new",
      "in_progress",
      "waiting_on_customer",
      "in_progress",
      "resolved",
      "closed",
    ]);
    expect(fromConnectWiseStatus("Custom Done", true)).toBe("resolved");
    expect(["Priority 1 - Emergency Response", "Priority 3 - Normal Response", "Priority 4 - Schedule Maintenance", "Priority 10 - Other", ""].map(fromConnectWisePriority)).toEqual([
      "urgent",
      "normal",
      "low",
      "normal",
      null,
    ]);
  });
});

describe("Autotask PSA adapter", () => {
  const ZONE = "https://webservices5.autotask.net/atservicesrest/V1.0";
  const atTicket = (id: number, lastActivityDate: string, extra: Record<string, unknown> = {}) => ({
    id,
    ticketNumber: `T20260927.00${id}`,
    title: `Ticket ${id}`,
    description: "Printer offline",
    status: 8,
    priority: 1,
    companyID: 175,
    contactID: 30,
    lastActivityDate,
    createDate: "2026-09-26T08:00:00Z",
    ...extra,
  });

  function autotask(config: Record<string, string> = {}) {
    const net = fakeFetch([
      [/webservices\.autotask\.net\/atservicesrest\/v1\.0\/zoneInformation/, () => ({ zoneName: "America East 5", url: "https://webservices5.autotask.net/atservicesrest/", webUrl: "https://ww5.autotask.net/" })],
      [/\/Tickets\/entityInformation\/fields$/, () => ({
        fields: [
          { name: "status", isPickList: true, picklistValues: [
            { value: "1", label: "New", isActive: true },
            { value: "8", label: "In Progress", isActive: true },
            { value: "7", label: "Waiting Customer", isActive: true },
            { value: "5", label: "Complete", isActive: true, isSystem: true },
            { value: "21", label: "Old Waiting", isActive: false },
          ] },
          { name: "priority", isPickList: true, picklistValues: [
            { value: "4", label: "Critical", isActive: true },
            { value: "1", label: "High", isActive: true },
            { value: "2", label: "Medium", isActive: true },
            { value: "3", label: "Low", isActive: true },
          ] },
          { name: "title", isPickList: false },
        ],
      })],
      [/\/TicketNotes\/entityInformation\/fields$/, () => ({
        fields: [
          { name: "publish", isPickList: true, picklistValues: [{ value: "1", label: "All Autotask Users", isActive: true }, { value: "2", label: "Internal Only", isActive: true }] },
          { name: "noteType", isPickList: true, picklistValues: [{ value: "13", label: "System Workflow Note", isSystem: true, isActive: true }, { value: "3", label: "Task Notes", isDefaultValue: true, isActive: true }] },
        ],
      })],
      [/\/Tickets\/query\/next/, () => ({ items: [atTicket(12, "2026-09-27T10:00:00Z", { status: 7, priority: 4 })], pageDetails: { count: 1, requestCount: 500, prevPageUrl: null, nextPageUrl: null } })],
      [/\/Tickets\/query$/, () => ({
        items: [atTicket(11, "2026-09-27T10:30:00Z"), atTicket(10, "2026-09-27T09:00:00Z")],
        pageDetails: { count: 2, requestCount: 500, prevPageUrl: null, nextPageUrl: `${ZONE}/Tickets/query/next?paging=%7b%22pageSize%22%3a500%7d&search=%7b%7d` },
      })],
      [/\/TicketNotes\/query$/, (c) =>
        c.json().filter[0].value === 12
          ? { items: [
              { id: 903, ticketID: 12, title: "Re: printer", description: "Still offline after reboot", createdByContactID: 30, publish: 1, noteType: 3, createDateTime: "2026-09-27T09:50:00Z" },
              { id: 901, ticketID: 12, title: "Workflow", description: "Status changed", creatorResourceID: 4, publish: 1, noteType: 13, createDateTime: "2026-09-27T09:10:00Z" },
              { id: 902, ticketID: 12, title: "", description: "Checked the spooler", creatorResourceID: 29682885, publish: 2, noteType: 3, createDateTime: "2026-09-27T09:30:00Z" },
            ], pageDetails: { nextPageUrl: null } }
          : { items: [], pageDetails: { nextPageUrl: null } }],
      [/\/Companies\/query\/count$/, () => ({ queryCount: 3 })],
      [/\/Companies\/query$/, () => ({ items: [{ id: 175, companyName: "Contoso Ltd", webAddress: "www.contoso.example", isActive: true }, { id: 176, companyName: "No Site" }], pageDetails: { nextPageUrl: null } })],
      [/\/Companies\/175$/, () => ({ item: { id: 175, companyName: "Contoso Ltd" } })],
      [/\/Contacts\/30$/, () => ({ item: { id: 30, firstName: "Megan", lastName: "Bowen", emailAddress: "Megan.Bowen@contoso.example" } })],
      [/\/Contacts\/query$/, () => ({ items: [{ id: 30 }], pageDetails: { nextPageUrl: null } })],
      [/\/Tickets\/12\/Notes$/, (c) => ({ itemId: c.json().publish === 1 ? 950 : 951 })],
      [/\/Tickets\/12$/, () => ({ item: atTicket(12, "2026-09-27T10:00:00Z") })],
      [/\/Tickets\/900$/, () => ({ item: { id: 900, ticketNumber: "T20260927.0042" } })],
      [/\/Tickets$/, (c) => (c.method === "PATCH" ? { itemId: c.json().id } : { itemId: 900 })],
    ]);
    const adapter = new AutotaskAdapter({ username: "haley@msp.example", secret: "at-secret", integrationCode: "TRACKING123", ...config }, net.impl, NOW);
    return { adapter, net };
  }

  it("finds the zone without credentials, then authenticates with the three headers", async () => {
    const { adapter, net } = autotask();
    expect(await adapter.test()).toBe("Connected to Autotask (webservices5.autotask.net, 3 active companies).");
    expect(net.calls[0].url).toBe("https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation?user=haley%40msp.example");
    expect(Object.keys(net.calls[0].headers)).toEqual(["accept"]);
    expect(net.calls[1].url).toBe(`${ZONE}/Companies/query/count`);
    expect(net.calls[1].headers).toMatchObject({ apiintegrationcode: "TRACKING123", username: "haley@msp.example", secret: "at-secret", "content-type": "application/json" });
  });

  it("uses a configured zone URL and lists active companies", async () => {
    const { adapter, net } = autotask({ zoneUrl: "webservices5.autotask.net/ATServicesRest/" });
    expect(await adapter.listCustomers()).toEqual([
      { id: "175", name: "Contoso Ltd", domains: ["contoso.example"] },
      { id: "176", name: "No Site", domains: [] },
    ]);
    expect(net.calls[0].url).toBe("https://webservices5.autotask.net/ATServicesRest/V1.0/Companies/query");
    expect(net.calls[0].json()).toEqual({ filter: [{ op: "eq", field: "isActive", value: true }] });
  });

  it("follows nextPageUrl and returns changed tickets oldest first, past the cursor", async () => {
    const { adapter, net } = autotask();
    const tickets = await adapter.listUpdatedTickets(SINCE);
    const query = net.calls.find((c) => c.url.endsWith("/Tickets/query"))!;
    expect(query.json()).toEqual({ filter: [{ op: "gt", field: "lastActivityDate", value: SINCE }] });
    expect(net.calls.find((c) => c.url.includes("/Tickets/query/next"))!.method).toBe("GET");
    expect(tickets.map((t) => [t.id, t.updatedAt])).toEqual([
      ["12", "2026-09-27T10:00:00.000Z"],
      ["11", "2026-09-27T10:30:00.000Z"],
    ]);
    expect(tickets[0]).toMatchObject({
      number: "T20260927.0012",
      description: "Printer offline",
      customerId: "175",
      customerName: "Contoso Ltd",
      requesterEmail: "megan.bowen@contoso.example",
      requesterName: "Megan Bowen",
      status: "waiting_on_customer",
      externalStatus: "Waiting Customer",
      priority: "urgent",
    });
    // Workflow notes are dropped; contact notes are the customer's; Internal Only notes are private.
    expect(tickets[0].comments.map((c) => [c.id, c.fromCustomer, c.public, c.author])).toEqual([
      ["902", false, false, "Autotask resource 29682885"],
      ["903", true, true, "Megan Bowen"],
    ]);
    expect(tickets[1]).toMatchObject({ status: "in_progress", priority: "high" });
  });

  it("gets a ticket by id", async () => {
    const { adapter } = autotask();
    expect(await adapter.getTicket("12")).toMatchObject({ id: "12", status: "in_progress", comments: [expect.anything(), expect.anything()] });
  });

  it("adds published and internal notes, updates status and creates tickets", async () => {
    const { adapter, net } = autotask({ queueId: "29682833" });
    expect(adapter.notifiesCustomer).toBe(false);
    expect(await adapter.addComment("12", { body: "Fixed!", public: true })).toBe("950");
    expect(await adapter.addComment("12", { body: "note", public: false })).toBe("951");
    const notes = net.calls.filter((c) => c.url.endsWith("/Tickets/12/Notes")).map((c) => c.json());
    expect(notes[0]).toEqual({ ticketID: 12, title: "Reply to the customer (sent by Haley)", description: "Fixed!", noteType: 3, publish: 1 });
    expect(notes[1]).toMatchObject({ title: "Haley note", publish: 2 });

    await adapter.setStatus("12", "resolved");
    await adapter.setStatus("12", "waiting_on_customer");
    expect(net.calls.filter((c) => c.method === "PATCH").map((c) => [c.url, c.json()])).toEqual([
      [`${ZONE}/Tickets`, { id: 12, status: 5 }],
      [`${ZONE}/Tickets`, { id: 12, status: 7 }],
    ]);

    const created = await adapter.createTicket({ customerId: "175", subject: "Printer", description: "d", requesterEmail: "megan.bowen@contoso.example", priority: "low" });
    expect(created).toEqual({ id: "900", number: "T20260927.0042" });
    expect(net.calls.find((c) => c.url.endsWith("/Contacts/query"))!.json().filter).toEqual([
      { op: "eq", field: "companyID", value: 175 },
      { op: "eq", field: "emailAddress", value: "megan.bowen@contoso.example" },
    ]);
    expect(net.calls.find((c) => c.method === "POST" && c.url === `${ZONE}/Tickets`)!.json()).toEqual({
      companyID: 175,
      title: "Printer",
      description: "d",
      status: 1,
      priority: 3,
      queueID: 29682833,
      contactID: 30,
    });
  });

  it("falls back to configured or stock ids when picklists can't be read", async () => {
    const net = fakeFetch([
      [/entityInformation/, () => json(403, { errors: ["no access"] })],
      [/\/Tickets$/, () => ({ itemId: 1 })],
    ]);
    const adapter = new AutotaskAdapter({ username: "u", secret: "s", integrationCode: "i", zoneUrl: "https://webservices2.autotask.net/atservicesrest/v1.0", statusInProgress: "15" }, net.impl);
    await adapter.setStatus("3", "in_progress");
    await adapter.setStatus("3", "closed");
    expect(net.calls.filter((c) => c.method === "PATCH").map((c) => c.json())).toEqual([{ id: 3, status: 15 }, { id: 3, status: 5 }]);
  });

  it("explains authentication and server failures without leaking the secret", async () => {
    const net = fakeFetch([
      [/zoneInformation/, () => ({ url: "https://webservices5.autotask.net/atservicesrest/" })],
      [/Companies\/query$/, () => json(401, {})],
      [/Tickets\/query$/, () => json(500, { errors: ["Invalid filter: field lastActivityDate"] })],
    ]);
    const adapter = new AutotaskAdapter({ username: "u@x.example", secret: "at-super-secret", integrationCode: "i" }, net.impl);
    const err = await failure(adapter.listCustomers());
    expect(err.message).toMatch(/^Autotask POST \/Companies\/query failed \(401\): .*Check the API username, secret and integration code\.$/);
    expect(err.message).not.toContain("at-super-secret");
    await expect(adapter.listUpdatedTickets(null)).rejects.toThrow("Autotask POST /Tickets/query failed (500): Invalid filter: field lastActivityDate");
    const nozone = fakeFetch([[/zoneInformation/, () => json(404, { errors: ["Unable to find user"] })]]);
    await expect(new AutotaskAdapter({ username: "nobody", secret: "s", integrationCode: "i" }, nozone.impl).test()).rejects.toThrow(/zone lookup failed \(404\): Unable to find user/);
  });
});

describe("HaloPSA adapter", () => {
  const halo = (id: number, lastactiondate: string, extra: Record<string, unknown> = {}) => ({
    id,
    summary: `Ticket ${id}`,
    details: "<p>VPN drops&nbsp;hourly</p>",
    client_id: 12,
    client_name: "Contoso Ltd",
    user_name: "Megan Bowen",
    user_email: "Megan.Bowen@contoso.example",
    status_id: 2,
    priority_id: 2,
    dateoccurred: "2026-09-26T08:00:00",
    lastactiondate,
    last_update: "1900-01-01T00:00:00",
    ...extra,
  });
  const old = Array.from({ length: 99 }, (_, i) => halo(200 + i, "2026-09-27T08:00:00"));

  function haloPsa(config: Record<string, string> = {}) {
    const posted: any[] = [];
    const net = fakeFetch([
      [/\/auth\/token/, () => ({ access_token: "halo-token", token_type: "Bearer", expires_in: 3600 })],
      [/\/api\/Client\?pageinate=true&page_size=1&/, () => ({ record_count: 101, clients: [{ id: 12, name: "Contoso Ltd" }] })],
      [/\/api\/Client\?includeinactive=false.*page_no=1$/, () => ({
        record_count: 101,
        clients: [
          { id: 12, name: "Contoso Ltd", website: "https://contoso.example", emaildomain: "@contoso.example", client_domains: ["contoso-mail.example"] },
          { id: 13, name: "Gone", inactive: true },
          ...Array.from({ length: 98 }, (_, i) => ({ id: 100 + i, name: `Client ${i}` })),
        ],
      })],
      [/\/api\/Client\?includeinactive=false.*page_no=2$/, () => ({ record_count: 101, clients: [{ id: 500, name: "Fabrikam", client_domains: [{ domain: "fabrikam.example" }] }] })],
      [/\/api\/Tickets\?datesearch=.*page_no=1$/, () => ({ record_count: 101, tickets: [halo(42, "2026-09-27T10:30:00"), ...old] })],
      [/\/api\/Tickets\?datesearch=.*page_no=2$/, () => ({ record_count: 101, tickets: [halo(43, "2026-09-27T10:00:00", { status_id: 9 })] })],
      [/\/api\/Tickets\/(\d+)\?includedetails=true$/, (c) => {
        const id = Number(/Tickets\/(\d+)/.exec(c.url)![1]);
        return id === 43 ? halo(43, "2026-09-27T10:00:00", { status_id: 9 }) : halo(id, "2026-09-27T10:30:00", { status_id: 4, priority_id: 1 });
      }],
      [/\/api\/Actions\?ticket_id=42/, () => ({
        record_count: 3,
        actions: [
          { id: 3, ticket_id: 42, outcome: "Email Update", who: "Megan Bowen", who_type: 1, note: "It dropped again at 10", hiddenfromuser: false, datetime: "2026-09-27T10:25:00" },
          { id: 1, ticket_id: 42, outcome: "Logged", who: "Megan Bowen", who_type: 1, note: "VPN drops hourly", hiddenfromuser: false, datetime: "2026-09-26T08:00:00" },
          { id: 2, ticket_id: 42, outcome: "Private Note", who: "Jordan", who_type: 0, who_agentid: 5, note_html: "<p>Checked the <b>tunnel</b></p>", hiddenfromuser: true, datetime: "2026-09-27T09:00:00" },
        ],
      })],
      [/\/api\/Actions\?ticket_id=/, () => ({ record_count: 0, actions: [] })],
      [/\/api\/Status$/, () => [{ id: 1, name: "New" }, { id: 2, name: "In Progress" }, { id: 4, name: "With User" }, { id: 9, name: "Closed" }]],
      [/\/api\/Actions$/, (c) => (posted.push(c.json()), { id: c.json()[0].hiddenfromuser ? 11 : 10, ticket_id: 42 })],
      [/\/api\/Tickets$/, (c) => (posted.push(c.json()), [{ id: c.json()[0].id ?? 321 }])],
    ]);
    const adapter = new HaloAdapter({ instance: "https://yourmsp.halopsa.com/", clientId: "halo-app", clientSecret: "halo-secret", ...config }, net.impl, NOW);
    return { adapter, net, posted };
  }

  it("gets a client-credentials token once and uses it as a bearer", async () => {
    const { adapter, net } = haloPsa({ tenant: "yourmsp" });
    expect(await adapter.test()).toBe("Connected to yourmsp.halopsa.com (101 clients visible).");
    await adapter.test();
    expect(net.calls.filter((c) => c.url.includes("/auth/token")).length).toBe(1);
    expect(net.calls[0].url).toBe("https://yourmsp.halopsa.com/auth/token?tenant=yourmsp");
    expect(Object.fromEntries(new URLSearchParams(net.calls[0].body))).toEqual({ grant_type: "client_credentials", client_id: "halo-app", client_secret: "halo-secret", scope: "all" });
    expect(net.calls[1].headers.authorization).toBe("Bearer halo-token");
  });

  it("pages clients, skips inactive ones and collects their domains", async () => {
    const { adapter, net } = haloPsa();
    const clients = await adapter.listCustomers();
    expect(clients).toHaveLength(100);
    expect(clients[0]).toEqual({ id: "12", name: "Contoso Ltd", domains: ["contoso.example", "contoso-mail.example"] });
    expect(clients.at(-1)).toEqual({ id: "500", name: "Fabrikam", domains: ["fabrikam.example"] });
    expect(net.calls.filter((c) => c.url.includes("/api/Client")).length).toBe(2);
  });

  it("lists tickets changed since the cursor oldest first, with actions as comments", async () => {
    const { adapter, net } = haloPsa();
    const tickets = await adapter.listUpdatedTickets(SINCE);
    expect(net.calls.find((c) => c.url.includes("/api/Tickets?"))!.url).toContain(`datesearch=lastactiondate&startdate=${encodeURIComponent(SINCE)}`);
    expect(tickets.map((t) => [t.id, t.updatedAt, t.status])).toEqual([
      ["43", "2026-09-27T10:00:00.000Z", "closed"],
      ["42", "2026-09-27T10:30:00.000Z", "waiting_on_customer"],
    ]);
    expect(tickets[1]).toMatchObject({
      number: "42",
      description: "VPN drops hourly",
      customerId: "12",
      customerName: "Contoso Ltd",
      requesterEmail: "megan.bowen@contoso.example",
      requesterName: "Megan Bowen",
      externalStatus: "With User",
      priority: "urgent",
    });
    expect(tickets[1].comments.map((c) => [c.id, c.fromCustomer, c.public, c.body])).toEqual([
      ["1", true, true, "VPN drops hourly"],
      ["2", false, false, "Checked the tunnel"],
      ["3", true, true, "It dropped again at 10"],
    ]);
    expect(net.calls.filter((c) => c.url.includes("/api/Status")).length).toBe(1);
  });

  it("posts emailed and private actions, status changes and new tickets as arrays", async () => {
    const { adapter, posted } = haloPsa({ ticketTypeId: "3" });
    expect(adapter.notifiesCustomer).toBe(true);
    expect(await adapter.addComment("42", { body: "Fixed!", public: true })).toBe("10");
    expect(await adapter.addComment("42", { body: "note", public: false })).toBe("11");
    expect(posted[0]).toEqual([{ ticket_id: 42, outcome: "Email User", note: "Fixed!", hiddenfromuser: false, sendemail: true }]);
    expect(posted[1]).toEqual([{ ticket_id: 42, outcome: "Private Note", note: "note", hiddenfromuser: true, sendemail: false }]);
    await adapter.setStatus("42", "waiting_on_customer");
    await adapter.setStatus("42", "resolved");
    expect(posted.slice(2, 4)).toEqual([[{ id: 42, status_id: 4 }], [{ id: 42, status_id: 9 }]]);
    const created = await adapter.createTicket({ customerId: "12", subject: "Printer", description: "d", requesterEmail: "megan@contoso.example", priority: "normal" });
    expect(created).toEqual({ id: "321", number: "321" });
    expect(posted[4]).toEqual([{ summary: "Printer", details: "d", client_id: 12, status_id: 1, priority_id: 3, user_email: "megan@contoso.example", tickettype_id: 3 }]);
  });

  it("uses configured status ids and survives an instance without a waiting status", async () => {
    const net = fakeFetch([
      [/\/auth\/token/, () => ({ access_token: "t" })],
      [/\/api\/Status$/, () => [{ id: 1, name: "New" }, { id: 2, name: "In Progress" }]],
      [/\/api\/Tickets$/, () => [{ id: 1 }]],
    ]);
    const adapter = new HaloAdapter({ instance: "x.halopsa.com", clientId: "a", clientSecret: "b", statusClosed: "20" }, net.impl);
    await adapter.setStatus("1", "waiting_on_customer");
    await adapter.setStatus("1", "closed");
    expect(net.calls.filter((c) => c.url.endsWith("/api/Tickets")).map((c) => c.json())).toEqual([[{ id: 1, status_id: 2 }], [{ id: 1, status_id: 20 }]]);
  });

  it("explains sign-in and server failures", async () => {
    const bad = fakeFetch([[/\/auth\/token/, () => json(401, { error: "invalid_client", error_description: "Client authentication failed" })]]);
    const err = await failure(new HaloAdapter({ instance: "x.halopsa.com", clientId: "a", clientSecret: "halo-top-secret" }, bad.impl).listCustomers());
    expect(err.message).toBe("HaloPSA sign-in failed (401): Client authentication failed. Check the client ID and secret.");
    expect(err.message).not.toContain("halo-top-secret");
    const down = fakeFetch([
      [/\/auth\/token/, () => ({ access_token: "t" })],
      [/\/api\//, () => new Response("Object reference not set to an instance of an object.", { status: 500 })],
    ]);
    await expect(new HaloAdapter({ instance: "x.halopsa.com", clientId: "a", clientSecret: "b" }, down.impl).getTicket("5")).rejects.toThrow(
      "HaloPSA GET /api/Tickets/5 failed (500): Object reference not set to an instance of an object.",
    );
  });

  it("maps built-in and custom statuses", () => {
    expect([fromHaloStatus(1, ""), fromHaloStatus(2, "In Progress"), fromHaloStatus(4, "With User"), fromHaloStatus(9, ""), fromHaloStatus(30, "Resolved - Awaiting Confirmation")]).toEqual([
      "new",
      "in_progress",
      "waiting_on_customer",
      "closed",
      "resolved",
    ]);
  });
});

describe("New PSAs end to end", () => {
  it("imports a HaloPSA ticket, replies as an emailed action, and wakes Haley only for the customer's reply", async () => {
    // A tiny stateful Halo: one ticket whose actions grow as Haley and the customer write. The app uses the real
    // clock (first sync looks back 7 days), so times are relative to now, in Halo's zone-less format.
    const start = Date.now() - 2 * 3_600_000;
    const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString().slice(0, 19);
    const actions: any[] = [{ id: 1, who: "Megan Bowen", who_type: 1, note: "Teams crashes every morning", hiddenfromuser: false, datetime: at(0) }];
    let lastAction = at(0);
    const ticket = () => ({ id: 42, summary: "Teams crashing", details: "Teams crashes every morning", client_id: 12, client_name: "Contoso Ltd", user_name: "Megan Bowen", user_email: "megan.bowen@contoso.example", status_id: 1, priority_id: 3, lastactiondate: lastAction });
    const net = fakeFetch([
      [/\/auth\/token/, () => ({ access_token: "t" })],
      [/\/api\/Client\?pageinate=true&page_size=1&/, () => ({ record_count: 1, clients: [{ id: 12, name: "Contoso Ltd" }] })],
      [/\/api\/Client\?includeinactive/, () => ({ record_count: 1, clients: [{ id: 12, name: "Contoso Ltd", emaildomain: "contoso.example" }] })],
      [/\/api\/Status$/, () => [{ id: 1, name: "New" }, { id: 2, name: "In Progress" }, { id: 9, name: "Closed" }]],
      [/\/api\/Tickets\?datesearch=/, () => ({ record_count: 1, tickets: [ticket()] })],
      [/\/api\/Tickets\/42\?/, () => ticket()],
      [/\/api\/Actions\?ticket_id=42/, () => ({ actions })],
      // New connections import attachments; this ticket has none.
      [/\/api\/Attachment\?ticket_id=42/, () => ({ attachments: [] })],
      [/\/api\/Actions$/, (c) => {
        const [a] = c.json();
        const id = actions.length + 1;
        lastAction = at(id);
        actions.push({ id, who: "Haley API", who_type: 0, who_agentid: 3, note: a.note, hiddenfromuser: a.hiddenfromuser, datetime: lastAction });
        return { id };
      }],
      [/\/api\/Tickets$/, (c) => [{ id: c.json()[0].id }]],
    ]);
    const { app, store, psa, agent } = await makeApp(new ScriptedLlm(turn(text("Looking into it.")), turn(text("Thanks, checking the logs."))), {}, net.impl);
    await app.inject({ method: "POST", url: "/api/demo" });
    const contoso = store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
    const connection = (await app.inject({ method: "POST", url: "/api/psa", payload: { kind: "halopsa", config: { instance: "msp.halopsa.com", clientId: "a", clientSecret: "halo-secret-xyz" } } })).json();
    expect(connection).toMatchObject({ kind: "halopsa", status: "connected" });
    expect(JSON.stringify((await app.inject({ url: "/api/psa" })).json())).not.toContain("halo-secret-xyz");
    const customers = (await app.inject({ url: `/api/psa/${connection.id}/customers` })).json();
    expect(customers[0]).toMatchObject({ id: "12", suggestedOrgId: contoso.id });
    await app.inject({ method: "PUT", url: `/api/psa/${connection.id}/mapping`, payload: { "12": contoso.id } });

    expect(await psa.sync(connection.id)).toMatchObject({ imported: 1, errors: [] });
    const t = store.listTickets({ search: "Teams crashing" })[0];
    expect(t).toMatchObject({ channel: "halopsa", requester_email: "megan.bowen@contoso.example" });
    await agent.settled(store.listRuns({ ticketId: t.id })[0].id);
    const ack = actions.find((a) => a.note.includes("I'm Haley"));
    expect(ack).toMatchObject({ hiddenfromuser: false });

    // Haley's own action doesn't come back as a customer message; the customer's reply does.
    await psa.sync(connection.id);
    expect(store.listRuns({ ticketId: t.id })).toHaveLength(1);
    actions.push({ id: 99, who: "Megan Bowen", who_type: 1, note: "Only when on VPN", hiddenfromuser: false, datetime: at(60) });
    lastAction = at(60);
    const pulled = await psa.sync(connection.id);
    expect(pulled.errors).toEqual([]);
    expect(store.listTicketEvents(t.id).some((e) => e.body === "Only when on VPN")).toBe(true);
    const runs = store.listRuns({ ticketId: t.id });
    expect(runs).toHaveLength(2);
    await agent.settled(runs[0].id);
  });
});
