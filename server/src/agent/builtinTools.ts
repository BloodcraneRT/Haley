import { z } from "zod";
import { defineTool, type HaleyTool, type Verifier } from "../connectors/types.js";
import type { ReplyDelivery } from "../channels/types.js";
import type { Store } from "../store.js";
import type { Run } from "../types.js";
import { effectiveAssurance, MFA_WINDOW_MS, TICKET_PRIORITIES } from "../types.js";

/** MFA-fatigue protection: pushes per ticket and per person within an hour. */
export const MAX_PUSHES_PER_TICKET_PER_HOUR = 3;
export const MAX_PUSHES_PER_PERSON_PER_HOUR = 5;

function verificationTool(store: Store, run: Run, ticketId: string, verifier: Verifier): HaleyTool {
  return defineTool({
    name: "verify_requester_identity",
    description: `Send an MFA push (${verifier.method}) to the requester's own registered device and wait for them to approve it. Use before a security-sensitive change to their own account when their identity isn't strong enough for it. It always targets the ticket's requester, never anyone else. Tell them to expect the push first. Approval counts as step-up verification for ${MFA_WINDOW_MS / 60_000} minutes.`,
    input: z.object({
      reason: z.string().min(5).max(120).describe("Shown with the push where the method supports it, e.g. 'Password reset for ticket #1042'"),
    }),
    risk: "internal",
    describe: (i) => `MFA push to the requester: ${i.reason}`,
    run: async ({ reason }) => {
      const ticket = store.getTicket(ticketId)!;
      const email = ticket.requester_email.toLowerCase();
      if (!email) throw new Error("This ticket has no requester email to verify.");
      if (effectiveAssurance(ticket) === "mfa") {
        return { outcome: "approved", alreadyVerified: true, detail: `Already verified with ${ticket.mfa_method} at ${ticket.mfa_verified_at}.` };
      }
      if (store.listVerifications({ ticketId }).some((a) => a.outcome === "denied")) {
        throw new Error("The requester already denied a push on this ticket. Don't send another; a technician has to handle it.");
      }
      const since = new Date(Date.now() - 3_600_000).toISOString();
      if (
        store.listVerifications({ ticketId, since }).length >= MAX_PUSHES_PER_TICKET_PER_HOUR ||
        store.listVerifications({ target: email, since }).length >= MAX_PUSHES_PER_PERSON_PER_HOUR
      ) {
        throw new Error("Too many verification pushes recently (MFA fatigue protection). Hand this to a technician.");
      }

      const result = await verifier.verify(email, { reason, ticketNumber: ticket.number });
      store.recordVerification({ orgId: run.org_id, ticketId, method: verifier.method, target: email, outcome: result.outcome, detail: result.detail });
      store.audit({ orgId: run.org_id, actor: AGENT, action: `verification.${result.outcome}`, target: ticketId, detail: { method: verifier.method, user: email, detail: result.detail } });
      store.addTicketEvent(ticketId, "action", AGENT, `${verifier.method} to ${email}: ${result.outcome}. ${result.detail}`.trim(), { runId: run.id, verification: result.outcome });

      if (result.outcome === "approved") {
        store.markMfaVerified(ticketId, verifier.method, new Date().toISOString());
        return { outcome: "approved", detail: result.detail, assurance: "mfa", validForMinutes: MFA_WINDOW_MS / 60_000 };
      }
      if (result.outcome === "denied") {
        // Someone asked for changes to this account and its owner said no: treat as impersonation.
        store.updateTicket(ticketId, { status: "escalated", assignee: "unassigned" }, AGENT);
        store.addTicketEvent(ticketId, "escalation", AGENT, `The requester denied the ${verifier.method}. Possible impersonation: no changes were made.`, { runId: run.id });
        return { outcome: "denied", detail: result.detail, instruction: "Make no changes. The ticket was escalated as possible impersonation; tell the requester a technician will contact them." };
      }
      return { outcome: result.outcome, detail: result.detail, instruction: "Not verified. You may try once more if the requester asks, otherwise hand off." };
    },
  });
}

const AGENT = "haley";
const settableStatuses = ["in_progress", "waiting_on_customer", "escalated", "resolved"] as const;

function knowledgeTools(store: Store, run: Run): HaleyTool[] {
  return [
    defineTool({
      name: "search_knowledge_base",
      description: "Search the MSP knowledge base (this client's articles plus global runbooks). Returns titles, ids and a short excerpt.",
      input: z.object({ query: z.string().min(1) }),
      risk: "read",
      run: async ({ query }) =>
        store.searchArticles({ orgId: run.org_id, query, limit: 8 }).map((a) => ({
          id: a.id,
          title: a.title,
          scope: a.org_id ? "client" : "global",
          tags: a.tags,
          excerpt: a.body.slice(0, 300),
        })),
    }),
    defineTool({
      name: "read_knowledge_article",
      description: "Read a knowledge base article in full.",
      input: z.object({ id: z.string() }),
      risk: "read",
      run: async ({ id }) => {
        const article = store.getArticle(id);
        if (!article || (article.org_id && article.org_id !== run.org_id)) throw new Error(`No article ${id}`);
        return article;
      },
    }),
    defineTool({
      name: "save_knowledge_article",
      description:
        "Create or update (pass id) a Markdown knowledge base article for this client: runbooks, environment documentation, resolutions. Use scope 'global' only for procedures that apply to every client.",
      input: z.object({
        id: z.string().optional().describe("Existing article id to update"),
        title: z.string().min(3),
        body: z.string().min(20).describe("Markdown"),
        tags: z.array(z.string()).default([]),
        scope: z.enum(["client", "global"]).default("client"),
      }),
      risk: "internal",
      describe: (i) => `${i.id ? "Update" : "Create"} KB article "${i.title}"`,
      run: async ({ id, title, body, tags, scope }) => {
        if (id) {
          const existing = store.getArticle(id);
          if (!existing || (existing.org_id && existing.org_id !== run.org_id)) throw new Error(`No article ${id}`);
        }
        const article = store.saveArticle({
          id,
          orgId: scope === "global" ? null : run.org_id,
          title,
          body,
          tags,
          source: "agent",
          runId: run.id,
        });
        return { ok: true, id: article.id, title: article.title };
      },
    }),
  ];
}

function ticketTools(store: Store, run: Run, ticketId: string, delivery_: ReplyDelivery | null): HaleyTool[] {
  return [
    defineTool({
      name: "get_ticket",
      description: "Re-read the current ticket and its full history (use to pick up new comments).",
      input: z.object({}),
      risk: "read",
      run: async () => ({ ticket: store.getTicket(ticketId), history: store.listTicketEvents(ticketId) }),
    }),
    defineTool({
      name: "update_ticket",
      description: "Set the ticket's title, category, priority and/or status.",
      input: z.object({
        title: z.string().min(3).max(120).optional().describe("Short summary, useful when the ticket came from a chat message"),
        category: z
          .string()
          .optional()
          .describe("Short lowercase category, e.g. account-access, licensing, email, onboarding, offboarding, security, hardware, network, software"),
        priority: z.enum(TICKET_PRIORITIES as [string, ...string[]]).optional(),
        status: z.enum(settableStatuses).optional(),
      }),
      risk: "internal",
      describe: (i) => `Update ticket ${Object.entries(i).map(([k, v]) => `${k}=${v}`).join(", ")}`,
      run: async (input) => {
        const t = store.updateTicket(ticketId, input as never, AGENT);
        return { ok: true, status: t?.status, priority: t?.priority, category: t?.category };
      },
    }),
    defineTool({
      name: "add_internal_note",
      description: "Add an internal note to the ticket (visible to technicians only). Use for findings and progress, not for final summaries.",
      input: z.object({ note: z.string().min(1) }),
      risk: "internal",
      run: async ({ note }) => {
        store.addTicketEvent(ticketId, "agent_note", AGENT, note, { runId: run.id });
        return { ok: true };
      },
    }),
    defineTool({
      name: "reply_to_requester",
      description:
        "Reply to the person who opened the ticket. It is delivered on the channel they used (email, Slack, Teams, chat) and recorded on the ticket. Markdown is fine.",
      input: z.object({ message: z.string().min(1) }),
      risk: "internal",
      describe: (i) => `Reply to requester: ${i.message.slice(0, 80)}`,
      run: async ({ message }) => {
        const ticket = store.getTicket(ticketId)!;
        const delivery = delivery_ ? await delivery_.deliverReply(ticket, message) : { delivered: false, detail: "Posted on the ticket." };
        store.addTicketEvent(ticketId, "reply", AGENT, message, { runId: run.id, delivery });
        return { ok: true, delivered: delivery.delivered, detail: delivery.detail };
      },
    }),
    defineTool({
      name: "schedule_follow_up",
      description:
        "Schedule yourself to come back to this ticket later, e.g. to remove temporary access when it expires, check that a fix held, or chase a reply. At that time you'll get the ticket again with this instruction, acting with the same requester's authority.",
      input: z.object({
        runAt: z.iso.datetime({ offset: true }).describe("When to follow up, ISO 8601 with timezone, e.g. 2026-10-03T17:00:00Z"),
        instruction: z.string().min(5).describe("What to do then, specific enough to act on without re-reading everything"),
      }),
      risk: "internal",
      describe: (i) => `Follow up at ${i.runAt}: ${i.instruction.slice(0, 80)}`,
      run: async ({ runAt, instruction }) => {
        const at = Date.parse(runAt);
        if (at <= Date.now()) throw new Error("runAt must be in the future.");
        if (at > Date.now() + 90 * 86_400_000) throw new Error("Follow-ups can be at most 90 days out.");
        const ticket = store.getTicket(ticketId)!;
        const schedule = store.createSchedule({
          orgId: run.org_id,
          ticketId,
          title: `Follow-up on #${ticket.number}`,
          instruction,
          cadence: "once",
          nextRunAt: new Date(at).toISOString(),
          createdBy: AGENT,
        });
        store.addTicketEvent(ticketId, "agent_note", AGENT, `Scheduled a follow-up for ${new Date(at).toISOString()}: ${instruction}`, {
          runId: run.id,
          scheduleId: schedule.id,
        });
        return { ok: true, scheduleId: schedule.id, runAt: schedule.next_run_at };
      },
    }),
    defineTool({
      name: "escalate_to_human",
      description: "Hand the ticket to a human technician with a handoff note (what you checked, what you found, suggested next step).",
      input: z.object({ reason: z.string().min(1), handoffNote: z.string().min(1) }),
      risk: "internal",
      run: async ({ reason, handoffNote }) => {
        store.updateTicket(ticketId, { status: "escalated", assignee: "unassigned" }, AGENT);
        store.addTicketEvent(ticketId, "escalation", AGENT, `${reason}\n\n${handoffNote}`, { runId: run.id });
        store.audit({ orgId: run.org_id, actor: AGENT, action: "ticket.escalated", target: ticketId, detail: { reason } });
        return { ok: true, status: "escalated" };
      },
    }),
  ];
}

export function builtinTools(store: Store, run: Run, delivery: ReplyDelivery | null = null, verifier: Verifier | null = null): HaleyTool[] {
  return [
    ...(run.ticket_id ? ticketTools(store, run, run.ticket_id, delivery) : []),
    ...(run.ticket_id && verifier ? [verificationTool(store, run, run.ticket_id, verifier)] : []),
    ...knowledgeTools(store, run),
  ];
}
