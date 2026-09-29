import type { M365Api, M365RoleHolder } from "./api.js";

export interface M365Discovery {
  tenantId: string;
  organization: string;
  domains: string[];
  licenses: Array<{ sku: string; purchased: number; assigned: number }>;
  users: { total: number; enabled: number; licensed: number; truncated: boolean };
  /** null when Intune isn't licensed or Haley lacks the device permission. */
  devices: { total: number; noncompliant: number; staleOver30Days: number } | null;
  admins: M365RoleHolder[];
  /** Settings Haley suggests for the client, from what it found. */
  suggestions: { emailDomains: string[]; teamsTenantId: string; protectedAccounts: string[] };
  /** Things Haley couldn't read, usually a missing permission. */
  warnings: string[];
  discoveredAt: string;
}

const USER_LIST_CAP = 500;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Reads a tenant's shape so onboarding can pre-fill the client's settings instead of typing them in. */
export async function discoverM365(api: M365Api): Promise<M365Discovery> {
  const warnings: string[] = [];
  const [org, skus, users] = await Promise.all([api.organization(), api.listSkus(), api.listUsers()]);

  const devices = await api.listDevices().catch((err) => {
    warnings.push(`Intune devices: ${errorText(err)}`);
    return null;
  });
  const admins = await api.listPrivilegedUsers().catch((err) => {
    warnings.push(`Admin roles: ${errorText(err)}`);
    return [] as M365RoleHolder[];
  });

  const staleCutoff = Date.now() - 30 * 86_400_000;
  const domains = org.verifiedDomains.map((d) => d.toLowerCase());
  return {
    tenantId: org.id,
    organization: org.displayName,
    domains,
    licenses: skus.map((s) => ({ sku: s.skuPartNumber, purchased: s.enabled, assigned: s.consumed })),
    users: {
      total: users.length,
      enabled: users.filter((u) => u.accountEnabled).length,
      licensed: users.filter((u) => u.licenses.length > 0).length,
      truncated: users.length >= USER_LIST_CAP,
    },
    devices: devices
      ? {
          total: devices.length,
          noncompliant: devices.filter((d) => d.complianceState === "noncompliant").length,
          staleOver30Days: devices.filter((d) => d.lastSyncDateTime && Date.parse(d.lastSyncDateTime) < staleCutoff).length,
        }
      : null,
    admins,
    suggestions: {
      // The onmicrosoft.com domain never receives real user mail.
      emailDomains: domains.filter((d) => !d.endsWith(".onmicrosoft.com")),
      // Only a real tenant GUID can route Teams messages.
      teamsTenantId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(org.id) ? org.id : "",
      protectedAccounts: [...new Set(admins.map((a) => a.userPrincipalName.toLowerCase()))],
    },
    warnings,
    discoveredAt: new Date().toISOString(),
  };
}
