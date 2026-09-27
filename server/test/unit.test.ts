import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decide, targetsOf, type PolicyInput } from "../src/agent/policy.js";
import { toApiTool } from "../src/agent/runner.js";
import { m365Tools } from "../src/connectors/m365/tools.js";
import { googleTools } from "../src/connectors/google/tools.js";
import { SandboxM365Api, type M365SandboxState } from "../src/connectors/sandbox/m365.js";
import { SandboxGoogleApi, type GoogleSandboxState } from "../src/connectors/sandbox/google.js";
import { SensitiveResult, type StateStore } from "../src/connectors/types.js";
import { generateTempPassword, seal, unseal } from "../src/crypto.js";
import { openDb } from "../src/db.js";
import { Store } from "../src/store.js";

const memoryState = <T>(): StateStore<T> & { value: T | null } => {
  const s = { value: null as T | null, load: () => s.value, save: (v: T) => void (s.value = structuredClone(v)) };
  return s;
};
const ctx = { orgId: "org", runId: "run", ticketId: null };

describe("approval policy", () => {
  const base: PolicyInput = {
    autonomy: "unattended",
    risk: "destructive",
    grantsAccess: false,
    requester: { email: "sam@acme.example", assurance: "chat", authorized: false },
    targets: ["sam@acme.example"],
    protectedTargets: [],
    changesLastHour: 0,
    maxChangesPerHour: 20,
    selfServiceToday: 0,
    maxSelfServicePerDay: 3,
  };
  const outcome = (patch: Partial<PolicyInput>) => decide({ ...base, ...patch }).outcome;

  it("never gates reads or internal writes", () => {
    for (const autonomy of ["read_only", "supervised", "autonomous", "unattended"] as const) {
      for (const risk of ["read", "internal"] as const) {
        expect(outcome({ autonomy, risk, requester: { email: null, assurance: "none", authorized: false } })).toBe("run");
      }
    }
  });

  it("gates customer changes by autonomy", () => {
    expect(outcome({ autonomy: "read_only", risk: "write" })).toBe("block");
    expect(outcome({ autonomy: "supervised", risk: "write" })).toBe("approve");
    expect(outcome({ autonomy: "supervised", risk: "destructive" })).toBe("approve");
    expect(outcome({ autonomy: "autonomous", risk: "write" })).toBe("run");
    expect(outcome({ autonomy: "autonomous", risk: "destructive" })).toBe("approve");
  });

  it("always sends protected accounts to a technician", () => {
    for (const autonomy of ["autonomous", "unattended"] as const) {
      expect(outcome({ autonomy, risk: "write", protectedTargets: ["sam@acme.example"] })).toBe("approve");
    }
    expect(outcome({ requester: { ...base.requester, authorized: true }, protectedTargets: ["sam@acme.example"] })).toBe("approve");
  });

  it("unattended: lets a verified requester fix their own account", () => {
    expect(outcome({})).toBe("run");
    expect(outcome({ requester: { ...base.requester, assurance: "directory" } })).toBe("run");
    expect(outcome({ risk: "write" })).toBe("run");
  });

  it("unattended: never lets email alone authorize security-sensitive changes", () => {
    const email = { ...base.requester, assurance: "email" as const };
    expect(outcome({ requester: email })).toBe("approve");
    expect(outcome({ requester: { ...email, authorized: true } })).toBe("approve");
    expect(outcome({ requester: email, risk: "write" })).toBe("run");
    expect(decide({ ...base, requester: email }).reason).toMatch(/stronger identity than email/);
  });

  it("unattended: unverified requesters always fall back to approval", () => {
    expect(outcome({ requester: { ...base.requester, assurance: "none" }, risk: "write" })).toBe("approve");
  });

  it("unattended: changes to someone else need an authorized approver", () => {
    expect(outcome({ targets: ["kevin@acme.example"] })).toBe("approve");
    expect(outcome({ targets: ["kevin@acme.example"], risk: "write" })).toBe("approve");
    expect(outcome({ targets: [] })).toBe("approve");
    const manager = { ...base.requester, authorized: true };
    expect(outcome({ targets: ["kevin@acme.example"], requester: manager })).toBe("run");
    expect(outcome({ targets: ["kevin@acme.example"], requester: manager, risk: "write" })).toBe("run");
  });

  it("unattended: access grants need an approver even for yourself", () => {
    expect(outcome({ risk: "write", grantsAccess: true })).toBe("approve");
    expect(outcome({ risk: "write", grantsAccess: true, requester: { ...base.requester, authorized: true } })).toBe("run");
  });

  it("unattended: rate limits fall back to approval", () => {
    expect(outcome({ selfServiceToday: 3 })).toBe("approve");
    expect(outcome({ risk: "write", changesLastHour: 20 })).toBe("approve");
  });

  it("reads change targets from tool inputs", () => {
    expect(targetsOf({ user: "Sam@Acme.example", enabled: false })).toEqual(["sam@acme.example"]);
    expect(targetsOf({ groupEmail: "g@acme.example", userEmail: "kev@acme.example" })).toEqual(["kev@acme.example"]);
    expect(targetsOf({})).toEqual([]);
  });
});

describe("crypto", () => {
  it("round-trips sealed secrets and rejects the wrong key", () => {
    const key = randomBytes(32);
    const sealed = seal(key, "s3cret");
    expect(sealed).not.toContain("s3cret");
    expect(unseal(key, sealed)).toBe("s3cret");
    expect(() => unseal(randomBytes(32), sealed)).toThrow();
  });

  it("generates complex temporary passwords", () => {
    for (let i = 0; i < 50; i++) {
      const p = generateTempPassword();
      expect(p).toHaveLength(16);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });
});

describe("store", () => {
  const store = () => new Store(openDb(":memory:"), randomBytes(32));

  it("numbers tickets sequentially and records field changes on the timeline", () => {
    const s = store();
    const org = s.createOrg({ name: "Contoso" });
    const a = s.createTicket({ orgId: org.id, title: "A" });
    const b = s.createTicket({ orgId: org.id, title: "B" });
    expect(b.number).toBe(a.number + 1);
    s.updateTicket(a.id, { status: "resolved", priority: "high" }, "tech");
    const kinds = s.listTicketEvents(a.id).map((e) => e.kind);
    expect(kinds).toEqual(["created", "status_change", "field_change"]);
    expect(s.listTickets({ status: "open" }).map((t) => t.id)).toEqual([b.id]);
    expect(s.stats().resolvedThisWeek).toBe(1);
  });

  it("encrypts integration credentials at rest", () => {
    const s = store();
    const org = s.createOrg({ name: "Contoso" });
    const integration = s.createIntegration({ orgId: org.id, provider: "m365", label: "M365", mode: "live", config: { clientSecret: "abc123" } });
    const raw = s.db.prepare("SELECT config_sealed FROM integrations").get() as { config_sealed: string };
    expect(raw.config_sealed).not.toContain("abc123");
    expect(s.getIntegrationConfig(integration.id)).toEqual({ clientSecret: "abc123" });
    expect(JSON.stringify(s.getIntegration(integration.id))).not.toContain("abc123");
  });

  it("ranks knowledge base search by title matches and scopes by org", () => {
    const s = store();
    const a = s.createOrg({ name: "A" });
    const b = s.createOrg({ name: "B" });
    s.saveArticle({ orgId: null, title: "Password reset runbook", body: "steps" });
    s.saveArticle({ orgId: a.id, title: "Printer setup", body: "password for the printer admin page" });
    s.saveArticle({ orgId: b.id, title: "Password policy for B", body: "..." });
    const results = s.searchArticles({ orgId: a.id, query: "password" }).map((r) => r.title);
    expect(results).toEqual(["Password reset runbook", "Printer setup"]);
  });
});

describe("Microsoft 365 sandbox tools", () => {
  const setup = () => {
    const state = memoryState<M365SandboxState>();
    const api = new SandboxM365Api(state);
    const tools = new Map(m365Tools(api).map((t) => [t.name, t]));
    return { api, state, tool: (name: string) => tools.get(name)! };
  };

  it("resolves SKUs by part number and enforces seat limits", async () => {
    const { tool } = setup();
    const licenses = (await tool("m365_list_licenses").run({}, ctx)) as Array<{ skuPartNumber: string; available: number }>;
    const e3 = licenses.find((l) => l.skuPartNumber === "SPE_E3")!;
    expect(e3.available).toBe(0);
    await expect(tool("m365_assign_license").run({ user: "megan.bowen@contoso.example", sku: "spe_e3" }, ctx)).rejects.toThrow(/No available seats/);
    await tool("m365_remove_license").run({ user: "diego.siciliani@contoso.example", sku: "SPE_E3" }, ctx);
    await expect(tool("m365_assign_license").run({ user: "megan.bowen@contoso.example", sku: "SPE_E3" }, ctx)).resolves.toMatchObject({ assigned: "SPE_E3" });
  });

  it("adds group members by display name and reports friendly errors", async () => {
    const { tool } = setup();
    await tool("m365_add_group_member").run({ user: "alex.wilber@contoso.example", group: "accounts payable mailbox" }, ctx);
    const alex = (await tool("m365_get_user").run({ user: "alex.wilber@contoso.example" }, ctx)) as { groups: Array<{ displayName: string }> };
    expect(alex.groups.map((g) => g.displayName)).toContain("Accounts Payable Mailbox");
    await expect(tool("m365_add_group_member").run({ user: "alex.wilber@contoso.example", group: "Nope" }, ctx)).rejects.toThrow(/No group matching/);
  });

  it("returns temporary passwords only as secrets", async () => {
    const { tool } = setup();
    const out = await tool("m365_reset_password").run({ user: "isaiah.langer@contoso.example", forceChangeAtNextSignIn: true }, ctx);
    expect(out).toBeInstanceOf(SensitiveResult);
    const sensitive = out as SensitiveResult;
    expect(JSON.stringify(sensitive.visible)).not.toContain(sensitive.secrets.temporaryPassword);
    expect(sensitive.secrets.temporaryPassword).toHaveLength(16);
  });

  it("persists tenant changes through the state store", async () => {
    const { state, tool } = setup();
    await tool("m365_set_account_enabled").run({ user: "megan.bowen@contoso.example", enabled: false }, ctx);
    const reloaded = new SandboxM365Api(state);
    expect((await reloaded.getUser("megan.bowen@contoso.example")).accountEnabled).toBe(false);
  });
});

describe("Google Workspace sandbox tools", () => {
  it("creates users, filters by 2SV and manages groups", async () => {
    const api = new SandboxGoogleApi(memoryState<GoogleSandboxState>());
    const tools = new Map(googleTools(api).map((t) => [t.name, t]));
    const no2sv = (await tools.get("gws_list_users")!.run({ query: "isEnrolledIn2Sv=false" }, ctx)) as Array<{ primaryEmail: string }>;
    expect(no2sv.map((u) => u.primaryEmail).sort()).toEqual(["kevin@acme-health.example", "priya@acme-health.example"]);

    const created = await tools.get("gws_create_user")!.run(
      { primaryEmail: "dana@acme-health.example", givenName: "Dana", familyName: "Whitfield", orgUnitPath: "/Staff/Clinical" },
      ctx,
    );
    expect(created).toBeInstanceOf(SensitiveResult);
    await tools.get("gws_add_group_member")!.run({ groupEmail: "clinical@acme-health.example", userEmail: "dana@acme-health.example", role: "MEMBER" }, ctx);
    const dana = (await tools.get("gws_get_user")!.run({ email: "dana@acme-health.example" }, ctx)) as { groups: Array<{ email: string }> };
    expect(dana.groups.map((g) => g.email)).toContain("clinical@acme-health.example");
    await expect(
      tools.get("gws_create_user")!.run({ primaryEmail: "x@other.example", givenName: "X", familyName: "Y", orgUnitPath: "/" }, ctx),
    ).rejects.toThrow(/Domain not found/);
  });
});

describe("tool schemas", () => {
  it("produce object JSON schemas where defaulted fields are optional", () => {
    const api = new SandboxM365Api(memoryState<M365SandboxState>());
    for (const tool of m365Tools(api)) {
      const schema = toApiTool(tool).input_schema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema).not.toHaveProperty("$schema");
    }
    const reset = toApiTool(m365Tools(api).find((t) => t.name === "m365_reset_password")!).input_schema as { required?: string[] };
    expect(reset.required).toEqual(["user"]);
  });
});
