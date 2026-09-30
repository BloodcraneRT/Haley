import type { ModelProfile } from "./ai/providers.js";
import { clientReport } from "./report.js";
import type { Store } from "./store.js";

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
  const match = priced.find((p) => p.provider === provider && sameModel(p.model, model)) ?? priced.find((p) => sameModel(p.model, model));
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

  const clients = store.listOrgs().map((org) => {
    const rows = usage.filter((u) => u.org_id === org.id);
    let cost = 0;
    let unpricedTokens = 0;
    for (const row of rows) {
      const price = priceFor(profiles, row.model);
      if (price) cost += costOf(price, row.input_tokens, row.output_tokens);
      else {
        unpriced.add(row.model);
        unpricedTokens += row.input_tokens + row.output_tokens;
      }
    }
    const report = clientReport(store, org, { days, minutesPerTicket: settings.minutesPerTicket, minutesPerAction: settings.minutesPerAction, to });
    return {
      orgId: org.id,
      name: org.name,
      modelCalls: rows.reduce((n, r) => n + r.calls, 0),
      inputTokens: rows.reduce((n, r) => n + r.input_tokens, 0),
      outputTokens: rows.reduce((n, r) => n + r.output_tokens, 0),
      /** Tokens on models without a price; the cost below leaves them out. */
      unpricedTokens,
      aiCostUsd: usd(cost),
      billableAiUsd: usd(cost * (1 + settings.aiMarkupPercent / 100)),
      ticketsResolvedByHaley: report.tickets.resolvedByHaleyAlone,
      confirmedByRequester: report.tickets.confirmedByRequester,
      automaticChanges: report.changes.automatic,
      recipeRuns: report.timeSaved.recipeRuns,
      hoursSaved: report.timeSaved.hours,
    };
  });

  const sum = (key: keyof (typeof clients)[number]) => clients.reduce((n, c) => n + (c[key] as number), 0);
  const technicians = store.activeTechnicians(from.toISOString(), to.toISOString());
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
      ticketsResolvedByHaley: sum("ticketsResolvedByHaley"),
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
    "tickets_resolved_by_haley",
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
    c.ticketsResolvedByHaley,
    c.confirmedByRequester,
    c.automaticChanges,
    c.recipeRuns,
    c.hoursSaved,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
