/** Normalized Google Workspace surface. Implemented by the live Admin SDK client and the sandbox tenant. */

export interface GwsUser {
  id: string;
  primaryEmail: string;
  name: string;
  suspended: boolean;
  isAdmin: boolean;
  orgUnitPath: string;
  isEnrolledIn2Sv: boolean;
  lastLoginTime: string | null;
  aliases: string[];
  /** Recovery phone on file (E.164), used for SMS verification codes. */
  recoveryPhone: string | null;
}

export interface GwsGroup {
  id: string;
  email: string;
  name: string;
  directMembersCount: number;
}

export interface GwsOrgUnit {
  orgUnitPath: string;
  name: string;
  description: string;
}

export interface NewGwsUser {
  primaryEmail: string;
  givenName: string;
  familyName: string;
  password: string;
  orgUnitPath: string;
}

export interface GoogleApi {
  listUsers(query?: string): Promise<GwsUser[]>;
  getUser(email: string): Promise<GwsUser>;
  createUser(input: NewGwsUser): Promise<GwsUser>;
  resetPassword(email: string, password: string, changeAtNextLogin: boolean): Promise<void>;
  setSuspended(email: string, suspended: boolean): Promise<void>;
  signOut(email: string): Promise<void>;
  moveToOrgUnit(email: string, orgUnitPath: string): Promise<void>;
  listGroups(userEmail?: string): Promise<GwsGroup[]>;
  addGroupMember(groupEmail: string, userEmail: string, role: "MEMBER" | "MANAGER" | "OWNER"): Promise<void>;
  removeGroupMember(groupEmail: string, userEmail: string): Promise<void>;
  listOrgUnits(): Promise<GwsOrgUnit[]>;
}
