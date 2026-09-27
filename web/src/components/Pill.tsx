import type { ReactNode } from "react";
import type { ActionStatus, Autonomy, IntegrationMode, IntegrationStatus, Risk, RunStatus, TicketPriority, TicketStatus } from "../api";
import {
  ACTION_STATUS_META,
  AUTONOMY_META,
  INTEGRATION_STATUS_META,
  PRIORITY_META,
  RISK_META,
  RUN_STATUS_META,
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
