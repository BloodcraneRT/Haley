import { describe, expect, it } from "vitest";
import { clientReport } from "../src/report.js";
import { makeApp } from "./helpers.js";

describe("accurate workspace and value reporting", () => {
  it("counts failed-run status escalations even without a dedicated escalation event", async () => {
    const { app, store } = await makeApp();
    try {
      const org = store.createOrg({ name: "Failed run client" });
      const ticket = store.createTicket({ orgId: org.id, title: "Run failed" });
      store.updateTicket(ticket.id, { status: "escalated", assignee: "unassigned" }, "haley");
      let report = clientReport(store, org, { days: 90, minutesPerTicket: 20, minutesPerAction: 5 });
      expect(report.tickets.escalated).toBe(1);
      store.setTicketStatus(ticket.id, "resolved", "haley");
      report = clientReport(store, org, { days: 90, minutesPerTicket: 20, minutesPerAction: 5 });
      expect(report.tickets.resolvedByHaleyAlone).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("does not credit manual resolutions or technician approvals to Haley alone", async () => {
    const { app, store } = await makeApp();
    try {
      const org = store.createOrg({ name: "Reporting client" });
      const manual = store.createTicket({ orgId: org.id, title: "Manual fix" });
      store.setTicketStatus(manual.id, "resolved", "Jordan");
      const automatic = store.createTicket({ orgId: org.id, title: "Automatic fix" });
      store.setTicketStatus(automatic.id, "resolved", "haley");
      const assisted = store.createTicket({ orgId: org.id, title: "Approved fix" });
      store.addTicketEvent(assisted.id, "action", "Jordan", "Approved the fix", { decision: "approved" });
      store.setTicketStatus(assisted.id, "resolved", "haley");
      const report = clientReport(store, org, { days: 90, minutesPerTicket: 20, minutesPerAction: 5 });
      expect(report.tickets).toMatchObject({ resolved: 3, resolvedByHaleyAlone: 1, automationRate: 33.3 });
      expect(report.timeSaved.hours).toBe(0.3);
    } finally {
      await app.close();
    }
  });

  it("counts weekly resolutions by resolution date instead of recent comments", async () => {
    const { app, store } = await makeApp();
    try {
      const org = store.createOrg({ name: "Reporting client" });
      const ticket = store.createTicket({ orgId: org.id, title: "Old resolution" });
      store.setTicketStatus(ticket.id, "resolved", "haley");
      store.db.prepare("UPDATE tickets SET resolved_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", ticket.id);
      store.addTicketEvent(ticket.id, "agent_note", "Jordan", "Administrative note today");
      expect(store.stats().resolvedThisWeek).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("counts PSA technician comments as human intervention, but preserves requester follow-ups", async () => {
    const { app, store } = await makeApp();
    try {
      const org = store.createOrg({ name: "PSA client" });
      const assisted = store.createTicket({ orgId: org.id, title: "PSA technician helped", requesterName: "Jordan" });
      store.addTicketEvent(assisted.id, "comment", "Jordan", "I fixed the mailbox manually", { channel: "syncro", fromTechnician: true });
      store.setTicketStatus(assisted.id, "resolved", "haley");
      const automatic = store.createTicket({ orgId: org.id, title: "Requester followed up", requesterName: "Megan" });
      store.addTicketEvent(automatic.id, "comment", "Megan", "Thanks, please finish", { channel: "email", fromRequester: true });
      store.setTicketStatus(automatic.id, "in_progress", "haley");
      store.setTicketStatus(automatic.id, "resolved", "haley");
      const report = clientReport(store, org, { days: 90, minutesPerTicket: 20, minutesPerAction: 5 });
      expect(report.tickets).toMatchObject({ resolved: 2, resolvedByHaleyAlone: 1, automationRate: 50 });
    } finally {
      await app.close();
    }
  });

  it("returns exact client counts after 10,000 tickets without loading ticket rows", async () => {
    const { app, store } = await makeApp();
    try {
      const org = store.createOrg({ name: "Large client" });
      const empty = store.createOrg({ name: "Empty client" });
      const insert = store.db.prepare("INSERT INTO tickets (id, number, org_id, title, created_at, updated_at) VALUES (?, ?, ?, 'Queue', ?, ?)");
      const now = new Date().toISOString();
      store.db.exec("BEGIN");
      for (let i = 0; i < 10_005; i++) insert.run(`bulk-${i}`, i + 1, org.id, now, now);
      store.db.exec("COMMIT");
      const response = await app.inject({ url: "/api/orgs" });
      expect(response.statusCode).toBe(200);
      expect(response.json().find((o: { id: string }) => o.id === org.id).openTickets).toBe(10_005);
      expect(response.json().find((o: { id: string }) => o.id === empty.id).openTickets).toBe(0);
    } finally {
      await app.close();
    }
  });
});
