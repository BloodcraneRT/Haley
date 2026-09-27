import type { Store } from "../store.js";
import type { Integration } from "../types.js";
import { LiveGoogleApi } from "./google/live.js";
import { googleTools } from "./google/tools.js";
import { GraphM365Api } from "./m365/graph.js";
import { m365Tools } from "./m365/tools.js";
import { SandboxGoogleApi, type GoogleSandboxState } from "./sandbox/google.js";
import { SandboxM365Api, type M365SandboxState } from "./sandbox/m365.js";
import { ConnectorError, type Connector, type ProviderInfo, type StateStore } from "./types.js";
import { DuoVerifier } from "./verification/duo.js";
import { SmsCodeVerifier, type PhoneLookup } from "./verification/sms.js";

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
            const phone = user.mfaMethods?.find((m) => /phone/i.test(m.type) && /\d{6,}/.test(m.detail.replace(/\D/g, "")))?.detail;
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

export function buildConnector(
  store: Store,
  integration: Integration,
  fetchImpl: typeof fetch = fetch,
  siblings: SiblingConnectors = () => [],
): Connector {
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

  throw new ConnectorError(`Unknown provider ${integration.provider}`);
}
