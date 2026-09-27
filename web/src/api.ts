/**
 * Typed client for the Haley server (see server/src/app.ts).
 * Types mirror server/src/types.ts, server/src/transcript.ts and the route response shapes.
 */

// ------------------------------------------------------------------ domain

export type Autonomy = "read_only" | "supervised" | "autonomous" | "unattended";
export const AUTONOMY_LEVELS: Autonomy[] = ["read_only", "supervised", "autonomous", "unattended"];
export type ProviderId = "m365" | "google" | "slack";
export type ProviderKind = "directory" | "channel";

/** How strongly the requester's identity is established, weakest first (server/src/types.ts). */
export type Assurance = "none" | "email" | "chat" | "directory" | "technician";
export const ASSURANCE_LEVELS: Assurance[] = ["none", "email", "chat", "directory", "technician"];

/** Where a ticket came from; replies go back the same way. */
export type TicketChannel = "portal" | "api" | "email" | "slack" | "teams" | "chat";
export type RunMode = "live" | "plan";
export type Cadence = "once" | "daily" | "weekly" | "monthly";
export const CADENCES: Cadence[] = ["once", "daily", "weekly", "monthly"];
export type IntegrationMode = "live" | "sandbox";
export type IntegrationStatus = "unknown" | "connected" | "error";

export type TicketStatus =
  | "new"
  | "in_progress"
  | "awaiting_approval"
  | "waiting_on_customer"
  | "escalated"
  | "resolved"
  | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";

export const TICKET_STATUSES: TicketStatus[] = [
  "new",
  "in_progress",
  "awaiting_approval",
  "waiting_on_customer",
  "escalated",
  "resolved",
  "closed",
];
export const TICKET_PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

export type RunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed";
export type RunKind = "ticket" | "task";
export type Risk = "read" | "internal" | "write" | "destructive";
export type ActionStatus = "executed" | "failed" | "pending_approval" | "approved" | "rejected" | "blocked" | "planned";

export interface SlaTarget {
  responseMinutes: number;
  resolutionMinutes: number;
}

export interface OrgSettings {
  /** Email domains (besides the primary domain) whose senders belong to this org. */
  emailDomains: string[];
  /** Entra tenant id used to route Microsoft Teams messages to this org. */
  teamsTenantId: string;
  /** People allowed to request changes to other users' accounts (managers, the IT contact). */
  authorizedRequesters: string[];
  /** Accounts Haley never changes without a technician. */
  protectedAccounts: string[];
  maxAutoChangesPerHour: number;
  maxSelfServicePerUserPerDay: number;
  /** Kill switch: Haley stops acting on this client's tickets. */
  paused: boolean;
  sla: Record<TicketPriority, SlaTarget>;
}

export interface Org {
  id: string;
  name: string;
  domain: string;
  autonomy: Autonomy;
  notes: string;
  settings: OrgSettings;
  created_at: string;
}

export interface Integration {
  id: string;
  org_id: string;
  provider: ProviderId;
  label: string;
  mode: IntegrationMode;
  status: IntegrationStatus;
  status_detail: string;
  created_at: string;
}

export interface OrgSummary extends Org {
  integrations: Integration[];
  openTickets: number;
}

export interface OrgDetail extends Org {
  integrations: Integration[];
}

export interface Ticket {
  id: string;
  number: number;
  org_id: string;
  title: string;
  description: string;
  requester_name: string;
  requester_email: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: string;
  assignee: string;
  channel: TicketChannel;
  /** Channel-specific routing for replies (thread ids, conversation ids, message ids). */
  channel_ref: Record<string, string>;
  /** How strongly the channel established who the requester is. */
  assurance: Assurance;
  /** How the requester was (or wasn't) verified. */
  verification: string;
  /** A requester message arrived while Haley was busy; she takes another pass when the current one ends. */
  needs_followup: boolean;
  first_response_at: string | null;
  resolved_at: string | null;
  sla_escalated: boolean;
  created_at: string;
  updated_at: string;
}

export type SlaState = "met" | "pending" | "at_risk" | "breached";

/** server/src/sla.ts */
export interface SlaStatus {
  responseDue: string;
  resolutionDue: string;
  response: SlaState;
  resolution: SlaState;
}

export interface TicketWithOrg extends Ticket {
  org_name: string;
  /** Null when the ticket's org is gone. */
  sla: SlaStatus | null;
}

export type TicketEventKind =
  | "created"
  | "comment"
  | "reply"
  | "agent_note"
  | "status_change"
  | "field_change"
  | "action"
  | "escalation";

export interface TicketEvent {
  id: string;
  ticket_id: string;
  kind: TicketEventKind;
  author: string;
  body: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface Run {
  id: string;
  org_id: string;
  ticket_id: string | null;
  kind: RunKind;
  mode: RunMode;
  title: string;
  instruction: string;
  status: RunStatus;
  summary: string;
  error: string;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RunWithOrg extends Run {
  org_name: string;
}

export interface Action {
  id: string;
  run_id: string;
  org_id: string;
  tool_use_id: string;
  tool: string;
  input: unknown;
  risk: Risk;
  description: string;
  rationale: string;
  /** Why the policy held or blocked this call (empty when it ran automatically). */
  policy_reason: string;
  status: ActionStatus;
  result: unknown;
  has_secrets: boolean;
  decided_by: string | null;
  decision_note: string | null;
  decided_at: string | null;
  executed_at: string | null;
  created_at: string;
}

export interface Approval extends Action {
  org_name: string;
  run_title: string;
  ticket: { id: string; number: number; title: string } | null;
}

export interface Schedule {
  id: string;
  org_id: string;
  /** Follow-ups Haley schedules on a ticket run as that ticket. */
  ticket_id: string | null;
  title: string;
  instruction: string;
  cadence: Cadence;
  mode: RunMode;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_id: string | null;
  enabled: boolean;
  created_by: string;
  created_at: string;
}

export interface ScheduleListItem extends Schedule {
  org_name: string;
  ticket: { id: string; number: number; title: string } | null;
}

export interface KbArticle {
  id: string;
  org_id: string | null;
  title: string;
  body: string;
  tags: string[];
  source: "manual" | "agent";
  run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface KbArticleListItem extends KbArticle {
  org_name: string;
}

export interface AuditEntry {
  id: string;
  org_id: string | null;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export type TranscriptStep =
  | { type: "context"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; toolUseId: string; tool: string; input: unknown; action: Action | null }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

export interface ProviderField {
  key: string;
  label: string;
  help?: string;
  secret?: boolean;
  multiline?: boolean;
  placeholder?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  description: string;
  fields: ProviderField[];
  setupSteps: string[];
  capabilities: string[];
  supportsSandbox: boolean;
  /** directory: tools Haley acts with; channel: how end users reach Haley. */
  kind: ProviderKind;
}

export interface ChannelInfo {
  id: "email" | "slack" | "teams" | "chat";
  name: string;
  enabled: boolean;
  inbound: boolean;
  outbound: boolean;
  webhookUrl: string;
  env: string[];
}

export interface SimulateInput {
  orgId: string;
  email: string;
  name?: string;
  text: string;
  assurance?: Exclude<Assurance, "technician">;
  threadId?: string;
}

export interface SimulateResult {
  ticketId: string;
  ticketNumber: number;
  created: boolean;
  runId: string | null;
  threadId: string;
}

export interface CountRow {
  name: string;
  count: number;
}

/** server/src/report.ts clientReport() */
export interface ClientReport {
  org: { id: string; name: string; autonomy: Autonomy };
  period: { from: string; to: string; days: number };
  tickets: {
    opened: number;
    resolved: number;
    stillOpen: number;
    resolvedByHaleyAlone: number;
    automationRate: number | null;
    escalated: number;
    medianResolutionMinutes: number | null;
    byCategory: CountRow[];
    byChannel: CountRow[];
    byPriority: CountRow[];
    topRequesters: CountRow[];
  };
  sla: {
    responseCompliance: number | null;
    resolutionCompliance: number | null;
    responseBreaches: number;
    resolutionBreaches: number;
  };
  changes: {
    executed: number;
    automatic: number;
    approvedByTechnician: number;
    rejected: number;
    blockedByPolicy: number;
    byTool: CountRow[];
  };
  knowledge: { articlesWrittenByHaley: number; articlesTotal: number };
  timeSaved: { hours: number; assumptions: string };
}

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  instruction: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  risk: Risk;
}

export interface Health {
  ok: boolean;
  model: string;
  authRequired: boolean;
  claudeCredentials: boolean;
}

export interface Stats {
  orgs: number;
  integrations: number;
  openTickets: number;
  awaitingApproval: number;
  escalated: number;
  resolvedThisWeek: number;
  actionsExecutedThisWeek: number;
  kbArticles: number;
  activeRuns: number;
  /** Open tickets past their response or resolution SLA. */
  slaBreached: number;
  /** Enabled schedules. */
  schedules: number;
}

/** event.meta.delivery on replies: whether it reached the requester's channel. */
export interface Delivery {
  delivered: boolean;
  detail: string;
}

export interface TicketDetail {
  ticket: TicketWithOrg;
  /** Follow-ups Haley scheduled on this ticket. */
  schedules: Schedule[];
  events: TicketEvent[];
  runs: Run[];
  actions: Action[];
}

export interface RunDetail {
  run: RunWithOrg;
  actions: Action[];
  transcript: TranscriptStep[];
}

// ------------------------------------------------------------------ session

const TOKEN_KEY = "haley.token";
const USER_KEY = "haley.user";

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStorage(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable (private mode); session-only */
  }
}

let token = readStorage(TOKEN_KEY);
let user = readStorage(USER_KEY);

export const session = {
  get token() {
    return token;
  },
  get user() {
    return user;
  },
  setToken(value: string) {
    token = value.trim();
    writeStorage(TOKEN_KEY, token);
  },
  setUser(value: string) {
    user = value.trim();
    writeStorage(USER_KEY, user);
  },
};

/** Fired when the server answers 401 so the shell can show the sign-in screen. */
export const UNAUTHORIZED_EVENT = "haley:unauthorized";

// ------------------------------------------------------------------ transport

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Query = Record<string, string | number | undefined | null>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (user) headers["x-haley-user"] = user;
  // Fastify rejects an empty body declared as JSON, so only send the header with a payload.
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "Can't reach the Haley server. Check that it is running.");
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/health") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const message =
      data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `Request failed (${res.status} ${res.statusText})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

const get = <T>(path: string, query?: Query) => request<T>("GET", withQuery(path, query));
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

const enc = encodeURIComponent;

// ------------------------------------------------------------------ endpoints

export interface OrgInput {
  name: string;
  domain?: string;
  autonomy?: Autonomy;
  notes?: string;
  settings?: Partial<OrgSettings>;
}

export interface ScheduleInput {
  orgId: string;
  title: string;
  instruction: string;
  cadence: Cadence;
  mode?: RunMode;
  /** ISO date-time with offset. */
  startAt: string;
}

export interface SchedulePatch {
  title?: string;
  instruction?: string;
  cadence?: Cadence;
  mode?: RunMode;
  enabled?: boolean;
  startAt?: string;
}

export interface NewTicketInput {
  orgId: string;
  title: string;
  description?: string;
  requesterName?: string;
  requesterEmail?: string;
  priority?: TicketPriority;
  autoRun?: boolean;
}

export interface TicketPatch {
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: string;
  assignee?: string;
  title?: string;
}

export interface ArticleInput {
  orgId?: string | null;
  title: string;
  body: string;
  tags: string[];
}

export const api = {
  health: () => get<Health>("/api/health"),
  stats: () => get<Stats>("/api/stats"),
  providers: () => get<ProviderInfo[]>("/api/providers"),
  templates: () => get<TaskTemplate[]>("/api/templates"),
  loadDemo: () => post<{ ok: true; orgIds: string[] }>("/api/demo"),

  orgs: () => get<OrgSummary[]>("/api/orgs"),
  org: (id: string) => get<OrgDetail>(`/api/orgs/${enc(id)}`),
  createOrg: (input: OrgInput) => post<Org>("/api/orgs", input),
  updateOrg: (id: string, input: Partial<OrgInput>) => patch<Org>(`/api/orgs/${enc(id)}`, input),
  deleteOrg: (id: string) => del<{ ok: true }>(`/api/orgs/${enc(id)}`),

  connectIntegration: (orgId: string, input: { provider: ProviderId; mode: IntegrationMode; label?: string; config: Record<string, string> }) =>
    post<Integration>(`/api/orgs/${enc(orgId)}/integrations`, input),
  testIntegration: (id: string) => post<Integration>(`/api/integrations/${enc(id)}/test`),
  removeIntegration: (id: string) => del<{ ok: true }>(`/api/integrations/${enc(id)}`),
  integrationTools: (id: string) => get<ToolInfo[]>(`/api/integrations/${enc(id)}/tools`),

  tickets: (q: { orgId?: string; status?: string; search?: string } = {}) => get<TicketWithOrg[]>("/api/tickets", q),
  ticket: (id: string) => get<TicketDetail>(`/api/tickets/${enc(id)}`),
  createTicket: (input: NewTicketInput) => post<Ticket & { runId: string | null }>("/api/tickets", input),
  updateTicket: (id: string, input: TicketPatch) => patch<Ticket>(`/api/tickets/${enc(id)}`, input),
  addComment: (id: string, input: { body: string; kind: "comment" | "reply"; runAgent?: boolean }) =>
    post<{ event: TicketEvent; runId: string | null }>(`/api/tickets/${enc(id)}/comments`, input),
  runTicket: (id: string, mode: RunMode = "live") => post<Run>(`/api/tickets/${enc(id)}/run`, { mode }),

  runs: (q: { orgId?: string; kind?: RunKind } = {}) => get<RunWithOrg[]>("/api/runs", q),
  run: (id: string) => get<RunDetail>(`/api/runs/${enc(id)}`),
  startTask: (input: { orgId: string; title: string; instruction: string; mode?: RunMode }) => post<Run>("/api/runs", input),

  schedules: (q: { orgId?: string } = {}) => get<ScheduleListItem[]>("/api/schedules", q),
  createSchedule: (input: ScheduleInput) => post<Schedule>("/api/schedules", input),
  updateSchedule: (id: string, input: SchedulePatch) => patch<Schedule>(`/api/schedules/${enc(id)}`, input),
  deleteSchedule: (id: string) => del<{ ok: true }>(`/api/schedules/${enc(id)}`),
  runSchedule: (id: string) => post<{ scheduleId: string; runId: string }>(`/api/schedules/${enc(id)}/run`),

  report: (orgId: string, days: number) => get<ClientReport>(`/api/orgs/${enc(orgId)}/report`, { days }),

  channels: () => get<ChannelInfo[]>("/api/channels"),
  simulate: (input: SimulateInput) => post<SimulateResult>("/api/simulate", input),

  approvals: () => get<Approval[]>("/api/approvals"),
  approve: (id: string, note = "") => post<Action>(`/api/actions/${enc(id)}/approve`, { note }),
  reject: (id: string, note = "") => post<Action>(`/api/actions/${enc(id)}/reject`, { note }),
  reveal: (id: string) => post<Record<string, string>>(`/api/actions/${enc(id)}/reveal`),

  kb: (q: { orgId?: string; q?: string } = {}) => get<KbArticleListItem[]>("/api/kb", q),
  article: (id: string) => get<KbArticle>(`/api/kb/${enc(id)}`),
  createArticle: (input: ArticleInput) => post<KbArticle>("/api/kb", input),
  updateArticle: (id: string, input: Partial<ArticleInput>) => put<KbArticle>(`/api/kb/${enc(id)}`, input),
  deleteArticle: (id: string) => del<{ ok: true }>(`/api/kb/${enc(id)}`),

  audit: (q: { orgId?: string; limit?: number } = {}) => get<AuditEntry[]>("/api/audit", q),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
