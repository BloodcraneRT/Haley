import { ConnectorError } from "../types.js";
import type {
  M365Api,
  M365AuthMethod,
  M365BitLockerKey,
  M365DetectedApp,
  M365Device,
  M365DeviceAction,
  M365Group,
  M365Remediation,
  M365RoleHolder,
  M365Sku,
  M365User,
  NewM365User,
} from "./api.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
/** Intune remediations (device health scripts) are only in the beta endpoint. */
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const DEVICE_SELECT =
  "id,deviceName,operatingSystem,osVersion,complianceState,lastSyncDateTime,userPrincipalName,manufacturer,model,serialNumber,azureADDeviceId,isEncrypted,freeStorageSpaceInBytes,totalStorageSpaceInBytes";
/** Entra roles whose holders should be protected accounts by default. */
export const PRIVILEGED_ROLES = [
  "Global Administrator",
  "Privileged Role Administrator",
  "Privileged Authentication Administrator",
  "Security Administrator",
  "User Administrator",
  "Exchange Administrator",
  "SharePoint Administrator",
  "Intune Administrator",
  "Authentication Administrator",
  "Helpdesk Administrator",
  "Billing Administrator",
  "Conditional Access Administrator",
];
const USER_SELECT = "id,displayName,userPrincipalName,mail,accountEnabled,jobTitle,department,usageLocation,assignedLicenses";

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

type Json = Record<string, any>;
type Fetch = typeof fetch;

const odataString = (value: string) => value.replace(/'/g, "''");

/** Microsoft Graph client using the OAuth2 client-credentials flow (app-only permissions). */
export class GraphM365Api implements M365Api {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly creds: GraphCredentials,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(this.creds.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      throw new ConnectorError(`Microsoft sign-in failed: ${body.error_description ?? body.error ?? res.statusText}`, res.status);
    }
    this.token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call<T = Json>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(path.startsWith("http") ? path : `${GRAPH}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const message = data?.error?.message ?? res.statusText;
      throw new ConnectorError(`Graph ${method} ${path.split("?")[0]} failed (${res.status}): ${message}`, res.status);
    }
    return data as T;
  }

  private async list<T = Json>(path: string, max = 200): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    while (next && items.length < max) {
      const page: Json = await this.call("GET", next);
      items.push(...((page.value ?? []) as T[]));
      next = page["@odata.nextLink"];
    }
    return items.slice(0, max);
  }

  private toUser(u: Json): M365User {
    return {
      id: u.id,
      displayName: u.displayName ?? "",
      userPrincipalName: u.userPrincipalName ?? "",
      mail: u.mail ?? null,
      accountEnabled: Boolean(u.accountEnabled),
      jobTitle: u.jobTitle ?? null,
      department: u.department ?? null,
      usageLocation: u.usageLocation ?? null,
      licenses: (u.assignedLicenses ?? []).map((l: Json) => l.skuId),
    };
  }

  private toGroup(g: Json): M365Group {
    const kind = (g.groupTypes ?? []).includes("Unified") ? "microsoft365" : g.securityEnabled ? "security" : "distribution";
    return { id: g.id, displayName: g.displayName ?? "", mail: g.mail ?? null, kind, roleAssignable: Boolean(g.isAssignableToRole) };
  }

  async organization() {
    const org = (await this.list<Json>("/organization"))[0] ?? {};
    return {
      id: org.id ?? this.creds.tenantId,
      displayName: org.displayName ?? "",
      verifiedDomains: (org.verifiedDomains ?? []).map((d: Json) => d.name),
    };
  }

  async listUsers(search?: string) {
    let path = `/users?$select=${USER_SELECT}&$top=100`;
    if (search) {
      const s = odataString(search);
      path += `&$filter=${encodeURIComponent(
        `startswith(displayName,'${s}') or startswith(userPrincipalName,'${s}') or startswith(mail,'${s}') or startswith(surname,'${s}')`,
      )}`;
    }
    return (await this.list<Json>(path, search ? 50 : 500)).map((u) => this.toUser(u));
  }

  async getUser(idOrUpn: string) {
    return this.toUser(await this.call("GET", `/users/${encodeURIComponent(idOrUpn)}?$select=${USER_SELECT}`));
  }

  async getUserGroups(id: string) {
    const items = await this.list<Json>(`/users/${encodeURIComponent(id)}/memberOf/microsoft.graph.group?$select=id,displayName,mail,groupTypes,securityEnabled,isAssignableToRole`);
    return items.map((g) => this.toGroup(g));
  }

  async createUser(input: NewM365User) {
    const created = await this.call("POST", "/users", {
      accountEnabled: true,
      displayName: input.displayName,
      mailNickname: input.mailNickname,
      userPrincipalName: input.userPrincipalName,
      usageLocation: input.usageLocation,
      jobTitle: input.jobTitle,
      department: input.department,
      passwordProfile: { password: input.password, forceChangePasswordNextSignIn: true },
    });
    return this.toUser(created);
  }

  async setAccountEnabled(id: string, enabled: boolean) {
    await this.call("PATCH", `/users/${encodeURIComponent(id)}`, { accountEnabled: enabled });
  }

  async resetPassword(id: string, password: string, forceChange: boolean) {
    await this.call("PATCH", `/users/${encodeURIComponent(id)}`, {
      passwordProfile: { password, forceChangePasswordNextSignIn: forceChange },
    });
  }

  async revokeSessions(id: string) {
    await this.call("POST", `/users/${encodeURIComponent(id)}/revokeSignInSessions`);
  }

  async listSkus(): Promise<M365Sku[]> {
    const skus = await this.list<Json>("/subscribedSkus");
    return skus.map((s) => ({
      skuId: s.skuId,
      skuPartNumber: s.skuPartNumber,
      enabled: Number(s.prepaidUnits?.enabled ?? 0),
      consumed: Number(s.consumedUnits ?? 0),
    }));
  }

  async assignLicense(userId: string, skuId: string) {
    await this.call("POST", `/users/${encodeURIComponent(userId)}/assignLicense`, {
      addLicenses: [{ skuId, disabledPlans: [] }],
      removeLicenses: [],
    });
  }

  async removeLicense(userId: string, skuId: string) {
    await this.call("POST", `/users/${encodeURIComponent(userId)}/assignLicense`, { addLicenses: [], removeLicenses: [skuId] });
  }

  async listGroups(search?: string) {
    let path = "/groups?$select=id,displayName,mail,groupTypes,securityEnabled,isAssignableToRole&$top=100";
    if (search) path += `&$filter=${encodeURIComponent(`startswith(displayName,'${odataString(search)}')`)}`;
    return (await this.list<Json>(path, 200)).map((g) => this.toGroup(g));
  }

  async addGroupMember(groupId: string, userId: string) {
    await this.call("POST", `/groups/${encodeURIComponent(groupId)}/members/$ref`, {
      "@odata.id": `${GRAPH}/directoryObjects/${userId}`,
    });
  }

  async removeGroupMember(groupId: string, userId: string) {
    await this.call("DELETE", `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`);
  }

  async listAuthMethods(userId: string): Promise<M365AuthMethod[]> {
    const methods = await this.list<Json>(`/users/${encodeURIComponent(userId)}/authentication/methods`);
    return methods.map((m) => {
      let type = String(m["@odata.type"] ?? "").replace("#microsoft.graph.", "").replace("AuthenticationMethod", "");
      // Keep the phone type: only "mobile" numbers can receive text messages.
      if (type === "phone" && m.phoneType) type = `phone:${m.phoneType}`;
      const detail = m.phoneNumber ?? m.displayName ?? m.emailAddress ?? m.deviceTag ?? "";
      return { type, detail: String(detail) };
    });
  }

  private toDevice(d: Json): M365Device {
    return {
      id: d.id,
      deviceName: d.deviceName ?? "",
      operatingSystem: d.operatingSystem ?? "",
      osVersion: d.osVersion ?? "",
      complianceState: d.complianceState ?? "unknown",
      lastSyncDateTime: d.lastSyncDateTime ?? "",
      userPrincipalName: (d.userPrincipalName ?? "").toLowerCase(),
      manufacturer: d.manufacturer ?? undefined,
      model: d.model ?? undefined,
      serialNumber: d.serialNumber ?? undefined,
      azureADDeviceId: d.azureADDeviceId ?? undefined,
      isEncrypted: d.isEncrypted ?? undefined,
      freeStorageSpaceInBytes: d.freeStorageSpaceInBytes ?? undefined,
      totalStorageSpaceInBytes: d.totalStorageSpaceInBytes ?? undefined,
    };
  }

  async listDevices(userPrincipalName?: string): Promise<M365Device[]> {
    let path = `/deviceManagement/managedDevices?$select=${DEVICE_SELECT}`;
    if (userPrincipalName) path += `&$filter=${encodeURIComponent(`userPrincipalName eq '${odataString(userPrincipalName)}'`)}`;
    return (await this.list<Json>(path, 500)).map((d) => this.toDevice(d));
  }

  async getDevice(deviceId: string) {
    return this.toDevice(await this.call("GET", `/deviceManagement/managedDevices/${encodeURIComponent(deviceId)}?$select=${DEVICE_SELECT}`));
  }

  async listDetectedApps(deviceId: string): Promise<M365DetectedApp[]> {
    const apps = await this.list<Json>(`/deviceManagement/managedDevices/${encodeURIComponent(deviceId)}/detectedApps?$select=displayName,version`, 500);
    return apps.map((a) => ({ name: a.displayName ?? "", version: a.version ?? "" }));
  }

  async getBitLockerKeys(azureADDeviceId: string): Promise<M365BitLockerKey[]> {
    // The recovery-key API requires client identification headers.
    const headers = { "ocp-client-name": "Haley", "ocp-client-version": "1.0" };
    const listed: Json = await this.call(
      "GET",
      `/informationProtection/bitlocker/recoveryKeys?$filter=${encodeURIComponent(`deviceId eq '${odataString(azureADDeviceId)}'`)}`,
      undefined,
      headers,
    );
    const keys: M365BitLockerKey[] = [];
    for (const k of (listed.value ?? []) as Json[]) {
      const full: Json = await this.call("GET", `/informationProtection/bitlocker/recoveryKeys/${encodeURIComponent(k.id)}?$select=key`, undefined, headers);
      keys.push({ id: k.id, volumeType: k.volumeType ?? "", createdDateTime: k.createdDateTime ?? "", key: String(full.key ?? "") });
    }
    return keys;
  }

  async deviceAction(deviceId: string, action: M365DeviceAction) {
    const base = `/deviceManagement/managedDevices/${encodeURIComponent(deviceId)}`;
    if (action === "sync") await this.call("POST", `${base}/syncDevice`);
    else if (action === "restart") await this.call("POST", `${base}/rebootNow`);
    else if (action === "retire") await this.call("POST", `${base}/retire`);
    else await this.call("POST", `${base}/wipe`, { keepEnrollmentData: false, keepUserData: false });
  }

  async listRemediations(): Promise<M365Remediation[]> {
    const scripts = await this.list<Json>(`${GRAPH_BETA}/deviceManagement/deviceHealthScripts?$select=id,displayName,description`, 200);
    return scripts.map((s) => ({ id: s.id, displayName: s.displayName ?? "", description: s.description ?? "" }));
  }

  async runRemediation(deviceId: string, remediationId: string) {
    await this.call("POST", `${GRAPH_BETA}/deviceManagement/managedDevices/${encodeURIComponent(deviceId)}/initiateOnDemandProactiveRemediation`, {
      scriptPolicyId: remediationId,
    });
  }

  async listPrivilegedUsers(): Promise<M365RoleHolder[]> {
    const roles = await this.list<Json>("/directoryRoles?$expand=members");
    const holders: M365RoleHolder[] = [];
    for (const role of roles) {
      if (!PRIVILEGED_ROLES.includes(role.displayName)) continue;
      for (const m of (role.members ?? []) as Json[]) {
        if (!m.userPrincipalName) continue;
        holders.push({ role: role.displayName, userPrincipalName: String(m.userPrincipalName).toLowerCase(), displayName: m.displayName ?? "" });
      }
    }
    return holders;
  }

  async serviceHealth() {
    const items = await this.list<Json>("/admin/serviceAnnouncement/healthOverviews");
    return items.map((h) => ({ service: h.service, status: h.status }));
  }

  async issueTemporaryAccessPass(userId: string, lifetimeMinutes: number, usableOnce: boolean) {
    const created = await this.call("POST", `/users/${encodeURIComponent(userId)}/authentication/temporaryAccessPassMethods`, {
      lifetimeInMinutes: lifetimeMinutes,
      isUsableOnce: usableOnce,
    });
    return { pass: String(created.temporaryAccessPass), lifetimeMinutes: Number(created.lifetimeInMinutes ?? lifetimeMinutes) };
  }

  async setAutoReply(userId: string, reply: { enabled: boolean; internalMessage: string; externalMessage: string }) {
    await this.call("PATCH", `/users/${encodeURIComponent(userId)}/mailboxSettings`, {
      automaticRepliesSetting: {
        status: reply.enabled ? "alwaysEnabled" : "disabled",
        internalReplyMessage: reply.internalMessage,
        externalReplyMessage: reply.externalMessage,
        externalAudience: "all",
      },
    });
  }
}
