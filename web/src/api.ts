/**
 * Typed client for the Haley server (see server/src/app.ts).
 * Types mirror server/src/types.ts, server/src/transcript.ts and the route response shapes.
 */

// ------------------------------------------------------------------ domain

export type Autonomy = "read_only" | "supervised" | "autonomous" | "unattended";
export const AUTONOMY_LEVELS: Autonomy[] = ["read_only", "supervised", "autonomous", "unattended"];
export type ProviderId = "m365" | "google" | "slack" | "duo" | "okta" | "sms_code" | "ninjaone" | "syncro_rmm" | "itglue" | "hudu" | "rest";
/** directory: tools Haley acts with; channel: how end users reach Haley; verification: step-up MFA. */
export type ProviderKind = "directory" | "channel" | "verification";

/**
 * How strongly the requester's identity is established, weakest first (server/src/types.ts).
 * "mfa" is never stored: a ticket counts as MFA verified for MFA_WINDOW_MINUTES after mfa_verified_at.
 */
export type Assurance = "none" | "email" | "chat" | "directory" | "mfa" | "technician";
export const ASSURANCE_LEVELS: Assurance[] = ["none", "email", "chat", "directory", "mfa", "technician"];
/** How long an approved step-up verification counts for its ticket (server MFA_WINDOW_MS). */
export const MFA_WINDOW_MINUTES = 30;

/** Where a ticket came from; replies go back the same way. */
export type TicketChannel = "portal" | "api" | "monitoring" | "email" | "slack" | "teams" | "chat" | "syncro" | "dynamics" | "connectwise" | "autotask" | "halopsa";
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
export type ActionStatus = "executed" | "failed" | "pending_approval" | "approved" | "rejected" | "changes_requested" | "blocked" | "planned";

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
  /** AI model profile for this client; empty uses the workspace default. */
  modelProfileId: string;
  /** Client rules layered on the autonomy policy, checked in order; the first enabled match wins. */
  policyRules: PolicyRule[];
  /** Slack channel id for this client's approval cards; empty uses the workspace default. */
  approvalSlackChannel: string;
}

/** deny: blocked; approve: goes to the approval queue; allow: runs without a sign-off the autonomy level would have asked for. */
export type PolicyEffect = "allow" | "approve" | "deny";
export const POLICY_EFFECTS: PolicyEffect[] = ["deny", "approve", "allow"];

/** A client policy rule (server/src/types.ts). Empty match lists match anything. */
export interface PolicyRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Tool names; "*" is a wildcard (e.g. "m365_*_device"). */
  tools: string[];
  risks: Array<"write" | "destructive">;
  /** Target accounts: "jane@contoso.com", "*@contoso.com" or "@contoso.com". */
  targets: string[];
  /** The target account's Microsoft 365 department. */
  departments: string[];
  /** Who asked, same patterns as targets. */
  requesters: string[];
  effect: PolicyEffect;
  /** For "approve": technicians (by the name they sign in with) who may approve. Empty means any technician. */
  approvers: string[];
  /** For "allow": the requester identity needed before the rule lets a change run on its own. */
  minAssurance: Exclude<Assurance, "none">;
}

/** A rule as sent to the server; new rules get an id server-side. */
export type PolicyRuleInput = Omit<PolicyRule, "id"> & { id?: string };

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
  /** When the requester confirmed Haley's fix (null when unconfirmed or closed automatically). */
  resolution_confirmed_at: string | null;
  /** The incident (shared problem) this ticket is part of. */
  incident_id?: string | null;
  sla_escalated: boolean;
  /** Last approved step-up verification (MFA push or SMS code) and the method used. */
  mfa_verified_at: string | null;
  mfa_method: string;
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
  /** provider/model that served the latest turn (empty before the first turn). */
  model: string;
  /** The recipe this task run started from, if any (credited in time saved). */
  template_id?: string | null;
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
  /** Technicians a client rule named as the only ones who may decide this (empty: any technician). */
  approvers: string[];
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
  template_id: string | null;
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
  optional?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  description: string;
  fields: ProviderField[];
  setupSteps: string[];
  capabilities: string[];
  supportsSandbox: boolean;
  kind: ProviderKind;
  /** Shown prominently in the connect dialog (e.g. undocumented APIs). */
  warning?: string;
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
  assurance?: Exclude<Assurance, "technician" | "mfa">;
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
    /** Of the tickets Haley resolved alone, how many the requester confirmed were fixed. */
    confirmedByRequester?: number;
    confirmationRate?: number | null;
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
  timeSaved: { hours: number; recipeRuns?: number; assumptions: string };
}

/** server/src/types.ts BillingSettings */
export interface BillingSettings {
  aiMarkupPercent: number;
  autoCloseResolvedDays: number;
  minutesPerTicket: number;
  minutesPerAction: number;
}

/** server/src/types.ts ApprovalSettings, plus what the server can do. */
export interface ApprovalSettingsView {
  slackChannel: string;
  slackTeamId: string;
  teamsConversation: { serviceUrl: string; conversationId: string; tenantId: string; registeredBy: string; registeredAt: string } | null;
  chatApprovalMaxRisk: "write" | "destructive";
  escalationNotices: boolean;
  slackConnected: boolean;
  slackAvailable: boolean;
  teamsAvailable: boolean;
  interactivityUrl: string;
}

export interface ApprovalSettingsInput {
  slackBotToken?: string | null;
  slackChannel?: string;
  chatApprovalMaxRisk?: "write" | "destructive";
  escalationNotices?: boolean;
  teamsConversation?: null;
}

/** server/src/types.ts Technician */
export interface Technician {
  id: string;
  name: string;
  email: string | null;
  slack_user_id: string | null;
  teams_aad_id: string | null;
  psa_refs: Record<string, string>;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UsageClientRow {
  orgId: string;
  name: string;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  unpricedTokens: number;
  aiCostUsd: number;
  billableAiUsd: number;
  ticketAiCostUsd: number;
  taskAiCostUsd: number;
  copilotAiCostUsd: number;
  unpricedTicketTokens: number;
  ticketsWorked: number;
  ticketsResolvedByHaley: number;
  /** All AI cost on ticket runs ÷ tickets resolved by Haley alone; null with none resolved or unpriced usage. */
  aiCostPerResolvedUsd: number | null;
  billablePerResolvedUsd: number | null;
  aiCostPerTicketWorkedUsd: number | null;
  confirmedByRequester: number;
  automaticChanges: number;
  recipeRuns: number;
  hoursSaved: number;
}

/** server/src/usage.ts usageReport() */
export interface UsageReport {
  period: { from: string; to: string; days: number };
  settings: BillingSettings;
  clients: UsageClientRow[];
  totals: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    unpricedTokens: number;
    aiCostUsd: number;
    billableAiUsd: number;
    ticketAiCostUsd: number;
    taskAiCostUsd: number;
    copilotAiCostUsd: number;
    ticketsWorked: number;
    ticketsResolvedByHaley: number;
    aiCostPerResolvedUsd: number | null;
    billablePerResolvedUsd: number | null;
    aiCostPerTicketWorkedUsd: number | null;
    confirmedByRequester: number;
    hoursSaved: number;
  };
  unpricedModels: string[];
  technicians: { names: string[]; count: number; note: string };
}

export type RecipeCategory =
  | "Identity & access"
  | "Licensing & cost"
  | "Email & collaboration"
  | "Security"
  | "Devices"
  | "RMM & endpoints"
  | "Documentation & reporting";

/** A recipe from the "Ask Haley" library. */
export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  instruction: string;
  category: RecipeCategory;
  /** Provider ids; each group needs one of its providers connected. */
  requires: string[][];
  tools: string[];
  /** Changes customer systems: preview in plan mode first. */
  changes: boolean;
  /** Technician minutes to do it by hand. */
  estimatedMinutes: number;
  tags: string[];
  /** False when the selected client lacks an integration the recipe needs. */
  available: boolean;
  /** Provider names the client is missing, e.g. "Microsoft 365" or "Microsoft 365 or Google Workspace". */
  missing: string[];
}

export interface ToolInfo {
  name: string;
  description: string;
  risk: Risk;
}

export interface Health {
  ok: boolean;
  /** Model id of the default profile. */
  model: string;
  authRequired: boolean;
  /** Legacy alias of aiConfigured. */
  claudeCredentials: boolean;
  /** Whether the default model plausibly has credentials (stored key, server environment, or none needed). */
  aiConfigured?: boolean;
  defaultModel?: { id: string; name: string; provider: ModelProviderKind; model: string } | null;
}

// ------------------------------------------------------------------ AI models (server/src/ai/providers.ts)

export type ModelProviderKind =
  | "anthropic"
  | "openai"
  | "azure_openai"
  | "google_gemini"
  | "mistral"
  | "groq"
  | "together"
  | "openrouter"
  | "deepseek"
  | "xai"
  | "ollama"
  | "vllm"
  | "lmstudio"
  | "openai_compatible";

export type ModelLicense = "closed" | "open" | "both";

export interface ModelProviderPreset {
  id: ModelProviderKind;
  name: string;
  /** closed: hosted proprietary models; open: open-weight models (hosted or self-hosted). */
  license: ModelLicense;
  /** Default base URL; empty means the user must supply one. */
  baseUrl: string;
  needsKey: boolean;
  exampleModels: string[];
  notes: string;
}

export type ModelEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const MODEL_EFFORTS: ModelEffort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ModelOptions {
  maxTokens?: number;
  effort?: ModelEffort;
  refusalFallbacks?: boolean;
  temperature?: number;
  tokenParam?: "max_tokens" | "max_completion_tokens";
  reasoningEffort?: string;
  apiVersion?: string;
  extraHeaders?: Record<string, string>;
  /** Your price in USD per million tokens, for AI cost reporting (never sent to the provider). */
  inputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
}

export interface ModelProfile {
  id: string;
  name: string;
  provider: ModelProviderKind;
  model: string;
  base_url: string;
  options: ModelOptions;
  fallback_id: string | null;
  is_default: boolean;
  has_key: boolean;
  created_at: string;
}

export interface ModelProfileListItem extends ModelProfile {
  /** Names of clients pinned to this profile. */
  usedBy: string[];
}

export interface ModelInput {
  name: string;
  provider: ModelProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  options?: ModelOptions;
  fallbackId?: string | null;
  isDefault?: boolean;
}

export interface ModelPatch {
  name?: string;
  model?: string;
  baseUrl?: string;
  /** Omit to keep the stored key; "" clears it. */
  apiKey?: string;
  options?: ModelOptions;
  fallbackId?: string | null;
  isDefault?: true;
}

export interface ModelTestResult {
  ok: boolean;
  toolCalling: boolean;
  latencyMs: number;
  servedBy: string | null;
  detail: string;
}

// ------------------------------------------------------------------ PSA sync (server/src/psa)

export type PsaKind = "syncro" | "dynamics" | "connectwise" | "autotask" | "halopsa";

export interface PsaProviderInfo {
  id: PsaKind;
  name: string;
  description: string;
  fields: Array<{ key: string; label: string; secret?: boolean; placeholder?: string; help?: string; optional?: boolean }>;
  setupSteps: string[];
  /** Haley can log her work as time entries on this PSA's tickets. */
  timeEntries?: boolean;
}

export interface PsaOptions {
  /** Import new PSA tickets for mapped customers and let Haley work them. */
  importTickets: boolean;
  /** Create PSA tickets for tickets that start in Haley (email, Slack, Teams…). */
  exportTickets: boolean;
  /** Mirror Haley's notes and actions as internal PSA comments. */
  mirrorNotes: boolean;
  /** Identity level given to requesters of imported tickets. */
  requesterAssurance: "none" | "email";
  /** Time entries for Haley's work: each run's working time, or the minutes-per-ticket estimate once per resolved ticket. */
  timeEntries?: "off" | "actual" | "estimate";
}

export interface PsaConnection {
  id: string;
  kind: PsaKind;
  name: string;
  /** External customer id → Haley org id. */
  customer_map: Record<string, string>;
  options: PsaOptions;
  cursor: string | null;
  enabled: boolean;
  status: IntegrationStatus;
  status_detail: string;
  last_sync_at: string | null;
  created_at: string;
}

export interface PsaConnectionListItem extends PsaConnection {
  linkedTickets: number;
}

export interface PsaCustomer {
  id: string;
  name: string;
  domains: string[];
  /** Currently mapped Haley client. */
  orgId: string | null;
  /** Client matched by domain or name. */
  suggestedOrgId: string | null;
}

/** server/src/psa/sync.ts */
export interface SyncResult {
  imported: number;
  commentsImported: number;
  exported: number;
  pushed: number;
  statusUpdates: number;
  timeLogged?: number;
  unmappedCustomers: string[];
  errors: string[];
}

export type AssistMode = "draft_reply" | "next_steps" | "summarize";
/** server/src/copilot.ts AssistResult */
export interface AssistResult {
  mode: AssistMode;
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface SimilarTickets {
  tickets: Array<{ id: string; number: number; title: string; status: TicketStatus; created_at: string; resolved_at: string | null; score: number; matched: string[]; resolution: string | null }>;
  articles: Array<{ id: string; title: string; scope: "client" | "global" }>;
}

export type IncidentStatus = "open" | "resolved" | "dismissed";
export interface Incident {
  id: string;
  org_id: string;
  org_name: string;
  title: string;
  status: IncidentStatus;
  created_by: string;
  created_at: string;
  resolved_at: string | null;
  ticketCount: number;
  openCount: number;
  people: number;
  lastTicketAt: string;
}
export interface MessageAllResult {
  sent: number;
  delivered: number;
  notDelivered: number[];
}

/** server/src/snapshot.ts RequesterSnapshot */
export interface RequesterSnapshot {
  email: string;
  generatedAt: string;
  account: {
    source: "Microsoft 365" | "Google Workspace";
    name: string;
    enabled: boolean;
    title: string | null;
    department: string | null;
    licenses: string[];
    groups: string[];
    mfaMethods: string[] | null;
    lastSignIn: string | null;
    isAdmin: boolean | null;
  } | null;
  devices: Array<{ source: "Intune" | "Syncro"; name: string; id: string; os: string | null; lastSeen: string | null; issues: string[] }>;
  recentTickets: Array<{ id: string; number: number; title: string; status: TicketStatus; created_at: string }>;
  flags: Array<{ level: "warning" | "info"; text: string }>;
  unavailable: Array<{ source: string; error: string }>;
}

/** The workspace's Syncro webhook URL (Notification Center → Notification Sets). */
export interface SyncroWebhook {
  url: string;
  minGapSeconds: number;
}

export interface PsaInput {
  kind: PsaKind;
  name?: string;
  config: Record<string, string>;
  options?: Partial<PsaOptions>;
}

export interface PsaPatch {
  name?: string;
  /** Blank values keep the stored value. */
  config?: Record<string, string>;
  options?: Partial<PsaOptions>;
  enabled?: boolean;
}

// ------------------------------------------------------------------ Microsoft 365 onboarding (server/src/routes/m365Onboarding.ts)

export interface M365OnboardingInfo {
  /** Whether the MSP's multi-tenant app (HALEY_M365_CLIENT_ID / _SECRET) is set up for admin-consent onboarding. */
  mspAppConfigured: boolean;
  clientId: string | null;
  redirectUri: string;
  permissions: string[];
}

export interface M365ConsentLink {
  url: string;
  expiresInMinutes: number;
}

/** server/src/connectors/m365/discovery.ts */
export interface M365Discovery {
  tenantId: string;
  organization: string;
  domains: string[];
  licenses: Array<{ sku: string; purchased: number; assigned: number }>;
  users: { total: number; enabled: number; licensed: number; truncated: boolean };
  /** null when Intune isn't available. */
  devices: { total: number; noncompliant: number; staleOver30Days: number } | null;
  admins: Array<{ role: string; userPrincipalName: string; displayName: string }>;
  suggestions: { emailDomains: string[]; teamsTenantId: string; protectedAccounts: string[] };
  /** Things Haley couldn't read, usually a missing permission. */
  warnings: string[];
  discoveredAt: string;
}

export interface ApplyDiscoveryInput {
  emailDomains?: boolean;
  teamsTenantId?: boolean;
  protectedAccounts?: boolean;
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
  /** PSA tickets this ticket is synced with (imported or exported). */
  psaLinks?: Array<{ connectionId: string; name: string; kind: string | null; externalId: string; externalNumber: string }>;
  events: TicketEvent[];
  runs: Run[];
  actions: Action[];
}

export interface RunDetail {
  run: RunWithOrg;
  /** Model calls, tokens and AI cost (null when any model used has no price). */
  usage?: { modelCalls: number; inputTokens: number; outputTokens: number; usd: number | null; unpricedModels: string[] };
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

/**
 * A short fact Haley keeps about a client and sees on every run. Notes she saves from an end user's ticket
 * are "pending" (unused) until a technician confirms them.
 */
export interface ClientMemory {
  id: string;
  org_id: string;
  content: string;
  status: "active" | "pending";
  source: "agent" | "technician";
  run_id: string | null;
  ticket_id: string | null;
  created_by: string;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
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

/** Fetches a file with the session's credentials and hands it to the browser as a download. */
async function download(path: string, filename: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (user) headers["x-haley-user"] = user;
  let res: Response;
  try {
    res = await fetch(path, { headers });
  } catch {
    throw new ApiError(0, "Can't reach the Haley server. Check that it is running.");
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, `Download failed (${res.status} ${res.statusText})`);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  settings?: Partial<Omit<OrgSettings, "policyRules">> & { policyRules?: PolicyRuleInput[] };
}

export interface ScheduleInput {
  orgId: string;
  title: string;
  instruction: string;
  cadence: Cadence;
  mode?: RunMode;
  /** ISO date-time with offset. */
  startAt: string;
  templateId?: string;
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
  templates: (orgId?: string) => get<TaskTemplate[]>("/api/templates", orgId ? { orgId } : undefined),
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

  m365Onboarding: () => get<M365OnboardingInfo>("/api/m365/onboarding"),
  /** `tenant`: the customer's tenant ID or verified domain, for a partner admin consenting through GDAP. */
  m365ConsentLink: (orgId: string, tenant?: string) =>
    post<M365ConsentLink>(`/api/orgs/${enc(orgId)}/m365/consent`, tenant?.trim() ? { tenant: tenant.trim() } : {}),
  discoverM365: (integrationId: string) => post<M365Discovery>(`/api/integrations/${enc(integrationId)}/discover`),
  m365Discovery: (integrationId: string) => get<M365Discovery>(`/api/integrations/${enc(integrationId)}/discovery`),
  applyM365Discovery: (orgId: string, input: ApplyDiscoveryInput) => post<Org>(`/api/orgs/${enc(orgId)}/m365/apply-discovery`, input),

  memories: (orgId: string) => get<ClientMemory[]>(`/api/orgs/${enc(orgId)}/memories`),
  addMemory: (orgId: string, content: string) => post<ClientMemory>(`/api/orgs/${enc(orgId)}/memories`, { content }),
  /** Edit a note, or confirm a pending one with `status: "active"`. */
  updateMemory: (id: string, input: { content?: string; status?: "active" }) => patch<ClientMemory>(`/api/memories/${enc(id)}`, input),
  deleteMemory: (id: string) => del<{ ok: true }>(`/api/memories/${enc(id)}`),
  technicians: () => get<{ technicians: Technician[]; suggestions: string[] }>("/api/technicians"),
  addTechnician: (input: { name: string; email?: string }) => post<Technician>("/api/technicians", input),
  updateTechnician: (id: string, input: { name?: string; email?: string | null; slackUserId?: string | null; teamsAadId?: string | null; active?: boolean }) =>
    patch<Technician>(`/api/technicians/${enc(id)}`, input),
  deleteTechnician: (id: string) => del<Technician>(`/api/technicians/${enc(id)}`),

  tickets: (q: { orgId?: string; status?: string; search?: string } = {}) => get<TicketWithOrg[]>("/api/tickets", q),
  ticket: (id: string) => get<TicketDetail>(`/api/tickets/${enc(id)}`),
  createTicket: (input: NewTicketInput) => post<Ticket & { runId: string | null }>("/api/tickets", input),
  updateTicket: (id: string, input: TicketPatch) => patch<Ticket>(`/api/tickets/${enc(id)}`, input),
  addComment: (id: string, input: { body: string; kind: "comment" | "reply"; runAgent?: boolean }) =>
    post<{ event: TicketEvent; runId: string | null }>(`/api/tickets/${enc(id)}/comments`, input),
  runTicket: (id: string, mode: RunMode = "live") => post<Run>(`/api/tickets/${enc(id)}/run`, { mode }),

  runs: (q: { orgId?: string; kind?: RunKind } = {}) => get<RunWithOrg[]>("/api/runs", q),
  run: (id: string) => get<RunDetail>(`/api/runs/${enc(id)}`),
  startTask: (input: { orgId: string; title: string; instruction: string; mode?: RunMode; templateId?: string }) => post<Run>("/api/runs", input),

  schedules: (q: { orgId?: string } = {}) => get<ScheduleListItem[]>("/api/schedules", q),
  createSchedule: (input: ScheduleInput) => post<Schedule>("/api/schedules", input),
  updateSchedule: (id: string, input: SchedulePatch) => patch<Schedule>(`/api/schedules/${enc(id)}`, input),
  deleteSchedule: (id: string) => del<{ ok: true }>(`/api/schedules/${enc(id)}`),
  runSchedule: (id: string) => post<{ scheduleId: string; runId: string }>(`/api/schedules/${enc(id)}/run`),

  report: (orgId: string, days: number) => get<ClientReport>(`/api/orgs/${enc(orgId)}/report`, { days }),

  usage: (month: string) => get<UsageReport>("/api/usage", { month }),
  downloadUsageCsv: (month: string) => download(withQuery("/api/usage.csv", { month }), `haley-usage-${month}.csv`),
  billingSettings: () => get<BillingSettings>("/api/billing/settings"),
  updateBillingSettings: (input: Partial<BillingSettings>) => patch<BillingSettings>("/api/billing/settings", input),

  channels: () => get<ChannelInfo[]>("/api/channels"),
  simulate: (input: SimulateInput) => post<SimulateResult>("/api/simulate", input),

  approvals: () => get<Approval[]>("/api/approvals"),
  approve: (id: string, note = "") => post<Action>(`/api/actions/${enc(id)}/approve`, { note }),
  reject: (id: string, note = "") => post<Action>(`/api/actions/${enc(id)}/reject`, { note }),
  requestChanges: (id: string, note: string) => post<Action>(`/api/actions/${enc(id)}/request-changes`, { note }),
  approvalSettings: () => get<ApprovalSettingsView>("/api/approvals/settings"),
  updateApprovalSettings: (input: ApprovalSettingsInput) => request<ApprovalSettingsView>("PUT", "/api/approvals/settings", input),
  testApprovals: (orgId?: string) => post<{ ok: true; channel: string }>("/api/approvals/test", orgId ? { orgId } : {}),
  reveal: (id: string) => post<Record<string, string>>(`/api/actions/${enc(id)}/reveal`),

  kb: (q: { orgId?: string; q?: string } = {}) => get<KbArticleListItem[]>("/api/kb", q),
  article: (id: string) => get<KbArticle>(`/api/kb/${enc(id)}`),
  createArticle: (input: ArticleInput) => post<KbArticle>("/api/kb", input),
  updateArticle: (id: string, input: Partial<ArticleInput>) => put<KbArticle>(`/api/kb/${enc(id)}`, input),
  deleteArticle: (id: string) => del<{ ok: true }>(`/api/kb/${enc(id)}`),

  audit: (q: { orgId?: string; limit?: number } = {}) => get<AuditEntry[]>("/api/audit", q),

  modelProviders: () => get<ModelProviderPreset[]>("/api/models/providers"),
  models: () => get<ModelProfileListItem[]>("/api/models"),
  createModel: (input: ModelInput) => post<ModelProfile>("/api/models", input),
  updateModel: (id: string, input: ModelPatch) => patch<ModelProfile>(`/api/models/${enc(id)}`, input),
  deleteModel: (id: string) => del<{ ok: true }>(`/api/models/${enc(id)}`),
  testModel: (id: string) => post<ModelTestResult>(`/api/models/${enc(id)}/test`),

  psaProviders: () => get<PsaProviderInfo[]>("/api/psa/providers"),
  psaConnections: () => get<PsaConnectionListItem[]>("/api/psa"),
  createPsa: (input: PsaInput) => post<PsaConnection>("/api/psa", input),
  updatePsa: (id: string, input: PsaPatch) => patch<PsaConnection>(`/api/psa/${enc(id)}`, input),
  deletePsa: (id: string) => del<{ ok: true }>(`/api/psa/${enc(id)}`),
  testPsa: (id: string) => post<PsaConnection>(`/api/psa/${enc(id)}/test`),
  psaCustomers: (id: string) => get<PsaCustomer[]>(`/api/psa/${enc(id)}/customers`),
  setPsaMapping: (id: string, map: Record<string, string>) => put<PsaConnection>(`/api/psa/${enc(id)}/mapping`, map),
  syncPsa: (id: string) => post<SyncResult>(`/api/psa/${enc(id)}/sync`),
  syncroWebhook: () => get<SyncroWebhook>("/api/syncro/webhook"),
  similarTickets: (ticketId: string) => get<SimilarTickets>(`/api/tickets/${enc(ticketId)}/similar`),
  incidents: (q: { status?: IncidentStatus; orgId?: string } = {}) => get<Incident[]>("/api/incidents", q),
  incident: (id: string) => get<{ incident: Incident; tickets: Ticket[] }>(`/api/incidents/${enc(id)}`),
  createIncident: (title: string, ticketIds: string[]) => post<Incident>("/api/incidents", { title, ticketIds }),
  renameIncident: (id: string, title: string) => patch<Incident>(`/api/incidents/${enc(id)}`, { title }),
  messageIncident: (id: string, message: string) => post<MessageAllResult>(`/api/incidents/${enc(id)}/message`, { message }),
  resolveIncident: (id: string, message: string) => post<{ incident: Incident; resolvedTickets: number; message: MessageAllResult | null }>(`/api/incidents/${enc(id)}/resolve`, { message }),
  dismissIncident: (id: string) => post<Incident>(`/api/incidents/${enc(id)}/dismiss`),
  setTicketIncident: (ticketId: string, incidentId: string | null) => put<Ticket>(`/api/tickets/${enc(ticketId)}/incident`, { incidentId }),
  assist: (ticketId: string, mode: AssistMode, instruction = "") => post<AssistResult>(`/api/tickets/${enc(ticketId)}/assist`, { mode, instruction }),
  statusLink: (ticketId: string) => get<{ url: string | null }>(`/api/tickets/${enc(ticketId)}/status-link`),
  requesterSnapshot: (ticketId: string) => get<RequesterSnapshot>(`/api/tickets/${enc(ticketId)}/requester`),
  rotateSyncroWebhook: () => post<SyncroWebhook>("/api/syncro/webhook/rotate"),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
