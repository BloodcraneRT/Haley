import { z } from "zod";
import { readCapped, validatePublicHttpsUrl } from "../http.js";
import { ConnectorError, defineTool, type HaleyTool } from "../types.js";

/**
 * A generic REST API connection for long-tail SaaS. The MSP configures a base URL and one auth header;
 * Haley gets a read tool and, only when writes are enabled, a write tool and a separate delete tool.
 */

export interface RestConfig {
  /** Slug used in tool names: api_{name}_get. */
  name: string;
  baseUrl: URL;
  authHeader: string;
  authValue: string;
  allowedPaths: string[];
  allowWrites: boolean;
  description: string;
}

/** Most response text returned to the model. */
export const REST_MAX_RESULT = 20_000;
/** Most bytes read from a response. */
const REST_MAX_READ = 1_000_000;
const TIMEOUT_MS = 20_000;

const TOKEN_HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "cookie", "accept"]);

/** Checks and normalizes the stored integration config. Throws ConnectorError with a readable reason. */
export function parseRestConfig(config: Record<string, string>): RestConfig {
  const name = (config.name ?? "").trim();
  if (!/^[a-z][a-z0-9_]{0,19}$/.test(name)) {
    throw new ConnectorError("Name must be 1-20 characters of lowercase letters, digits and _ and start with a letter (it's used in tool names).");
  }
  const baseUrl = validatePublicHttpsUrl(config.baseUrl ?? "", "Base URL");
  const authHeader = (config.authHeader ?? "").trim() || "Authorization";
  if (!TOKEN_HEADER.test(authHeader) || FORBIDDEN_HEADERS.has(authHeader.toLowerCase())) {
    throw new ConnectorError(`"${authHeader}" can't be used as the auth header name.`);
  }
  const authValue = config.authValue ?? "";
  if (!authValue.trim()) throw new ConnectorError("Auth header value is required.");
  if (/[\r\n]/.test(authValue)) throw new ConnectorError("Auth header value can't contain line breaks.");
  const allowedPaths = (config.allowedPaths ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      checkPath(p);
      return p.replace(/\/+$/, "") || "/";
    });
  return {
    name,
    baseUrl,
    authHeader,
    authValue,
    allowedPaths,
    allowWrites: (config.allowWrites ?? "").trim().toLowerCase() === "true",
    description: (config.description ?? "").trim().slice(0, 500),
  };
}

/** A relative API path: starts with a single /, no .., no scheme, no backslashes, no query or fragment. */
export function checkPath(path: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new ConnectorError("Path has invalid percent-encoding.");
  }
  for (const p of [path, decoded]) {
    if (!p.startsWith("/")) throw new ConnectorError("Path must be relative to the API's base URL and start with /.");
    if (p.startsWith("//") || p.includes("//")) throw new ConnectorError("Path can't contain //.");
    if (p.includes("\\")) throw new ConnectorError("Path can't contain backslashes.");
    if (/(^|\/)\.\.?(\/|$)/.test(p)) throw new ConnectorError("Path can't contain . or .. segments.");
    if (/^[a-z][a-z0-9+.-]*:/i.test(p.slice(1)) || p.includes("://")) throw new ConnectorError("Path can't contain a URL scheme.");
    if (/[?#]/.test(p)) throw new ConnectorError("Put query parameters in `query`, not in the path.");
    if (/[\s\x00-\x1f\x7f]/.test(p)) throw new ConnectorError("Path can't contain spaces or control characters.");
  }
}

function allowed(config: RestConfig, path: string): boolean {
  if (!config.allowedPaths.length) return true;
  return config.allowedPaths.some((prefix) => prefix === "/" || path === prefix || path.startsWith(`${prefix}/`));
}

/** The full URL for a path under the base URL; refuses anything that would leave it. */
export function urlFor(config: RestConfig, path: string, query?: Record<string, string | number | boolean>): URL {
  checkPath(path);
  if (!allowed(config, path)) {
    throw new ConnectorError(`Path ${path} isn't allowed for this API. Allowed prefixes: ${config.allowedPaths.join(", ")}.`);
  }
  const basePath = config.baseUrl.pathname.replace(/\/+$/, "");
  const url = new URL(`${basePath}${path}`, config.baseUrl.origin);
  if (url.origin !== config.baseUrl.origin || !url.pathname.startsWith(basePath)) throw new ConnectorError("Path leaves the API's base URL.");
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  return url;
}

export class RestApi {
  constructor(
    readonly config: RestConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Removes the secret wherever an API echoes it back (headers dumps, debug output, error messages). */
  scrub(text: string): string {
    const secret = this.config.authValue;
    let out = text.split(secret).join("[redacted]");
    // Also the bare token when the value is "Bearer xyz" / "Basic xyz".
    const token = secret.replace(/^\s*(bearer|basic|token|apikey)\s+/i, "");
    if (token.length >= 8 && token !== secret) out = out.split(token).join("[redacted]");
    return out;
  }

  async call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: URL, body?: unknown) {
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          [this.config.authHeader]: this.config.authValue,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Credentials must never follow a redirect to another host.
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error && err.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000}s` : err instanceof Error ? err.message : String(err);
      throw new ConnectorError(this.scrub(`${this.config.name} API request failed: ${message}`));
    }
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      throw new ConnectorError(`${this.config.name} API answered with a redirect (${res.status}${res.headers.get("location") ? ` to ${this.scrub(res.headers.get("location")!)}` : ""}); Haley doesn't follow redirects. Check the base URL.`, res.status);
    }
    const { text, truncated: cut } = await readCapped(res, REST_MAX_READ);
    const contentType = res.headers.get("content-type") ?? "";
    let data: unknown = text;
    if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
      try {
        data = JSON.parse(text);
      } catch {
        // keep as text
      }
    }
    let rendered = this.scrub(typeof data === "string" ? data : JSON.stringify(data));
    const truncated = cut || rendered.length > REST_MAX_RESULT;
    if (rendered.length > REST_MAX_RESULT) rendered = rendered.slice(0, REST_MAX_RESULT);
    // Structured JSON when it survived intact; otherwise the (possibly cut) text.
    let result: unknown = rendered;
    if (!truncated && typeof data !== "string") {
      try {
        result = JSON.parse(rendered);
      } catch {
        result = rendered;
      }
    }
    return { status: res.status, ok: res.ok, contentType: contentType || null, truncated, body: result };
  }
}

const pathInput = z.string().min(1).max(2000);

export function restTools(api: RestApi): HaleyTool[] {
  const { name, description, allowedPaths, baseUrl } = api.config;
  const about = `${description ? `${description}. ` : ""}Base URL ${baseUrl.origin}${baseUrl.pathname.replace(/\/+$/, "")}${
    allowedPaths.length ? `; allowed path prefixes: ${allowedPaths.join(", ")}` : ""
  }. Authentication is added for you.`;
  const label = (path: string) => `${baseUrl.host}${baseUrl.pathname.replace(/\/+$/, "")}${path}`;

  const tools: HaleyTool[] = [
    defineTool({
      name: `api_${name}_get`,
      description: `Read from the client's "${name}" API with an HTTP GET. ${about} Responses over ${REST_MAX_RESULT / 1000} KB are truncated, so ask for narrow resources and use paging/filter query parameters.`,
      input: z.object({
        path: pathInput.describe("Path relative to the base URL, starting with /, e.g. /v1/users/123"),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query parameters"),
      }),
      risk: "read",
      run: async ({ path, query }) => api.call("GET", urlFor(api.config, path, query)),
    }),
  ];

  if (api.config.allowWrites) {
    tools.push(
      defineTool({
        name: `api_${name}_write`,
        description: `Change data in the client's "${name}" API with POST, PUT or PATCH and a JSON body. ${about} Read the current state with api_${name}_get first and make the smallest change that resolves the request.`,
        input: z.object({
          method: z.enum(["POST", "PUT", "PATCH"]),
          path: pathInput.describe("Path relative to the base URL, starting with /"),
          body: z.unknown().optional().describe("JSON request body"),
        }),
        risk: "write",
        describe: (i) => `${i.method} ${label(i.path)}${i.body === undefined ? "" : ` with ${JSON.stringify(i.body).slice(0, 200)}`}`,
        run: async ({ method, path, body }) => api.call(method, urlFor(api.config, path), body),
      }),
      defineTool({
        name: `api_${name}_delete`,
        description: `Delete something in the client's "${name}" API with HTTP DELETE. ${about} Only when the request clearly asks for the deletion; it usually can't be undone.`,
        input: z.object({ path: pathInput.describe("Path relative to the base URL, starting with /") }),
        risk: "destructive",
        describe: (i) => `DELETE ${label(i.path)}`,
        run: async ({ path }) => api.call("DELETE", urlFor(api.config, path)),
      }),
    );
  }
  return tools;
}
