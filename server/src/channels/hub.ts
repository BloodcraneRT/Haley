import type { Store } from "../store.js";
import { ASSURANCE_RANK, type Run, type Ticket, type TicketChannel } from "../types.js";
import type { ChannelAdapter, DeliveryResult, InboundMessage, InboundResult, ReplyDelivery } from "./types.js";

export interface RunStarter {
  startTicketRun(ticketId: string, createdBy: string): Run;
  activeRun(ticketId: string): Run | undefined;
}

const SECRET_LABELS: Record<string, string> = {
  temporaryPassword: "Temporary password",
  temporaryAccessPass: "Temporary Access Pass",
  userPrincipalName: "Username",
  primaryEmail: "Username",
};

/** New tickets per requester per hour that Haley picks up automatically; beyond this they queue for technicians. */
export const MAX_NEW_TICKETS_PER_REQUESTER_PER_HOUR = 10;

function titleFrom(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "Help request";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/**
 * Connects end-user channels to tickets: inbound messages open or continue tickets and start Haley,
 * and replies go back out on the channel the ticket came from.
 */
export class ChannelHub implements ReplyDelivery {
  private readonly adapters = new Map<TicketChannel, ChannelAdapter>();
  private runs: RunStarter | null = null;

  constructor(private readonly store: Store) {}

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  attach(runs: RunStarter): void {
    this.runs = runs;
  }

  has(channel: TicketChannel): boolean {
    return this.adapters.has(channel);
  }

  private adapterFor(ticket: Ticket): ChannelAdapter | null {
    const direct = this.adapters.get(ticket.channel);
    if (direct) return direct;
    // Tickets opened in the dashboard or through the API can still be answered by email.
    if ((ticket.channel === "portal" || ticket.channel === "api") && ticket.requester_email) return this.adapters.get("email") ?? null;
    return null;
  }

  async deliverReply(ticket: Ticket, text: string): Promise<DeliveryResult> {
    const adapter = this.adapterFor(ticket);
    if (!adapter) return { delivered: false, detail: "Posted on the ticket; no outbound channel is configured for this requester." };
    try {
      return await adapter.send(ticket, text);
    } catch (err) {
      return { delivered: false, detail: `Delivery over ${adapter.channel} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async deliverSecret(ticket: Ticket, heading: string, secrets: Record<string, string>): Promise<DeliveryResult> {
    if (ASSURANCE_RANK[ticket.assurance] < ASSURANCE_RANK.chat) {
      return { delivered: false, detail: "The requester's identity isn't strong enough to receive credentials." };
    }
    const adapter = this.adapters.get(ticket.channel);
    if (!adapter?.supportsPrivate || ticket.channel_ref.private !== "1") {
      return { delivered: false, detail: `A ${ticket.channel} conversation can't carry credentials privately.` };
    }
    const lines = Object.entries(secrets).map(([k, v]) => `${SECRET_LABELS[k] ?? k}: \`${v}\``);
    const text = `${heading}\n\n${lines.join("\n")}\n\nUse it to sign in now; you'll be asked to set up your own password or sign-in method. Don't share this message.`;
    try {
      return await adapter.send(ticket, text, { private: true });
    } catch (err) {
      return { delivered: false, detail: `Private delivery failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Opens a ticket for a new conversation or appends to the existing one, then puts Haley on it. */
  async receive(msg: InboundMessage): Promise<InboundResult> {
    if (!this.runs) throw new Error("ChannelHub is not attached to the agent");
    const { org, sender } = msg;
    const author = sender.name || sender.email || "Requester";

    let ticket: Ticket | null = null;
    if (msg.ticketNumber) {
      const byNumber = this.store.getTicketByNumber(msg.ticketNumber);
      if (byNumber && byNumber.org_id === org.id) ticket = byNumber;
    }
    if (!ticket && msg.thread) ticket = this.store.findOpenTicketByChannelRef(org.id, msg.channel, msg.thread.key, msg.thread.value);

    if (ticket) {
      const fromRequester = Boolean(sender.email) && sender.email!.toLowerCase() === ticket.requester_email.toLowerCase();
      this.store.addTicketEvent(ticket.id, "comment", author, msg.text, {
        channel: msg.channel,
        fromRequester,
        senderEmail: sender.email,
        assurance: sender.assurance,
      });
      if (["resolved", "closed", "waiting_on_customer"].includes(ticket.status) && ticket.assignee === "haley") {
        this.store.setTicketStatus(ticket.id, "in_progress", msg.channel);
      }
      // A technician owns escalated tickets (and all tickets while Haley is paused); the message is on the timeline for them.
      if (ticket.status === "escalated" || ticket.assignee !== "haley" || org.settings.paused) {
        return { ticketId: ticket.id, ticketNumber: ticket.number, created: false, runId: null };
      }
      if (this.runs.activeRun(ticket.id)) {
        this.store.setNeedsFollowup(ticket.id, true);
        return { ticketId: ticket.id, ticketNumber: ticket.number, created: false, runId: null };
      }
      const run = this.runs.startTicketRun(ticket.id, msg.channel);
      return { ticketId: ticket.id, ticketNumber: ticket.number, created: false, runId: run.id };
    }

    const flooding =
      Boolean(sender.email) &&
      this.store.countTicketsFromRequesterSince(org.id, sender.email!, new Date(Date.now() - 3_600_000).toISOString()) >=
        MAX_NEW_TICKETS_PER_REQUESTER_PER_HOUR;
    const created = this.store.createTicket({
      orgId: org.id,
      title: msg.subject?.trim() || titleFrom(msg.text),
      description: msg.text,
      requesterName: sender.name,
      requesterEmail: sender.email ?? "",
      author,
      channel: msg.channel,
      channelRef: msg.ref,
      assurance: sender.assurance,
      verification: sender.verification,
    });
    this.store.audit({
      orgId: org.id,
      actor: msg.channel,
      action: "ticket.created",
      target: created.id,
      detail: { number: created.number, from: sender.email, assurance: sender.assurance },
    });
    const firstName = sender.name.split(" ")[0] || "there";
    if (flooding) {
      this.store.audit({ orgId: org.id, actor: msg.channel, action: "intake.throttled", target: created.id, detail: { from: sender.email } });
    }
    if (org.settings.paused || flooding) {
      this.store.updateTicket(created.id, { assignee: "unassigned" }, "system");
      const ackText = `Hi ${firstName}, the IT team has your request (ticket #${created.number}) and will be in touch here.`;
      const delivery = await this.deliverReply(created, ackText);
      this.store.addTicketEvent(created.id, "reply", "system", ackText, { auto: true, delivery });
      return { ticketId: created.id, ticketNumber: created.number, created: true, runId: null };
    }
    const ackText = `Hi ${firstName}, I'm Haley from IT. I've got your request (ticket #${created.number}) and I'm looking into it now. I'll update you here.`;
    const delivery = await this.deliverReply(created, ackText);
    this.store.addTicketEvent(created.id, "reply", "haley", ackText, { auto: true, delivery });
    const run = this.runs.startTicketRun(created.id, msg.channel);
    return { ticketId: created.id, ticketNumber: created.number, created: true, runId: run.id };
  }
}
