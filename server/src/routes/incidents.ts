import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ChannelHub } from "../channels/hub.js";
import type { IncidentDetector } from "../incidents.js";
import type { Store } from "../store.js";
import type { Incident, Ticket } from "../types.js";

class IncidentRouteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const OPEN = (t: Ticket) => t.status !== "resolved" && t.status !== "closed";

/**
 * Incidents: several tickets about one shared problem. Technicians see who's affected, message everyone at
 * once on the channel each person used, resolve every ticket together, or dismiss a false match.
 */
export function registerIncidentRoutes(
  app: FastifyInstance,
  deps: { store: Store; hub: ChannelHub; detector: IncidentDetector; actor: (req: FastifyRequest) => string },
): void {
  const { store, hub, detector, actor } = deps;
  const parse = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> => {
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success) throw new IncidentRouteError(400, z.prettifyError(parsed.error));
    return parsed.data;
  };
  const incident = (id: string): Incident => {
    const found = store.getIncident(id);
    if (!found) throw new IncidentRouteError(404, "Incident not found");
    return found;
  };
  const summary = (i: Incident) => {
    const tickets = store.listIncidentTickets(i.id);
    return {
      ...i,
      org_name: store.getOrg(i.org_id)?.name ?? "",
      ticketCount: tickets.length,
      openCount: tickets.filter(OPEN).length,
      people: new Set(tickets.map((t) => t.requester_email.toLowerCase() || t.id)).size,
      lastTicketAt: tickets.at(-1)?.created_at ?? i.created_at,
    };
  };

  /** Sends one message on each open ticket's own channel and records it, like a technician reply. */
  const messageAll = async (tickets: Ticket[], text: string, author: string) => {
    let delivered = 0;
    const failed: number[] = [];
    for (const t of tickets) {
      const delivery = await hub.deliverReply(t, text);
      store.addTicketEvent(t.id, "reply", author, text, { delivery, incidentBroadcast: true });
      if (delivery.delivered) delivered++;
      else failed.push(t.number);
    }
    return { sent: tickets.length, delivered, notDelivered: failed };
  };


  app.get("/api/incidents", async (req) => {
    const q = parse(z.object({ status: z.enum(["open", "resolved", "dismissed"]).optional(), orgId: z.string().optional() }), req.query);
    return store.listIncidents(q).map(summary);
  });

  app.get<{ Params: { id: string } }>("/api/incidents/:id", async (req) => {
    const i = incident(req.params.id);
    return { incident: summary(i), tickets: store.listIncidentTickets(i.id) };
  });

  app.post("/api/incidents", async (req) => {
    const input = parse(z.object({ title: z.string().trim().min(3).max(120), ticketIds: z.array(z.string()).min(1).max(200) }), req.body);
    const tickets = input.ticketIds.map((id) => store.getTicket(id));
    if (tickets.some((t) => !t)) throw new IncidentRouteError(404, "Ticket not found");
    const orgs = new Set(tickets.map((t) => t!.org_id));
    if (orgs.size > 1) throw new IncidentRouteError(400, "An incident's tickets must belong to one client.");
    const who = actor(req);
    const created = store.createIncident({ orgId: tickets[0]!.org_id, title: input.title, createdBy: who });
    for (const t of tickets) detector.link(created, t!, who);
    store.audit({ orgId: created.org_id, actor: who, action: "incident.created", target: created.id, detail: { tickets: tickets.map((t) => t!.number) } });
    return summary(created);
  });

  app.patch<{ Params: { id: string } }>("/api/incidents/:id", async (req) => {
    const i = incident(req.params.id);
    const input = parse(z.object({ title: z.string().trim().min(3).max(120) }), req.body);
    return summary(store.updateIncident(i.id, input)!);
  });

  app.post<{ Params: { id: string } }>("/api/incidents/:id/message", async (req) => {
    const i = incident(req.params.id);
    const input = parse(z.object({ message: z.string().trim().min(2).max(4000) }), req.body);
    const who = actor(req);
    const result = await messageAll(store.listIncidentTickets(i.id).filter(OPEN), input.message, who);
    store.audit({ orgId: i.org_id, actor: who, action: "incident.messaged", target: i.id, detail: result });
    return result;
  });

  app.post<{ Params: { id: string } }>("/api/incidents/:id/resolve", async (req) => {
    const i = incident(req.params.id);
    if (i.status !== "open") throw new IncidentRouteError(409, "This incident isn't open.");
    const input = parse(z.object({ message: z.string().trim().max(4000).default("") }), req.body);
    const who = actor(req);
    const open = store.listIncidentTickets(i.id).filter(OPEN);
    const messaged = input.message ? await messageAll(open, input.message, who) : null;
    for (const t of open) store.updateTicket(t.id, { status: "resolved" }, who);
    const updated = store.updateIncident(i.id, { status: "resolved" })!;
    store.audit({ orgId: i.org_id, actor: who, action: "incident.resolved", target: i.id, detail: { resolved: open.length, ...(messaged ?? {}) } });
    return { incident: summary(updated), resolvedTickets: open.length, message: messaged };
  });

  app.post<{ Params: { id: string } }>("/api/incidents/:id/dismiss", async (req) => {
    const i = incident(req.params.id);
    const who = actor(req);
    const tickets = store.listIncidentTickets(i.id);
    for (const t of tickets) {
      store.setTicketIncident(t.id, null);
      store.addTicketEvent(t.id, "field_change", who, `Unlinked from "${i.title}": not a shared problem.`, { incidentId: i.id });
    }
    const updated = store.updateIncident(i.id, { status: "dismissed" })!;
    store.audit({ orgId: i.org_id, actor: who, action: "incident.dismissed", target: i.id, detail: { unlinked: tickets.length } });
    return summary(updated);
  });

  /** Link a ticket to an incident (incidentId) or unlink it (null). */
  app.put<{ Params: { id: string } }>("/api/tickets/:id/incident", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw new IncidentRouteError(404, "Ticket not found");
    const input = parse(z.object({ incidentId: z.string().nullable() }), req.body);
    const who = actor(req);
    if (input.incidentId) {
      const i = incident(input.incidentId);
      if (i.org_id !== ticket.org_id) throw new IncidentRouteError(400, "That incident belongs to another client.");
      detector.link(i, ticket, who);
    } else if (ticket.incident_id) {
      const previous = store.getIncident(ticket.incident_id);
      store.setTicketIncident(ticket.id, null);
      store.addTicketEvent(ticket.id, "field_change", who, `Unlinked from "${previous?.title ?? "incident"}".`, { incidentId: ticket.incident_id });
    }
    return store.getTicket(ticket.id);
  });
}
