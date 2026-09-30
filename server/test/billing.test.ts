import { describe, expect, it } from "vitest";
import { priceFor, usageCsv } from "../src/usage.js";
import { lastToolResults, makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

async function contoso(llm: ScriptedLlm) {
  const haley = await makeApp(llm);
  await haley.app.inject({ method: "POST", url: "/api/demo" });
  const org = haley.store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
  return { ...haley, org };
}

const MEGAN = { email: "megan.bowen@contoso.example", name: "Megan Bowen" };

describe("AI usage and cost", () => {
  it("records every model call and prices it per run and per client with the markup", async () => {
    const llm = new ScriptedLlm(turn(toolUse("search_knowledge_base", { query: "vpn" })), turn(text("Done.")));
    const { app, agent, store, org } = await contoso(llm);
    const run = agent.startTaskRun(org.id, "Check", "Check the VPN docs", "tech");
    await agent.settled(run.id);

    // Two calls at 100 input + 20 output tokens each, on an unpriced model.
    let detail = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
    expect(detail.usage).toMatchObject({ modelCalls: 2, inputTokens: 200, outputTokens: 40, usd: null, unpricedModels: ["test/scripted"] });

    // "test" isn't a real provider, so price the served id through the store (the API validates providers).
    store.createModelProfile({ name: "Scripted", provider: "test", model: "scripted", options: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });
    detail = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
    // 200 × $3/M + 40 × $15/M = $0.0006 + $0.0006
    expect(detail.usage).toMatchObject({ usd: 0.0012, unpricedModels: [] });

    expect((await app.inject({ method: "PATCH", url: "/api/billing/settings", payload: { aiMarkupPercent: 50 } })).json()).toMatchObject({ aiMarkupPercent: 50 });
    const usage = (await app.inject({ method: "GET", url: "/api/usage" })).json();
    const row = usage.clients.find((c: { orgId: string }) => c.orgId === org.id);
    expect(row).toMatchObject({ modelCalls: 2, inputTokens: 200, outputTokens: 40, aiCostUsd: 0.0012, billableAiUsd: 0.0018, unpricedTokens: 0 });
    expect(usage.totals.aiCostUsd).toBe(0.0012);
    expect(usage.clients.find((c: { orgId: string }) => c.orgId !== org.id)).toMatchObject({ modelCalls: 0, aiCostUsd: 0 });
    expect(store.listAudit().some((a) => a.action === "billing.settings_changed")).toBe(true);

    const csv = await app.inject({ method: "GET", url: "/api/usage.csv" });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("attachment");
    expect(csv.body.split("\r\n")[0]).toContain("billable_ai_usd");
    expect(csv.body).toContain("Contoso Ltd");
  });

  it("matches dated model ids by prefix and neutralizes spreadsheet formulas", () => {
    const profiles = [{ provider: "anthropic", model: "claude-x", options: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 } }] as never;
    expect(priceFor(profiles, "anthropic/claude-x-20260101")).toEqual({ input: 1, output: 2 });
    expect(priceFor(profiles, "openai/gpt")).toBeNull();
    // A longer, different model isn't priced as its shorter namesake.
    expect(priceFor(profiles, "anthropic/claude-x-mini")).toBeNull();
    const csv = usageCsv({
      period: { from: "a", to: "b", days: 1 },
      clients: [{ name: '=HYPERLINK("x"),Evil', aiCostUsd: 0, billableAiUsd: 0 }],
    } as never);
    expect(csv).toContain(`"'=HYPERLINK(""x""),Evil"`);
  });

  it("validates billing periods and settings", async () => {
    const { app } = await contoso(new ScriptedLlm());
    expect((await app.inject({ method: "GET", url: "/api/usage?month=2026-13" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/usage?from=2026-02-01&to=2026-01-01" })).statusCode).toBe(400);
    const march = (await app.inject({ method: "GET", url: "/api/usage?month=2026-03" })).json();
    expect(march.period).toMatchObject({ from: "2026-03-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z", days: 31 });
    expect((await app.inject({ method: "PATCH", url: "/api/billing/settings", payload: { aiMarkupPercent: -1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/billing/settings" })).json()).toMatchObject({ aiMarkupPercent: 0, autoCloseResolvedDays: 3 });
  });

  it("counts technicians by dashboard name for per-seat pricing", async () => {
    const { app, org } = await contoso(new ScriptedLlm());
    for (const who of ["Jordan", "Priya", "Jordan"]) {
      await app.inject({ method: "POST", url: `/api/orgs/${org.id}/memories`, headers: { "x-haley-user": who }, payload: { content: `Note from ${who} ${Math.random()}` } });
    }
    const usage = (await app.inject({ method: "GET", url: "/api/usage" })).json();
    expect(usage.technicians.names).toEqual(expect.arrayContaining(["Jordan", "Priya"]));
    expect(usage.technicians.names).not.toContain("haley");
  });
});

describe("resolution confirmation", () => {
  it("asks, then closes as confirmed when the requester replies on the same chat thread", async () => {
    const llm = new ScriptedLlm(
      turn(
        toolUse("update_ticket", { status: "resolved" }),
        toolUse("confirm_resolution", { evidence: "self-confirmed" }),
        toolUse("reply_to_requester", { message: "Fixed! Let me know it's working." }),
      ),
      turn(text("Resolved.")),
      turn(toolUse("confirm_resolution", { evidence: "yes that worked, thanks" })),
      turn(text("Closed.")),
    );
    const { app, agent, store, org } = await contoso(llm);
    const first = (await app.inject({ method: "POST", url: "/api/simulate", payload: { orgId: org.id, ...MEGAN, text: "Outlook keeps asking for my password" } })).json();
    await agent.settled(first.runId);
    // Haley can't confirm on the requester's behalf.
    expect(lastToolResults(llm.requests[1])[1]).toMatchObject({ is_error: true, content: expect.stringContaining("hasn't replied") });
    const resolved = store.getTicket(first.ticketId)!;
    expect(resolved).toMatchObject({ status: "resolved", resolution_confirmed_at: null });

    const reply = (
      await app.inject({ method: "POST", url: "/api/simulate", payload: { orgId: org.id, ...MEGAN, text: "yes that worked, thanks", threadId: first.threadId } })
    ).json();
    expect(reply).toMatchObject({ ticketId: first.ticketId, created: false });
    await agent.settled(reply.runId);
    const closed = store.getTicket(first.ticketId)!;
    expect(closed.status).toBe("closed");
    expect(closed.resolution_confirmed_at).not.toBeNull();
    // SLA and reports keep the time of the fix, not of the confirmation.
    expect(closed.resolved_at).toBe(resolved.resolved_at);

    const report = (await app.inject({ method: "GET", url: `/api/orgs/${org.id}/report` })).json();
    expect(report.tickets).toMatchObject({ confirmedByRequester: 1 });
  });

  it("auto-closes resolved tickets nobody replied to after the configured days", async () => {
    const { scheduler, store, org } = await contoso(new ScriptedLlm());
    const ticket = store.createTicket({ orgId: org.id, title: "Printer", description: "Printer offline", requesterName: "Megan", requesterEmail: MEGAN.email, author: "Megan" });
    store.updateTicket(ticket.id, { status: "resolved", assignee: "haley" }, "haley");
    const tick = (ms: number) => scheduler.tick(ms);

    expect((await tick(Date.now() + 2 * 86_400_000)).closed).not.toContain(ticket.id);
    expect((await tick(Date.now() + 4 * 86_400_000)).closed).toContain(ticket.id);
    const closed = store.getTicket(ticket.id)!;
    expect(closed).toMatchObject({ status: "closed", resolution_confirmed_at: null });
    expect(store.listTicketEvents(ticket.id).at(-1)).toMatchObject({ author: "system", meta: { autoClosed: true } });

    store.setBillingSettings({ autoCloseResolvedDays: 0 });
    const other = store.createTicket({ orgId: org.id, title: "VPN", description: "VPN down", requesterName: "Megan", requesterEmail: MEGAN.email, author: "Megan" });
    store.updateTicket(other.id, { status: "resolved", assignee: "haley" }, "haley");
    expect((await tick(Date.now() + 30 * 86_400_000)).closed).toEqual([]);
  });

  it("credits completed recipe runs with their manual-time estimate", async () => {
    const llm = new ScriptedLlm(turn(text("Audit done.")));
    const { app, agent, org } = await contoso(llm);
    const templates = (await app.inject({ method: "GET", url: `/api/templates?orgId=${org.id}` })).json();
    const list = Array.isArray(templates) ? templates : templates.templates;
    const recipe = list.find((t: { estimatedMinutes?: number }) => (t.estimatedMinutes ?? 0) > 0);
    const res = await app.inject({ method: "POST", url: "/api/runs", payload: { orgId: org.id, title: recipe.name ?? recipe.title, instruction: "Run it", templateId: recipe.id } });
    await agent.settled(res.json().id);
    const report = (await app.inject({ method: "GET", url: `/api/orgs/${org.id}/report` })).json();
    expect(report.timeSaved.recipeRuns).toBe(1);
    expect(report.timeSaved.hours * 60).toBeGreaterThanOrEqual(recipe.estimatedMinutes - 3);

    // An unknown template id is ignored rather than trusted.
    const bogus = await app.inject({ method: "POST", url: "/api/runs", payload: { orgId: org.id, title: "x", instruction: "y", templateId: "not-a-recipe" } });
    expect(bogus.json().template_id).toBeNull();
  });
});
