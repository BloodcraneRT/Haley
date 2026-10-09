import { ConnectorError } from "../connectors/types.js";
import type { TicketPriority, TicketStatus } from "../types.js";
import { registerPsaFactory } from "./registry.js";
import type { ExternalComment, ExternalCustomer, ExternalTicket, HistoricTicket, PsaAdapter, TimeEntry } from "./types.js";

type Json = Record<string, any>;
type Picklist = Array<{ value: string; label: string; isActive?: boolean; isDefaultValue?: boolean; isSystem?: boolean }>;

const MAX_PAGES = 40;
/** 500 rows per page: company lists and catch-up ticket syncs get more room. */
const CUSTOMER_MAX_PAGES = 100;
const TICKET_MAX_PAGES = 40;
/** On the first sync, only look back this far. */
const FIRST_SYNC_LOOKBACK_MS = 7 * 86_400_000;
const ZONE_LOOKUP = "https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation";
/** noteType 13 is Autotask's own "System Workflow Note". */
const SYSTEM_WORKFLOW_NOTE = 13;

const hostOf = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

/** The REST API stores and returns UTC; a time without a zone designator is still UTC. */
const iso = (value: unknown): string => {
  const s = String(value ?? "");
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
};

/** Status is a per-tenant picklist; labels are matched loosely, with the system ids (1 New, 5 Complete) as a fallback. */
export function fromAutotaskStatus(label: string, value: number): TicketStatus {
  const s = label.toLowerCase();
  if (value === 5 || /complete|closed|resolved|cancel/.test(s)) return "resolved";
  if (s === "new" || (!s && value === 1)) return "new";
  if (/wait(ing)?( on| for)? (the )?(customer|client|user|contact)/.test(s)) return "waiting_on_customer";
  return "in_progress";
}

/** Stock priorities: 1 High, 2 Medium, 3 Low, 4 Critical (tenants can add more). */
export function fromAutotaskPriority(label: string, value: number): TicketPriority | null {
  const p = label.toLowerCase();
  if (/critical|urgent|emergency/.test(p) || (!p && value === 4)) return "urgent";
  if (/high/.test(p) || (!p && value === 1)) return "high";
  if (/low/.test(p) || (!p && value === 3)) return "low";
  if (/medium|normal/.test(p) || (!p && value === 2)) return "normal";
  return p ? "normal" : null;
}

const DEFAULT_STATUS: Record<"new" | "in_progress" | "waiting_on_customer" | "resolved", number> = { new: 1, in_progress: 8, waiting_on_customer: 7, resolved: 5 };
const STATUS_LABELS: Record<keyof typeof DEFAULT_STATUS, RegExp> = {
  new: /^new$/i,
  in_progress: /^in progress$/i,
  waiting_on_customer: /^wait(ing)?( on| for)? (the )?(customer|client)$/i,
  resolved: /^complete(d)?$/i,
};
const DEFAULT_PRIORITY: Record<TicketPriority, number> = { urgent: 4, high: 1, normal: 2, low: 3 };

export interface AutotaskConfig {
  /** API-only user's username (an email address). */
  username: string;
  secret: string;
  /** API tracking identifier (integration code). */
  integrationCode: string;
  /** Zone URL, e.g. https://webservices5.autotask.net/ATServicesRest; looked up from the username when blank. */
  zoneUrl?: string;
  /** Queue for tickets Haley creates. */
  queueId?: string;
  statusNew?: string;
  statusInProgress?: string;
  statusWaiting?: string;
  statusComplete?: string;
  /** Resource id that owns Haley's time entries. Required to log time. */
  timeResourceId?: string;
  /** Role id for those entries; defaults to the ticket's assigned role, then the resource's default service desk role. */
  timeRoleId?: string;
}

/**
 * Autotask PSA REST API v1.0 as an API-only user. Haley's replies are ticket notes published to
 * "All Autotask Users"; her internal notes are "Internal Only". Notes added through the API don't
 * send Autotask's notification emails, so replies are also emailed by Haley.
 */
export class AutotaskAdapter implements PsaAdapter {
  readonly kind = "autotask" as const;
  readonly notifiesCustomer = false;
  private base: string | null = null;
  private readonly picklists = new Map<string, Picklist>();
  private readonly companies = new Map<string, Json>();

  constructor(
    private readonly config: AutotaskConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /** The tenant's zone, from config or the unauthenticated zoneInformation lookup. */
  private async zone(): Promise<string> {
    if (this.base) return this.base;
    let url = this.config.zoneUrl?.trim();
    if (!url) {
      const res = await this.fetchImpl(`${ZONE_LOOKUP}?user=${encodeURIComponent(this.config.username.trim())}`, { method: "GET", headers: { accept: "application/json" }, redirect: "manual" });
      const data = (await res.json().catch(() => ({}))) as Json;
      if (!res.ok || !data.url) {
        throw new ConnectorError(`Autotask zone lookup failed (${res.status}): ${data.errors?.join?.("; ") ?? "no zone found for that username"}. Check the API username.`, res.status);
      }
      url = String(data.url);
    }
    url = url.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (!/\/atservicesrest/i.test(url)) url = `${url}/ATServicesRest`;
    if (!/\/v1\.0$/i.test(url)) url = `${url}/V1.0`;
    this.base = url;
    return url;
  }

  private async call<T = Json>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    const base = await this.zone();
    const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${base}${pathOrUrl}`);
    const baseUrl = new URL(base);
    const basePath = baseUrl.pathname.replace(/\/+$/, "");
    // nextPageUrl comes from a response; it must never choose a new credential destination.
    if (url.protocol !== "https:" || url.origin !== baseUrl.origin || url.username || url.password || !url.pathname.toLowerCase().startsWith(`${basePath.toLowerCase()}/`)) {
      throw new ConnectorError("Autotask request URL leaves the configured HTTPS API base URL.");
    }
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        ApiIntegrationCode: this.config.integrationCode.trim(),
        UserName: this.config.username.trim(),
        Secret: this.config.secret,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      if (res.status === 429) throw new ConnectorError("Autotask rate limit reached; the next sync will continue.", 429);
      const detail = Array.isArray(data.errors) && data.errors.length ? data.errors.join("; ") : (data.message ?? res.statusText);
      const hint = res.status === 401 ? " Check the API username, secret and integration code." : "";
      const path = url.toString().replace(base, "").split("?")[0];
      throw new ConnectorError(`Autotask ${method} ${path} failed (${res.status}): ${detail}${hint}`, res.status);
    }
    return data as T;
  }

  /** POST {Entity}/query, then follow pageDetails.nextPageUrl (500 per page, ordered by id). */
  private async query(entity: string, filter: Json[], maxPages = MAX_PAGES): Promise<Json[]> {
    const items: Json[] = [];
    let data = await this.call<Json>("POST", `/${entity}/query`, { filter });
    for (let page = 1; ; page++) {
      items.push(...((data.items ?? []) as Json[]));
      const next = data.pageDetails?.nextPageUrl;
      if (!next) break;
      if (page >= maxPages) throw new ConnectorError(`Autotask ${entity} query reached the page limit (${maxPages}); results are incomplete.`);
      data = await this.call<Json>("GET", next);
    }
    return items;
  }

  private async picklist(entity: string, field: string): Promise<Picklist> {
    const key = `${entity}.${field}`;
    if (!this.picklists.has(key)) {
      // Label lookups are a convenience; the documented defaults still work without them.
      const data = await this.call<Json>("GET", `/${entity}/entityInformation/fields`).catch(() => ({ fields: [] }) as Json);
      for (const f of (data.fields ?? []) as Json[]) {
        if (f.isPickList) this.picklists.set(`${entity}.${f.name}`, ((f.picklistValues ?? []) as Picklist).filter((v) => v.isActive !== false));
      }
      if (!this.picklists.has(key)) this.picklists.set(key, []);
    }
    return this.picklists.get(key)!;
  }

  private async label(entity: string, field: string, value: unknown): Promise<string> {
    if (value == null) return "";
    return (await this.picklist(entity, field)).find((v) => String(v.value) === String(value))?.label ?? "";
  }

  async test() {
    const data = await this.call<Json>("POST", "/Companies/query/count", { filter: [{ op: "eq", field: "isActive", value: true }] });
    return `Connected to Autotask (${new URL(this.base!).hostname}, ${data.queryCount ?? "?"} active companies).`;
  }

  async listCustomers(): Promise<ExternalCustomer[]> {
    const companies = await this.query("Companies", [{ op: "eq", field: "isActive", value: true }], CUSTOMER_MAX_PAGES);
    return companies.map((c) => {
      this.companies.set(String(c.id), c);
      return { id: String(c.id), name: c.companyName ?? `Company ${c.id}`, domains: [hostOf(c.webAddress)].filter((d): d is string => Boolean(d)) };
    });
  }

  private async company(id: unknown): Promise<Json | null> {
    if (id == null) return null;
    if (!this.companies.has(String(id))) {
      const data = await this.call<Json>("GET", `/Companies/${id}`).catch(() => ({ item: null }) as Json);
      if (data.item) this.companies.set(String(id), data.item);
    }
    return this.companies.get(String(id)) ?? null;
  }

  private async contact(id: unknown): Promise<Json | null> {
    if (id == null) return null;
    const data = await this.call<Json>("GET", `/Contacts/${id}`).catch(() => ({ item: null }) as Json);
    return data.item ?? null;
  }

  private async toTicket(t: Json): Promise<ExternalTicket> {
    const [notes, company, contact, statusLabel, priorityLabel, publish] = await Promise.all([
      this.query("TicketNotes", [{ op: "eq", field: "ticketID", value: Number(t.id) }]),
      this.company(t.companyID),
      this.contact(t.contactID),
      this.label("Tickets", "status", t.status),
      this.label("Tickets", "priority", t.priority),
      this.picklist("TicketNotes", "publish"),
    ]);
    const internalOnly = Number(publish.find((v) => /internal only/i.test(v.label))?.value ?? 2);
    const requesterName = contact ? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() : "";
    const comments: ExternalComment[] = notes
      .filter((n) => Number(n.noteType) !== SYSTEM_WORKFLOW_NOTE)
      .sort((a, b) => iso(a.createDateTime).localeCompare(iso(b.createDateTime)) || Number(a.id) - Number(b.id))
      .map((n) => {
        // Client portal updates and emailed replies from a known contact carry createdByContactID.
        const byContact = n.createdByContactID != null;
        return {
          id: String(n.id),
          body: [n.title, n.description].filter(Boolean).join("\n").trim(),
          author: byContact ? (Number(n.createdByContactID) === Number(t.contactID) && requesterName ? requesterName : `Contact ${n.createdByContactID}`) : `Autotask resource ${n.creatorResourceID ?? ""}`.trim(),
          fromCustomer: byContact,
          public: Number(n.publish) !== internalOnly,
          createdAt: iso(n.createDateTime),
        };
      });
    return {
      id: String(t.id),
      number: String(t.ticketNumber ?? t.id),
      subject: t.title ?? "",
      description: String(t.description ?? ""),
      customerId: String(t.companyID ?? ""),
      customerName: company?.companyName ?? "",
      requesterEmail: contact?.emailAddress ? String(contact.emailAddress).toLowerCase() : null,
      requesterName,
      status: t.status == null ? null : fromAutotaskStatus(statusLabel, Number(t.status)),
      externalStatus: statusLabel || String(t.status ?? ""),
      priority: t.priority == null ? null : fromAutotaskPriority(priorityLabel, Number(t.priority)),
      updatedAt: iso(t.lastActivityDate ?? t.lastTrackedModificationDateTime ?? t.createDate),
      comments,
    };
  }

  async getTicket(id: string): Promise<ExternalTicket> {
    if (!/^\d+$/.test(id)) throw new ConnectorError(`Not an Autotask ticket id: ${id}`);
    const data = await this.call<Json>("GET", `/Tickets/${id}`);
    if (!data.item) throw new ConnectorError(`Autotask ticket ${id} wasn't found.`, 404);
    return this.toTicket(data.item);
  }

  async listUpdatedTickets(since: string | null): Promise<ExternalTicket[]> {
    const from = since ?? new Date(this.nowMs() - FIRST_SYNC_LOOKBACK_MS).toISOString();
    // lastActivityDate moves when a note or time entry is added, not only when the ticket's own fields change.
    const items = await this.query("Tickets", [{ op: "gt", field: "lastActivityDate", value: from }], TICKET_MAX_PAGES);
    const changed = items
      .filter((t) => !since || iso(t.lastActivityDate) > since)
      .sort((a, b) => iso(a.lastActivityDate).localeCompare(iso(b.lastActivityDate)) || Number(a.id) - Number(b.id));
    const tickets: ExternalTicket[] = [];
    for (const t of changed) tickets.push(await this.toTicket(t));
    return tickets;
  }

  /**
   * Tickets completed in [from, to), newest first, for the automation report. The Complete status is read from
   * the picklist (5 by default). Autotask tickets have no actual-hours field, so minutes are left unknown.
   */
  async listClosedTickets(from: string, to: string, opts: { max: number }): Promise<HistoricTicket[]> {
    const statuses = await this.picklist("Tickets", "status");
    const complete = Number(statuses.find((v) => /^complete/i.test(v.label))?.value ?? DEFAULT_STATUS.resolved);
    const filter = [
      { op: "eq", field: "status", value: complete },
      { op: "gte", field: "completedDate", value: from },
      { op: "lt", field: "completedDate", value: to },
    ];
    const rows: Json[] = [];
    let data = await this.call<Json>("POST", "/Tickets/query", { filter });
    for (;;) {
      rows.push(...((data.items ?? []) as Json[]));
      const next = data.pageDetails?.nextPageUrl;
      if (!next || rows.length >= opts.max) break;
      data = await this.call<Json>("GET", next);
    }
    const out: HistoricTicket[] = [];
    for (const t of rows) {
      const closedAt = iso(t.completedDate);
      if (!closedAt || closedAt < from || closedAt >= to) continue;
      out.push({
        id: String(t.id),
        subject: String(t.title ?? ""),
        description: String(t.description ?? "").slice(0, 2000),
        customerId: String(t.companyID ?? ""),
        customerName: String((await this.company(t.companyID))?.companyName ?? ""),
        createdAt: iso(t.createDate),
        closedAt,
        minutesSpent: null,
        category: (await this.label("Tickets", "issueType", t.issueType)) || null,
      });
    }
    return out.sort((a, b) => b.closedAt.localeCompare(a.closedAt)).slice(0, opts.max);
  }

  async addComment(ticketId: string, comment: { body: string; public: boolean }): Promise<string> {
    const [publish, noteTypes] = await Promise.all([this.picklist("TicketNotes", "publish"), this.picklist("TicketNotes", "noteType")]);
    const publishValue = comment.public
      ? Number(publish.find((v) => /all autotask users/i.test(v.label))?.value ?? 1)
      : Number(publish.find((v) => /internal only/i.test(v.label))?.value ?? 2);
    const noteType = Number(noteTypes.find((v) => v.isDefaultValue)?.value ?? noteTypes.find((v) => !v.isSystem)?.value ?? 1);
    const data = await this.call<Json>("POST", `/Tickets/${ticketId}/Notes`, {
      ticketID: Number(ticketId),
      title: comment.public ? "Reply to the customer (sent by Haley)" : "Haley note",
      description: comment.body.slice(0, 32000),
      noteType,
      publish: publishValue,
    });
    if (data.itemId == null) throw new ConnectorError("Autotask didn't return the new note's id.");
    return String(data.itemId);
  }

  private async statusId(status: TicketStatus): Promise<number> {
    const key = status === "new" ? "new" : status === "resolved" || status === "closed" ? "resolved" : status === "waiting_on_customer" ? "waiting_on_customer" : "in_progress";
    const configured = { new: this.config.statusNew, in_progress: this.config.statusInProgress, waiting_on_customer: this.config.statusWaiting, resolved: this.config.statusComplete }[key];
    if (configured && /^\d+$/.test(configured.trim())) return Number(configured);
    const found = (await this.picklist("Tickets", "status")).find((v) => STATUS_LABELS[key].test(v.label.trim()));
    return Number(found?.value ?? DEFAULT_STATUS[key]);
  }

  async setStatus(ticketId: string, status: TicketStatus): Promise<void> {
    await this.call("PATCH", "/Tickets", { id: Number(ticketId), status: await this.statusId(status) });
  }

  private async priorityId(priority: TicketPriority): Promise<number> {
    const found = (await this.picklist("Tickets", "priority")).find((v) => fromAutotaskPriority(v.label, Number(v.value)) === priority);
    return Number(found?.value ?? DEFAULT_PRIORITY[priority]);
  }

  /** The role for Haley's time on a ticket: configured, else the ticket's assigned role, else the resource's default. */
  private async timeRole(ticketId: string, resourceId: number): Promise<number> {
    const configured = this.config.timeRoleId?.trim();
    if (configured && /^\d+$/.test(configured)) return Number(configured);
    const ticket = (await this.call<Json>("GET", `/Tickets/${ticketId}`)).item as Json | undefined;
    // Autotask spells it with a lowercase "role".
    if (ticket?.assignedResourceroleID) return Number(ticket.assignedResourceroleID);
    const roles = await this.query("ResourceServiceDeskRoles", [
      { op: "eq", field: "resourceID", value: resourceId },
      { op: "eq", field: "isActive", value: true },
    ]);
    const role = roles.find((r) => r.isDefault) ?? roles[0];
    if (!role) throw new ConnectorError(`Autotask resource ${resourceId} has no active service desk role; set a role id for Haley's time on this connection.`);
    return Number(role.roleID);
  }

  /**
   * POST /TimeEntries for the ticket, non-billable and off the invoice so technicians decide what's billed. The
   * resource must be able to receive it (Proxy Time Entry for the API user, or Haley's own resource).
   */
  async logTime(ticketId: string, entry: TimeEntry): Promise<string> {
    const resource = this.config.timeResourceId?.trim();
    if (!resource || !/^\d+$/.test(resource)) throw new ConnectorError("Set the Autotask resource id for Haley's time on this connection (Edit credentials) to log time.");
    if (!/^\d+$/.test(ticketId)) throw new ConnectorError(`Not an Autotask ticket id: ${ticketId}`);
    const start = Date.parse(entry.startedAt);
    const data = await this.call<Json>("POST", "/TimeEntries", {
      ticketID: Number(ticketId),
      resourceID: Number(resource),
      roleID: await this.timeRole(ticketId, Number(resource)),
      startDateTime: new Date(start).toISOString(),
      endDateTime: new Date(start + entry.minutes * 60_000).toISOString(),
      summaryNotes: entry.notes.slice(0, 8000) || "Work by Haley",
      isNonBillable: true,
      showOnInvoice: false,
    });
    if (data.itemId == null) throw new ConnectorError("Autotask didn't return the new time entry's id.");
    return String(data.itemId);
  }

  async createTicket(input: { customerId: string; subject: string; description: string; requesterEmail: string | null; priority: TicketPriority }) {
    let contactId: number | null = null;
    if (input.requesterEmail) {
      const contacts = await this.query("Contacts", [
        { op: "eq", field: "companyID", value: Number(input.customerId) },
        { op: "eq", field: "emailAddress", value: input.requesterEmail },
      ]);
      contactId = contacts[0]?.id ?? null;
    }
    const created = await this.call<Json>("POST", "/Tickets", {
      companyID: Number(input.customerId),
      title: input.subject.slice(0, 255),
      description: input.description.slice(0, 8000),
      status: await this.statusId("new"),
      priority: await this.priorityId(input.priority),
      ...(this.config.queueId?.trim() ? { queueID: Number(this.config.queueId) } : {}),
      ...(contactId ? { contactID: contactId } : {}),
    });
    if (created.itemId == null) throw new ConnectorError("Autotask didn't return the new ticket's id.");
    const id = String(created.itemId);
    const { item } = await this.call<Json>("GET", `/Tickets/${id}`).catch(() => ({ item: null }) as Json);
    return { id, number: String(item?.ticketNumber ?? id) };
  }
}

registerPsaFactory("autotask", (_connection, config, fetchImpl) =>
  new AutotaskAdapter(
    {
      username: config.username,
      secret: config.secret,
      integrationCode: config.integrationCode,
      zoneUrl: config.zoneUrl,
      queueId: config.queueId,
      statusNew: config.statusNew,
      statusInProgress: config.statusInProgress,
      statusWaiting: config.statusWaiting,
      statusComplete: config.statusComplete,
      timeResourceId: config.timeResourceId,
      timeRoleId: config.timeRoleId,
    },
    fetchImpl,
  ),
);
