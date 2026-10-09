import { describe, expect, it } from "vitest";
import { psaTimeIssues } from "../src/qa.js";
import { ConnectWiseAdapter } from "../src/psa/connectwise.js";
import { HaloAdapter } from "../src/psa/halopsa.js";
import { SyncroAdapter } from "../src/psa/syncro.js";
import { AutotaskAdapter } from "../src/psa/autotask.js";
import type { LoggedTime, PsaAdapter, PsaConnection } from "../src/psa/types.js";
import { fakeFetch, makeApp, ScriptedLlm } from "./helpers.js";

/** A PSA whose time entries the test sets; null makes it hang (for the timeout). */
function timePsa(entries: () => LoggedTime[] | Error | null, withMethod = true): PsaAdapter {
  return {
    kind: "connectwise",
    test: async () => "ok",
    listCustomers: async () => [],
    listUpdatedTickets: async () => [],
    getTicket: async () => {
      throw new Error("unused");
    },
    addComment: async () => "c",
    setStatus: async () => {},
    createTicket: async () => ({ id: "x", number: "x" }),
    ...(withMethod
      ? {
          listTimeEntries: async () => {
            const e = entries();
            if (e === null) return new Promise<never>(() => {});
            if (e instanceof Error) throw e;
            return e;
          },
        }
      : {}),
  };
}

const entry = (id: string, minutes: number, notes = "Replaced toner", member = "Dana") => ({ id, minutes, member, notes, createdAt: "2026-10-01T10:00:00Z" });

async function setup(adapter: PsaAdapter, timeEntries: "off" | "actual" | "estimate" = "actual") {
  const haley = await makeApp(new ScriptedLlm(), {}, undefined, undefined, () => adapter);
  const { app, store } = haley;
  const org = store.createOrg({ name: "Contoso", domain: "contoso.example" });
  const connection = (await app.inject({ method: "POST", url: "/api/psa", payload: { kind: "connectwise", config: { site: "a", companyId: "b", publicKey: "c", privateKey: "d", clientId: "e", board: "f" }, options: { timeEntries } } })).json() as PsaConnection;
  const ticket = store.createTicket({ orgId: org.id, title: "Printer offline", channel: "connectwise" });
  store.createTicketLink({ ticketId: ticket.id, connectionId: connection.id, externalId: "4512", externalNumber: "4512", seenCommentIds: [] });
  store.updateTicketLink(ticket.id, connection.id, { timeEntryIds: ["900"] });
  const qa = async () => (await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/qa` })).json() as { issues: Array<{ code: string; level: string; text: string }> };
  return { ...haley, connection, ticket, qa };
}

describe("PSA time in the close check", () => {
  it("warns when only Haley's time is on the PSA ticket, and is satisfied by a technician's", async () => {
    let entries: LoggedTime[] = [entry("900", 12, "anything"), entry("901", 15, "Resolved by Haley (AI technician). Logged at the workspace estimate.")];
    const { app, qa } = await setup(timePsa(() => entries));
    expect((await qa()).issues).toContainEqual({ code: "no_psa_time", level: "warning", text: "No technician time is logged on ConnectWise PSA ticket #4512." });
    entries = [...entries, entry("902", 20)];
    expect((await qa()).issues.map((i) => i.code)).not.toContain("no_psa_time");
    await app.close();
  });

  it("turns a PSA failure into a hint, and skips connections that don't log time or can't read it", async () => {
    const failing = await setup(timePsa(() => new Error("ConnectWise GET /time/entries failed (403)")));
    expect((await failing.qa()).issues).toContainEqual({ code: "psa_time_unchecked", level: "hint", text: "Couldn't check the time on ConnectWise PSA ticket #4512: ConnectWise GET /time/entries failed (403)" });
    await failing.app.close();

    const off = await setup(timePsa(() => []), "off");
    expect((await off.qa()).issues.map((i) => i.code)).not.toContain("no_psa_time");
    await off.app.close();

    const unsupported = await setup(timePsa(() => [], false));
    expect((await unsupported.qa()).issues.map((i) => i.code).filter((c) => c.startsWith("psa"))).toEqual([]);
    await unsupported.app.close();
  });

  it("gives up after the timeout", async () => {
    const { app, store, psa, ticket } = await setup(timePsa(() => null));
    const issues = await psaTimeIssues(store, (c) => psa.adapterFor(c), ticket, 20);
    expect(issues).toEqual([{ code: "psa_time_unchecked", level: "hint", text: "Couldn't check the time on ConnectWise PSA ticket #4512: the PSA didn't answer in time" }]);
    await app.close();
  });
});

describe("time entries in each PSA", () => {
  it("ConnectWise: time entries charged to the ticket", async () => {
    const net = fakeFetch([[/\/time\/entries\?/, () => [{ id: 7, actualHours: 0.5, member: { name: "Dana Reyes" }, notes: "Fixed", timeStart: "2026-10-01T10:00:00Z" }]]]);
    const cw = new ConnectWiseAdapter({ site: "api-na.myconnectwise.net", companyId: "a", publicKey: "b", privateKey: "c", clientId: "d", board: "B" }, net.impl);
    expect(await cw.listTimeEntries("4512")).toEqual([{ id: "7", minutes: 30, member: "Dana Reyes", notes: "Fixed", createdAt: "2026-10-01T10:00:00.000Z" }]);
    expect(decodeURIComponent(net.calls[0].url)).toContain('conditions=chargeToType="ServiceTicket" and chargeToId=4512');
  });

  it("HaloPSA: actions with time taken", async () => {
    const net = fakeFetch([
      [/\/auth\/token/, () => ({ access_token: "t", expires_in: 3600 })],
      [/\/api\/Actions\?ticket_id=9/, () => ({ actions: [{ id: 1, who: "Dana", note: "Called user", timetaken: 0.25, datetime: "2026-10-01T10:00:00" }, { id: 2, who: "Megan", note: "Thanks", timetaken: 0 }] })],
    ]);
    const halo = new HaloAdapter({ instance: "https://msp.halopsa.com", clientId: "a", clientSecret: "b" }, net.impl);
    expect(await halo.listTimeEntries("9")).toEqual([{ id: "1", minutes: 15, member: "Dana", notes: "Called user", createdAt: "2026-10-01T10:00:00.000Z" }]);
  });

  it("Syncro: the ticket's timers", async () => {
    const net = fakeFetch([[/\/tickets\/3$/, () => ({ ticket: { id: 3, ticket_timers: [{ id: 5, start_time: "2026-10-01T10:00:00Z", end_time: "2026-10-01T10:45:00Z", user_id: 44, notes: "Onsite" }] } })]]);
    const syncro = new SyncroAdapter({ subdomain: "msp", apiKey: "k" }, net.impl);
    expect(await syncro.listTimeEntries("3")).toEqual([{ id: "5", minutes: 45, member: "44", notes: "Onsite", createdAt: "2026-10-01T10:00:00Z" }]);
  });

  it("Autotask: time entries for the ticket", async () => {
    const net = fakeFetch([[/\/TimeEntries\/query$/, () => ({ items: [{ id: 8, hoursWorked: 1.5, resourceID: 29, summaryNotes: "Rebuilt profile", startDateTime: "2026-10-01T10:00:00Z" }], pageDetails: {} })]]);
    const at = new AutotaskAdapter({ username: "u", secret: "s", integrationCode: "i", zoneUrl: "https://webservices2.autotask.net/atservicesrest/v1.0" }, net.impl);
    expect(await at.listTimeEntries("7")).toEqual([{ id: "8", minutes: 90, member: "29", notes: "Rebuilt profile", createdAt: "2026-10-01T10:00:00.000Z" }]);
    expect(net.calls[0].json().filter).toEqual([{ op: "eq", field: "ticketID", value: 7 }]);
  });
});
