import type { Assurance, Org, Ticket, TicketChannel } from "../types.js";

export interface DeliveryResult {
  delivered: boolean;
  /** Where it went ("Slack thread", "email to megan@…") or why it didn't go anywhere. */
  detail: string;
}

/** Sends messages back to end users on the channel their ticket came from. */
export interface ChannelAdapter {
  channel: TicketChannel;
  /** Whether a message can be shown only to the verified requester (a DM), which is required for secrets. */
  supportsPrivate: boolean;
  send(ticket: Ticket, text: string, options?: { private?: boolean }): Promise<DeliveryResult>;
}

/** What the runner needs from the channel layer. */
export interface ReplyDelivery {
  deliverReply(ticket: Ticket, text: string): Promise<DeliveryResult>;
  /** Sends credentials straight to the verified requester, never through the model. */
  deliverSecret(ticket: Ticket, heading: string, secrets: Record<string, string>, actionId: string): Promise<DeliveryResult>;
}

export interface InboundMessage {
  channel: TicketChannel;
  org: Org;
  sender: {
    name: string;
    email: string | null;
    assurance: Assurance;
    /** Human-readable account of how identity was established, e.g. "Microsoft Teams (Entra ID sign-in)". */
    verification: string;
  };
  text: string;
  subject?: string;
  /** Channel reference identifying the conversation, used to thread follow-ups onto the same ticket. */
  thread: { key: string; value: string } | null;
  /** Ticket number the sender referenced (e.g. "[#1004]" in an email subject). */
  ticketNumber?: number;
  /** Routing info stored on a new ticket so replies can find their way back. */
  ref: Record<string, string>;
}

export interface InboundResult {
  ticketId: string;
  ticketNumber: number;
  created: boolean;
  runId: string | null;
}
