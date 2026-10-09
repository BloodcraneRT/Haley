import { describe, expect, it } from "vitest";
import { editRatio, LESSONS_PER_DAY } from "../src/lessons.js";
import { makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

async function setup(llm: ScriptedLlm) {
  const haley = await makeApp(llm);
  const { store } = haley;
  const org = store.createOrg({ name: "Contoso", domain: "contoso.example", autonomy: "supervised" });
  store.createIntegration({ orgId: org.id, provider: "m365", label: "M365", mode: "sandbox", config: {} });
  const ticket = store.createTicket({ orgId: org.id, title: "Reset Isaiah's password", description: "He's locked out", requesterName: "Grady", requesterEmail: "grady.archie@contoso.example" });
  return { ...haley, org, ticket };
}

/** Haley proposes a password reset, which waits for approval. */
const RESET = turn(toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" }));

async function parkReset(h: Awaited<ReturnType<typeof setup>>) {
  const run = h.agent.startTicketRun(h.ticket.id, "tech");
  await h.agent.settled(run.id);
  return { run, pending: h.store.listActions({ status: "pending_approval" })[0] };
}

describe("edit ratio", () => {
  it("is 0 for the same words and 1 for nothing in common", () => {
    expect(editRatio("Your printer is fixed now.", "your PRINTER is fixed now")).toBe(0);
    expect(editRatio("abc def", "xyz uvw")).toBe(1);
    expect(editRatio("one two three four", "one two five six")).toBe(0.5);
  });
});

describe("lessons from technicians' decisions", () => {
  it("turns a rejection with a reason into a pending client note, on its own", async () => {
    const llm = new ScriptedLlm(RESET, turn(text("Okay, I won't reset it.")), turn(text('{"kind":"note","note":"Password resets at Contoso need the requester\'s manager to confirm first."}')));
    const h = await setup(llm);
    const { pending } = await parkReset(h);
    await h.agent.decideAction(pending.id, false, "Dana Reyes", "Managers must confirm resets for Contoso");
    await h.lessons.idle();

    const lessonPrompt = llm.requests[2].messages[0].parts[0];
    expect(lessonPrompt.type === "text" && lessonPrompt.text).toContain('Dana Reyes rejected Haley\'s proposed change "Reset password for isaiah.langer@contoso.example"');
    const [note] = h.store.listMemories(h.org.id, "pending");
    expect(note).toMatchObject({ source: "lesson", status: "pending", ticket_id: h.ticket.id, content: expect.stringContaining("manager to confirm") });
    // Pending notes aren't used until a technician confirms them.
    expect(h.store.listMemories(h.org.id, "active")).toEqual([]);
    expect(h.store.listAudit().some((a) => a.action === "memory.suggested" && a.actor === "Dana Reyes")).toBe(true);
    expect(h.store.db.prepare("SELECT purpose FROM model_usage WHERE run_id IS NULL").all()).toEqual([{ purpose: "lesson" }]);
  });

  it("doesn't call the model for short notes, system rejections, or tickets without feedback", async () => {
    const llm = new ScriptedLlm(RESET, turn(text("Okay.")));
    const h = await setup(llm);
    const { pending } = await parkReset(h);
    await h.agent.decideAction(pending.id, false, "Dana Reyes", "no");
    await h.lessons.idle();
    expect(llm.requests).toHaveLength(2);
    const other = h.store.createTicket({ orgId: h.org.id, title: "Nothing to learn" });
    expect((await h.app.inject({ method: "POST", url: `/api/tickets/${other.id}/lesson` })).json()).toMatchObject({ kind: "none", reason: expect.stringContaining("No technician feedback") });
  });

  it("suggests a rule on demand that a technician can accept (edited) or dismiss", async () => {
    const rule = { name: "Resets need Dana", tools: ["m365_reset_password"], targets: [], departments: [], requesters: [], effect: "approve", approvers: ["Dana Reyes"], minAssurance: "directory" };
    const llm = new ScriptedLlm(
      RESET,
      turn(text("Understood.")),
      turn(text(`{"kind":"rule","rule":${JSON.stringify(rule)},"why":"Dana asked to approve every reset herself."}`)),
      turn(text(`{"kind":"rule","rule":${JSON.stringify({ ...rule, name: "Second" })},"why":"Again."}`)),
    );
    const h = await setup(llm);
    const { pending } = await parkReset(h);
    await h.app.inject({ method: "POST", url: `/api/actions/${pending.id}/request-changes`, headers: { "x-haley-user": "Dana Reyes" }, payload: { note: "Only I approve resets for this client" } });
    await h.agent.settled(pending.run_id);
    // The automatic check ran after the change request; ask again on demand for a second suggestion.
    await h.lessons.idle();
    const manual = (await h.app.inject({ method: "POST", url: `/api/tickets/${h.ticket.id}/lesson` })).json();
    expect(manual).toMatchObject({ kind: "rule", suggestion: { status: "pending", rule: { name: "Second", effect: "approve" } } });

    const list = (await h.app.inject({ url: `/api/orgs/${h.org.id}/rule-suggestions` })).json();
    expect(list.map((s: { rule: { name: string } }) => s.rule.name)).toEqual(["Second", "Resets need Dana"]);
    const [second, first] = list;

    const accepted = await h.app.inject({ method: "POST", url: `/api/rule-suggestions/${first.id}/accept`, headers: { "x-haley-user": "Sam" }, payload: { rule: { ...first.rule, name: "Resets need Dana (edited)" } } });
    expect(accepted.json().rule).toMatchObject({ name: "Resets need Dana (edited)", id: expect.stringMatching(/^rule_/) });
    expect(h.store.getOrg(h.org.id)!.settings.policyRules.map((r) => r.name)).toEqual(["Resets need Dana (edited)"]);
    expect((await h.app.inject({ method: "POST", url: `/api/rule-suggestions/${first.id}/accept`, payload: {} })).statusCode).toBe(409);
    expect((await h.app.inject({ method: "POST", url: `/api/rule-suggestions/${second.id}/dismiss` })).json()).toEqual({ ok: true });
    expect((await h.app.inject({ url: `/api/orgs/${h.org.id}/rule-suggestions` })).json()).toEqual([]);
    expect(h.store.listAudit().map((a) => a.action)).toEqual(expect.arrayContaining(["rule.suggested", "rule.suggestion_accepted", "rule.suggestion_dismissed"]));
  });

  it("drops rules for tools the client doesn't have, rules matching everything, secret-looking notes and unreadable answers", async () => {
    const bad = (rule: object) => turn(text(`{"kind":"rule","rule":${JSON.stringify({ name: "x", targets: [], departments: [], requesters: [], approvers: [], ...rule })},"why":"x"}`));
    const llm = new ScriptedLlm(
      RESET,
      turn(text("Okay.")),
      bad({ tools: ["fake_wipe_everything"], effect: "allow" }),
      bad({ tools: [], effect: "allow" }),
      turn(text('{"kind":"note","note":"The admin password is: Hunter2-Contoso"}')),
      turn(text("I think they want approvals")),
    );
    const h = await setup(llm);
    const { pending } = await parkReset(h);
    await h.agent.decideAction(pending.id, false, "Dana Reyes", "Not without the manager's OK");
    await h.lessons.idle();
    const ask = async () => (await h.app.inject({ method: "POST", url: `/api/tickets/${h.ticket.id}/lesson` })).json();
    // The automatic check got the unknown tool and suggested nothing; on demand, a rule with no tools is refused.
    expect(h.store.listAudit().some((a) => a.action === "rule.suggested")).toBe(false);
    expect(await ask()).toMatchObject({ kind: "none", reason: "The suggested rule didn't say which changes it applies to." });
    expect(await ask()).toMatchObject({ kind: "none", reason: "The suggested note looked like it contained a secret, so it was dropped." });
    expect(await ask()).toMatchObject({ kind: "none", reason: "Haley's answer couldn't be read." });
    expect(h.store.listRuleSuggestions(h.org.id)).toEqual([]);
    expect(h.store.listMemories(h.org.id)).toEqual([]);
  });

  it("links a sent reply to the copilot draft it came from and learns from heavy edits", async () => {
    const llm = new ScriptedLlm(
      turn(text("Hi Grady, I've reset the password and sent it by email.")),
      turn(text('{"kind":"note","note":"Never send passwords by email at Contoso; technicians share them by phone."}')),
    );
    const h = await setup(llm);
    const draft = (await h.app.inject({ method: "POST", url: `/api/tickets/${h.ticket.id}/assist`, payload: { mode: "draft_reply" } })).json();
    expect(draft.draftId).toMatch(/^draft_/);
    await h.app.inject({
      method: "POST",
      url: `/api/tickets/${h.ticket.id}/comments`,
      headers: { "x-haley-user": "Dana Reyes" },
      payload: { kind: "reply", body: "Grady, I'll call Isaiah with the temporary password shortly.", draftId: draft.draftId },
    });
    const reply = h.store.listTicketEvents(h.ticket.id).find((e) => e.kind === "reply" && e.author === "Dana Reyes")!;
    expect(reply.meta).toMatchObject({ draftId: draft.draftId });
    expect(reply.meta.draftEditRatio as number).toBeGreaterThan(0.3);
    const result = (await h.app.inject({ method: "POST", url: `/api/tickets/${h.ticket.id}/lesson` })).json();
    expect(result).toMatchObject({ kind: "note" });
    const prompt = llm.requests[1].messages[0].parts[0];
    expect(prompt.type === "text" && prompt.text).toContain("Dana Reyes heavily rewrote Haley's draft reply");
  });

  it("stops after the daily limit per client", async () => {
    const llm = new ScriptedLlm(RESET, turn(text("Okay.")));
    const h = await setup(llm);
    const { pending } = await parkReset(h);
    for (let i = 0; i < LESSONS_PER_DAY; i++) h.store.recordModelUsage({ runId: null, orgId: h.org.id, model: "test/scripted", inputTokens: 1, outputTokens: 1, purpose: "lesson" });
    await h.agent.decideAction(pending.id, false, "Dana Reyes", "Managers must confirm resets first");
    await h.lessons.idle();
    expect((await h.app.inject({ method: "POST", url: `/api/tickets/${h.ticket.id}/lesson` })).json()).toMatchObject({ kind: "none", reason: expect.stringContaining("lesson checks today") });
    expect(llm.requests).toHaveLength(2);
  });
});
