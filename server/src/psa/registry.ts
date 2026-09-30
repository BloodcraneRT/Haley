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
  {
    id: "connectwise",
    name: "ConnectWise PSA",
    description: "Two-way ticket sync with ConnectWise PSA (Manage): import service tickets for Haley to work, post her replies as Discussion notes and her notes as Internal notes, and move tickets between board statuses as she does.",
    fields: [
      { key: "site", label: "API site", placeholder: "api-na.myconnectwise.net", help: "Your region's API host (api-na, api-eu, api-au…), or your on-premises server." },
      { key: "companyId", label: "Company ID", placeholder: "yourmsp", help: "The company you log in to ConnectWise with." },
      { key: "publicKey", label: "Public key", help: "From the API member's API Keys tab." },
      { key: "privateKey", label: "Private key", secret: true },
      { key: "clientId", label: "Client ID", placeholder: "00000000-0000-0000-0000-000000000000", help: "A developer clientId from developer.connectwise.com (ClientID)." },
      { key: "board", label: "Service board", placeholder: "Help Desk", help: "Tickets Haley creates go here, and tickets on this board are imported." },
      { key: "importBoards", label: "Also import from boards", optional: true, placeholder: "Service Desk, Projects", help: "Comma-separated." },
      { key: "statusNew", label: "“New” status", optional: true, placeholder: "New" },
      { key: "statusInProgress", label: "“In progress” status", optional: true, placeholder: "In Progress" },
      { key: "statusWaiting", label: "“Waiting on customer” status", optional: true, placeholder: "Waiting on Customer" },
      { key: "statusResolved", label: "“Resolved” status", optional: true, placeholder: "Resolved", help: "Status names must exist on the ticket's board." },
      { key: "emailContacts", label: "ConnectWise emails contacts about Discussion notes", optional: true, placeholder: "no", help: "Answer yes only if your board's notification rules email the contact; otherwise Haley emails them herself." },
    ],
    setupSteps: [
      "Create a developer clientId at developer.connectwise.com (ClientID → New).",
      "In ConnectWise go to System → Members → API Members, add a member with a security role that can read Companies and read/write Service Tickets and ticket notes, and default it to your service board.",
      "Open the API member's API Keys tab → +, and copy the public and private keys (the private key is shown once).",
      "Paste your API site, company ID, keys, clientId and board here, then map ConnectWise companies to Haley clients.",
    ],
  },
  {
    id: "autotask",
    name: "Autotask PSA",
    description: "Two-way ticket sync with Autotask PSA: import tickets for Haley to work, add her replies and internal notes as ticket notes, and keep ticket status in step.",
    fields: [
      { key: "username", label: "API username", placeholder: "haley@yourmsp.com", help: "The API-only resource's username; Haley looks up your zone from it." },
      { key: "secret", label: "API secret", secret: true },
      { key: "integrationCode", label: "API tracking identifier", secret: true, help: "The integration code chosen on the API user's API Tracking Identifier section." },
      { key: "zoneUrl", label: "Zone URL", optional: true, placeholder: "https://webservices5.autotask.net/ATServicesRest", help: "Leave blank to look it up." },
      { key: "queueId", label: "Queue ID for tickets Haley creates", optional: true, placeholder: "29682833" },
      { key: "statusNew", label: "“New” status ID", optional: true, placeholder: "1" },
      { key: "statusInProgress", label: "“In progress” status ID", optional: true, placeholder: "8" },
      { key: "statusWaiting", label: "“Waiting customer” status ID", optional: true, placeholder: "7" },
      { key: "statusComplete", label: "“Complete” status ID", optional: true, placeholder: "5", help: "Blank status IDs are found by name." },
    ],
    setupSteps: [
      "In Autotask go to Admin → Account Settings & Users → Resources/Users → New → New API User.",
      "Give it the API User (system) security level, generate a username and secret, and under API Tracking Identifier choose Custom (Haley) or an integration vendor.",
      "Make sure the API user's line of business/permissions can see the companies and tickets Haley should work.",
      "Paste the username, secret and tracking identifier here, then map Autotask companies to Haley clients.",
    ],
  },
  {
    id: "halopsa",
    name: "HaloPSA",
    description: "Two-way ticket sync with HaloPSA: import tickets for Haley to work, post her replies as actions emailed to the end user and her notes as private actions, and keep status in step.",
    fields: [
      { key: "instance", label: "Halo URL", placeholder: "yourmsp.halopsa.com" },
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "tenant", label: "Tenant", optional: true, help: "Only for Halo-hosted instances whose API details show a tenant." },
      { key: "ticketTypeId", label: "Ticket type ID for tickets Haley creates", optional: true, placeholder: "1" },
      { key: "statusNew", label: "“New” status ID", optional: true, placeholder: "1" },
      { key: "statusInProgress", label: "“In progress” status ID", optional: true, placeholder: "2" },
      { key: "statusWaiting", label: "“Waiting on customer” status ID", optional: true, help: "Blank status IDs are found by name." },
      { key: "statusClosed", label: "“Closed” status ID", optional: true, placeholder: "9" },
    ],
    setupSteps: [
      "In HaloPSA go to Configuration → Integrations → HaloPSA API → View Applications → New.",
      "Choose Client ID and Secret (Services) authentication, log in as an agent that can see the right clients and tickets, and grant the all permission (or read/edit tickets, actions, customers).",
      "Paste your Halo URL, client ID and secret (and tenant, if shown on the API page) here, then map Halo clients to Haley clients.",
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
