import type { ChannelHub } from "../channels/hub.js";
import type { ChannelAdapter, DeliveryResult } from "../channels/types.js";
import type { Store } from "../store.js";
import type { Ticket, TicketEvent, TicketStatus } from "../types.js";
import type { ExternalTicket, PsaAdapter, PsaConnection, PsaKind } from "./types.js";

export interface SyncResult {
  imported: number;
  commentsImported: number;
  exported: number;
  pushed: number;
  statusUpdates: number;
  unmappedCustomers: string[];
  errors: string[];
}

/** Statuses both sides can agree on; finer-grained Haley statuses collapse to these for comparison. */
function coarse(status: TicketStatus | null): string {
  if (!status) return "";
  if (status === "resolved" || status === "closed") return "resolved";
  if (status === "waiting_on_customer") return "waiting_on_customer";
  if (status === "new") return "new";
  return "in_progress";
}

const MIRRORED_KINDS = new Set<TicketEvent["kind"]>(["agent_note", "escalation", "action", "reply", "comment"]);

function mirrorText(event: TicketEvent, ticket: Ticket, kind: PsaKind): string | null {
  if (!MIRRORED_KINDS.has(event.kind)) return null;
  // Messages that came from this PSA are already there.
  if (event.meta.channel === kind) return null;
  // Replies on a PSA-originated ticket went out as public PSA comments already.
  if (event.kind === "reply" && ticket.channel === kind) return null;
  const label: Record<string, string> = {
    agent_note: "Haley note",
    escalation: "Escalation",
    action: "Action",
    reply: `Reply sent to the requester${ticket.channel === "portal" || ticket.channel === "api" ? "" : ` via ${ticket.channel}`}`,
    comment: event.meta.fromRequester ? `Message from the requester via ${String(event.meta.channel ?? ticket.channel)}` : "Technician note",
  };
  return `[${label[event.kind]}: ${event.author}]\n${event.body}`;
}

/**
 * Two-way sync between Haley and a PSA / service desk.
 *
 * Pull: new tickets for mapped customers are opened in Haley (Haley works them); customer comments continue the
 * ticket; the PSA closing a ticket resolves it here. Push: replies on PSA tickets go out as public comments (the PSA
 * notifies the customer); Haley's notes, actions and other-channel conversation are mirrored as internal comments;
 * status changes flow back; tickets that start in Haley are created in the PSA so billing and reporting see them.
 */
export class PsaSync {
  private readonly adapters = new Map<string, PsaAdapter>();
  /** Comment ids Haley posted before the ticket link existed (the acknowledgement on import). */
  private readonly pendingSeen = new Map<string, string[]>();
  private readonly running = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly hub: ChannelHub,
    private readonly build: (connection: PsaConnection, config: Record<string, string>) => PsaAdapter,
  ) {}

  adapterFor(connection: PsaConnection): PsaAdapter {
    let adapter = this.adapters.get(connection.id);
    if (!adapter) {
      adapter = this.build(connection, this.store.getPsaConfig(connection.id));
      this.adapters.set(connection.id, adapter);
    }
    return adapter;
  }

  invalidate(connectionId: string): void {
    this.adapters.delete(connectionId);
  }

  /** Delivers replies on PSA-originated tickets as public comments on the PSA ticket. */
  channelAdapter(kind: PsaKind): ChannelAdapter {
    return {
      channel: kind,
      supportsPrivate: false,
      send: async (ticket: Ticket, text: string): Promise<DeliveryResult> => {
        const { connectionId, externalId, externalNumber } = ticket.channel_ref;
        const connection = connectionId ? this.store.getPsaConnection(connectionId) : null;
        if (!connection || !externalId) return { delivered: false, detail: "The PSA connection for this ticket no longer exists." };
        const commentId = await this.adapterFor(connection).addComment(externalId, { body: text, public: true });
        this.markSeen(ticket.id, connection.id, externalId, [commentId]);
        return { delivered: true, detail: `${connection.name} ticket #${externalNumber || externalId}` };
      },
    };
  }

  private markSeen(ticketId: string, connectionId: string, externalId: string, ids: string[]) {
    const link = this.store.getTicketLink(ticketId, connectionId);
    if (link) {
      this.store.updateTicketLink(ticketId, connectionId, { seenCommentIds: [...new Set([...link.seen_comment_ids, ...ids])] });
    } else {
      const key = `${connectionId}:${externalId}`;
      this.pendingSeen.set(key, [...(this.pendingSeen.get(key) ?? []), ...ids]);
    }
  }

  async syncAll(minIntervalMs = 120_000): Promise<Record<string, SyncResult>> {
    const results: Record<string, SyncResult> = {};
    for (const connection of this.store.listPsaConnections()) {
      if (!connection.enabled) continue;
      if (connection.last_sync_at && Date.now() - Date.parse(connection.last_sync_at) < minIntervalMs) continue;
      results[connection.id] = await this.sync(connection.id);
    }
    return results;
  }

  async sync(connectionId: string): Promise<SyncResult> {
    const result: SyncResult = { imported: 0, commentsImported: 0, exported: 0, pushed: 0, statusUpdates: 0, unmappedCustomers: [], errors: [] };
    const connection = this.store.getPsaConnection(connectionId);
    if (!connection || this.running.has(connectionId)) return result;
    this.running.add(connectionId);
    const startedAt = new Date().toISOString();
    try {
      const adapter = this.adapterFor(connection);
      const tickets = await adapter.listUpdatedTickets(connection.cursor);
      let cursor = connection.cursor;
      for (const external of tickets) {
        try {
          await this.pull(connection, external, result);
        } catch (err) {
          result.errors.push(`Ticket ${external.number || external.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!cursor || external.updatedAt > cursor) cursor = external.updatedAt;
      }
      await this.push(connection, adapter, result);
      if (connection.options.exportTickets) await this.exportNew(connection, adapter, result);
      this.store.updatePsaConnection(connectionId, {
        cursor,
        lastSyncAt: startedAt,
        status: result.errors.length ? "error" : "connected",
        statusDetail: result.errors.length
          ? result.errors.slice(0, 3).join("; ")
          : `Synced: ${result.imported} imported, ${result.commentsImported} comments, ${result.exported} exported, ${result.pushed} mirrored.`,
      });
      if (result.imported || result.exported || result.errors.length) {
        this.store.audit({ actor: connection.name, action: "psa.synced", target: connectionId, detail: { ...result } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(message);
      this.store.updatePsaConnection(connectionId, { lastSyncAt: startedAt, status: "error", statusDetail: message });
    } finally {
      this.running.delete(connectionId);
    }
    return result;
  }

  private async pull(connection: PsaConnection, external: ExternalTicket, result: SyncResult) {
    const link = this.store.findTicketLinkByExternal(connection.id, external.id);
    if (!link) {
      if (!connection.options.importTickets) return;
      const orgId = connection.customer_map[external.customerId];
      const org = orgId ? this.store.getOrg(orgId) : null;
      if (!org) {
        if (!result.unmappedCustomers.includes(external.customerName)) result.unmappedCustomers.push(external.customerName);
        return;
      }
      // Tickets closed before Haley ever saw them aren't worth importing.
      if (coarse(external.status) === "resolved") return;
      const received = await this.hub.receive({
        channel: connection.kind,
        org,
        sender: {
          name: external.requesterName,
          email: external.requesterEmail?.toLowerCase() ?? null,
          assurance: connection.options.requesterAssurance,
          verification: `Imported from ${connection.name}`,
        },
        subject: external.subject,
        text: external.description || external.subject,
        thread: null,
        ref: { connectionId: connection.id, externalId: external.id, externalNumber: external.number },
      });
      const key = `${connection.id}:${external.id}`;
      this.store.createTicketLink({
        ticketId: received.ticketId,
        connectionId: connection.id,
        externalId: external.id,
        externalNumber: external.number,
        seenCommentIds: [...external.comments.map((c) => c.id), ...(this.pendingSeen.get(key) ?? [])],
        lastStatus: coarse(external.status),
      });
      this.pendingSeen.delete(key);
      // Everything already on the PSA ticket is Haley's to mirror only from now on.
      this.store.updateTicketLink(received.ticketId, connection.id, {
        pushedEventIds: this.store.listTicketEvents(received.ticketId).map((e) => e.id),
      });
      result.imported++;
      return;
    }

    const ticket = this.store.getTicket(link.ticket_id);
    if (!ticket) return;
    const fresh = external.comments.filter((c) => !link.seen_comment_ids.includes(c.id));
    for (const comment of fresh) {
      if (comment.fromCustomer && comment.public) {
        this.hub.appendToTicket(this.store.getTicket(ticket.id)!, {
          channel: connection.kind,
          author: comment.author || external.requesterName || "Requester",
          email: external.requesterEmail,
          assurance: connection.options.requesterAssurance,
          text: comment.body,
        });
      } else {
        // A technician worked the ticket in the PSA: keep the record, don't wake Haley.
        this.store.addTicketEvent(ticket.id, "comment", comment.author || connection.name, comment.body, {
          channel: connection.kind,
          fromTechnician: true,
          internal: !comment.public,
        });
      }
      result.commentsImported++;
    }
    const externalStatus = coarse(external.status);
    let lastStatus = link.last_status;
    if (externalStatus && externalStatus !== link.last_status) {
      lastStatus = externalStatus;
      if (externalStatus === "resolved" && coarse(ticket.status) !== "resolved") {
        this.store.updateTicket(ticket.id, { status: external.status === "closed" ? "closed" : "resolved" }, connection.name);
        result.statusUpdates++;
      }
    }
    this.store.updateTicketLink(ticket.id, connection.id, {
      seenCommentIds: [...link.seen_comment_ids, ...fresh.map((c) => c.id)],
      lastStatus,
    });
  }

  /** Mirrors new timeline events and status changes to linked PSA tickets. */
  private async push(connection: PsaConnection, adapter: PsaAdapter, result: SyncResult) {
    const since = connection.last_sync_at ?? "";
    for (const link of this.store.listTicketLinks({ connectionId: connection.id })) {
      const ticket = this.store.getTicket(link.ticket_id);
      if (!ticket || (since && ticket.updated_at < since && coarse(ticket.status) === link.last_status)) continue;
      const pushed = [...link.pushed_event_ids];
      const seen = [...link.seen_comment_ids];
      if (connection.options.mirrorNotes) {
        for (const event of this.store.listTicketEvents(ticket.id)) {
          // Imported tickets start with their history marked pushed; exported ones mirror their history once.
          if (pushed.includes(event.id)) continue;
          const text = mirrorText(event, ticket, connection.kind);
          pushed.push(event.id);
          if (!text) continue;
          seen.push(await adapter.addComment(link.external_id, { body: text, public: false }));
          result.pushed++;
        }
      }
      const status = coarse(ticket.status);
      let lastStatus = link.last_status;
      if (status && status !== link.last_status) {
        await adapter.setStatus(link.external_id, ticket.status);
        lastStatus = status;
        result.statusUpdates++;
      }
      this.store.updateTicketLink(ticket.id, connection.id, { pushedEventIds: pushed, seenCommentIds: seen, lastStatus });
    }
  }

  /** Creates PSA tickets for Haley tickets of mapped clients that started elsewhere. */
  private async exportNew(connection: PsaConnection, adapter: PsaAdapter, result: SyncResult) {
    const customerFor = new Map<string, string>();
    for (const [customerId, orgId] of Object.entries(connection.customer_map)) if (!customerFor.has(orgId)) customerFor.set(orgId, customerId);
    for (const [orgId, customerId] of customerFor) {
      for (const ticket of this.store.listTickets({ orgId, limit: 500 })) {
        if (ticket.created_at < connection.created_at || ticket.channel === connection.kind) continue;
        if (this.store.getTicketLink(ticket.id, connection.id)) continue;
        const created = await adapter.createTicket({
          customerId,
          subject: `[Haley #${ticket.number}] ${ticket.title}`,
          description: `${ticket.description || ticket.title}\n\nRequester: ${ticket.requester_name} <${ticket.requester_email}> via ${ticket.channel}. Haley is handling this ticket; updates are mirrored here.`,
          requesterEmail: ticket.requester_email || null,
          priority: ticket.priority,
        });
        this.store.createTicketLink({
          ticketId: ticket.id,
          connectionId: connection.id,
          externalId: created.id,
          externalNumber: created.number,
          lastStatus: "new",
        });
        this.store.addTicketEvent(ticket.id, "field_change", connection.name, `Linked to ${connection.name} ticket #${created.number}.`, {
          psa: connection.id,
          externalId: created.id,
        });
        result.exported++;
      }
    }
  }
}
