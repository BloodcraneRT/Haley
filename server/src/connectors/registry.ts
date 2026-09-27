import type { Store } from "../store.js";
import type { Integration } from "../types.js";
import { LiveGoogleApi } from "./google/live.js";
import { googleTools } from "./google/tools.js";
import { GraphM365Api } from "./m365/graph.js";
import { m365Tools } from "./m365/tools.js";
import { SandboxGoogleApi, type GoogleSandboxState } from "./sandbox/google.js";
import { SandboxM365Api, type M365SandboxState } from "./sandbox/m365.js";
import { ConnectorError, type Connector, type ProviderInfo, type StateStore } from "./types.js";

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
      "Under API permissions add Microsoft Graph application permissions: User.ReadWrite.All, Group.ReadWrite.All, Directory.Read.All, UserAuthenticationMethod.ReadWrite.All, DeviceManagementManagedDevices.Read.All, ServiceHealth.Read.All, MailboxSettings.ReadWrite, Organization.Read.All. Grant admin consent.",
      "For password resets, assign the app's service principal the 'User Administrator' or 'Privileged Authentication Administrator' role.",
      "Under Certificates & secrets create a client secret and paste the tenant ID, client ID and secret here.",
    ],
    capabilities: ["Users & licenses", "Groups & shared mailboxes", "Password resets & sign-in blocks", "MFA method review", "Intune devices", "Service health", "Out-of-office"],
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
];

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

export function buildConnector(store: Store, integration: Integration, fetchImpl: typeof fetch = fetch): Connector {
  const config = store.getIntegrationConfig(integration.id);
  const sandbox = integration.mode === "sandbox";

  if (integration.provider === "m365") {
    let api;
    if (sandbox) {
      api = new SandboxM365Api(stateStore<M365SandboxState>(store, integration.id), config.domain || undefined);
    } else {
      required(config, ["tenantId", "clientId", "clientSecret"]);
      api = new GraphM365Api({ tenantId: config.tenantId, clientId: config.clientId, clientSecret: config.clientSecret }, fetchImpl);
    }
    return {
      integrationId: integration.id,
      provider: "m365",
      label: integration.label,
      tools: m365Tools(api),
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

  throw new ConnectorError(`Unknown provider ${integration.provider}`);
}
