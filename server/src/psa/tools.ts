import { z } from "zod";
import { clip } from "../connectors/http.js";
import { ConnectorError, defineTool, type Connector, type HaleyTool } from "../connectors/types.js";
import type { Store } from "../store.js";
import type { PsaAdapter, PsaConnection } from "./types.js";

/** Contract statuses that mean it isn't (or is no longer) in force. */
const NOT_IN_FORCE = /opportunit|expired|cancel|inactive|lost|draft|closed/i;

/** Whether a contract covers today, from its dates and status. */
export function contractInForce(c: { status: string; startDate: string | null; endDate: string | null }, today = new Date().toISOString().slice(0, 10)): boolean {
  if (NOT_IN_FORCE.test(c.status)) return false;
  if (c.startDate && c.startDate.slice(0, 10) > today) return false;
  if (c.endDate && c.endDate.slice(0, 10) < today) return false;
  return true;
}

/**
 * Tools that use the client's PSA beyond ticket sync: the MSP's saved replies, the client's contracts, and
 * booking on-site appointments. One PSA connection that maps this client; only what its adapter supports.
 */
export function psaTools(store: Store, connection: PsaConnection, adapter: PsaAdapter, customerId: string): HaleyTool[] {
  const tools: HaleyTool[] = [];
  const name = connection.name;

  if (adapter.findCannedResponses) {
    const find = adapter.findCannedResponses.bind(adapter);
    tools.push(
      defineTool({
        name: "psa_find_canned_response",
        description: `Search the MSP's saved replies (canned responses) in ${name}. When one fits the situation, base your reply on it so it matches the MSP's wording and process: adapt it to this ticket and fill in its placeholders. Never send placeholder text like [name] as-is.`,
        input: z.object({ query: z.string().trim().min(2).max(100).describe("A few words, e.g. 'password reset' or 'new laptop'") }),
        risk: "read",
        run: async ({ query }) => {
          const found = await find(query);
          return {
            count: found.length,
            responses: found.slice(0, 8).map((r) => ({ title: r.title, category: r.category || null, subject: r.subject || null, body: clip(r.body, 2000) })),
          };
        },
      }),
    );
  }

  if (adapter.listContracts) {
    const list = adapter.listContracts.bind(adapter);
    tools.push(
      defineTool({
        name: "psa_list_contracts",
        description: `List this client's contracts (agreements) in ${name}, with whether each is in force today and which products it covers or makes non-billable. Check it before work that may be billable outside the contract (projects, hardware, on-site visits, after-hours work, purchases).`,
        input: z.object({}),
        risk: "read",
        run: async () => {
          const contracts = await list(customerId);
          return {
            count: contracts.length,
            contracts: contracts.slice(0, 50).map((c) => ({ ...c, description: clip(c.description, 600), inForce: contractInForce(c) })),
            note: contracts.length ? undefined : `No contracts for this client in ${name}: treat extra work as billable and check with a technician.`,
          };
        },
      }),
    );
  }

  if (adapter.createAppointment) {
    const create = adapter.createAppointment.bind(adapter);
    tools.push(
      defineTool({
        name: "psa_book_appointment",
        description: `Book an appointment on ${name}'s calendar, typically an on-site visit when you escalate work that needs someone there. Agree the time with the requester first. It's linked to this ticket. Only ask ${name} to email the customer when they've agreed the time.`,
        input: z.object({
          summary: z.string().trim().min(3).max(120).describe("e.g. 'On-site: replace front desk printer'"),
          startAt: z.iso.datetime({ offset: true }).describe("Start, ISO 8601 with timezone"),
          durationMinutes: z.number().int().min(15).max(480).default(60),
          location: z.string().trim().max(200).optional(),
          notes: z.string().trim().max(2000).default("").describe("What needs doing and what you already checked"),
          emailCustomer: z.boolean().default(false),
        }),
        risk: "write",
        describe: (i) => `Book "${i.summary}" in ${name} at ${i.startAt} for ${i.durationMinutes} min${i.emailCustomer ? " and email the customer" : ""}`,
        run: async (input, ctx) => {
          const start = Date.parse(input.startAt);
          if (start <= Date.now()) throw new ConnectorError("The appointment must be in the future.");
          if (start > Date.now() + 90 * 86_400_000) throw new ConnectorError("Appointments can be at most 90 days out.");
          const link = ctx.ticketId ? store.getTicketLink(ctx.ticketId, connection.id) : null;
          const ticket = ctx.ticketId ? store.getTicket(ctx.ticketId) : null;
          const description = [input.notes, ticket ? `Haley ticket #${ticket.number}: ${ticket.title}` : ""].filter(Boolean).join("\n\n");
          const created = await create({
            customerId,
            ticketId: link?.external_id ?? null,
            summary: input.summary,
            description,
            startAt: new Date(start).toISOString(),
            endAt: new Date(start + input.durationMinutes * 60_000).toISOString(),
            location: input.location,
            emailCustomer: input.emailCustomer,
          });
          if (ctx.ticketId) {
            store.addTicketEvent(ctx.ticketId, "agent_note", "haley", `Booked "${input.summary}" in ${name} for ${new Date(start).toISOString()} (${input.durationMinutes} min).`, {
              runId: ctx.runId,
              appointmentId: created.id,
            });
          }
          return { booked: true, appointmentId: created.id, linkedToPsaTicket: Boolean(link), startAt: new Date(start).toISOString(), durationMinutes: input.durationMinutes };
        },
      }),
    );
  }
  return tools;
}

/**
 * A pseudo-connector per PSA connection that maps this client, carrying the PSA tools. A client mapped in
 * several connections gets the first one's tools (tool names would collide).
 */
export function psaConnectorsFor(store: Store, orgId: string, adapterFor: (c: PsaConnection) => PsaAdapter): Connector[] {
  for (const connection of store.listPsaConnections()) {
    if (!connection.enabled) continue;
    const customerId = Object.entries(connection.customer_map).find(([, mapped]) => mapped === orgId)?.[0];
    if (!customerId) continue;
    let adapter: PsaAdapter;
    try {
      adapter = adapterFor(connection);
    } catch {
      continue;
    }
    const tools = psaTools(store, connection, adapter, customerId);
    if (!tools.length) continue;
    return [{ integrationId: connection.id, provider: `psa:${connection.kind}`, label: connection.name, tools, test: () => adapter.test() }];
  }
  return [];
}
