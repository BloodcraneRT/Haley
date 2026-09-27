import { createHash, createHmac } from "node:crypto";
import { ConnectorError, type Verifier, type VerificationResult } from "../types.js";

export interface DuoCredentials {
  integrationKey: string;
  secretKey: string;
  /** api-XXXXXXXX.duosecurity.com */
  apiHostname: string;
  /** How Haley's user emails map to Duo usernames: the full email, or the part before @. */
  usernameFormat?: "email" | "local";
}

type Json = Record<string, any>;

const sha512hex = (s: string) => createHash("sha512").update(s, "utf8").digest("hex");
/** Duo canonical encoding: everything but A-Za-z0-9_.~- is %XX with uppercase hex. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Signs a Duo Auth API request with the v5 scheme (HMAC-SHA512 over date, method, host, path, sorted
 * query, SHA-512 of the JSON body, and SHA-512 of the X-Duo-* headers, of which Haley sends none).
 */
export function signDuo(
  creds: Pick<DuoCredentials, "integrationKey" | "secretKey" | "apiHostname">,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>,
  date: string,
): { url: string; headers: Record<string, string>; body?: string } {
  const host = creds.apiHostname.toLowerCase();
  const isBody = method === "POST";
  const query = isBody
    ? ""
    : Object.keys(params)
        .sort()
        .map((k) => `${enc(k)}=${enc(params[k])}`)
        .join("&");
  const body = isBody ? JSON.stringify(params) : "";
  const canonical = [date, method, host, path, query, sha512hex(body), sha512hex("")].join("\n");
  const signature = createHmac("sha512", creds.secretKey).update(canonical, "utf8").digest("hex");
  return {
    url: `https://${host}${path}${query ? `?${query}` : ""}`,
    headers: {
      date,
      authorization: `Basic ${Buffer.from(`${creds.integrationKey}:${signature}`).toString("base64")}`,
      ...(isBody ? { "content-type": "application/json" } : {}),
    },
    body: isBody ? body : undefined,
  };
}

/** Duo Push through the Auth API v2 (https://duo.com/docs/authapi). */
export class DuoVerifier implements Verifier {
  readonly method = "Duo push";
  readonly kind = "push" as const;

  constructor(
    private readonly creds: DuoCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowMs: () => number = Date.now,
    /** Upper bound on waiting for the user; Duo itself times a push out after 60 seconds. */
    private readonly maxWaitMs = 90_000,
  ) {}

  async call(method: "GET" | "POST", path: string, params: Record<string, string> = {}): Promise<Json> {
    const req = signDuo(this.creds, method, path, params, new Date(this.nowMs()).toUTCString());
    const res = await this.fetchImpl(req.url, { method, headers: req.headers, body: req.body });
    const data = (await res.json().catch(() => ({}))) as Json;
    if (data.stat !== "OK") {
      throw new ConnectorError(`Duo ${path} failed: ${data.message ?? res.statusText}${data.message_detail ? ` (${data.message_detail})` : ""}`, Number(data.code) || res.status);
    }
    return data.response ?? {};
  }

  private username(email: string) {
    return this.creds.usernameFormat === "local" ? email.split("@")[0] : email;
  }

  async check(): Promise<string> {
    await this.call("GET", "/auth/v2/check");
    return `Connected to Duo (${this.creds.apiHostname}).`;
  }

  async verify(userEmail: string, context: { reason: string; ticketNumber: number | null }): Promise<VerificationResult> {
    const username = this.username(userEmail);
    const pre = await this.call("POST", "/auth/v2/preauth", { username });
    if (pre.result === "enroll") return { outcome: "unavailable", detail: "The user isn't enrolled in Duo." };
    if (pre.result === "deny") return { outcome: "unavailable", detail: `Duo won't authenticate this user: ${pre.status_msg ?? "denied by policy"}.` };
    // "allow" means the user bypasses 2FA, so a push proves nothing.
    if (pre.result === "allow") return { outcome: "unavailable", detail: "The user is in Duo bypass mode, so a push can't verify them." };
    const pushable = (pre.devices ?? []).filter((d: Json) => (d.capabilities ?? []).includes("push"));
    if (!pushable.length) return { outcome: "unavailable", detail: "No push-capable Duo device is enrolled." };

    const pushinfo = new URLSearchParams({ Request: context.reason, ...(context.ticketNumber ? { Ticket: `#${context.ticketNumber}` } : {}) }).toString();
    const { txid } = await this.call("POST", "/auth/v2/auth", {
      username,
      factor: "push",
      device: "auto",
      async: "1",
      type: "IT helpdesk verification",
      display_username: userEmail,
      pushinfo,
    });

    const deadline = this.nowMs() + this.maxWaitMs;
    while (this.nowMs() < deadline) {
      let status: Json;
      try {
        // Long-polls until the push's status changes.
        status = await this.call("GET", "/auth/v2/auth_status", { txid });
      } catch (err) {
        // 40002 can mean the long poll itself timed out; poll again.
        if (err instanceof ConnectorError && err.status === 40002) continue;
        throw err;
      }
      if (status.result === "allow") return { outcome: "approved", detail: `Approved in Duo Mobile (${pushable[0].display_name ?? "device"}).` };
      if (status.result === "deny") {
        if (status.status === "timeout") return { outcome: "timeout", detail: "The push wasn't answered in time." };
        if (status.status === "locked_out") return { outcome: "unavailable", detail: "The user is locked out in Duo." };
        return { outcome: "denied", detail: status.status === "fraud" ? "The user reported the push as fraud." : "The user denied the push." };
      }
    }
    return { outcome: "timeout", detail: "No answer to the push." };
  }
}
