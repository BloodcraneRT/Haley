import { z } from "zod";
import { generateTempPassword } from "../../crypto.js";
import { ConnectorError, defineTool, SensitiveResult, type HaleyTool } from "../types.js";
import type { M365Api, M365Group, M365Sku } from "./api.js";

const user = z.string().min(1).describe("User principal name (e.g. jane@contoso.com) or Entra object id");

async function resolveSku(api: M365Api, sku: string): Promise<M365Sku> {
  const skus = await api.listSkus();
  const match = skus.find((s) => s.skuId === sku || s.skuPartNumber.toLowerCase() === sku.toLowerCase());
  if (!match) {
    throw new ConnectorError(`No subscribed SKU "${sku}". Available: ${skus.map((s) => s.skuPartNumber).join(", ")}`);
  }
  return match;
}

async function resolveGroup(api: M365Api, group: string): Promise<M365Group> {
  const groups = await api.listGroups();
  const lower = group.toLowerCase();
  const match =
    groups.find((g) => g.id === group) ??
    groups.find((g) => g.displayName.toLowerCase() === lower || g.mail?.toLowerCase() === lower);
  if (!match) throw new ConnectorError(`No group matching "${group}". Use m365_list_groups to find the right one.`);
  return match;
}

export function m365Tools(api: M365Api): HaleyTool[] {
  const skuName = async (ids: string[]) => {
    if (!ids.length) return [];
    const skus = await api.listSkus();
    return ids.map((id) => skus.find((s) => s.skuId === id)?.skuPartNumber ?? id);
  };

  return [
    defineTool({
      name: "m365_list_users",
      description:
        "List Microsoft 365 users. Optional search matches the start of display name, surname, UPN or email. Returns account state, title, department and license SKUs.",
      input: z.object({ search: z.string().optional().describe("Prefix to search for, e.g. 'jane' or 'jane.doe@'") }),
      risk: "read",
      run: async ({ search }) => {
        const users = await api.listUsers(search);
        const skus = await api.listSkus();
        return users.map((u) => ({
          ...u,
          licenses: u.licenses.map((id) => skus.find((s) => s.skuId === id)?.skuPartNumber ?? id),
        }));
      },
    }),
    defineTool({
      name: "m365_get_user",
      description: "Get a Microsoft 365 user's full profile: account state, licenses, group memberships and registered MFA methods.",
      input: z.object({ user }),
      risk: "read",
      run: async ({ user }) => {
        const u = await api.getUser(user);
        const [groups, methods, licenses] = await Promise.all([
          api.getUserGroups(u.id),
          api.listAuthMethods(u.id).catch((e: Error) => [{ type: "unavailable", detail: e.message }]),
          skuName(u.licenses),
        ]);
        return { ...u, licenses, groups, mfaMethods: methods };
      },
    }),
    defineTool({
      name: "m365_list_licenses",
      description: "List the tenant's subscribed license SKUs with purchased (enabled) and consumed seat counts.",
      input: z.object({}),
      risk: "read",
      run: async () => {
        const skus = await api.listSkus();
        return skus.map((s) => ({ ...s, available: s.enabled - s.consumed }));
      },
    }),
    defineTool({
      name: "m365_list_groups",
      description: "List Microsoft 365, security and distribution groups. Optional search matches the start of the display name.",
      input: z.object({ search: z.string().optional() }),
      risk: "read",
      run: async ({ search }) => api.listGroups(search),
    }),
    defineTool({
      name: "m365_list_devices",
      description: "List Intune-managed devices, optionally only those for one user, with OS version and compliance state.",
      input: z.object({ user: z.string().optional().describe("User principal name to filter by") }),
      risk: "read",
      run: async ({ user }) => api.listDevices(user),
    }),
    defineTool({
      name: "m365_service_health",
      description: "Current Microsoft 365 service health (Exchange Online, Teams, SharePoint, etc). Check this first for outage-like tickets.",
      input: z.object({}),
      risk: "read",
      run: async () => api.serviceHealth(),
    }),
    defineTool({
      name: "m365_create_user",
      description:
        "Create a new Microsoft 365 user with a generated temporary password (they must change it at first sign-in). The password is delivered to the technician, never to you.",
      input: z.object({
        displayName: z.string().min(1),
        userPrincipalName: z.string().email(),
        usageLocation: z.string().length(2).default("US").describe("ISO country code; required before licenses can be assigned"),
        jobTitle: z.string().optional(),
        department: z.string().optional(),
      }),
      risk: "write",
      describe: (i) => `Create user ${i.displayName} <${i.userPrincipalName}>`,
      run: async (input) => {
        const password = generateTempPassword();
        const created = await api.createUser({
          ...input,
          mailNickname: input.userPrincipalName.split("@")[0],
          password,
        });
        return new SensitiveResult(
          { created, temporaryPassword: "[delivered securely to the technician]" },
          { temporaryPassword: password, userPrincipalName: created.userPrincipalName },
        );
      },
    }),
    defineTool({
      name: "m365_assign_license",
      description: "Assign a license SKU (by skuPartNumber like SPE_E3 / O365_BUSINESS_PREMIUM, or skuId) to a user. Check seat availability first.",
      input: z.object({ user, sku: z.string().min(1) }),
      risk: "write",
      describe: (i) => `Assign license ${i.sku} to ${i.user}`,
      run: async ({ user, sku }) => {
        const match = await resolveSku(api, sku);
        if (match.enabled - match.consumed <= 0) {
          throw new ConnectorError(`No available seats for ${match.skuPartNumber} (${match.consumed}/${match.enabled} used).`);
        }
        const u = await api.getUser(user);
        await api.assignLicense(u.id, match.skuId);
        return { ok: true, user: u.userPrincipalName, assigned: match.skuPartNumber };
      },
    }),
    defineTool({
      name: "m365_remove_license",
      description: "Remove a license SKU from a user.",
      input: z.object({ user, sku: z.string().min(1) }),
      risk: "write",
      describe: (i) => `Remove license ${i.sku} from ${i.user}`,
      run: async ({ user, sku }) => {
        const match = await resolveSku(api, sku);
        const u = await api.getUser(user);
        await api.removeLicense(u.id, match.skuId);
        return { ok: true, user: u.userPrincipalName, removed: match.skuPartNumber };
      },
    }),
    defineTool({
      name: "m365_add_group_member",
      description: "Add a user to a group (by group id, display name or email). Use for shared mailbox / distribution list / Teams / app access requests.",
      input: z.object({ user, group: z.string().min(1) }),
      risk: "write",
      grantsAccess: true,
      describe: (i) => `Add ${i.user} to group "${i.group}"`,
      run: async ({ user, group }) => {
        const [u, g] = await Promise.all([api.getUser(user), resolveGroup(api, group)]);
        await api.addGroupMember(g.id, u.id);
        return { ok: true, user: u.userPrincipalName, group: g.displayName };
      },
    }),
    defineTool({
      name: "m365_remove_group_member",
      description: "Remove a user from a group (by group id, display name or email).",
      input: z.object({ user, group: z.string().min(1) }),
      risk: "write",
      describe: (i) => `Remove ${i.user} from group "${i.group}"`,
      run: async ({ user, group }) => {
        const [u, g] = await Promise.all([api.getUser(user), resolveGroup(api, group)]);
        await api.removeGroupMember(g.id, u.id);
        return { ok: true, user: u.userPrincipalName, group: g.displayName };
      },
    }),
    defineTool({
      name: "m365_set_auto_reply",
      description: "Turn a mailbox's automatic replies (out of office) on or off.",
      input: z.object({
        user,
        enabled: z.boolean(),
        internalMessage: z.string().default(""),
        externalMessage: z.string().default(""),
      }),
      risk: "write",
      describe: (i) => `${i.enabled ? "Enable" : "Disable"} automatic replies for ${i.user}`,
      run: async ({ user, ...reply }) => {
        const u = await api.getUser(user);
        await api.setAutoReply(u.id, reply);
        return { ok: true, user: u.userPrincipalName, autoReply: reply.enabled ? "on" : "off" };
      },
    }),
    defineTool({
      name: "m365_reset_password",
      description:
        "Reset a user's password to a generated temporary password and require a change at next sign-in. The password goes to the technician, never to you. Verify the requester's identity per policy first.",
      input: z.object({ user, forceChangeAtNextSignIn: z.boolean().default(true) }),
      risk: "destructive",
      describe: (i) => `Reset password for ${i.user}`,
      run: async ({ user, forceChangeAtNextSignIn }) => {
        const u = await api.getUser(user);
        const password = generateTempPassword();
        await api.resetPassword(u.id, password, forceChangeAtNextSignIn);
        return new SensitiveResult(
          { ok: true, user: u.userPrincipalName, temporaryPassword: "[delivered securely to the technician]" },
          { temporaryPassword: password, userPrincipalName: u.userPrincipalName },
        );
      },
    }),
    defineTool({
      name: "m365_set_account_enabled",
      description: "Block (enabled=false) or unblock (enabled=true) a user's sign-in. Blocking is the first step of offboarding or a compromise response.",
      input: z.object({ user, enabled: z.boolean() }),
      risk: "destructive",
      describe: (i) => `${i.enabled ? "Unblock" : "Block"} sign-in for ${i.user}`,
      run: async ({ user, enabled }) => {
        const u = await api.getUser(user);
        await api.setAccountEnabled(u.id, enabled);
        return { ok: true, user: u.userPrincipalName, accountEnabled: enabled };
      },
    }),
    defineTool({
      name: "m365_revoke_sessions",
      description: "Sign a user out everywhere by revoking all refresh tokens and sessions. Use after a password reset for a suspected compromise.",
      input: z.object({ user }),
      risk: "destructive",
      describe: (i) => `Revoke all sign-in sessions for ${i.user}`,
      run: async ({ user }) => {
        const u = await api.getUser(user);
        await api.revokeSessions(u.id);
        return { ok: true, user: u.userPrincipalName, sessionsRevoked: true };
      },
    }),
  ];
}
