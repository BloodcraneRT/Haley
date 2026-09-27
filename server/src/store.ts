import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { seal, unseal } from "./crypto.js";
import { tx, type Db } from "./db.js";
import type {
  Action,
  ActionStatus,
  AuditEntry,
  Autonomy,
  Integration,
  IntegrationMode,
  KbArticle,
  Org,
  ProviderId,
  Risk,
  Run,
  RunKind,
  RunStatus,
  Ticket,
  TicketEvent,
  TicketPriority,
  TicketStatus,
} from "./types.js";

type Row = Record<string, unknown>;

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

  createOrg(input: { name: string; domain?: string; autonomy?: Autonomy; notes?: string }): Org {
    const org: Org = {
      id: newId("org"),
      name: input.name,
      domain: input.domain ?? "",
      autonomy: input.autonomy ?? "supervised",
      notes: input.notes ?? "",
      created_at: now(),
    };
    this.db
      .prepare("INSERT INTO orgs (id, name, domain, autonomy, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(org.id, org.name, org.domain, org.autonomy, org.notes, org.created_at);
    return org;
  }

  listOrgs(): Org[] {
    return this.db.prepare("SELECT * FROM orgs ORDER BY name COLLATE NOCASE").all() as unknown as Org[];
  }

  getOrg(id: string): Org | null {
    return (this.db.prepare("SELECT * FROM orgs WHERE id = ?").get(id) as unknown as Org) ?? null;
  }

  updateOrg(id: string, patch: Partial<Pick<Org, "name" | "domain" | "autonomy" | "notes">>): Org | null {
    const org = this.getOrg(id);
    if (!org) return null;
    const next = { ...org, ...patch };
    this.db
      .prepare("UPDATE orgs SET name = ?, domain = ?, autonomy = ?, notes = ? WHERE id = ?")
      .run(next.name, next.domain, next.autonomy, next.notes, id);
    return next;
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
        created_at: ts,
        updated_at: ts,
      };
      this.db
        .prepare(
          `INSERT INTO tickets (id, number, org_id, title, description, requester_name, requester_email,
             status, priority, category, assignee, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return this.db.prepare(sql).all(...args) as unknown as Ticket[];
  }

  getTicket(id: string): Ticket | null {
    return (this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as unknown as Ticket) ?? null;
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
    this.db
      .prepare(
        "UPDATE tickets SET status = ?, priority = ?, category = ?, assignee = ?, title = ?, updated_at = ? WHERE id = ?",
      )
      .run(next.status, next.priority, next.category, next.assignee, next.title, next.updated_at, id);
    for (const [field, change] of Object.entries(changes)) {
      this.addTicketEvent(
        id,
        field === "status" ? "status_change" : "field_change",
        actor,
        `${field}: ${String(change.from)} → ${String(change.to)}`,
        { field, ...change },
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
  ): TicketEvent {
    const event: TicketEvent = { id: newId("evt"), ticket_id: ticketId, kind, author, body, meta, created_at: now() };
    this.db
      .prepare("INSERT INTO ticket_events (id, ticket_id, kind, author, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(event.id, ticketId, kind, author, body, json(meta), event.created_at);
    this.db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(event.created_at, ticketId);
    return event;
  }

  listTicketEvents(ticketId: string): TicketEvent[] {
    return (this.db.prepare("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at, rowid").all(ticketId) as Row[]).map(
      (r) => ({ ...(r as unknown as TicketEvent), meta: parse(r.meta, {}) }),
    );
  }

  // ---------------------------------------------------------------- runs

  createRun(input: {
    orgId: string;
    ticketId?: string | null;
    kind: RunKind;
    title: string;
    instruction: string;
    createdBy: string;
  }): Run {
    const ts = now();
    const id = newId("run");
    this.db
      .prepare(
        `INSERT INTO runs (id, org_id, ticket_id, kind, title, instruction, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, input.orgId, input.ticketId ?? null, input.kind, input.title, input.instruction, input.createdBy, ts, ts);
    return this.getRun(id)!;
  }

  getRun(id: string): Run | null {
    const row = this.db
      .prepare(
        `SELECT id, org_id, ticket_id, kind, title, instruction, status, summary, error, iterations,
                input_tokens, output_tokens, created_by, created_at, updated_at FROM runs WHERE id = ?`,
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
        `SELECT id, org_id, ticket_id, kind, title, instruction, status, summary, error, iterations,
                input_tokens, output_tokens, created_by, created_at, updated_at
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
  }): Action {
    const id = newId("act");
    this.db
      .prepare(
        `INSERT INTO actions (id, run_id, org_id, tool_use_id, tool, input, risk, description, rationale, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        "SELECT COUNT(*) AS n FROM tickets WHERE status IN ('resolved', 'closed') AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')",
      ),
      actionsExecutedThisWeek: one(
        "SELECT COUNT(*) AS n FROM actions WHERE status = 'executed' AND risk IN ('write', 'destructive') AND executed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')",
      ),
      kbArticles: one("SELECT COUNT(*) AS n FROM kb_articles"),
      activeRuns: one("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')"),
    };
  }
}
