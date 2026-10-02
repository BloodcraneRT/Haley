import { apiError } from "../http.js";
import { ConnectorError } from "../types.js";

/**
 * NinjaOne public API v2 client (OAuth2 client credentials).
 * Paths and schemas checked against the official OpenAPI spec at https://app.ninjarmm.com/apidocs/NinjaRMM-API-v2.json.
 */

/** NinjaOne instances. Each answers POST /ws/oauth/token (probed 2026-09). */
export const NINJA_REGIONS: Record<string, string> = {
  app: "app.ninjarmm.com",
  us: "app.ninjarmm.com",
  us2: "us2.ninjarmm.com",
  eu: "eu.ninjarmm.com",
  ca: "ca.ninjarmm.com",
  oc: "oc.ninjarmm.com",
};

/** Accepts a region key ("eu") or the instance hostname ("eu.ninjarmm.com"); only known instances. */
export function ninjaHost(region: string | undefined): string {
  const value = (region ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/.*$/, "") || "app";
  const host = NINJA_REGIONS[value] ?? Object.values(NINJA_REGIONS).find((h) => h === value);
  if (!host) throw new ConnectorError(`Unknown NinjaOne region "${region}". Use one of: ${Object.keys(NINJA_REGIONS).join(", ")}.`);
  return host;
}

/**
 * monitoring: read devices, alerts; management: run scripts and reboot (NinjaOne documents "running
 * scripts" under management). Haley doesn't ask for "control" (remote access sessions).
 */
export const NINJA_SCOPES = "monitoring management";

export interface NinjaConfig {
  host: string;
  clientId: string;
  clientSecret: string;
}

export interface NinjaDevice {
  id: number;
  organizationId: number;
  nodeClass?: string;
  displayName?: string;
  systemName?: string;
  dnsName?: string;
  offline?: boolean;
  lastContact?: number;
  lastUpdate?: number;
  assignedOwnerUid?: string;
  lastLoggedInUser?: string;
  os?: { name?: string; buildNumber?: string; releaseId?: string; lastBootTime?: number; needsReboot?: boolean; architecture?: string };
  system?: { manufacturer?: string; model?: string; serialNumber?: string; biosSerialNumber?: string; domain?: string };
  publicIP?: string;
  ipAddresses?: string[];
  [key: string]: unknown;
}

export class NinjaOneApi {
  private token: { value: string; expires: number } | null = null;

  constructor(
    private readonly config: NinjaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get host(): string {
    return this.config.host;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`https://${this.config.host}/ws/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        scope: NINJA_SCOPES,
      }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw await apiError(res, "NinjaOne sign-in");
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new ConnectorError("NinjaOne didn't return an access token.");
    this.token = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async request<T>(method: "GET" | "POST", path: string, query: Record<string, string | number | undefined> = {}, body?: unknown): Promise<T> {
    const url = new URL(`https://${this.config.host}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) this.token = null;
    if (!res.ok) throw await apiError(res, "NinjaOne");
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** GET /v2/organization/{id} */
  organization(orgId: number) {
    return this.request<{ id: number; name: string }>("GET", `/v2/organization/${orgId}`);
  }

  /** GET /v2/organization/{id}/devices, following the `after` cursor (last device id of the previous page). */
  async organizationDevices(orgId: number, max = 5000): Promise<NinjaDevice[]> {
    const pageSize = 1000;
    const all: NinjaDevice[] = [];
    let after: number | undefined;
    for (;;) {
      const page = await this.request<NinjaDevice[]>("GET", `/v2/organization/${orgId}/devices`, { pageSize, after });
      if (all.length + (page?.length ?? 0) > max) {
        throw new ConnectorError(`NinjaOne device collection is incomplete: more than ${max} devices. Use a numeric device id for an individual device.`);
      }
      all.push(...(page ?? []));
      if (!page || page.length < pageSize) break;
      after = page[page.length - 1].id;
    }
    // The path already scopes to the organization; checking again costs nothing.
    return all.filter((d) => d.organizationId === orgId);
  }

  /** GET /v2/organization/{id}/end-users */
  endUsers(orgId: number) {
    return this.request<Array<{ uid?: string; email?: string; organizationId?: number }>>("GET", `/v2/organization/${orgId}/end-users`);
  }

  /** GET /v2/device/{id} (detailed: os, system, lastLoggedInUser). */
  device(id: number) {
    return this.request<NinjaDevice>("GET", `/v2/device/${id}`);
  }
}
