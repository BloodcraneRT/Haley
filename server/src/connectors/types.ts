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
  run: (input: I, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  input: S;
  risk: Risk;
  grantsAccess?: boolean;
  describe?: (input: z.infer<S>) => string;
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
  outcome: "approved" | "denied" | "timeout" | "unavailable";
  /** Human-readable detail, e.g. "Approved on iPhone 15" or "No push-capable device enrolled". */
  detail: string;
}

/** Out-of-band identity check: a push to the user's own registered MFA device. */
export interface Verifier {
  /** Short method name recorded on the ticket, e.g. "Duo push". */
  method: string;
  verify(userEmail: string, context: { reason: string; ticketNumber: number | null }): Promise<VerificationResult>;
}

export interface Connector {
  integrationId: string;
  provider: string;
  label: string;
  tools: HaleyTool[];
  /** Present on identity-verification providers (Duo, Okta, Microsoft Authenticator). */
  verifier?: Verifier;
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
