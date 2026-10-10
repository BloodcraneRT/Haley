import { ConnectorError } from "../types.js";

/**
 * SentinelOne management API v2.1 client (API token auth). Every call is scoped to one site, the client's.
 * Paths and fields follow SentinelOne's API v2.1 documentation; see INTEGRATION_API_NOTES for what is unverified.
 */

type Json = Record<string, any>;

/** Only SentinelOne's own consoles: the API token is never sent anywhere else. */
export function sentinelOneBase(raw: string | undefined): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw ?? "") ? raw! : `https://${raw ?? ""}`);
  } catch {
    throw new ConnectorError(`"${raw}" isn't a SentinelOne console URL.`);
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(host.endsWith(".sentinelone.net") || host.endsWith(".s1gov.net"))) {
    throw new ConnectorError("Use your SentinelOne console URL, like https://usea1-partners.sentinelone.net.");
  }
  return `https://${host}/web/api/v2.1`;
}

export interface S1Config {
  consoleUrl: string;
  apiToken: string;
}

export interface S1Agent {
  id: string;
  computerName: string;
  siteId: string;
  osName?: string;
  machineType?: string;
  networkStatus?: string;
  isActive?: boolean;
  infected?: boolean;
  activeThreats?: number;
  lastActiveDate?: string;
  agentVersion?: string;
  lastLoggedInUserName?: string;
  [key: string]: unknown;
}

export interface S1Threat {
  id: string;
  threatInfo?: {
    threatName?: string;
    classification?: string;
    confidenceLevel?: string;
    mitigationStatus?: string;
    analystVerdict?: string;
    incidentStatus?: string;
    createdAt?: string;
    filePath?: string;
    sha1?: string;
    storyline?: string;
    detectionType?: string;
    initiatedBy?: string;
  };
  agentRealtimeInfo?: { agentId?: string; agentComputerName?: string; agentOsName?: string; siteId?: string };
  agentDetectionInfo?: { siteId?: string; agentLastLoggedInUserName?: string };
  [key: string]: unknown;
}

const MAX_PAGES = 20;
const PAGE = 100;

export class SentinelOneApi {
  readonly base: string;

  constructor(
    private readonly config: S1Config,
    private readonly siteId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = sentinelOneBase(config.consoleUrl);
    if (!/^\d+$/.test(siteId)) throw new ConnectorError("SentinelOne site ID must be a number.");
  }

  private async request<T = Json>(method: "GET" | "POST", path: string, query: Record<string, string | number | boolean | undefined> = {}, body?: unknown): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await this.fetchImpl(url, {
      method,
      headers: { authorization: `ApiToken ${this.config.apiToken}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const detail = Array.isArray(data.errors) ? data.errors.map((e: Json) => e.detail ?? e.title).filter(Boolean).join("; ") : res.statusText;
      const hint = res.status === 401 ? " Check the API token (they expire)." : res.status === 403 ? " The token's user needs access to this site." : "";
      throw new ConnectorError(`SentinelOne ${method} ${path} failed (${res.status}): ${detail || res.statusText}${hint}`, res.status);
    }
    return data as T;
  }

  /** Cursor paging (pagination.nextCursor), always within this site. */
  private async list<T>(path: string, query: Record<string, string | number | boolean | undefined>, max: number): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && items.length < max; page++) {
      const data = await this.request<Json>("GET", path, { ...query, siteIds: this.siteId, limit: Math.min(PAGE, max - items.length), cursor });
      items.push(...((data.data ?? []) as T[]));
      cursor = data.pagination?.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return items.slice(0, max);
  }

  async site(): Promise<{ id: string; name: string; activeLicenses?: number }> {
    const data = await this.request<Json>("GET", "/sites", { siteIds: this.siteId });
    const site = (data.data?.sites ?? [])[0];
    if (!site) throw new ConnectorError(`SentinelOne site ${this.siteId} wasn't found, or the token can't see it.`);
    return { id: String(site.id), name: String(site.name ?? ""), activeLicenses: site.activeLicenses };
  }

  agents(filter: { search?: string; infected?: boolean; ids?: string[] } = {}, max = 500): Promise<S1Agent[]> {
    return this.list<S1Agent>(
      "/agents",
      { computerName__contains: filter.search, infected: filter.infected, ids: filter.ids?.join(","), sortBy: "computerName" },
      max,
    );
  }

  /** One agent in this site by id or exact computer name; null when it isn't this client's. */
  async agent(idOrName: string): Promise<S1Agent | null> {
    const byId = /^\d+$/.test(idOrName) ? await this.agents({ ids: [idOrName] }, 1) : [];
    if (byId[0]) return byId[0];
    // Exact names only: a partial match could be another machine, and these tools can cut a device off the network.
    const found = await this.agents({ search: idOrName }, 50);
    return found.find((a) => a.computerName.toLowerCase() === idOrName.trim().toLowerCase()) ?? null;
  }

  threats(filter: { unresolvedOnly?: boolean; since?: string; ids?: string[] } = {}, max = 200): Promise<S1Threat[]> {
    return this.list<S1Threat>(
      "/threats",
      {
        resolved: filter.unresolvedOnly ? false : undefined,
        createdAt__gte: filter.since,
        ids: filter.ids?.join(","),
        sortBy: "createdAt",
        sortOrder: "desc",
      },
      max,
    );
  }

  /** A threat in this site, or null when it isn't this client's. */
  async threat(id: string): Promise<S1Threat | null> {
    if (!/^\d+$/.test(id)) return null;
    return (await this.threats({ ids: [id] }, 1))[0] ?? null;
  }

  /** Bulk actions take a filter; the site id is always in it, so nothing outside this client is touched. */
  private async act(path: string, filter: Json, data?: Json): Promise<number> {
    const res = await this.request<Json>("POST", path, {}, { filter: { ...filter, siteIds: [this.siteId] }, ...(data ? { data } : {}) });
    return Number(res.data?.affected ?? 0);
  }

  setIncidentStatus(threatId: string, incidentStatus: "resolved" | "in_progress" | "unresolved"): Promise<number> {
    return this.act("/threats/incident", { ids: [threatId] }, { incidentStatus });
  }

  setVerdict(threatId: string, analystVerdict: "true_positive" | "false_positive" | "suspicious" | "undefined"): Promise<number> {
    return this.act("/threats/analyst-verdict", { ids: [threatId] }, { analystVerdict });
  }

  mitigate(threatId: string, action: "kill" | "quarantine" | "remediate" | "rollback-remediation"): Promise<number> {
    return this.act(`/threats/mitigate/${action}`, { ids: [threatId] });
  }

  disconnect(agentId: string): Promise<number> {
    return this.act("/agents/actions/disconnect", { ids: [agentId] });
  }

  reconnect(agentId: string): Promise<number> {
    return this.act("/agents/actions/connect", { ids: [agentId] });
  }
}
