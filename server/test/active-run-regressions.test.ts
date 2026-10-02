import { describe, expect, it } from "vitest";
import { RunConflictError } from "../src/agent/runner.js";
import { makeApp } from "./helpers.js";

describe("ticket active run lookup", () => {
  it("finds pending work behind more than 100 later completed runs and prevents overlap", async () => {
    const { app, store, agent } = await makeApp();
    try {
      const org = store.createOrg({ name: "Many plans" });
      const ticket = store.createTicket({ orgId: org.id, title: "Still awaiting approval" });
      const pending = store.createRun({ orgId: org.id, ticketId: ticket.id, kind: "ticket", title: "Pending", instruction: "Change access", createdBy: "tech" });
      store.saveRunProgress(pending.id, { status: "awaiting_approval" });
      store.db.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", pending.id);
      for (let i = 0; i < 101; i++) {
        const plan = store.createRun({ orgId: org.id, ticketId: ticket.id, kind: "ticket", mode: "plan", title: `Plan ${i}`, instruction: "Preview", createdBy: "tech" });
        store.saveRunProgress(plan.id, { status: "completed" });
      }
      expect(agent.activeRun(ticket.id)?.id).toBe(pending.id);
      expect(() => agent.startTicketRun(ticket.id, "tech")).toThrow(RunConflictError);
    } finally { await app.close(); }
  });
});
