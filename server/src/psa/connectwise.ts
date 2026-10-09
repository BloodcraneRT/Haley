import { ConnectorError } from "../connectors/types.js";
import type { TicketPriority, TicketStatus } from "../types.js";
import { registerPsaFactory } from "./registry.js";
import { readCapped } from "../attachments.js";
import type { ExternalComment, ExternalCustomer, ExternalTicket, HistoricTicket, LoggedTime, PsaAdapter, PsaAttachment, PsaOwner, TimeEntry } from "./types.js";

type Json = Record<string, any>;

const PAGE_SIZE = 100;
const MAX_PAGES = 40;
/** Company lists of established MSPs (prospects, vendors…) and catch-up ticket syncs run long; they get more room. */
const CUSTOMER_MAX_PAGES = 500;
const TICKET_MAX_PAGES = 200;
/** On the first sync, only look back this far. */
const FIRST_SYNC_LOOKBACK_MS = 7 * 86_400_000;

const hostOf = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

/** ConnectWise returns UTC times ("2026-09-27T10:00:00Z"); normalise so cursors compare as strings. */
const iso = (value: unknown): string => {
  const s = String(value ?? "");
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
};

/** Condition strings are double-quoted; a quote inside one would end it early. */
const quoted = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** ConnectWise statuses are per service board; names are matched loosely. */
export function fromConnectWiseStatus(name: string, closedFlag = false): TicketStatus {
  const s = name.replace(/^[>\s]+/, "").toLowerCase();
  if (/closed|cancel/.test(s)) return "closed";
  if (closedFlag || /resolved|complete/.test(s)) return "resolved";
  if (s === "new" || s.startsWith("new ")) return "new";
  if (/wait(ing)?( on| for)? (the )?(customer|client|user|contact)|pending (customer|client)/.test(s)) return "waiting_on_customer";
  return "in_progress";
}

/** Stock priorities are "Priority 1 - Emergency Response" … "Priority 4 - Schedule Maintenance"; boards can rename them. */
export function fromConnectWisePriority(name: unknown): TicketPriority | null {
  const p = String(name ?? "").toLowerCase();
  if (!p) return null;
  if (/emergency|critical|urgent|priority 1\b|^p1\b/.test(p)) return "urgent";
  if (/high|quick|priority 2\b|^p2\b/.test(p)) return "high";
  if (/low|schedule|do not respond|priority 4\b|^p4\b/.test(p)) return "low";
  return "normal";
}

export interface ConnectWiseConfig {
  /** API host, e.g. api-na.myconnectwise.net (or an on-premises server). */
  site: string;
  companyId: string;
  publicKey: string;
  privateKey: string;
  /** Developer clientId (GUID) from developer.connectwise.com. */
  clientId: string;
  /** Service board Haley's tickets are created on, and whose tickets are imported. */
  board: string;
  /** Extra boards to import from, comma-separated. */
  importBoards?: string;
  statusNew?: string;
  statusInProgress?: string;
  statusWaiting?: string;
  statusResolved?: string;
  /** "true" when the board's notification rules email the contact about new Discussion notes. */
  emailContacts?: string;
  /** Member identifier that owns Haley's time entries (e.g. a "haley" member). Required to log time. */
  timeMember?: string;
  /** Optional work type and work role ids for those entries; ConnectWise defaults them otherwise. */
  timeWorkTypeId?: string;
  timeWorkRoleId?: string;
}

/** Status names tried in order on the ticket's board; the configured name always comes first. */
const STATUS_CANDIDATES: Record<"new" | "in_progress" | "waiting_on_customer" | "resolved", string[]> = {
  new: ["New"],
  in_progress: ["In Progress", "Assigned", "Work in Progress"],
  waiting_on_customer: ["Waiting on Customer", "Waiting Customer", "Waiting on Client", "Waiting Client", "Customer Waiting"],
  resolved: ["Resolved", "Completed", "Complete", "Closed", ">Closed"],
};

const coarseStatus = (status: TicketStatus): keyof typeof STATUS_CANDIDATES =>
  status === "new" ? "new" : status === "resolved" || status === "closed" ? "resolved" : status === "waiting_on_customer" ? "waiting_on_customer" : "in_progress";

/**
 * ConnectWise PSA (Manage) REST API 3.0 with API member keys. Haley's replies are Discussion notes
 * (detailDescriptionFlag) and her notes are Internal notes (internalAnalysisFlag).
 */
export class ConnectWiseAdapter implements PsaAdapter {
  readonly kind = "connectwise" as const;
  /** A Discussion note only reaches the contact if the board's notification rules send it. */
  readonly notifiesCustomer: boolean;
  private readonly base: string;
  private readonly host: string;
  private readonly boards: string[];
  private readonly boardStatuses = new Map<number, Json[]>();
  private priorities: Json[] | null = null;
  /** Members by id, for owners' names and emails (looked up once per adapter). */
  private readonly members = new Map<string, PsaOwner>();

  constructor(
    private readonly config: ConnectWiseConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowMs: () => number = Date.now,
  ) {
    const site = config.site.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.host = site.split("/")[0];
    this.base = /\/apis\/3\.0$/i.test(site) ? `https://${site}` : `https://${this.host}/v4_6_release/apis/3.0`;
    this.boards = [config.board, ...(config.importBoards ?? "").split(",")].map((b) => b.trim()).filter((b, i, all) => b && all.indexOf(b) === i);
    this.notifiesCustomer = /^(true|yes|1)$/i.test(config.emailContacts ?? "");
  }

  private auth(): Record<string, string> {
    const auth = Buffer.from(`${this.config.companyId.trim()}+${this.config.publicKey.trim()}:${this.config.privateKey.trim()}`).toString("base64");
    return { authorization: `Basic ${auth}`, clientId: this.config.clientId.trim() };
  }

  private async call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        ...this.auth(),
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      if (res.status === 429) throw new ConnectorError("ConnectWise rate limit reached; the next sync will continue.", 429);
      const errors = Array.isArray(data.errors) ? data.errors.map((e: Json) => e.message).filter(Boolean) : [];
      const detail = [data.message ?? res.statusText, ...errors].filter(Boolean).join(" ");
      const hint = res.status === 401 ? " Check the company ID and the API member's public/private keys." : "";
      throw new ConnectorError(`ConnectWise ${method} ${path.split("?")[0]} failed (${res.status}): ${detail}${hint}`, res.status);
    }
    return data as T;
  }

  /** Page/pageSize paging; a short page is the last one. */
  private async pages<T = Json>(path: string, maxPages = MAX_PAGES): Promise<T[]> {
    const items: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages + 1; page++) {
      const data = await this.call<T[]>("GET", `${path}${sep}pageSize=${PAGE_SIZE}&page=${page}`);
      const rows = Array.isArray(data) ? data : [];
      // One empty probe page allows a collection of exactly maxPages full pages.
      if (page > maxPages && rows.length) throw new ConnectorError(`ConnectWise ${path.split("?")[0]} reached the page limit (${maxPages}); results are incomplete.`);
      items.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    return items;
  }

  async test() {
    const info = await this.call<Json>("GET", "/system/info");
    const boards = await this.call<Json[]>("GET", `/service/boards?conditions=${encodeURIComponent(`name=${quoted(this.config.board)}`)}&fields=id,name`);
    if (!Array.isArray(boards) || !boards.length) throw new ConnectorError(`Connected, but there's no service board named "${this.config.board}". Check the board name.`);
    return `Connected to ${this.host}${info.version ? ` (ConnectWise PSA ${info.version})` : ""}; tickets go to the "${boards[0].name}" board.`;
  }

  async listCustomers(): Promise<ExternalCustomer[]> {
    const companies = await this.pages<Json>(`/company/companies?conditions=${encodeURIComponent("deletedFlag=false")}&fields=id,identifier,name,website&orderBy=${encodeURIComponent("id asc")}`, CUSTOMER_MAX_PAGES);
    return companies.map((c) => ({
      id: String(c.id),
      name: c.name || c.identifier || `Company ${c.id}`,
      domains: [hostOf(c.website)].filter((d): d is string => Boolean(d)),
    }));
  }

  private async notes(ticketId: string): Promise<Json[]> {
    if (!/^\d+$/.test(ticketId)) throw new ConnectorError(`Not a ConnectWise ticket id: ${ticketId}`);
    const notes = await this.pages<Json>(`/service/tickets/${ticketId}/notes?orderBy=${encodeURIComponent("id asc")}`);
    return notes.sort((a, b) => iso(a.dateCreated).localeCompare(iso(b.dateCreated)) || Number(a.id) - Number(b.id));
  }

  private toTicket(t: Json, notes: Json[]): ExternalTicket {
    // initialDescription is write-only; the ticket's description is its first Discussion note.
    const first = notes.find((n) => n.detailDescriptionFlag) ?? null;
    const comments: ExternalComment[] = notes.map((n) => ({
      id: String(n.id),
      body: String(n.text ?? ""),
      author: String(n.member?.name ?? n.contact?.name ?? n.createdBy ?? ""),
      // Notes a member writes carry `member`; email replies and portal updates come from the contact.
      fromCustomer: n !== first && !n.member?.id && Boolean(n.contact?.id || n.externalFlag),
      public: !n.internalAnalysisFlag && !n.internalFlag,
      createdAt: iso(n.dateCreated),
    }));
    const statusName = String(t.status?.name ?? "");
    return {
      id: String(t.id),
      number: String(t.id),
      subject: t.summary ?? "",
      description: first ? String(first.text ?? "") : "",
      customerId: String(t.company?.id ?? ""),
      customerName: t.company?.name ?? "",
      requesterEmail: t.contactEmailAddress ? String(t.contactEmailAddress).toLowerCase() : null,
      requesterName: t.contactName ?? t.contact?.name ?? "",
      status: statusName || t.closedFlag ? fromConnectWiseStatus(statusName, Boolean(t.closedFlag)) : null,
      externalStatus: statusName,
      priority: fromConnectWisePriority(t.priority?.name),
      updatedAt: iso(t._info?.lastUpdated ?? t.dateEntered ?? t._info?.dateEntered),
      comments,
    };
  }

  /** The ticket's owner (a member), with their email from /system/members (cached). */
  private async owner(t: Json): Promise<PsaOwner | null> {
    const id = t.owner?.id;
    if (id == null) return null;
    const key = String(id);
    if (!this.members.has(key)) {
      const m = await this.call<Json>("GET", `/system/members/${key}?fields=id,identifier,firstName,lastName,officeEmail`).catch(() => ({}) as Json);
      const name = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || t.owner.name || t.owner.identifier || `Member ${key}`;
      this.members.set(key, { id: key, name, email: m.officeEmail ? String(m.officeEmail).toLowerCase() : null });
    }
    return this.members.get(key)!;
  }

  async getTicket(id: string): Promise<ExternalTicket> {
    if (!/^\d+$/.test(id)) throw new ConnectorError(`Not a ConnectWise ticket id: ${id}`);
    const [ticket, notes] = await Promise.all([this.call<Json>("GET", `/service/tickets/${id}`), this.notes(id)]);
    return { ...this.toTicket(ticket, notes), owner: await this.owner(ticket) };
  }

  async listTimeEntries(ticketId: string): Promise<LoggedTime[]> {
    if (!/^\d+$/.test(ticketId)) throw new ConnectorError(`Not a ConnectWise ticket id: ${ticketId}`);
    const conditions = `chargeToType="ServiceTicket" and chargeToId=${ticketId}`;
    const rows = await this.pages<Json>(`/time/entries?conditions=${encodeURIComponent(conditions)}&fields=id,actualHours,member,notes,timeStart,dateEntered`, 5);
    return rows.map((r) => ({
      id: String(r.id),
      minutes: Math.round(Number(r.actualHours ?? 0) * 60),
      member: String(r.member?.name ?? r.member?.identifier ?? ""),
      notes: String(r.notes ?? ""),
      createdAt: iso(r.timeStart ?? r.dateEntered),
    }));
  }

  /** Documents attached to the ticket (emailed-in files arrive here too, so they're treated as the customer's). */
  async listAttachments(ticketId: string): Promise<PsaAttachment[]> {
    if (!/^\d+$/.test(ticketId)) throw new ConnectorError(`Not a ConnectWise ticket id: ${ticketId}`);
    const docs = await this.call<Json[]>("GET", `/system/documents?recordType=Ticket&recordId=${ticketId}&pageSize=${PAGE_SIZE}`);
    return (Array.isArray(docs) ? docs : []).map((d) => ({
      id: String(d.id),
      filename: String(d.fileName ?? d.title ?? `document-${d.id}`),
      contentType: d.contentType ? String(d.contentType) : null,
      size: typeof d.fileSize === "number" ? d.fileSize : null,
      createdAt: iso(d._info?.lastUpdated ?? d._info?.dateEntered),
      fromCustomer: true,
    }));
  }

  async getAttachment(_ticketId: string, attachment: PsaAttachment, maxBytes: number): Promise<Uint8Array | null> {
    if (!/^\d+$/.test(attachment.id)) throw new ConnectorError(`Not a ConnectWise document id: ${attachment.id}`);
    const res = await this.fetchImpl(`${this.base}/system/documents/${attachment.id}/download`, { headers: this.auth(), redirect: "follow" });
    if (!res.ok) throw new ConnectorError(`ConnectWise GET /system/documents/${attachment.id}/download failed (${res.status})`, res.status);
    return readCapped(res, maxBytes);
  }

  async setOwner(ticketId: string, ownerId: string): Promise<void> {
    if (!/^\d+$/.test(ticketId) || !/^\d+$/.test(ownerId)) throw new ConnectorError(`Not a ConnectWise ticket or member id: ${ticketId}, ${ownerId}`);
    await this.call("PATCH", `/service/tickets/${ticketId}`, [{ op: "replace", path: "owner", value: { id: Number(ownerId) } }]);
  }

  async listUpdatedTickets(since: string | null): Promise<ExternalTicket[]> {
    const from = (since ?? new Date(this.nowMs() - FIRST_SYNC_LOOKBACK_MS).toISOString()).replace(/\.\d+Z$/, "Z");
    const boards = this.boards.map((b) => `board/name=${quoted(b)}`).join(" or ");
    const conditions = `lastUpdated > [${from}]${boards ? ` and (${boards})` : ""}`;
    // Paged by id so a ticket updated mid-sync can't shift the pages; sorted oldest first below.
    const summaries = await this.pages<Json>(`/service/tickets?conditions=${encodeURIComponent(conditions)}&orderBy=${encodeURIComponent("id asc")}`, TICKET_MAX_PAGES);
    const changed = summaries
      .filter((t) => !since || iso(t._info?.lastUpdated) > since)
      .sort((a, b) => iso(a._info?.lastUpdated).localeCompare(iso(b._info?.lastUpdated)) || Number(a.id) - Number(b.id));
    const tickets: ExternalTicket[] = [];
    for (const summary of changed) tickets.push({ ...this.toTicket(summary, await this.notes(String(summary.id))), owner: await this.owner(summary) });
    return tickets;
  }

  async listClosedTickets(from: string, to: string, opts: { max: number }): Promise<HistoricTicket[]> {
    const day = (s: string) => s.replace(/\.\d+Z$/, "Z");
    const conditions = `closedFlag=true and closedDate>=[${day(from)}] and closedDate<[${day(to)}]`;
    const fields = "id,summary,initialDescription,company,dateEntered,closedDate,actualHours,type,subType";
    const out: HistoricTicket[] = [];
    for (let page = 1; out.length < opts.max; page++) {
      const rows = await this.call<Json[]>(
        "GET",
        `/service/tickets?conditions=${encodeURIComponent(conditions)}&fields=${fields}&orderBy=${encodeURIComponent("closedDate desc")}&pageSize=${PAGE_SIZE}&page=${page}`,
      );
      const list = Array.isArray(rows) ? rows : [];
      for (const t of list) {
        out.push({
          id: String(t.id),
          subject: String(t.summary ?? ""),
          description: String(t.initialDescription ?? "").slice(0, 2000),
          customerId: String(t.company?.id ?? ""),
          customerName: String(t.company?.name ?? ""),
          createdAt: iso(t.dateEntered),
          closedAt: iso(t.closedDate),
          minutesSpent: typeof t.actualHours === "number" ? Math.round(t.actualHours * 60) : null,
          category: [t.type?.name, t.subType?.name].filter(Boolean).join(" / ") || null,
        });
      }
      if (list.length < PAGE_SIZE) break;
    }
    return out.slice(0, opts.max);
  }

  async addComment(ticketId: string, comment: { body: string; public: boolean }): Promise<string> {
    const data = await this.call<Json>("POST", `/service/tickets/${ticketId}/notes`, {
      text: comment.body,
      detailDescriptionFlag: comment.public,
      internalAnalysisFlag: !comment.public,
      resolutionFlag: false,
      // Only a public reply may trigger the board's contact emails, and only when the MSP relies on them.
      processNotifications: comment.public && this.notifiesCustomer,
    });
    if (data.id == null) throw new ConnectorError("ConnectWise didn't return the new note's id.");
    return String(data.id);
  }

  private async statusesFor(boardId: number): Promise<Json[]> {
    let statuses = this.boardStatuses.get(boardId);
    if (!statuses) {
      statuses = (await this.pages<Json>(`/service/boards/${boardId}/statuses?fields=id,name,inactive,closedStatus`)).filter((s) => !s.inactive);
      this.boardStatuses.set(boardId, statuses);
    }
    return statuses;
  }

  async setStatus(ticketId: string, status: TicketStatus): Promise<void> {
    const ticket = await this.call<Json>("GET", `/service/tickets/${ticketId}?fields=id,board,status`);
    const boardId = Number(ticket.board?.id);
    if (!boardId) throw new ConnectorError(`ConnectWise ticket ${ticketId} has no service board.`);
    const statuses = await this.statusesFor(boardId);
    const find = (key: keyof typeof STATUS_CANDIDATES) => {
      const configured = {
        new: this.config.statusNew,
        in_progress: this.config.statusInProgress,
        waiting_on_customer: this.config.statusWaiting,
        resolved: this.config.statusResolved,
      }[key]?.trim();
      for (const name of [configured, ...STATUS_CANDIDATES[key]].filter(Boolean) as string[]) {
        const match = statuses.find((s) => String(s.name ?? "").toLowerCase() === name.toLowerCase());
        if (match) return match;
      }
      return null;
    };
    const key = coarseStatus(status);
    // A board without a waiting status keeps the ticket in progress rather than failing the sync.
    const target = find(key) ?? (key === "waiting_on_customer" ? find("in_progress") : null);
    if (!target) {
      throw new ConnectorError(
        `ConnectWise board "${ticket.board?.name ?? boardId}" has no status for "${status}". Set the status names in the connection settings.`,
      );
    }
    if (Number(ticket.status?.id) === Number(target.id)) return;
    await this.call("PATCH", `/service/tickets/${ticketId}`, [{ op: "replace", path: "status", value: { id: target.id } }]);
  }

  private async priorityId(priority: TicketPriority): Promise<number | null> {
    if (!this.priorities) {
      this.priorities = await this.pages<Json>(`/service/priorities?fields=id,name,sortOrder&orderBy=${encodeURIComponent("sortOrder asc")}`).catch(() => []);
    }
    const match = this.priorities.find((p) => fromConnectWisePriority(p.name) === priority);
    return match ? Number(match.id) : null;
  }

  /**
   * POST /time/entries against the service ticket, as "Do Not Bill" so technicians decide what's invoiced. Notes
   * aren't copied onto the ticket (no Discussion note, so no contact email). ConnectWise rejects fractional seconds.
   */
  async logTime(ticketId: string, entry: TimeEntry): Promise<string> {
    const member = this.config.timeMember?.trim();
    if (!member) throw new ConnectorError("Set the ConnectWise member for Haley's time on this connection (Edit credentials) to log time.");
    if (!/^\d+$/.test(ticketId)) throw new ConnectorError(`Not a ConnectWise ticket id: ${ticketId}`);
    const cw = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const start = Date.parse(entry.startedAt);
    const id = (v?: string) => (v && /^\d+$/.test(v.trim()) ? { id: Number(v) } : undefined);
    const data = await this.call<Json>("POST", "/time/entries", {
      chargeToId: Number(ticketId),
      chargeToType: "ServiceTicket",
      member: { identifier: member },
      timeStart: cw(start),
      timeEnd: cw(start + entry.minutes * 60_000),
      notes: entry.notes.slice(0, 4000),
      billableOption: "DoNotBill",
      addToDetailDescriptionFlag: false,
      addToInternalAnalysisFlag: false,
      addToResolutionFlag: false,
      ...(id(this.config.timeWorkTypeId) ? { workType: id(this.config.timeWorkTypeId) } : {}),
      ...(id(this.config.timeWorkRoleId) ? { workRole: id(this.config.timeWorkRoleId) } : {}),
    });
    if (data.id == null) throw new ConnectorError("ConnectWise didn't return the new time entry's id.");
    return String(data.id);
  }

  async createTicket(input: { customerId: string; subject: string; description: string; requesterEmail: string | null; priority: TicketPriority }) {
    const priorityId = await this.priorityId(input.priority);
    const data = await this.call<Json>("POST", "/service/tickets", {
      summary: input.subject.slice(0, 100),
      initialDescription: input.description,
      board: { name: this.config.board },
      company: { id: Number(input.customerId) },
      ...(input.requesterEmail ? { contactEmailAddress: input.requesterEmail } : {}),
      ...(priorityId ? { priority: { id: priorityId } } : {}),
    });
    if (data.id == null) throw new ConnectorError("ConnectWise didn't return the new ticket's id.");
    return { id: String(data.id), number: String(data.id) };
  }
}

registerPsaFactory("connectwise", (_connection, config, fetchImpl) =>
  new ConnectWiseAdapter(
    {
      site: config.site,
      companyId: config.companyId,
      publicKey: config.publicKey,
      privateKey: config.privateKey,
      clientId: config.clientId,
      board: config.board,
      importBoards: config.importBoards,
      statusNew: config.statusNew,
      statusInProgress: config.statusInProgress,
      statusWaiting: config.statusWaiting,
      statusResolved: config.statusResolved,
      emailContacts: config.emailContacts,
      timeMember: config.timeMember,
      timeWorkTypeId: config.timeWorkTypeId,
      timeWorkRoleId: config.timeWorkRoleId,
    },
    fetchImpl,
  ),
);
