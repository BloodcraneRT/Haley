import type { Store } from "../store.js";
import { fixDidNotHold } from "../frustration.js";
import { ASSURANCE_RANK, effectiveAssurance, type Assurance, type Run, type Ticket, type TicketChannel } from "../types.js";

/** One-time credential links expire after this long. */
export const SECRET_LINK_TTL_MS = 15 * 60_000;
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
/** How long after Haley resolves a chat ticket the requester's next message still continues it (to confirm or reopen). */
export const RESOLUTION_REPLY_WINDOW_MS = 24 * 3_600_000;

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

  constructor(
    private readonly store: Store,
    /** Public base URL, for one-time secret links. */
    private readonly publicUrl = "",
  ) {}

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

  /** The requester's private status page for a ticket (signed, expiring link). */
  statusLink(ticket: Ticket): string | null {
    return this.publicUrl ? `${this.publicUrl}/t/${this.store.statusToken(ticket.id)}` : null;
  }

  async deliverReply(ticket: Ticket, text: string): Promise<DeliveryResult> {
    const adapter = this.adapterFor(ticket);
    if (!adapter) return { delivered: false, detail: "Posted on the ticket; no outbound channel is configured for this requester." };
    // Emails carry a link to the request's status page, where the requester can follow, reply and confirm.
    const link = adapter.channel === "email" ? this.statusLink(ticket) : null;
    try {
      return await adapter.send(ticket, link ? `${text}\n\n—\nSee or reply to this request: ${link}` : text);
    } catch (err) {
      return { delivered: false, detail: `Delivery over ${adapter.channel} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async deliverByEmail(ticket: Ticket, text: string): Promise<DeliveryResult> {
    const email = this.adapters.get("email");
    if (!email || !ticket.requester_email) return { delivered: false, detail: "no email is configured to reach the requester." };
    try {
      return await email.send(ticket, text);
    } catch (err) {
      return { delivered: false, detail: `emailing the requester failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async deliverSecret(ticket: Ticket, heading: string, secrets: Record<string, string>, actionId: string): Promise<DeliveryResult> {
    const assurance = effectiveAssurance(ticket);
    if (ASSURANCE_RANK[assurance] < ASSURANCE_RANK.chat) {
      return { delivered: false, detail: "The requester's identity isn't strong enough to receive credentials." };
    }
    const adapter = this.adapters.get(ticket.channel);
    if (!adapter?.supportsPrivate || ticket.channel_ref.private !== "1") {
      // Email can't carry a credential, but a view-once link can once the owner approved an MFA push.
      const email = this.adapters.get("email");
      if (assurance === "mfa" && email && ticket.requester_email && this.publicUrl) {
        const token = this.store.createSecretLink(actionId, ticket.id, SECRET_LINK_TTL_MS);
        try {
          const sent = await email.send(
            ticket,
            `${heading}\n\nOpen this link within ${SECRET_LINK_TTL_MS / 60_000} minutes to see it. It works once:\n${this.publicUrl}/s/${token}\n\nIf you didn't ask for this, reply to this email right away.`,
          );
          return sent.delivered ? { delivered: true, detail: `One-time link emailed to ${ticket.requester_email}` } : sent;
        } catch (err) {
          return { delivered: false, detail: `Emailing the one-time link failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
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

  /**
   * A continuation can reuse the requester's authority only when the channel still establishes
   * the same person at least as strongly. Unverified messages cannot reuse a prior MFA step-up.
   */
  private canContinue(ticket: Ticket, email: string | null, assurance: Assurance): boolean {
    if (!email || email.toLowerCase() !== ticket.requester_email.toLowerCase()) return false;
    if (ASSURANCE_RANK[assurance] < ASSURANCE_RANK[ticket.assurance]) return false;
    return assurance !== "none" || effectiveAssurance(ticket) === "none";
  }

  /**
   * A new message on an existing ticket: record it, reopen if needed, and give Haley another pass
   * (now, or when her current pass ends). Technician-owned tickets just get the message.
   */
  appendToTicket(
    ticket: Ticket,
    msg: { channel: TicketChannel; author: string; email: string | null; assurance: Assurance; text: string },
  ): InboundResult {
    if (!this.runs) throw new Error("ChannelHub is not attached to the agent");
    const org = this.store.getOrg(ticket.org_id);
    const fromRequester = Boolean(msg.email) && msg.email!.toLowerCase() === ticket.requester_email.toLowerCase();
    const trusted = this.canContinue(ticket, msg.email, msg.assurance);
    this.store.addTicketEvent(ticket.id, "comment", msg.author, msg.text, {
      channel: msg.channel,
      fromRequester,
      senderEmail: msg.email,
      assurance: msg.assurance,
      ...(!trusted ? { untrustedContinuation: true } : {}),
    });
    // PSA comments still belong on the technician timeline, but must not enter owner-authorized runs.
    if (!trusted) return { ticketId: ticket.id, ticketNumber: ticket.number, created: false, runId: null };
    // A frustrated requester saying Haley's fix didn't hold goes to a person rather than a second attempt.
    const flagged = this.store.getTicket(ticket.id);
    if (
      fromRequester &&
      flagged?.flags.frustrated &&
      ticket.assignee === "haley" &&
      ticket.status !== "escalated" &&
      !org?.settings.paused &&
      !this.runs.activeRun(ticket.id) &&
      fixDidNotHold(msg.text, this.store.listTicketEvents(ticket.id))
    ) {
      this.store.addTicketEvent(
        ticket.id,
        "escalation",
        "haley",
        `Handed to a technician: the requester seems frustrated (${flagged.flags.frustrated.reason}) and says Haley's earlier fix didn't hold.`,
        { reason: "frustrated" },
      );
      this.store.updateTicket(ticket.id, { status: "escalated", assignee: "unassigned" }, "haley");
      this.store.audit({ orgId: ticket.org_id, actor: "haley", action: "ticket.escalated", target: ticket.id, detail: { reason: "frustrated" } });
      const text = "I'm sorry this is still happening. I've passed it to one of our technicians, who will pick it up with you here.";
      void this.deliverReply(this.store.getTicket(ticket.id)!, text).then((delivery) => this.store.addTicketEvent(ticket.id, "reply", "haley", text, { auto: true, delivery }));
      return { ticketId: ticket.id, ticketNumber: ticket.number, created: false, runId: null };
    }
    if (["resolved", "closed", "waiting_on_customer"].includes(ticket.status) && ticket.assignee === "haley") {
      this.store.setTicketStatus(ticket.id, "in_progress", "haley");
    }
    // A technician owns escalated tickets (and all tickets while Haley is paused); the message is on the timeline for them.
    if (ticket.status === "escalated" || ticket.assignee !== "haley" || org?.settings.paused) {
      return { ticketId: ticket.id, ticketNumber: ticket.number, created: false, runId: null };
    }
    if (this.runs.activeRun(ticket.id)) {
      this.store.setNeedsFollowup(ticket.id, true);
      return { ticketId: ticket.id, ticketNumber: ticket.number, created: false, runId: null };
    }
    const run = this.runs.startTicketRun(ticket.id, msg.channel);
    return { ticketId: ticket.id, ticketNumber: ticket.number, created: false, runId: run.id };
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
    if (!ticket && msg.thread) {
      const confirmSince = new Date(Date.now() - RESOLUTION_REPLY_WINDOW_MS).toISOString();
      ticket = this.store.findOpenTicketByChannelRef(org.id, msg.channel, msg.thread.key, msg.thread.value, confirmSince);
    }

    if (ticket && this.canContinue(ticket, sender.email, sender.assurance)) {
      return this.appendToTicket(ticket, { channel: msg.channel, author, email: sender.email, assurance: sender.assurance, text: msg.text });
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
