import { z } from "zod";
import type { Risk } from "../types.js";

export interface ToolContext {
  orgId: string;
  runId: string;
  ticketId: string | null;
}

/**
 * A capability Haley's agent can call. Connectors and built-ins both produce these;
 * the runner handles validation, approval policy, auditing and secret redaction.
 */
export interface HaleyTool<I = any> {
  name: string;
  description: string;
  input: z.ZodType;
  risk: Risk;
  /** Grants access to data or resources (group, mailbox, app membership); unattended mode wants an approver. */
  grantsAccess?: boolean;
  /** One-line, human-readable summary shown to technicians in the approval queue. */
  describe?: (input: I) => string;
  /** Accounts the call affects when the input doesn't name them, e.g. a device's primary user. */
  resolveTargets?: (input: I) => Promise<string[]>;
  /**
   * A hard safety rail that no autonomy level or client rule can relax:
   *  technician_only  always waits for a technician's approval (e.g. wiping a device)
   *  self_only        runs on its own only for the requester's own account; for anyone else a technician
   *                   approves (e.g. a Temporary Access Pass, which gets around the target's MFA)
   */
  rail?: "technician_only" | "self_only";
  /** Extra check on the actual input; returns a reason when the call must wait for a technician. */
  guard?: (input: I) => Promise<string | null>;
  run: (input: I, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  input: S;
  risk: Risk;
  grantsAccess?: boolean;
  describe?: (input: z.infer<S>) => string;
  resolveTargets?: (input: z.infer<S>) => Promise<string[]>;
  rail?: "technician_only" | "self_only";
  guard?: (input: z.infer<S>) => Promise<string | null>;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}): HaleyTool<z.infer<S>> {
  return tool as HaleyTool<z.infer<S>>;
}

/**
 * Wrap a tool result that carries credentials (e.g. a temporary password).
 * The runner stores `secrets` encrypted for technicians and only shows `visible` to the model.
 */
export class SensitiveResult {
  constructor(
    readonly visible: unknown,
    readonly secrets: Record<string, string>,
    /** Whose secret this is when the input doesn't name the account (e.g. the device owner for a BitLocker key). */
    readonly owners?: string[],
  ) {}
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface VerificationResult {
  /** code_sent: a one-time code went to the user's phone on file; confirm it with checkCode. */
  outcome: "approved" | "denied" | "timeout" | "unavailable" | "code_sent" | "wrong_code";
  /** Human-readable detail, e.g. "Approved on iPhone 15" or "No push-capable device enrolled". */
  detail: string;
}

/**
 * Out-of-band identity check against something only the real user has: a push to their registered MFA
 * device, or a one-time code sent to the phone number already on their account.
 */
export interface Verifier {
  /** Short method name recorded on the ticket, e.g. "Duo push" or "SMS code". */
  method: string;
  kind: "push" | "code";
  verify(userEmail: string, context: { reason: string; ticketNumber: number | null }): Promise<VerificationResult>;
  /** Code-based methods: check what the user typed back. */
  checkCode?(userEmail: string, code: string): Promise<VerificationResult>;
}

export interface Connector {
  integrationId: string;
  provider: string;
  label: string;
  tools: HaleyTool[];
  /** Present on identity-verification providers (Duo, Okta, Microsoft Authenticator). */
  verifier?: Verifier;
  /** Microsoft 365: scan the tenant and suggest client settings. */
  discover?: () => Promise<unknown>;
  test(): Promise<string>;
}

/** Persists sandbox tenant state between requests. */
export interface StateStore<T> {
  load(): T | null;
  save(state: T): void;
}

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
  id: string;
  name: string;
  description: string;
  fields: ProviderField[];
  setupSteps: string[];
  capabilities: string[];
  /** Whether a simulated tenant is available for trying the provider without credentials. */
  supportsSandbox: boolean;
  /** "directory" providers give Haley tools; "channel" providers let end users reach Haley; "verification" providers do MFA step-up. */
  kind: "directory" | "channel" | "verification";
  /** Shown prominently in the connect dialog (e.g. undocumented APIs). */
  warning?: string;
}
