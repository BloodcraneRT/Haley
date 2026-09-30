import { z } from "zod";
import { generateTempPassword } from "../../crypto.js";
import { defineTool, SensitiveResult, type HaleyTool } from "../types.js";
import type { GoogleApi } from "./api.js";

const email = z.string().email().describe("The user's primary email address");

export function googleTools(api: GoogleApi): HaleyTool[] {
  const accountOf = async (input: { email?: string; userEmail?: string }) => [(await api.getUser((input.email ?? input.userEmail)!)).primaryEmail.toLowerCase()];
  return [
    defineTool({
      name: "gws_list_users",
      description:
        "List Google Workspace users with suspension state, admin flag, org unit, 2-Step Verification enrollment and last login. Optional query uses Admin SDK syntax, e.g. 'name:Jane' or 'isEnrolledIn2Sv=false'.",
      input: z.object({ query: z.string().optional() }),
      risk: "read",
      run: async ({ query }) => api.listUsers(query),
    }),
    defineTool({
      name: "gws_get_user",
      description: "Get one Google Workspace user's profile and group memberships.",
      input: z.object({ email }),
      risk: "read",
      run: async ({ email }) => {
        const [user, groups] = await Promise.all([api.getUser(email), api.listGroups(email)]);
        return { ...user, groups };
      },
    }),
    defineTool({
      name: "gws_list_groups",
      description: "List Google Groups in the domain, or only those a user belongs to.",
      input: z.object({ userEmail: z.string().email().optional() }),
      risk: "read",
      run: async ({ userEmail }) => api.listGroups(userEmail),
    }),
    defineTool({
      name: "gws_list_org_units",
      description: "List organizational units (policy containers) in the domain.",
      input: z.object({}),
      risk: "read",
      run: async () => api.listOrgUnits(),
    }),
    defineTool({
      name: "gws_create_user",
      description:
        "Create a Google Workspace user with a generated temporary password (change required at first login). The password goes to the technician, never to you.",
      input: z.object({
        primaryEmail: z.string().email(),
        givenName: z.string().min(1),
        familyName: z.string().min(1),
        orgUnitPath: z.string().default("/"),
      }),
      risk: "write",
      describe: (i) => `Create user ${i.givenName} ${i.familyName} <${i.primaryEmail}> in ${i.orgUnitPath}`,
      run: async (input) => {
        const password = generateTempPassword();
        const created = await api.createUser({ ...input, password });
        return new SensitiveResult(
          { created, temporaryPassword: "[delivered securely to the technician]" },
          { temporaryPassword: password, primaryEmail: created.primaryEmail },
        );
      },
    }),
    defineTool({
      name: "gws_add_group_member",
      description: "Add a user to a Google Group (shared inbox, distribution list, drive/app access).",
      input: z.object({
        groupEmail: z.string().email(),
        userEmail: z.string().email(),
        role: z.enum(["MEMBER", "MANAGER", "OWNER"]).default("MEMBER"),
      }),
      risk: "write",
      resolveTargets: accountOf,
      grantsAccess: true,
      describe: (i) => `Add ${i.userEmail} to ${i.groupEmail} as ${i.role}`,
      run: async ({ groupEmail, userEmail, role }) => {
        await api.addGroupMember(groupEmail, userEmail, role);
        return { ok: true, group: groupEmail, user: userEmail, role };
      },
    }),
    defineTool({
      name: "gws_remove_group_member",
      description: "Remove a user from a Google Group.",
      input: z.object({ groupEmail: z.string().email(), userEmail: z.string().email() }),
      risk: "write",
      resolveTargets: accountOf,
      describe: (i) => `Remove ${i.userEmail} from ${i.groupEmail}`,
      run: async ({ groupEmail, userEmail }) => {
        await api.removeGroupMember(groupEmail, userEmail);
        return { ok: true, group: groupEmail, user: userEmail };
      },
    }),
    defineTool({
      name: "gws_move_org_unit",
      description: "Move a user to a different organizational unit (changes which policies apply to them).",
      input: z.object({ email, orgUnitPath: z.string().min(1) }),
      risk: "write",
      resolveTargets: accountOf,
      describe: (i) => `Move ${i.email} to org unit ${i.orgUnitPath}`,
      run: async ({ email, orgUnitPath }) => {
        await api.moveToOrgUnit(email, orgUnitPath);
        return { ok: true, user: email, orgUnitPath };
      },
    }),
    defineTool({
      name: "gws_reset_password",
      description:
        "Reset a user's password to a generated temporary password (change required at next login). The password goes to the technician, never to you. Verify the requester's identity per policy first.",
      input: z.object({ email, changeAtNextLogin: z.boolean().default(true) }),
      risk: "destructive",
      resolveTargets: accountOf,
      describe: (i) => `Reset password for ${i.email}`,
      run: async ({ email, changeAtNextLogin }) => {
        const user = await api.getUser(email);
        const password = generateTempPassword();
        await api.resetPassword(user.primaryEmail, password, changeAtNextLogin);
        return new SensitiveResult(
          { ok: true, user: user.primaryEmail, temporaryPassword: "[delivered securely to the technician]" },
          { temporaryPassword: password, primaryEmail: user.primaryEmail },
          [user.primaryEmail.toLowerCase()],
        );
      },
    }),
    defineTool({
      name: "gws_set_suspended",
      description: "Suspend (suspended=true) or restore (suspended=false) a user. Suspension blocks sign-in and is the first step of offboarding.",
      input: z.object({ email, suspended: z.boolean() }),
      risk: "destructive",
      resolveTargets: accountOf,
      describe: (i) => `${i.suspended ? "Suspend" : "Restore"} ${i.email}`,
      run: async ({ email, suspended }) => {
        await api.setSuspended(email, suspended);
        return { ok: true, user: email, suspended };
      },
    }),
    defineTool({
      name: "gws_sign_out_user",
      description: "Sign a user out of all web and device sessions and reset their sign-in cookies.",
      input: z.object({ email }),
      risk: "destructive",
      resolveTargets: accountOf,
      describe: (i) => `Sign ${i.email} out of all sessions`,
      run: async ({ email }) => {
        await api.signOut(email);
        return { ok: true, user: email, signedOut: true };
      },
    }),
  ];
}
