import type { Store } from "../store.js";
import type { Integration } from "../types.js";
import { LiveGoogleApi } from "./google/live.js";
import { googleTools } from "./google/tools.js";
import { discoverM365 } from "./m365/discovery.js";
import { GraphM365Api } from "./m365/graph.js";
import { m365Tools } from "./m365/tools.js";
import { SandboxGoogleApi, type GoogleSandboxState } from "./sandbox/google.js";
import { SandboxM365Api, type M365SandboxState } from "./sandbox/m365.js";
import { ConnectorError, type Connector, type ProviderInfo, type StateStore } from "./types.js";
import { DuoVerifier } from "./verification/duo.js";
import { OktaVerifier } from "./verification/okta.js";
import { SmsCodeVerifier, type PhoneLookup } from "./verification/sms.js";
import { ninjaHost, NinjaOneApi } from "./ninjaone/api.js";
import { ninjaOneTools } from "./ninjaone/tools.js";
import { ItGlueApi, itglueHost, itGlueTools } from "./itglue/tools.js";
import { HuduApi, huduBase, huduTools } from "./hudu/tools.js";
import { parseRestConfig, RestApi, restTools, urlFor } from "./rest/tools.js";

/** Microsoft Graph application permissions Haley's Microsoft 365 tools use. */
export const M365_APP_PERMISSIONS = [
  "User.ReadWrite.All",
  "Group.ReadWrite.All",
  "Directory.Read.All",
  "RoleManagement.Read.Directory",
  "UserAuthenticationMethod.ReadWrite.All",
  "DeviceManagementManagedDevices.ReadWrite.All",
  "DeviceManagementManagedDevices.PrivilegedOperations.All",
  "DeviceManagementConfiguration.Read.All",
  "BitlockerKey.Read.All",
  "ServiceHealth.Read.All",
  "MailboxSettings.ReadWrite",
  "Organization.Read.All",
];

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "m365",
    name: "Microsoft 365",
    description: "Entra ID users, licenses, groups, MFA methods, Intune devices, Exchange mailboxes and service health via Microsoft Graph.",
    fields: [
      { key: "tenantId", label: "Directory (tenant) ID", placeholder: "00000000-0000-0000-0000-000000000000" },
      { key: "clientId", label: "Application (client) ID", placeholder: "00000000-0000-0000-0000-000000000000" },
      { key: "clientSecret", label: "Client secret", secret: true },
    ],
    setupSteps: [
      "In the customer's Entra admin center, go to App registrations → New registration (single tenant).",
      `Under API permissions add Microsoft Graph application permissions: ${M365_APP_PERMISSIONS.join(", ")}. Grant admin consent.`,
      "For password resets, assign the app's service principal the 'User Administrator' or 'Privileged Authentication Administrator' role.",
      "Under Certificates & secrets create a client secret and paste the tenant ID, client ID and secret here.",
    ],
    capabilities: [
      "Users & licenses",
      "Groups & shared mailboxes",
      "Password resets & sign-in blocks",
      "MFA method review",
      "Intune devices, BitLocker keys & remote actions",
      "Intune remediations",
      "Service health",
      "Out-of-office",
    ],
    supportsSandbox: true,
    kind: "directory",
  },
  {
    id: "google",
    name: "Google Workspace",
    description: "Users, groups, org units, 2-Step Verification status, suspensions and sign-outs via the Admin SDK Directory API.",
    fields: [
      { key: "adminEmail", label: "Super admin to impersonate", placeholder: "admin@customer.com" },
      { key: "serviceAccountJson", label: "Service account key (JSON)", secret: true, multiline: true },
    ],
    setupSteps: [
      "In Google Cloud console create a project, enable the Admin SDK API, and create a service account with a JSON key.",
      "In the Workspace Admin console go to Security → API controls → Domain-wide delegation and add the service account's client ID with scopes: https://www.googleapis.com/auth/admin.directory.user, https://www.googleapis.com/auth/admin.directory.group, https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
      "Paste the JSON key and the email of a super admin Haley should act as.",
    ],
    capabilities: ["Users & org units", "Groups", "Password resets", "Suspend / restore", "Force sign-out", "2SV enrollment review"],
    supportsSandbox: true,
    kind: "directory",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Lets this client's employees DM or @mention Haley in their Slack workspace. Haley answers in the thread and can send self-service credentials by DM.",
    fields: [{ key: "botToken", label: "Bot user OAuth token", secret: true, placeholder: "xoxb-…" }],
    setupSteps: [
      "Create (once, for your MSP) a Slack app at api.slack.com/apps. Under OAuth & Permissions add bot scopes: chat:write, im:history, app_mentions:read, users:read, users:read.email.",
      "Under Event Subscriptions, enable events with the Request URL shown on Haley's Channels page (…/hooks/slack/events) and subscribe to bot events message.im and app_mention. Under App Home, enable the Messages tab.",
      "Set HALEY_SLACK_SIGNING_SECRET on the Haley server to the app's signing secret.",
      "Install the app to the client's workspace and paste its bot token here. Haley detects the workspace automatically.",
    ],
    capabilities: ["DMs and @mentions become tickets", "Replies in thread", "Private credential delivery", "Verified identity from Slack profile"],
    supportsSandbox: false,
    kind: "channel",
  },
  {
    id: "duo",
    name: "Duo push",
    description: "Step-up identity check: Haley sends a Duo Push to the requester's own enrolled device (Auth API) and continues only if they approve it.",
    fields: [
      { key: "integrationKey", label: "Integration key", placeholder: "DI…" },
      { key: "secretKey", label: "Secret key", secret: true },
      { key: "apiHostname", label: "API hostname", placeholder: "api-XXXXXXXX.duosecurity.com" },
      { key: "usernameFormat", label: "Duo usernames are", optional: true, placeholder: "email (default) or local", help: "\"local\" if Duo usernames are the part before the @." },
    ],
    setupSteps: [
      "In the client's Duo Admin Panel go to Applications → Application Catalog → Auth API → Protect.",
      "Copy the integration key, secret key and API hostname here.",
      "Make sure the Auth API application's user access includes the client's users.",
    ],
    capabilities: ["Push to the user's own device", "Denials and fraud reports escalate", "Bypass-mode users can't be 'verified'"],
    supportsSandbox: false,
    kind: "verification",
  },
  {
    id: "okta",
    name: "Okta Verify push",
    description: "Step-up identity check: Haley sends an Okta Verify push to the requester's own enrolled device (Factors API) and continues only if they approve it.",
    fields: [
      { key: "domain", label: "Okta domain", placeholder: "acme.okta.com" },
      { key: "apiToken", label: "API token", secret: true },
    ],
    setupSteps: [
      "In the client's Okta Admin Console create a dedicated service admin (Help Desk Admin scoped to the right groups, or Org Admin).",
      "Signed in as that admin, go to Security → API → Tokens → Create token and paste it here with the Okta domain.",
      "Users need an active Okta Verify push factor; the token expires after 30 days without use.",
    ],
    capabilities: ["Push to the user's own device", "Rejections escalate", "Inactive users can't be 'verified'"],
    supportsSandbox: false,
    kind: "verification",
  },
  {
    id: "sms_code",
    name: "SMS verification code (Twilio)",
    description:
      "Step-up identity check for any client: Haley texts a one-time code to the phone number already on the user's Microsoft 365 or Google account, and the user replies with it. No MFA vendor needed.",
    fields: [
      { key: "accountSid", label: "Twilio Account SID", placeholder: "AC…" },
      { key: "authToken", label: "Twilio Auth Token", secret: true },
      { key: "from", label: "Sender number or Messaging Service SID", placeholder: "+15551234567 or MG…" },
    ],
    setupSteps: [
      "Create or reuse a Twilio account with an SMS-capable number or Messaging Service (register it for A2P 10DLC if you text US numbers).",
      "Paste the Account SID, Auth Token and sender here.",
      "Make sure the client's Microsoft 365 app has UserAuthenticationMethod.Read.All (to read registered phones), or that Google users have recovery phones set.",
    ],
    capabilities: ["Codes only go to the number on file", "10-minute codes, 5 guesses", "Works for Microsoft 365 and Google users"],
    supportsSandbox: true,
    kind: "verification",
  },
  {
    id: "ninjaone",
    name: "NinjaOne RMM",
    description:
      "This client's devices in NinjaOne: inventory, health, alerts and pending patches, plus running the MSP's existing automation scripts and normal reboots. Scoped to one NinjaOne organization.",
    fields: [
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "region", label: "Instance", placeholder: "app, us2, eu, ca or oc", help: "The first part of your NinjaOne URL: app.ninjarmm.com → app, eu.ninjarmm.com → eu." },
      { key: "organizationId", label: "NinjaOne organization ID", placeholder: "123", help: "The number in the organization's URL in NinjaOne (…/#/customerDashboard/123/overview)." },
    ],
    setupSteps: [
      "In NinjaOne go to Administration → Apps → API → Client app IDs → Add.",
      "Choose Application platform: API Services (machine-to-machine), scopes Monitoring and Management, and allowed grant type Client Credentials. Save and copy the client ID and secret (the secret is shown once).",
      "Open the client's organization in NinjaOne and copy its ID from the URL.",
      "One NinjaOne API app can serve every client; Haley only reads and acts on devices in the organization you enter here.",
    ],
    capabilities: ["Device inventory & health", "Disk space & pending patches", "Active alerts", "Run existing automation scripts", "Normal reboots"],
    supportsSandbox: false,
    kind: "directory",
  },
  {
    id: "itglue",
    name: "IT Glue",
    description: "Read-only access to this client's IT Glue documents and configurations, so Haley follows your documented procedures. Passwords are never read.",
    fields: [
      { key: "apiKey", label: "API key", secret: true, placeholder: "ITG.…" },
      { key: "region", label: "Data center", placeholder: "us, eu or au", optional: true, help: "Defaults to us (api.itglue.com)." },
      { key: "organizationId", label: "IT Glue organization ID", placeholder: "1234567", help: "The number after your IT Glue domain in the organization's URL." },
    ],
    setupSteps: [
      "In IT Glue go to Account → Settings → API Keys and generate a key. Leave \"Allow access to passwords\" off: Haley never reads passwords.",
      "Open the client's organization in IT Glue and copy its ID from the URL (https://yourcompany.itglue.com/1234567).",
      "Paste the key, your data center (us, eu or au) and the organization ID here.",
    ],
    capabilities: ["Search documents", "Read document sections", "Configurations (documented devices)", "Never reads passwords"],
    supportsSandbox: false,
    kind: "directory",
  },
  {
    id: "hudu",
    name: "Hudu",
    description: "Read-only access to this client's Hudu knowledge base articles and assets, so Haley follows your documented procedures. Asset passwords are never read.",
    fields: [
      { key: "baseUrl", label: "Hudu URL", placeholder: "https://docs.yourmsp.com" },
      { key: "apiKey", label: "API key", secret: true },
      { key: "companyId", label: "Hudu company ID", placeholder: "42", help: "The number in the company's URL in Hudu." },
    ],
    setupSteps: [
      "In Hudu go to Admin → API Keys and create a key. If your Hudu version supports it, restrict the key to this company and leave password access off.",
      "Open the client's company in Hudu and copy its ID from the URL.",
      "Paste your Hudu URL (https only), the key and the company ID here.",
    ],
    capabilities: ["Search knowledge base articles", "Read articles", "Search assets", "Never reads passwords"],
    supportsSandbox: false,
    kind: "directory",
  },
  {
    id: "rest",
    name: "Other REST API",
    description:
      "Connect a SaaS app that has a JSON REST API and a static API key or token. Haley can read from it, and only if you allow writes, change or delete data (every change is policy-gated).",
    fields: [
      { key: "name", label: "Short name", placeholder: "hibob", help: "Lowercase letters, digits and _ (max 20). Haley's tools are named api_<name>_get, api_<name>_write and api_<name>_delete." },
      { key: "description", label: "What this API is", optional: true, multiline: true, placeholder: "HiBob HR: employees, departments and managers", help: "Shown to Haley so she knows when to use it." },
      { key: "baseUrl", label: "Base URL", placeholder: "https://api.example.com/v1", help: "https only, public hostname. Paths Haley calls are appended to this." },
      { key: "authHeader", label: "Auth header name", optional: true, placeholder: "Authorization" },
      { key: "authValue", label: "Auth header value", secret: true, placeholder: "Bearer …" },
      { key: "allowedPaths", label: "Allowed path prefixes", optional: true, placeholder: "/users,/groups", help: "Comma-separated. Leave empty to allow any path under the base URL." },
      { key: "allowWrites", label: "Allow writes", optional: true, placeholder: "false", help: "\"true\" gives Haley POST/PUT/PATCH and DELETE tools. Off by default." },
    ],
    setupSteps: [
      "Create an API key or token in the app, scoped as narrowly as it allows (read-only unless Haley should make changes).",
      "Enter the API's base URL and the header the app expects (e.g. Authorization: Bearer <token>, or X-API-Key: <key>).",
      "Optionally limit Haley to specific path prefixes, and set Allow writes to true only if she should change data. Writes need approval under your autonomy policy; deletes are treated as security-sensitive.",
      "Haley doesn't follow redirects and refuses non-https, IP-address and internal hostnames.",
    ],
    capabilities: ["Read any allowed endpoint", "Optional writes (policy-gated)", "Deletes treated as security-sensitive", "Credentials never shown to the model"],
    supportsSandbox: false,
    kind: "directory",
  },
];

/** Checks provider-specific config values before an integration is stored. Returns a reason, or null. */
export function validateProviderConfig(provider: string, config: Record<string, string>): string | null {
  try {
    if (provider === "ninjaone") {
      ninjaHost(config.region);
      if (!/^\d+$/.test(config.organizationId?.trim() ?? "")) return "NinjaOne organization ID must be a number.";
    } else if (provider === "itglue") {
      itglueHost(config.region);
      if (!/^\d+$/.test(config.organizationId?.trim() ?? "")) return "IT Glue organization ID must be a number.";
    } else if (provider === "hudu") {
      huduBase(config.baseUrl ?? "");
      if (!/^\d+$/.test(config.companyId?.trim() ?? "")) return "Hudu company ID must be a number.";
    } else if (provider === "rest") {
      parseRestConfig(config);
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

function stateStore<T>(store: Store, integrationId: string): StateStore<T> {
  return {
    load: () => store.getIntegrationState<T>(integrationId),
    save: (state) => store.setIntegrationState(integrationId, state),
  };
}

function required(config: Record<string, string>, keys: string[]) {
  const missing = keys.filter((k) => !config[k]?.trim());
  if (missing.length) throw new ConnectorError(`Missing credentials: ${missing.join(", ")}`);
}

/** Other connectors for the same org, e.g. so a verifier can look up a user's phone number in the directory. */
export type SiblingConnectors = () => Connector[];

/** The phone number registered on the user's account in the org's directory (Microsoft 365, then Google). */
export function directoryPhoneLookup(siblings: SiblingConnectors, orgId: string): PhoneLookup {
  const ctx = { orgId, runId: "", ticketId: null };
  return async (email) => {
    for (const connector of siblings()) {
      for (const tool of connector.tools) {
        try {
          if (tool.name === "m365_get_user") {
            const user = (await tool.run({ user: email }, ctx)) as { mfaMethods?: Array<{ type: string; detail: string }> };
            // Only a mobile number can receive a text (office and alternate phones may be landlines).
            const phone = user.mfaMethods?.find((m) => m.type === "phone:mobile" && /\d{6,}/.test(m.detail.replace(/\D/g, "")))?.detail;
            if (phone) return phone;
          } else if (tool.name === "gws_get_user") {
            const user = (await tool.run({ email }, ctx)) as { recoveryPhone?: string | null };
            if (user.recoveryPhone) return user.recoveryPhone;
          }
        } catch {
          // Not in this directory; try the next one.
        }
      }
    }
    return null;
  };
}

/** The MSP's multi-tenant Entra app, used by clients connected through admin consent. */
export interface MspM365App {
  clientId: string;
  clientSecret: string;
}

export function buildConnector(
  store: Store,
  integration: Integration,
  fetchImpl: typeof fetch = fetch,
  siblings: SiblingConnectors = () => [],
  mspApp: MspM365App | null = null,
): Connector {
  const config = store.getIntegrationConfig(integration.id);
  const sandbox = integration.mode === "sandbox";

  if (integration.provider === "m365") {
    let api;
    if (sandbox) {
      api = new SandboxM365Api(stateStore<M365SandboxState>(store, integration.id), config.domain || undefined);
    } else if (config.authMode === "msp_app") {
      required(config, ["tenantId"]);
      if (!mspApp) throw new ConnectorError("This client was connected with the MSP app, but HALEY_M365_CLIENT_ID / HALEY_M365_CLIENT_SECRET aren't set on the server.");
      api = new GraphM365Api({ tenantId: config.tenantId, clientId: mspApp.clientId, clientSecret: mspApp.clientSecret }, fetchImpl);
    } else {
      required(config, ["tenantId", "clientId", "clientSecret"]);
      api = new GraphM365Api({ tenantId: config.tenantId, clientId: config.clientId, clientSecret: config.clientSecret }, fetchImpl);
    }
    return {
      integrationId: integration.id,
      provider: "m365",
      label: integration.label,
      tools: m365Tools(api),
      discover: () => discoverM365(api),
      test: async () => {
        const [org, skus] = await Promise.all([api.organization(), api.listSkus()]);
        return `Connected to ${org.displayName || org.id} (${org.verifiedDomains.join(", ")}); ${skus.length} license SKUs visible.`;
      },
    };
  }

  if (integration.provider === "google") {
    let api;
    if (sandbox) {
      api = new SandboxGoogleApi(stateStore<GoogleSandboxState>(store, integration.id), config.domain || undefined);
    } else {
      required(config, ["adminEmail", "serviceAccountJson"]);
      api = new LiveGoogleApi({ adminEmail: config.adminEmail, serviceAccountJson: config.serviceAccountJson }, fetchImpl);
    }
    return {
      integrationId: integration.id,
      provider: "google",
      label: integration.label,
      tools: googleTools(api),
      test: async () => {
        const [users, ous] = await Promise.all([api.listUsers(), api.listOrgUnits()]);
        return `Connected; ${users.length} users and ${ous.length} org units visible.`;
      },
    };
  }

  if (integration.provider === "slack") {
    required(config, ["botToken"]);
    return {
      integrationId: integration.id,
      provider: "slack",
      label: integration.label,
      tools: [],
      test: async () => {
        const res = await fetchImpl("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${config.botToken}` } });
        const data = (await res.json()) as { ok: boolean; error?: string; team?: string; team_id?: string; user?: string };
        if (!data.ok) throw new ConnectorError(`Slack rejected the token: ${data.error}`);
        store.setIntegrationState(integration.id, { teamId: data.team_id, team: data.team });
        return `Connected to the ${data.team} workspace as @${data.user}.`;
      },
    };
  }

  if (integration.provider === "duo") {
    required(config, ["integrationKey", "secretKey", "apiHostname"]);
    const verifier = new DuoVerifier(
      {
        integrationKey: config.integrationKey,
        secretKey: config.secretKey,
        apiHostname: config.apiHostname,
        usernameFormat: config.usernameFormat?.trim().toLowerCase() === "local" ? "local" : "email",
      },
      fetchImpl,
    );
    return { integrationId: integration.id, provider: "duo", label: integration.label, tools: [], verifier, test: () => verifier.check() };
  }

  if (integration.provider === "okta") {
    required(config, ["domain", "apiToken"]);
    const verifier = new OktaVerifier({ domain: config.domain, apiToken: config.apiToken }, fetchImpl);
    return { integrationId: integration.id, provider: "okta", label: integration.label, tools: [], verifier, test: () => verifier.check() };
  }

  if (integration.provider === "sms_code") {
    const lookup = directoryPhoneLookup(siblings, integration.org_id);
    let verifier: SmsCodeVerifier;
    if (sandbox) {
      verifier = new SmsCodeVerifier(null, lookup, fetchImpl, (email, phone, body) => {
        const ticket = store.listTickets({ orgId: integration.org_id, status: "open", limit: 500 }).find((t) => t.requester_email.toLowerCase() === email);
        if (ticket) store.addTicketEvent(ticket.id, "agent_note", "sandbox sms", `[Sandbox text to ${phone}] ${body}`, { sandbox: true });
      });
    } else {
      required(config, ["accountSid", "authToken", "from"]);
      verifier = new SmsCodeVerifier({ accountSid: config.accountSid, authToken: config.authToken, from: config.from }, lookup, fetchImpl);
    }
    return {
      integrationId: integration.id,
      provider: "sms_code",
      label: integration.label,
      tools: [],
      verifier,
      test: async () => {
        if (sandbox) return "Sandbox: codes appear on the ticket timeline instead of being texted.";
        const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}.json`, {
          headers: { authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}` },
        });
        const data = (await res.json().catch(() => ({}))) as { friendly_name?: string; status?: string; message?: string };
        if (!res.ok) throw new ConnectorError(`Twilio rejected the credentials: ${data.message ?? res.statusText}`, res.status);
        return `Twilio account "${data.friendly_name}" (${data.status}). Codes go to the phone on each user's account.`;
      },
    };
  }

  if (integration.provider === "ninjaone") {
    required(config, ["clientId", "clientSecret", "organizationId"]);
    const orgId = Number(config.organizationId.trim());
    if (!Number.isInteger(orgId) || orgId <= 0) throw new ConnectorError("NinjaOne organization ID must be a number.");
    const api = new NinjaOneApi({ host: ninjaHost(config.region), clientId: config.clientId.trim(), clientSecret: config.clientSecret.trim() }, fetchImpl);
    return {
      integrationId: integration.id,
      provider: "ninjaone",
      label: integration.label,
      tools: ninjaOneTools(api, orgId),
      test: async () => {
        const org = await api.organization(orgId);
        const devices = await api.organizationDevices(orgId);
        const offline = devices.filter((d) => d.offline).length;
        return `Connected to ${api.host}; organization "${org.name}" has ${devices.length} devices (${offline} offline).`;
      },
    };
  }

  if (integration.provider === "itglue") {
    required(config, ["apiKey", "organizationId"]);
    const orgId = config.organizationId.trim();
    if (!/^\d+$/.test(orgId)) throw new ConnectorError("IT Glue organization ID must be a number.");
    const api = new ItGlueApi({ host: itglueHost(config.region), apiKey: config.apiKey.trim() }, fetchImpl);
    return {
      integrationId: integration.id,
      provider: "itglue",
      label: integration.label,
      tools: itGlueTools(api, orgId),
      test: async () => {
        const { data } = await api.get<{ data: { id: string; attributes: Record<string, unknown> } }>(`/organizations/${orgId}`);
        return `Connected; IT Glue organization "${data.attributes.name}" (${data.id}). Documents and configurations are read-only; passwords are never read.`;
      },
    };
  }

  if (integration.provider === "hudu") {
    required(config, ["baseUrl", "apiKey", "companyId"]);
    const companyId = Number(config.companyId.trim());
    if (!Number.isInteger(companyId) || companyId <= 0) throw new ConnectorError("Hudu company ID must be a number.");
    const api = new HuduApi({ baseUrl: huduBase(config.baseUrl), apiKey: config.apiKey.trim() }, fetchImpl);
    return {
      integrationId: integration.id,
      provider: "hudu",
      label: integration.label,
      tools: huduTools(api, companyId),
      test: async () => {
        const { company } = await api.get<{ company?: { id: number; name?: string } }>(`/companies/${companyId}`);
        if (!company) throw new ConnectorError(`Hudu company ${companyId} wasn't found.`);
        return `Connected; Hudu company "${company.name}" (${company.id}). Articles and assets are read-only; passwords are never read.`;
      },
    };
  }

  if (integration.provider === "rest") {
    const api = new RestApi(parseRestConfig(config), fetchImpl);
    return {
      integrationId: integration.id,
      provider: "rest",
      label: integration.label,
      tools: restTools(api),
      test: async () => {
        const path = api.config.allowedPaths[0];
        const url = path ? urlFor(api.config, path) : api.config.baseUrl;
        const res = await api.call("GET", url);
        if (res.status === 401 || res.status === 403) {
          throw new ConnectorError(`${url.host} rejected the credentials (HTTP ${res.status}).`, res.status);
        }
        if (res.status >= 500) throw new ConnectorError(`${url.host} returned HTTP ${res.status}.`, res.status);
        const tools = api.config.allowWrites ? "read, write and delete tools" : "a read-only tool";
        return `Reached ${url.host}${url.pathname}: HTTP ${res.status}. Haley has ${tools} (api_${api.config.name}_*).`;
      },
    };
  }

  throw new ConnectorError(`Unknown provider ${integration.provider}`);
}
