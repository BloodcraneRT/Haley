import { ConnectorError } from "../connectors/types.js";
import type { TicketPriority, TicketStatus } from "../types.js";
import { registerPsaFactory } from "./registry.js";
import type { ExternalComment, ExternalCustomer, ExternalTicket, PsaAdapter } from "./types.js";

type Json = Record<string, any>;

const PAGE_SIZE = 100;
const MAX_PAGES = 40;
/** On the first sync, only look back this far. */
const FIRST_SYNC_LOOKBACK_MS = 7 * 86_400_000;
/** Halo's built-in Closed status. */
const CLOSED_STATUS_ID = 9;

const hostOf = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

/** Halo returns times without a zone designator; they are UTC. */
const iso = (value: unknown): string => {
  const s = String(value ?? "");
  if (!s) return "";
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
};

const latest = (...values: unknown[]) =>
  values
    .map(iso)
    .filter((v) => v && !v.startsWith("1900") && !v.startsWith("0001"))
    .sort()
    .pop() ?? "";

const stripHtml = (html: string) =>
  html
    .replace(/<(br|\/p|\/div)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Halo statuses are configurable; names are matched loosely and the built-in ids (1 New, 9 Closed) are a fallback. */
export function fromHaloStatus(id: number, name: string): TicketStatus {
  const s = name.toLowerCase();
  if (id === CLOSED_STATUS_ID || /closed|cancel/.test(s)) return "closed";
  if (/resolved|complete/.test(s)) return "resolved";
  if ((!s && id === 1) || s === "new") return "new";
  if (/with (the )?(user|customer|client)|wait(ing)?( on| for)? (the )?(user|customer|client)|awaiting (user|customer|client)/.test(s)) return "waiting_on_customer";
  return "in_progress";
}

/** Default Halo priorities: 1 Critical, 2 High, 3 Medium, 4 Low. */
const FROM_PRIORITY: Record<number, TicketPriority> = { 1: "urgent", 2: "high", 3: "normal", 4: "low" };
const TO_PRIORITY: Record<TicketPriority, number> = { urgent: 1, high: 2, normal: 3, low: 4 };

type StatusKey = "new" | "in_progress" | "waiting_on_customer" | "closed";
const STATUS_NAMES: Record<StatusKey, RegExp> = {
  new: /^new$/i,
  in_progress: /^in progress$/i,
  waiting_on_customer: /^(with user|with customer|waiting on (user|customer|client)|awaiting (user|customer))$/i,
  closed: /^(closed|resolved)$/i,
};
const DEFAULT_STATUS: Partial<Record<StatusKey, number>> = { new: 1, in_progress: 2, closed: CLOSED_STATUS_ID };

export interface HaloConfig {
  /** Instance host, e.g. yourmsp.halopsa.com. */
  instance: string;
  clientId: string;
  clientSecret: string;
  /** Tenant name, only for Halo-hosted instances that need it. */
  tenant?: string;
  /** Ticket type for tickets Haley creates. */
  ticketTypeId?: string;
  statusNew?: string;
  statusInProgress?: string;
  statusWaiting?: string;
  statusClosed?: string;
}

/**
 * HaloPSA REST API with a client-credentials application. Tickets' conversation is their actions:
 * Haley's replies are actions visible to the end user with an email sent; her notes are hidden actions.
 */
export class HaloAdapter implements PsaAdapter {
  readonly kind = "halopsa" as const;
  /** Public actions are posted with sendemail, so Halo emails the end user. */
  readonly notifiesCustomer = true;
  private readonly root: string;
  private readonly api: string;
  private token: { value: string; expiresAt: number } | null = null;
  private statuses: Json[] | null = null;

  constructor(
    private readonly config: HaloConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowMs: () => number = Date.now,
  ) {
    const host = config.instance.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    this.root = `https://${host}`;
    this.api = `${this.root}/api`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.nowMs() + 60_000) return this.token.value;
    const tenant = this.config.tenant?.trim();
    const res = await this.fetchImpl(`${this.root}/auth/token${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.clientId.trim(),
        client_secret: this.config.clientSecret,
        scope: "all",
      }),
      redirect: "manual",
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || !body.access_token) {
      throw new ConnectorError(`HaloPSA sign-in failed (${res.status}): ${body.error_description ?? body.error ?? res.statusText}. Check the client ID and secret.`, res.status);
    }
    this.token = { value: body.access_token, expiresAt: this.nowMs() + Number(body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const raw = await res.text().catch(() => "");
    let data: any = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = raw;
    }
    if (!res.ok) {
      if (res.status === 401) this.token = null;
      if (res.status === 429) throw new ConnectorError("HaloPSA rate limit reached; the next sync will continue.", 429);
      const detail = typeof data === "string" ? data.slice(0, 300) : (data.message ?? data.Message ?? data.error_description ?? data.error ?? res.statusText);
      throw new ConnectorError(`HaloPSA ${method} /api${path.split("?")[0]} failed (${res.status}): ${detail || res.statusText}`, res.status);
    }
    return data as T;
  }

  /** Halo's page_no/page_size paging ("pageinate" is Halo's spelling). */
  private async pages(path: string, key: string): Promise<Json[]> {
    const items: Json[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES + 1; page++) {
      const data = await this.call<Json>("GET", `${path}${sep}pageinate=true&page_size=${PAGE_SIZE}&page_no=${page}`);
      const rows = (Array.isArray(data) ? data : (data[key] ?? [])) as Json[];
      if (page > MAX_PAGES && rows.length) throw new ConnectorError(`HaloPSA ${path.split("?")[0]} reached the page limit (${MAX_PAGES}); results are incomplete.`);
      items.push(...rows);
      const total = Number(data.record_count ?? NaN);
      if (rows.length < PAGE_SIZE || (!Number.isNaN(total) && page * PAGE_SIZE >= total)) break;
      if (page === MAX_PAGES && !Number.isNaN(total) && total > items.length) {
        throw new ConnectorError(`HaloPSA ${path.split("?")[0]} reached the page limit (${MAX_PAGES}); results are incomplete.`);
      }
    }
    return items;
  }

  async test() {
    const data = await this.call<Json>("GET", "/Client?pageinate=true&page_size=1&page_no=1");
    return `Connected to ${new URL(this.root).hostname} (${data.record_count ?? (data.clients ?? []).length} clients visible).`;
  }

  async listCustomers(): Promise<ExternalCustomer[]> {
    const clients = await this.pages("/Client?includeinactive=false", "clients");
    return clients
      .filter((c) => !c.inactive)
      .map((c) => {
        const listed = Array.isArray(c.client_domains) ? c.client_domains.map((d: unknown) => (typeof d === "string" ? d : (d as Json)?.domain)) : [];
        const domains = [hostOf(c.website), c.emaildomain, ...listed]
          .map((d) => (d ? String(d).replace(/^@/, "").toLowerCase() : null))
          .filter((d): d is string => Boolean(d));
        return { id: String(c.id), name: c.name ?? `Client ${c.id}`, domains: [...new Set(domains)] };
      });
  }

  private async statusList(): Promise<Json[]> {
    if (!this.statuses) {
      const data = await this.call<Json | Json[]>("GET", "/Status").catch(() => []);
      this.statuses = Array.isArray(data) ? data : ((data as Json).statuses ?? []);
    }
    return this.statuses!;
  }

  private async actions(ticketId: string): Promise<Json[]> {
    const data = await this.call<Json>("GET", `/Actions?ticket_id=${ticketId}&excludesys=true`);
    const rows = (Array.isArray(data) ? data : (data.actions ?? [])) as Json[];
    return rows.sort((a, b) => iso(a.datetime ?? a.actiondatecreated).localeCompare(iso(b.datetime ?? b.actiondatecreated)) || Number(a.id) - Number(b.id));
  }

  private toTicket(t: Json, actions: Json[], statuses: Json[]): ExternalTicket {
    const statusId = Number(t.status_id);
    const statusName = String(t.status_name ?? statuses.find((s) => Number(s.id) === statusId)?.name ?? "");
    const comments: ExternalComment[] = actions.map((a) => ({
      id: String(a.id),
      body: String(a.note ?? (a.note_html ? stripHtml(String(a.note_html)) : "")).trim(),
      author: String(a.who ?? ""),
      // who_type 1 is the end user; agents are 0 and carry who_agentid.
      fromCustomer: a.who_type != null ? Number(a.who_type) === 1 : !(Number(a.who_agentid) > 0),
      public: !a.hiddenfromuser,
      createdAt: iso(a.datetime ?? a.actiondatecreated),
    }));
    const priorityName = String(t.priority?.name ?? "").toLowerCase();
    return {
      id: String(t.id),
      number: String(t.id),
      subject: t.summary ?? "",
      description: stripHtml(String(t.details ?? t.details_html ?? "")),
      customerId: String(t.client_id ?? ""),
      customerName: t.client_name ?? "",
      requesterEmail: (t.user_email ?? t.emailfrom ?? t.user?.emailaddress ?? null)?.toLowerCase() || null,
      requesterName: t.user_name ?? t.reportedby ?? "",
      status: Number.isNaN(statusId) && !statusName ? null : fromHaloStatus(statusId, statusName),
      externalStatus: statusName || String(t.status_id ?? ""),
      priority: FROM_PRIORITY[Number(t.priority_id)] ?? (priorityName ? (/critical|urgent/.test(priorityName) ? "urgent" : /high/.test(priorityName) ? "high" : /low/.test(priorityName) ? "low" : "normal") : null),
      updatedAt: latest(t.last_update, t.lastactiondate, t.dateoccurred),
      comments,
    };
  }

  async getTicket(id: string): Promise<ExternalTicket> {
    if (!/^\d+$/.test(id)) throw new ConnectorError(`Not a HaloPSA ticket id: ${id}`);
    const [ticket, actions, statuses] = await Promise.all([this.call<Json>("GET", `/Tickets/${id}?includedetails=true`), this.actions(id), this.statusList()]);
    return this.toTicket(ticket, actions, statuses);
  }

  async listUpdatedTickets(since: string | null): Promise<ExternalTicket[]> {
    const from = since ?? new Date(this.nowMs() - FIRST_SYNC_LOOKBACK_MS).toISOString();
    const summaries = await this.pages(`/Tickets?datesearch=lastactiondate&startdate=${encodeURIComponent(from)}&order=id`, "tickets");
    const changed = summaries
      .map((t) => ({ t, updated: latest(t.last_update, t.lastactiondate, t.dateoccurred) }))
      .filter(({ updated }) => updated > from)
      .sort((a, b) => a.updated.localeCompare(b.updated) || Number(a.t.id) - Number(b.t.id));
    const tickets: ExternalTicket[] = [];
    for (const { t } of changed) tickets.push(await this.getTicket(String(t.id)));
    return tickets;
  }

  async addComment(ticketId: string, comment: { body: string; public: boolean }): Promise<string> {
    const data = await this.call<Json | Json[]>("POST", "/Actions", [
      {
        ticket_id: Number(ticketId),
        outcome: comment.public ? "Email User" : "Private Note",
        note: comment.body,
        hiddenfromuser: !comment.public,
        sendemail: comment.public,
      },
    ]);
    const created = Array.isArray(data) ? data[0] : data;
    if (created?.id == null) throw new ConnectorError("HaloPSA didn't return the new action's id.");
    return String(created.id);
  }

  private async statusId(status: TicketStatus): Promise<number> {
    const key: StatusKey = status === "new" ? "new" : status === "resolved" || status === "closed" ? "closed" : status === "waiting_on_customer" ? "waiting_on_customer" : "in_progress";
    const configured = { new: this.config.statusNew, in_progress: this.config.statusInProgress, waiting_on_customer: this.config.statusWaiting, closed: this.config.statusClosed }[key];
    if (configured && /^\d+$/.test(configured.trim())) return Number(configured);
    const statuses = await this.statusList();
    const found = statuses.find((s) => STATUS_NAMES[key].test(String(s.name ?? "").trim()));
    if (found) return Number(found.id);
    if (DEFAULT_STATUS[key]) return DEFAULT_STATUS[key]!;
    // No waiting status on this instance: keep the ticket in progress rather than failing the sync.
    return this.statusId("in_progress");
  }

  async setStatus(ticketId: string, status: TicketStatus): Promise<void> {
    await this.call("POST", "/Tickets", [{ id: Number(ticketId), status_id: await this.statusId(status) }]);
  }

  async createTicket(input: { customerId: string; subject: string; description: string; requesterEmail: string | null; priority: TicketPriority }) {
    const data = await this.call<Json | Json[]>("POST", "/Tickets", [
      {
        summary: input.subject,
        details: input.description,
        client_id: Number(input.customerId),
        status_id: await this.statusId("new"),
        priority_id: TO_PRIORITY[input.priority],
        ...(input.requesterEmail ? { user_email: input.requesterEmail } : {}),
        ...(this.config.ticketTypeId?.trim() ? { tickettype_id: Number(this.config.ticketTypeId) } : {}),
      },
    ]);
    const created = Array.isArray(data) ? data[0] : data;
    if (created?.id == null) throw new ConnectorError("HaloPSA didn't return the new ticket's id.");
    return { id: String(created.id), number: String(created.id) };
  }
}

registerPsaFactory("halopsa", (_connection, config, fetchImpl) =>
  new HaloAdapter(
    {
      instance: config.instance,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tenant: config.tenant,
      ticketTypeId: config.ticketTypeId,
      statusNew: config.statusNew,
      statusInProgress: config.statusInProgress,
      statusWaiting: config.statusWaiting,
      statusClosed: config.statusClosed,
    },
    fetchImpl,
  ),
);
