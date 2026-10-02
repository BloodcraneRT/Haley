import { describe, expect, it } from "vitest";
import { AutotaskAdapter } from "../src/psa/autotask.js";
import { ConnectWiseAdapter } from "../src/psa/connectwise.js";
import { HaloAdapter } from "../src/psa/halopsa.js";
import { fakeFetch } from "./helpers.js";

const ENTRY = { startedAt: "2026-10-01T14:00:00.123Z", minutes: 25, notes: "Haley reset the mailbox rule." };
const ZONE = "https://webservices5.autotask.net/ATServicesRest/V1.0";

describe("ConnectWise time entries", () => {
  const cw = (net: ReturnType<typeof fakeFetch>, extra: Record<string, string> = {}) =>
    new ConnectWiseAdapter({ site: "api-na.myconnectwise.net", companyId: "c", publicKey: "p", privateKey: "s", clientId: "i", board: "Help Desk", ...extra }, net.impl);

  it("adds a Do Not Bill entry on the service ticket for the configured member", async () => {
    const net = fakeFetch([[/\/time\/entries$/, () => ({ id: 777 })]]);
    expect(await cw(net, { timeMember: "haley", timeWorkTypeId: "12" }).logTime("4321", ENTRY)).toBe("777");
    expect(net.calls[0].method).toBe("POST");
    expect(net.calls[0].json()).toEqual({
      chargeToId: 4321,
      chargeToType: "ServiceTicket",
      member: { identifier: "haley" },
      timeStart: "2026-10-01T14:00:00Z",
      timeEnd: "2026-10-01T14:25:00Z",
      notes: ENTRY.notes,
      billableOption: "DoNotBill",
      addToDetailDescriptionFlag: false,
      addToInternalAnalysisFlag: false,
      addToResolutionFlag: false,
      workType: { id: 12 },
    });
  });

  it("asks for a member instead of guessing", async () => {
    const net = fakeFetch([]);
    await expect(cw(net).logTime("4321", ENTRY)).rejects.toThrow(/member for Haley's time/);
    expect(net.calls).toHaveLength(0);
  });
});

describe("Autotask time entries", () => {
  const at = (net: ReturnType<typeof fakeFetch>, extra: Record<string, string> = {}) =>
    new AutotaskAdapter({ username: "u", secret: "s", integrationCode: "i", zoneUrl: ZONE, ...extra }, net.impl);

  it("adds a non-billable entry using the ticket's assigned role", async () => {
    const net = fakeFetch([
      [/\/Tickets\/555$/, () => ({ item: { id: 555, assignedResourceroleID: 29683000 } })],
      [/\/TimeEntries$/, () => ({ itemId: 9001 })],
    ]);
    expect(await at(net, { timeResourceId: "29684" }).logTime("555", ENTRY)).toBe("9001");
    const post = net.calls.find((c) => c.url.endsWith("/TimeEntries"))!;
    expect(post.json()).toEqual({
      ticketID: 555,
      resourceID: 29684,
      roleID: 29683000,
      startDateTime: "2026-10-01T14:00:00.123Z",
      endDateTime: "2026-10-01T14:25:00.123Z",
      summaryNotes: ENTRY.notes,
      isNonBillable: true,
      showOnInvoice: false,
    });
  });

  it("falls back to the resource's default service desk role, or uses a configured one", async () => {
    const net = fakeFetch([
      [/\/Tickets\/555$/, () => ({ item: { id: 555 } })],
      [/\/ResourceServiceDeskRoles\/query$/, () => ({ items: [{ roleID: 1 }, { roleID: 2, isDefault: true }], pageDetails: {} })],
      [/\/TimeEntries$/, () => ({ itemId: 1 })],
    ]);
    await at(net, { timeResourceId: "29684" }).logTime("555", ENTRY);
    expect(net.calls.find((c) => c.url.endsWith("/TimeEntries"))!.json().roleID).toBe(2);

    const configured = fakeFetch([[/\/TimeEntries$/, () => ({ itemId: 2 })]]);
    await at(configured, { timeResourceId: "29684", timeRoleId: "42" }).logTime("555", ENTRY);
    expect(configured.calls).toHaveLength(1);
    expect(configured.calls[0].json().roleID).toBe(42);
  });

  it("asks for a resource instead of guessing", async () => {
    await expect(at(fakeFetch([])).logTime("555", ENTRY)).rejects.toThrow(/resource id for Haley's time/);
  });
});

describe("HaloPSA time entries", () => {
  it("adds a private, non-emailed, non-billable action with the time in hours", async () => {
    const net = fakeFetch([
      [/auth\/token/, () => ({ access_token: "t" })],
      [/\/api\/Actions$/, () => [{ id: 31337 }]],
    ]);
    const halo = new HaloAdapter({ instance: "msp.halopsa.com", clientId: "c", clientSecret: "s", timeChargeRateId: "5" }, net.impl);
    expect(await halo.logTime("88", ENTRY)).toBe("31337");
    expect(net.calls.find((c) => c.url.endsWith("/api/Actions"))!.json()).toEqual([
      {
        ticket_id: 88,
        outcome: "Private Note",
        note: ENTRY.notes,
        hiddenfromuser: true,
        sendemail: false,
        timetaken: 0.42,
        actionarrivaldate: "2026-10-01T14:00:00.123Z",
        actioncompletiondate: "2026-10-01T14:25:00.123Z",
        actisbillable: false,
        chargerate: 5,
      },
    ]);
  });
});
