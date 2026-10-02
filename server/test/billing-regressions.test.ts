import { describe, expect, it } from "vitest";
import type { ModelProfile } from "../src/ai/providers.js";
import { TASK_TEMPLATES } from "../src/agent/templates.js";
import { priceFor, usageReport } from "../src/usage.js";
import { makeApp } from "./helpers.js";

const FROM = new Date("2026-10-01T00:00:00.000Z");
const TO = new Date("2026-10-01T12:00:00.000Z");

describe("billing report regressions", () => {
  it("uses the exact supplied start for partial-day billing periods", async () => {
    const { app, store } = await makeApp();
    try {
      const org = store.createOrg({ name: "Partial month" });
      for (const at of ["2026-09-30T23:59:59.999Z", FROM.toISOString()]) {
        const ticket = store.createTicket({ orgId: org.id, title: at });
        store.setTicketStatus(ticket.id, "resolved", "haley");
        store.db.prepare("UPDATE tickets SET created_at = ?, resolved_at = ? WHERE id = ?").run(at, at, ticket.id);
      }
      const report = usageReport(store, FROM, TO);
      expect(report.clients[0].ticketsResolvedByHaley).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("excludes the end instant from both resolutions and model usage", async () => {
    const { app, store } = await makeApp();
    try {
      const org = store.createOrg({ name: "Month boundary" });
      const to = new Date("2026-11-01T00:00:00.000Z");
      const ticket = store.createTicket({ orgId: org.id, title: "Next month" });
      store.setTicketStatus(ticket.id, "resolved", "haley");
      store.db.prepare("UPDATE tickets SET resolved_at = ? WHERE id = ?").run(to.toISOString(), ticket.id);
      const run = store.createRun({ orgId: org.id, kind: "task", title: "Boundary", instruction: "Check", createdBy: "Jordan" });
      store.recordModelUsage({ orgId: org.id, runId: run.id, model: "test/scripted", inputTokens: 100, outputTokens: 20 });
      store.db.prepare("UPDATE model_usage SET created_at = ? WHERE run_id = ?").run(to.toISOString(), run.id);
      expect(usageReport(store, FROM, to).clients[0]).toMatchObject({ ticketsResolvedByHaley: 0, modelCalls: 0 });
    } finally {
      await app.close();
    }
  });

  it("does not credit recipes whose failed actions were attempted before the billing period", async () => {
    const { app, store } = await makeApp();
    try {
      const org = store.createOrg({ name: "Long recipe" });
      const template = TASK_TEMPLATES.find((t) => (t.estimatedMinutes ?? 0) > 0)!;
      const run = store.createRun({ orgId: org.id, kind: "task", title: "Recipe", instruction: "Check", createdBy: "Jordan", templateId: template.id });
      store.saveRunProgress(run.id, { status: "completed" });
      store.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run("2026-10-01T01:00:00.000Z", run.id);
      const action = store.createAction({
        orgId: org.id, runId: run.id, toolUseId: "failed", tool: "test", input: {}, risk: "write",
        description: "Failed change", rationale: "Check", status: "failed",
      });
      store.db.prepare("UPDATE actions SET created_at = ? WHERE id = ?").run("2026-09-30T23:00:00.000Z", action.id);
      const row = usageReport(store, FROM, new Date("2026-10-02T00:00:00.000Z")).clients[0];
      expect(row.recipeRuns).toBe(0);
      expect(row.hoursSaved).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("counts changes in the period they executed rather than the period they were proposed", async () => {
    const { app, store } = await makeApp();
    try {
      const org = store.createOrg({ name: "Delayed change" });
      const run = store.createRun({ orgId: org.id, kind: "task", title: "Change", instruction: "Check", createdBy: "Jordan" });
      const action = store.createAction({
        orgId: org.id, runId: run.id, toolUseId: "delayed", tool: "test", input: {}, risk: "write",
        description: "Change", rationale: "Check", status: "executed",
      });
      store.db.prepare("UPDATE actions SET created_at = ?, executed_at = ? WHERE id = ?")
        .run("2026-09-30T23:00:00.000Z", "2026-10-01T01:00:00.000Z", action.id);
      expect(usageReport(store, FROM, TO).clients[0].automaticChanges).toBe(1);
      expect(usageReport(store, new Date("2026-09-01T00:00:00.000Z"), FROM).clients[0].automaticChanges).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("prefers an exactly priced model snapshot over its general model alias", () => {
    const profiles: Pick<ModelProfile, "provider" | "model" | "options">[] = [
      { provider: "openai", model: "gpt-4o", options: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 } },
      { provider: "openai", model: "gpt-4o-2024-08-06", options: { inputUsdPerMTok: 3, outputUsdPerMTok: 4 } },
    ];
    expect(priceFor(profiles, "openai/gpt-4o-2024-08-06")).toEqual({ input: 3, output: 4 });
  });
});
