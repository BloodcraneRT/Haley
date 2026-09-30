import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentService } from "../src/agent/runner.js";
import { ChannelHub } from "../src/channels/hub.js";
import type { ReplyDelivery } from "../src/channels/types.js";
import { defineTool, type HaleyTool } from "../src/connectors/types.js";
import { m365Tools } from "../src/connectors/m365/tools.js";
import { SandboxM365Api } from "../src/connectors/sandbox/m365.js";
import { SandboxGoogleApi, type GoogleSandboxState } from "../src/connectors/sandbox/google.js";
import { googleTools } from "../src/connectors/google/tools.js";
import type { PolicyRule } from "../src/types.js";
import { makeApp, ScriptedLlm, text, toolUse, turn, firstUserText, lastToolResults } from "./helpers.js";

describe("agent safety at asynchronous boundaries", () => {
  it("stops a tool batch returned after the client was paused", async () => {
    let pause = () => {};
    const llm = new ScriptedLlm(() => {
      pause();
      return { content: [toolUse("m365_create_user", { displayName: "New User", userPrincipalName: "new@contoso.example" })] };
    });
    const { app, store, agent } = await makeApp(llm);
    const org = store.createOrg({ name: "Contoso", domain: "contoso.example", autonomy: "autonomous" });
    store.createIntegration({ orgId: org.id, provider: "m365", label: "test", mode: "sandbox", config: {} });
    pause = () => void store.updateOrg(org.id, { settings: { paused: true } });
    const run = agent.startTaskRun(org.id, "Create user", "Create a new user", "tech");
    await agent.settled(run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/paused/i) });
    expect(store.listActions({ runId: run.id }).some((a) => a.status === "executed")).toBe(false);
    await app.close();
  });

  it("does not execute an approved action while the client is paused", async () => {
    const llm = new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "megan.bowen@contoso.example" })), turn(text("Done")));
    const { app, store, agent } = await makeApp(llm);
    const org = store.createOrg({ name: "Contoso", domain: "contoso.example" });
    store.createIntegration({ orgId: org.id, provider: "m365", label: "test", mode: "sandbox", config: {} });
    const ticket = store.createTicket({ orgId: org.id, title: "Reset password" });
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    const action = store.listActions({ runId: run.id })[0];
    store.updateOrg(org.id, { settings: { paused: true } });
    await agent.decideAction(action.id, true, "tech");
    await agent.settled(run.id);
    expect(store.getAction(action.id)).toMatchObject({ has_secrets: false });
    expect(store.getAction(action.id)!.status).not.toBe("executed");
    expect(store.getRun(run.id)!.status).toBe("failed");
    await app.close();
  });

  it.each(["read_only", "deny", "verification_denied", "approver_changed"] as const)("revokes an approval after %s becomes the current policy", async (change) => {
    const llm = new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "megan.bowen@contoso.example" })), turn(text("Stopped")));
    const { app, store, agent } = await makeApp(llm);
    const org = store.createOrg({ name: "Contoso", domain: "contoso.example" });
    store.createIntegration({ orgId: org.id, provider: "m365", label: "test", mode: "sandbox", config: {} });
    const ticket = store.createTicket({ orgId: org.id, title: "Reset password" });
    const run = agent.startTicketRun(ticket.id, "tech"); await agent.settled(run.id);
    const action = store.listActions({ runId: run.id })[0];
    if (change === "read_only") store.updateOrg(org.id, { autonomy: "read_only" });
    if (change === "deny" || change === "approver_changed") {
      const rule: PolicyRule = { id: "rule", name: "Changed policy", enabled: true, tools: ["m365_reset_password"], risks: [], targets: [], departments: [], requesters: [], effect: change === "deny" ? "deny" : "approve", approvers: change === "approver_changed" ? ["Account manager"] : [], minAssurance: "directory" };
      store.updateOrg(org.id, { settings: { policyRules: [rule] } });
    }
    if (change === "verification_denied") store.recordVerification({ orgId: org.id, ticketId: ticket.id, method: "SMS", target: "megan.bowen@contoso.example", outcome: "denied", detail: "Owner denied" });
    await agent.decideAction(action.id, true, "tech"); await agent.settled(run.id);
    expect(store.getAction(action.id)).toMatchObject({ status: "blocked", has_secrets: false });
    expect(JSON.stringify(store.getAction(action.id)!.result)).toMatch(/policy|verification|approv|read.only/i);
    await app.close();
  });

  it.each(["autonomy", "protected", "requester"] as const)("uses current %s policy after target and guard lookups", async (change) => {
    const llm = new ScriptedLlm(turn(toolUse("change_account", { user: "other@contoso.example" })), turn(text("Done")));
    const { app, store } = await makeApp();
    const org = store.createOrg({ name: "Contoso", autonomy: "unattended", settings: { authorizedRequesters: ["owner@contoso.example"] } });
    const ticket = store.createTicket({ orgId: org.id, title: "Change account", requesterEmail: "owner@contoso.example", assurance: "directory" });
    let executed = false;
    const changePolicy = () => {
      if (change === "autonomy") store.updateOrg(org.id, { autonomy: "read_only" });
      if (change === "protected") store.updateOrg(org.id, { settings: { protectedAccounts: ["other@contoso.example"] } });
      if (change === "requester") store.updateOrg(org.id, { settings: { authorizedRequesters: [] } });
    };
    const tool = defineTool({
      name: "change_account", description: "Change an account", input: z.object({ user: z.string() }), risk: "write",
      resolveTargets: async ({ user }) => { if (change === "protected") changePolicy(); return [user]; },
      guard: async () => { if (change !== "protected") changePolicy(); return null; },
      run: async () => { executed = true; return { ok: true }; },
    });
    const agent = testAgent(store, llm, [tool]);
    const run = agent.startTicketRun(ticket.id, "email");
    await agent.settled(run.id);
    expect(executed).toBe(false);
    expect(store.listActions({ runId: run.id })[0].status).toBe(change === "autonomy" ? "blocked" : "pending_approval");
    await app.close();
  });

  it("checks pause between calls in the same tool batch", async () => {
    const { app, store } = await makeApp();
    const org = store.createOrg({ name: "Contoso", autonomy: "autonomous" });
    let secondExecuted = false;
    const llm = new ScriptedLlm(turn(toolUse("first_step", {}), toolUse("second_step", {})), turn(text("Done")));
    const agent = testAgent(store, llm, [
      defineTool({ name: "first_step", description: "First", input: z.object({}), risk: "read", run: async () => { store.updateOrg(org.id, { settings: { paused: true } }); return {}; } }),
      defineTool({ name: "second_step", description: "Second", input: z.object({}), risk: "write", run: async () => { secondExecuted = true; return {}; } }),
    ]);
    const run = agent.startTaskRun(org.id, "Work", "Do both steps", "tech");
    await agent.settled(run.id);
    expect(secondExecuted).toBe(false);
    expect(store.getRun(run.id)!.status).toBe("failed");
    await app.close();
  });

  it("requires technician review when the admin-group guard lookup fails", async () => {
    const { app, store } = await makeApp();
    const org = store.createOrg({ name: "Contoso", autonomy: "unattended" });
    const api = new SandboxM365Api({ load: () => null, save: () => {} });
    const realListGroups = api.listGroups.bind(api);
    let calls = 0;
    api.listGroups = async () => {
      if (++calls === 1) throw new Error("Temporary directory failure");
      return realListGroups();
    };
    const llm = new ScriptedLlm(turn(toolUse("m365_add_group_member", { user: "megan.bowen@contoso.example", group: "Global Admins (break-glass)" })), turn(text("Waiting")));
    const agent = testAgent(store, llm, m365Tools(api));
    const run = agent.startTaskRun(org.id, "Admin group", "Add Megan to the admin group", "tech"); await agent.settled(run.id);
    expect(store.listActions({ runId: run.id })[0]).toMatchObject({ status: "pending_approval", policy_reason: expect.stringMatching(/safety|guard|check/i) });
    const user = await api.getUser("megan.bowen@contoso.example");
    expect((await api.getUserGroups(user.id)).some((group) => group.displayName.includes("break-glass"))).toBe(false);
    await app.close();
  });

  it("protects accounts addressed by Entra object ID as well as their email", async () => {
    const { app, store } = await makeApp();
    const email = "megan.bowen@contoso.example";
    const org = store.createOrg({ name: "Contoso", autonomy: "unattended", settings: { protectedAccounts: [email] } });
    const api = new SandboxM365Api({ load: () => null, save: () => {} });
    const user = await api.getUser(email);
    const llm = new ScriptedLlm(turn(toolUse("m365_reset_password", { user: user.id })), turn(text("Done")));
    const agent = testAgent(store, llm, m365Tools(api));
    const run = agent.startTaskRun(org.id, "Protected user", "Reset protected user", "tech");
    await agent.settled(run.id);
    expect(store.listActions({ runId: run.id })[0]).toMatchObject({ status: "pending_approval", has_secrets: false, policy_reason: expect.stringContaining("protected") });
    await app.close();
  });

  it("recognizes a verified self-service requester addressed by object ID", async () => {
    const { app, store } = await makeApp();
    const email = "megan.bowen@contoso.example";
    const org = store.createOrg({ name: "Contoso", autonomy: "unattended" });
    const api = new SandboxM365Api({ load: () => null, save: () => {} });
    const user = await api.getUser(email);
    const llm = new ScriptedLlm(turn(toolUse("m365_reset_password", { user: user.id })), turn(text("Done")));
    let delivered = false;
    const agent = testAgent(store, llm, m365Tools(api), {
      deliverReply: async () => ({ delivered: true, detail: "test" }),
      deliverSecret: async () => { delivered = true; return { delivered: true, detail: "private test channel" }; },
    });
    const ticket = store.createTicket({ orgId: org.id, title: "Own reset", requesterEmail: email, assurance: "directory" });
    const run = agent.startTicketRun(ticket.id, "teams");
    await agent.settled(run.id);
    expect(store.listActions({ runId: run.id })[0]).toMatchObject({ status: "executed", has_secrets: true });
    expect(delivered).toBe(true);
    await app.close();
  });

  it("requires review when target resolution fails even if a client rule allows the tool", async () => {
    const { app, store } = await makeApp();
    const org = store.createOrg({ name: "Contoso", autonomy: "autonomous", settings: { policyRules: [{ id: "allow", name: "Allow tool", enabled: true, tools: ["target_change"], risks: [], targets: [], departments: [], requesters: [], effect: "allow", approvers: [], minAssurance: "email" }] } });
    let executed = false;
    const tool = defineTool({ name: "target_change", description: "Change target", input: z.object({ user: z.string() }), risk: "write", resolveTargets: async () => { throw new Error("Directory unavailable"); }, run: async () => { executed = true; return {}; } });
    const llm = new ScriptedLlm(turn(toolUse("target_change", { user: "object-id" })), turn(text("Done")));
    const agent = testAgent(store, llm, [tool]);
    const run = agent.startTaskRun(org.id, "Target", "Change target", "tech");
    await agent.settled(run.id);
    expect(executed).toBe(false);
    expect(store.listActions({ runId: run.id })[0].status).toBe("pending_approval");
    await app.close();
  });

  it("protects Google primary accounts when a tool uses an alias", async () => {
    const { app, store } = await makeApp();
    let state: GoogleSandboxState | null = null;
    const api = new SandboxGoogleApi({ load: () => state, save: (value) => { state = value; } });
    const user = (await api.listUsers())[0];
    const alias = "alternate@acme-health.example";
    state!.users[0].aliases.push(alias);
    const org = store.createOrg({ name: "Acme", autonomy: "unattended", settings: { protectedAccounts: [user.primaryEmail] } });
    const llm = new ScriptedLlm(turn(toolUse("gws_reset_password", { email: alias })), turn(text("Done")));
    const agent = testAgent(store, llm, googleTools(api));
    const run = agent.startTaskRun(org.id, "Protected alias", "Reset protected user", "tech");
    await agent.settled(run.id);
    expect(store.listActions({ runId: run.id })[0]).toMatchObject({ status: "pending_approval", has_secrets: false, policy_reason: expect.stringContaining("protected") });
    await app.close();
  });

  it("requires review when a department rule cannot be checked", async () => {
    const { app, store } = await makeApp();
    const rule: PolicyRule = { id: "finance", name: "Finance needs review", enabled: true, tools: ["target_change"], risks: [], targets: [], departments: ["Finance"], requesters: [], effect: "deny", approvers: [], minAssurance: "email" };
    const org = store.createOrg({ name: "Contoso", autonomy: "autonomous", settings: { policyRules: [rule] } });
    let executed = false;
    const llm = new ScriptedLlm(turn(toolUse("target_change", { user: "someone@example.com" })), turn(text("Done")));
    const agent = testAgent(store, llm, [
      defineTool({ name: "target_change", description: "Change target", input: z.object({ user: z.string() }), risk: "write", run: async () => { executed = true; return {}; } }),
      defineTool({ name: "m365_get_user", description: "Lookup", input: z.object({ user: z.string() }), risk: "read", run: async () => { throw new Error("Directory unavailable"); } }),
    ]);
    const run = agent.startTaskRun(org.id, "Department", "Change target", "tech");
    await agent.settled(run.id);
    expect(executed).toBe(false);
    expect(store.listActions({ runId: run.id })[0].status).toBe("pending_approval");
    await app.close();
  });
});

function testAgent(store: Awaited<ReturnType<typeof makeApp>>["store"], llm: ScriptedLlm, tools: HaleyTool[], delivery: ReplyDelivery | null = null) {
  return new AgentService(store, () => llm, { maxAgentIterations: 30 }, () => [{ integrationId: "test", provider: "test", label: "test", tools, test: async () => "ok" }], delivery);
}

describe("continuation identity", () => {
  it.each(["different_sender", "unverified_owner"] as const)("opens a separate ticket for %s instead of borrowing requester authority", async (variant) => {
    const { app, store } = await makeApp();
    const org = store.createOrg({ name: "Contoso" });
    const ticket = store.createTicket({ orgId: org.id, title: "Original", requesterEmail: "owner@contoso.example", assurance: "email", channel: "email", channelRef: { messageId: "original" } });
    store.markMfaVerified(ticket.id, "SMS", new Date().toISOString());
    const llm = new ScriptedLlm(turn(text("New request")));
    const agent = testAgent(store, llm, []);
    const hub = new ChannelHub(store); hub.attach(agent);
    const result = await hub.receive({
      org, channel: "email", ticketNumber: ticket.number, thread: { key: "messageId", value: "original" }, ref: { messageId: "reply" }, text: "Reset owner password",
      sender: { name: "Sender", email: variant === "different_sender" ? "other@contoso.example" : "owner@contoso.example", assurance: variant === "different_sender" ? "email" : "none", verification: "test" },
    });
    await agent.settled(result.runId!);
    expect(result.created).toBe(true);
    expect(result.ticketId).not.toBe(ticket.id);
    expect(store.listTicketEvents(ticket.id).some((e) => e.body.includes("Reset owner password"))).toBe(false);
    expect(store.getTicket(result.ticketId)!.mfa_verified_at).toBeNull();
    await app.close();
  });

  it("holds an untrusted PSA continuation for technicians and excludes it from later agent context", async () => {
    const { app, store } = await makeApp();
    const org = store.createOrg({ name: "Contoso" });
    const ticket = store.createTicket({ orgId: org.id, title: "Original", requesterEmail: "owner@contoso.example", assurance: "none", channel: "syncro" });
    store.markMfaVerified(ticket.id, "SMS", new Date().toISOString());
    const llm = new ScriptedLlm(turn(toolUse("get_ticket", {})), turn(text("Original request only")));
    const agent = testAgent(store, llm, []);
    const hub = new ChannelHub(store); hub.attach(agent);
    const result = hub.appendToTicket(store.getTicket(ticket.id)!, { channel: "syncro", author: "Requester", email: "owner@contoso.example", assurance: "none", text: "UNTRUSTED PASSWORD RESET" });
    expect(result.runId).toBeNull();
    expect(store.getTicket(ticket.id)!.needs_followup).toBe(false);
    expect(store.listTicketEvents(ticket.id).some((e) => e.body === "UNTRUSTED PASSWORD RESET")).toBe(true);
    const run = agent.startTicketRun(ticket.id, "tech"); await agent.settled(run.id);
    expect(firstUserText(llm.requests[0])).not.toContain("UNTRUSTED PASSWORD RESET");
    expect(lastToolResults(llm.requests[1])[0].content).not.toContain("UNTRUSTED PASSWORD RESET");
    await app.close();
  });

  it("continues a verified owner's stepped-up ticket and attributes its automated reopen to Haley", async () => {
    const { app, store } = await makeApp();
    const org = store.createOrg({ name: "Contoso" });
    const ticket = store.createTicket({ orgId: org.id, title: "Original", requesterEmail: "owner@contoso.example", assurance: "email", channel: "email" });
    store.markMfaVerified(ticket.id, "SMS", new Date().toISOString());
    store.setTicketStatus(ticket.id, "waiting_on_customer", "haley");
    const llm = new ScriptedLlm(turn(text("Continuing")));
    const agent = testAgent(store, llm, []);
    const hub = new ChannelHub(store); hub.attach(agent);
    const result = hub.appendToTicket(store.getTicket(ticket.id)!, { channel: "email", author: "Owner", email: "owner@contoso.example", assurance: "email", text: "Here is the update" });
    expect(result.runId).not.toBeNull(); await agent.settled(result.runId!);
    expect(store.listTicketEvents(ticket.id).find((event) => event.meta.field === "status" && event.meta.from === "waiting_on_customer")).toMatchObject({ author: "haley" });
    expect(store.getTicket(ticket.id)!.mfa_verified_at).not.toBeNull();
    await app.close();
  });
});

describe("agent knowledge base isolation", () => {
  it("restricts ticket writes to client articles while tasks can author global procedures", async () => {
    const { app, store } = await makeApp();
    const org = store.createOrg({ name: "Client A" });
    const global = store.saveArticle({ orgId: null, title: "Global procedure", body: "The original shared procedure." });
    const llm = new ScriptedLlm(
      turn(toolUse("save_knowledge_article", { title: "Unsafe global", body: "An unverified client-controlled shared procedure.", scope: "global" })),
      turn(toolUse("save_knowledge_article", { id: global.id, title: "Overwritten global", body: "An unverified client-controlled shared procedure.", scope: "client" })),
      turn(toolUse("save_knowledge_article", { title: "Client procedure", body: "This procedure belongs to this client only.", scope: "client" })),
      turn(text("Done")),
      turn(toolUse("save_knowledge_article", { title: "Technician global", body: "A technician-requested shared procedure.", scope: "global" })),
      turn(text("Done")),
    );
    const agent = testAgent(store, llm, []);
    const ticket = store.createTicket({ orgId: org.id, title: "Document a procedure", assurance: "none" });
    const run = agent.startTicketRun(ticket.id, "email"); await agent.settled(run.id);
    expect(store.listActions({ runId: run.id }).map((a) => a.status)).toEqual(["failed", "failed", "executed"]);
    expect(store.getArticle(global.id)!.body).toBe("The original shared procedure.");
    expect(store.searchArticles({ orgId: "another-org" }).map((a) => a.title)).toEqual(["Global procedure"]);
    const task = agent.startTaskRun(org.id, "Shared runbook", "Write a shared runbook", "tech"); await agent.settled(task.id);
    expect(store.searchArticles({ orgId: "another-org" }).some((a) => a.title === "Technician global")).toBe(true);
    await app.close();
  });
});
