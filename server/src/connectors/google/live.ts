import { createSign } from "node:crypto";
import { ConnectorError } from "../types.js";
import type { GoogleApi, GwsGroup, GwsOrgUnit, GwsUser, NewGwsUser } from "./api.js";

const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1";
const SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.group",
  "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
];

export interface GoogleCredentials {
  /** Full service-account key JSON (with client_email and private_key). */
  serviceAccountJson: string;
  /** Super-admin the service account impersonates via domain-wide delegation. */
  adminEmail: string;
}

type Json = Record<string, any>;
type Fetch = typeof fetch;

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** Google Admin SDK Directory API client using a service account with domain-wide delegation. */
export class LiveGoogleApi implements GoogleApi {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly key: { client_email: string; private_key: string; token_uri?: string };

  constructor(
    private readonly creds: GoogleCredentials,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    try {
      this.key = JSON.parse(creds.serviceAccountJson);
    } catch {
      throw new ConnectorError("Service account key is not valid JSON.");
    }
    if (!this.key.client_email || !this.key.private_key) {
      throw new ConnectorError("Service account key is missing client_email or private_key.");
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const tokenUri = this.key.token_uri ?? "https://oauth2.googleapis.com/token";
    const iat = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({
        iss: this.key.client_email,
        sub: this.creds.adminEmail,
        scope: SCOPES.join(" "),
        aud: tokenUri,
        iat,
        exp: iat + 3600,
      }),
    );
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(this.key.private_key).toString("base64url");
    const res = await this.fetchImpl(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${signature}`,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      throw new ConnectorError(`Google sign-in failed: ${body.error_description ?? body.error ?? res.statusText}`, res.status);
    }
    this.token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${DIRECTORY}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      throw new ConnectorError(`Google ${method} ${path.split("?")[0]} failed (${res.status}): ${data?.error?.message ?? res.statusText}`, res.status);
    }
    return data as T;
  }

  private async pages<T>(path: string, key: string, max = 500): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const page: Json = await this.call("GET", `${path}${pageToken ? `${sep}pageToken=${encodeURIComponent(pageToken)}` : ""}`);
      items.push(...((page[key] ?? []) as T[]));
      pageToken = page.nextPageToken;
    } while (pageToken && items.length < max);
    return items.slice(0, max);
  }

  private toUser(u: Json): GwsUser {
    return {
      id: u.id,
      primaryEmail: u.primaryEmail,
      name: u.name?.fullName ?? "",
      suspended: Boolean(u.suspended),
      isAdmin: Boolean(u.isAdmin),
      orgUnitPath: u.orgUnitPath ?? "/",
      isEnrolledIn2Sv: Boolean(u.isEnrolledIn2Sv),
      lastLoginTime: u.lastLoginTime && !u.lastLoginTime.startsWith("1970") ? u.lastLoginTime : null,
      aliases: u.aliases ?? [],
      recoveryPhone: u.recoveryPhone ?? null,
    };
  }

  async listUsers(query?: string) {
    const q = query ? `&query=${encodeURIComponent(query)}` : "";
    return (await this.pages<Json>(`/users?customer=my_customer&maxResults=200&orderBy=email${q}`, "users")).map((u) => this.toUser(u));
  }

  async getUser(email: string) {
    return this.toUser(await this.call("GET", `/users/${encodeURIComponent(email)}`));
  }

  async createUser(input: NewGwsUser) {
    const created = await this.call("POST", "/users", {
      primaryEmail: input.primaryEmail,
      name: { givenName: input.givenName, familyName: input.familyName },
      password: input.password,
      changePasswordAtNextLogin: true,
      orgUnitPath: input.orgUnitPath,
    });
    return this.toUser(created);
  }

  async resetPassword(email: string, password: string, changeAtNextLogin: boolean) {
    await this.call("PUT", `/users/${encodeURIComponent(email)}`, { password, changePasswordAtNextLogin: changeAtNextLogin });
  }

  async setSuspended(email: string, suspended: boolean) {
    await this.call("PUT", `/users/${encodeURIComponent(email)}`, { suspended });
  }

  async signOut(email: string) {
    await this.call("POST", `/users/${encodeURIComponent(email)}/signOut`);
  }

  async moveToOrgUnit(email: string, orgUnitPath: string) {
    await this.call("PUT", `/users/${encodeURIComponent(email)}`, { orgUnitPath });
  }

  async listGroups(userEmail?: string): Promise<GwsGroup[]> {
    const scope = userEmail ? `userKey=${encodeURIComponent(userEmail)}` : "customer=my_customer";
    const groups = await this.pages<Json>(`/groups?${scope}&maxResults=200`, "groups");
    return groups.map((g) => ({ id: g.id, email: g.email, name: g.name, directMembersCount: Number(g.directMembersCount ?? 0) }));
  }

  async addGroupMember(groupEmail: string, userEmail: string, role: "MEMBER" | "MANAGER" | "OWNER") {
    await this.call("POST", `/groups/${encodeURIComponent(groupEmail)}/members`, { email: userEmail, role });
  }

  async removeGroupMember(groupEmail: string, userEmail: string) {
    await this.call("DELETE", `/groups/${encodeURIComponent(groupEmail)}/members/${encodeURIComponent(userEmail)}`);
  }

  async listOrgUnits(): Promise<GwsOrgUnit[]> {
    const data: Json = await this.call("GET", "/customer/my_customer/orgunits?type=all");
    return (data.organizationUnits ?? []).map((o: Json) => ({ orgUnitPath: o.orgUnitPath, name: o.name, description: o.description ?? "" }));
  }
}
