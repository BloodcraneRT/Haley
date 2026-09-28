import { ClipboardList, Code, Hash, Headset, Mail, MessageCircle, Monitor, RefreshCw, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useNow } from "../hooks/useNow";
import type {
  ActionStatus,
  Assurance,
  Autonomy,
  IntegrationMode,
  IntegrationStatus,
  Risk,
  RunMode,
  RunStatus,
  SlaState,
  SlaStatus,
  Ticket,
  TicketChannel,
  TicketPriority,
  TicketStatus,
} from "../api";
import {
  absoluteTime,
  ACTION_STATUS_META,
  ASSURANCE_META,
  AUTONOMY_META,
  CHANNEL_META,
  effectiveAssurance,
  INTEGRATION_STATUS_META,
  mfaExpiresAt,
  PRIORITY_META,
  RISK_META,
  RUN_STATUS_META,
  SLA_STATE_META,
  TICKET_STATUS_META,
  type Tone,
} from "../lib/format";

export function Pill({
  tone = "neutral",
  dot,
  pulse,
  title,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const cls = ["pill", `tone-${tone}`, dot || pulse ? "pill-dot" : "", pulse ? "pill-pulse" : ""].filter(Boolean).join(" ");
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

export function TicketStatusPill({ status }: { status: TicketStatus }) {
  const meta = TICKET_STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Pill tone={meta.tone} dot>
      {meta.label}
    </Pill>
  );
}

export function RunStatusPill({ status }: { status: RunStatus }) {
  const meta = RUN_STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Pill tone={meta.tone} dot pulse={status === "running" || status === "queued"}>
      {meta.label}
    </Pill>
  );
}

export function RiskPill({ risk }: { risk: Risk }) {
  const meta = RISK_META[risk] ?? { label: risk, tone: "neutral" as Tone, help: "" };
  return (
    <Pill tone={meta.tone} title={`${meta.label} risk: ${meta.help}`}>
      {meta.label}
    </Pill>
  );
}

export function ActionStatusPill({ status }: { status: ActionStatus }) {
  const meta = ACTION_STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Pill tone={meta.tone} dot>
      {meta.label}
    </Pill>
  );
}

export function IntegrationStatusPill({ status }: { status: IntegrationStatus }) {
  const meta = INTEGRATION_STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Pill tone={meta.tone} dot>
      {meta.label}
    </Pill>
  );
}

export function ModePill({ mode }: { mode: IntegrationMode }) {
  return mode === "sandbox" ? (
    <Pill tone="violet" title="Simulated tenant; nothing real is changed">
      Sandbox
    </Pill>
  ) : (
    <Pill tone="teal" title="Connected to the customer's real tenant">
      Live
    </Pill>
  );
}

export function AutonomyPill({ autonomy }: { autonomy: Autonomy }) {
  const meta = AUTONOMY_META[autonomy];
  return (
    <Pill tone={meta.tone} title={meta.summary}>
      {meta.label}
    </Pill>
  );
}

export function Priority({ priority }: { priority: TicketPriority }) {
  const level = { low: 1, normal: 2, high: 3, urgent: 3 }[priority] ?? 2;
  return (
    <span className={`priority priority-${priority}`}>
      <span className="priority-bars" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <i key={n} className={n <= level ? "on" : ""} />
        ))}
      </span>
      {PRIORITY_META[priority]?.label ?? priority}
    </span>
  );
}

const CHANNEL_ICONS: Record<TicketChannel, typeof Mail> = {
  portal: Monitor,
  api: Code,
  email: Mail,
  slack: Hash,
  teams: Users,
  chat: MessageCircle,
  syncro: RefreshCw,
  dynamics: Headset,
};

export function ChannelIcon({ channel, className = "icon-sm" }: { channel: TicketChannel; className?: string }) {
  const Icon = CHANNEL_ICONS[channel] ?? MessageCircle;
  return <Icon className={className} aria-hidden="true" />;
}

/** The PSA ticket/case number for tickets imported from a PSA ("Syncro #1234"), or null. */
export function psaRef(ticket: Pick<Ticket, "channel" | "channel_ref">): string | null {
  const n = ticket.channel_ref?.externalNumber;
  if (!n || (ticket.channel !== "syncro" && ticket.channel !== "dynamics")) return null;
  return `${CHANNEL_META[ticket.channel].label} #${n}`;
}

/** Compact PSA reference for lists: Dynamics case numbers are self-describing ("CAS-01042-K7P2"). */
export function psaShortRef(ticket: Pick<Ticket, "channel" | "channel_ref">): string | null {
  const full = psaRef(ticket);
  if (!full) return null;
  return ticket.channel === "dynamics" ? ticket.channel_ref.externalNumber : full;
}

/** Where the ticket came from (portal, email, Slack…); PSA tickets show their PSA number. */
export function ChannelBadge({ channel, iconOnly, externalNumber }: { channel: TicketChannel; iconOnly?: boolean; externalNumber?: string }) {
  const meta = CHANNEL_META[channel] ?? { label: channel, help: "" };
  const label = externalNumber ? `${meta.label} #${externalNumber}` : meta.label;
  if (iconOnly) {
    return (
      <span className="channel-icon" title={`${label}: ${meta.help}`} aria-label={`Channel: ${label}`} role="img">
        <ChannelIcon channel={channel} />
      </span>
    );
  }
  return (
    <span className={`pill pill-outline channel-badge ${externalNumber ? "is-psa" : ""}`} title={meta.help}>
      <ChannelIcon channel={channel} className="icon-xs" />
      {label}
    </span>
  );
}

/** How strongly the requester's identity was established; `verification` explains how. */
export function AssuranceBadge({ assurance, verification, short }: { assurance: Assurance; verification?: string; short?: boolean }) {
  const meta = ASSURANCE_META[assurance] ?? { label: assurance, tone: "neutral" as Tone, short: assurance, how: "" };
  return (
    <Pill tone={meta.tone} title={verification ? `${meta.label}: ${verification}` : `${meta.label}. ${meta.how}`}>
      {short ? meta.short : meta.label}
    </Pill>
  );
}

const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/**
 * The requester's identity right now: shows "MFA verified" while a step-up verification is fresh
 * (30 minutes after mfa_verified_at), otherwise the channel's assurance.
 */
export function IdentityBadge({
  ticket,
  short,
}: {
  ticket: Pick<Ticket, "assurance" | "verification" | "mfa_verified_at" | "mfa_method">;
  short?: boolean;
}) {
  const now = useNow();
  const level = effectiveAssurance(ticket, now);
  if (level !== "mfa" || !ticket.mfa_verified_at) return <AssuranceBadge assurance={ticket.assurance} verification={ticket.verification} short={short} />;
  const meta = ASSURANCE_META.mfa;
  const expires = mfaExpiresAt(ticket)!;
  const tip = `${meta.label} with ${ticket.mfa_method || "step-up verification"} at ${absoluteTime(ticket.mfa_verified_at)}. Counts until ${timeFmt.format(expires)} (30 minutes after approval), then falls back to ${ASSURANCE_META[ticket.assurance]?.label.toLowerCase() ?? ticket.assurance}.`;
  return (
    <Pill tone={meta.tone} title={tip}>
      {short ? meta.short : meta.label}
    </Pill>
  );
}

export function SlaStatePill({ state, label }: { state: SlaState; label?: string }) {
  const meta = SLA_STATE_META[state];
  return (
    <Pill tone={meta.tone} dot>
      {label ? `${label} ${meta.label.toLowerCase()}` : meta.label}
    </Pill>
  );
}

/** The worst of a ticket's response/resolution SLA states, for compact list display. */
export function worstSla(sla: SlaStatus): { state: SlaState; which: "response" | "resolution"; due: string } {
  const rank: Record<SlaState, number> = { breached: 3, at_risk: 2, pending: 1, met: 0 };
  // Response only matters until it's met; after that, resolution is what's ticking.
  const response = { state: sla.response, which: "response" as const, due: sla.responseDue };
  const resolution = { state: sla.resolution, which: "resolution" as const, due: sla.resolutionDue };
  if (rank[sla.response] > rank[sla.resolution]) return response;
  if (rank[sla.resolution] > rank[sla.response]) return resolution;
  return sla.response === "met" ? resolution : response;
}

/** Compact SLA indicator for lists: a dot pill with the governing timer, due time in the tooltip. */
export function SlaIndicator({ sla, resolved }: { sla: SlaStatus | null; resolved?: boolean }) {
  if (!sla) return <span className="muted">—</span>;
  const w = worstSla(sla);
  const meta = SLA_STATE_META[w.state];
  const tip = `Response: ${SLA_STATE_META[sla.response].label} (due ${absoluteTime(sla.responseDue)})\nResolution: ${SLA_STATE_META[sla.resolution].label} (due ${absoluteTime(sla.resolutionDue)})`;
  const text = w.state === "met" ? "Met" : w.state === "pending" && !resolved ? meta.label : `${w.which === "response" ? "Response" : "Resolution"} ${meta.label.toLowerCase()}`;
  return (
    <Pill tone={meta.tone} dot title={tip}>
      {text}
    </Pill>
  );
}

/** Marks dry runs everywhere a run appears. */
export function RunModeBadge({ mode }: { mode: RunMode }) {
  if (mode !== "plan") return null;
  return (
    <span className="pill plan-badge" title="Dry run: changes are simulated and reported, nothing is executed">
      <ClipboardList className="icon-xs" aria-hidden="true" />
      Plan (dry run)
    </span>
  );
}
