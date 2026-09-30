import { z } from "zod";
import { apiError, clip, htmlToText, matches, stripSecrets } from "../http.js";
import { ConnectorError, defineTool, type HaleyTool } from "../types.js";

/**
 * IT Glue documentation, read-only, scoped to one IT Glue organization.
 * API reference: https://api.itglue.com/developer/ (JSON:API, x-api-key header).
 * Haley never calls the passwords endpoints, and strips credential-like fields from everything it returns.
 */

export const ITGLUE_HOSTS: Record<string, string> = {
  us: "api.itglue.com",
  eu: "api.eu.itglue.com",
  au: "api.au.itglue.com",
};

export function itglueHost(region: string | undefined): string {
  const value = (region ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/.*$/, "") || "us";
  const host = ITGLUE_HOSTS[value] ?? Object.values(ITGLUE_HOSTS).find((h) => h === value);
  if (!host) throw new ConnectorError(`Unknown IT Glue region "${region}". Use us, eu or au.`);
  return host;
}

interface Resource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}

export class ItGlueApi {
  constructor(
    private readonly config: { host: string; apiKey: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get<T = { data: Resource | Resource[] }>(path: string, query: Record<string, string> = {}): Promise<T> {
    // Defense in depth: this client only ever reads, and never touches credentials.
    if (/password/i.test(path)) throw new ConnectorError("Haley doesn't read IT Glue passwords.");
    const url = new URL(`https://${this.config.host}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { "x-api-key": this.config.apiKey, accept: "application/vnd.api+json" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw await apiError(res, "IT Glue");
    return (await res.json()) as T;
  }
}

const id = z.string().regex(/^\d+$/, "a numeric IT Glue id").describe("Document id from itglue_search_documents, e.g. \"1234\"");

export function itGlueTools(api: ItGlueApi, orgId: string): HaleyTool[] {
  const base = `/organizations/${orgId}/relationships`;
  const own = (r: Resource) => String(r.attributes["organization-id"]) === orgId;

  const list = async (kind: string, query: Record<string, string> = {}): Promise<Resource[]> => {
    const { data } = await api.get<{ data: Resource[] }>(`${base}/${kind}`, { "page[size]": "1000", ...query });
    return (data ?? []).filter(own);
  };

  return [
    defineTool({
      name: "itglue_search_documents",
      description:
        "Search this client's IT Glue documents (runbooks, how-tos, network and vendor notes) by name. Check it before troubleshooting something client-specific, then read the right one with itglue_get_document.",
      input: z.object({ search: z.string().optional().describe("Words from the document name, e.g. 'VPN' or 'printer'") }),
      risk: "read",
      run: async ({ search }) => {
        // filter[document_folder_id]=null returns documents in every folder, not only the root.
        const docs = (await list("documents", { "filter[document_folder_id]": "null" })).filter((d) => !d.attributes.archived);
        const words = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const hits = docs.filter((d) => words.every((w) => matches(w, String(d.attributes.name ?? ""))));
        return {
          count: hits.length,
          documents: hits.slice(0, 50).map((d) => ({
            id: d.id,
            name: d.attributes.name,
            updated: d.attributes["updated-at"],
            folderId: d.attributes["document-folder-id"] ?? null,
            url: d.attributes["resource-url"],
          })),
        };
      },
    }),
    defineTool({
      name: "itglue_get_document",
      description: "Read one of this client's IT Glue documents: its headings, text and steps as plain text. Use the id from itglue_search_documents.",
      input: z.object({ id }),
      risk: "read",
      run: async ({ id: docId }) => {
        const { data } = await api.get<{ data: Resource }>(`${base}/documents/${docId}`);
        if (!data || !own(data)) throw new ConnectorError(`Document ${docId} isn't in this client's IT Glue organization.`);
        const sections = (data.attributes.sections as Array<{ attributes?: Record<string, unknown> }> | undefined) ?? [];
        const text = sections.length
          ? sections
              .map((s) => s.attributes ?? {})
              .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
              .map((a) => {
                const body = htmlToText(String(a.content ?? a["rendered-content"] ?? ""));
                if (a["resource-type"] === "Document::Heading") return `${"#".repeat(Math.min(Number(a.level ?? 1), 6))} ${body}`;
                if (a["resource-type"] === "Document::Step") return `Step: ${body}`;
                return body;
              })
              .filter(Boolean)
              .join("\n\n")
          : htmlToText(String(data.attributes.content ?? ""));
        return stripSecrets({
          id: data.id,
          name: data.attributes.name,
          updated: data.attributes["updated-at"],
          url: data.attributes["resource-url"],
          content: clip(text, 15_000),
        });
      },
    }),
    defineTool({
      name: "itglue_list_configurations",
      description:
        "List this client's IT Glue configurations (documented devices: servers, workstations, firewalls, switches, printers) with type, IP, serial, OS, model and warranty. Optional search matches name, hostname, IP or serial.",
      input: z.object({
        search: z.string().optional(),
        includeArchived: z.boolean().default(false),
      }),
      risk: "read",
      run: async ({ search, includeArchived }) => {
        const configs = (await list("configurations", includeArchived ? {} : { "filter[archived]": "false" })).filter((c) =>
          matches(search, ...["name", "hostname", "primary-ip", "serial-number", "asset-tag"].map((k) => (c.attributes[k] == null ? null : String(c.attributes[k])))),
        );
        const keep = [
          "name", "hostname", "configuration-type-name", "configuration-status-name", "primary-ip", "mac-address", "serial-number", "asset-tag",
          "manufacturer-name", "model-name", "operating-system-name", "location-name", "warranty-expires-at", "installed-at", "notes", "archived", "resource-url",
        ];
        return stripSecrets({
          count: configs.length,
          configurations: configs.slice(0, 100).map((c) => ({
            id: c.id,
            ...Object.fromEntries(keep.filter((k) => c.attributes[k] != null).map((k) => [k, k === "notes" ? clip(htmlToText(String(c.attributes[k])), 500) : c.attributes[k]])),
          })),
        });
      },
    }),
  ];
}
