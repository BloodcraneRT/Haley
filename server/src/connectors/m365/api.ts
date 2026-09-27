/** Normalized Microsoft 365 surface. Implemented by the live Graph client and the sandbox tenant. */

export interface M365User {
  id: string;
  displayName: string;
  userPrincipalName: string;
  mail: string | null;
  accountEnabled: boolean;
  jobTitle: string | null;
  department: string | null;
  usageLocation: string | null;
  /** skuIds */
  licenses: string[];
}

export interface M365Sku {
  skuId: string;
  skuPartNumber: string;
  enabled: number;
  consumed: number;
}

export interface M365Group {
  id: string;
  displayName: string;
  mail: string | null;
  kind: "microsoft365" | "security" | "distribution";
}

export interface M365AuthMethod {
  type: string;
  detail: string;
}

export interface M365Device {
  id: string;
  deviceName: string;
  operatingSystem: string;
  osVersion: string;
  complianceState: string;
  lastSyncDateTime: string;
  userPrincipalName: string;
}

export interface M365ServiceHealth {
  service: string;
  status: string;
}

export interface NewM365User {
  displayName: string;
  userPrincipalName: string;
  mailNickname: string;
  password: string;
  usageLocation: string;
  jobTitle?: string;
  department?: string;
}

export interface M365Api {
  organization(): Promise<{ id: string; displayName: string; verifiedDomains: string[] }>;
  listUsers(search?: string): Promise<M365User[]>;
  getUser(idOrUpn: string): Promise<M365User>;
  getUserGroups(id: string): Promise<M365Group[]>;
  createUser(input: NewM365User): Promise<M365User>;
  setAccountEnabled(id: string, enabled: boolean): Promise<void>;
  resetPassword(id: string, password: string, forceChange: boolean): Promise<void>;
  revokeSessions(id: string): Promise<void>;
  listSkus(): Promise<M365Sku[]>;
  assignLicense(userId: string, skuId: string): Promise<void>;
  removeLicense(userId: string, skuId: string): Promise<void>;
  listGroups(search?: string): Promise<M365Group[]>;
  addGroupMember(groupId: string, userId: string): Promise<void>;
  removeGroupMember(groupId: string, userId: string): Promise<void>;
  listAuthMethods(userId: string): Promise<M365AuthMethod[]>;
  listDevices(userPrincipalName?: string): Promise<M365Device[]>;
  serviceHealth(): Promise<M365ServiceHealth[]>;
  setAutoReply(userId: string, reply: { enabled: boolean; internalMessage: string; externalMessage: string }): Promise<void>;
  issueTemporaryAccessPass(userId: string, lifetimeMinutes: number, usableOnce: boolean): Promise<{ pass: string; lifetimeMinutes: number }>;
}
