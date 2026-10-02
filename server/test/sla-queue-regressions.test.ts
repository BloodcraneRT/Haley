import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

async function largeQueue() {
  const context = await makeApp();
  const org = context.store.createOrg({ name: "Large queue" });
  const old = context.store.createTicket({ orgId: org.id, title: "Old low-priority breach", priority: "low" });
  const now = new Date().toISOString();
  context.store.db.prepare("UPDATE tickets SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 10 * 86_400_000).toISOString(), old.id);
  // All 10,000 recent urgent tickets sort ahead of the older low-priority ticket in the UI list.
  context.store.db.prepare(`INSERT INTO tickets
    (id, number, org_id, title, description, requester_name, requester_email, status, priority, category,
     assignee, channel, channel_ref, assurance, verification, created_at, updated_at)
    SELECT 'recent_' || value, value + ?, ?, 'Recent urgent ticket', '', '', '', 'new', 'urgent', 'general',
      'haley', 'portal', '{}', 'technician', '', ?, ? FROM json_each(?)`)
    .run(old.number + 1, org.id, now, now, JSON.stringify(Array.from({ length: 10_000 }, (_, i) => i)));
  return { ...context, old };
}

describe("SLA queues beyond the dashboard list cap", () => {
  it("counts the older breach even when 10,000 higher-priority tickets precede it", async () => {
    const { app } = await largeQueue();
    try {
      const response = await app.inject({ url: "/api/stats" });
      expect(response.statusCode).toBe(200);
      expect(response.json().slaBreached).toBe(1);
    } finally { await app.close(); }
  });

  it("escalates the older breach and does not escalate it again on the next sweep", async () => {
    const { app, store, scheduler, old } = await largeQueue();
    try {
      expect((await scheduler.tick()).escalated).toEqual([old.id]);
      expect(store.getTicket(old.id)).toMatchObject({ status: "escalated", sla_escalated: true });
      expect((await scheduler.tick()).escalated).toEqual([]);
    } finally { await app.close(); }
  });
});
