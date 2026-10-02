import { describe, expect, it } from "vitest";
import { builtinTools } from "../src/agent/builtinTools.js";
import { RECIPE_CATEGORIES, TASK_TEMPLATES, templateAvailability } from "../src/agent/templates.js";
import { HuduApi, huduTools } from "../src/connectors/hudu/tools.js";
import { ItGlueApi, itGlueTools } from "../src/connectors/itglue/tools.js";
import { NinjaOneApi } from "../src/connectors/ninjaone/api.js";
import { SyncroRmmApi } from "../src/connectors/syncro/api.js";
import { syncroRmmTools } from "../src/connectors/syncro/tools.js";
import { ninjaOneTools } from "../src/connectors/ninjaone/tools.js";
import { buildConnector, PROVIDERS } from "../src/connectors/registry.js";
import type { HaleyTool } from "../src/connectors/types.js";
import { makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

const noFetch = (async () => {
  throw new Error("recipe lint must not call out");
}) as unknown as typeof fetch;

/** Every tool a recipe could name, by provider, built from the real connectors and built-ins. */
async function realTools() {
  const { store } = await makeApp();
  const org = store.createOrg({ name: "Lint Co", domain: "lint.example" });
  const sandbox = (provider: "m365" | "google") => {
    const integration = store.createIntegration({ orgId: org.id, provider, label: `lint ${provider}`, mode: "sandbox", config: {} });
    return buildConnector(store, integration).tools;
  };
  const taskRun = store.createRun({ orgId: org.id, kind: "task", title: "lint", instruction: "lint", createdBy: "test" });
  const ticket = store.createTicket({ orgId: org.id, title: "lint", requesterEmail: "someone@contoso.example" });
  const ticketRun = store.createRun({ orgId: org.id, ticketId: ticket.id, kind: "ticket", title: "lint", instruction: "lint", createdBy: "test" });
  const byProvider: Record<string, HaleyTool[]> = {
    m365: sandbox("m365"),
    google: sandbox("google"),
    ninjaone: ninjaOneTools(new NinjaOneApi({ host: "app.ninjarmm.com", clientId: "c", clientSecret: "s" }, noFetch), 1),
    itglue: itGlueTools(new ItGlueApi({ host: "api.itglue.com", apiKey: "k" }, noFetch), "1"),
    hudu: huduTools(new HuduApi({ baseUrl: "https://docs.example.com", apiKey: "k" }, noFetch), 1),
    syncro_rmm: syncroRmmTools(new SyncroRmmApi({ subdomain: "lint", apiKey: "k" }, noFetch), 1, []),
    builtin: builtinTools(store, taskRun),
  };
  const all = new Map<string, HaleyTool>();
  const providerOf = new Map<string, string>();
  for (const [provider, tools] of Object.entries(byProvider)) {
    for (const tool of tools) {
      all.set(tool.name, tool);
      providerOf.set(tool.name, provider);
    }
  }
  const ticketOnly = new Set(builtinTools(store, ticketRun).map((t) => t.name).filter((name) => !all.has(name)));
  return { all, providerOf, ticketOnly };
}

describe("recipe library", () => {
  it("has well-formed recipes", () => {
    expect(TASK_TEMPLATES.length).toBeGreaterThanOrEqual(25);
    const ids = TASK_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The original templates keep their ids so saved links and run history still resolve.
    for (const id of ["onboard", "offboard", "license-audit", "security-review", "document", "health-check"]) expect(ids).toContain(id);
    const providerIds = new Set(PROVIDERS.map((p) => p.id));
    for (const t of TASK_TEMPLATES) {
      const where = `recipe ${t.id}`;
      expect(t.id, where).toMatch(/^[a-z0-9-]{2,64}$/);
      for (const field of [t.name, t.description, t.instruction]) expect(field.trim().length, where).toBeGreaterThan(0);
      expect(RECIPE_CATEGORIES, where).toContain(t.category);
      expect(Number.isInteger(t.estimatedMinutes) && t.estimatedMinutes >= 1 && t.estimatedMinutes <= 480, `${where}: estimatedMinutes ${t.estimatedMinutes}`).toBe(true);
      expect(t.tools.length, where).toBeGreaterThan(0);
      expect(new Set(t.tools).size, `${where}: duplicate tools`).toBe(t.tools.length);
      expect(t.tags.length, where).toBeGreaterThan(0);
      for (const group of t.requires) {
        expect(group.length, where).toBeGreaterThan(0);
        for (const id of group) expect(providerIds.has(id), `${where}: unknown provider "${id}"`).toBe(true);
      }
    }
    // Every category is used.
    for (const c of RECIPE_CATEGORIES) expect(TASK_TEMPLATES.some((t) => t.category === c), c).toBe(true);
  });

  it("only names tools that exist in a task run, and flags change recipes from the tools' real risk", async () => {
    const { all, providerOf, ticketOnly } = await realTools();
    const problems: string[] = [];
    for (const t of TASK_TEMPLATES) {
      for (const name of t.tools) {
        if (ticketOnly.has(name)) problems.push(`${t.id}: ${name} is only available in ticket runs`);
        else if (!all.has(name)) problems.push(`${t.id}: unknown tool ${name}`);
      }
      const known = t.tools.filter((n) => all.has(n));
      const changeTools = known.filter((n) => ["write", "destructive"].includes(all.get(n)!.risk));
      if (changeTools.length && !t.changes) problems.push(`${t.id}: uses ${changeTools.join(", ")} but changes is false`);
      if (!changeTools.length && t.changes) problems.push(`${t.id}: changes is true but it names no write/destructive tool`);
      // A recipe that needs a provider should use at least one of its tools.
      for (const group of t.requires) {
        if (!known.some((n) => group.includes(providerOf.get(n)!))) problems.push(`${t.id}: requires ${group.join("|")} but names none of its tools`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("change recipes ask for the plan first and never ask for secrets", () => {
    for (const t of TASK_TEMPLATES) {
      if (t.changes) expect(t.instruction, t.id).toMatch(/state the plan/i);
      expect(t.instruction, t.id).not.toMatch(/\b(email|send|tell) (them|the user) (the|their) (password|key|pass)\b/i);
    }
  });

  it("reports missing providers by name", () => {
    const nameOf = (id: string) => PROVIDERS.find((p) => p.id === id)?.name ?? id;
    const reconcile = TASK_TEMPLATES.find((t) => t.id === "docs-reconcile")!;
    expect(templateAvailability(reconcile, ["hudu"], nameOf)).toEqual({ available: false, missing: ["Microsoft 365 or NinjaOne RMM"] });
    expect(templateAvailability(reconcile, ["hudu", "ninjaone"], nameOf)).toEqual({ available: true, missing: [] });
  });
});

describe("GET /api/templates", () => {
  it("marks recipes available per client from its integrations", async () => {
    const { app, store } = await makeApp();
    await app.inject({ method: "POST", url: "/api/demo" });
    const acme = store.listOrgs().find((o) => o.name === "Acme Health Clinic")!;
    const contoso = store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
    expect(store.listIntegrations(acme.id).map((i) => i.provider)).toEqual(["google"]);

    const plain = (await app.inject({ url: "/api/templates" })).json();
    expect(plain).toHaveLength(TASK_TEMPLATES.length);
    expect(plain.every((t: { available: boolean }) => t.available)).toBe(true);

    const forAcme = (await app.inject({ url: `/api/templates?orgId=${acme.id}` })).json() as Array<{ id: string; available: boolean; missing: string[] }>;
    const byId = (list: typeof forAcme, id: string) => list.find((t) => t.id === id)!;
    expect(byId(forAcme, "license-reclaim")).toMatchObject({ available: false, missing: ["Microsoft 365"] });
    expect(byId(forAcme, "ninja-patch-report")).toMatchObject({ available: false, missing: ["NinjaOne RMM"] });
    expect(byId(forAcme, "offboard")).toMatchObject({ available: true, missing: [] });
    expect(byId(forAcme, "find-procedure")).toMatchObject({ available: true, missing: [] });

    const forContoso = (await app.inject({ url: `/api/templates?orgId=${contoso.id}` })).json() as typeof forAcme;
    expect(byId(forContoso, "license-reclaim")).toMatchObject({ available: true, missing: [] });

    // Connecting a sandbox Microsoft 365 tenant makes the Microsoft 365 recipes available.
    const res = await app.inject({ method: "POST", url: `/api/orgs/${acme.id}/integrations`, payload: { provider: "m365", mode: "sandbox" } });
    expect(res.statusCode).toBe(200);
    const after = (await app.inject({ url: `/api/templates?orgId=${acme.id}` })).json() as typeof forAcme;
    expect(byId(after, "license-reclaim")).toMatchObject({ available: true, missing: [] });

    expect((await app.inject({ url: "/api/templates?orgId=nope" })).statusCode).toBe(404);
  });
});

describe("running a recipe", () => {
  it("preserves scheduled recipe attribution on live and plan runs", async () => {
    const { app, store, agent, scheduler } = await makeApp(new ScriptedLlm(turn(text("Plan done.")), turn(text("Audit done."))));
    try {
      await app.inject({ method: "POST", url: "/api/demo" });
      const org = store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
      const recipe = TASK_TEMPLATES.find((t) => t.id === "license-reclaim")!;
      for (const mode of ["plan", "live"] as const) {
        const response = await app.inject({ method: "POST", url: "/api/schedules", payload: {
          orgId: org.id, title: recipe.name, instruction: recipe.instruction, cadence: "monthly", mode,
          startAt: new Date(Date.now() + 300_000).toISOString(), templateId: recipe.id,
        } });
        expect(response.statusCode).toBe(200);
        expect(response.json().template_id).toBe(recipe.id);
        const started = scheduler.runNow(response.json().id).started[0];
        await agent.settled(started.runId);
        expect(store.getRun(started.runId)).toMatchObject({ template_id: recipe.id, mode, status: "completed" });
      }
      const report = (await app.inject({ url: `/api/orgs/${org.id}/report` })).json();
      expect(report.timeSaved.recipeRuns).toBe(1);
      const unknown = await app.inject({ method: "POST", url: "/api/schedules", payload: {
        orgId: org.id, title: "Custom", instruction: "Check", cadence: "once", startAt: new Date().toISOString(), templateId: "unknown",
      } });
      expect(unknown.json().template_id).toBeNull();
    } finally { await app.close(); }
  });

  it("previews a change recipe in plan mode without changing the tenant", async () => {
    const user = "megan.bowen@contoso.example";
    const llm = new ScriptedLlm(
      turn(toolUse("m365_get_user", { user })),
      turn(toolUse("m365_set_account_enabled", { user, enabled: false }), toolUse("m365_revoke_sessions", { user })),
      turn(text("Plan: block sign-in, revoke sessions.")),
    );
    const { app, store, agent } = await makeApp(llm);
    await app.inject({ method: "POST", url: "/api/demo" });
    const contoso = store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
    const recipe = TASK_TEMPLATES.find((t) => t.id === "offboard")!;
    const instruction = recipe.instruction.replace("User:", `User: ${user}`);

    const res = await app.inject({ method: "POST", url: "/api/runs", payload: { orgId: contoso.id, title: recipe.name, instruction, mode: "plan", templateId: recipe.id } });
    expect(res.statusCode).toBe(200);
    const run = res.json();
    expect(run.mode).toBe("plan");
    await agent.settled(run.id);

    const actions = store.listActions({ runId: run.id });
    expect(actions.find((a) => a.tool === "m365_get_user")?.status).toBe("executed");
    const changes = actions.filter((a) => a.tool !== "m365_get_user");
    expect(changes.map((a) => [a.tool, a.status])).toEqual([
      ["m365_set_account_enabled", "planned"],
      ["m365_revoke_sessions", "planned"],
    ]);
    // The account is still enabled in the tenant.
    const integration = store.listIntegrations(contoso.id).find((i) => i.provider === "m365")!;
    const getUser = buildConnector(store, integration).tools.find((t) => t.name === "m365_get_user")!;
    const after = (await getUser.run({ user }, { orgId: contoso.id, runId: run.id, ticketId: null })) as { accountEnabled: boolean };
    expect(after.accountEnabled).toBe(true);
    expect(store.getRun(run.id)?.status).toBe("completed");
  });
});
