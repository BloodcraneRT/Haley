import { ConnectorError, type Verifier, type VerificationResult } from "../types.js";

export interface OktaCredentials {
  /** acme.okta.com or a custom domain. */
  domain: string;
  apiToken: string;
}

type Json = Record<string, any>;

/** Okta Verify push through the Factors API (https://developer.okta.com/docs/api/openapi/okta-management/management/tag/UserFactor/). */
export class OktaVerifier implements Verifier {
  readonly method = "Okta Verify push";
  readonly kind = "push" as const;
  private readonly base: string;

  constructor(
    private readonly creds: OktaCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowMs: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly maxWaitMs = 90_000,
  ) {
    this.base = `https://${creds.domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  }

  private async call(method: string, pathOrUrl: string): Promise<{ status: number; data: Json }> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.base}${pathOrUrl}`;
    // Poll links come from Okta's response; only ever follow them on the client's own Okta domain.
    if (new URL(url).origin !== new URL(this.base).origin) throw new ConnectorError("Okta returned a link to a different host; refusing to follow it.");
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `SSWS ${this.creds.apiToken}`,
        accept: "application/json",
        "content-type": "application/json",
        // Okta requires a User-Agent to verify push factors.
        "user-agent": "Haley-Helpdesk/1.0",
      },
    });
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      if (res.status === 404) return { status: 404, data };
      throw new ConnectorError(`Okta ${method} ${new URL(url).pathname} failed (${res.status}): ${data.errorSummary ?? res.statusText}`, res.status);
    }
    return { status: res.status, data };
  }

  async check(): Promise<string> {
    const { status, data } = await this.call("GET", "/api/v1/users/me");
    if (status === 404) return `Connected to ${this.base}.`;
    return `Connected to ${this.base} as ${data.profile?.login ?? "the API token's admin"}.`;
  }

  async verify(userEmail: string): Promise<VerificationResult> {
    const user = await this.call("GET", `/api/v1/users/${encodeURIComponent(userEmail)}`);
    if (user.status === 404) return { outcome: "unavailable", detail: "No Okta user with that login." };
    if (user.data.status !== "ACTIVE") return { outcome: "unavailable", detail: `The Okta user is ${String(user.data.status).toLowerCase()}.` };
    const { data: factors } = await this.call("GET", `/api/v1/users/${user.data.id}/factors`);
    const push = (factors as unknown as Json[]).find((f) => f.factorType === "push" && f.provider === "OKTA" && f.status === "ACTIVE");
    if (!push) return { outcome: "unavailable", detail: "No active Okta Verify push factor is enrolled." };

    const started = await this.call("POST", `/api/v1/users/${user.data.id}/factors/${push.id}/verify`);
    let tx = started.data;
    const deadline = this.nowMs() + this.maxWaitMs;
    for (;;) {
      switch (tx.factorResult) {
        case "SUCCESS":
          return { outcome: "approved", detail: `Approved in Okta Verify (${push.profile?.name ?? "device"}).` };
        case "REJECTED":
          return { outcome: "denied", detail: "The user rejected the Okta Verify push." };
        case "TIMEOUT":
        case "EXPIRED":
          return { outcome: "timeout", detail: "The push wasn't answered in time." };
        case "WAITING":
          break;
        default:
          return { outcome: "unavailable", detail: `Okta returned ${tx.factorResult ?? "no result"}.` };
      }
      const poll = tx._links?.poll?.href;
      if (!poll || this.nowMs() > deadline) return { outcome: "timeout", detail: "No answer to the push." };
      await this.sleep(3000);
      tx = (await this.call("GET", poll)).data;
    }
  }
}
