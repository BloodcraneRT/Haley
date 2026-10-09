import { rankSimilar } from "./similar.js";
import type { Store } from "./store.js";
import type { AssigneeSuggestion, Technician, Ticket, TicketStatus } from "./types.js";

const DAY = 86_400_000;
const SIMILAR_WINDOW_DAYS = 180;
const RECENT_WINDOW_DAYS = 90;
const SIMILAR_LIMIT = 10;
const LOAD_PENALTY = 0.1;
const LOAD_CAP = 3;

export interface Candidate {
  technician: Technician;
  score: number;
  reasons: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Ranks the active directory technicians for a ticket, explainably and without a model call:
 * who resolved similar tickets (0.45), who knows this client (0.30), who knows the category (0.15),
 * minus 0.1 per open ticket they already have (at most 0.3).
 */
export function rankTechnicians(store: Store, ticket: Ticket, nowMs = Date.now()): Candidate[] {
  const technicians = store.listTechnicians({ activeOnly: true });
  if (!technicians.length) return [];
  const byName = new Map(technicians.map((t) => [t.name.toLowerCase(), t]));

  // The person who last resolved or closed each ticket, if they're in the directory.
  const resolver = new Map<string, { name: string; org_id: string; category: string; at: string }>();
  for (const r of store.resolutionsSince(new Date(nowMs - SIMILAR_WINDOW_DAYS * DAY).toISOString())) {
    const tech = byName.get(r.author.toLowerCase());
    if (tech) resolver.set(r.ticket_id, { name: tech.name, org_id: r.org_id, category: r.category, at: r.created_at });
  }

  const resolved = store.listTickets({ orgId: ticket.org_id, limit: 2000 }).filter((t) => resolver.has(t.id));
  const similar = rankSimilar(ticket, resolved, 0.34, SIMILAR_LIMIT).map((s) => resolver.get(s.ticket.id)!.name);
  const recentSince = new Date(nowMs - RECENT_WINDOW_DAYS * DAY).toISOString();
  const recent = [...resolver.values()].filter((r) => r.at >= recentSince);
  const forClient = recent.filter((r) => r.org_id === ticket.org_id);
  const category = ticket.category && ticket.category !== "uncategorized" ? recent.filter((r) => r.category === ticket.category) : [];
  const load = store.openTicketsByAssignee();
  const org = store.getOrg(ticket.org_id);

  return technicians
    .map((technician) => {
      const mine = (list: Array<{ name: string } | string>) => list.filter((r) => (typeof r === "string" ? r : r.name) === technician.name).length;
      const similarCount = mine(similar);
      const clientCount = mine(forClient);
      const categoryCount = mine(category);
      const open = load.get(technician.name.toLowerCase()) ?? 0;
      const score =
        0.45 * (similar.length ? similarCount / similar.length : 0) +
        0.3 * (forClient.length ? clientCount / forClient.length : 0) +
        0.15 * (category.length ? categoryCount / category.length : 0) -
        LOAD_PENALTY * Math.min(open, LOAD_CAP);
      const reasons: string[] = [];
      if (similarCount) reasons.push(`resolved ${plural(similarCount, "similar ticket")}`);
      if (clientCount) reasons.push(`resolved ${plural(clientCount, "ticket")} for ${org?.name ?? "this client"} lately`);
      if (categoryCount && !similarCount) reasons.push(`knows ${ticket.category} tickets`);
      reasons.push(open ? `${open} open now` : "nothing open now");
      return { technician, score: Math.round(score * 1000) / 1000, reasons };
    })
    .sort((a, b) => b.score - a.score || a.technician.name.localeCompare(b.technician.name));
}

/** The best technician for a ticket, or null when the directory is empty. */
export function suggestTechnician(store: Store, ticket: Ticket, nowMs = Date.now()): AssigneeSuggestion | null {
  const [best] = rankTechnicians(store, ticket, nowMs);
  return best ? { name: best.technician.name, reasons: best.reasons, at: new Date(nowMs).toISOString() } : null;
}

const AUTOMATIC = new Set(["haley", "scheduler", "system"]);

/**
 * Store listener: when Haley (or the SLA sweep) escalates a ticket, suggest a technician and, if the
 * workspace says so, assign them. Runs before the escalation notice is posted, so the notice can name them.
 */
export function onEscalated(store: Store, ticket: Ticket, from: TicketStatus, actor: string, nowMs = Date.now()): void {
  if (ticket.status !== "escalated" || from === "escalated" || !AUTOMATIC.has(actor)) return;
  const suggestion = suggestTechnician(store, ticket, nowMs);
  store.setSuggestedAssignee(ticket.id, suggestion);
  if (!suggestion) return;
  if (store.getHelpdeskSettings().autoAssignOnEscalation === "suggested") {
    store.updateTicket(ticket.id, { assignee: suggestion.name }, "haley");
    store.audit({ orgId: ticket.org_id, actor: "haley", action: "ticket.auto_assigned", target: ticket.id, detail: { to: suggestion.name, reasons: suggestion.reasons } });
  }
}
