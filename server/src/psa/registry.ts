import type { PsaAdapter, PsaConnection, PsaKind } from "./types.js";

export interface PsaProviderInfo {
  id: PsaKind;
  name: string;
  description: string;
  fields: Array<{ key: string; label: string; secret?: boolean; placeholder?: string; help?: string; optional?: boolean }>;
  setupSteps: string[];
}

export const PSA_PROVIDERS: PsaProviderInfo[] = [
  {
    id: "syncro",
    name: "SyncroMSP",
    description: "Two-way ticket sync with SyncroMSP: import customer tickets for Haley to work, post her replies as public comments, mirror notes as hidden comments, and keep status in step.",
    fields: [
      { key: "subdomain", label: "Syncro subdomain", placeholder: "yourmsp (from yourmsp.syncromsp.com)" },
      { key: "apiKey", label: "API token", secret: true, help: "Admin → API Tokens → New Token, with ticket, customer and contact permissions." },
      { key: "problemType", label: "Problem type for tickets Haley creates", optional: true, placeholder: "Other", help: "Must be one of your account's problem types." },
    ],
    setupSteps: [
      "In SyncroMSP go to Admin → API Tokens → New Token (custom permissions).",
      "Grant: Tickets (list/search, view details, create, edit, comment), Customers (list/search, view), Contacts (list/search, view).",
      "Paste your subdomain and the token here, then map Syncro customers to Haley clients.",
    ],
  },
  {
    id: "dynamics",
    name: "Dynamics 365 Customer Service",
    description: "Two-way case sync with Dynamics 365 (Dataverse): import cases for Haley to work, add her replies and notes to the case timeline, and resolve or reopen cases as she does.",
    fields: [
      { key: "orgUrl", label: "Environment URL", placeholder: "https://yourorg.crm.dynamics.com" },
      { key: "tenantId", label: "Directory (tenant) ID" },
      { key: "clientId", label: "Application (client) ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
    ],
    setupSteps: [
      "Register an app in Entra ID (single tenant) and create a client secret.",
      "In the Power Platform admin center, open the environment → Settings → Users + permissions → Application users → New app user, pick the app, and give it a security role that can read/write Cases, Notes, Accounts and Contacts (e.g. Customer Service Representative plus note write).",
      "Paste the environment URL, tenant ID, client ID and secret here, then map Dynamics accounts to Haley clients.",
    ],
  },
];

export type PsaFactory = (connection: PsaConnection, config: Record<string, string>, fetchImpl: typeof fetch) => PsaAdapter;

const factories = new Map<PsaKind, PsaFactory>();

export function registerPsaFactory(kind: PsaKind, factory: PsaFactory) {
  factories.set(kind, factory);
}

export function buildPsaAdapter(connection: PsaConnection, config: Record<string, string>, fetchImpl: typeof fetch = fetch): PsaAdapter {
  const factory = factories.get(connection.kind);
  if (!factory) throw new Error(`Unknown PSA ${connection.kind}`);
  return factory(connection, config, fetchImpl);
}
