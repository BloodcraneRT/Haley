import { describe, expect, it } from "vitest";
import { lastToolResults, makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

async function setup(llm: ScriptedLlm, autonomy: "read_only" | "supervised" | "autonomous" = "supervised") {
  const haley = await makeApp(llm);
  const { store } = haley;
  const org = store.createOrg({ name: "Contoso", domain: "contoso.example", autonomy });
  store.createIntegration({ orgId: org.id, provider: "m365", label: "Contoso M365", mode: "sandbox", config: {} });
  const ticket = store.createTicket({
    orgId: org.id,
    title: "Isaiah locked out",
    description: "Isaiah can't sign in",
    requesterName: "Grady Archie",
    requesterEmail: "grady.archie@contoso.example",
  });
  return { ...haley, org, ticket };
}

describe("agent runner", () => {
  it("investigates with read tools, updates the ticket, and posts its summary", async () => {
    const llm = new ScriptedLlm(
      turn(text("Checking the account."), toolUse("m365_get_user", { user: "isaiah.langer@contoso.example" })),
      turn(toolUse("update_ticket", { category: "account-access", priority: "high" }), toolUse("reply_to_requester", { message: "Looking into it." })),
      turn(text("Isaiah's account is enabled; he has no MFA method registered.")),
    );
    const { agent, store, ticket } = await setup(llm);
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);

    expect(store.getRun(run.id)).toMatchObject({ status: "completed", iterations: 3, summary: expect.stringContaining("no MFA") });
    // The model saw its tools and the org/ticket context.
    const first = llm.requests[0];
    expect(first.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["m365_get_user", "reply_to_requester", "search_knowledge_base"]));
    expect(first.messages[0].content).toContain("Isaiah locked out");
    expect(first.messages[0].content).toContain("supervised");
    // Tool results flowed back.
    const [userResult] = lastToolResults(llm.requests[1]);
    expect(JSON.parse(userResult.content).userPrincipalName).toBe("isaiah.langer@contoso.example");

    const t = store.getTicket(ticket.id)!;
    expect(t).toMatchObject({ category: "account-access", priority: "high", status: "in_progress" });
    const kinds = store.listTicketEvents(ticket.id).map((e) => e.kind);
    expect(kinds).toContain("reply");
    expect(kinds[kinds.length - 1]).toBe("agent_note");
    expect(store.listActions({ runId: run.id }).every((a) => a.status === "executed")).toBe(true);
  });

  it("pauses for approval, executes on approve, and never shows the model the password", async () => {
    const llm = new ScriptedLlm(
      turn(text("Resetting the password as requested by his manager."), toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })),
      turn(text("Password reset; technician will deliver the temporary password.")),
    );
    const { agent, store, ticket } = await setup(llm);
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);

    expect(store.getRun(run.id)!.status).toBe("awaiting_approval");
    expect(store.getTicket(ticket.id)!.status).toBe("awaiting_approval");
    const [pending] = store.listActions({ status: "pending_approval" });
    expect(pending).toMatchObject({ tool: "m365_reset_password", risk: "destructive", description: "Reset password for isaiah.langer@contoso.example" });
    expect(pending.rationale).toContain("requested by his manager");
    expect(llm.requests).toHaveLength(1);

    await agent.decideAction(pending.id, true, "Jordan");
    await agent.settled(run.id);

    expect(store.getRun(run.id)!.status).toBe("completed");
    const action = store.getAction(pending.id)!;
    expect(action).toMatchObject({ status: "executed", decided_by: "Jordan", has_secrets: true });
    const secrets = store.revealActionSecrets(pending.id)!;
    expect(secrets.temporaryPassword).toHaveLength(16);

    const [result] = lastToolResults(llm.requests[1]);
    expect(result.is_error).toBe(false);
    expect(result.content).toContain("delivered securely");
    const everythingSentToModel = JSON.stringify(llm.requests);
    expect(everythingSentToModel).not.toContain(secrets.temporaryPassword);
    expect(JSON.stringify(store.getRunMessages(run.id))).not.toContain(secrets.temporaryPassword);
    expect(JSON.stringify(action.result)).not.toContain(secrets.temporaryPassword);
  });

  it("tells the model when a technician rejects an action", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("m365_set_account_enabled", { user: "megan.bowen@contoso.example", enabled: false })),
      turn(text("Understood, leaving the account enabled.")),
    );
    const { agent, store, ticket } = await setup(llm);
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    const [pending] = store.listActions({ status: "pending_approval" });
    await agent.decideAction(pending.id, false, "Jordan", "Wrong user");
    await agent.settled(run.id);

    const [result] = lastToolResults(llm.requests[1]);
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toContain("Jordan");
    expect(result.content).toContain("Wrong user");
    expect(store.getAction(pending.id)!.status).toBe("rejected");
    expect(store.listAudit().map((a) => a.action)).toContain("action.rejected");
    await expect(agent.decideAction(pending.id, true, "Sam")).rejects.toThrow(/no longer awaiting/);
  });

  it("returns results in call order when one call runs and another waits", async () => {
    const llm = new ScriptedLlm(
      turn(
        toolUse("m365_add_group_member", { user: "alex.wilber@contoso.example", group: "Accounts Payable Mailbox" }, "toolu_a"),
        toolUse("m365_list_licenses", {}, "toolu_b"),
        toolUse("m365_get_user", { user: "nobody@contoso.example" }, "toolu_c"),
      ),
      turn(text("Done.")),
    );
    const { agent, store, ticket } = await setup(llm);
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    const [pending] = store.listActions({ status: "pending_approval" });
    expect(pending.tool).toBe("m365_add_group_member");
    await agent.decideAction(pending.id, true, "Jordan");
    await agent.settled(run.id);

    const results = lastToolResults(llm.requests[1]);
    expect(results.map((r) => r.tool_use_id)).toEqual(["toolu_a", "toolu_b", "toolu_c"]);
    expect(results.map((r) => Boolean(r.is_error))).toEqual([false, false, true]);
    expect(results[2].content).toContain("does not exist");
  });

  it("blocks customer changes for read-only organizations", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("m365_assign_license", { user: "megan.bowen@contoso.example", sku: "SPE_E3" })),
      turn(text("Recommend assigning E3.")),
    );
    const { agent, store, ticket } = await setup(llm, "read_only");
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    expect(store.getRun(run.id)!.status).toBe("completed");
    const [result] = lastToolResults(llm.requests[1]);
    expect(result.content).toContain("read-only");
    expect(store.listActions({ runId: run.id })[0].status).toBe("blocked");
  });

  it("runs routine writes immediately for autonomous organizations but still gates destructive ones", async () => {
    const llm = new ScriptedLlm(
      turn(
        toolUse("m365_add_group_member", { user: "alex.wilber@contoso.example", group: "Sales" }),
        toolUse("m365_revoke_sessions", { user: "alex.wilber@contoso.example" }),
      ),
      turn(text("Done.")),
    );
    const { agent, store, ticket } = await setup(llm, "autonomous");
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    const actions = store.listActions({ runId: run.id });
    expect(actions.map((a) => [a.tool, a.status])).toEqual([
      ["m365_add_group_member", "failed"], // Alex is already in Sales in the sandbox
      ["m365_revoke_sessions", "pending_approval"],
    ]);
  });

  it("feeds validation errors back instead of running the tool", async () => {
    const llm = new ScriptedLlm(turn(toolUse("m365_assign_license", { user: "x" })), turn(text("Fixed.")));
    const { agent, store, ticket } = await setup(llm, "autonomous");
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    const [result] = lastToolResults(llm.requests[1]);
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toContain("sku");
    expect(store.listActions({ runId: run.id })).toHaveLength(0);
  });

  it("escalates the ticket when the model declines", async () => {
    const llm = new ScriptedLlm(() => ({ content: [], stop_reason: "refusal" }));
    const { agent, store, ticket } = await setup(llm);
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", error: expect.stringContaining("declined") });
    expect(store.getTicket(ticket.id)!).toMatchObject({ status: "escalated", assignee: "unassigned" });
  });

  it("fails the run cleanly when the model call errors, and allows a fresh run", async () => {
    const llm = new ScriptedLlm(() => {
      throw new Error("no credentials");
    }, turn(text("ok")));
    const { agent, store, ticket } = await setup(llm);
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    expect(store.getRun(run.id)!.error).toContain("no credentials");
    const again = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(again.id);
    expect(store.getRun(again.id)!.status).toBe("completed");
    expect(llm.requests[1].messages[0].content).toContain("worked this ticket before");
  });

  it("refuses to start a second concurrent run on the same ticket", async () => {
    const llm = new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })));
    const { agent, ticket } = await setup(llm);
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    expect(() => agent.startTicketRun(ticket.id, "tech")).toThrow(/already working/);
  });

  it("stops at the iteration limit", async () => {
    const loopForever = turn(toolUse("m365_list_licenses", {}));
    const llm = new ScriptedLlm(...Array.from({ length: 40 }, () => loopForever));
    const { agent, store, ticket } = await setup(llm);
    const run = agent.startTicketRun(ticket.id, "tech");
    await agent.settled(run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", iterations: 30 });
  });

  it("runs ad-hoc tasks that write knowledge base articles", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("m365_list_licenses", {})),
      turn(toolUse("save_knowledge_article", { title: "License audit", body: "## Findings\nE3 is fully consumed.", tags: ["audit"] })),
      turn(text("Saved the audit.")),
    );
    const { agent, store, org } = await setup(llm);
    const run = agent.startTaskRun(org.id, "License audit", "Audit licenses", "tech");
    await agent.settled(run.id);
    expect(store.getRun(run.id)!.status).toBe("completed");
    expect(llm.requests[0].tools.map((t) => t.name)).not.toContain("reply_to_requester");
    const [article] = store.searchArticles({ orgId: org.id, query: "license" });
    expect(article).toMatchObject({ title: "License audit", source: "agent", org_id: org.id, run_id: run.id });
  });
});
