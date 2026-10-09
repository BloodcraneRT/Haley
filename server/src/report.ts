import { TASK_TEMPLATES } from "./agent/templates.js";
import { slaFor } from "./sla.js";
import type { Store } from "./store.js";
import type { Org } from "./types.js";

export interface ReportOptions {
  days: number;
  /** Technician minutes a ticket Haley resolved alone would otherwise have taken. */
  minutesPerTicket: number;
  /** Technician minutes per change Haley made on her own (license, group, reset...). */
  minutesPerAction: number;
  /** Exclusive end of a supplied period; otherwise the report includes activity through now. */
  to?: Date;
  /** Exact inclusive start, when the caller already has a billing period. */
  from?: Date;
}

/** Technician minutes a recipe takes by hand, from the recipe library (0 when unknown). */
export function recipeMinutes(templateId: string | null | undefined): number {
  if (!templateId) return 0;
  const template = TASK_TEMPLATES.find((t) => t.id === templateId) as { estimatedMinutes?: number } | undefined;
  return template?.estimatedMinutes ?? 0;
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
  const to = options.to ?? new Date();
  const from = options.from ?? new Date(to.getTime() - options.days * 86_400_000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const inPeriod = (iso: string | null) => Boolean(iso) && iso! >= fromIso && (options.to ? iso! < toIso : iso! <= toIso);

  const all = store.listTickets({ orgId: org.id, limit: 100_000 });
  const activity = store.ticketActivityForReport(org.id);
  const opened = all.filter((t) => inPeriod(t.created_at));
  const resolved = all.filter((t) => inPeriod(t.resolved_at));

  const handledByHaleyAlone = resolved.filter((t) => {
    const flags = activity.get(t.id);
    return flags?.resolvedByHaley && !flags.escalated && !flags.technicianTouched;
  });

  const resolutionMinutes = resolved.map((t) => (Date.parse(t.resolved_at!) - Date.parse(t.created_at)) / 60_000);
  const slas = opened.map((t) => slaFor(t, org.settings.sla));
  const settled = (state: string) => state === "met" || state === "breached";
  const responseSettled = slas.filter((s) => settled(s.response));
  const resolutionSettled = slas.filter((s) => settled(s.resolution));
  const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

  const allActions = store.listActions({ orgId: org.id, limit: 100_000 });
  const actions = allActions.filter((a) => inPeriod(a.created_at));
  const changes = actions.filter((a) => a.risk === "write" || a.risk === "destructive");
  const executedChanges = allActions.filter(
    (a) => (a.risk === "write" || a.risk === "destructive") && a.status === "executed" && inPeriod(a.executed_at ?? a.created_at),
  );
  const autoChanges = executedChanges.filter((a) => !a.decided_by);

  const articles = store.searchArticles({ orgId: org.id, limit: 100_000 }).filter((a) => a.org_id === org.id);
  // Recipes count only when a live run finished with every change it attempted done.
  // Check its entire action history: a recipe may span the start of the period.
  const incompleteRuns = new Set(allActions.filter((a) => ["failed", "rejected", "changes_requested", "blocked", "pending_approval"].includes(a.status)).map((a) => a.run_id));
  const recipeRuns = store
    .listRuns({ orgId: org.id, kind: "task", limit: 100_000 })
    .filter((r) => r.template_id && r.mode === "live" && r.status === "completed" && inPeriod(r.updated_at))
    .filter((r) => !incompleteRuns.has(r.id));
  const recipeMinutesSaved = recipeRuns.reduce((sum, r) => sum + recipeMinutes(r.template_id), 0);
  const minutesSaved =
    handledByHaleyAlone.length * options.minutesPerTicket + autoChanges.length * options.minutesPerAction + recipeMinutesSaved;
  const confirmed = handledByHaleyAlone.filter((t) => t.resolution_confirmed_at);

  return {
    org: { id: org.id, name: org.name, autonomy: org.autonomy },
    period: { from: from.toISOString(), to: to.toISOString(), days: options.days },
    tickets: {
      opened: opened.length,
      resolved: resolved.length,
      stillOpen: all.filter((t) => !["resolved", "closed"].includes(t.status)).length,
      resolvedByHaleyAlone: handledByHaleyAlone.length,
      automationRate: pct(handledByHaleyAlone.length, resolved.length),
      /** Of the tickets Haley resolved alone, how many the requester confirmed were fixed. */
      confirmedByRequester: confirmed.length,
      confirmationRate: pct(confirmed.length, handledByHaleyAlone.length),
      escalated: opened.filter((t) => activity.get(t.id)?.escalated).length,
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
      rejected: changes.filter((a) => (a.status === "rejected" || a.status === "changes_requested") && a.decided_by !== "system").length,
      blockedByPolicy: changes.filter((a) => a.status === "blocked").length,
      byTool: count(executedChanges, (a) => a.tool),
    },
    knowledge: {
      articlesWrittenByHaley: articles.filter((a) => a.source === "agent" && inPeriod(a.created_at)).length,
      articlesTotal: articles.length,
    },
    timeSaved: {
      hours: Math.round((minutesSaved / 60) * 10) / 10,
      recipeRuns: recipeRuns.length,
      assumptions: `${options.minutesPerTicket} technician minutes per ticket Haley resolved without a technician, plus ${options.minutesPerAction} per change she made automatically${
        recipeRuns.length ? `, plus each completed recipe's hands-on estimate (${recipeRuns.length} run${recipeRuns.length === 1 ? "" : "s"})` : ""
      }.`,
    },
  };
}

export type ClientReport = ReturnType<typeof clientReport>;
