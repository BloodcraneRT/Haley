import {
  MFA_WINDOW_MINUTES,
  type ActionStatus,
  type Assurance,
  type Autonomy,
  type Cadence,
  type IntegrationStatus,
  type ModelLicense,
  type Risk,
  type RunStatus,
  type SlaState,
  type Ticket,
  type TicketChannel,
  type TicketPriority,
  type TicketStatus,
} from "../api";

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

/** Compact duration for minutes: "45 min", "3.5 h", "2 d". */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes == null || Number.isNaN(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)} h`;
  const days = hours / 24;
  return `${days < 10 ? Math.round(days * 10) / 10 : Math.round(days)} d`;
}

export function formatPercent(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value * 10) / 10}%`;
}

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
  planned: { label: "Planned – not executed", tone: "blue" },
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
  unattended: {
    label: "Unattended",
    tone: "teal",
    summary: "End users self-serve, no technician.",
    detail:
      "Verified requesters get their own problems fixed with no technician: password resets, sign-outs, Temporary Access Passes on their own account. Access grants need an authorized approver; email alone never authorizes security-sensitive changes; protected accounts and unusual volume fall back to approvals.",
  },
};

export const PROVIDER_NAMES: Record<string, string> = {
  m365: "Microsoft 365",
  google: "Google Workspace",
  slack: "Slack",
  duo: "Duo push",
  okta: "Okta Verify push",
  sms_code: "SMS verification code",
};

export const PSA_NAMES: Record<string, string> = { syncro: "Syncro", dynamics: "Dynamics 365" };

export const CHANNEL_META: Record<TicketChannel, { label: string; help: string }> = {
  portal: { label: "Portal", help: "Entered in the Haley dashboard by a technician" },
  api: { label: "API", help: "Submitted through the API (PSA or integration)" },
  email: { label: "Email", help: "Arrived by email" },
  slack: { label: "Slack", help: "Direct message or @mention in Slack" },
  teams: { label: "Teams", help: "Message to the Haley bot in Microsoft Teams" },
  chat: { label: "Chat", help: "Chat bridge (web widget, SMS, Google Chat) or the end-user simulator" },
  syncro: { label: "Syncro", help: "Imported from SyncroMSP; replies go back as public ticket comments" },
  dynamics: { label: "Dynamics 365", help: "Imported from a Dynamics 365 Customer Service case; replies go to the case timeline" },
};

export const ASSURANCE_META: Record<Assurance, { label: string; tone: Tone; short: string; how: string }> = {
  none: { label: "Unverified", tone: "neutral", short: "None", how: "Nothing beyond what they typed: an unsigned API call, a chat user the bridge didn't vouch for, or email that failed DMARC." },
  email: { label: "Email verified", tone: "blue", short: "Email", how: "DMARC-aligned email. The domain vouches for the sender, but mailboxes get phished and spoofed." },
  chat: { label: "Chat verified", tone: "violet", short: "Chat", how: "A signed-in chat identity: a Slack workspace member, or a chat bridge that authenticated the user." },
  directory: { label: "Directory verified", tone: "green", short: "Directory", how: "Matched to an active directory account through SSO (Teams with Entra ID)." },
  mfa: {
    label: "MFA verified",
    tone: "green",
    short: "MFA",
    how: `Approved a push or confirmed a texted code on their own registered device (step-up verification). Counts for ${MFA_WINDOW_MINUTES} minutes.`,
  },
  technician: { label: "Technician", tone: "teal", short: "Technician", how: "Entered or confirmed by a technician." },
};

export const SLA_STATE_META: Record<SlaState, { label: string; tone: Tone }> = {
  pending: { label: "On track", tone: "neutral" },
  at_risk: { label: "At risk", tone: "amber" },
  breached: { label: "Breached", tone: "red" },
  met: { label: "Met", tone: "green" },
};

export const CADENCE_META: Record<Cadence, { label: string; every: string }> = {
  once: { label: "Once", every: "One time" },
  daily: { label: "Daily", every: "Every day" },
  weekly: { label: "Weekly", every: "Every week" },
  monthly: { label: "Monthly", every: "Every month" },
};

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

// ------------------------------------------------------------------ step-up verification

/** When a ticket's step-up verification stops counting, or null if it was never verified. */
export function mfaExpiresAt(ticket: Pick<Ticket, "mfa_verified_at">): number | null {
  if (!ticket.mfa_verified_at) return null;
  const t = Date.parse(ticket.mfa_verified_at);
  return Number.isNaN(t) ? null : t + MFA_WINDOW_MINUTES * 60_000;
}

/** The requester's identity right now: a fresh step-up verification lifts it to "mfa" (server effectiveAssurance). */
export function effectiveAssurance(ticket: Pick<Ticket, "assurance" | "mfa_verified_at">, now = Date.now()): Assurance {
  const expires = mfaExpiresAt(ticket);
  const rank = ASSURANCE_RANK[ticket.assurance] ?? 0;
  return expires !== null && now < expires && ASSURANCE_RANK.mfa > rank ? "mfa" : ticket.assurance;
}

export const ASSURANCE_RANK: Record<Assurance, number> = { none: 0, email: 1, chat: 2, directory: 3, mfa: 4, technician: 5 };

/** Outcomes recorded on `action` events by verify_requester_identity / confirm_verification_code (meta.verification). */
export const VERIFICATION_META: Record<string, { label: string; tone: Tone }> = {
  code_sent: { label: "Code sent", tone: "amber" },
  approved: { label: "Verified", tone: "green" },
  denied: { label: "Denied", tone: "red" },
  timeout: { label: "Timed out", tone: "amber" },
  unavailable: { label: "Unavailable", tone: "amber" },
  wrong_code: { label: "Wrong code", tone: "amber" },
};

// ------------------------------------------------------------------ AI models

export const LICENSE_META: Record<ModelLicense, { label: string; tone: Tone; help: string }> = {
  closed: { label: "Closed", tone: "blue", help: "Hosted proprietary models" },
  open: { label: "Open-weight", tone: "teal", help: "Open-weight models, hosted or on your own hardware" },
  both: { label: "Open & closed", tone: "violet", help: "Serves both open-weight and proprietary models" },
};

/** "anthropic/claude-x" → provider and model parts for display. */
export function splitServedBy(value: string): { provider: string; model: string } {
  const i = value.indexOf("/");
  return i < 0 ? { provider: "", model: value } : { provider: value.slice(0, i), model: value.slice(i + 1) };
}
