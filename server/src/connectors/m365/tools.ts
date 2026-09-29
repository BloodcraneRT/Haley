import { z } from "zod";
import { generateTempPassword } from "../../crypto.js";
import { ConnectorError, defineTool, SensitiveResult, type HaleyTool } from "../types.js";
import type { M365Api, M365Device, M365Group, M365Sku } from "./api.js";

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

async function resolveDevice(api: M365Api, device: string): Promise<M365Device> {
  const all = await api.listDevices();
  const byId = all.find((d) => d.id === device);
  if (byId) return api.getDevice(byId.id);
  const lower = device.trim().toLowerCase();
  const matches = all.filter((d) => d.deviceName.toLowerCase() === lower || d.serialNumber?.toLowerCase() === lower);
  if (!matches.length) throw new ConnectorError(`No Intune device matching "${device}". Use m365_list_devices to find it.`);
  if (matches.length > 1) {
    throw new ConnectorError(`"${device}" matches ${matches.length} devices (${matches.map((d) => `${d.id} for ${d.userPrincipalName}`).join("; ")}). Use the device id.`);
  }
  return api.getDevice(matches[0].id);
}

/** Groups that hand out admin rights: Entra role-assignable groups, or ones clearly named for admins. */
const ADMIN_GROUP = /admin|privileged|break[- ]?glass/i;

export function m365Tools(api: M365Api): HaleyTool[] {
  const device = z.string().min(1).describe("Intune device name (e.g. CON-LT-014), serial number or device id");
  const ownerOf = async ({ device: d }: { device: string }) => {
    const found = await resolveDevice(api, d);
    return found.userPrincipalName ? [found.userPrincipalName.toLowerCase()] : [];
  };

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
      name: "m365_get_device",
      description:
        "Get one Intune device: model, serial, OS version, compliance, encryption, free disk space and last check-in. Optionally include installed apps (for 'is X installed' or version questions).",
      input: z.object({ device, includeApps: z.boolean().default(false) }),
      risk: "read",
      run: async ({ device: d, includeApps }) => {
        const found = await resolveDevice(api, d);
        const gb = (bytes?: number) => (bytes === undefined ? null : Math.round((bytes / 1024 ** 3) * 10) / 10);
        return {
          ...found,
          freeStorageGB: gb(found.freeStorageSpaceInBytes),
          totalStorageGB: gb(found.totalStorageSpaceInBytes),
          ...(includeApps ? { installedApps: await api.listDetectedApps(found.id) } : {}),
        };
      },
    }),
    defineTool({
      name: "m365_get_bitlocker_key",
      description:
        "Retrieve the BitLocker recovery key for a Windows device when it's stuck at the BitLocker recovery screen. The key goes to the device's owner privately or to a technician, never to you. Match the key ID the user sees on screen.",
      input: z.object({ device }),
      risk: "destructive",
      rail: "self_only",
      resolveTargets: ownerOf,
      describe: (i) => `Retrieve the BitLocker recovery key for ${i.device}`,
      run: async ({ device: d }) => {
        const found = await resolveDevice(api, d);
        if (!found.azureADDeviceId) throw new ConnectorError(`${found.deviceName} has no Entra device id, so there's no escrowed BitLocker key.`);
        const keys = await api.getBitLockerKeys(found.azureADDeviceId);
        if (!keys.length) throw new ConnectorError(`No BitLocker recovery key is escrowed for ${found.deviceName}.`);
        const secrets: Record<string, string> = { device: found.deviceName };
        keys.forEach((k, i) => (secrets[keys.length === 1 ? "recoveryKey" : `recoveryKey${i + 1}`] = `${k.key} (key ID ${k.id.slice(0, 8)})`));
        return new SensitiveResult(
          {
            ok: true,
            device: found.deviceName,
            owner: found.userPrincipalName,
            keys: keys.map((k) => ({ keyId: k.id.slice(0, 8), volumeType: k.volumeType, created: k.createdDateTime })),
            recoveryKey: "[held]",
          },
          secrets,
          found.userPrincipalName ? [found.userPrincipalName.toLowerCase()] : [],
        );
      },
    }),
    defineTool({
      name: "m365_sync_device",
      description: "Ask an Intune device to check in now so new policies, apps and compliance results apply without waiting.",
      input: z.object({ device }),
      risk: "write",
      resolveTargets: ownerOf,
      describe: (i) => `Sync Intune device ${i.device}`,
      run: async ({ device: d }) => {
        const found = await resolveDevice(api, d);
        await api.deviceAction(found.id, "sync");
        return { ok: true, device: found.deviceName, action: "sync requested" };
      },
    }),
    defineTool({
      name: "m365_restart_device",
      description: "Restart an Intune-managed device remotely. Unsaved work on it is lost, so confirm the user is ready first.",
      input: z.object({ device }),
      risk: "destructive",
      resolveTargets: ownerOf,
      describe: (i) => `Restart device ${i.device}`,
      run: async ({ device: d }) => {
        const found = await resolveDevice(api, d);
        await api.deviceAction(found.id, "restart");
        return { ok: true, device: found.deviceName, action: "restart requested" };
      },
    }),
    defineTool({
      name: "m365_list_remediations",
      description: "List the Intune remediation scripts this tenant has (e.g. clear Teams cache, restart print spooler) that can be run on one device.",
      input: z.object({}),
      risk: "read",
      run: async () => api.listRemediations(),
    }),
    defineTool({
      name: "m365_run_remediation",
      description: "Run one of the tenant's existing Intune remediation scripts on a device now. Use m365_list_remediations to pick the script.",
      input: z.object({ device, remediation: z.string().min(1).describe("Remediation id or exact display name") }),
      risk: "write",
      resolveTargets: ownerOf,
      describe: (i) => `Run remediation "${i.remediation}" on ${i.device}`,
      run: async ({ device: d, remediation }) => {
        const [found, scripts] = await Promise.all([resolveDevice(api, d), api.listRemediations()]);
        const script = scripts.find((s) => s.id === remediation || s.displayName.toLowerCase() === remediation.toLowerCase());
        if (!script) throw new ConnectorError(`No remediation "${remediation}". Available: ${scripts.map((s) => s.displayName).join(", ") || "none"}`);
        await api.runRemediation(found.id, script.id);
        return { ok: true, device: found.deviceName, remediation: script.displayName, status: "started; results appear in Intune within a few minutes" };
      },
    }),
    defineTool({
      name: "m365_retire_device",
      description:
        "Retire an Intune device: removes company data, apps and profiles but leaves personal data. For offboarding or a personal phone leaving the company. Always needs a technician's approval.",
      input: z.object({ device }),
      risk: "destructive",
      rail: "technician_only",
      resolveTargets: ownerOf,
      describe: (i) => `Retire device ${i.device} (remove company data)`,
      run: async ({ device: d }) => {
        const found = await resolveDevice(api, d);
        await api.deviceAction(found.id, "retire");
        return { ok: true, device: found.deviceName, action: "retire requested" };
      },
    }),
    defineTool({
      name: "m365_wipe_device",
      description:
        "Factory-reset an Intune device, erasing everything on it. Only for lost or stolen devices or a confirmed compromise. Always needs a technician's approval.",
      input: z.object({ device }),
      risk: "destructive",
      rail: "technician_only",
      resolveTargets: ownerOf,
      describe: (i) => `WIPE device ${i.device} (factory reset, erases all data)`,
      run: async ({ device: d }) => {
        const found = await resolveDevice(api, d);
        await api.deviceAction(found.id, "wipe");
        return { ok: true, device: found.deviceName, action: "wipe requested" };
      },
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
      guard: async ({ group }) => {
        const g = await resolveGroup(api, group).catch(() => null);
        if (g && (g.roleAssignable || ADMIN_GROUP.test(g.displayName))) {
          return `"${g.displayName}" grants admin rights, so adding someone to it always needs a technician.`;
        }
        return null;
      },
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
      name: "m365_issue_temporary_access_pass",
      description:
        "Issue a Temporary Access Pass: a short-lived, one-time code the user signs in with to register new MFA methods. Prefer this over a password reset when someone lost or replaced their phone or can't complete MFA. The pass goes to the requester privately or to a technician, never to you.",
      input: z.object({
        user,
        lifetimeMinutes: z.number().int().min(10).max(480).default(60),
        usableOnce: z.boolean().default(true),
      }),
      risk: "destructive",
      rail: "self_only",
      describe: (i) => `Issue a Temporary Access Pass for ${i.user}`,
      run: async ({ user, lifetimeMinutes, usableOnce }) => {
        const u = await api.getUser(user);
        const tap = await api.issueTemporaryAccessPass(u.id, lifetimeMinutes, usableOnce);
        return new SensitiveResult(
          { ok: true, user: u.userPrincipalName, lifetimeMinutes: tap.lifetimeMinutes, usableOnce, temporaryAccessPass: "[held]" },
          { temporaryAccessPass: tap.pass, userPrincipalName: u.userPrincipalName },
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
