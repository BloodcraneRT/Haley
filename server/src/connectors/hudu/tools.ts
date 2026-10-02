import { z } from "zod";
import { apiError, clip, htmlToText, stripSecrets, validatePublicHttpsUrl } from "../http.js";
import { ConnectorError, defineTool, type HaleyTool } from "../types.js";

/**
 * Hudu documentation, read-only, scoped to one Hudu company.
 * REST API v1 at {instance}/api/v1 with an x-api-key header (reference: each instance's /developer page).
 * Haley never calls /asset_passwords and strips credential-like fields (including asset fields labelled
 * like passwords) from everything it returns.
 */

/** https://docs.example.com, https://docs.example.com/ or https://docs.example.com/api/v1 → https://docs.example.com */
export function huduBase(raw: string): string {
  const url = validatePublicHttpsUrl(raw, "Hudu URL");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  return `${url.origin}${path}`;
}

export class HuduApi {
  constructor(
    private readonly config: { baseUrl: string; apiKey: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    if (/password/i.test(path)) throw new ConnectorError("Haley doesn't read Hudu passwords.");
    const url = new URL(`${this.config.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { "x-api-key": this.config.apiKey, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw await apiError(res, "Hudu");
    return (await res.json()) as T;
  }

  /** Hudu's documented default pagination is 25 items, with numbered pages. */
  async list<T>(path: string, key: string, query: Record<string, string | number | undefined>): Promise<T[]> {
    const all: T[] = [];
    const max = 5000;
    for (let page = 1; ; page++) {
      const response = await this.get<Record<string, T[]>>(path, { ...query, page });
      const items = response[key] ?? [];
      if (all.length + items.length > max) {
        throw new ConnectorError(`Hudu ${key} collection is incomplete: more than ${max} results. Narrow the search.`);
      }
      all.push(...items);
      if (items.length < 25) return all;
    }
  }
}

interface HuduArticle {
  id: number;
  name?: string;
  content?: string;
  company_id?: number | null;
  url?: string;
  draft?: boolean;
  updated_at?: string;
}

interface HuduAsset {
  id: number;
  name?: string;
  company_id?: number | null;
  asset_type?: string;
  primary_serial?: string;
  primary_model?: string;
  primary_manufacturer?: string;
  primary_mail?: string;
  archived?: boolean;
  url?: string;
  updated_at?: string;
  fields?: Array<{ label?: string; value?: unknown }>;
}

export function huduTools(api: HuduApi, companyId: number): HaleyTool[] {
  const own = (item: { company_id?: number | null }) => Number(item.company_id) === companyId;

  return [
    defineTool({
      name: "hudu_search_articles",
      description:
        "Search this client's Hudu knowledge base articles (runbooks, how-tos, vendor and network notes). Check it before troubleshooting something client-specific, then read the right one with hudu_get_article. At most 50 matches are shown; narrow the search when truncated is true.",
      input: z.object({ search: z.string().optional().describe("Words to search for, e.g. 'VPN' or 'printer'") }),
      risk: "read",
      run: async ({ search }) => {
        const articles = await api.list<HuduArticle>("/articles", "articles", { company_id: companyId, search: search?.trim() });
        const mine = articles.filter((a) => own(a) && !a.draft);
        return {
          count: mine.length,
          truncated: mine.length > 50,
          articles: mine.slice(0, 50).map((a) => ({ id: a.id, name: a.name, updated: a.updated_at, url: a.url, preview: clip(htmlToText(a.content), 200) })),
        };
      },
    }),
    defineTool({
      name: "hudu_get_article",
      description: "Read one of this client's Hudu knowledge base articles as plain text. Use the id from hudu_search_articles.",
      input: z.object({ id: z.number().int().positive() }),
      risk: "read",
      run: async ({ id }) => {
        const { article } = await api.get<{ article?: HuduArticle }>(`/articles/${id}`);
        if (!article || !own(article)) throw new ConnectorError(`Article ${id} isn't one of this client's Hudu articles.`);
        return stripSecrets({ id: article.id, name: article.name, updated: article.updated_at, url: article.url, content: clip(htmlToText(article.content), 15_000) });
      },
    }),
    defineTool({
      name: "hudu_search_assets",
      description:
        "Search this client's Hudu assets (computers, network gear, printers, contacts, applications, and other documented items) with their fields. Passwords are never included. At most 50 matches are shown; narrow the search when truncated is true.",
      input: z.object({
        search: z.string().optional().describe("Name or other text to search for"),
        includeArchived: z.boolean().default(false),
      }),
      risk: "read",
      run: async ({ search, includeArchived }) => {
        const assets = await api.list<HuduAsset>("/assets", "assets", {
          company_id: companyId,
          search: search?.trim(),
          archived: includeArchived ? undefined : "false",
        });
        const mine = assets.filter((a) => own(a) && (includeArchived || !a.archived));
        return stripSecrets({
          count: mine.length,
          truncated: mine.length > 50,
          assets: mine.slice(0, 50).map((a) => ({
            id: a.id,
            name: a.name,
            type: a.asset_type,
            manufacturer: a.primary_manufacturer,
            model: a.primary_model,
            serial: a.primary_serial,
            email: a.primary_mail,
            archived: a.archived ?? false,
            url: a.url,
            fields: (a.fields ?? [])
              .filter((f) => f.value !== null && f.value !== undefined && f.value !== "")
              .map((f) => ({ label: f.label, value: typeof f.value === "string" ? clip(htmlToText(f.value), 500) : f.value })),
          })),
        });
      },
    }),
  ];
}
