import { slaFor } from "./sla.js";
import type { Store } from "./store.js";
import type { Org } from "./types.js";

export interface ReportOptions {
  days: number;
  /** Technician minutes a ticket Haley resolved alone would otherwise have taken. */
  minutesPerTicket: number;
  /** Technician minutes per change Haley made on her own (license, group, reset...). */
  minutesPerAction: number;
}

const count = <T>(items: T[], key: (item: T) => string) => {
  const map = new Map<string, number>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
  return [...map.entries()].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count);
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per-client value report for QBRs: what Haley handled, how fast, against which SLA, and the time it saved.
 * Everything is derived from tickets, actions and the KB, so it reflects what actually happened.
 */
export function clientReport(store: Store, org: Org, options: ReportOptions) {
  const to = new Date();
  const from = new Date(to.getTime() - options.days * 86_400_000);
  const inPeriod = (iso: string | null) => Boolean(iso) && iso! >= from.toISOString() && iso! <= to.toISOString();

  const all = store.listTickets({ orgId: org.id, limit: 100_000 });
  const eventCache = new Map<string, ReturnType<Store["listTicketEvents"]>>();
  const eventsOf = (ticketId: string) => {
    if (!eventCache.has(ticketId)) eventCache.set(ticketId, store.listTicketEvents(ticketId));
    return eventCache.get(ticketId)!;
  };
  const opened = all.filter((t) => inPeriod(t.created_at));
  const resolved = all.filter((t) => inPeriod(t.resolved_at));

  const handledByHaleyAlone = resolved.filter((t) => {
    const events = eventsOf(t.id);
    const escalated = events.some((e) => e.kind === "escalation");
    const technicianTouched = events.some(
      (e) => (e.kind === "comment" || e.kind === "reply") && e.author !== "haley" && !e.meta.channel && !e.meta.auto && e.author !== t.requester_name,
    );
    return !escalated && !technicianTouched;
  });

  const resolutionMinutes = resolved.map((t) => (Date.parse(t.resolved_at!) - Date.parse(t.created_at)) / 60_000);
  const slas = opened.map((t) => slaFor(t, org.settings.sla));
  const settled = (state: string) => state === "met" || state === "breached";
  const responseSettled = slas.filter((s) => settled(s.response));
  const resolutionSettled = slas.filter((s) => settled(s.resolution));
  const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

  const actions = store.listActions({ orgId: org.id, limit: 100_000 }).filter((a) => inPeriod(a.created_at));
  const changes = actions.filter((a) => a.risk === "write" || a.risk === "destructive");
  const executedChanges = changes.filter((a) => a.status === "executed");
  const autoChanges = executedChanges.filter((a) => !a.decided_by);

  const articles = store.searchArticles({ orgId: org.id, limit: 100_000 }).filter((a) => a.org_id === org.id);
  const minutesSaved = handledByHaleyAlone.length * options.minutesPerTicket + autoChanges.length * options.minutesPerAction;

  return {
    org: { id: org.id, name: org.name, autonomy: org.autonomy },
    period: { from: from.toISOString(), to: to.toISOString(), days: options.days },
    tickets: {
      opened: opened.length,
      resolved: resolved.length,
      stillOpen: all.filter((t) => !["resolved", "closed"].includes(t.status)).length,
      resolvedByHaleyAlone: handledByHaleyAlone.length,
      automationRate: pct(handledByHaleyAlone.length, resolved.length),
      escalated: opened.filter((t) => eventsOf(t.id).some((e) => e.kind === "escalation")).length,
      medianResolutionMinutes: median(resolutionMinutes),
      byCategory: count(opened, (t) => t.category),
      byChannel: count(opened, (t) => t.channel),
      byPriority: count(opened, (t) => t.priority),
      topRequesters: count(opened.filter((t) => t.requester_email), (t) => t.requester_email).slice(0, 5),
    },
    sla: {
      responseCompliance: pct(responseSettled.filter((s) => s.response === "met").length, responseSettled.length),
      resolutionCompliance: pct(resolutionSettled.filter((s) => s.resolution === "met").length, resolutionSettled.length),
      responseBreaches: responseSettled.filter((s) => s.response === "breached").length,
      resolutionBreaches: resolutionSettled.filter((s) => s.resolution === "breached").length,
    },
    changes: {
      executed: executedChanges.length,
      automatic: autoChanges.length,
      approvedByTechnician: executedChanges.length - autoChanges.length,
      rejected: changes.filter((a) => a.status === "rejected" && a.decided_by !== "system").length,
      blockedByPolicy: changes.filter((a) => a.status === "blocked").length,
      byTool: count(executedChanges, (a) => a.tool),
    },
    knowledge: {
      articlesWrittenByHaley: articles.filter((a) => a.source === "agent" && inPeriod(a.created_at)).length,
      articlesTotal: articles.length,
    },
    timeSaved: {
      hours: Math.round((minutesSaved / 60) * 10) / 10,
      assumptions: `${options.minutesPerTicket} technician minutes per ticket Haley resolved without a technician, plus ${options.minutesPerAction} per change she made automatically.`,
    },
  };
}

export type ClientReport = ReturnType<typeof clientReport>;
