import type { TicketPriority, TicketStatus } from "../types.js";

export type PsaKind = "syncro" | "dynamics";

export interface ExternalComment {
  id: string;
  body: string;
  author: string;
  /** Written by the customer/contact (not a technician or automation). */
  fromCustomer: boolean;
  public: boolean;
  createdAt: string;
}

export interface ExternalTicket {
  id: string;
  /** Human-facing ticket/case number in the PSA. */
  number: string;
  subject: string;
  description: string;
  customerId: string;
  customerName: string;
  requesterEmail: string | null;
  requesterName: string;
  /** Haley's equivalent of the PSA status, or null if it has none. */
  status: TicketStatus | null;
  externalStatus: string;
  priority: TicketPriority | null;
  updatedAt: string;
  comments: ExternalComment[];
}

export interface ExternalCustomer {
  id: string;
  name: string;
  /** Email/web domains that identify the customer, used to suggest a client mapping. */
  domains: string[];
}

/** What Haley needs from a PSA or service desk to keep tickets in sync both ways. */
export interface PsaAdapter {
  kind: PsaKind;
  /** Whether a public comment reaches the customer (Syncro emails them; a Dynamics note doesn't). Default true. */
  notifiesCustomer?: boolean;
  test(): Promise<string>;
  listCustomers(): Promise<ExternalCustomer[]>;
  /** Tickets changed since the cursor (ISO time), oldest first; null means a first sync. */
  listUpdatedTickets(since: string | null): Promise<ExternalTicket[]>;
  getTicket(id: string): Promise<ExternalTicket>;
  /** Returns the new comment's id so it isn't imported back as a customer message. */
  addComment(ticketId: string, comment: { body: string; public: boolean }): Promise<string>;
  setStatus(ticketId: string, status: TicketStatus): Promise<void>;
  createTicket(input: {
    customerId: string;
    subject: string;
    description: string;
    requesterEmail: string | null;
    priority: TicketPriority;
  }): Promise<{ id: string; number: string }>;
}

export interface PsaOptions {
  /** Import new PSA tickets for mapped customers and let Haley work them. */
  importTickets: boolean;
  /** Create PSA tickets for tickets that start in Haley (email, Slack, Teams…), so billing sees them. */
  exportTickets: boolean;
  /** Mirror Haley's notes and actions as internal (hidden) PSA comments. */
  mirrorNotes: boolean;
  /** Identity level given to requesters of imported tickets ("none" unless the PSA authenticates them). */
  requesterAssurance: "none" | "email";
}

export const DEFAULT_PSA_OPTIONS: PsaOptions = {
  importTickets: true,
  exportTickets: true,
  mirrorNotes: true,
  requesterAssurance: "none",
};

export interface PsaConnection {
  id: string;
  kind: PsaKind;
  name: string;
  /** External customer id → Haley org id. */
  customer_map: Record<string, string>;
  options: PsaOptions;
  cursor: string | null;
  enabled: boolean;
  status: "unknown" | "connected" | "error";
  status_detail: string;
  last_sync_at: string | null;
  created_at: string;
}

export interface TicketLink {
  ticket_id: string;
  connection_id: string;
  external_id: string;
  external_number: string;
  /** Comment ids already imported or posted by Haley. */
  seen_comment_ids: string[];
  /** Haley timeline events already mirrored upstream. */
  pushed_event_ids: string[];
  last_status: string;
  created_at: string;
}
