import { describe, expect, it } from "vitest";
import { makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

const DAY = 86_400_000;

describe("scheduled task overlap", () => {
  it("keeps a due task waiting through approval, blocks Run now, and retries once the prior run completes", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("m365_remove_group_member", { user: "alex.wilber@contoso.example", group: "Accounts Payable Mailbox" })),
      turn(text("Removed.")),
      turn(text("Next review done.")),
    );
    const { app, store, agent, scheduler } = await makeApp(llm);
    try {
      await app.inject({ method: "POST", url: "/api/demo" });
      const org = store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
      const now = Date.now();
      const schedule = store.createSchedule({ orgId: org.id, title: "Review access", instruction: "Review and remove expired access", cadence: "daily", nextRunAt: new Date(now - 1000).toISOString(), createdBy: "tech" });
      const first = (await scheduler.tick(now)).started[0];
      await agent.settled(first.runId);
      expect(store.getRun(first.runId)!.status).toBe("awaiting_approval");
      const dueAt = store.getSchedule(schedule.id)!.next_run_at;
      const blocked = await scheduler.tick(now + DAY);
      expect(blocked.started).toHaveLength(0);
      expect(blocked.skipped).toContainEqual({ scheduleId: schedule.id, reason: "previous task run busy; retrying" });
      expect(store.getSchedule(schedule.id)).toMatchObject({ next_run_at: dueAt, last_run_id: first.runId });
      const runNow = await app.inject({ method: "POST", url: `/api/schedules/${schedule.id}/run` });
      expect(runNow.statusCode).toBe(409);
      expect(store.listActions({ runId: first.runId, status: "pending_approval" })).toHaveLength(1);
      await agent.decideAction(store.listActions({ runId: first.runId })[0].id, true, "tech");
      await agent.settled(first.runId);
      expect(store.getRun(first.runId)!.status).toBe("completed");
      const retried = await scheduler.tick(now + DAY + 30_000);
      expect(retried.started).toHaveLength(1);
      await agent.settled(retried.started[0].runId);
      expect(store.getRun(retried.started[0].runId)!.status).toBe("completed");
      expect(Date.parse(store.getSchedule(schedule.id)!.next_run_at!)).toBeGreaterThan(now + DAY + 30_000);
    } finally { await app.close(); }
  });

  it("blocks another scheduled or manual launch while the previous task's model call is running", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const { app, store, agent, scheduler } = await makeApp(new ScriptedLlm(async () => { await pending; return { content: [text("Done.")] }; }));
    try {
      const org = store.createOrg({ name: "Acme" });
      const now = Date.now();
      const schedule = store.createSchedule({ orgId: org.id, title: "Audit", instruction: "Review", cadence: "daily", nextRunAt: new Date(now - 1000).toISOString(), createdBy: "tech" });
      const first = scheduler.runNow(schedule.id, now).started[0];
      expect(store.getRun(first.runId)!.status).toBe("queued");
      expect(scheduler.runNow(schedule.id, now).started).toHaveLength(0);
      await Promise.resolve();
      expect(store.getRun(first.runId)!.status).toBe("running");
      expect(scheduler.runNow(schedule.id, now).started).toHaveLength(0);
      expect((await scheduler.tick(now)).started).toHaveLength(0);
      finish();
      await agent.settled(first.runId);
    } finally { finish(); await app.close(); }
  });
});
