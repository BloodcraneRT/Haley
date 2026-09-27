import { randomUUID } from "node:crypto";
import { ConnectorError, type StateStore } from "../types.js";
import type { GoogleApi, GwsGroup, GwsOrgUnit, GwsUser, NewGwsUser } from "../google/api.js";

interface SandboxGwsUser extends GwsUser {
  groups: Array<{ email: string; role: string }>;
  passwordChangedAt: string | null;
  signedOutAt: string | null;
}

export interface GoogleSandboxState {
  domain: string;
  users: SandboxGwsUser[];
  groups: Array<Omit<GwsGroup, "directMembersCount">>;
  orgUnits: GwsOrgUnit[];
}

function seed(domain: string): GoogleSandboxState {
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const mk = (first: string, last: string, ou: string, opts: Partial<SandboxGwsUser> = {}): SandboxGwsUser => ({
    id: randomUUID().replace(/-/g, "").slice(0, 21),
    primaryEmail: `${first}@${domain}`.toLowerCase(),
    name: `${first} ${last}`,
    suspended: false,
    isAdmin: false,
    orgUnitPath: ou,
    isEnrolledIn2Sv: true,
    lastLoginTime: day(1),
    aliases: [],
    recoveryPhone: null,
    groups: [{ email: `everyone@${domain}`, role: "MEMBER" }],
    passwordChangedAt: null,
    signedOutAt: null,
    ...opts,
  });
  return {
    domain,
    orgUnits: [
      { orgUnitPath: "/", name: domain, description: "Root" },
      { orgUnitPath: "/Staff", name: "Staff", description: "Standard employees" },
      { orgUnitPath: "/Staff/Clinical", name: "Clinical", description: "Clinical staff - stricter device policy" },
      { orgUnitPath: "/Contractors", name: "Contractors", description: "Limited Drive sharing" },
      { orgUnitPath: "/Suspended", name: "Suspended", description: "Offboarded accounts" },
    ],
    groups: [
      { id: randomUUID(), email: `everyone@${domain}`, name: "Everyone" },
      { id: randomUUID(), email: `frontdesk@${domain}`, name: "Front Desk" },
      { id: randomUUID(), email: `billing@${domain}`, name: "Billing" },
      { id: randomUUID(), email: `clinical@${domain}`, name: "Clinical Team" },
    ],
    users: [
      mk("maria", "Lopez", "/Staff", { isAdmin: true, recoveryPhone: "+15550100101" }),
      mk("sam", "Chen", "/Staff/Clinical", { groups: [{ email: `everyone@${domain}`, role: "MEMBER" }, { email: `clinical@${domain}`, role: "MEMBER" }] }),
      mk("priya", "Nair", "/Staff/Clinical", { isEnrolledIn2Sv: false, groups: [{ email: `everyone@${domain}`, role: "MEMBER" }, { email: `clinical@${domain}`, role: "MEMBER" }] }),
      mk("tom", "Baker", "/Staff", { groups: [{ email: `everyone@${domain}`, role: "MEMBER" }, { email: `billing@${domain}`, role: "OWNER" }] }),
      mk("jess", "Ortiz", "/Staff", {
        recoveryPhone: "+15550100155", groups: [{ email: `everyone@${domain}`, role: "MEMBER" }, { email: `frontdesk@${domain}`, role: "MEMBER" }] }),
      mk("kevin", "Walsh", "/Contractors", { isEnrolledIn2Sv: false, lastLoginTime: day(62) }),
    ],
  };
}

/** In-memory Google Workspace domain that behaves like the Admin SDK for demos, onboarding and tests. */
export class SandboxGoogleApi implements GoogleApi {
  private state: GoogleSandboxState;

  constructor(
    private readonly store: StateStore<GoogleSandboxState>,
    domain = "acme-health.example",
  ) {
    this.state = store.load() ?? seed(domain);
    this.store.save(this.state);
  }

  private commit() {
    this.store.save(this.state);
  }

  private find(email: string): SandboxGwsUser {
    const key = email.toLowerCase();
    const u = this.state.users.find((x) => x.primaryEmail === key || x.aliases.includes(key) || x.id === email);
    if (!u) throw new ConnectorError(`Google GET /users/${email} failed (404): Resource Not Found: userKey`, 404);
    return u;
  }

  private group(email: string) {
    const g = this.state.groups.find((x) => x.email === email.toLowerCase() || x.id === email);
    if (!g) throw new ConnectorError(`Google /groups/${email} failed (404): Resource Not Found: groupKey`, 404);
    return g;
  }

  private strip(u: SandboxGwsUser): GwsUser {
    const { groups: _g, passwordChangedAt: _p, signedOutAt: _s, ...rest } = u;
    return { ...rest, aliases: [...u.aliases] };
  }

  async listUsers(query?: string) {
    let users = this.state.users;
    if (query) {
      const q = query.toLowerCase();
      const [field, value] = q.includes("=") ? q.split("=") : q.includes(":") ? q.split(":") : ["", q];
      users = users.filter((u) => {
        if (field === "isenrolledin2sv") return String(u.isEnrolledIn2Sv) === value;
        if (field === "issuspended") return String(u.suspended) === value;
        if (field === "orgunitpath") return u.orgUnitPath.toLowerCase().startsWith(value.replace(/'/g, ""));
        return u.name.toLowerCase().includes(value) || u.primaryEmail.includes(value);
      });
    }
    return users.map((u) => this.strip(u));
  }

  async getUser(email: string) {
    return this.strip(this.find(email));
  }

  async createUser(input: NewGwsUser) {
    const email = input.primaryEmail.toLowerCase();
    if (!email.endsWith(`@${this.state.domain}`)) {
      throw new ConnectorError(`Google POST /users failed (400): Domain not found for ${email}.`, 400);
    }
    if (this.state.users.some((u) => u.primaryEmail === email)) {
      throw new ConnectorError("Google POST /users failed (409): Entity already exists.", 409);
    }
    if (!this.state.orgUnits.some((o) => o.orgUnitPath === input.orgUnitPath)) {
      throw new ConnectorError(`Google POST /users failed (400): Invalid Input: orgunit ${input.orgUnitPath}`, 400);
    }
    const user: SandboxGwsUser = {
      id: randomUUID().replace(/-/g, "").slice(0, 21),
      primaryEmail: email,
      name: `${input.givenName} ${input.familyName}`,
      suspended: false,
      isAdmin: false,
      orgUnitPath: input.orgUnitPath,
      isEnrolledIn2Sv: false,
      lastLoginTime: null,
      aliases: [],
      recoveryPhone: null,
      groups: [{ email: `everyone@${this.state.domain}`, role: "MEMBER" }],
      passwordChangedAt: new Date().toISOString(),
      signedOutAt: null,
    };
    this.state.users.push(user);
    this.commit();
    return this.strip(user);
  }

  async resetPassword(email: string) {
    this.find(email).passwordChangedAt = new Date().toISOString();
    this.commit();
  }

  async setSuspended(email: string, suspended: boolean) {
    this.find(email).suspended = suspended;
    this.commit();
  }

  async signOut(email: string) {
    this.find(email).signedOutAt = new Date().toISOString();
    this.commit();
  }

  async moveToOrgUnit(email: string, orgUnitPath: string) {
    if (!this.state.orgUnits.some((o) => o.orgUnitPath === orgUnitPath)) {
      throw new ConnectorError(`Google PUT /users failed (400): Invalid Input: orgunit ${orgUnitPath}`, 400);
    }
    this.find(email).orgUnitPath = orgUnitPath;
    this.commit();
  }

  async listGroups(userEmail?: string): Promise<GwsGroup[]> {
    const member = userEmail ? this.find(userEmail) : null;
    return this.state.groups
      .filter((g) => !member || member.groups.some((m) => m.email === g.email))
      .map((g) => ({
        ...g,
        directMembersCount: this.state.users.filter((u) => u.groups.some((m) => m.email === g.email)).length,
      }));
  }

  async addGroupMember(groupEmail: string, userEmail: string, role: "MEMBER" | "MANAGER" | "OWNER") {
    const g = this.group(groupEmail);
    const u = this.find(userEmail);
    if (u.groups.some((m) => m.email === g.email)) throw new ConnectorError("Google POST members failed (409): Member already exists.", 409);
    u.groups.push({ email: g.email, role });
    this.commit();
  }

  async removeGroupMember(groupEmail: string, userEmail: string) {
    const g = this.group(groupEmail);
    const u = this.find(userEmail);
    u.groups = u.groups.filter((m) => m.email !== g.email);
    this.commit();
  }

  async listOrgUnits() {
    return this.state.orgUnits;
  }
}
