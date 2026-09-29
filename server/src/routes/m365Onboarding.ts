import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { HaleyConfig } from "../config.js";
import { M365_APP_PERMISSIONS } from "../connectors/registry.js";
import type { M365Discovery } from "../connectors/m365/discovery.js";
import type { Connector } from "../connectors/types.js";
import type { Store } from "../store.js";
import type { Integration } from "../types.js";

/** How long an admin-consent link stays valid. */
export const CONSENT_STATE_TTL_MS = 30 * 60_000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class OnboardingError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface ConsentState {
  orgId: string;
  expiresAt: number;
  nonce: string;
}

/** The consent `state` is signed so the public callback only accepts links Haley issued for that client. */
export function signConsentState(key: Buffer, state: ConsentState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const mac = createHmac("sha256", key).update(`m365-consent.${payload}`).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyConsentState(key: Buffer, token: string, nowMs = Date.now()): ConsentState | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", key).update(`m365-consent.${payload}`).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ConsentState;
    return typeof state.orgId === "string" && state.expiresAt > nowMs ? state : null;
  } catch {
    return null;
  }
}

export interface OnboardingDeps {
  config: HaleyConfig;
  store: Store;
  connectorFor: (integration: Integration) => Connector;
  testIntegration: (integration: Integration) => Promise<Integration>;
  actor: (req: FastifyRequest) => string;
}

/**
 * Guided Microsoft 365 onboarding for MSPs: one multi-tenant Haley app, an admin-consent link per client,
 * then a tenant discovery that suggests the client's settings.
 */
export function registerM365Onboarding(app: FastifyInstance, deps: OnboardingDeps): void {
  const { config, store } = deps;
  const publicUrl = config.channels.publicUrl;
  const redirectUri = `${publicUrl}/hooks/m365/consent`;

  app.get("/api/m365/onboarding", async () => ({
    mspAppConfigured: Boolean(config.m365App),
    clientId: config.m365App?.clientId ?? null,
    redirectUri,
    permissions: M365_APP_PERMISSIONS,
  }));

  app.post<{ Params: { id: string } }>("/api/orgs/:id/m365/consent", async (req) => {
    const org = store.getOrg(req.params.id);
    if (!org) throw new OnboardingError(404, "Organization not found");
    if (!config.m365App) {
      throw new OnboardingError(400, "Set HALEY_M365_CLIENT_ID and HALEY_M365_CLIENT_SECRET (your MSP's multi-tenant Entra app) to use admin-consent onboarding.");
    }
    // A partner admin consenting through GDAP must sign in against the customer's tenant, not their own,
    // so the link can name the tenant. A client's own Global Admin can use the generic link.
    const parsed = z
      .object({ tenant: z.string().trim().toLowerCase().regex(/^([0-9a-f-]{36}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/, "Use the tenant ID or a verified domain.").optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw new OnboardingError(400, z.prettifyError(parsed.error));
    const authority = parsed.data.tenant || "organizations";
    const state = signConsentState(config.secretKey, { orgId: org.id, expiresAt: Date.now() + CONSENT_STATE_TTL_MS, nonce: randomBytes(8).toString("hex") });
    const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(authority)}/v2.0/adminconsent`);
    url.searchParams.set("client_id", config.m365App.clientId);
    url.searchParams.set("scope", "https://graph.microsoft.com/.default");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    store.audit({ orgId: org.id, actor: deps.actor(req), action: "m365.consent_link_created", target: org.id });
    return { url: url.toString(), expiresInMinutes: CONSENT_STATE_TTL_MS / 60_000 };
  });

  // Public: Microsoft sends the admin's browser here after they approve (or decline) the consent prompt.
  app.get("/hooks/m365/consent", async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const back = (orgId: string | null, params: Record<string, string>) =>
      reply.redirect(`${publicUrl}/${orgId ? `clients/${encodeURIComponent(orgId)}` : ""}?${new URLSearchParams(params)}`);

    const state = q.state ? verifyConsentState(config.secretKey, q.state) : null;
    if (!state) return back(null, { m365: "error", detail: "This consent link is invalid or expired. Start again from the client's page." });
    const org = store.getOrg(state.orgId);
    if (!org) return back(null, { m365: "error", detail: "That client no longer exists." });

    if (q.error || q.admin_consent?.toLowerCase() !== "true") {
      const detail = q.error_description?.split("\r\n")[0] || q.error || "Consent wasn't granted.";
      store.audit({ orgId: org.id, actor: "microsoft", action: "m365.consent_declined", target: org.id, detail: { error: q.error ?? "" } });
      return back(org.id, { m365: "error", detail });
    }
    const tenantId = q.tenant ?? "";
    if (!GUID.test(tenantId)) return back(org.id, { m365: "error", detail: "Microsoft didn't return a tenant ID." });
    if (!config.m365App) return back(org.id, { m365: "error", detail: "The MSP app isn't configured on this server." });

    const existing = store.listIntegrations(org.id).find((i) => i.provider === "m365");
    let integration: Integration;
    if (existing) {
      const cfg = store.getIntegrationConfig(existing.id);
      if (existing.mode !== "live" || cfg.authMode !== "msp_app" || cfg.tenantId?.toLowerCase() !== tenantId.toLowerCase()) {
        return back(org.id, { m365: "error", detail: `${org.name} already has a Microsoft 365 connection. Remove it first to connect this tenant.` });
      }
      integration = existing; // Re-consent (e.g. after new permissions); just re-test.
    } else {
      integration = store.createIntegration({
        orgId: org.id,
        provider: "m365",
        mode: "live",
        label: `${org.name} Microsoft 365`,
        config: { tenantId, authMode: "msp_app" },
      });
    }
    store.audit({ orgId: org.id, actor: "microsoft", action: "m365.consent_granted", target: integration.id, detail: { tenantId } });

    // New consent can take a moment to reach Microsoft's token service; a failed first test is retried from the UI.
    const tested = await deps.testIntegration(integration);
    if (tested.status !== "connected") return back(org.id, { m365: "connected", detail: `Consent recorded, but the first test failed: ${tested.status_detail}` });
    try {
      const discovery = (await deps.connectorFor(tested).discover?.()) as M365Discovery | undefined;
      if (discovery) store.saveDiscovery(integration.id, discovery);
    } catch {
      // Discovery can be re-run from the dashboard.
    }
    return back(org.id, { m365: "connected" });
  });

  const m365Integration = (integrationId: string) => {
    const integration = store.getIntegration(integrationId);
    if (!integration) throw new OnboardingError(404, "Integration not found");
    if (integration.provider !== "m365") throw new OnboardingError(400, "Discovery is only available for Microsoft 365.");
    return integration;
  };

  app.post<{ Params: { id: string } }>("/api/integrations/:id/discover", async (req) => {
    const integration = m365Integration(req.params.id);
    const discovery = (await deps.connectorFor(integration).discover!()) as M365Discovery;
    store.saveDiscovery(integration.id, discovery);
    store.audit({ orgId: integration.org_id, actor: deps.actor(req), action: "m365.discovered", target: integration.id });
    return discovery;
  });

  app.get<{ Params: { id: string } }>("/api/integrations/:id/discovery", async (req) => {
    const integration = m365Integration(req.params.id);
    const discovery = store.getDiscovery<M365Discovery>(integration.id);
    if (!discovery) throw new OnboardingError(404, "No discovery yet. Run it first.");
    return discovery;
  });

  app.post<{ Params: { id: string } }>("/api/orgs/:id/m365/apply-discovery", async (req) => {
    const parsed = z
      .object({ emailDomains: z.boolean().default(false), teamsTenantId: z.boolean().default(false), protectedAccounts: z.boolean().default(false) })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw new OnboardingError(400, z.prettifyError(parsed.error));
    const org = store.getOrg(req.params.id);
    if (!org) throw new OnboardingError(404, "Organization not found");
    const integration = store.listIntegrations(org.id).find((i) => i.provider === "m365");
    const discovery = integration ? store.getDiscovery<M365Discovery>(integration.id) : null;
    if (!discovery) throw new OnboardingError(404, "Run Microsoft 365 discovery first.");

    const merge = (current: string[], add: string[]) => [...new Set([...current, ...add.map((v) => v.toLowerCase())])];
    const pick = parsed.data;
    const settings = {
      ...(pick.emailDomains ? { emailDomains: merge(org.settings.emailDomains, discovery.suggestions.emailDomains) } : {}),
      ...(pick.teamsTenantId && discovery.suggestions.teamsTenantId ? { teamsTenantId: discovery.suggestions.teamsTenantId } : {}),
      ...(pick.protectedAccounts ? { protectedAccounts: merge(org.settings.protectedAccounts, discovery.suggestions.protectedAccounts) } : {}),
    };
    const updated = store.updateOrg(org.id, { settings } as never)!;
    store.audit({ orgId: org.id, actor: deps.actor(req), action: "m365.discovery_applied", target: org.id, detail: { applied: Object.keys(settings) } });
    return updated;
  });

}

export { OnboardingError };
