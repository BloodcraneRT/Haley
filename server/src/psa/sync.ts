import type { ChannelHub } from "../channels/hub.js";
import type { ChannelAdapter, DeliveryResult } from "../channels/types.js";
import type { Store } from "../store.js";
import type { Ticket, TicketEvent, TicketStatus } from "../types.js";
import { matchOwner } from "./owners.js";
import type { ExternalTicket, PsaAdapter, PsaConnection, PsaKind, TicketLink } from "./types.js";

export interface SyncResult {
  imported: number;
  commentsImported: number;
  exported: number;
  pushed: number;
  statusUpdates: number;
  /** Time entries added for Haley's work. */
  timeLogged: number;
  unmappedCustomers: string[];
  /** Technicians assigned in Haley who have no id in this PSA, so the assignment couldn't be sent. */
  ownersNotSent: string[];
  errors: string[];
  /** Set when the sync didn't run, with the reason. */
  skipped?: string;
}

/** Statuses both sides can agree on; finer-grained Haley statuses collapse to these for comparison. */
function coarse(status: TicketStatus | null): string {
  if (!status) return "";
  if (status === "resolved" || status === "closed") return "resolved";
  if (status === "waiting_on_customer") return "waiting_on_customer";
  if (status === "new") return "new";
  return "in_progress";
}

/** Gaps between a run's model calls longer than this are waiting (for approval, a reply), not work. */
const IDLE_GAP_MS = 5 * 60_000;

/**
 * Minutes Haley actually worked on a run, from when its model calls finished: gaps up to five minutes count
 * (thinking plus tool calls), longer gaps count as one minute of work, and the first turn counts as a minute.
 */
export function workingMinutes(callTimes: string[]): number {
  const times = callTimes.map((t) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!times.length) return 0;
  let ms = 60_000;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    ms += gap <= IDLE_GAP_MS ? gap : 60_000;
  }
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** A PSA ticket that fails to import this many syncs in a row is set aside so newer tickets keep flowing. */
export const MAX_PULL_ATTEMPTS = 3;

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
  /** Consecutive failed imports per connection:external id. In memory: a restart gives each ticket fresh tries. */
  private readonly pullFailures = new Map<string, number>();

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
        const adapter = this.adapterFor(connection);
        const commentId = await adapter.addComment(externalId, { body: text, public: true });
        this.markSeen(ticket.id, connection.id, externalId, [commentId]);
        const recorded = `${connection.name} ticket #${externalNumber || externalId}`;
        if (adapter.notifiesCustomer === false) {
          // The PSA won't tell the customer, so email them too.
          const emailed = await this.hub.deliverByEmail(ticket, text);
          return emailed.delivered ? { delivered: true, detail: `${recorded} and ${emailed.detail}` } : { delivered: false, detail: `Recorded on ${recorded}, but ${emailed.detail}` };
        }
        return { delivered: true, detail: recorded };
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
    const result: SyncResult = { imported: 0, commentsImported: 0, exported: 0, pushed: 0, statusUpdates: 0, timeLogged: 0, unmappedCustomers: [], ownersNotSent: [], errors: [] };
    const connection = this.store.getPsaConnection(connectionId);
    if (!connection) return { ...result, skipped: "The connection no longer exists." };
    if (!connection.enabled) return { ...result, skipped: "Sync is paused for this connection." };
    if (this.running.has(connectionId)) return { ...result, skipped: "A sync is already running for this connection." };
    this.running.add(connectionId);
    const startedAt = new Date().toISOString();
    try {
      const adapter = this.adapterFor(connection);
      const tickets = await adapter.listUpdatedTickets(connection.cursor);
      // Tickets arrive oldest first. The cursor moves up to the first ticket that failed, so the next sync retries
      // it (and replays only what came after it). A ticket that keeps failing is set aside after a few tries.
      let cursor = connection.cursor;
      let blocked = false;
      for (const external of tickets) {
        const key = `${connection.id}:${external.id}`;
        try {
          await this.pull(connection, external, result);
          this.pullFailures.delete(key);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const attempts = (this.pullFailures.get(key) ?? 0) + 1;
          if (attempts >= MAX_PULL_ATTEMPTS) {
            this.pullFailures.delete(key);
            result.errors.push(`Ticket ${external.number || external.id} skipped after ${attempts} failed imports: ${message}`);
            this.store.audit({ actor: connection.name, action: "psa.ticket_skipped", target: connectionId, detail: { externalId: external.id, number: external.number, error: message } });
          } else {
            this.pullFailures.set(key, attempts);
            result.errors.push(`Ticket ${external.number || external.id}: ${message}`);
            blocked = true;
          }
        }
        if (!blocked && (!cursor || external.updatedAt > cursor)) cursor = external.updatedAt;
      }
      // Save import progress before pushing, so a failing push or export can't undo it.
      this.store.updatePsaConnection(connectionId, { cursor });
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
      this.applyOwner(connection, received.ticketId, external);
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
    this.applyOwner(connection, ticket.id, external);
  }

  /**
   * When the PSA ticket's owner changes, assign the Haley ticket to the matching technician. An owner that hasn't
   * changed since the last sync leaves the Haley assignment alone, so assigning someone in Haley sticks.
   */
  private applyOwner(connection: PsaConnection, ticketId: string, external: ExternalTicket) {
    if (external.owner === undefined) return;
    const link = this.store.getTicketLink(ticketId, connection.id);
    const ownerId = external.owner?.id ?? "";
    if (!link || ownerId === link.last_owner) return;
    this.store.updateTicketLink(ticketId, connection.id, { lastOwner: ownerId });
    const technician = matchOwner(this.store, connection.id, external.owner);
    const ticket = this.store.getTicket(ticketId);
    if (technician && ticket && ticket.assignee !== technician.name) this.store.updateTicket(ticketId, { assignee: technician.name }, connection.name);
  }

  /** With "send assignments", sets the PSA owner to the technician the ticket is assigned to in Haley. */
  private async pushOwner(connection: PsaConnection, adapter: PsaAdapter, link: TicketLink, ticket: Ticket, result: SyncResult): Promise<string> {
    if (!connection.options.syncOwner || !adapter.setOwner || !ticket.assignee) return link.last_owner;
    const technician = this.store.findTechnician({ name: ticket.assignee });
    if (!technician) return link.last_owner;
    const ref = technician.psa_refs[connection.id];
    if (!ref) {
      if (!result.ownersNotSent.includes(technician.name)) result.ownersNotSent.push(technician.name);
      return link.last_owner;
    }
    if (ref === link.last_owner) return ref;
    try {
      await adapter.setOwner(link.external_id, ref);
      return ref;
    } catch (err) {
      result.errors.push(`Assigning #${link.external_number || link.external_id} to ${technician.name}: ${err instanceof Error ? err.message : String(err)}`);
      return link.last_owner;
    }
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
      const lastOwner = await this.pushOwner(connection, adapter, link, ticket, result);
      this.store.updateTicketLink(ticket.id, connection.id, { pushedEventIds: pushed, seenCommentIds: seen, lastStatus, lastOwner });
      if (connection.options.timeEntries && connection.options.timeEntries !== "off" && adapter.logTime) {
        await this.logTime(connection, adapter, { ...link, pushed_event_ids: pushed, seen_comment_ids: seen, last_status: lastStatus }, ticket, result);
      }
    }
  }

  /** Adds PSA time entries for Haley's work on a linked ticket that hasn't been logged yet. */
  private async logTime(connection: PsaConnection, adapter: PsaAdapter, link: TicketLink, ticket: Ticket, result: SyncResult) {
    const since = connection.options.timeEntriesSince ?? connection.created_at;
    const logged = [...link.logged_time];
    const record = async (key: string, startedAt: string, minutes: number, notes: string) => {
      try {
        const entryId = await adapter.logTime!(link.external_id, { startedAt, minutes, notes });
        logged.push(key);
        // Some PSAs record time as a ticket note/action (HaloPSA): it mustn't come back as a technician comment.
        const current = this.store.getTicketLink(ticket.id, connection.id);
        const seen = entryId && current && !current.seen_comment_ids.includes(entryId) ? [...current.seen_comment_ids, entryId] : undefined;
        const entries = entryId && current ? [...current.time_entry_ids, entryId] : undefined;
        this.store.updateTicketLink(ticket.id, connection.id, { loggedTime: logged, ...(seen ? { seenCommentIds: seen } : {}), ...(entries ? { timeEntryIds: entries } : {}) });
        result.timeLogged++;
      } catch (err) {
        // Retried on the next sync; a missing permission shows on the connection's status.
        result.errors.push(`Logging time on #${link.external_number || link.external_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    if (connection.options.timeEntries === "actual") {
      for (const run of this.store.listRuns({ ticketId: ticket.id })) {
        const key = `run:${run.id}`;
        if (run.mode !== "live" || run.status !== "completed" || run.updated_at < since || logged.includes(key)) continue;
        const calls = this.store.runModelCallTimes(run.id);
        const minutes = workingMinutes(calls);
        if (!minutes) continue;
        const summary = run.summary.trim() ? `\n\n${run.summary.trim().slice(0, 1500)}` : "";
        await record(key, calls[0] ?? run.created_at, minutes, `Haley (AI technician) worked this ticket for about ${minutes} min.${summary}`);
      }
      return;
    }

    // estimate: once, when Haley resolved the ticket, at the workspace's minutes per ticket.
    if (logged.includes("estimate") || !ticket.resolved_at || ticket.resolved_at < since) return;
    if (ticket.status !== "resolved" && ticket.status !== "closed") return;
    const lastResolve = this.store.listTicketEvents(ticket.id).findLast((e) => e.kind === "status_change" && e.meta.to === "resolved");
    if (lastResolve?.author !== "haley") return;
    const minutes = Math.max(1, Math.round(this.store.getBillingSettings().minutesPerTicket));
    const startedAt = new Date(Date.parse(ticket.resolved_at) - minutes * 60_000).toISOString();
    await record("estimate", startedAt, minutes, `Resolved by Haley (AI technician). Logged at the workspace estimate of ${minutes} technician minutes per ticket.`);
  }

  /** Creates PSA tickets for Haley tickets of mapped clients that started elsewhere. */
  private async exportNew(connection: PsaConnection, adapter: PsaAdapter, result: SyncResult) {
    const customerFor = new Map<string, string>();
    for (const [customerId, orgId] of Object.entries(connection.customer_map)) if (!customerFor.has(orgId)) customerFor.set(orgId, customerId);
    for (const [orgId, customerId] of customerFor) {
      for (const ticket of this.store.listTicketsAwaitingPsaExport(connection, orgId)) {
        // One ticket the PSA rejects mustn't hold up the others; it's retried on the next sync.
        try {
          await this.exportOne(connection, adapter, customerId, ticket);
          result.exported++;
        } catch (err) {
          result.errors.push(`Exporting Haley #${ticket.number}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  private async exportOne(connection: PsaConnection, adapter: PsaAdapter, customerId: string, ticket: Ticket) {
    const created = await adapter.createTicket({
      customerId,
      subject: `[Haley #${ticket.number}] ${ticket.title}`,
      description: `${ticket.description || ticket.title}\n\n${
        ticket.channel === "monitoring" ? "Opened by Haley from a monitoring alert" : `Requester: ${ticket.requester_name} <${ticket.requester_email}> via ${ticket.channel}`
      }. Haley is handling this ticket; updates are mirrored here.`,
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
  }
}
