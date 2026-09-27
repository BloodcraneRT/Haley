import { z } from "zod";
import type { HaleyConfig } from "../config.js";
import { SensitiveResult, type Connector, type HaleyTool, type ToolContext } from "../connectors/types.js";
import type { PendingState, Store } from "../store.js";
import type { ReplyDelivery } from "../channels/types.js";
import { ASSURANCE_RANK, type Action, type Org, type Run, type RunMode } from "../types.js";
import { builtinTools } from "./builtinTools.js";
import { describeLlmError, type LlmClient, type Message, type MessageParam, type ToolParam } from "./llm.js";
import { decide, targetsOf, type Requester } from "./policy.js";
import { orgContext, SYSTEM_PROMPT, ticketContext } from "./prompts.js";

const AGENT = "haley";

const PLAN_MODE_TEXT = `PLAN MODE (dry run): nothing you do in this run takes effect. Tools that would change anything (customer systems, the ticket, replies, the knowledge base) are simulated and tell you what would happen, including whether the live policy would run the step automatically or need approval. Investigate normally with read tools, then finish with the exact plan: each step, the tool and inputs you would use, and what the requester would be told.`;
const MAX_RESULT_CHARS = 40_000;

type ToolResult = { content: string; is_error: boolean };
type ToolResultBlock = Extract<Exclude<MessageParam["content"], string>[number], { type: "tool_result" }>;

export class RunConflictError extends Error {}

export function toApiTool(tool: HaleyTool): ToolParam {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { ...schema, type: "object" } as ToolParam["input_schema"],
  };
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${text.length - MAX_RESULT_CHARS} chars]` : text;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Drives Haley's tool-use loop. Each run's conversation is persisted after every model turn,
 * so a run can pause for technician approval and resume later, even from another request.
 * The history is append-only: assistant turns are stored exactly as returned.
 */
export class AgentService {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly llm: LlmClient,
    private readonly config: Pick<HaleyConfig, "maxAgentIterations">,
    private readonly connectorsFor: (orgId: string) => Connector[],
    private readonly delivery: ReplyDelivery | null = null,
  ) {}

  // --------------------------------------------------------------- start

  startTicketRun(ticketId: string, createdBy: string, mode: RunMode = "live", followUp?: string): Run {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) throw new Error(`No ticket ${ticketId}`);
    const active = this.activeRun(ticketId);
    if (active) throw new RunConflictError(`Haley is already working this ticket (run ${active.id}).`);
    const org = this.requireOrg(ticket.org_id);
    this.assertNotPaused(org);
    const prior = this.store.listRuns({ ticketId }).length;
    // This run sees the full history, so any queued follow-up is covered by it.
    if (mode === "live") this.store.setNeedsFollowup(ticketId, false);
    const run = this.store.createRun({
      orgId: org.id,
      ticketId,
      kind: "ticket",
      mode,
      title: `#${ticket.number} ${ticket.title}`,
      instruction: followUp
        ? `Scheduled follow-up: ${followUp}`
        : mode === "plan"
          ? "Plan this ticket (dry run)."
          : prior
            ? "Follow-up pass on this ticket."
            : "Work this ticket.",
      createdBy,
    });
    const intro = `${this.header(org)}\n\n${ticketContext(ticket, this.store.listTicketEvents(ticketId))}\n\n${
      followUp
        ? `This is a follow-up you scheduled earlier on this ticket. Do this now: ${followUp}${mode === "plan" ? `\n\n${PLAN_MODE_TEXT}` : ""}`
        : mode === "plan"
          ? PLAN_MODE_TEXT
        : prior
          ? "You have worked this ticket before; the history above shows what happened since. Continue from where things stand."
          : "Work this ticket."
    }`;
    this.store.saveRunProgress(run.id, { messages: [{ role: "user", content: intro }] });
    this.store.audit({ orgId: org.id, actor: createdBy, action: "run.started", target: run.id, detail: { ticketId } });
    this.kick(run.id, () => this.loop(run.id));
    return this.store.getRun(run.id)!;
  }

  startTaskRun(orgId: string, title: string, instruction: string, createdBy: string, mode: RunMode = "live"): Run {
    const org = this.requireOrg(orgId);
    this.assertNotPaused(org);
    const run = this.store.createRun({ orgId, kind: "task", mode, title, instruction, createdBy });
    const intro = `${this.header(org)}\n\n<task requested_by="${createdBy}">\n${instruction}\n</task>${mode === "plan" ? `\n\n${PLAN_MODE_TEXT}` : ""}`;
    this.store.saveRunProgress(run.id, { messages: [{ role: "user", content: intro }] });
    this.store.audit({ orgId, actor: createdBy, action: "run.started", target: run.id, detail: { title } });
    this.kick(run.id, () => this.loop(run.id));
    return this.store.getRun(run.id)!;
  }

  private assertNotPaused(org: Org) {
    if (org.settings.paused) throw new RunConflictError(`Haley is paused for ${org.name}. Resume her on the client's page.`);
  }

  activeRun(ticketId: string): Run | undefined {
    return this.store.listRuns({ ticketId }).find((r) => ["queued", "running", "awaiting_approval"].includes(r.status));
  }

  // ------------------------------------------------------------ approval

  /** Approve or reject one pending action. The run resumes once none of its actions are pending. */
  async decideAction(actionId: string, approve: boolean, decidedBy: string, note = ""): Promise<Action> {
    const action = this.store.getAction(actionId);
    if (!action) throw new Error(`No action ${actionId}`);
    if (!this.store.claimPendingAction(actionId, decidedBy, note, approve)) {
      throw new RunConflictError(`Action ${actionId} is no longer awaiting approval.`);
    }
    this.store.audit({
      orgId: action.org_id,
      actor: decidedBy,
      action: approve ? "action.approved" : "action.rejected",
      target: actionId,
      detail: { tool: action.tool, description: action.description, note },
    });
    const run = this.store.getRun(action.run_id)!;
    if (run.ticket_id) {
      this.store.addTicketEvent(
        run.ticket_id,
        "action",
        decidedBy,
        `${approve ? "Approved" : "Rejected"}: ${action.description}${note ? ` — ${note}` : ""}`,
        { actionId, decision: approve ? "approved" : "rejected" },
      );
    }
    if (this.store.listActions({ runId: run.id, status: "pending_approval" }).length === 0) {
      this.kick(run.id, () => this.resume(run.id));
    }
    return this.store.getAction(actionId)!;
  }

  /** Resolves when the run's current background work (if any) settles. For tests and graceful shutdown. */
  async settled(runId: string): Promise<void> {
    while (this.inflight.has(runId)) await this.inflight.get(runId);
  }

  /** Fail runs that were mid-flight when the process stopped; they can be restarted from the UI. */
  recoverInterrupted(): void {
    for (const run of this.store.listInterruptedRuns()) {
      this.store.saveRunProgress(run.id, { status: "failed", error: "Interrupted by a server restart. Start Haley again to continue." });
    }
  }

  // ---------------------------------------------------------------- loop

  private kick(runId: string, work: () => Promise<void>) {
    const previous = this.inflight.get(runId) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((err) => this.fail(runId, describeLlmError(err)))
      .finally(() => {
        if (this.inflight.get(runId) === next) this.inflight.delete(runId);
      });
    this.inflight.set(runId, next);
  }

  private header(org: Org): string {
    const integrations = this.store.listIntegrations(org.id);
    return `Today is ${new Date().toISOString().slice(0, 10)}.\n\n${orgContext(org, integrations)}`;
  }

  private requireOrg(orgId: string): Org {
    const org = this.store.getOrg(orgId);
    if (!org) throw new Error(`No organization ${orgId}`);
    return org;
  }

  /** Who the run is acting for. Technician-started tasks and dashboard tickets carry technician authority. */
  private requesterFor(run: Run, org: Org): Requester {
    const ticket = run.ticket_id ? this.store.getTicket(run.ticket_id) : null;
    if (!ticket) return { email: null, assurance: "technician", authorized: true };
    const email = ticket.requester_email.toLowerCase() || null;
    const listed = Boolean(email) && org.settings.authorizedRequesters.some((a) => a.toLowerCase() === email);
    return { email, assurance: ticket.assurance, authorized: ticket.assurance === "technician" || listed };
  }

  private toolsFor(run: Run): Map<string, HaleyTool> {
    const tools = new Map<string, HaleyTool>();
    for (const tool of builtinTools(this.store, run, this.delivery)) tools.set(tool.name, tool);
    for (const connector of this.connectorsFor(run.org_id)) {
      for (const tool of connector.tools) tools.set(tool.name, tool);
    }
    return tools;
  }

  private async resume(runId: string): Promise<void> {
    const pending = this.store.getRunPending(runId);
    if (!pending) return;
    const run = this.store.getRun(runId)!;
    const tools = this.toolsFor(run);
    const actions = new Map(this.store.listActions({ runId }).map((a) => [a.tool_use_id, a]));
    const blocks: ToolResultBlock[] = [];
    for (const toolUseId of pending.order) {
      let result = pending.results[toolUseId];
      if (!result) {
        const action = actions.get(toolUseId);
        const tool = action && tools.get(action.tool);
        if (!action || !tool) {
          result = { content: "This tool is no longer available (the integration may have been removed).", is_error: true };
        } else if (action.status === "approved") {
          result = await this.execute(run, action, tool, action.input);
        } else {
          result = {
            content: `A technician (${action.decided_by}) rejected this action.${action.decision_note ? ` Their note: ${action.decision_note}` : ""}`,
            is_error: true,
          };
        }
      }
      blocks.push({ type: "tool_result", tool_use_id: toolUseId, content: result.content, is_error: result.is_error });
    }
    const messages = this.store.getRunMessages<MessageParam>(runId);
    messages.push({ role: "user", content: blocks });
    this.store.saveRunProgress(runId, { messages, pending: null, status: "running" });
    await this.loop(runId);
  }

  private async loop(runId: string): Promise<void> {
    let run = this.store.getRun(runId)!;
    const org = this.requireOrg(run.org_id);
    const tools = this.toolsFor(run);
    const apiTools = [...tools.values()].map(toApiTool);
    const messages = this.store.getRunMessages<MessageParam>(runId);

    this.store.saveRunProgress(runId, { status: "running" });
    if (run.ticket_id && run.mode === "live") {
      const ticket = this.store.getTicket(run.ticket_id);
      if (ticket && ["new", "awaiting_approval"].includes(ticket.status)) {
        this.store.setTicketStatus(ticket.id, "in_progress", AGENT);
      }
    }

    for (;;) {
      run = this.store.getRun(runId)!;
      if (this.requireOrg(run.org_id).settings.paused) {
        return this.fail(runId, "Haley was paused for this client, so she stopped before doing anything else.");
      }
      if (run.iterations >= this.config.maxAgentIterations) {
        return this.fail(runId, `Stopped after ${run.iterations} model turns without finishing. A technician should review.`);
      }

      const response: Message = await this.llm.create({ system: SYSTEM_PROMPT, messages, tools: apiTools });
      messages.push({ role: "assistant", content: response.content } as MessageParam);
      this.store.saveRunProgress(runId, {
        messages,
        addIterations: 1,
        addInputTokens:
          (response.usage?.input_tokens ?? 0) +
          (response.usage?.cache_read_input_tokens ?? 0) +
          (response.usage?.cache_creation_input_tokens ?? 0),
        addOutputTokens: response.usage?.output_tokens ?? 0,
      });

      const text = response.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      switch (response.stop_reason) {
        case "refusal":
          return this.fail(runId, "The model declined to continue this request. A technician needs to handle it.", true);
        case "pause_turn":
          continue;
        case "max_tokens":
        case "model_context_window_exceeded":
          return this.fail(runId, `The model ran out of room (${response.stop_reason}). A technician should review.`, true);
        case "tool_use": {
          const paused = await this.handleToolUse(run, org, tools, response, text, messages);
          if (paused) return;
          continue;
        }
        default:
          return this.complete(runId, text);
      }
    }
  }

  /** Executes or queues each tool call. Returns true when the run paused for approval. */
  private async handleToolUse(
    run: Run,
    org: Org,
    tools: Map<string, HaleyTool>,
    response: Message,
    rationale: string,
    messages: MessageParam[],
  ): Promise<boolean> {
    const calls = response.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
    const pending: PendingState = { order: calls.map((c) => c.id), results: {} };
    let awaiting = 0;

    for (const call of calls) {
      const tool = tools.get(call.name);
      if (!tool) {
        pending.results[call.id] = { content: `Unknown tool ${call.name}.`, is_error: true };
        continue;
      }
      const parsed = tool.input.safeParse(call.input);
      if (!parsed.success) {
        pending.results[call.id] = { content: `Invalid input: ${z.prettifyError(parsed.error)}`, is_error: true };
        continue;
      }
      const targets = targetsOf(parsed.data);
      const protectedList = org.settings.protectedAccounts.map((a) => a.toLowerCase());
      const requester = this.requesterFor(run, org);
      const decision = decide({
        autonomy: org.autonomy,
        risk: tool.risk,
        grantsAccess: Boolean(tool.grantsAccess),
        requester,
        targets,
        protectedTargets: targets.filter((t) => protectedList.includes(t)),
        changesLastHour: this.store.countAgentChangesSince(org.id, new Date(Date.now() - 3_600_000).toISOString()),
        maxChangesPerHour: org.settings.maxAutoChangesPerHour,
        selfServiceToday: requester.email
          ? this.store.countSelfServiceSince(org.id, requester.email, new Date(Date.now() - 86_400_000).toISOString())
          : 0,
        maxSelfServicePerDay: org.settings.maxSelfServicePerUserPerDay,
      });
      const description = tool.describe?.(parsed.data) ?? tool.name;

      if (run.mode === "plan" && tool.risk !== "read") {
        const live =
          decision.outcome === "run"
            ? "would run automatically"
            : decision.outcome === "approve"
              ? `would wait for technician approval (${decision.reason})`
              : `would be blocked (${decision.reason})`;
        const planned = this.store.createAction({
          runId: run.id,
          orgId: run.org_id,
          toolUseId: call.id,
          tool: tool.name,
          input: parsed.data,
          risk: tool.risk,
          description,
          rationale,
          status: "planned",
          policyReason: decision.reason,
        });
        this.store.finishAction(planned.id, { status: "planned", result: { planned: true, live: decision.outcome } });
        pending.results[call.id] = {
          content: `Plan mode: not executed. In a live run this step ${live}. Assume it succeeds and continue planning.`,
          is_error: false,
        };
        continue;
      }

      const action = this.store.createAction({
        runId: run.id,
        orgId: run.org_id,
        toolUseId: call.id,
        tool: tool.name,
        input: parsed.data,
        risk: tool.risk,
        description,
        rationale,
        status: decision.outcome === "approve" ? "pending_approval" : decision.outcome === "block" ? "blocked" : "approved",
        policyReason: decision.reason,
      });
      if (decision.outcome === "run") {
        pending.results[call.id] = await this.execute(run, action, tool, parsed.data);
      } else if (decision.outcome === "block") {
        pending.results[call.id] = {
          content: `Blocked by policy: ${decision.reason} Recommend this step to a technician instead.`,
          is_error: true,
        };
        this.store.audit({ orgId: run.org_id, actor: AGENT, action: "action.blocked", target: action.id, detail: { tool: tool.name } });
      } else {
        awaiting++;
      }
    }

    if (awaiting > 0) {
      this.store.saveRunProgress(run.id, { pending, status: "awaiting_approval" });
      if (run.ticket_id) {
        this.store.setTicketStatus(run.ticket_id, "awaiting_approval", AGENT);
        this.store.addTicketEvent(
          run.ticket_id,
          "agent_note",
          AGENT,
          `Waiting for technician approval on ${awaiting} action${awaiting > 1 ? "s" : ""}.${rationale ? `\n\n${rationale}` : ""}`,
          { runId: run.id },
        );
        // Chat users would otherwise wait in silence while a technician reviews.
        const ticket = this.store.getTicket(run.ticket_id);
        if (ticket && this.delivery && !["portal", "api"].includes(ticket.channel)) {
          const text = "This needs a quick sign-off from the IT team before I can finish. I'll pick it back up as soon as it's approved.";
          const delivery = await this.delivery.deliverReply(ticket, text);
          this.store.addTicketEvent(ticket.id, "reply", AGENT, text, { auto: true, delivery });
        }
      }
      return true;
    }

    messages.push({
      role: "user",
      content: pending.order.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: pending.results[id].content,
        is_error: pending.results[id].is_error,
      })),
    });
    this.store.saveRunProgress(run.id, { messages });
    return false;
  }

  private async execute(run: Run, action: Action, tool: HaleyTool, input: unknown): Promise<ToolResult> {
    const ctx: ToolContext = { orgId: run.org_id, runId: run.id, ticketId: run.ticket_id };
    const changesCustomer = tool.risk === "write" || tool.risk === "destructive";
    try {
      let output = await tool.run(input, ctx);
      let secrets: Record<string, string> | null = null;
      if (output instanceof SensitiveResult) {
        secrets = output.secrets;
        output = output.visible;
        const note = await this.deliverSecretToRequester(run, action, secrets);
        if (output && typeof output === "object") {
          const visible = { ...(output as Record<string, unknown>) };
          for (const key of Object.keys(secrets)) if (key in visible) visible[key] = note;
          output = visible;
        }
      }
      this.store.finishAction(action.id, { status: "executed", result: output ?? { ok: true }, secrets });
      if (changesCustomer) {
        this.store.audit({ orgId: run.org_id, actor: AGENT, action: "action.executed", target: action.id, detail: { tool: tool.name, input } });
        if (run.ticket_id) {
          this.store.addTicketEvent(run.ticket_id, "action", AGENT, `Done: ${action.description}`, {
            actionId: action.id,
            hasSecrets: Boolean(secrets),
          });
        }
      }
      return { content: truncate(JSON.stringify(output ?? { ok: true })), is_error: false };
    } catch (err) {
      const message = errorMessage(err);
      this.store.finishAction(action.id, { status: "failed", result: { error: message } });
      if (changesCustomer) {
        this.store.audit({ orgId: run.org_id, actor: AGENT, action: "action.failed", target: action.id, detail: { tool: tool.name, error: message } });
        if (run.ticket_id) {
          this.store.addTicketEvent(run.ticket_id, "action", AGENT, `Failed: ${action.description} — ${message}`, { actionId: action.id });
        }
      }
      return { content: `Error: ${message}`, is_error: true };
    }
  }

  /**
   * Self-service: when a verified requester changed their own account, send the credential to them
   * privately on their channel. Otherwise it waits for a technician to reveal and deliver it.
   */
  private async deliverSecretToRequester(run: Run, action: Action, secrets: Record<string, string>): Promise<string> {
    const fallback = "[held for a technician to deliver securely]";
    const ticket = run.ticket_id ? this.store.getTicket(run.ticket_id) : null;
    if (!ticket || !this.delivery || ASSURANCE_RANK[ticket.assurance] < ASSURANCE_RANK.chat) return fallback;
    const targets = targetsOf(action.input);
    const self = ticket.requester_email.toLowerCase();
    if (!self || targets.length === 0 || !targets.every((t) => t === self)) return fallback;
    const result = await this.delivery.deliverSecret(ticket, `Here are your sign-in details for ${self}:`, secrets);
    this.store.addTicketEvent(
      ticket.id,
      "action",
      AGENT,
      result.delivered ? `Sent the sign-in credential privately: ${result.detail}` : `Couldn't send the sign-in credential privately: ${result.detail}`,
      { actionId: action.id, delivery: result },
    );
    this.store.audit({
      orgId: run.org_id,
      actor: AGENT,
      action: result.delivered ? "secret.delivered" : "secret.delivery_failed",
      target: action.id,
      detail: { to: self, channel: ticket.channel, detail: result.detail },
    });
    return result.delivered ? `[sent privately to the requester: ${result.detail}]` : `${fallback} (automatic delivery failed: ${result.detail})`;
  }

  private complete(runId: string, summary: string) {
    const run = this.store.getRun(runId)!;
    this.store.saveRunProgress(runId, { status: "completed", summary });
    if (run.ticket_id && summary) {
      const body = run.mode === "plan" ? `**Plan (dry run, nothing was changed)**\n\n${summary}` : summary;
      this.store.addTicketEvent(run.ticket_id, "agent_note", AGENT, body, { runId, summary: true, plan: run.mode === "plan" });
    }
    this.store.audit({ orgId: run.org_id, actor: AGENT, action: "run.completed", target: runId });
    if (run.mode === "live") this.startFollowupIfNeeded(run.ticket_id);
  }

  /** The requester wrote again while Haley was busy: take another pass with the new messages. */
  private startFollowupIfNeeded(ticketId: string | null) {
    if (!ticketId) return;
    const ticket = this.store.getTicket(ticketId);
    if (!ticket?.needs_followup || ["resolved", "closed", "escalated"].includes(ticket.status)) return;
    queueMicrotask(() => {
      try {
        if (!this.activeRun(ticketId)) this.startTicketRun(ticketId, "follow-up");
      } catch (err) {
        this.store.audit({ actor: AGENT, action: "run.followup_failed", target: ticketId, detail: { error: errorMessage(err) } });
      }
    });
  }

  private fail(runId: string, error: string, escalate = false) {
    const run = this.store.getRun(runId);
    if (!run) return;
    this.store.saveRunProgress(runId, { status: "failed", error, pending: null });
    // Anything still queued for approval can no longer be resumed into this run.
    for (const action of this.store.listActions({ runId, status: "pending_approval" })) {
      this.store.finishAction(action.id, { status: "rejected", decidedBy: "system", decisionNote: "Run ended" });
    }
    if (run.ticket_id && run.mode === "plan") {
      this.store.addTicketEvent(run.ticket_id, "agent_note", AGENT, `Plan run stopped: ${error}`, { runId, error: true });
    } else if (run.ticket_id) {
      this.store.addTicketEvent(run.ticket_id, "agent_note", AGENT, `Haley stopped: ${error}`, { runId, error: true });
      const ticket = this.store.getTicket(run.ticket_id);
      if (escalate || ticket?.status === "awaiting_approval" || ticket?.status === "in_progress") {
        this.store.updateTicket(run.ticket_id, { status: "escalated", assignee: "unassigned" }, AGENT);
        if (ticket && this.delivery && ticket.channel !== "portal" && ticket.channel !== "api") {
          const text = "I've passed this to our IT team so a person can take it from here. They'll follow up with you on this ticket.";
          void this.delivery.deliverReply(ticket, text).then((delivery) => {
            this.store.addTicketEvent(ticket.id, "reply", AGENT, text, { auto: true, delivery });
          });
        }
      }
    }
    this.store.audit({ orgId: run.org_id, actor: AGENT, action: "run.failed", target: runId, detail: { error } });
  }
}
