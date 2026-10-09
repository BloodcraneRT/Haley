import { ConnectorError } from "../connectors/types.js";
import type { TicketPriority, TicketStatus } from "../types.js";
import { registerPsaFactory } from "./registry.js";
import { decodeCapped } from "../attachments.js";
import type { ExternalComment, ExternalCustomer, ExternalTicket, HistoricTicket, PsaAdapter, PsaAttachment, PsaOwner } from "./types.js";

type Json = Record<string, any>;

const FIRST_SYNC_LOOKBACK_MS = 7 * 86_400_000;
const MAX_PAGES = 50;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INCIDENT_SELECT =
  "incidentid,ticketnumber,title,description,statecode,statuscode,prioritycode,modifiedon,createdon,_customerid_value,_primarycontactid_value,_ownerid_value";
const INCIDENT_EXPAND =
  "primarycontactid($select=fullname,emailaddress1),customerid_account($select=name,websiteurl,emailaddress1),customerid_contact($select=fullname,emailaddress1,_parentcustomerid_value)";

export interface DynamicsConfig {
  /** Environment URL, e.g. https://contoso.crm.dynamics.com */
  orgUrl: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/** Dataverse statecode: 0 Active, 1 Resolved, 2 Cancelled. statuscode 3 = Waiting for Details. */
export function fromDynamicsStatus(statecode: number, statuscode: number): TicketStatus {
  if (statecode === 1) return "resolved";
  if (statecode === 2) return "closed";
  if (statuscode === 3) return "waiting_on_customer";
  return "in_progress";
}

const fromPriority = (code: unknown): TicketPriority | null => (code === 1 ? "high" : code === 3 ? "low" : code === 2 ? "normal" : null);
const toPriority = (p: TicketPriority) => (p === "urgent" || p === "high" ? 1 : p === "low" ? 3 : 2);

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

const hostOf = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Dynamics 365 Customer Service cases through the Dataverse Web API v9.2, as an application user
 * (client-credentials). Haley's notes land on the case timeline as annotations; incoming emails
 * regarding the case count as customer replies.
 */
export class DynamicsAdapter implements PsaAdapter {
  readonly kind = "dynamics" as const;
  /** A Dynamics note doesn't reach the customer, so replies are also emailed by Haley. */
  readonly notifiesCustomer = false;
  private readonly orgUrl: string;
  private readonly api: string;
  private token: { value: string; expiresAt: number } | null = null;
  /** System users by id, for owners' emails (looked up once per adapter). */
  private readonly users = new Map<string, PsaOwner>();

  constructor(
    private readonly config: DynamicsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowMs: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.orgUrl = config.orgUrl.trim().replace(/\/+$/, "");
    this.api = `${this.orgUrl}/api/data/v9.2`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.nowMs() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "client_credentials",
        scope: `${this.orgUrl}/.default`,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new ConnectorError(`Dynamics sign-in failed: ${body.error_description ?? body.error ?? res.statusText}`);
    this.token = { value: body.access_token, expiresAt: this.nowMs() + Number(body.expires_in ?? 3599) * 1000 };
    return this.token.value;
  }

  private async call<T = Json>(method: string, pathOrUrl: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ data: T; headers: Headers }> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.api}${pathOrUrl}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          accept: "application/json",
          "odata-maxversion": "4.0",
          "odata-version": "4.0",
          "if-none-match": "null",
          prefer: 'odata.include-annotations="*",odata.maxpagesize=100',
          ...(body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}),
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // Service protection: honor Retry-After once for short waits.
      if (res.status === 429 && attempt === 0) {
        const wait = Number(res.headers.get("retry-after") ?? "5") * 1000;
        if (wait <= 15_000) {
          await this.sleep(wait);
          continue;
        }
      }
      if (res.status === 204) return { data: {} as T, headers: res.headers };
      const data = (await res.json().catch(() => ({}))) as Json;
      if (!res.ok) throw new ConnectorError(`Dynamics ${method} ${url.replace(this.api, "").split("?")[0]} failed (${res.status}): ${data.error?.message ?? res.statusText}`);
      return { data: data as T, headers: res.headers };
    }
  }

  private async pages<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const { data }: { data: Json } = await this.call<Json>("GET", next);
      items.push(...((data.value ?? []) as T[]));
      next = data["@odata.nextLink"];
    }
    return items;
  }

  /** The id from a 201 representation, or the OData-EntityId header of a 204. */
  private createdId(data: Json, headers: Headers, key: string): string {
    if (data[key]) return String(data[key]);
    const entity = headers.get("odata-entityid") ?? "";
    const match = /\(([0-9a-f-]{36})\)$/i.exec(entity);
    if (!match) throw new ConnectorError(`Dynamics didn't return the new ${key}.`);
    return match[1];
  }

  async test() {
    const { data } = await this.call<Json>("GET", "/WhoAmI");
    return `Connected to ${new URL(this.orgUrl).hostname} as application user ${data.UserId}.`;
  }

  /**
   * Cases resolved in [from, to), newest first, for the automation report. The resolution activity gives the
   * close time (actualend) and the time spent in minutes (timespent); a case resolved before `from` can't have
   * been modified after it, so modifiedon narrows the query and actualend decides.
   */
  async listClosedTickets(from: string, to: string, opts: { max: number }): Promise<HistoricTicket[]> {
    const select = "incidentid,title,description,createdon,modifiedon,_customerid_value,casetypecode";
    const expand = "customerid_account($select=name),Incident_IncidentResolutions($select=actualend,timespent)";
    const rows: Json[] = [];
    let next: string | undefined = `/incidents?$select=${select}&$filter=statecode eq 1 and modifiedon ge ${from}&$orderby=modifiedon desc&$expand=${expand}`;
    while (next && rows.length < opts.max) {
      const { data }: { data: Json } = await this.call<Json>("GET", next);
      rows.push(...((data.value ?? []) as Json[]));
      next = data["@odata.nextLink"];
    }
    const out: HistoricTicket[] = [];
    for (const i of rows) {
      const resolutions = ((i.Incident_IncidentResolutions ?? []) as Json[]).filter((r) => r.actualend).sort((a, b) => String(b.actualend).localeCompare(String(a.actualend)));
      const closedAt = new Date(resolutions[0]?.actualend ?? i.modifiedon).toISOString();
      if (closedAt < from || closedAt >= to) continue;
      const spent = resolutions.reduce((n, r) => n + (typeof r.timespent === "number" ? r.timespent : 0), 0);
      out.push({
        id: String(i.incidentid),
        subject: String(i.title ?? ""),
        description: stripHtml(i.description ?? "").slice(0, 2000),
        customerId: String(i._customerid_value ?? ""),
        customerName: i.customerid_account?.name ?? i["_customerid_value@OData.Community.Display.V1.FormattedValue"] ?? "",
        createdAt: String(i.createdon ?? ""),
        closedAt,
        minutesSpent: spent > 0 ? spent : null,
        category: i["casetypecode@OData.Community.Display.V1.FormattedValue"] ?? null,
      });
    }
    return out.sort((a, b) => b.closedAt.localeCompare(a.closedAt)).slice(0, opts.max);
  }

  async listCustomers(): Promise<ExternalCustomer[]> {
    const accounts = await this.pages<Json>("/accounts?$select=accountid,name,websiteurl,emailaddress1&$filter=statecode eq 0&$orderby=accountid");
    return accounts.map((a) => ({
      id: String(a.accountid),
      name: a.name ?? "",
      domains: [...new Set([hostOf(a.websiteurl), a.emailaddress1?.split("@")[1]?.toLowerCase()].filter((d): d is string => Boolean(d)))],
    }));
  }

  private toTicket(i: Json, notes: Json[], emails: Json[]): ExternalTicket {
    const contact = i.primarycontactid ?? i.customerid_contact ?? null;
    const account = i.customerid_account ?? null;
    const isAccount = i["_customerid_value@Microsoft.Dynamics.CRM.lookuplogicalname"] === "account";
    const comments: ExternalComment[] = [
      ...notes.map((n) => ({
        id: `note:${n.annotationid}`,
        body: stripHtml(`${n.subject ? `${n.subject}\n` : ""}${n.notetext ?? ""}`),
        author: n["_createdby_value@OData.Community.Display.V1.FormattedValue"] ?? "Dynamics user",
        fromCustomer: false,
        public: false,
        createdAt: n.createdon,
      })),
      ...emails.map((e) => ({
        id: `email:${e.activityid}`,
        body: stripHtml(e.description ?? e.subject ?? ""),
        author: e.sender ?? "Customer",
        fromCustomer: true,
        public: true,
        createdAt: e.createdon,
      })),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      id: String(i.incidentid),
      number: String(i.ticketnumber ?? ""),
      subject: i.title ?? "",
      description: stripHtml(i.description ?? ""),
      // Cases filed under a contact belong to that contact's parent account for client mapping.
      customerId: isAccount ? String(i._customerid_value) : String(i.customerid_contact?._parentcustomerid_value ?? i._customerid_value),
      customerName: account?.name ?? i["_customerid_value@OData.Community.Display.V1.FormattedValue"] ?? "",
      requesterEmail: contact?.emailaddress1?.toLowerCase() ?? null,
      requesterName: contact?.fullname ?? "",
      status: fromDynamicsStatus(Number(i.statecode), Number(i.statuscode)),
      externalStatus: i["statuscode@OData.Community.Display.V1.FormattedValue"] ?? String(i.statuscode),
      priority: fromPriority(i.prioritycode),
      updatedAt: i.modifiedon,
      comments,
    };
  }

  /** The case's owner when it's a user (cases owned by a team have no single owner), with their email. */
  private async owner(i: Json): Promise<PsaOwner | null> {
    const id = i._ownerid_value;
    if (!id || i["_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname"] === "team") return null;
    const key = String(id);
    if (!this.users.has(key)) {
      const { data: u } = await this.call<Json>("GET", `/systemusers(${key})?$select=fullname,internalemailaddress`).catch(() => ({ data: {} as Json }));
      const name = String(u.fullname ?? i["_ownerid_value@OData.Community.Display.V1.FormattedValue"] ?? "Dynamics user");
      this.users.set(key, { id: key, name, email: u.internalemailaddress ? String(u.internalemailaddress).toLowerCase() : null });
    }
    return this.users.get(key)!;
  }

  /**
   * Files on the case: documents on its notes (added by users, so a technician's) and attachments on the
   * customer's incoming emails about it (the customer's, linked to that email).
   */
  async listAttachments(ticketId: string): Promise<PsaAttachment[]> {
    if (!GUID.test(ticketId)) throw new ConnectorError(`Not a case id: ${ticketId}`);
    const [notes, emails] = await Promise.all([
      this.pages<Json>(`/annotations?$select=annotationid,filename,mimetype,filesize,createdon&$filter=_objectid_value eq ${ticketId} and isdocument eq true`),
      this.pages<Json>(`/emails?$select=activityid&$filter=_regardingobjectid_value eq ${ticketId} and directioncode eq false&$orderby=createdon desc&$top=10`),
    ]);
    const files: PsaAttachment[] = notes.map((n) => ({
      id: `note:${n.annotationid}`,
      filename: String(n.filename ?? "attachment"),
      contentType: n.mimetype ? String(n.mimetype) : null,
      size: typeof n.filesize === "number" ? n.filesize : null,
      createdAt: String(n.createdon ?? ""),
      fromCustomer: false,
    }));
    for (const email of emails.slice(0, 10)) {
      const attachments = await this.pages<Json>(
        `/activitymimeattachments?$select=activitymimeattachmentid,filename,mimetype,filesize,createdon&$filter=_objectid_value eq ${email.activityid}`,
      );
      for (const a of attachments) {
        files.push({
          id: `email:${a.activitymimeattachmentid}`,
          filename: String(a.filename ?? "attachment"),
          contentType: a.mimetype ? String(a.mimetype) : null,
          size: typeof a.filesize === "number" ? a.filesize : null,
          createdAt: String(a.createdon ?? ""),
          fromCustomer: true,
          commentId: `email:${email.activityid}`,
        });
      }
    }
    return files;
  }

  async getAttachment(_ticketId: string, attachment: PsaAttachment, maxBytes: number): Promise<Uint8Array | null> {
    if (attachment.size && attachment.size > maxBytes) return null;
    const [kind, id] = attachment.id.split(":");
    if (!GUID.test(id ?? "")) throw new ConnectorError(`Not a Dynamics attachment id: ${attachment.id}`);
    const path = kind === "note" ? `/annotations(${id})?$select=documentbody` : `/activitymimeattachments(${id})?$select=body`;
    const { data } = await this.call<Json>("GET", path);
    const base64 = kind === "note" ? data.documentbody : data.body;
    if (typeof base64 !== "string") throw new ConnectorError("Dynamics didn't return the file's content.");
    return decodeCapped(base64, maxBytes);
  }

  async setOwner(ticketId: string, ownerId: string): Promise<void> {
    if (!GUID.test(ticketId) || !GUID.test(ownerId)) throw new ConnectorError(`Not a case or user id: ${ticketId}, ${ownerId}`);
    await this.call("PATCH", `/incidents(${ticketId})`, { "ownerid@odata.bind": `/systemusers(${ownerId})` }, { "if-match": "*" });
  }

  private async activity(id: string): Promise<[Json[], Json[]]> {
    if (!GUID.test(id)) throw new ConnectorError(`Not a case id: ${id}`);
    return Promise.all([
      this.pages<Json>(`/annotations?$select=annotationid,subject,notetext,createdon,_createdby_value&$filter=_objectid_value eq ${id}&$orderby=createdon asc`),
      // Incoming emails regarding the case are the customer's replies.
      this.pages<Json>(
        `/emails?$select=activityid,subject,description,createdon,sender&$filter=_regardingobjectid_value eq ${id} and directioncode eq false&$orderby=createdon asc`,
      ),
    ]);
  }

  async getTicket(id: string): Promise<ExternalTicket> {
    if (!GUID.test(id)) throw new ConnectorError(`Not a case id: ${id}`);
    const [{ data }, [notes, emails]] = await Promise.all([
      this.call<Json>("GET", `/incidents(${id})?$select=${INCIDENT_SELECT}&$expand=${INCIDENT_EXPAND}`),
      this.activity(id),
    ]);
    return { ...this.toTicket(data, notes, emails), owner: await this.owner(data) };
  }

  async listUpdatedTickets(since: string | null): Promise<ExternalTicket[]> {
    const from = since ?? new Date(this.nowMs() - FIRST_SYNC_LOOKBACK_MS).toISOString();
    const incidents = await this.pages<Json>(
      `/incidents?$select=${INCIDENT_SELECT}&$filter=modifiedon gt ${from}&$orderby=modifiedon asc,incidentid asc&$expand=${INCIDENT_EXPAND}`,
    );
    const tickets: ExternalTicket[] = [];
    for (const incident of incidents) {
      const [notes, emails] = await this.activity(String(incident.incidentid));
      tickets.push({ ...this.toTicket(incident, notes, emails), owner: await this.owner(incident) });
    }
    return tickets;
  }

  async addComment(ticketId: string, comment: { body: string; public: boolean }): Promise<string> {
    const { data, headers } = await this.call<Json>(
      "POST",
      "/annotations?$select=annotationid",
      {
        subject: comment.public ? "Reply to the customer (sent by Haley)" : "Haley note",
        notetext: comment.body,
        "objectid_incident@odata.bind": `/incidents(${ticketId})`,
      },
      { prefer: "return=representation" },
    );
    return `note:${this.createdId(data, headers, "annotationid")}`;
  }

  async setStatus(ticketId: string, status: TicketStatus): Promise<void> {
    const { data: current } = await this.call<Json>("GET", `/incidents(${ticketId})?$select=statecode`);
    const resolved = status === "resolved" || status === "closed";
    if (resolved) {
      if (Number(current.statecode) !== 0) return;
      await this.call("POST", "/CloseIncident", {
        IncidentResolution: {
          "@odata.type": "Microsoft.Dynamics.CRM.incidentresolution",
          subject: "Resolved by Haley",
          "incidentid@odata.bind": `/incidents(${ticketId})`,
        },
        Status: 5,
      });
      return;
    }
    // Reactivating or moving between active reasons: always set statecode and statuscode together.
    await this.call("PATCH", `/incidents(${ticketId})`, { statecode: 0, statuscode: status === "waiting_on_customer" ? 3 : 1 }, { "if-match": "*" });
  }

  async createTicket(input: { customerId: string; subject: string; description: string; requesterEmail: string | null; priority: TicketPriority }) {
    let contactId: string | null = null;
    if (input.requesterEmail) {
      const email = input.requesterEmail.replace(/'/g, "''");
      const contacts = await this.pages<Json>(`/contacts?$select=contactid&$filter=emailaddress1 eq '${email}'`);
      contactId = contacts[0]?.contactid ?? null;
    }
    const { data, headers } = await this.call<Json>(
      "POST",
      "/incidents?$select=incidentid,ticketnumber",
      {
        title: input.subject.slice(0, 200),
        description: input.description,
        prioritycode: toPriority(input.priority),
        "customerid_account@odata.bind": `/accounts(${input.customerId})`,
        ...(contactId ? { "primarycontactid@odata.bind": `/contacts(${contactId})` } : {}),
      },
      { prefer: "return=representation" },
    );
    const id = this.createdId(data, headers, "incidentid");
    return { id, number: String(data.ticketnumber ?? id) };
  }
}

registerPsaFactory("dynamics", (_connection, config, fetchImpl) =>
  new DynamicsAdapter({ orgUrl: config.orgUrl, tenantId: config.tenantId, clientId: config.clientId, clientSecret: config.clientSecret }, fetchImpl),
);
