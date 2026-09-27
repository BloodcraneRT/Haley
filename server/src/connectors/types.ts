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
  /** One-line, human-readable summary shown to technicians in the approval queue. */
  describe?: (input: I) => string;
  run: (input: I, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  input: S;
  risk: Risk;
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

export interface Connector {
  integrationId: string;
  provider: string;
  label: string;
  tools: HaleyTool[];
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
}
