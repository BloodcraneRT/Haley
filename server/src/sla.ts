import type { SlaTarget, Ticket } from "./types.js";

export type SlaState = "met" | "pending" | "at_risk" | "breached";

export interface SlaStatus {
  responseDue: string;
  resolutionDue: string;
  response: SlaState;
  resolution: SlaState;
}

/** A timer is at risk once less than a quarter of its window remains. */
const AT_RISK_FRACTION = 0.25;

function state(startMs: number, minutes: number, doneAt: string | null, nowMs: number): SlaState {
  const dueMs = startMs + minutes * 60_000;
  if (doneAt) return Date.parse(doneAt) <= dueMs ? "met" : "breached";
  if (nowMs > dueMs) return "breached";
  return dueMs - nowMs < minutes * 60_000 * AT_RISK_FRACTION ? "at_risk" : "pending";
}

/** Response and resolution SLA for a ticket against its org's targets (24x7 clock). */
export function slaFor(ticket: Ticket, targets: Record<Ticket["priority"], SlaTarget>, nowMs = Date.now()): SlaStatus {
  const target = targets[ticket.priority];
  const start = Date.parse(ticket.created_at);
  // A ticket resolved without a separate reply still got its answer.
  const respondedAt = ticket.first_response_at ?? ticket.resolved_at;
  return {
    responseDue: new Date(start + target.responseMinutes * 60_000).toISOString(),
    resolutionDue: new Date(start + target.resolutionMinutes * 60_000).toISOString(),
    response: state(start, target.responseMinutes, respondedAt, nowMs),
    resolution: state(start, target.resolutionMinutes, ticket.resolved_at, nowMs),
  };
}
