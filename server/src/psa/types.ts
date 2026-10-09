import type { TicketPriority, TicketStatus } from "../types.js";

export type PsaKind = "syncro" | "dynamics" | "connectwise" | "autotask" | "halopsa";

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

/** A closed ticket, summarised for the "What would Haley handle?" report (no comments, to keep it cheap). */
export interface HistoricTicket {
  id: string;
  subject: string;
  /** The first 2,000 characters. */
  description: string;
  customerId: string;
  customerName: string;
  createdAt: string;
  closedAt: string;
  /** Technician time recorded on the ticket, when the PSA keeps it on the ticket itself. */
  minutesSpent: number | null;
  category: string | null;
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
  /** Adds a time entry for Haley's work to the PSA ticket and returns its id. PSAs without it don't log time. */
  logTime?(ticketId: string, entry: TimeEntry): Promise<string>;
  /** The MSP's saved replies matching a search. */
  findCannedResponses?(query: string): Promise<CannedResponse[]>;
  /** A customer's contracts (agreements), for checking what work is covered. */
  listContracts?(customerId: string): Promise<Contract[]>;
  /** Books an appointment (e.g. an on-site visit) on the PSA calendar, linked to a ticket when given. */
  createAppointment?(input: AppointmentInput): Promise<{ id: string }>;
  /** Tickets closed in [from, to), newest first, at most `max` (for the automation report). */
  listClosedTickets?(from: string, to: string, opts: { max: number }): Promise<HistoricTicket[]>;
}

export interface CannedResponse {
  title: string;
  subject: string;
  body: string;
  category: string;
}

export interface Contract {
  id: string;
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  description: string;
  /** Products (labor, services) with contracted pricing. */
  coveredProductIds: string[];
  /** Products the contract makes non-billable. */
  nonBillableProductIds: string[];
}

export interface AppointmentInput {
  customerId: string;
  /** The PSA ticket it's for, if any. */
  ticketId: string | null;
  summary: string;
  description: string;
  startAt: string;
  endAt: string;
  location?: string;
  /** Let the PSA email the customer about it. */
  emailCustomer: boolean;
}

export interface TimeEntry {
  startedAt: string;
  minutes: number;
  notes: string;
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
  /**
   * Time entries for Haley's work on synced tickets: "actual" logs each run's working time, "estimate" logs the
   * workspace's minutes-per-ticket once when Haley resolves a ticket. Only PSAs that support it.
   */
  timeEntries: "off" | "actual" | "estimate";
  /** When time entries were turned on; earlier work isn't logged retroactively. Set by the server. */
  timeEntriesSince?: string;
}

export const DEFAULT_PSA_OPTIONS: PsaOptions = {
  importTickets: true,
  exportTickets: true,
  mirrorNotes: true,
  requesterAssurance: "none",
  timeEntries: "off",
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
  /** Work already logged as PSA time: "run:<id>" per run, or "estimate" once per ticket. */
  logged_time: string[];
  last_status: string;
  created_at: string;
}
