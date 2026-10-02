import { namesService, similarity, ticketTerms } from "./similar.js";
import type { Store } from "./store.js";
import type { Incident, Ticket } from "./types.js";

/** Tickets about the same thing within this window can form an incident. */
export const INCIDENT_WINDOW_MS = 60 * 60_000;
/** A likely outage: at least this many tickets… */
export const INCIDENT_MIN_TICKETS = 3;
/** …from at least this many different people (or devices, for monitoring alerts). */
export const INCIDENT_MIN_PEOPLE = 2;

/** Stricter than "similar tickets": the tickets name the same service, or share several specific words. */
function sameProblem(a: Ticket, b: Ticket): boolean {
  const { score, shared } = similarity(ticketTerms(a), ticketTerms(b));
  return (score >= 0.5 && namesService(shared)) || (score >= 0.6 && shared.length >= 3);
}

/** Who raised a ticket, for counting distinct people: the requester, or the device for monitoring alerts. */
const who = (t: Ticket) => t.requester_email.toLowerCase() || t.channel_ref.assetId || t.requester_name.toLowerCase() || t.id;

/**
 * Watches new tickets for a shared problem. A ticket that matches an open incident joins it; three or more
 * matching tickets from two or more people within an hour open a new "possible outage" incident. Technicians
 * confirm, message everyone, resolve, or dismiss it.
 */
export class IncidentDetector {
  constructor(private readonly store: Store) {}

  onTicketCreated(ticket: Ticket, nowMs = Date.now()): Incident | null {
    if (ticket.incident_id) return null;
    for (const incident of this.store.listIncidents({ orgId: ticket.org_id, status: "open" })) {
      const members = this.store.listIncidentTickets(incident.id);
      if (members.some((m) => sameProblem(ticket, m))) {
        this.link(incident, ticket, "haley");
        return incident;
      }
    }
    const since = new Date(nowMs - INCIDENT_WINDOW_MS).toISOString();
    const cluster = [ticket, ...this.store.listOpenTicketsCreatedSince(ticket.org_id, since).filter((t) => t.id !== ticket.id && !t.incident_id && sameProblem(ticket, t))];
    if (cluster.length < INCIDENT_MIN_TICKETS || new Set(cluster.map(who)).size < INCIDENT_MIN_PEOPLE) return null;

    const incident = this.store.createIncident({ orgId: ticket.org_id, title: ticket.title.slice(0, 120), createdBy: "haley" });
    for (const t of cluster.reverse()) this.link(incident, t, "haley");
    this.store.audit({ orgId: ticket.org_id, actor: "haley", action: "incident.detected", target: incident.id, detail: { tickets: cluster.map((t) => t.number) } });
    return incident;
  }

  link(incident: Incident, ticket: Ticket, actor: string): void {
    this.store.setTicketIncident(ticket.id, incident.id);
    this.store.addTicketEvent(
      ticket.id,
      "field_change",
      actor,
      actor === "haley" ? `Linked to possible outage "${incident.title}": other people reported the same problem.` : `Linked to incident "${incident.title}".`,
      { incidentId: incident.id },
    );
  }
}

/** What Haley is told about a ticket's incident, so she treats it as a shared problem. */
export function incidentContext(store: Store, ticket: Ticket): string {
  if (!ticket.incident_id) return "";
  const incident = store.getIncident(ticket.incident_id);
  if (!incident || incident.status !== "open") return "";
  const others = store.listIncidentTickets(incident.id).filter((t) => t.id !== ticket.id);
  return `<incident>
This ticket is part of a likely shared problem, "${incident.title}" (${others.length + 1} tickets from ${new Set([ticket, ...others].map(who)).size} people since ${incident.created_at}).
Check for a service or network outage (for example service health) before troubleshooting this person's own account or device. Tell them others are affected and it's being worked on. A technician may message everyone affected at once, so don't promise a fix time.
</incident>`;
}
