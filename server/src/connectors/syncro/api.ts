import { apiError } from "../http.js";
import { ConnectorError } from "../types.js";

/**
 * SyncroMSP REST API v1 client for RMM data (assets, alerts, patches, scripts).
 * Paths and schemas checked against https://api-docs.syncromsp.com/swagger.json (2026-10).
 * 180 requests per minute per IP; most lists return 25 per page with meta.total_pages.
 */

type Json = Record<string, any>;

/** "yourmsp", "yourmsp.syncromsp.com" or "https://yourmsp.syncromsp.com/…" → "yourmsp". */
export function syncroSubdomain(raw: string | undefined): string {
  const sub = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\.syncromsp\.com(\/.*)?$/, "");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(sub)) throw new ConnectorError(`"${raw}" isn't a SyncroMSP subdomain. Use the first part of yourmsp.syncromsp.com.`);
  return sub;
}

export interface SyncroRmmConfig {
  subdomain: string;
  apiKey: string;
}

export interface SyncroAsset {
  id: number;
  name: string;
  customer_id: number;
  contact_id?: number | null;
  asset_type?: string | null;
  asset_serial?: string | null;
  properties?: Json | null;
  rmm_store?: { triggers?: Record<string, string | boolean>; windows_updates?: Json; general?: Json; updated_at?: string } | null;
  updated_at?: string;
  [key: string]: unknown;
}

export interface SyncroAlert {
  id: number;
  customer_id: number;
  asset_id?: number | null;
  computer_name?: string | null;
  description?: string | null;
  formatted_output?: string | null;
  status?: string | null;
  resolved?: boolean;
  ticket_number?: string | number | null;
  created_at: string;
  updated_at?: string;
}

/** More pages than this means the collection is too big to read whole; callers must narrow the query. */
const MAX_PAGES = 40;

export class SyncroRmmApi {
  readonly base: string;

  constructor(
    private readonly config: SyncroRmmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `https://${syncroSubdomain(config.subdomain)}.syncromsp.com/api/v1`;
  }

  async request<T = Json>(method: "GET" | "POST" | "DELETE", path: string, query: Record<string, string | number | undefined> = {}, body?: unknown): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Never send the token on to wherever a redirect points.
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) throw new ConnectorError("SyncroMSP rate limit reached (180 requests per minute). Try again in a minute.", 429);
    if (res.status >= 300 && res.status < 400) throw new ConnectorError(`SyncroMSP answered with a redirect (${res.status}); check the subdomain.`, res.status);
    if (!res.ok) throw await apiError(res, "SyncroMSP");
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Every page of a list, or an error when it's larger than MAX_PAGES (never a silent partial list). */
  async all<T>(path: string, key: string, query: Record<string, string | number | undefined> = {}): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const data = await this.request<Json>("GET", path, { ...query, page });
      items.push(...((data[key] ?? []) as T[]));
      const total = Number(data.meta?.total_pages ?? 1);
      if (page >= total) return items;
      if (page >= MAX_PAGES) throw new ConnectorError(`SyncroMSP ${key} list is incomplete: more than ${MAX_PAGES} pages. Narrow the search.`);
    }
  }

  asset(id: number) {
    return this.request<{ asset: SyncroAsset }>("GET", `/customer_assets/${id}`).then((d) => d.asset);
  }

  customerAssets(customerId: number, query?: string) {
    return this.all<SyncroAsset>("/customer_assets", "assets", { customer_id: customerId, query });
  }

  contacts(customerId: number) {
    return this.all<{ id: number; name?: string; email?: string | null; customer_id: number }>("/contacts", "contacts", { customer_id: customerId });
  }

  /** Active (unresolved) alerts across the account, optionally only those created after a time. */
  activeAlerts(createdAfter?: string) {
    return this.all<SyncroAlert>("/rmm_alerts", "rmm_alerts", { status: "active", created_after: createdAfter });
  }

  alert(id: number) {
    return this.request<{ rmm_alert: SyncroAlert }>("GET", `/rmm_alerts/${id}`).then((d) => d.rmm_alert);
  }
}
