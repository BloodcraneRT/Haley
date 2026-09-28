import { createPublicKey, createVerify, type JsonWebKey } from "node:crypto";
import type { Connector } from "../connectors/types.js";
import type { Store } from "../store.js";
import type { Org, Ticket } from "../types.js";
import type { ChannelAdapter, DeliveryResult, InboundMessage } from "./types.js";

type Json = Record<string, any>;

const OPENID_CONFIG = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const ISSUER = "https://api.botframework.com";
const CLOCK_SKEW_S = 300;

export interface TeamsConfig {
  appId: string;
  appPassword: string;
  /** Tenant for single-tenant bot registrations; empty for multi-tenant. */
  tenantId: string;
}

const b64json = (part: string): Json => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/**
 * Microsoft Teams through an Azure Bot registration. Inbound activities carry a Bot Framework JWT that is
 * verified here; the sender's Entra object id is resolved through the org's Microsoft 365 integration.
 */
export class TeamsChannel implements ChannelAdapter {
  readonly channel = "teams" as const;
  readonly supportsPrivate = true;
  private keys: { fetchedAt: number; keys: Array<JsonWebKey & { kid?: string; endorsements?: string[] }> } | null = null;
  private botToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: TeamsConfig,
    private readonly store: Store,
    private readonly connectorsFor: (orgId: string) => Connector[],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowMs: () => number = Date.now,
  ) {}

  private async signingKeys(force = false) {
    if (!force && this.keys && this.nowMs() - this.keys.fetchedAt < 12 * 3_600_000) return this.keys.keys;
    const config = (await (await this.fetchImpl(OPENID_CONFIG)).json()) as Json;
    const jwks = (await (await this.fetchImpl(config.jwks_uri)).json()) as Json;
    this.keys = { fetchedAt: this.nowMs(), keys: jwks.keys ?? [] };
    return this.keys.keys;
  }

  /** Throws unless the request carries a valid Bot Framework token for this bot and this activity. */
  async verify(authorization: string | undefined, activity: Json): Promise<void> {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) throw new Error("Missing bearer token");
    const header = b64json(h);
    const claims = b64json(p);
    if (header.alg !== "RS256") throw new Error("Unexpected token algorithm");

    let key = (await this.signingKeys()).find((k) => k.kid === header.kid);
    if (!key) key = (await this.signingKeys(true)).find((k) => k.kid === header.kid);
    if (!key) throw new Error("Unknown signing key");
    if (key.endorsements && activity.channelId && !key.endorsements.includes(activity.channelId)) {
      throw new Error("Signing key not endorsed for this channel");
    }
    const { kid: _kid, endorsements: _e, ...jwk } = key;
    const valid = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url"));
    if (!valid) throw new Error("Bad token signature");

    const now = this.nowMs() / 1000;
    if (claims.iss !== ISSUER) throw new Error("Wrong issuer");
    if (claims.aud !== this.config.appId) throw new Error("Token is for a different bot");
    if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_S) throw new Error("Token expired");
    if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_S) throw new Error("Token not yet valid");
    // Replies go to activity.serviceUrl, so it must be the one Microsoft vouched for.
    if (claims.serviceurl && claims.serviceurl !== activity.serviceUrl) throw new Error("serviceUrl mismatch");
  }

  private orgForTenant(tenantId: string): Org | null {
    for (const org of this.store.listOrgs()) {
      if (org.settings.teamsTenantId && org.settings.teamsTenantId === tenantId) return org;
    }
    for (const integration of this.store.listIntegrations()) {
      if (integration.provider !== "m365" || integration.mode !== "live") continue;
      if (this.store.getIntegrationConfig(integration.id).tenantId === tenantId) return this.store.getOrg(integration.org_id);
    }
    return null;
  }

  /** Looks the sender up in the org's Microsoft 365 directory to get their sign-in name. */
  private async resolveUser(org: Org, aadObjectId: string): Promise<string | null> {
    const getUser = this.connectorsFor(org.id)
      .flatMap((c) => c.tools)
      .find((t) => t.name === "m365_get_user");
    if (!getUser || !aadObjectId) return null;
    try {
      const user = (await getUser.run({ user: aadObjectId }, { orgId: org.id, runId: "", ticketId: null })) as Json;
      return user.accountEnabled === false ? null : (user.userPrincipalName as string).toLowerCase();
    } catch {
      return null;
    }
  }

  async toInbound(activity: Json): Promise<InboundMessage | null> {
    if (activity.type !== "message" || !activity.text) return null;
    const tenantId = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id;
    const org = tenantId ? this.orgForTenant(tenantId) : null;
    if (!org) return null;
    const email = await this.resolveUser(org, activity.from?.aadObjectId ?? "");
    const personal = activity.conversation?.conversationType === "personal";
    const text = String(activity.text)
      .replace(/<at>[^<]*<\/at>/g, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    return {
      channel: "teams",
      org,
      sender: {
        name: activity.from?.name ?? "Teams user",
        email,
        assurance: email ? "directory" : "none",
        verification: email
          ? "Microsoft Teams (Entra ID sign-in)"
          : "Microsoft Teams user who couldn't be matched to an active directory account",
      },
      text,
      thread: { key: "conversationId", value: activity.conversation.id },
      ref: {
        serviceUrl: activity.serviceUrl,
        conversationId: activity.conversation.id,
        tenantId,
        private: personal ? "1" : "0",
      },
    };
  }

  private async accessToken(): Promise<string> {
    if (this.botToken && this.botToken.expiresAt > this.nowMs() + 60_000) return this.botToken.value;
    const tenant = this.config.tenantId || "botframework.com";
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.appId,
        client_secret: this.config.appPassword,
        scope: "https://api.botframework.com/.default",
      }),
    });
    const body = (await res.json()) as Json;
    if (!res.ok) throw new Error(`Bot sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
    this.botToken = { value: body.access_token, expiresAt: this.nowMs() + Number(body.expires_in ?? 3600) * 1000 };
    return this.botToken.value;
  }

  async send(ticket: Ticket, text: string): Promise<DeliveryResult> {
    const { serviceUrl, conversationId } = ticket.channel_ref;
    if (!serviceUrl || !conversationId) return { delivered: false, detail: "No Teams conversation on this ticket." };
    const res = await this.fetchImpl(`${serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", text, textFormat: "markdown" }),
    });
    if (!res.ok) throw new Error(`Teams returned ${res.status}`);
    return { delivered: true, detail: ticket.channel_ref.private === "1" ? "Teams chat" : "Teams channel" };
  }
}
