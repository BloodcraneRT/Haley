import { z } from "zod";
import type { HaleyConfig } from "../config.js";
import { SensitiveResult, type Connector, type HaleyTool, type ToolContext } from "../connectors/types.js";
import type { PendingState, Store } from "../store.js";
import type { Action, Org, Run } from "../types.js";
import { builtinTools } from "./builtinTools.js";
import { describeLlmError, type LlmClient, type Message, type MessageParam, type ToolParam } from "./llm.js";
import { decide } from "./policy.js";
import { orgContext, SYSTEM_PROMPT, ticketContext } from "./prompts.js";

const AGENT = "haley";
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
  ) {}

  // --------------------------------------------------------------- start

  startTicketRun(ticketId: string, createdBy: string): Run {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) throw new Error(`No ticket ${ticketId}`);
    const active = this.activeRun(ticketId);
    if (active) throw new RunConflictError(`Haley is already working this ticket (run ${active.id}).`);
    const org = this.requireOrg(ticket.org_id);
    const prior = this.store.listRuns({ ticketId }).length;
    const run = this.store.createRun({
      orgId: org.id,
      ticketId,
      kind: "ticket",
      title: `#${ticket.number} ${ticket.title}`,
      instruction: prior ? "Follow-up pass on this ticket." : "Work this ticket.",
      createdBy,
    });
    const intro = `${this.header(org)}\n\n${ticketContext(ticket, this.store.listTicketEvents(ticketId))}\n\n${
      prior
        ? "You have worked this ticket before; the history above shows what happened since. Continue from where things stand."
        : "Work this ticket."
    }`;
    this.store.saveRunProgress(run.id, { messages: [{ role: "user", content: intro }] });
    this.store.audit({ orgId: org.id, actor: createdBy, action: "run.started", target: run.id, detail: { ticketId } });
    this.kick(run.id, () => this.loop(run.id));
    return this.store.getRun(run.id)!;
  }

  startTaskRun(orgId: string, title: string, instruction: string, createdBy: string): Run {
    const org = this.requireOrg(orgId);
    const run = this.store.createRun({ orgId, kind: "task", title, instruction, createdBy });
    const intro = `${this.header(org)}\n\n<task requested_by="${createdBy}">\n${instruction}\n</task>`;
    this.store.saveRunProgress(run.id, { messages: [{ role: "user", content: intro }] });
    this.store.audit({ orgId, actor: createdBy, action: "run.started", target: run.id, detail: { title } });
    this.kick(run.id, () => this.loop(run.id));
    return this.store.getRun(run.id)!;
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

  private toolsFor(run: Run): Map<string, HaleyTool> {
    const tools = new Map<string, HaleyTool>();
    for (const tool of builtinTools(this.store, run)) tools.set(tool.name, tool);
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
    if (run.ticket_id) {
      const ticket = this.store.getTicket(run.ticket_id);
      if (ticket && ["new", "awaiting_approval"].includes(ticket.status)) {
        this.store.setTicketStatus(ticket.id, "in_progress", AGENT);
      }
    }

    for (;;) {
      run = this.store.getRun(runId)!;
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
      const decision = decide(org.autonomy, tool.risk);
      const action = this.store.createAction({
        runId: run.id,
        orgId: run.org_id,
        toolUseId: call.id,
        tool: tool.name,
        input: parsed.data,
        risk: tool.risk,
        description: tool.describe?.(parsed.data) ?? tool.name,
        rationale,
        status: decision === "approve" ? "pending_approval" : decision === "block" ? "blocked" : "approved",
      });
      if (decision === "run") {
        pending.results[call.id] = await this.execute(run, action, tool, parsed.data);
      } else if (decision === "block") {
        pending.results[call.id] = {
          content: `Blocked by policy: ${org.name} is in read-only mode, so changes to customer systems are not allowed. Recommend this step to a technician instead.`,
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

  private complete(runId: string, summary: string) {
    const run = this.store.getRun(runId)!;
    this.store.saveRunProgress(runId, { status: "completed", summary });
    if (run.ticket_id && summary) {
      this.store.addTicketEvent(run.ticket_id, "agent_note", AGENT, summary, { runId, summary: true });
    }
    this.store.audit({ orgId: run.org_id, actor: AGENT, action: "run.completed", target: runId });
  }

  private fail(runId: string, error: string, escalate = false) {
    const run = this.store.getRun(runId);
    if (!run) return;
    this.store.saveRunProgress(runId, { status: "failed", error, pending: null });
    // Anything still queued for approval can no longer be resumed into this run.
    for (const action of this.store.listActions({ runId, status: "pending_approval" })) {
      this.store.finishAction(action.id, { status: "rejected", decidedBy: "system", decisionNote: "Run ended" });
    }
    if (run.ticket_id) {
      this.store.addTicketEvent(run.ticket_id, "agent_note", AGENT, `Haley stopped: ${error}`, { runId, error: true });
      const ticket = this.store.getTicket(run.ticket_id);
      if (escalate || ticket?.status === "awaiting_approval" || ticket?.status === "in_progress") {
        this.store.updateTicket(run.ticket_id, { status: "escalated", assignee: "unassigned" }, AGENT);
      }
    }
    this.store.audit({ orgId: run.org_id, actor: AGENT, action: "run.failed", target: runId, detail: { error } });
  }
}
