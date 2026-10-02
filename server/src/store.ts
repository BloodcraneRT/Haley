import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { seal, unseal } from "./crypto.js";
import { tx, type Db } from "./db.js";
import type {
  Action,
  ActionStatus,
  AuditEntry,
  Assurance,
  ClientMemory,
  Cadence,
  Autonomy,
  Integration,
  IntegrationMode,
  KbArticle,
  Org,
  OrgSettings,
  ProviderId,
  Risk,
  Run,
  RunKind,
  Schedule,
  RunMode,
  RunStatus,
  Ticket,
  TicketEvent,
  TicketPriority,
  TicketChannel,
  TicketStatus,
} from "./types.js";
import { DEFAULT_BILLING_SETTINGS, DEFAULT_ORG_SETTINGS, type BillingSettings } from "./types.js";
import type { ModelProfile } from "./ai/providers.js";
import { DEFAULT_PSA_OPTIONS, type PsaConnection, type PsaKind, type PsaOptions, type TicketLink } from "./psa/types.js";

type Row = Record<string, unknown>;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export interface PendingState {
  /** tool_use ids in the order the model emitted them. */
  order: string[];
  /** Results already produced for auto-executed calls in the same turn. */
  results: Record<string, { content: string; is_error: boolean }>;
}

export interface TicketFilter {
  orgId?: string;
  status?: string;
  search?: string;
  limit?: number;
}

export class Store {
  constructor(
    readonly db: Db,
    private readonly secretKey: Buffer,
  ) {}

  // ---------------------------------------------------------------- orgs

  createOrg(input: { name: string; domain?: string; autonomy?: Autonomy; notes?: string; settings?: Partial<OrgSettings> }): Org {
    const org: Org = {
      id: newId("org"),
      name: input.name,
      domain: input.domain ?? "",
      autonomy: input.autonomy ?? "supervised",
      notes: input.notes ?? "",
      settings: { ...DEFAULT_ORG_SETTINGS, ...input.settings },
      created_at: now(),
    };
    this.db
      .prepare("INSERT INTO orgs (id, name, domain, autonomy, notes, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(org.id, org.name, org.domain, org.autonomy, org.notes, json(org.settings), org.created_at);
    return org;
  }

  listOrgs(): Org[] {
    return (this.db.prepare("SELECT * FROM orgs ORDER BY name COLLATE NOCASE").all() as Row[]).map((r) => this.toOrg(r));
  }

  getOrg(id: string): Org | null {
    const row = this.db.prepare("SELECT * FROM orgs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toOrg(row) : null;
  }

  updateOrg(
    id: string,
    patch: Partial<Pick<Org, "name" | "domain" | "autonomy" | "notes">> & { settings?: Partial<OrgSettings> },
  ): Org | null {
    const org = this.getOrg(id);
    if (!org) return null;
    const next = { ...org, ...patch, settings: { ...org.settings, ...patch.settings } };
    this.db
      .prepare("UPDATE orgs SET name = ?, domain = ?, autonomy = ?, notes = ?, settings = ? WHERE id = ?")
      .run(next.name, next.domain, next.autonomy, next.notes, json(next.settings), id);
    return next;
  }

  /** The org whose primary or extra email domains include this address's domain. */
  findOrgByEmailDomain(email: string): Org | null {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return null;
    return (
      this.listOrgs().find(
        (o) => o.domain.toLowerCase() === domain || o.settings.emailDomains.some((d) => d.toLowerCase() === domain),
      ) ?? null
    );
  }

  private toOrg(row: Row): Org {
    return { ...(row as unknown as Org), settings: { ...DEFAULT_ORG_SETTINGS, ...parse<Partial<OrgSettings>>(row.settings, {}) } };
  }

  deleteOrg(id: string): boolean {
    return this.db.prepare("DELETE FROM orgs WHERE id = ?").run(id).changes > 0;
  }

  // -------------------------------------------------------- integrations

  createIntegration(input: {
    orgId: string;
    provider: ProviderId;
    label: string;
    mode: IntegrationMode;
    config: Record<string, string>;
  }): Integration {
    const id = newId("int");
    const created = now();
    this.db
      .prepare(
        `INSERT INTO integrations (id, org_id, provider, label, mode, config_sealed, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?)`,
      )
      .run(id, input.orgId, input.provider, input.label, input.mode, seal(this.secretKey, json(input.config)), created);
    return this.getIntegration(id)!;
  }

  listIntegrations(orgId?: string): Integration[] {
    const rows = orgId
      ? this.db.prepare("SELECT * FROM integrations WHERE org_id = ? ORDER BY provider").all(orgId)
      : this.db.prepare("SELECT * FROM integrations ORDER BY org_id, provider").all();
    return rows.map((r) => this.toIntegration(r as Row));
  }

  getIntegration(id: string): Integration | null {
    const row = this.db.prepare("SELECT * FROM integrations WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toIntegration(row) : null;
  }

  /** Decrypted credentials. Never return these from an API route. */
  getIntegrationConfig(id: string): Record<string, string> {
    const row = this.db.prepare("SELECT config_sealed FROM integrations WHERE id = ?").get(id) as Row | undefined;
    if (!row?.config_sealed) return {};
    return parse(unseal(this.secretKey, row.config_sealed as string), {});
  }

  getIntegrationState<T>(id: string): T | null {
    const row = this.db.prepare("SELECT state FROM integrations WHERE id = ?").get(id) as Row | undefined;
    return parse<T | null>(row?.state, null);
  }

  setIntegrationState(id: string, state: unknown): void {
    this.db.prepare("UPDATE integrations SET state = ? WHERE id = ?").run(json(state), id);
  }

  /** Latest tenant discovery for an integration (Microsoft 365 onboarding). */
  saveDiscovery(integrationId: string, data: unknown): void {
    this.db
      .prepare("INSERT INTO tenant_discoveries (integration_id, data, created_at) VALUES (?, ?, ?) ON CONFLICT(integration_id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at")
      .run(integrationId, json(data), now());
  }

  getDiscovery<T>(integrationId: string): T | null {
    const row = this.db.prepare("SELECT data FROM tenant_discoveries WHERE integration_id = ?").get(integrationId) as Row | undefined;
    return parse<T | null>(row?.data, null);
  }

  setIntegrationStatus(id: string, status: Integration["status"], detail: string): void {
    this.db.prepare("UPDATE integrations SET status = ?, status_detail = ? WHERE id = ?").run(status, detail, id);
  }

  deleteIntegration(id: string): boolean {
    return this.db.prepare("DELETE FROM integrations WHERE id = ?").run(id).changes > 0;
  }

  private toIntegration(row: Row): Integration {
    return {
      id: row.id as string,
      org_id: row.org_id as string,
      provider: row.provider as ProviderId,
      label: row.label as string,
      mode: row.mode as IntegrationMode,
      status: row.status as Integration["status"],
      status_detail: row.status_detail as string,
      created_at: row.created_at as string,
    };
  }

  // ------------------------------------------------------------- tickets

  createTicket(input: {
    orgId: string;
    title: string;
    description?: string;
    requesterName?: string;
    requesterEmail?: string;
    priority?: TicketPriority;
    category?: string;
    author?: string;
    channel?: TicketChannel;
    channelRef?: Record<string, string>;
    assurance?: Assurance;
    verification?: string;
  }): Ticket {
    return tx(this.db, () => {
      const next = this.db.prepare("SELECT COALESCE(MAX(number), 1000) + 1 AS n FROM tickets").get() as Row;
      const ts = now();
      const ticket: Ticket = {
        id: newId("tkt"),
        number: Number(next.n),
        org_id: input.orgId,
        title: input.title,
        description: input.description ?? "",
        requester_name: input.requesterName ?? "",
        requester_email: input.requesterEmail ?? "",
        status: "new",
        priority: input.priority ?? "normal",
        category: input.category ?? "uncategorized",
        assignee: "haley",
        channel: input.channel ?? "portal",
        channel_ref: input.channelRef ?? {},
        assurance: input.assurance ?? "none",
        verification: input.verification ?? "",
        needs_followup: false,
        first_response_at: null,
        resolved_at: null,
        sla_escalated: false,
        mfa_verified_at: null,
        mfa_method: "",
        resolution_confirmed_at: null,
        created_at: ts,
        updated_at: ts,
      };
      this.db
        .prepare(
          `INSERT INTO tickets (id, number, org_id, title, description, requester_name, requester_email,
             status, priority, category, assignee, channel, channel_ref, assurance, verification, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ticket.id,
          ticket.number,
          ticket.org_id,
          ticket.title,
          ticket.description,
          ticket.requester_name,
          ticket.requester_email,
          ticket.status,
          ticket.priority,
          ticket.category,
          ticket.assignee,
          ticket.channel,
          json(ticket.channel_ref),
          ticket.assurance,
          ticket.verification,
          ticket.created_at,
          ticket.updated_at,
        );
      this.addTicketEvent(ticket.id, "created", input.author ?? (ticket.requester_name || "system"), ticket.description);
      return ticket;
    });
  }

  listTickets(filter: TicketFilter = {}): Ticket[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.orgId) {
      where.push("org_id = ?");
      args.push(filter.orgId);
    }
    if (filter.status === "open") {
      where.push("status NOT IN ('resolved', 'closed')");
    } else if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    if (filter.search) {
      where.push("(title LIKE ? OR description LIKE ? OR requester_name LIKE ? OR CAST(number AS TEXT) = ?)");
      const like = `%${filter.search}%`;
      args.push(like, like, like, filter.search.replace(/^#/, ""));
    }
    const sql = `SELECT * FROM tickets ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, updated_at DESC
      LIMIT ?`;
    args.push(filter.limit ?? 200);
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => this.toTicket(r));
  }

  /** Exact client queue counts, independent of the dashboard's ticket-list limit. */
  countOpenTicketsByOrg(): Map<string, number> {
    const rows = this.db.prepare("SELECT org_id, COUNT(*) AS n FROM tickets WHERE status NOT IN ('resolved', 'closed') GROUP BY org_id").all() as Row[];
    return new Map(rows.map((r) => [r.org_id as string, Number(r.n)]));
  }

  getTicket(id: string): Ticket | null {
    const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toTicket(row) : null;
  }

  getTicketByNumber(number: number): Ticket | null {
    const row = this.db.prepare("SELECT * FROM tickets WHERE number = ?").get(number) as Row | undefined;
    return row ? this.toTicket(row) : null;
  }

  /**
   * Most recently updated open ticket matching a channel reference key, for threading follow-up messages.
   * A ticket resolved within `confirmSince` that the requester hasn't confirmed yet still counts, so their
   * "yes, that fixed it" (or "no, still broken") lands on it instead of opening a new ticket.
   */
  findOpenTicketByChannelRef(orgId: string, channel: TicketChannel, key: string, value: string, confirmSince?: string): Ticket | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tickets WHERE org_id = ? AND channel = ?
           AND (status NOT IN ('resolved', 'closed') OR (status = 'resolved' AND resolution_confirmed_at IS NULL AND resolved_at >= ?))
           AND json_extract(channel_ref, '$.' || ?) = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(orgId, channel, confirmSince ?? "9999", key, value) as Row | undefined;
    return row ? this.toTicket(row) : null;
  }

  setTicketChannelRef(id: string, ref: Record<string, string>): void {
    this.db.prepare("UPDATE tickets SET channel_ref = ? WHERE id = ?").run(json(ref), id);
  }

  setNeedsFollowup(id: string, value: boolean): void {
    this.db.prepare("UPDATE tickets SET needs_followup = ? WHERE id = ?").run(value ? 1 : 0, id);
  }

  private toTicket(row: Row): Ticket {
    return {
      ...(row as unknown as Ticket),
      channel_ref: parse(row.channel_ref, {}),
      needs_followup: Boolean(row.needs_followup),
      sla_escalated: Boolean(row.sla_escalated),
    };
  }

  /**
   * The requester confirmed Haley's fix. Their reply briefly reopened the ticket, so `resolvedAt` puts back
   * when the fix was actually made; SLA and reports shouldn't count the wait for their answer.
   */
  markResolutionConfirmed(id: string, at: string, resolvedAt?: string): void {
    this.db.prepare("UPDATE tickets SET resolution_confirmed_at = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?").run(at, resolvedAt ?? null, id);
  }

  /** Tickets Haley resolved that have waited in "resolved" since before `before` (for auto-close). */
  listResolvedAwaitingClose(before: string): Ticket[] {
    return (
      this.db
        .prepare("SELECT * FROM tickets WHERE status = 'resolved' AND assignee = 'haley' AND resolved_at IS NOT NULL AND resolved_at < ? ORDER BY resolved_at LIMIT 1000")
        .all(before) as Row[]
    ).map((r) => this.toTicket(r));
  }

  markMfaVerified(id: string, method: string, at: string): void {
    this.db.prepare("UPDATE tickets SET mfa_verified_at = ?, mfa_method = ? WHERE id = ?").run(at, method, id);
  }

  recordVerification(input: { orgId: string; ticketId: string | null; method: string; target: string; outcome: string; detail: string }): void {
    this.db
      .prepare(
        "INSERT INTO verification_attempts (id, org_id, ticket_id, method, target, outcome, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(newId("ver"), input.orgId, input.ticketId, input.method, input.target.toLowerCase(), input.outcome, input.detail, now());
  }

  listVerifications(filter: { ticketId?: string; target?: string; since?: string }): Array<{ method: string; target: string; outcome: string; detail: string; ticket_id: string | null; created_at: string }> {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.ticketId) {
      where.push("ticket_id = ?");
      args.push(filter.ticketId);
    }
    if (filter.target) {
      where.push("target = ?");
      args.push(filter.target.toLowerCase());
    }
    if (filter.since) {
      where.push("created_at >= ?");
      args.push(filter.since);
    }
    return this.db
      .prepare(`SELECT * FROM verification_attempts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`)
      .all(...args) as never;
  }

  /** A view-once link to an action's credential. Only the token's hash is stored. */
  createSecretLink(actionId: string, ticketId: string, ttlMs: number): string {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + ttlMs).toISOString();
    this.db
      .prepare("INSERT INTO secret_links (token_hash, action_id, ticket_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashToken(token), actionId, ticketId, expires, now());
    return token;
  }

  getSecretLink(token: string): { action_id: string; ticket_id: string; expires_at: string; viewed_at: string | null } | null {
    return (this.db.prepare("SELECT * FROM secret_links WHERE token_hash = ?").get(hashToken(token)) as never) ?? null;
  }

  /** Marks the link used; false if it was already used or expired. */
  consumeSecretLink(token: string): boolean {
    return (
      this.db
        .prepare("UPDATE secret_links SET viewed_at = ? WHERE token_hash = ? AND viewed_at IS NULL AND expires_at > ?")
        .run(now(), hashToken(token), now()).changes > 0
    );
  }

  markSlaEscalated(id: string): void {
    this.db.prepare("UPDATE tickets SET sla_escalated = 1 WHERE id = ?").run(id);
  }

  updateTicket(
    id: string,
    patch: Partial<Pick<Ticket, "status" | "priority" | "category" | "assignee" | "title">>,
    actor: string,
  ): Ticket | null {
    const ticket = this.getTicket(id);
    if (!ticket) return null;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && ticket[key as keyof Ticket] !== value) {
        changes[key] = { from: ticket[key as keyof Ticket], to: value };
      }
    }
    if (Object.keys(changes).length === 0) return ticket;
    const next = { ...ticket, ...patch, updated_at: now() } as Ticket;
    if (patch.status === "resolved" || patch.status === "closed") {
      next.needs_followup = false;
      next.resolved_at ??= next.updated_at;
    } else if (patch.status) {
      next.resolved_at = null;
      next.resolution_confirmed_at = null;
    }
    this.db
      .prepare(
        "UPDATE tickets SET status = ?, priority = ?, category = ?, assignee = ?, title = ?, needs_followup = ?, resolved_at = ?, resolution_confirmed_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(next.status, next.priority, next.category, next.assignee, next.title, next.needs_followup ? 1 : 0, next.resolved_at, next.resolution_confirmed_at, next.updated_at, id);
    for (const [field, change] of Object.entries(changes)) {
      this.addTicketEvent(
        id,
        field === "status" ? "status_change" : "field_change",
        actor,
        `${field}: ${String(change.from)} → ${String(change.to)}`,
        { field, ...change },
        // Same instant as the ticket's updated_at/resolved_at, so the event can stand in for them later.
        next.updated_at,
      );
    }
    return next;
  }

  setTicketStatus(id: string, status: TicketStatus, actor: string): Ticket | null {
    return this.updateTicket(id, { status }, actor);
  }

  addTicketEvent(
    ticketId: string,
    kind: TicketEvent["kind"],
    author: string,
    body: string,
    meta: Record<string, unknown> = {},
    at: string = now(),
  ): TicketEvent {
    const event: TicketEvent = { id: newId("evt"), ticket_id: ticketId, kind, author, body, meta, created_at: at };
    this.db
      .prepare("INSERT INTO ticket_events (id, ticket_id, kind, author, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(event.id, ticketId, kind, author, body, json(meta), event.created_at);
    this.db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(event.created_at, ticketId);
    if (kind === "reply" && !meta.auto) {
      this.db.prepare("UPDATE tickets SET first_response_at = ? WHERE id = ? AND first_response_at IS NULL").run(event.created_at, ticketId);
    }
    return event;
  }

  mergeEventMeta(eventId: string, meta: Record<string, unknown>): Record<string, unknown> {
    const row = this.db.prepare("SELECT meta FROM ticket_events WHERE id = ?").get(eventId) as Row | undefined;
    const merged = { ...parse<Record<string, unknown>>(row?.meta, {}), ...meta };
    this.db.prepare("UPDATE ticket_events SET meta = ? WHERE id = ?").run(json(merged), eventId);
    return merged;
  }

  listTicketEvents(ticketId: string): TicketEvent[] {
    return (this.db.prepare("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at, rowid").all(ticketId) as Row[]).map(
      (r) => ({ ...(r as unknown as TicketEvent), meta: parse(r.meta, {}) }),
    );
  }

  /** Reporting needs activity flags, not every timeline body in a query per ticket. */
  ticketActivityForReport(orgId: string): Map<string, { resolvedByHaley: boolean; escalated: boolean; technicianTouched: boolean }> {
    const rows = this.db.prepare(`
      SELECT e.ticket_id,
        MAX(CASE WHEN e.kind = 'status_change' AND e.author = 'haley'
          AND json_extract(e.meta, '$.to') IN ('resolved', 'closed') THEN 1 ELSE 0 END) AS resolved_by_haley,
        MAX(CASE WHEN e.kind = 'escalation' OR
          (e.kind = 'status_change' AND json_extract(e.meta, '$.to') = 'escalated')
          THEN 1 ELSE 0 END) AS escalated,
        MAX(CASE WHEN json_extract(e.meta, '$.fromTechnician') = 1 OR (e.author NOT IN ('haley', 'system') AND (
          (e.kind IN ('comment', 'reply') AND e.author <> t.requester_name
            AND json_extract(e.meta, '$.channel') IS NULL AND COALESCE(json_extract(e.meta, '$.auto'), 0) = 0)
          OR e.kind IN ('status_change', 'field_change', 'agent_note')
          OR (e.kind = 'action' AND json_extract(e.meta, '$.decision') IN ('approved', 'rejected'))
        )) THEN 1 ELSE 0 END) AS technician_touched
      FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.org_id = ? GROUP BY e.ticket_id
    `).all(orgId) as Row[];
    return new Map(rows.map((r) => [r.ticket_id as string, {
      resolvedByHaley: Boolean(r.resolved_by_haley),
      escalated: Boolean(r.escalated),
      technicianTouched: Boolean(r.technician_touched),
    }]));
  }

  // ---------------------------------------------------------------- runs

  createRun(input: {
    orgId: string;
    ticketId?: string | null;
    kind: RunKind;
    mode?: RunMode;
    title: string;
    instruction: string;
    createdBy: string;
    templateId?: string | null;
  }): Run {
    const ts = now();
    const id = newId("run");
    this.db
      .prepare(
        `INSERT INTO runs (id, org_id, ticket_id, kind, mode, title, instruction, status, created_by, template_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(id, input.orgId, input.ticketId ?? null, input.kind, input.mode ?? "live", input.title, input.instruction, input.createdBy, input.templateId ?? null, ts, ts);
    return this.getRun(id)!;
  }

  getRun(id: string): Run | null {
    const row = this.db
      .prepare(
        `SELECT id, org_id, ticket_id, kind, mode, title, instruction, status, summary, error, iterations,
                input_tokens, output_tokens, model, template_id, created_by, created_at, updated_at FROM runs WHERE id = ?`,
      )
      .get(id);
    return (row as unknown as Run) ?? null;
  }

  listRuns(filter: { orgId?: string; ticketId?: string; kind?: RunKind; limit?: number } = {}): Run[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.orgId) {
      where.push("org_id = ?");
      args.push(filter.orgId);
    }
    if (filter.ticketId) {
      where.push("ticket_id = ?");
      args.push(filter.ticketId);
    }
    if (filter.kind) {
      where.push("kind = ?");
      args.push(filter.kind);
    }
    args.push(filter.limit ?? 100);
    return this.db
      .prepare(
        `SELECT id, org_id, ticket_id, kind, mode, title, instruction, status, summary, error, iterations,
                input_tokens, output_tokens, model, template_id, created_by, created_at, updated_at
         FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...args) as unknown as Run[];
  }

  getRunMessages<T>(id: string): T[] {
    const row = this.db.prepare("SELECT messages FROM runs WHERE id = ?").get(id) as Row | undefined;
    return parse<T[]>(row?.messages, []);
  }

  getRunPending(id: string): PendingState | null {
    const row = this.db.prepare("SELECT pending FROM runs WHERE id = ?").get(id) as Row | undefined;
    return parse<PendingState | null>(row?.pending, null);
  }

  saveRunProgress(
    id: string,
    patch: {
      status?: RunStatus;
      messages?: unknown[];
      pending?: PendingState | null;
      summary?: string;
      error?: string;
      addIterations?: number;
      addInputTokens?: number;
      addOutputTokens?: number;
      model?: string;
    },
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const args: SQLInputValue[] = [now()];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      args.push(patch.status);
    }
    if (patch.messages !== undefined) {
      sets.push("messages = ?");
      args.push(json(patch.messages));
    }
    if (patch.pending !== undefined) {
      sets.push("pending = ?");
      args.push(patch.pending === null ? null : json(patch.pending));
    }
    if (patch.summary !== undefined) {
      sets.push("summary = ?");
      args.push(patch.summary);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      args.push(patch.error);
    }
    if (patch.model !== undefined) {
      sets.push("model = ?");
      args.push(patch.model);
    }
    if (patch.addIterations) {
      sets.push("iterations = iterations + ?");
      args.push(patch.addIterations);
    }
    if (patch.addInputTokens) {
      sets.push("input_tokens = input_tokens + ?");
      args.push(patch.addInputTokens);
    }
    if (patch.addOutputTokens) {
      sets.push("output_tokens = output_tokens + ?");
      args.push(patch.addOutputTokens);
    }
    args.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  /** Runs left mid-flight by a previous process. */
  listInterruptedRuns(): Run[] {
    return this.db
      .prepare("SELECT id FROM runs WHERE status IN ('queued', 'running')")
      .all()
      .map((r) => this.getRun((r as Row).id as string)!);
  }

  // ------------------------------------------------------------- usage & billing

  /** Bound each export batch after selecting eligible work so linked recent tickets cannot hide older ones. */
  listTicketsAwaitingPsaExport(connection: PsaConnection, orgId: string, limit = 500): Ticket[] {
    return (this.db.prepare(`
      SELECT t.* FROM tickets t
      WHERE t.org_id = ? AND t.created_at >= ? AND t.channel <> ?
        AND NOT EXISTS (SELECT 1 FROM ticket_links l WHERE l.ticket_id = t.id AND l.connection_id = ?)
      ORDER BY t.created_at, t.number LIMIT ?
    `).all(orgId, connection.created_at, connection.kind, connection.id, limit) as Row[]).map((r) => this.toTicket(r));
  }

  recordModelUsage(input: { runId: string; orgId: string; model: string; inputTokens: number; outputTokens: number }): void {
    this.db
      .prepare("INSERT INTO model_usage (run_id, org_id, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.runId, input.orgId, input.model, input.inputTokens, input.outputTokens, now());
  }

  /** Token totals per client and model in [from, to). */
  modelUsageSummary(from: string, to: string, orgId?: string): Array<{ org_id: string; model: string; calls: number; input_tokens: number; output_tokens: number }> {
    const where = `created_at >= ? AND created_at < ?${orgId ? " AND org_id = ?" : ""}`;
    const args: SQLInputValue[] = orgId ? [from, to, orgId] : [from, to];
    return this.db
      .prepare(
        `SELECT org_id, model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
         FROM model_usage WHERE ${where} GROUP BY org_id, model`,
      )
      .all(...args) as Array<{ org_id: string; model: string; calls: number; input_tokens: number; output_tokens: number }>;
  }

  /** Token totals per model for one run. */
  runModelUsage(runId: string): Array<{ model: string; calls: number; input_tokens: number; output_tokens: number }> {
    return this.db
      .prepare("SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM model_usage WHERE run_id = ? GROUP BY model")
      .all(runId) as Array<{ model: string; calls: number; input_tokens: number; output_tokens: number }>;
  }

  getBillingSettings(): BillingSettings {
    const row = this.db.prepare("SELECT value FROM workspace_settings WHERE key = 'billing'").get() as Row | undefined;
    return { ...DEFAULT_BILLING_SETTINGS, ...parse<Partial<BillingSettings>>(row?.value, {}) };
  }

  setBillingSettings(patch: Partial<BillingSettings>): BillingSettings {
    const next = { ...this.getBillingSettings(), ...patch };
    this.db
      .prepare("INSERT INTO workspace_settings (key, value) VALUES ('billing', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(json(next));
    return next;
  }

  /** Distinct technician names that approved, rejected, commented or started work in [from, to) (dashboard sign-in names). */
  activeTechnicians(from: string, to: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT actor FROM audit_log WHERE created_at >= ? AND created_at < ?
         AND actor NOT IN ('haley', 'system', 'microsoft', 'scheduler', 'technician', 'intake', 'requester') AND actor NOT LIKE '%@%'`,
      )
      .all(from, to) as Array<{ actor: string }>;
    return rows.map((r) => r.actor).sort((a, b) => a.localeCompare(b));
  }

  // ------------------------------------------------------------- memory

  createMemory(input: {
    orgId: string;
    content: string;
    status: ClientMemory["status"];
    source: ClientMemory["source"];
    createdBy: string;
    runId?: string | null;
    ticketId?: string | null;
  }): ClientMemory {
    const id = newId("mem");
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO client_memories (id, org_id, content, status, source, run_id, ticket_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.orgId, input.content, input.status, input.source, input.runId ?? null, input.ticketId ?? null, input.createdBy, ts, ts);
    return this.getMemory(id)!;
  }

  getMemory(id: string): ClientMemory | null {
    return (this.db.prepare("SELECT * FROM client_memories WHERE id = ?").get(id) as unknown as ClientMemory | undefined) ?? null;
  }

  /** Newest first. */
  listMemories(orgId: string, status?: ClientMemory["status"]): ClientMemory[] {
    return (
      status
        ? this.db.prepare("SELECT * FROM client_memories WHERE org_id = ? AND status = ? ORDER BY updated_at DESC, rowid DESC").all(orgId, status)
        : this.db.prepare("SELECT * FROM client_memories WHERE org_id = ? ORDER BY updated_at DESC, rowid DESC").all(orgId)
    ) as unknown as ClientMemory[];
  }

  updateMemory(id: string, patch: { content?: string; status?: ClientMemory["status"]; reviewedBy?: string }): ClientMemory | null {
    const current = this.getMemory(id);
    if (!current) return null;
    this.db
      .prepare("UPDATE client_memories SET content = ?, status = ?, reviewed_by = COALESCE(?, reviewed_by), updated_at = ? WHERE id = ?")
      .run(patch.content ?? current.content, patch.status ?? current.status, patch.reviewedBy ?? null, now(), id);
    return this.getMemory(id);
  }

  deleteMemory(id: string): boolean {
    return this.db.prepare("DELETE FROM client_memories WHERE id = ?").run(id).changes > 0;
  }

  // ------------------------------------------------------------- actions

  createAction(input: {
    runId: string;
    orgId: string;
    toolUseId: string;
    tool: string;
    input: unknown;
    risk: Risk;
    description: string;
    rationale: string;
    status: ActionStatus;
    policyReason?: string;
    approvers?: string[];
  }): Action {
    const id = newId("act");
    this.db
      .prepare(
        `INSERT INTO actions (id, run_id, org_id, tool_use_id, tool, input, risk, description, rationale, status, policy_reason, approvers, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.orgId,
        input.toolUseId,
        input.tool,
        json(input.input),
        input.risk,
        input.description,
        input.rationale,
        input.status,
        input.policyReason ?? "",
        json(input.approvers ?? []),
        now(),
      );
    return this.getAction(id)!;
  }

  getAction(id: string): Action | null {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toAction(row) : null;
  }

  listActions(filter: { runId?: string; status?: ActionStatus; orgId?: string; limit?: number } = {}): Action[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.runId) {
      where.push("run_id = ?");
      args.push(filter.runId);
    }
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    if (filter.orgId) {
      where.push("org_id = ?");
      args.push(filter.orgId);
    }
    args.push(filter.limit ?? 500);
    return (
      this.db
        .prepare(`SELECT * FROM actions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid LIMIT ?`)
        .all(...args) as Row[]
    ).map((r) => this.toAction(r));
  }

  finishAction(
    id: string,
    patch: {
      status: ActionStatus;
      result?: unknown;
      secrets?: Record<string, string> | null;
      decidedBy?: string;
      decisionNote?: string;
    },
  ): void {
    const ts = now();
    this.db
      .prepare(
        `UPDATE actions SET status = ?, result = COALESCE(?, result),
           secrets_sealed = COALESCE(?, secrets_sealed),
           decided_by = COALESCE(?, decided_by), decision_note = COALESCE(?, decision_note),
           decided_at = CASE WHEN ? IS NOT NULL THEN ? ELSE decided_at END,
           executed_at = CASE WHEN ? IN ('executed', 'failed') THEN ? ELSE executed_at END
         WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.result === undefined ? null : json(patch.result),
        patch.secrets ? seal(this.secretKey, json(patch.secrets)) : null,
        patch.decidedBy ?? null,
        patch.decisionNote ?? null,
        patch.decidedBy ?? null,
        ts,
        patch.status,
        ts,
        id,
      );
  }

  /** Atomically moves an action out of pending_approval; returns false if someone else already decided. */
  claimPendingAction(id: string, decidedBy: string, note: string, approve: boolean): boolean {
    const res = this.db
      .prepare(
        `UPDATE actions SET status = ?, decided_by = ?, decision_note = ?, decided_at = ?
         WHERE id = ? AND status = 'pending_approval'`,
      )
      .run(approve ? "approved" : "rejected", decidedBy, note, now(), id);
    return res.changes > 0;
  }

  revealActionSecrets(id: string): Record<string, string> | null {
    const row = this.db.prepare("SELECT secrets_sealed FROM actions WHERE id = ?").get(id) as Row | undefined;
    if (!row?.secrets_sealed) return null;
    return parse(unseal(this.secretKey, row.secrets_sealed as string), null);
  }

  private toAction(row: Row): Action {
    return {
      id: row.id as string,
      run_id: row.run_id as string,
      org_id: row.org_id as string,
      tool_use_id: row.tool_use_id as string,
      tool: row.tool as string,
      input: parse(row.input, {}),
      risk: row.risk as Risk,
      description: row.description as string,
      rationale: row.rationale as string,
      policy_reason: (row.policy_reason as string) ?? "",
      approvers: parse<string[]>(row.approvers, []),
      status: row.status as ActionStatus,
      result: parse(row.result, null),
      has_secrets: Boolean(row.secrets_sealed),
      decided_by: (row.decided_by as string) ?? null,
      decision_note: (row.decision_note as string) ?? null,
      decided_at: (row.decided_at as string) ?? null,
      executed_at: (row.executed_at as string) ?? null,
      created_at: row.created_at as string,
    };
  }

  // ------------------------------------------------------------------ kb

  saveArticle(input: {
    id?: string;
    orgId: string | null;
    title: string;
    body: string;
    tags?: string[];
    source?: KbArticle["source"];
    runId?: string | null;
  }): KbArticle {
    const ts = now();
    const existing = input.id ? this.getArticle(input.id) : null;
    if (existing) {
      this.db
        .prepare("UPDATE kb_articles SET title = ?, body = ?, tags = ?, updated_at = ? WHERE id = ?")
        .run(input.title, input.body, json(input.tags ?? existing.tags), ts, existing.id);
      return this.getArticle(existing.id)!;
    }
    const id = newId("kb");
    this.db
      .prepare(
        `INSERT INTO kb_articles (id, org_id, title, body, tags, source, run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.orgId, input.title, input.body, json(input.tags ?? []), input.source ?? "manual", input.runId ?? null, ts, ts);
    return this.getArticle(id)!;
  }

  getArticle(id: string): KbArticle | null {
    const row = this.db.prepare("SELECT * FROM kb_articles WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toArticle(row) : null;
  }

  /** Org-scoped search that also includes global (org_id NULL) articles. */
  searchArticles(filter: { orgId?: string | null; query?: string; limit?: number } = {}): KbArticle[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.orgId) {
      where.push("(org_id = ? OR org_id IS NULL)");
      args.push(filter.orgId);
    }
    const terms = (filter.query ?? "").toLowerCase().split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
    if (terms.length) {
      where.push(`(${terms.map(() => "(LOWER(title) LIKE ? OR LOWER(body) LIKE ? OR LOWER(tags) LIKE ?)").join(" OR ")})`);
      for (const t of terms) args.push(`%${t}%`, `%${t}%`, `%${t}%`);
    }
    args.push(filter.limit ?? 100);
    const rows = this.db
      .prepare(`SELECT * FROM kb_articles ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`)
      .all(...args) as Row[];
    const articles = rows.map((r) => this.toArticle(r));
    if (!terms.length) return articles;
    const score = (a: KbArticle) =>
      terms.reduce((s, t) => s + (a.title.toLowerCase().includes(t) ? 3 : 0) + (a.body.toLowerCase().includes(t) ? 1 : 0), 0);
    return articles.sort((a, b) => score(b) - score(a));
  }

  deleteArticle(id: string): boolean {
    return this.db.prepare("DELETE FROM kb_articles WHERE id = ?").run(id).changes > 0;
  }

  private toArticle(row: Row): KbArticle {
    return { ...(row as unknown as KbArticle), tags: parse(row.tags, []) };
  }

  // -------------------------------------------------------------- models

  createModelProfile(input: {
    name: string;
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
    options?: Record<string, unknown>;
    fallbackId?: string | null;
    isDefault?: boolean;
  }): ModelProfile {
    const id = newId("mdl");
    tx(this.db, () => {
      if (input.isDefault) this.db.exec("UPDATE model_profiles SET is_default = 0");
      this.db
        .prepare(
          `INSERT INTO model_profiles (id, name, provider, model, base_url, api_key_sealed, options, fallback_id, is_default, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.provider,
          input.model,
          input.baseUrl ?? "",
          input.apiKey ? seal(this.secretKey, input.apiKey) : null,
          json(input.options ?? {}),
          input.fallbackId ?? null,
          input.isDefault ? 1 : 0,
          now(),
        );
    });
    return this.getModelProfile(id)!;
  }

  listModelProfiles(): ModelProfile[] {
    return (this.db.prepare("SELECT * FROM model_profiles ORDER BY is_default DESC, name COLLATE NOCASE").all() as Row[]).map((r) =>
      this.toModelProfile(r),
    );
  }

  getModelProfile(id: string): ModelProfile | null {
    const row = this.db.prepare("SELECT * FROM model_profiles WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toModelProfile(row) : null;
  }

  getDefaultModelProfile(): ModelProfile | null {
    const row = this.db.prepare("SELECT * FROM model_profiles ORDER BY is_default DESC, created_at LIMIT 1").get() as Row | undefined;
    return row ? this.toModelProfile(row) : null;
  }

  /** Decrypted API key. Never return this from an API route. */
  getModelApiKey(id: string): string {
    const row = this.db.prepare("SELECT api_key_sealed FROM model_profiles WHERE id = ?").get(id) as Row | undefined;
    return row?.api_key_sealed ? unseal(this.secretKey, row.api_key_sealed as string) : "";
  }

  updateModelProfile(
    id: string,
    patch: { name?: string; model?: string; baseUrl?: string; apiKey?: string | null; options?: Record<string, unknown>; fallbackId?: string | null; isDefault?: boolean },
  ): ModelProfile | null {
    const current = this.getModelProfile(id);
    if (!current) return null;
    tx(this.db, () => {
      if (patch.isDefault) this.db.exec("UPDATE model_profiles SET is_default = 0");
      const sets: string[] = [];
      const args: SQLInputValue[] = [];
      const set = (col: string, value: SQLInputValue) => {
        sets.push(`${col} = ?`);
        args.push(value);
      };
      if (patch.name !== undefined) set("name", patch.name);
      if (patch.model !== undefined) set("model", patch.model);
      if (patch.baseUrl !== undefined) set("base_url", patch.baseUrl);
      if (patch.apiKey !== undefined) set("api_key_sealed", patch.apiKey ? seal(this.secretKey, patch.apiKey) : null);
      if (patch.options !== undefined) set("options", json(patch.options));
      if (patch.fallbackId !== undefined) set("fallback_id", patch.fallbackId);
      if (patch.isDefault !== undefined) set("is_default", patch.isDefault ? 1 : 0);
      if (sets.length) this.db.prepare(`UPDATE model_profiles SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    });
    return this.getModelProfile(id);
  }

  deleteModelProfile(id: string): boolean {
    return tx(this.db, () => {
      this.db.prepare("UPDATE model_profiles SET fallback_id = NULL WHERE fallback_id = ?").run(id);
      return this.db.prepare("DELETE FROM model_profiles WHERE id = ?").run(id).changes > 0;
    });
  }

  private toModelProfile(row: Row): ModelProfile {
    return {
      id: row.id as string,
      name: row.name as string,
      provider: row.provider as ModelProfile["provider"],
      model: row.model as string,
      base_url: row.base_url as string,
      options: parse(row.options, {}),
      fallback_id: (row.fallback_id as string) ?? null,
      is_default: Boolean(row.is_default),
      has_key: Boolean(row.api_key_sealed),
      created_at: row.created_at as string,
    };
  }

  // ------------------------------------------------------------------ psa

  createPsaConnection(input: { kind: PsaKind; name: string; config: Record<string, string>; options?: Partial<PsaOptions> }): PsaConnection {
    const id = newId("psa");
    this.db
      .prepare("INSERT INTO psa_connections (id, kind, name, config_sealed, options, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.kind, input.name, seal(this.secretKey, json(input.config)), json({ ...DEFAULT_PSA_OPTIONS, ...input.options }), now());
    return this.getPsaConnection(id)!;
  }

  listPsaConnections(): PsaConnection[] {
    return (this.db.prepare("SELECT * FROM psa_connections ORDER BY created_at").all() as Row[]).map((r) => this.toPsa(r));
  }

  getPsaConnection(id: string): PsaConnection | null {
    const row = this.db.prepare("SELECT * FROM psa_connections WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toPsa(row) : null;
  }

  getPsaConfig(id: string): Record<string, string> {
    const row = this.db.prepare("SELECT config_sealed FROM psa_connections WHERE id = ?").get(id) as Row | undefined;
    return row ? parse(unseal(this.secretKey, row.config_sealed as string), {}) : {};
  }

  updatePsaConnection(
    id: string,
    patch: {
      name?: string;
      config?: Record<string, string>;
      customerMap?: Record<string, string>;
      options?: Partial<PsaOptions>;
      cursor?: string | null;
      enabled?: boolean;
      status?: PsaConnection["status"];
      statusDetail?: string;
      lastSyncAt?: string;
    },
  ): PsaConnection | null {
    const current = this.getPsaConnection(id);
    if (!current) return null;
    const sets: string[] = [];
    const args: SQLInputValue[] = [];
    const set = (col: string, value: SQLInputValue) => {
      sets.push(`${col} = ?`);
      args.push(value);
    };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.config !== undefined) set("config_sealed", seal(this.secretKey, json({ ...this.getPsaConfig(id), ...patch.config })));
    if (patch.customerMap !== undefined) set("customer_map", json(patch.customerMap));
    if (patch.options !== undefined) set("options", json({ ...current.options, ...patch.options }));
    if (patch.cursor !== undefined) set("cursor", patch.cursor);
    if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.statusDetail !== undefined) set("status_detail", patch.statusDetail);
    if (patch.lastSyncAt !== undefined) set("last_sync_at", patch.lastSyncAt);
    if (sets.length) this.db.prepare(`UPDATE psa_connections SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    return this.getPsaConnection(id);
  }

  deletePsaConnection(id: string): boolean {
    return this.db.prepare("DELETE FROM psa_connections WHERE id = ?").run(id).changes > 0;
  }

  private toPsa(row: Row): PsaConnection {
    return {
      id: row.id as string,
      kind: row.kind as PsaKind,
      name: row.name as string,
      customer_map: parse(row.customer_map, {}),
      options: { ...DEFAULT_PSA_OPTIONS, ...parse<Partial<PsaOptions>>(row.options, {}) },
      cursor: (row.cursor as string) ?? null,
      enabled: Boolean(row.enabled),
      status: row.status as PsaConnection["status"],
      status_detail: row.status_detail as string,
      last_sync_at: (row.last_sync_at as string) ?? null,
      created_at: row.created_at as string,
    };
  }

  createTicketLink(input: { ticketId: string; connectionId: string; externalId: string; externalNumber: string; seenCommentIds?: string[]; lastStatus?: string }): TicketLink {
    this.db
      .prepare(
        `INSERT INTO ticket_links (ticket_id, connection_id, external_id, external_number, seen_comment_ids, last_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.ticketId, input.connectionId, input.externalId, input.externalNumber, json(input.seenCommentIds ?? []), input.lastStatus ?? "", now());
    return this.getTicketLink(input.ticketId, input.connectionId)!;
  }

  getTicketLink(ticketId: string, connectionId: string): TicketLink | null {
    const row = this.db.prepare("SELECT * FROM ticket_links WHERE ticket_id = ? AND connection_id = ?").get(ticketId, connectionId) as Row | undefined;
    return row ? this.toLink(row) : null;
  }

  findTicketLinkByExternal(connectionId: string, externalId: string): TicketLink | null {
    const row = this.db.prepare("SELECT * FROM ticket_links WHERE connection_id = ? AND external_id = ?").get(connectionId, externalId) as Row | undefined;
    return row ? this.toLink(row) : null;
  }

  listTicketLinks(filter: { connectionId?: string; ticketId?: string } = {}): TicketLink[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.connectionId) {
      where.push("connection_id = ?");
      args.push(filter.connectionId);
    }
    if (filter.ticketId) {
      where.push("ticket_id = ?");
      args.push(filter.ticketId);
    }
    return (this.db.prepare(`SELECT * FROM ticket_links ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`).all(...args) as Row[]).map((r) =>
      this.toLink(r),
    );
  }

  updateTicketLink(ticketId: string, connectionId: string, patch: { seenCommentIds?: string[]; pushedEventIds?: string[]; lastStatus?: string }): void {
    const link = this.getTicketLink(ticketId, connectionId);
    if (!link) return;
    this.db
      .prepare("UPDATE ticket_links SET seen_comment_ids = ?, pushed_event_ids = ?, last_status = ? WHERE ticket_id = ? AND connection_id = ?")
      .run(
        json(patch.seenCommentIds ?? link.seen_comment_ids),
        json(patch.pushedEventIds ?? link.pushed_event_ids),
        patch.lastStatus ?? link.last_status,
        ticketId,
        connectionId,
      );
  }

  private toLink(row: Row): TicketLink {
    return {
      ...(row as unknown as TicketLink),
      seen_comment_ids: parse(row.seen_comment_ids, []),
      pushed_event_ids: parse(row.pushed_event_ids, []),
    };
  }

  // ----------------------------------------------------------- schedules

  createSchedule(input: {
    orgId: string;
    ticketId?: string | null;
    templateId?: string | null;
    title: string;
    instruction: string;
    cadence: Cadence;
    mode?: RunMode;
    nextRunAt: string;
    createdBy: string;
  }): Schedule {
    const id = newId("sch");
    this.db
      .prepare(
        `INSERT INTO schedules (id, org_id, ticket_id, template_id, title, instruction, cadence, mode, next_run_at, enabled, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, input.orgId, input.ticketId ?? null, input.templateId ?? null, input.title, input.instruction, input.cadence, input.mode ?? "live", input.nextRunAt, input.createdBy, now());
    return this.getSchedule(id)!;
  }

  getSchedule(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return row ? { ...(row as unknown as Schedule), enabled: Boolean(row.enabled) } : null;
  }

  listSchedules(filter: { orgId?: string; ticketId?: string } = {}): Schedule[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.orgId) {
      where.push("org_id = ?");
      args.push(filter.orgId);
    }
    if (filter.ticketId) {
      where.push("ticket_id = ?");
      args.push(filter.ticketId);
    }
    return (
      this.db
        .prepare(`SELECT * FROM schedules ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY enabled DESC, next_run_at`)
        .all(...args) as Row[]
    ).map((r) => ({ ...(r as unknown as Schedule), enabled: Boolean(r.enabled) }));
  }

  dueSchedules(at: string): Schedule[] {
    return (this.db.prepare("SELECT id FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at").all(at) as Row[]).map(
      (r) => this.getSchedule(r.id as string)!,
    );
  }

  updateSchedule(
    id: string,
    patch: Partial<Pick<Schedule, "title" | "instruction" | "cadence" | "mode" | "next_run_at" | "last_run_at" | "last_run_id" | "enabled">>,
  ): Schedule | null {
    const current = this.getSchedule(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE schedules SET title = ?, instruction = ?, cadence = ?, mode = ?, next_run_at = ?, last_run_at = ?, last_run_id = ?, enabled = ?
         WHERE id = ?`,
      )
      .run(next.title, next.instruction, next.cadence, next.mode, next.next_run_at, next.last_run_at, next.last_run_id, next.enabled ? 1 : 0, id);
    return next;
  }

  deleteSchedule(id: string): boolean {
    return this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
  }

  // --------------------------------------------------------------- audit

  audit(entry: { orgId?: string | null; actor: string; action: string; target?: string; detail?: Record<string, unknown> }): void {
    this.db
      .prepare("INSERT INTO audit_log (id, org_id, actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(newId("aud"), entry.orgId ?? null, entry.actor, entry.action, entry.target ?? "", json(entry.detail ?? {}), now());
  }

  listAudit(filter: { orgId?: string; limit?: number } = {}): AuditEntry[] {
    const rows = filter.orgId
      ? this.db.prepare("SELECT * FROM audit_log WHERE org_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(filter.orgId, filter.limit ?? 200)
      : this.db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC, rowid DESC LIMIT ?").all(filter.limit ?? 200);
    return (rows as Row[]).map((r) => ({ ...(r as unknown as AuditEntry), detail: parse(r.detail, {}) }));
  }

  countTicketsFromRequesterSince(orgId: string, requesterEmail: string, since: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tickets WHERE org_id = ? AND LOWER(requester_email) = LOWER(?) AND created_at >= ?")
      .get(orgId, requesterEmail, since) as Row;
    return Number(row.n);
  }

  /** Security-sensitive changes Haley made on its own for one requester since the given ISO time. */
  countSelfServiceSince(orgId: string, requesterEmail: string, since: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM actions a JOIN runs r ON r.id = a.run_id JOIN tickets t ON t.id = r.ticket_id
         WHERE a.org_id = ? AND LOWER(t.requester_email) = LOWER(?) AND a.status = 'executed' AND a.risk = 'destructive'
           AND a.decided_by IS NULL AND a.executed_at >= ?`,
      )
      .get(orgId, requesterEmail, since) as Row;
    return Number(row.n);
  }

  /** Customer-system changes Haley executed for an org since the given ISO time. */
  countAgentChangesSince(orgId: string, since: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM actions WHERE org_id = ? AND status = 'executed' AND risk IN ('write', 'destructive')
           AND decided_by IS NULL AND executed_at >= ?`,
      )
      .get(orgId, since) as Row;
    return Number(row.n);
  }

  // --------------------------------------------------------------- stats

  stats(): Record<string, number> {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return {
      orgs: one("SELECT COUNT(*) AS n FROM orgs"),
      integrations: one("SELECT COUNT(*) AS n FROM integrations"),
      openTickets: one("SELECT COUNT(*) AS n FROM tickets WHERE status NOT IN ('resolved', 'closed')"),
      awaitingApproval: one("SELECT COUNT(*) AS n FROM actions WHERE status = 'pending_approval'"),
      escalated: one("SELECT COUNT(*) AS n FROM tickets WHERE status = 'escalated'"),
      resolvedThisWeek: one(
        "SELECT COUNT(*) AS n FROM tickets WHERE status IN ('resolved', 'closed') AND resolved_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')",
      ),
      actionsExecutedThisWeek: one(
        "SELECT COUNT(*) AS n FROM actions WHERE status = 'executed' AND risk IN ('write', 'destructive') AND executed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')",
      ),
      kbArticles: one("SELECT COUNT(*) AS n FROM kb_articles"),
      activeRuns: one("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')"),
    };
  }
}
