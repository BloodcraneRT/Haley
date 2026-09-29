import { randomUUID } from "node:crypto";
import { ConnectorError, type StateStore } from "../types.js";
import type {
  M365Api,
  M365AuthMethod,
  M365BitLockerKey,
  M365DetectedApp,
  M365Device,
  M365DeviceAction,
  M365Group,
  M365Remediation,
  M365ServiceHealth,
  M365Sku,
  M365User,
  NewM365User,
} from "../m365/api.js";

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
  /** Installed apps per device id. */
  detectedApps?: Record<string, M365DetectedApp[]>;
  /** BitLocker recovery keys per Entra device id. */
  bitlocker?: Record<string, M365BitLockerKey[]>;
  remediations?: M365Remediation[];
  /** Remote actions and remediation runs Haley sent, newest last. */
  deviceLog?: Array<{ deviceId: string; action: string; at: string }>;
  roles?: Array<{ role: string; userId: string }>;
}

/** Fills in Intune and role data for tenants saved before those features existed. */
function withIntuneData(state: M365SandboxState): M365SandboxState {
  const recoveryKey = () =>
    Array.from({ length: 8 }, () => String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")).join("-");
  const officeApps: M365DetectedApp[] = [
    { name: "Microsoft 365 Apps for enterprise", version: "16.0.18827.20128" },
    { name: "Microsoft Edge", version: "139.0.3405.86" },
    { name: "Microsoft Teams", version: "25212.2204.3808.2893" },
  ];
  for (const d of state.devices) {
    d.manufacturer ??= d.operatingSystem === "Windows" ? "Lenovo" : "Apple";
    d.model ??= d.operatingSystem === "Windows" ? "ThinkPad T14 Gen 5" : d.operatingSystem === "iOS" ? "iPhone 15" : "MacBook Pro 14";
    d.serialNumber ??= `SN${d.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    d.azureADDeviceId ??= randomUUID();
    d.isEncrypted ??= d.complianceState === "compliant";
    d.totalStorageSpaceInBytes ??= 512 * 1024 ** 3;
    d.freeStorageSpaceInBytes ??= d.complianceState === "compliant" ? 180 * 1024 ** 3 : 6 * 1024 ** 3;
  }
  state.detectedApps ??= Object.fromEntries(
    state.devices.map((d) => [
      d.id,
      d.operatingSystem === "iOS"
        ? [{ name: "Microsoft Authenticator", version: "6.8.21" }, { name: "Outlook", version: "4.2533.0" }]
        : [...officeApps, ...(d.complianceState === "noncompliant" ? [{ name: "Adobe Acrobat Reader DC", version: "19.012.20034" }] : [])],
    ]),
  );
  state.bitlocker ??= Object.fromEntries(
    state.devices
      .filter((d) => d.operatingSystem === "Windows")
      .map((d) => [
        d.azureADDeviceId!,
        [{ id: randomUUID(), volumeType: "operatingSystemVolume", createdDateTime: new Date(Date.now() - 200 * 86_400_000).toISOString(), key: recoveryKey() }],
      ]),
  );
  state.remediations ??= [
    { id: randomUUID(), displayName: "Clear Teams cache", description: "Signs the user out of Teams and clears its local cache." },
    { id: randomUUID(), displayName: "Restart print spooler", description: "Restarts the Print Spooler service and clears stuck jobs." },
    { id: randomUUID(), displayName: "Disk cleanup", description: "Clears temp files and the Windows Update cache." },
  ];
  state.deviceLog ??= [];
  if (!state.roles) {
    const grady = state.users.find((u) => u.displayName.startsWith("Grady"));
    const lynne = state.users.find((u) => u.displayName.startsWith("Lynne"));
    state.roles = [
      ...(grady ? [{ role: "Global Administrator", userId: grady.id }] : []),
      ...(lynne ? [{ role: "Billing Administrator", userId: lynne.id }] : []),
    ];
    const breakGlass = state.groups.find((g) => /break-glass/i.test(g.displayName));
    if (breakGlass) breakGlass.roleAssignable = true;
  }
  return state;
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
        { type: "phone:mobile", detail: "+1 5550142" },
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
    this.state = withIntuneData(store.load() ?? seed(domain, displayName));
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
    return { id: "sandbox-tenant", displayName: this.state.displayName, verifiedDomains: [this.state.domain, `${this.state.domain.split(".")[0]}.onmicrosoft.com`] };
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

  private device(id: string): M365Device {
    const d = this.state.devices.find((x) => x.id === id);
    if (!d) throw new ConnectorError(`Graph GET /deviceManagement/managedDevices/${id} failed (404): Device not found.`, 404);
    return d;
  }

  async getDevice(deviceId: string) {
    return { ...this.device(deviceId) };
  }

  async listDetectedApps(deviceId: string) {
    this.device(deviceId);
    return this.state.detectedApps?.[deviceId] ?? [];
  }

  async getBitLockerKeys(azureADDeviceId: string) {
    return this.state.bitlocker?.[azureADDeviceId] ?? [];
  }

  async deviceAction(deviceId: string, action: M365DeviceAction) {
    const d = this.device(deviceId);
    const at = new Date().toISOString();
    if (action === "sync" || action === "restart") d.lastSyncDateTime = at;
    if (action === "retire" || action === "wipe") this.state.devices = this.state.devices.filter((x) => x.id !== deviceId);
    this.state.deviceLog!.push({ deviceId, action, at });
    this.commit();
  }

  async listRemediations() {
    return this.state.remediations ?? [];
  }

  async runRemediation(deviceId: string, remediationId: string) {
    this.device(deviceId);
    const script = this.state.remediations?.find((r) => r.id === remediationId);
    if (!script) throw new ConnectorError(`Graph POST initiateOnDemandProactiveRemediation failed (404): Script ${remediationId} not found.`, 404);
    this.state.deviceLog!.push({ deviceId, action: `remediation:${script.displayName}`, at: new Date().toISOString() });
    this.commit();
  }

  async listPrivilegedUsers() {
    return (this.state.roles ?? []).flatMap((r) => {
      const u = this.state.users.find((x) => x.id === r.userId);
      return u ? [{ role: r.role, userPrincipalName: u.userPrincipalName, displayName: u.displayName }] : [];
    });
  }

  async serviceHealth() {
    return this.state.health;
  }

  async issueTemporaryAccessPass(userId: string, lifetimeMinutes: number, _usableOnce: boolean) {
    const u = this.find(userId);
    if (!u.accountEnabled) throw new ConnectorError("Graph POST temporaryAccessPassMethods failed (400): The user account is disabled.", 400);
    const pass = randomUUID().replace(/-/g, "").slice(0, 10).replace(/(.{5})/, "$1-");
    u.authMethods = [...u.authMethods.filter((m) => m.type !== "temporaryAccessPass"), { type: "temporaryAccessPass", detail: `valid ${lifetimeMinutes} min` }];
    this.commit();
    return { pass, lifetimeMinutes };
  }

  async setAutoReply(userId: string, reply: { enabled: boolean; internalMessage: string; externalMessage: string }) {
    this.find(userId).autoReply = reply;
    this.commit();
  }
}
