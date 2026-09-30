import { isIP } from "node:net";
import { ConnectorError } from "./types.js";

/**
 * Shared helpers for connectors that call third-party HTTP APIs configured by the MSP
 * (NinjaOne, IT Glue, Hudu, generic REST APIs).
 */

/** Hostname suffixes that only ever name private or local machines. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".arpa", ".localdomain"];

/**
 * Validates an MSP-supplied base URL before Haley sends credentials to it: https only, no user:password@,
 * no IP literals (so no 10.x, 127.x, 169.254.x, [::1] …), no localhost or single-label/internal names.
 * The hostname string is checked as written; nothing is resolved, so a public name that resolves to a
 * private address (DNS rebinding) isn't caught here.
 */
export function validatePublicHttpsUrl(raw: string, label = "Base URL"): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConnectorError(`${label} isn't a valid URL.`);
  }
  if (url.protocol !== "https:") throw new ConnectorError(`${label} must use https://.`);
  if (url.username || url.password) throw new ConnectorError(`${label} can't contain a user name or password.`);
  if (url.search || url.hash) throw new ConnectorError(`${label} can't contain a query string or fragment.`);
  // WHATWG URL parsing already normalizes decimal/hex/octal IPv4 forms (e.g. 2130706433, 0x7f.1) to dotted quads.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) throw new ConnectorError(`${label} must use a public hostname, not an IP address.`);
  if (host === "localhost" || !host.includes(".") || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new ConnectorError(`${label} must use a public hostname (not localhost or an internal name).`);
  }
  return url;
}

/** Keys whose values are credentials; dropped from anything returned to the model. */
const SECRET_KEY = /pass(word|wd|phrase|code)|secret|api[-_ ]?key|token|credential|private[-_ ]?key|(^|[-_ .])(otp|totp|mfa[-_ ]?seed|pin)([-_ .]|$)/i;

export function isSecretKey(key: string): boolean {
  // camelCase forms such as otpSeed or userPin (but not "pinned" or "footprint").
  return SECRET_KEY.test(key) || /(^|[a-z])(Otp|Totp|Pin)([A-Z]|$)/.test(key) || /^(otp|totp|pin)[A-Z]/.test(key);
}

/**
 * Deep copy of an API response without credential-like fields. Also drops label/value pairs whose label
 * looks like a credential (Hudu asset fields, IT Glue flexible asset traits).
 */
export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(item && typeof item === "object" && typeof (item as Record<string, unknown>).label === "string" && isSecretKey(String((item as Record<string, unknown>).label))))
      .map((item) => stripSecrets(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) continue;
      out[k] = stripSecrets(v);
    }
    return out as T;
  }
  return value;
}

/** Rough HTML → text for documentation bodies, so the model reads prose rather than markup. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

/** Reads at most `maxBytes` of a response body as text. */
export async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    return text.length > maxBytes ? { text: text.slice(0, maxBytes), truncated: true } : { text, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return { text: truncated ? text.slice(0, maxBytes) : text, truncated };
}

/** Error text from a failed API call, without echoing large bodies. */
export async function apiError(res: Response, service: string): Promise<ConnectorError> {
  const { text } = await readCapped(res, 2000).catch(() => ({ text: "" }));
  let detail = text;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const errors = data.errors as Array<Record<string, unknown>> | undefined;
    detail = String(data.errorMessage ?? data.error_description ?? data.message ?? data.error ?? errors?.[0]?.detail ?? errors?.[0]?.title ?? text);
  } catch {
    // not JSON
  }
  return new ConnectorError(`${service} returned ${res.status}${detail ? `: ${clip(detail, 300)}` : ""}`, res.status);
}

/** Case-insensitive substring match on any of the given fields. */
export function matches(search: string | undefined, ...fields: Array<string | null | undefined>): boolean {
  if (!search?.trim()) return true;
  const needle = search.trim().toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(needle));
}
