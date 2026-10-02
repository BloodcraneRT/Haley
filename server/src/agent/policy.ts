import { ASSURANCE_RANK, type Assurance, type Autonomy, type PolicyRule, type Risk } from "../types.js";

export type Outcome = "run" | "approve" | "block";

/**
 * Why the autonomy policy asked for approval. A client "allow" rule may only waive the ones that are about
 * trust in Haley's autonomy (supervised, sensitive, access_grant, other_account, unknown_target), never the
 * ones that protect people (protected accounts, weak identity, rate limits).
 */
export type DecisionCode =
  | "ok"
  | "read_only"
  | "protected"
  | "supervised"
  | "sensitive"
  | "rate_limit"
  | "unverified"
  | "access_grant"
  | "other_account"
  | "weak_identity"
  | "unknown_target"
  | "self_service_limit"
  | "rule"
  | "rail";

export interface Decision {
  outcome: Outcome;
  /** Why the call needs a human or was blocked; shown to technicians and the agent. */
  reason: string;
  code?: DecisionCode;
  /** Technicians who may approve, from a client rule. Empty or missing means any technician. */
  approvers?: string[];
}

export interface Requester {
  email: string | null;
  assurance: Assurance;
  /** Allowed to request changes to other people's accounts (listed approvers, technicians). */
  authorized: boolean;
  /** The ticket came from a monitoring alert, not a person: there's no identity to verify or account to act for. */
  monitoring?: boolean;
}

export interface PolicyInput {
  autonomy: Autonomy;
  risk: Risk;
  /** The tool grants access to data or resources (group, mailbox, app membership). */
  grantsAccess: boolean;
  requester: Requester;
  /** Normalized (lowercase) accounts the call would change. Empty when unknown. */
  targets: string[];
  /** Subset of targets on the org's protected list. */
  protectedTargets: string[];
  changesLastHour: number;
  maxChangesPerHour: number;
  /** Security-sensitive changes Haley already made for this requester in the last 24 hours. */
  selfServiceToday: number;
  maxSelfServicePerDay: number;
}

const run: Decision = { outcome: "run", reason: "", code: "ok" };
const atLeast = (a: Assurance, min: Assurance) => ASSURANCE_RANK[a] >= ASSURANCE_RANK[min];

/**
 * The approval matrix.
 *
 *                read  internal  write                           destructive
 *  read_only     run   run       block                           block
 *  supervised    run   run       approve                         approve
 *  autonomous    run   run       run                             approve
 *  unattended    run   run       run for the requester's own     run for the requester's own account
 *                                account (email+ identity) or    with a chat/directory identity, within
 *                                an authorized approver;         the daily per-person limit, or for an
 *                                access grants need an approver  authorized approver with chat+ identity
 *
 * In every mode, protected accounts wait for a technician. Anything unattended mode can't justify on its
 * own falls back to the approval queue rather than failing, so the request still gets handled.
 */
export function decide(input: PolicyInput): Decision {
  const { autonomy, risk, requester, targets, protectedTargets } = input;
  if (risk === "read" || risk === "internal") return run;
  if (autonomy === "read_only") {
    return { outcome: "block", code: "read_only", reason: "This organization is read-only: Haley recommends changes but doesn't make them." };
  }
  if (protectedTargets.length) {
    return { outcome: "approve", code: "protected", reason: `${protectedTargets.join(", ")} is a protected account.` };
  }
  if (autonomy === "supervised") return { outcome: "approve", code: "supervised", reason: "Supervised: every change needs approval." };
  if (autonomy === "autonomous") {
    return risk === "destructive" ? { outcome: "approve", code: "sensitive", reason: "Security-sensitive change." } : run;
  }

  // unattended
  if (input.changesLastHour >= input.maxChangesPerHour) {
    return { outcome: "approve", code: "rate_limit", reason: `Hourly limit of ${input.maxChangesPerHour} automatic changes reached.` };
  }
  if (requester.monitoring) {
    // No person asked, so self-service doesn't apply: routine fixes run as in autonomous mode, the rest waits.
    if (risk === "destructive") return { outcome: "approve", code: "sensitive", reason: "Security-sensitive change on a monitoring alert." };
    if (input.grantsAccess) return { outcome: "approve", code: "access_grant", reason: "Access grants need a person to ask for them." };
    return run;
  }
  if (!atLeast(requester.assurance, "email")) {
    return { outcome: "approve", code: "unverified", reason: "The requester's identity isn't verified by the channel they used." };
  }
  const self = requester.email?.toLowerCase();
  const selfService = Boolean(self) && targets.length > 0 && targets.every((t) => t === self);

  if (risk === "write") {
    if (input.grantsAccess) {
      return requester.authorized
        ? run
        : { outcome: "approve", code: "access_grant", reason: "Access grants need an authorized approver (a manager or the IT contact), not just the requester." };
    }
    if (selfService || requester.authorized) return run;
    return { outcome: "approve", code: "other_account", reason: "Changes someone else's account and the requester isn't an authorized approver." };
  }

  // destructive
  if (!atLeast(requester.assurance, "chat")) {
    return {
      outcome: "approve",
      code: "weak_identity",
      reason: "Security-sensitive changes need a stronger identity than email (Teams, Slack or a verified chat).",
    };
  }
  if (requester.authorized) return run;
  if (!selfService) {
    return {
      outcome: "approve",
      code: targets.length ? "other_account" : "unknown_target",
      reason: targets.length ? `Affects ${targets.join(", ")}, not the requester.` : "Couldn't confirm which account this changes.",
    };
  }
  if (input.selfServiceToday >= input.maxSelfServicePerDay) {
    return { outcome: "approve", code: "self_service_limit", reason: `${self} already had ${input.selfServiceToday} security-sensitive changes today.` };
  }
  return run;
}

const TARGET_KEYS = ["user", "email", "userEmail", "userPrincipalName", "primaryEmail"];

/** Accounts a tool call would change, read from its validated input. */
export function targetsOf(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const values = TARGET_KEYS.map((k) => (input as Record<string, unknown>)[k]).filter((v): v is string => typeof v === "string" && v.length > 0);
  return [...new Set(values.map((v) => v.toLowerCase()))];
}

// ------------------------------------------------------------ client rules

/** Glob match for tool names: "*" matches any run of characters. */
export function toolMatches(pattern: string, tool: string): boolean {
  const re = new RegExp(`^${pattern.trim().split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(tool);
}

/** Account patterns: an exact address, "*@domain", "@domain" or "*". */
export function accountMatches(pattern: string, account: string): boolean {
  const p = pattern.trim().toLowerCase();
  const a = account.toLowerCase();
  if (!p) return false;
  if (p === "*") return true;
  if (p.startsWith("*@")) return a.endsWith(p.slice(1));
  if (p.startsWith("@")) return a.endsWith(p);
  return a === p;
}

const WAIVABLE: DecisionCode[] = ["supervised", "sensitive", "access_grant", "other_account", "unknown_target"];

export interface RuleContext {
  tool: string;
  risk: Risk;
  targets: string[];
  /** Directory departments of the targets, lowercase; only looked up when a rule needs them. */
  departments: string[];
  requester: Requester;
}

export function ruleMatches(rule: PolicyRule, ctx: RuleContext): boolean {
  if (!rule.enabled) return false;
  if (rule.tools.length && !rule.tools.some((p) => toolMatches(p, ctx.tool))) return false;
  if (rule.risks.length && !rule.risks.includes(ctx.risk)) return false;
  if (rule.targets.length && !(ctx.targets.length && ctx.targets.every((t) => rule.targets.some((p) => accountMatches(p, t))))) return false;
  if (rule.departments.length) {
    const wanted = rule.departments.map((d) => d.trim().toLowerCase());
    if (!(ctx.departments.length && ctx.departments.every((d) => wanted.includes(d)))) return false;
  }
  if (rule.requesters.length) {
    const email = ctx.requester.email;
    if (!email || !rule.requesters.some((p) => accountMatches(p, email))) return false;
  }
  return true;
}

/**
 * Applies the client's rules on top of the autonomy decision; the first matching rule wins.
 *  deny     blocks the call
 *  approve  sends it to the approval queue (to the rule's approvers, if any), even if it would have run
 *  allow    runs it where the autonomy policy only wanted a sign-off for trust reasons (see WAIVABLE),
 *           when the requester's identity is at least the rule's minimum
 * Rules never loosen a block, and only reads are exempt from deny/approve rules.
 */
export function applyRules(base: Decision, rules: PolicyRule[], ctx: RuleContext): Decision & { rule?: PolicyRule } {
  const rule = rules.find((r) => ruleMatches(r, ctx));
  if (!rule) return base;
  const label = `client rule "${rule.name}"`;
  if (rule.effect === "deny") {
    return { outcome: "block", code: "rule", reason: `Blocked by ${label}.`, rule };
  }
  if (rule.effect === "approve") {
    if (base.outcome === "block") return base;
    return {
      outcome: "approve",
      code: "rule",
      reason: base.outcome === "approve" ? `${base.reason} (${label})` : `Needs approval under ${label}.`,
      approvers: rule.approvers.filter(Boolean),
      rule,
    };
  }
  // allow
  if (base.outcome !== "approve" || !base.code || !WAIVABLE.includes(base.code)) return base;
  if (ASSURANCE_RANK[ctx.requester.assurance] < ASSURANCE_RANK[rule.minAssurance]) return base;
  return { outcome: "run", code: "rule", reason: `Allowed by ${label}.`, rule };
}

/**
 * Haley's hard rails. They only ever escalate a decision to "approve" (or keep a block) and nothing a
 * client configures can relax them.
 */
export function applyRails(
  decision: Decision,
  rail: "technician_only" | "self_only" | undefined,
  guardReason: string | null,
  targets: string[],
  requester: Requester,
): Decision {
  if (decision.outcome === "block") return decision;
  const escalate = (reason: string): Decision => ({
    outcome: "approve",
    code: "rail",
    reason: decision.outcome === "approve" && decision.reason ? `${reason} ${decision.reason}` : reason,
    approvers: decision.approvers,
  });
  if (guardReason) return escalate(guardReason);
  if (rail === "technician_only") return escalate("This always needs a technician's approval.");
  if (rail === "self_only" && requester.assurance !== "technician") {
    const self = requester.email?.toLowerCase();
    const selfOnly = Boolean(self) && targets.length > 0 && targets.every((t) => t === self);
    if (!selfOnly) return escalate("Only the account's owner can get this without a technician; for anyone else a technician approves.");
  }
  return decision;
}
