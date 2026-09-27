import type { ActionStatus, Autonomy, IntegrationStatus, Risk, RunStatus, TicketPriority, TicketStatus } from "../api";

export type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "violet" | "teal";

// ------------------------------------------------------------------ time

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const absoluteFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  if (abs < 3600) return compact(Math.round(diff / 60), "m");
  if (abs < 86400) return compact(Math.round(diff / 3600), "h");
  if (abs < 86400 * 7) return compact(Math.round(diff / 86400), "d");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / (86400 * 7)), "week");
  return dateFmt.format(t);
}

function compact(n: number, unit: string): string {
  return n < 0 ? `${-n}${unit} ago` : `in ${n}${unit}`;
}

export function absoluteTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : absoluteFmt.format(t);
}

// ------------------------------------------------------------------ numbers

const numberFmt = new Intl.NumberFormat();
export const formatNumber = (n: number) => numberFmt.format(n);

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ------------------------------------------------------------------ labels & tones

export const humanize = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const TICKET_STATUS_META: Record<TicketStatus, { label: string; tone: Tone }> = {
  new: { label: "New", tone: "blue" },
  in_progress: { label: "In progress", tone: "violet" },
  awaiting_approval: { label: "Awaiting approval", tone: "amber" },
  waiting_on_customer: { label: "Waiting on customer", tone: "teal" },
  escalated: { label: "Escalated", tone: "red" },
  resolved: { label: "Resolved", tone: "green" },
  closed: { label: "Closed", tone: "neutral" },
};

export const RUN_STATUS_META: Record<RunStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "blue" },
  awaiting_approval: { label: "Awaiting approval", tone: "amber" },
  completed: { label: "Completed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
};

export const RISK_META: Record<Risk, { label: string; tone: Tone; help: string }> = {
  read: { label: "Read", tone: "neutral", help: "No side effects" },
  internal: { label: "Internal", tone: "blue", help: "Writes only inside Haley (notes, KB, ticket fields)" },
  write: { label: "Write", tone: "amber", help: "Changes a customer system" },
  destructive: { label: "Destructive", tone: "red", help: "Security-sensitive or hard to undo" },
};

export const ACTION_STATUS_META: Record<ActionStatus, { label: string; tone: Tone }> = {
  executed: { label: "Executed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  pending_approval: { label: "Needs approval", tone: "amber" },
  approved: { label: "Approved", tone: "teal" },
  rejected: { label: "Rejected", tone: "neutral" },
  blocked: { label: "Blocked by policy", tone: "neutral" },
};

export const PRIORITY_META: Record<TicketPriority, { label: string; tone: Tone }> = {
  low: { label: "Low", tone: "neutral" },
  normal: { label: "Normal", tone: "neutral" },
  high: { label: "High", tone: "amber" },
  urgent: { label: "Urgent", tone: "red" },
};

export const INTEGRATION_STATUS_META: Record<IntegrationStatus, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "green" },
  error: { label: "Error", tone: "red" },
  unknown: { label: "Not tested", tone: "neutral" },
};

export const AUTONOMY_META: Record<Autonomy, { label: string; tone: Tone; summary: string; detail: string }> = {
  read_only: {
    label: "Read-only",
    tone: "neutral",
    summary: "Investigates and recommends only.",
    detail: "Haley can look things up, write notes and KB articles, and reply, but never changes the customer's systems. Proposed changes are recorded as blocked.",
  },
  supervised: {
    label: "Supervised",
    tone: "blue",
    summary: "Every change needs approval.",
    detail: "Any action that changes the customer's systems waits in the approval queue until a technician approves it.",
  },
  autonomous: {
    label: "Autonomous",
    tone: "violet",
    summary: "Routine changes run automatically.",
    detail: "Routine write actions (licenses, groups, mailbox settings) run without waiting. Security-sensitive actions such as password resets, sign-in blocks and deletions still need approval.",
  },
};

export const PROVIDER_NAMES: Record<string, string> = { m365: "Microsoft 365", google: "Google Workspace" };

export const isRunActive = (status: RunStatus) => status === "queued" || status === "running";

export function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}
