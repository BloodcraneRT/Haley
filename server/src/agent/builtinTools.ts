import { z } from "zod";
import { defineTool, type HaleyTool } from "../connectors/types.js";
import type { ReplyDelivery } from "../channels/types.js";
import type { Store } from "../store.js";
import type { Run } from "../types.js";
import { TICKET_PRIORITIES } from "../types.js";

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

export function builtinTools(store: Store, run: Run, delivery: ReplyDelivery | null = null): HaleyTool[] {
  return [...(run.ticket_id ? ticketTools(store, run, run.ticket_id, delivery) : []), ...knowledgeTools(store, run)];
}
