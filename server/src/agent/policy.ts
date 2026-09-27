import { ASSURANCE_RANK, type Assurance, type Autonomy, type Risk } from "../types.js";

export type Outcome = "run" | "approve" | "block";

export interface Decision {
  outcome: Outcome;
  /** Why the call needs a human or was blocked; shown to technicians and the agent. */
  reason: string;
}

export interface Requester {
  email: string | null;
  assurance: Assurance;
  /** Allowed to request changes to other people's accounts (listed approvers, technicians). */
  authorized: boolean;
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

const run: Decision = { outcome: "run", reason: "" };
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
    return { outcome: "block", reason: "This organization is read-only: Haley recommends changes but doesn't make them." };
  }
  if (protectedTargets.length) {
    return { outcome: "approve", reason: `${protectedTargets.join(", ")} is a protected account.` };
  }
  if (autonomy === "supervised") return { outcome: "approve", reason: "Supervised: every change needs approval." };
  if (autonomy === "autonomous") {
    return risk === "destructive" ? { outcome: "approve", reason: "Security-sensitive change." } : run;
  }

  // unattended
  if (input.changesLastHour >= input.maxChangesPerHour) {
    return { outcome: "approve", reason: `Hourly limit of ${input.maxChangesPerHour} automatic changes reached.` };
  }
  if (!atLeast(requester.assurance, "email")) {
    return { outcome: "approve", reason: "The requester's identity isn't verified by the channel they used." };
  }
  const self = requester.email?.toLowerCase();
  const selfService = Boolean(self) && targets.length > 0 && targets.every((t) => t === self);

  if (risk === "write") {
    if (input.grantsAccess) {
      return requester.authorized
        ? run
        : { outcome: "approve", reason: "Access grants need an authorized approver (a manager or the IT contact), not just the requester." };
    }
    if (selfService || requester.authorized) return run;
    return { outcome: "approve", reason: "Changes someone else's account and the requester isn't an authorized approver." };
  }

  // destructive
  if (!atLeast(requester.assurance, "chat")) {
    return {
      outcome: "approve",
      reason: "Security-sensitive changes need a stronger identity than email (Teams, Slack or a verified chat).",
    };
  }
  if (requester.authorized) return run;
  if (!selfService) {
    return {
      outcome: "approve",
      reason: targets.length ? `Affects ${targets.join(", ")}, not the requester.` : "Couldn't confirm which account this changes.",
    };
  }
  if (input.selfServiceToday >= input.maxSelfServicePerDay) {
    return { outcome: "approve", reason: `${self} already had ${input.selfServiceToday} security-sensitive changes today.` };
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
