export type Autonomy = "read_only" | "supervised" | "autonomous" | "unattended";
export const AUTONOMY_LEVELS: Autonomy[] = ["read_only", "supervised", "autonomous", "unattended"];
export type ProviderId = "m365" | "google" | "slack" | "duo" | "okta" | "sms_code" | "ninjaone" | "itglue" | "hudu" | "rest";

/**
 * How strongly the requester's identity is established, weakest first.
 *  none        nothing beyond what they typed
 *  email       DMARC / aligned-DKIM email: the domain vouches, but mailboxes get phished and spoofed
 *  chat        signed-in chat identity (Slack workspace member, a chat bridge that authenticated them)
 *  directory   matched to an active directory account through SSO (Teams / Entra ID)
 *  mfa         approved an MFA push on their own registered device moments ago (step-up)
 *  technician  entered or confirmed by a technician
 */
export type Assurance = "none" | "email" | "chat" | "directory" | "mfa" | "technician";
export const ASSURANCE_RANK: Record<Assurance, number> = { none: 0, email: 1, chat: 2, directory: 3, mfa: 4, technician: 5 };

/** How long an approved MFA push counts as step-up verification for its ticket. */
export const MFA_WINDOW_MS = 30 * 60_000;

/** The requester's assurance right now: a fresh MFA approval lifts it to "mfa". */
export function effectiveAssurance(ticket: Pick<Ticket, "assurance" | "mfa_verified_at">, nowMs = Date.now()): Assurance {
  const fresh = ticket.mfa_verified_at && nowMs - Date.parse(ticket.mfa_verified_at) < MFA_WINDOW_MS;
  return fresh && ASSURANCE_RANK.mfa > ASSURANCE_RANK[ticket.assurance] ? "mfa" : ticket.assurance;
}

/** Where a ticket came from; replies go back the same way. */
export type TicketChannel = "portal" | "api" | "email" | "slack" | "teams" | "chat" | "syncro" | "dynamics" | "connectwise" | "autotask" | "halopsa";
export type IntegrationMode = "live" | "sandbox";

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

/**
 * read        - no side effects
 * internal    - writes only inside Haley (notes, KB, ticket fields); always auto-run
 * write       - changes a customer system (license, group, account state)
 * destructive - security-sensitive or hard to undo (password resets, disabling users, deletes)
 */
export type Risk = "read" | "internal" | "write" | "destructive";

export type ActionStatus =
  | "executed"
  | "failed"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "blocked"
  | "planned";

/** live runs act; plan runs are dry runs that simulate every change and report what would happen. */
export type RunMode = "live" | "plan";

export interface OrgSettings {
  /** Email domains (besides the primary domain) whose senders belong to this org. */
  emailDomains: string[];
  /** Entra tenant id used to route Microsoft Teams messages to this org. */
  teamsTenantId: string;
  /** People (emails) allowed to request changes to other users' accounts, e.g. managers and the IT contact. */
  authorizedRequesters: string[];
  /** Accounts Haley never changes without a technician, e.g. admins and executives. */
  protectedAccounts: string[];
  /** Unattended mode safety valve: customer-system changes per hour before Haley falls back to approvals. */
  maxAutoChangesPerHour: number;
  /** Unattended mode: security-sensitive self-service changes per person per day (e.g. password resets). */
  maxSelfServicePerUserPerDay: number;
  /** Kill switch: Haley stops picking up and acting on this client's tickets; everything goes to technicians. */
  paused: boolean;
  /** Response and resolution targets per priority, in minutes (24x7). */
  sla: Record<TicketPriority, SlaTarget>;
  /** AI model profile for this client; empty uses the workspace default. */
  modelProfileId: string;
  /** Client-specific rules layered on the autonomy policy, checked in order; the first match wins. */
  policyRules: PolicyRule[];
}

export type PolicyEffect = "allow" | "approve" | "deny";

/**
 * A client policy rule. Empty match lists match anything. "deny" blocks the call, "approve" sends it to
 * the approval queue (optionally to named approvers), and "allow" lets it run without approval where the
 * autonomy policy would only have asked for a sign-off. "allow" never overrides protected accounts,
 * identity checks, rate limits or Haley's hard safety rails.
 */
export interface PolicyRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Tool names; "*" is a wildcard (e.g. "m365_*_device"). */
  tools: string[];
  risks: Risk[];
  /** Target accounts: "jane@contoso.com", "*@contoso.com" or "@contoso.com". */
  targets: string[];
  /** The target account's directory department (Microsoft 365). */
  departments: string[];
  /** Who asked, same patterns as targets. */
  requesters: string[];
  effect: PolicyEffect;
  /** For "approve": technicians (by the name they sign in with) who may approve. Empty means any technician. */
  approvers: string[];
  /** For "allow": the requester identity needed before the rule lets a change run on its own. */
  minAssurance: Assurance;
}

export interface SlaTarget {
  responseMinutes: number;
  resolutionMinutes: number;
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  emailDomains: [],
  teamsTenantId: "",
  authorizedRequesters: [],
  protectedAccounts: [],
  maxAutoChangesPerHour: 20,
  maxSelfServicePerUserPerDay: 3,
  paused: false,
  modelProfileId: "",
  policyRules: [],
  sla: {
    urgent: { responseMinutes: 15, resolutionMinutes: 240 },
    high: { responseMinutes: 60, resolutionMinutes: 480 },
    normal: { responseMinutes: 240, resolutionMinutes: 1440 },
    low: { responseMinutes: 480, resolutionMinutes: 4320 },
  },
};

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
  status: "unknown" | "connected" | "error";
  status_detail: string;
  created_at: string;
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
  /** How the requester was (or wasn't) verified, shown to technicians and the agent. */
  verification: string;
  /** A requester message arrived while Haley was busy; start another pass when the current one ends. */
  needs_followup: boolean;
  /** First human-visible response (auto-acknowledgements don't count). */
  first_response_at: string | null;
  resolved_at: string | null;
  /** Already escalated for an SLA breach, so the sweep doesn't repeat it. */
  sla_escalated: boolean;
  /** Last approved MFA push for the requester (step-up verification) and the method used. */
  mfa_verified_at: string | null;
  mfa_method: string;
  created_at: string;
  updated_at: string;
}

export interface TicketEvent {
  id: string;
  ticket_id: string;
  kind: "created" | "comment" | "reply" | "agent_note" | "status_change" | "field_change" | "action" | "escalation";
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
  /** Provider/model that served the latest turn. */
  model: string;
  created_by: string;
  created_at: string;
  updated_at: string;
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
  /** Technicians allowed to approve this action (from a client policy rule). Empty means any technician. */
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

export type Cadence = "once" | "daily" | "weekly" | "monthly";

export interface Schedule {
  id: string;
  org_id: string;
  /** Follow-ups Haley schedules on a ticket run as that ticket (with its requester's authority). */
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

export interface AuditEntry {
  id: string;
  org_id: string | null;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  created_at: string;
}

/**
 * A short fact Haley keeps about a client's environment (a quirk, a preference, a recurring fix) and sees on
 * every later run for that client. Notes she writes while working an end user's ticket start as "pending"
 * and are only used once a technician confirms them, so a requester can't plant instructions for later runs.
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
