import type { ModelProfile } from "./ai/providers.js";
import { clientReport } from "./report.js";
import type { Store, UsageKind } from "./store.js";

export interface ModelPrice {
  input: number;
  output: number;
}

/** A served id is the profile's model, or it with a date or version suffix ("claude-x-20260101", "gpt-4o-2024-08-06"). */
function sameModel(profileModel: string, served: string): boolean {
  if (served === profileModel) return true;
  return served.startsWith(profileModel) && /^[-@](\d{8}|\d{4}-\d{2}-\d{2}|latest|v\d+(:\d+)?)$/.test(served.slice(profileModel.length));
}

/**
 * Your price for a served model ("provider/model"), from the AI model profile with that model and both
 * prices set. The provider must match too unless no profile does (a gateway can report another provider).
 */
export function priceFor(profiles: Pick<ModelProfile, "provider" | "model" | "options">[], served: string): ModelPrice | null {
  const priced = profiles.filter((p) => typeof p.options?.inputUsdPerMTok === "number" && typeof p.options?.outputUsdPerMTok === "number");
  const slash = served.indexOf("/");
  const provider = served.slice(0, slash);
  const model = served.slice(slash + 1);
  const find = (candidates: typeof priced) => candidates.find((p) => p.model === model) ?? candidates.find((p) => sameModel(p.model, model));
  const match = find(priced.filter((p) => p.provider === provider)) ?? find(priced);
  return match ? { input: match.options.inputUsdPerMTok!, output: match.options.outputUsdPerMTok! } : null;
}

const usd = (n: number) => Math.round(n * 10_000) / 10_000;
const costOf = (price: ModelPrice, input: number, output: number) => (input * price.input + output * price.output) / 1_000_000;

/** AI cost of one run, or null when any of its usage is on a model without a price. */
export function runCost(store: Store, runId: string): { usd: number | null; unpricedModels: string[] } {
  const profiles = store.listModelProfiles();
  let total = 0;
  const unpriced = new Set<string>();
  for (const row of store.runModelUsage(runId)) {
    const price = priceFor(profiles, row.model);
    if (price) total += costOf(price, row.input_tokens, row.output_tokens);
    else unpriced.add(row.model);
  }
  return { usd: unpriced.size ? null : usd(total), unpricedModels: [...unpriced] };
}

/**
 * What each client used in a period and what it's worth: model calls, tokens and AI cost (with the
 * workspace markup for pass-through billing), tickets Haley resolved alone and how many requesters
 * confirmed, and estimated technician hours saved. Built for monthly billing and QBRs.
 */
export function usageReport(store: Store, from: Date, to: Date) {
  const settings = store.getBillingSettings();
  const profiles = store.listModelProfiles();
  const usage = store.modelUsageSummary(from.toISOString(), to.toISOString());
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  const unpriced = new Set<string>();

  const worked = store.ticketsWorkedByOrg(from.toISOString(), to.toISOString());
  const markup = 1 + settings.aiMarkupPercent / 100;
  /** Cost per unit, or null when there are no units or some of the cost is unpriced. */
  const per = (cost: number, unpricedTokens: number, units: number) => (units > 0 && unpricedTokens === 0 ? usd(cost / units) : null);

  const clients = store.listOrgs().map((org) => {
    const rows = usage.filter((u) => u.org_id === org.id);
    const cost: Record<UsageKind, number> = { ticket: 0, task: 0, assist: 0 };
    const unpricedByKind: Record<UsageKind, number> = { ticket: 0, task: 0, assist: 0 };
    for (const row of rows) {
      const price = priceFor(profiles, row.model);
      if (price) cost[row.kind] += costOf(price, row.input_tokens, row.output_tokens);
      else {
        unpriced.add(row.model);
        unpricedByKind[row.kind] += row.input_tokens + row.output_tokens;
      }
    }
    const total = cost.ticket + cost.task + cost.assist;
    const report = clientReport(store, org, { days, minutesPerTicket: settings.minutesPerTicket, minutesPerAction: settings.minutesPerAction, from, to });
    const resolved = report.tickets.resolvedByHaleyAlone;
    const ticketsWorked = worked.get(org.id) ?? 0;
    return {
      orgId: org.id,
      name: org.name,
      modelCalls: rows.reduce((n, r) => n + r.calls, 0),
      inputTokens: rows.reduce((n, r) => n + r.input_tokens, 0),
      outputTokens: rows.reduce((n, r) => n + r.output_tokens, 0),
      /** Tokens on models without a price; the cost below leaves them out. */
      unpricedTokens: unpricedByKind.ticket + unpricedByKind.task + unpricedByKind.assist,
      aiCostUsd: usd(total),
      billableAiUsd: usd(total * markup),
      /** AI cost split by kind of work: ticket runs, task runs (recipes), and the technician copilot. */
      ticketAiCostUsd: usd(cost.ticket),
      taskAiCostUsd: usd(cost.task),
      copilotAiCostUsd: usd(cost.assist),
      /** Unpriced tokens on ticket runs; while there are any, the per-ticket figures are unknown. */
      unpricedTicketTokens: unpricedByKind.ticket,
      ticketsWorked,
      ticketsResolvedByHaley: resolved,
      /**
       * Fully loaded: all AI cost on ticket runs, including tickets Haley escalated, divided by the tickets
       * she resolved alone. The figure to compare with per-ticket pricing.
       */
      aiCostPerResolvedUsd: per(cost.ticket, unpricedByKind.ticket, resolved),
      billablePerResolvedUsd: per(cost.ticket * markup, unpricedByKind.ticket, resolved),
      aiCostPerTicketWorkedUsd: per(cost.ticket, unpricedByKind.ticket, ticketsWorked),
      confirmedByRequester: report.tickets.confirmedByRequester,
      automaticChanges: report.changes.automatic,
      recipeRuns: report.timeSaved.recipeRuns,
      hoursSaved: report.timeSaved.hours,
    };
  });

  const sum = (key: keyof (typeof clients)[number]) => clients.reduce((n, c) => n + (c[key] as number), 0);
  const technicians = store.activeTechnicians(from.toISOString(), to.toISOString());
  const ticketCost = sum("ticketAiCostUsd");
  const unpricedTicketTokens = sum("unpricedTicketTokens");
  return {
    period: { from: from.toISOString(), to: to.toISOString(), days },
    settings,
    clients,
    totals: {
      modelCalls: sum("modelCalls"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      unpricedTokens: sum("unpricedTokens"),
      aiCostUsd: usd(sum("aiCostUsd")),
      billableAiUsd: usd(sum("billableAiUsd")),
      ticketAiCostUsd: usd(ticketCost),
      taskAiCostUsd: usd(sum("taskAiCostUsd")),
      copilotAiCostUsd: usd(sum("copilotAiCostUsd")),
      ticketsWorked: sum("ticketsWorked"),
      ticketsResolvedByHaley: sum("ticketsResolvedByHaley"),
      aiCostPerResolvedUsd: per(ticketCost, unpricedTicketTokens, sum("ticketsResolvedByHaley")),
      billablePerResolvedUsd: per(ticketCost * markup, unpricedTicketTokens, sum("ticketsResolvedByHaley")),
      aiCostPerTicketWorkedUsd: per(ticketCost, unpricedTicketTokens, sum("ticketsWorked")),
      confirmedByRequester: sum("confirmedByRequester"),
      hoursSaved: Math.round(sum("hoursSaved") * 10) / 10,
    },
    unpricedModels: [...unpriced].sort(),
    technicians: {
      names: technicians,
      count: technicians.length,
      note: "Names technicians typed when signing in to the dashboard. They aren't verified accounts, so treat this as an estimate for per-technician pricing.",
    },
  };
}

export type UsageReport = ReturnType<typeof usageReport>;

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  // Leading =, +, - or @ would run as a formula in spreadsheet apps.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Four decimals, or empty when unknown (no resolved tickets, or unpriced usage). */
const money = (n: number | null | undefined) => (n == null ? "" : n.toFixed(4));

/** One row per client, for billing exports. */
export function usageCsv(report: UsageReport): string {
  const header = [
    "client",
    "period_start",
    "period_end",
    "model_calls",
    "input_tokens",
    "output_tokens",
    "unpriced_tokens",
    "ai_cost_usd",
    "billable_ai_usd",
    "ticket_ai_cost_usd",
    "task_ai_cost_usd",
    "copilot_ai_cost_usd",
    "tickets_worked",
    "tickets_resolved_by_haley",
    "ai_cost_per_resolved_usd",
    "billable_per_resolved_usd",
    "ai_cost_per_ticket_worked_usd",
    "confirmed_by_requester",
    "automatic_changes",
    "recipe_runs",
    "hours_saved",
  ];
  const rows = report.clients.map((c) => [
    c.name,
    report.period.from,
    report.period.to,
    c.modelCalls,
    c.inputTokens,
    c.outputTokens,
    c.unpricedTokens,
    c.aiCostUsd.toFixed(4),
    c.billableAiUsd.toFixed(4),
    money(c.ticketAiCostUsd),
    money(c.taskAiCostUsd),
    money(c.copilotAiCostUsd),
    c.ticketsWorked,
    c.ticketsResolvedByHaley,
    money(c.aiCostPerResolvedUsd),
    money(c.billablePerResolvedUsd),
    money(c.aiCostPerTicketWorkedUsd),
    c.confirmedByRequester,
    c.automaticChanges,
    c.recipeRuns,
    c.hoursSaved,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
