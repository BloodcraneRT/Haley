import type { TicketPriority, TicketStatus } from "../types.js";
import { registerPsaFactory } from "./registry.js";
import type { ExternalComment, ExternalCustomer, ExternalTicket, PsaAdapter } from "./types.js";

type Json = Record<string, any>;

/** Consumer mailbox domains say nothing about which business a customer is. */
const FREE_MAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "live.com", "aol.com", "proton.me", "protonmail.com", "msn.com"]);
const MAX_PAGES = 40;
/** On the first sync, only look back this far. */
const FIRST_SYNC_LOOKBACK_MS = 7 * 86_400_000;

const domainOf = (email: string | null | undefined) => (email?.includes("@") ? email.split("@")[1].toLowerCase() : null);

/** Syncro statuses are account-customizable; unknown ones count as "in progress". */
export function fromSyncroStatus(status: string): TicketStatus {
  const s = status.toLowerCase();
  if (s === "new") return "new";
  if (s === "resolved" || s === "invoiced") return "resolved";
  if (s === "waiting on customer") return "waiting_on_customer";
  return "in_progress";
}

export function toSyncroStatus(status: TicketStatus): string {
  if (status === "new") return "New";
  if (status === "resolved" || status === "closed") return "Resolved";
  if (status === "waiting_on_customer") return "Waiting on Customer";
  return "In Progress";
}

function fromSyncroPriority(priority: unknown): TicketPriority | null {
  const p = String(priority ?? "").toLowerCase();
  if (!p) return null;
  if (p.includes("urgent") || p.includes("emergency") || p.startsWith("0")) return "urgent";
  if (p.includes("high") || p.startsWith("1")) return "high";
  if (p.includes("low") || p.startsWith("3")) return "low";
  return "normal";
}

const TO_SYNCRO_PRIORITY: Record<TicketPriority, string> = { urgent: "0 Urgent", high: "1 High", normal: "2 Normal", low: "3 Low" };

export interface SyncroConfig {
  subdomain: string;
  apiKey: string;
  /** Problem type for tickets Haley creates; must be one the account allows. */
  problemType?: string;
}

/** SyncroMSP REST API v1 (https://api-docs.syncromsp.com). 180 requests/minute per IP. */
export class SyncroAdapter implements PsaAdapter {
  readonly kind = "syncro" as const;
  private readonly base: string;

  constructor(
    private readonly config: SyncroConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowMs: () => number = Date.now,
  ) {
    const sub = config.subdomain.trim().replace(/^https?:\/\//, "").replace(/\.syncromsp\.com.*$/, "");
    this.base = `https://${sub}.syncromsp.com/api/v1`;
  }

  private async call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const detail = Array.isArray(data.message) ? data.message.join("; ") : (data.error ?? data.message ?? res.statusText);
      if (res.status === 429) throw new Error("SyncroMSP rate limit reached (180 requests/minute); the next sync will continue.");
      throw new Error(`SyncroMSP ${method} ${path.split("?")[0]} failed (${res.status}): ${detail}`);
    }
    return data as T;
  }

  private async pages<T>(path: string, key: string): Promise<T[]> {
    const items: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.call<Json>("GET", `${path}${sep}page=${page}`);
      items.push(...((data[key] ?? []) as T[]));
      if (page >= Number(data.meta?.total_pages ?? 1)) break;
    }
    return items;
  }

  async test() {
    const data = await this.call<Json>("GET", "/customers?page=1");
    const total = data.meta?.total_entries ?? (data.customers ?? []).length;
    return `Connected to ${this.base.replace("/api/v1", "")} (${total} customers visible).`;
  }

  async listCustomers(): Promise<ExternalCustomer[]> {
    const customers = await this.pages<Json>("/customers", "customers");
    return customers
      .filter((c) => !c.disabled)
      .map((c) => {
        const domains = [c.email, ...(c.contacts ?? []).map((x: Json) => x.email)]
          .map(domainOf)
          .filter((d): d is string => Boolean(d) && !FREE_MAIL.has(d!));
        return { id: String(c.id), name: c.business_name || c.fullname || c.business_then_name || `Customer ${c.id}`, domains: [...new Set(domains)] };
      });
  }

  private async comments(ticketId: string): Promise<Json[]> {
    const out: Json[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.call<Json>("GET", `/tickets/${ticketId}/comments?sort_by=created_at&sort_direction=ASC&per_page=100&page=${page}`);
      out.push(...(data.comments ?? []));
      if (page >= Number(data.meta?.total_pages ?? 1)) break;
    }
    return out;
  }

  async getTicket(id: string): Promise<ExternalTicket> {
    const [{ ticket: t }, comments] = await Promise.all([this.call<Json>("GET", `/tickets/${id}`), this.comments(id)]);
    const first = comments[0];
    const mapped: ExternalComment[] = comments.slice(first ? 1 : 0).map((c) => ({
      id: String(c.id),
      body: String(c.body ?? ""),
      author: String(c.tech ?? c.user?.full_name ?? ""),
      // Comments written by a Syncro user (technician) carry a user_id; customer replies don't.
      fromCustomer: c.user_id == null,
      public: !c.hidden,
      createdAt: c.created_at,
    }));
    const contact = t.contact ?? null;
    return {
      id: String(t.id),
      number: String(t.number ?? t.id),
      subject: t.subject ?? "",
      description: first ? String(first.body ?? "") : "",
      customerId: String(t.customer_id),
      customerName: t.customer_business_then_name ?? t.customer?.business_name ?? t.customer?.fullname ?? "",
      requesterEmail: (contact?.email ?? t.customer?.email ?? null)?.toLowerCase() ?? null,
      requesterName: contact?.name ?? t.contact_fullname ?? t.customer?.fullname ?? "",
      status: fromSyncroStatus(String(t.status ?? "")),
      externalStatus: String(t.status ?? ""),
      priority: fromSyncroPriority(t.priority),
      updatedAt: t.updated_at,
      // The first comment is the ticket's description; it's always "seen".
      comments: first ? [{ id: String(first.id), body: String(first.body ?? ""), author: String(first.tech ?? ""), fromCustomer: false, public: !first.hidden, createdAt: first.created_at }, ...mapped] : mapped,
    };
  }

  async listUpdatedTickets(since: string | null): Promise<ExternalTicket[]> {
    const from = since ?? new Date(this.nowMs() - FIRST_SYNC_LOOKBACK_MS).toISOString();
    const summaries = await this.pages<Json>(`/tickets?since_updated_at=${encodeURIComponent(from)}`, "tickets");
    const changed = summaries.filter((t) => !since || t.updated_at > since).sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
    const tickets: ExternalTicket[] = [];
    for (const summary of changed) tickets.push(await this.getTicket(String(summary.id)));
    return tickets;
  }

  async addComment(ticketId: string, comment: { body: string; public: boolean }): Promise<string> {
    const data = await this.call<Json>("POST", `/tickets/${ticketId}/comment`, {
      subject: comment.public ? "Update" : "Haley note",
      body: comment.body,
      hidden: !comment.public,
      // Public comments email the customer: that's how Haley's replies reach them.
      do_not_email: !comment.public,
      tech: "Haley",
    });
    return String(data.comment?.id ?? "");
  }

  async setStatus(ticketId: string, status: TicketStatus): Promise<void> {
    await this.call("PUT", `/tickets/${ticketId}`, { status: toSyncroStatus(status) });
  }

  async createTicket(input: { customerId: string; subject: string; description: string; requesterEmail: string | null; priority: TicketPriority }) {
    let contactId: number | undefined;
    if (input.requesterEmail) {
      const contacts = await this.pages<Json>(`/contacts?customer_id=${encodeURIComponent(input.customerId)}`, "contacts");
      contactId = contacts.find((c) => String(c.email ?? "").toLowerCase() === input.requesterEmail!.toLowerCase())?.id;
    }
    const data = await this.call<Json>("POST", "/tickets", {
      customer_id: Number(input.customerId),
      ...(contactId ? { contact_id: contactId } : {}),
      subject: input.subject,
      problem_type: this.config.problemType || "Other",
      status: "New",
      priority: TO_SYNCRO_PRIORITY[input.priority],
      comments_attributes: [{ subject: "Initial Issue", body: input.description, hidden: false, do_not_email: true, tech: "Haley" }],
    });
    return { id: String(data.ticket.id), number: String(data.ticket.number ?? data.ticket.id) };
  }
}

registerPsaFactory("syncro", (_connection, config, fetchImpl) =>
  new SyncroAdapter({ subdomain: config.subdomain, apiKey: config.apiKey, problemType: config.problemType }, fetchImpl),
);
