import { randomUUID } from "node:crypto";
import { ConnectorError, type StateStore } from "../types.js";
import type { M365Api, M365AuthMethod, M365Device, M365Group, M365ServiceHealth, M365Sku, M365User, NewM365User } from "../m365/api.js";

interface SandboxUser extends M365User {
  groups: string[];
  authMethods: M365AuthMethod[];
  sessionsRevokedAt: string | null;
  passwordChangedAt: string | null;
  autoReply: { enabled: boolean; internalMessage: string; externalMessage: string };
}

export interface M365SandboxState {
  domain: string;
  displayName: string;
  users: SandboxUser[];
  skus: Array<Omit<M365Sku, "consumed">>;
  groups: M365Group[];
  devices: M365Device[];
  health: M365ServiceHealth[];
}

const SKU_E3 = "05e9a617-0261-4cee-bb44-138d3ef5d965";
const SKU_BP = "cbdc14ab-d96c-4c30-b9f4-6ada7cdc1d46";
const SKU_EXO = "4b9405b0-7788-4568-add1-99614e613b69";

function seed(domain: string, displayName: string): M365SandboxState {
  const mk = (
    first: string,
    last: string,
    jobTitle: string,
    department: string,
    opts: Partial<SandboxUser> = {},
  ): SandboxUser => {
    const upn = `${first}.${last}@${domain}`.toLowerCase();
    return {
      id: randomUUID(),
      displayName: `${first} ${last}`,
      userPrincipalName: upn,
      mail: upn,
      accountEnabled: true,
      jobTitle,
      department,
      usageLocation: "US",
      licenses: [SKU_BP],
      groups: [],
      authMethods: [
        { type: "password", detail: "" },
        { type: "microsoftAuthenticator", detail: "iPhone 15" },
      ],
      sessionsRevokedAt: null,
      passwordChangedAt: null,
      autoReply: { enabled: false, internalMessage: "", externalMessage: "" },
      ...opts,
    };
  };

  const groups: M365Group[] = [
    { id: randomUUID(), displayName: "All Staff", mail: `allstaff@${domain}`, kind: "microsoft365" },
    { id: randomUUID(), displayName: "Sales", mail: `sales@${domain}`, kind: "microsoft365" },
    { id: randomUUID(), displayName: "Finance", mail: `finance@${domain}`, kind: "microsoft365" },
    { id: randomUUID(), displayName: "Accounts Payable Mailbox", mail: `ap@${domain}`, kind: "distribution" },
    { id: randomUUID(), displayName: "VPN Users", mail: null, kind: "security" },
    { id: randomUUID(), displayName: "Global Admins (break-glass)", mail: null, kind: "security" },
  ];
  const [all, sales, finance, ap, vpn] = groups;

  const users = [
    mk("Megan", "Bowen", "Marketing Manager", "Marketing", { groups: [all.id] }),
    mk("Alex", "Wilber", "Sales Representative", "Sales", { groups: [all.id, sales.id] }),
    mk("Diego", "Siciliani", "Sales Director", "Sales", { groups: [all.id, sales.id, vpn.id], licenses: [SKU_E3] }),
    mk("Isaiah", "Langer", "Accountant", "Finance", {
      groups: [all.id, finance.id],
      authMethods: [{ type: "password", detail: "" }],
    }),
    mk("Lynne", "Robbins", "Controller", "Finance", {
      groups: [all.id, finance.id, ap.id],
      licenses: [SKU_E3],
      authMethods: [
        { type: "password", detail: "" },
        { type: "phone", detail: "+1 555-0142" },
      ],
    }),
    mk("Grady", "Archie", "IT Coordinator", "Operations", { groups: [all.id, vpn.id], licenses: [SKU_E3] }),
    mk("Pradeep", "Gupta", "Former Sales Rep", "Sales", {
      accountEnabled: false,
      groups: [all.id, sales.id],
      authMethods: [{ type: "password", detail: "" }],
    }),
    mk("Joni", "Sherman", "Receptionist", "Operations", {
      licenses: [SKU_EXO],
      groups: [all.id],
      authMethods: [{ type: "password", detail: "" }],
    }),
  ];
  const byName = (name: string) => users.find((u) => u.displayName.startsWith(name))!;
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  return {
    domain,
    displayName,
    users,
    skus: [
      { skuId: SKU_BP, skuPartNumber: "O365_BUSINESS_PREMIUM", enabled: 6 },
      { skuId: SKU_E3, skuPartNumber: "SPE_E3", enabled: 3 },
      { skuId: SKU_EXO, skuPartNumber: "EXCHANGESTANDARD", enabled: 2 },
    ],
    groups,
    devices: [
      { id: randomUUID(), deviceName: "CON-LT-014", operatingSystem: "Windows", osVersion: "10.0.26100.4652", complianceState: "compliant", lastSyncDateTime: day(0), userPrincipalName: byName("Megan").userPrincipalName },
      { id: randomUUID(), deviceName: "CON-LT-022", operatingSystem: "Windows", osVersion: "10.0.19045.3803", complianceState: "noncompliant", lastSyncDateTime: day(9), userPrincipalName: byName("Isaiah").userPrincipalName },
      { id: randomUUID(), deviceName: "Diego's iPhone", operatingSystem: "iOS", osVersion: "18.6", complianceState: "compliant", lastSyncDateTime: day(1), userPrincipalName: byName("Diego").userPrincipalName },
      { id: randomUUID(), deviceName: "CON-MBP-003", operatingSystem: "macOS", osVersion: "15.5", complianceState: "compliant", lastSyncDateTime: day(2), userPrincipalName: byName("Lynne").userPrincipalName },
      { id: randomUUID(), deviceName: "CON-LT-009", operatingSystem: "Windows", osVersion: "10.0.26100.4652", complianceState: "compliant", lastSyncDateTime: day(45), userPrincipalName: byName("Pradeep").userPrincipalName },
    ],
    health: [
      { service: "Exchange Online", status: "serviceDegradation" },
      { service: "Microsoft Teams", status: "serviceOperational" },
      { service: "SharePoint Online", status: "serviceOperational" },
      { service: "OneDrive for Business", status: "serviceOperational" },
      { service: "Microsoft Entra", status: "serviceOperational" },
      { service: "Microsoft Intune", status: "serviceOperational" },
    ],
  };
}

/** In-memory Microsoft 365 tenant that behaves like Graph for demos, onboarding and tests. */
export class SandboxM365Api implements M365Api {
  private state: M365SandboxState;

  constructor(
    private readonly store: StateStore<M365SandboxState>,
    domain = "contoso.example",
    displayName = "Contoso (Sandbox)",
  ) {
    this.state = store.load() ?? seed(domain, displayName);
    this.store.save(this.state);
  }

  private commit() {
    this.store.save(this.state);
  }

  private find(idOrUpn: string): SandboxUser {
    const key = idOrUpn.toLowerCase();
    const u = this.state.users.find((x) => x.id === idOrUpn || x.userPrincipalName === key || x.mail === key);
    if (!u) throw new ConnectorError(`Graph GET /users/${idOrUpn} failed (404): Resource '${idOrUpn}' does not exist.`, 404);
    return u;
  }

  private strip(u: SandboxUser): M365User {
    const { groups: _g, authMethods: _a, sessionsRevokedAt: _s, passwordChangedAt: _p, autoReply: _r, ...rest } = u;
    return { ...rest, licenses: [...u.licenses] };
  }

  async organization() {
    return { id: "sandbox-tenant", displayName: this.state.displayName, verifiedDomains: [this.state.domain] };
  }

  async listUsers(search?: string) {
    const s = search?.toLowerCase();
    return this.state.users
      .filter(
        (u) =>
          !s ||
          u.displayName.toLowerCase().startsWith(s) ||
          u.displayName.toLowerCase().split(" ").some((part) => part.startsWith(s)) ||
          u.userPrincipalName.startsWith(s),
      )
      .map((u) => this.strip(u));
  }

  async getUser(idOrUpn: string) {
    return this.strip(this.find(idOrUpn));
  }

  async getUserGroups(id: string) {
    const u = this.find(id);
    return this.state.groups.filter((g) => u.groups.includes(g.id));
  }

  async createUser(input: NewM365User) {
    const upn = input.userPrincipalName.toLowerCase();
    if (this.state.users.some((u) => u.userPrincipalName === upn)) {
      throw new ConnectorError(`Graph POST /users failed (400): Another object with the same value for property userPrincipalName already exists.`, 400);
    }
    const user: SandboxUser = {
      id: randomUUID(),
      displayName: input.displayName,
      userPrincipalName: upn,
      mail: upn,
      accountEnabled: true,
      jobTitle: input.jobTitle ?? null,
      department: input.department ?? null,
      usageLocation: input.usageLocation,
      licenses: [],
      groups: [],
      authMethods: [{ type: "password", detail: "" }],
      sessionsRevokedAt: null,
      passwordChangedAt: new Date().toISOString(),
      autoReply: { enabled: false, internalMessage: "", externalMessage: "" },
    };
    this.state.users.push(user);
    this.commit();
    return this.strip(user);
  }

  async setAccountEnabled(id: string, enabled: boolean) {
    this.find(id).accountEnabled = enabled;
    this.commit();
  }

  async resetPassword(id: string, _password: string, _forceChange: boolean) {
    this.find(id).passwordChangedAt = new Date().toISOString();
    this.commit();
  }

  async revokeSessions(id: string) {
    this.find(id).sessionsRevokedAt = new Date().toISOString();
    this.commit();
  }

  async listSkus(): Promise<M365Sku[]> {
    return this.state.skus.map((s) => ({
      ...s,
      consumed: this.state.users.filter((u) => u.licenses.includes(s.skuId)).length,
    }));
  }

  async assignLicense(userId: string, skuId: string) {
    const u = this.find(userId);
    if (!u.usageLocation) {
      throw new ConnectorError("Graph POST assignLicense failed (400): License assignment failed because of invalid usage location.", 400);
    }
    const sku = (await this.listSkus()).find((s) => s.skuId === skuId);
    if (!sku) throw new ConnectorError(`Graph POST assignLicense failed (400): License ${skuId} does not correspond to a valid company License.`, 400);
    if (!u.licenses.includes(skuId)) {
      if (sku.consumed >= sku.enabled) throw new ConnectorError("Graph POST assignLicense failed (400): Subscription has no available licenses.", 400);
      u.licenses.push(skuId);
    }
    this.commit();
  }

  async removeLicense(userId: string, skuId: string) {
    const u = this.find(userId);
    u.licenses = u.licenses.filter((l) => l !== skuId);
    this.commit();
  }

  async listGroups(search?: string) {
    const s = search?.toLowerCase();
    return this.state.groups.filter((g) => !s || g.displayName.toLowerCase().startsWith(s));
  }

  async addGroupMember(groupId: string, userId: string) {
    const u = this.find(userId);
    if (!this.state.groups.some((g) => g.id === groupId)) throw new ConnectorError(`Graph POST /groups/${groupId}/members failed (404)`, 404);
    if (u.groups.includes(groupId)) {
      throw new ConnectorError("Graph POST members/$ref failed (400): One or more added object references already exist.", 400);
    }
    u.groups.push(groupId);
    this.commit();
  }

  async removeGroupMember(groupId: string, userId: string) {
    const u = this.find(userId);
    u.groups = u.groups.filter((g) => g !== groupId);
    this.commit();
  }

  async listAuthMethods(userId: string) {
    return this.find(userId).authMethods;
  }

  async listDevices(userPrincipalName?: string) {
    const upn = userPrincipalName?.toLowerCase();
    return this.state.devices.filter((d) => !upn || d.userPrincipalName === upn);
  }

  async serviceHealth() {
    return this.state.health;
  }

  async setAutoReply(userId: string, reply: { enabled: boolean; internalMessage: string; externalMessage: string }) {
    this.find(userId).autoReply = reply;
    this.commit();
  }
}
