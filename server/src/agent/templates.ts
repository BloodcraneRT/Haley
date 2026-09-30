/**
 * Recipes: runbooks a technician starts for one client from "Ask Haley". Each one pre-fills an instruction
 * (with blank `Field:` lines to fill in), says which integrations it needs, and names the tools Haley is
 * expected to use so the library can be linted against the real tool set (see test/recipes.test.ts).
 */

export const RECIPE_CATEGORIES = [
  "Identity & access",
  "Licensing & cost",
  "Email & collaboration",
  "Security",
  "Devices",
  "RMM & endpoints",
  "Documentation & reporting",
] as const;

export type RecipeCategory = (typeof RECIPE_CATEGORIES)[number];

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  /** Pre-filled instruction the technician edits before starting. */
  instruction: string;
  category: RecipeCategory;
  /**
   * Integrations the recipe needs: every group must be satisfied by at least one of its provider ids.
   * `[["m365", "google"]]` = needs a directory; `[]` = runs for any client.
   */
  requires: string[][];
  /** Tools Haley is expected to use, read and change tools alike. Linted against the real tools. */
  tools: string[];
  /** Whether it changes customer systems; the UI suggests previewing in plan mode first. */
  changes: boolean;
  /** Conservative technician minutes to do it by hand, for time-saved reporting. */
  estimatedMinutes: number;
  tags: string[];
}

/** Every change recipe asks for the plan and a scope check before anything changes. */
const CONFIRM = `Before changing anything, state the plan: each change, the tool you'll use and the account or device it affects, with before → after. Check it matches the details above. If a detail is missing, or a name matches more than one account, group or device, stop and report the question instead of guessing.`;

const DIRECTORY = [["m365", "google"]];
const M365 = [["m365"]];
const NINJA = [["ninjaone"]];

export const TASK_TEMPLATES: TaskTemplate[] = [
  // ------------------------------------------------------------------ Identity & access
  {
    id: "onboard",
    name: "Onboard a new employee",
    description: "Create the account, license it, and add the right groups.",
    category: "Identity & access",
    requires: DIRECTORY,
    changes: true,
    estimatedMinutes: 30,
    tags: ["new hire", "new user", "create account", "starter", "joiner"],
    tools: [
      "search_knowledge_base",
      "read_knowledge_article",
      "save_knowledge_article",
      "m365_list_users",
      "m365_get_user",
      "m365_list_licenses",
      "m365_list_groups",
      "m365_create_user",
      "m365_assign_license",
      "m365_add_group_member",
      "gws_list_users",
      "gws_get_user",
      "gws_list_groups",
      "gws_list_org_units",
      "gws_create_user",
      "gws_add_group_member",
    ],
    instruction: `Onboard a new employee.
Name:
Job title:
Department:
Manager:
Start date:
Email address to create:
License: (e.g. same as others in the department)
Groups / shared mailboxes: (e.g. same as their manager, or list them)
Org unit (Google only):

Steps, in order:
1. Search the knowledge base for this client's onboarding checklist and follow it where it adds to these steps.
2. Check the email address isn't taken. For Microsoft 365, check a seat of the license is free; if none is, create nothing and report what needs to be bought.
3. If groups aren't listed, mirror the non-admin groups of a peer in the same department and say which peer you used.
4. ${CONFIRM}
5. Create the account, assign the license, then add the groups.

Don't add anyone to admin, privileged or break-glass groups (a technician does that), and don't assign licenses beyond the one above. The temporary password goes to the technician securely; never write it in the summary, a note or an article.

Report what was created, each group added or skipped and why. If this client has no onboarding checklist yet, save one as a knowledge base article titled "Onboarding checklist".`,
  },
  {
    id: "offboard",
    name: "Offboard an employee",
    description: "Block sign-in, revoke sessions, set out-of-office, remove access and reclaim licenses.",
    category: "Identity & access",
    requires: DIRECTORY,
    changes: true,
    estimatedMinutes: 30,
    tags: ["leaver", "termination", "departure", "disable user", "block sign-in", "suspend"],
    tools: [
      "search_knowledge_base",
      "m365_get_user",
      "m365_list_devices",
      "m365_set_account_enabled",
      "m365_revoke_sessions",
      "m365_set_auto_reply",
      "m365_remove_group_member",
      "m365_remove_license",
      "gws_get_user",
      "gws_set_suspended",
      "gws_sign_out_user",
      "gws_remove_group_member",
    ],
    instruction: `Offboard a departing employee.
User:
Last day:
Out-of-office points to: (name and email)
Keep the mailbox for someone else: no (if yes, who)
Reclaim licenses: yes

Steps, in order:
1. Record the user's current state first: account status, licenses, groups and managed devices. Put it in the report so every change can be reversed.
2. ${CONFIRM}
3. Block sign-in (Microsoft 365) or suspend (Google), then revoke sessions / sign them out everywhere.
4. Set an out-of-office pointing to the contact above (Microsoft 365).
5. Remove them from groups that grant access to data, apps or shared mailboxes.
6. Remove licenses last. If the mailbox must be kept, leave the Exchange license and recommend converting it to a shared mailbox (a technician does that; removing the license deletes the mailbox after 30 days).
7. List their devices with serial numbers and recommend retire (company data only) or wipe for each. Don't retire or wipe here: that always needs a technician's approval.

Don't delete the account, reset its password, or change anyone else's access.

Report a before/after table of every change, anything that failed or is waiting for approval, and the follow-ups (mailbox conversion, device returns, account deletion after the retention period).`,
  },
  {
    id: "department-transfer",
    name: "Department transfer",
    description: "Swap department groups, licenses and org unit when someone changes role.",
    category: "Identity & access",
    requires: DIRECTORY,
    changes: true,
    estimatedMinutes: 25,
    tags: ["role change", "promotion", "move department", "mover", "title change", "groups"],
    tools: [
      "m365_get_user",
      "m365_list_users",
      "m365_list_groups",
      "m365_list_licenses",
      "m365_add_group_member",
      "m365_remove_group_member",
      "m365_assign_license",
      "m365_remove_license",
      "gws_get_user",
      "gws_list_users",
      "gws_list_groups",
      "gws_list_org_units",
      "gws_add_group_member",
      "gws_remove_group_member",
      "gws_move_org_unit",
    ],
    instruction: `Move an employee to a new department or role.
User:
New department:
New job title:
New manager:
Effective date:
Groups to add: (or "same as a peer in the new department")
Groups to remove: (or "the old department's groups")
License change: none (or old SKU → new SKU)
New org unit (Google only):

Steps, in order:
1. Record the user's current groups, licenses and (Google) org unit.
2. Work out the adds and removals. If mirroring a peer, name the peer and mirror only department groups, never admin groups.
3. ${CONFIRM}
4. Add the new groups first, then remove the old department's groups.
5. For a license change, assign the new SKU before removing the old one so mail isn't interrupted.
6. Move the org unit last (Google).

Don't remove company-wide groups (all-staff, company Teams). You can't edit profile fields, so leave job title, department and manager for the technician.

Report a before/after table and the profile fields the technician still needs to update in the admin console.`,
  },
  {
    id: "password-reset",
    name: "Password reset",
    description: "Reset a verified user's password safely, with an optional sign-out everywhere.",
    category: "Identity & access",
    requires: DIRECTORY,
    changes: true,
    estimatedMinutes: 10,
    tags: ["password", "locked out", "forgot password", "reset", "sign out"],
    tools: ["m365_get_user", "m365_reset_password", "m365_revoke_sessions", "gws_get_user", "gws_reset_password", "gws_sign_out_user"],
    instruction: `Reset a user's password.
User:
Identity verified by: (how you confirmed it's really them, e.g. called back on the number in the directory)
Sign them out everywhere: no (yes if a compromise is suspected)

Steps, in order:
1. If "Identity verified by" is empty, stop and say so.
2. Look up the account. If sign-in is blocked or the account is suspended, stop: that's deliberate (offboarding or a security hold) and a reset won't help. Report it.
3. ${CONFIRM}
4. Reset the password with a change required at next sign-in, then revoke sessions / sign out if asked above.

The temporary password is delivered to the technician securely. Never put it in the summary, a note, an article or an email, and don't ask for it.

Report what was done and what to tell the user: sign in with the temporary password, choose a new one, and re-register MFA only if prompted.`,
  },
  {
    id: "mfa-reregister",
    name: "Lost or replaced phone (MFA)",
    description: "Issue a Temporary Access Pass so a user can register their new phone.",
    category: "Identity & access",
    requires: M365,
    changes: true,
    estimatedMinutes: 15,
    tags: ["mfa", "authenticator", "new phone", "temporary access pass", "tap", "2fa"],
    tools: ["m365_get_user", "m365_issue_temporary_access_pass"],
    instruction: `Help a user who lost or replaced their phone register MFA again.
User:
Identity verified by: (how you confirmed it's really them)
Pass lifetime (minutes): 60

Steps, in order:
1. If "Identity verified by" is empty, stop and say so.
2. Look up the user and list their registered MFA methods. If sign-in is blocked, stop and report it.
3. ${CONFIRM}
4. Issue a one-time Temporary Access Pass with the lifetime above.

The pass goes to the technician. Give it to the user in person or on a call to a number already on file, never by email or chat. Don't reset the password; a pass is enough to register the new phone.

Report the methods currently registered, which ones look like the old phone and should be removed in Entra (you can't remove methods), and the steps for the user at https://aka.ms/mysecurityinfo.`,
  },
  {
    id: "returning-employee",
    name: "Restore a returning employee",
    description: "Re-enable someone back from leave: sign-in, licenses, groups, out-of-office off.",
    category: "Identity & access",
    requires: DIRECTORY,
    changes: true,
    estimatedMinutes: 20,
    tags: ["leave", "rehire", "unblock", "unsuspend", "reactivate", "return"],
    tools: [
      "search_knowledge_base",
      "read_knowledge_article",
      "m365_get_user",
      "m365_list_licenses",
      "m365_list_groups",
      "m365_set_account_enabled",
      "m365_assign_license",
      "m365_add_group_member",
      "m365_set_auto_reply",
      "gws_get_user",
      "gws_list_groups",
      "gws_set_suspended",
      "gws_add_group_member",
    ],
    instruction: `Restore an employee returning from leave (or a rehire).
User:
Return date:
License: (or "what they had before")
Groups: (or "what they had before")
Approved by: (who at the client approved the return)

Steps, in order:
1. Look up the account, and search the knowledge base for their offboarding or leave record to see what was removed.
2. ${CONFIRM}
3. Unblock sign-in (Microsoft 365) or restore the account (Google).
4. Assign the license (check a seat is free first), then add the groups.
5. Turn their out-of-office off (Microsoft 365).

Don't add admin or privileged groups (a technician does that) and don't reset the password; if they need one, run the Password reset recipe next.

Report what was restored, anything from the old record you didn't restore and why.`,
  },

  // ------------------------------------------------------------------ Licensing & cost
  {
    id: "license-audit",
    name: "License audit",
    description: "Find wasted and missing licenses and estimate savings.",
    category: "Licensing & cost",
    requires: M365,
    changes: false,
    estimatedMinutes: 45,
    tags: ["licenses", "seats", "cost", "savings", "sku", "audit"],
    tools: ["m365_list_licenses", "m365_list_users", "save_knowledge_article"],
    instruction: `Audit licensing for this organization.
Price per seat (optional, e.g. SPE_E3 = $36):

Report:
- seats purchased vs. assigned per SKU, and unused seats;
- licenses assigned to blocked accounts;
- enabled users with no license (flag the ones that look like shared mailboxes, rooms or service accounts separately: they often don't need one);
- users holding two overlapping SKUs (e.g. Business Premium and E3).

Don't change anything; recommend actions, with the monthly saving for each if prices are given. Save the findings as a knowledge base article titled "License audit - <today's date>".`,
  },
  {
    id: "license-reclaim",
    name: "Reclaim licenses from blocked accounts",
    description: "Remove licenses still held by accounts that can't sign in.",
    category: "Licensing & cost",
    requires: M365,
    changes: true,
    estimatedMinutes: 30,
    tags: ["licenses", "cleanup", "blocked", "disabled", "cost", "reclaim"],
    tools: ["search_knowledge_base", "m365_list_users", "m365_get_user", "m365_list_licenses", "m365_remove_license"],
    instruction: `Reclaim licenses held by accounts whose sign-in is blocked.
Accounts to leave alone: (e.g. accounts on leave, legal hold; list any)
Licenses to reclaim: all (or list SKUs)
Price per seat (optional):

Steps, in order:
1. List users and find blocked accounts that still hold licenses.
2. Leave out the accounts listed above and anything that looks like a shared mailbox, room, equipment or service account: shared mailboxes with an archive or over 50 GB need their license, and you can't see mailbox size. Flag those instead.
3. Check the knowledge base for notes about people on leave or legal hold and leave them out too.
4. ${CONFIRM}
5. Remove only the licenses in the plan.

Don't unblock, delete or change the groups of any account, and never remove licenses from enabled accounts.

Report the seats freed per SKU, the accounts skipped and why, and the monthly saving if a price is given.`,
  },
  {
    id: "unused-seats",
    name: "Unused license seats",
    description: "Seats paid for but not assigned, per SKU, with a cost estimate.",
    category: "Licensing & cost",
    requires: M365,
    changes: false,
    estimatedMinutes: 15,
    tags: ["licenses", "seats", "unassigned", "renewal", "cost"],
    tools: ["m365_list_licenses", "m365_list_users"],
    instruction: `Report unused license seats for this organization.
Price per seat (optional):
Renewal date (optional):

For each SKU list purchased, assigned and unused seats. Treat free or trial SKUs (e.g. FLOW_FREE, POWER_BI_STANDARD) separately and don't count them as waste. Compare with how many enabled users have no license, so seats that are about to be needed aren't cancelled.

Don't change anything. Recommend how many seats to drop at renewal and the monthly saving if prices are given.`,
  },
  {
    id: "license-assign",
    name: "Assign a license",
    description: "License a user after checking a seat is free.",
    category: "Licensing & cost",
    requires: M365,
    changes: true,
    estimatedMinutes: 10,
    tags: ["license", "assign", "seat", "sku", "add license"],
    tools: ["m365_get_user", "m365_list_licenses", "m365_assign_license"],
    instruction: `Assign a license to a user.
User:
License: (SKU, e.g. O365_BUSINESS_PREMIUM, or "same as their department")
Approved by: (who at the client approved the cost)

Steps, in order:
1. Look up the user. Their usage location must be set before a license can be assigned; if it's empty, stop and report it.
2. If they already hold this SKU, change nothing and say so.
3. Check a seat is free. If none is, don't remove a license from anyone else: report how many to buy.
4. ${CONFIRM}
5. Assign the license.

Report what was assigned and how many seats of that SKU are left.`,
  },

  // ------------------------------------------------------------------ Email & collaboration
  {
    id: "access-request",
    name: "Shared mailbox or group access",
    description: "Give someone access to a shared mailbox, group, distribution list or team.",
    category: "Email & collaboration",
    requires: DIRECTORY,
    changes: true,
    estimatedMinutes: 10,
    tags: ["shared mailbox", "distribution list", "group", "teams", "permissions", "access"],
    tools: ["m365_get_user", "m365_list_groups", "m365_add_group_member", "gws_get_user", "gws_list_groups", "gws_add_group_member"],
    instruction: `Give a user access to a group, shared mailbox, distribution list or team.
User:
Access to: (group or shared mailbox name or email)
Role (Google groups only): MEMBER
Approved by: (who at the client approved it)
Until: (leave empty if permanent)

Steps, in order:
1. Find the user and the group. Shared mailbox access is granted through the mailbox's access group; if more than one group could be it, stop and list the candidates.
2. If the user is already a member, change nothing and say so.
3. ${CONFIRM}
4. Add them.

Don't add anyone to admin, privileged or break-glass groups (that's always a technician's call) and don't change other members.

Report what was granted and who approved it. If there's an end date, remind the technician to remove the access then (use the "Remove access" recipe, or schedule it).`,
  },
  {
    id: "access-remove",
    name: "Remove access",
    description: "Take someone out of a shared mailbox, group, distribution list or team.",
    category: "Email & collaboration",
    requires: DIRECTORY,
    changes: true,
    estimatedMinutes: 10,
    tags: ["remove access", "revoke", "group", "shared mailbox", "permissions"],
    tools: ["m365_get_user", "m365_list_groups", "m365_remove_group_member", "gws_get_user", "gws_list_groups", "gws_remove_group_member"],
    instruction: `Remove a user's access to a group, shared mailbox, distribution list or team.
User:
Remove from: (group or shared mailbox name or email, or "all groups granting access to X")
Requested by:

Steps, in order:
1. Look up the user's current groups and find the ones to remove. If a name matches more than one group, stop and list them.
2. If they aren't a member, change nothing and say so.
3. ${CONFIRM}
4. Remove them.

Don't block the account, remove licenses or touch other members.

Report each group removed, and anything that looks like it still grants the same access (e.g. a nested or department group) for the technician to check.`,
  },
  {
    id: "out-of-office",
    name: "Out-of-office for an absent user",
    description: "Turn automatic replies on (or off) for someone who can't do it themselves.",
    category: "Email & collaboration",
    requires: M365,
    changes: true,
    estimatedMinutes: 5,
    tags: ["out of office", "ooo", "auto reply", "automatic replies", "leave", "vacation"],
    tools: ["m365_get_user", "m365_set_auto_reply"],
    instruction: `Set automatic replies for a user who is away.
User:
On or off: on
Away until:
Contact instead: (name and email)
Requested by: (their manager or the user)
Message: (leave empty and I'll write a short, neutral one)

Steps, in order:
1. Look up the user.
2. Write the internal and external messages. Keep the external one brief: no reason for the absence, no personal details, just the return date and the contact.
3. ${CONFIRM}
4. Set the automatic replies.

Don't change anything else on the mailbox and don't forward their mail.

Report the exact messages set and remind the technician that automatic replies stay on until someone turns them off.`,
  },
  {
    id: "health-check",
    name: "Service health check",
    description: "Check for active Microsoft 365 incidents affecting the client.",
    category: "Email & collaboration",
    requires: M365,
    changes: false,
    estimatedMinutes: 10,
    tags: ["outage", "incident", "service health", "exchange", "teams", "status"],
    tools: ["m365_service_health", "search_knowledge_base"],
    instruction: `Check the current health of this organization's Microsoft 365 services.

Summarize any degraded services, who is likely affected (e.g. everyone using Teams, or only mobile mail), and a suggested message to send users if an incident is active. If everything is healthy, say so in one line.

Don't change anything.`,
  },
  {
    id: "group-inventory",
    name: "Group & shared mailbox inventory",
    description: "List every group and shared mailbox with its likely purpose.",
    category: "Email & collaboration",
    requires: DIRECTORY,
    changes: false,
    estimatedMinutes: 30,
    tags: ["groups", "distribution lists", "shared mailboxes", "inventory", "cleanup"],
    tools: ["m365_list_groups", "gws_list_groups", "search_knowledge_base", "save_knowledge_article"],
    instruction: `Inventory this organization's groups and shared mailboxes.

List each group with its type (Microsoft 365, security, distribution, Google group), email address, and likely purpose based on its name. Flag groups that look like duplicates, test groups, or that grant admin rights.

Don't change anything. Save the inventory as a knowledge base article titled "Group inventory" (update it if it exists).`,
  },

  // ------------------------------------------------------------------ Security
  {
    id: "security-review",
    name: "Security posture review",
    description: "MFA/2SV gaps, admin sprawl, stale accounts, non-compliant devices.",
    category: "Security",
    requires: DIRECTORY,
    changes: false,
    estimatedMinutes: 60,
    tags: ["security", "posture", "mfa", "admins", "compliance", "risk"],
    tools: [
      "m365_list_users",
      "m365_get_user",
      "m365_list_groups",
      "m365_list_devices",
      "gws_list_users",
      "gws_list_groups",
      "search_knowledge_base",
      "save_knowledge_article",
    ],
    instruction: `Review this organization's identity security posture. Check for users without MFA / 2-Step Verification, admin accounts, accounts that are enabled but look stale, blocked accounts that still hold access, and non-compliant or long-unsynced devices.

Don't change anything. Rank findings by risk with a concrete fix for each and save the report as a knowledge base article titled "Security review - <today's date>".`,
  },
  {
    id: "mfa-gaps",
    name: "MFA / 2-Step Verification gaps",
    description: "Enabled users with no MFA method or 2SV enrollment, admins first.",
    category: "Security",
    requires: DIRECTORY,
    changes: false,
    estimatedMinutes: 30,
    tags: ["mfa", "2sv", "2fa", "authenticator", "security", "report"],
    tools: ["m365_list_users", "m365_get_user", "m365_list_groups", "gws_list_users", "save_knowledge_article"],
    instruction: `Find enabled accounts that aren't protected by MFA / 2-Step Verification.

Microsoft 365: check each enabled, licensed user's registered methods; count only real second factors (Authenticator app, phone, FIDO2 key, Windows Hello), not a password or email. Google: use the 2SV enrollment flag.
List admins and members of admin-named groups first, then everyone else. Ignore blocked or suspended accounts. Note weak-only setups (SMS only) separately.

Don't change anything and don't contact users. Report counts, the list, and a rollout suggestion. Save it as a knowledge base article titled "MFA gaps - <today's date>".`,
  },
  {
    id: "admin-review",
    name: "Admin access review",
    description: "Who holds admin rights, and whether they should.",
    category: "Security",
    requires: DIRECTORY,
    changes: false,
    estimatedMinutes: 30,
    tags: ["admins", "privileged", "roles", "least privilege", "access review"],
    tools: ["m365_list_groups", "m365_list_users", "m365_get_user", "gws_list_users", "gws_get_user"],
    instruction: `Review who has admin access in this organization.

Google: list users flagged as admins. Microsoft 365: list role-assignable groups and groups named for admins, privileged access or break-glass, and which users belong to them. Directly assigned Entra roles aren't visible to you, so tell the technician to check Entra → Roles and admins as well.
For each admin: is the account enabled, does it have MFA, is it a separate admin account or someone's everyday account, and does their title suggest they need it.

Don't change anything. Report findings ranked by risk (e.g. everyday accounts with admin rights, admins without MFA, blocked admins still in admin groups) with a recommendation for each.`,
  },
  {
    id: "stale-accounts",
    name: "Stale and orphaned accounts",
    description: "Enabled accounts that look unused, and blocked ones that still hold access.",
    category: "Security",
    requires: DIRECTORY,
    changes: false,
    estimatedMinutes: 30,
    tags: ["stale", "inactive", "unused accounts", "orphaned", "cleanup", "last login"],
    tools: ["gws_list_users", "gws_get_user", "m365_list_users", "m365_get_user", "m365_list_devices"],
    instruction: `Find accounts that are probably no longer used.
Inactive for more than: 60 days

Google: enabled users whose last login is older than the threshold (or never). Microsoft 365: sign-in activity isn't visible to you, so list candidates instead: enabled accounts with no license, no groups and no devices, or with names like test, temp, old or former. Say these need confirming against the sign-in logs.
Also list blocked or suspended accounts that are still in groups or hold licenses.

Don't block, suspend or change anything. Report each account with why it's flagged and a suggested action (confirm with the client, then offboard).`,
  },
  {
    id: "compromised-account",
    name: "Suspected compromised account",
    description: "Contain a possibly compromised account: block, sign out, reset, review.",
    category: "Security",
    requires: DIRECTORY,
    changes: true,
    estimatedMinutes: 30,
    tags: ["compromise", "phishing", "hacked", "breach", "incident response", "revoke sessions"],
    tools: [
      "m365_get_user",
      "m365_list_devices",
      "m365_set_account_enabled",
      "m365_revoke_sessions",
      "m365_reset_password",
      "gws_get_user",
      "gws_set_suspended",
      "gws_sign_out_user",
      "gws_reset_password",
    ],
    instruction: `Contain a possibly compromised account.
User:
What happened: (e.g. sent phishing, reported an MFA prompt they didn't make)
Reported by:

Steps, in order:
1. Record the account's current state: status, groups, registered MFA methods and devices.
2. ${CONFIRM}
3. Block sign-in (Microsoft 365) or suspend (Google).
4. Revoke all sessions / sign out everywhere.
5. Reset the password. The temporary password goes to the technician securely; don't write it anywhere.

Leave the account blocked: a technician unblocks it after confirming the user's devices are clean. Don't delete anything or change other accounts.

Report a timeline of what you did, MFA methods or group memberships that look unexpected, and the checks the technician must do in the admin portals because you can't see them: sign-in logs, inbox forwarding and rules, app consents, and messages sent from the account.`,
  },

  // ------------------------------------------------------------------ Devices
  {
    id: "lost-device",
    name: "Lost or stolen device",
    description: "Sign the owner out and request a wipe or retire; always needs a technician.",
    category: "Devices",
    requires: M365,
    changes: true,
    estimatedMinutes: 20,
    tags: ["lost", "stolen", "wipe", "retire", "intune", "laptop", "phone"],
    tools: ["m365_get_user", "m365_list_devices", "m365_get_device", "m365_revoke_sessions", "m365_wipe_device", "m365_retire_device"],
    instruction: `Respond to a lost or stolen device.
User:
Device: (name or serial, or "their laptop")
Company-owned or personal: company-owned
Action: wipe (company-owned) or retire (personal: removes company data only)

Steps, in order:
1. Find the device and confirm it's the right one: owner, model, serial and last check-in. If the user has several devices that could match, stop and list them.
2. ${CONFIRM}
3. Revoke the owner's sessions so the device loses access to email and files.
4. Request the wipe or retire above. It always waits for a technician's approval; that's expected.

Don't reset the password unless a compromise is suspected, and don't touch the user's other devices.

Report the device details, what was requested, whether it's awaiting approval, and follow-ups: a police report or insurance claim if stolen, and removing the device from Intune and Autopilot once the wipe completes.`,
  },
  {
    id: "bitlocker-recovery",
    name: "BitLocker recovery key",
    description: "Get a Windows device's recovery key to the technician, matched to the key ID on screen.",
    category: "Devices",
    requires: M365,
    changes: true,
    estimatedMinutes: 10,
    tags: ["bitlocker", "recovery key", "encryption", "locked laptop", "windows"],
    tools: ["m365_list_devices", "m365_get_device", "m365_get_bitlocker_key"],
    instruction: `Retrieve the BitLocker recovery key for a user's device.
User:
Device: (name or serial; leave empty if they only have one Windows device)
Key ID shown on screen: (first 8 characters)

Steps, in order:
1. Find the device and confirm it belongs to the user above.
2. ${CONFIRM}
3. Retrieve the recovery key.

The key goes to the technician privately. Never write it in the summary, a note, an article or an email; read it to the user over the phone. If none of the escrowed key IDs match the one on screen, say so instead of giving a different key.

Report the device, which key ID matched, and a suggestion to find out why recovery triggered (BIOS or firmware update, TPM change, docking station) if it keeps happening.`,
  },
  {
    id: "noncompliant-devices",
    name: "Non-compliant devices",
    description: "Devices failing Intune compliance or encryption, with the likely reason.",
    category: "Devices",
    requires: M365,
    changes: false,
    estimatedMinutes: 20,
    tags: ["compliance", "intune", "encryption", "os version", "report"],
    tools: ["m365_list_devices", "m365_get_device"],
    instruction: `Report this organization's non-compliant devices.

For each device that isn't compliant, or isn't encrypted, give the owner, OS and version, last check-in and the likely reason (outdated OS, not encrypted, low storage, hasn't checked in). Group them by reason and suggest a fix for each group.

Don't sync, restart or change any device.`,
  },
  {
    id: "stale-devices",
    name: "Stale devices (no check-in 30+ days)",
    description: "Devices that stopped checking in, for clean-up or follow-up.",
    category: "Devices",
    requires: M365,
    changes: false,
    estimatedMinutes: 20,
    tags: ["stale", "inactive devices", "intune", "cleanup", "last sync"],
    tools: ["m365_list_devices", "m365_get_user", "ninja_list_devices"],
    instruction: `Find devices that haven't checked in recently.
Not synced for more than: 30 days

List Intune devices whose last sync is older than the threshold, with the owner, OS, model and whether the owner's account is still enabled. If NinjaOne is connected, say whether the same machine is still reporting there (it may just have lost Intune enrollment).

Don't retire, wipe or delete anything. Suggest an action per device: contact the owner, re-enroll, or retire (a technician approves every retire).`,
  },
  {
    id: "intune-remediation",
    name: "Run an Intune remediation",
    description: "Fix a user's device with one of the tenant's existing remediation scripts.",
    category: "Devices",
    requires: M365,
    changes: true,
    estimatedMinutes: 15,
    tags: ["intune", "remediation", "script", "fix", "teams cache", "print spooler"],
    tools: ["m365_list_devices", "m365_get_device", "m365_list_remediations", "m365_run_remediation", "m365_sync_device"],
    instruction: `Run an Intune remediation on a user's device.
User:
Device: (leave empty if they have one Windows device)
Problem: (e.g. Teams won't load, printing stuck)
Remediation: (leave empty and I'll pick the matching existing one)

Steps, in order:
1. Find the device and check it has checked in recently; a device that's offline won't run anything.
2. Pick the remediation from the tenant's existing list. If none clearly fits the problem, stop and say so; don't use a loosely related one.
3. ${CONFIRM}
4. Run the remediation, then request a sync so the result reports sooner.

Don't restart, retire or wipe the device.

Report what ran, where to see the result in Intune, and what to try next if it doesn't fix the problem.`,
  },
  {
    id: "software-check",
    name: "Is an app installed?",
    description: "Check which devices have an app, and which version.",
    category: "Devices",
    requires: M365,
    changes: false,
    estimatedMinutes: 30,
    tags: ["software", "apps", "installed", "version", "inventory"],
    tools: ["m365_list_devices", "m365_get_device"],
    instruction: `Check which devices have an application installed.
App: (e.g. Adobe Acrobat Reader)
Users or devices: all (or list them)
Minimum version: (optional)

Look at the installed apps on each device in scope and list where the app is present, its version, and whether it meets the minimum. List devices without it too. For more than 50 devices, check the ones in scope that are Windows or macOS and say how many you skipped.

Don't install, update or remove anything.`,
  },

  // ------------------------------------------------------------------ RMM & endpoints (NinjaOne)
  {
    id: "ninja-alert-triage",
    name: "NinjaOne alert triage",
    description: "Group active alerts by cause, rank them, and suggest the fix for each.",
    category: "RMM & endpoints",
    requires: NINJA,
    changes: false,
    estimatedMinutes: 20,
    tags: ["alerts", "ninjaone", "rmm", "monitoring", "triage"],
    tools: ["ninja_list_alerts", "ninja_list_devices", "ninja_get_device", "ninja_list_scripts", "search_knowledge_base"],
    instruction: `Triage this client's active NinjaOne alerts.

Group the alerts by cause (disk space, offline, patching, AV, performance…), then rank them: servers and alerts affecting many devices first. For the top ones, look at the device for context (last contact, disk, pending reboot) and check the knowledge base for a known fix.

Don't run scripts or reboot anything. For each group, report the likely cause, the recommended fix, and the existing NinjaOne script that would do it (if there is one), so a technician can run it with the "Run a NinjaOne script" recipe.`,
  },
  {
    id: "ninja-patch-report",
    name: "Patch status report",
    description: "Pending OS patches and reboots across the client's devices.",
    category: "RMM & endpoints",
    requires: NINJA,
    changes: false,
    estimatedMinutes: 30,
    tags: ["patching", "updates", "windows update", "ninjaone", "reboot", "report"],
    tools: ["ninja_list_devices", "ninja_get_device", "save_knowledge_article"],
    instruction: `Report patch status for this client's devices in NinjaOne.

For each online device, list pending OS patches (count and the critical/security ones by KB), whether a reboot is pending, and the last boot time. List offline devices separately with last contact, since their patch state is unknown. Highlight servers and anything missing security patches.

Don't install patches or reboot anything. Save the report as a knowledge base article titled "Patch status - <today's date>".`,
  },
  {
    id: "low-disk-cleanup",
    name: "Low disk space cleanup",
    description: "Find devices low on disk and run the MSP's existing cleanup script on them.",
    category: "RMM & endpoints",
    requires: NINJA,
    changes: true,
    estimatedMinutes: 20,
    tags: ["disk space", "cleanup", "storage", "ninjaone", "script", "full disk"],
    tools: ["ninja_list_alerts", "ninja_list_devices", "ninja_get_device", "ninja_list_scripts", "ninja_run_script"],
    instruction: `Free up disk space on devices that are running low.
Devices: all with low disk (or list them)
Low means less than: 10% or 10 GB free on the system drive
Cleanup script: (leave empty and I'll pick the existing cleanup script)

Steps, in order:
1. Find the devices under the threshold from disk alerts and device volumes. Only online workstations are in scope; list servers and offline devices separately without touching them.
2. Pick the MSP's existing disk cleanup script. If there isn't one, stop and report the devices.
3. ${CONFIRM}
4. Run the script on each device in the plan.

Don't delete user files, reboot devices or run any other script.

Report free space before for each device, which ones the script ran on, and that the technician should re-check free space in NinjaOne once it finishes.`,
  },
  {
    id: "ninja-run-script",
    name: "Run a NinjaOne script",
    description: "Run one of the MSP's existing automation scripts on a device.",
    category: "RMM & endpoints",
    requires: NINJA,
    changes: true,
    estimatedMinutes: 10,
    tags: ["script", "automation", "ninjaone", "rmm", "fix"],
    tools: ["ninja_get_device", "ninja_list_scripts", "ninja_run_script"],
    instruction: `Run an existing NinjaOne script on a device.
Device:
Script: (name, or describe what it should do)
Parameters: (if any)
Run as: system

Steps, in order:
1. Find the device and check it's online.
2. Find the script. If it isn't clearly the right one, list the closest matches and stop.
3. ${CONFIRM}
4. Run it.

Don't write or modify scripts, and don't reboot the device. Scripts that remove or disable things always wait for a technician.

Report what ran and where to see the result in NinjaOne.`,
  },
  {
    id: "offline-devices",
    name: "Offline devices report",
    description: "Which machines are offline, since when, and whose they are.",
    category: "RMM & endpoints",
    requires: NINJA,
    changes: false,
    estimatedMinutes: 15,
    tags: ["offline", "ninjaone", "devices", "last contact", "report"],
    tools: ["ninja_list_devices", "ninja_get_device", "ninja_list_alerts"],
    instruction: `Report this client's offline devices in NinjaOne.

List each offline device with its type, last contact and last logged-in user. Group them: servers and network devices first (likely an outage), then workstations offline under 7 days (probably just switched off), then over 30 days (candidates for retirement).

Don't reboot or run anything. Suggest a next step per group.`,
  },

  // ------------------------------------------------------------------ Documentation & reporting
  {
    id: "document",
    name: "Document the environment",
    description: "Generate an up-to-date environment overview for the client.",
    category: "Documentation & reporting",
    requires: DIRECTORY,
    changes: false,
    estimatedMinutes: 90,
    tags: ["documentation", "environment", "overview", "handover", "inventory"],
    tools: [
      "m365_list_users",
      "m365_list_licenses",
      "m365_list_groups",
      "m365_list_devices",
      "gws_list_users",
      "gws_list_groups",
      "gws_list_org_units",
      "ninja_list_devices",
      "itglue_search_documents",
      "hudu_search_articles",
      "search_knowledge_base",
      "read_knowledge_article",
      "save_knowledge_article",
      "remember_for_client",
    ],
    instruction: `Create or update the environment documentation for this organization: tenant/domain details, license inventory, group and shared-mailbox inventory with purpose, org units or departments, admin accounts, device fleet summary, and anything unusual a new technician should know. Save it as a knowledge base article titled "Environment overview" (update the existing one if present).

Don't include passwords, keys or personal details beyond names and roles. Remember one or two short facts for this client that would help on future tickets, if you find any.`,
  },
  {
    id: "find-procedure",
    name: "Find the documented procedure",
    description: "Search the knowledge base, IT Glue and Hudu for how this client does X.",
    category: "Documentation & reporting",
    requires: [],
    changes: false,
    estimatedMinutes: 10,
    tags: ["runbook", "procedure", "how to", "it glue", "hudu", "documentation", "search"],
    tools: ["search_knowledge_base", "read_knowledge_article", "itglue_search_documents", "itglue_get_document", "hudu_search_articles", "hudu_get_article"],
    instruction: `Find this client's documented procedure for:
Topic: (e.g. VPN setup for new laptops, printer mapping, line-of-business app install)

Search the knowledge base, and IT Glue or Hudu if connected. Read the best matches and summarize the steps, noting which document each came from and when it was last updated if shown. If the documents disagree or look out of date, say so.

Don't follow the procedure or change anything. Never read or repeat passwords. If nothing is documented, say so and suggest what the article should cover.`,
  },
  {
    id: "docs-reconcile",
    name: "Documented vs. managed devices",
    description: "Compare IT Glue / Hudu assets with devices in Intune or NinjaOne.",
    category: "Documentation & reporting",
    requires: [
      ["itglue", "hudu"],
      ["m365", "ninjaone"],
    ],
    changes: false,
    estimatedMinutes: 45,
    tags: ["documentation", "assets", "configurations", "inventory", "reconcile", "it glue", "hudu"],
    tools: ["itglue_list_configurations", "hudu_search_assets", "m365_list_devices", "ninja_list_devices", "save_knowledge_article"],
    instruction: `Compare the devices documented in IT Glue or Hudu with the devices actually managed in Intune or NinjaOne.

Match by name or serial. List: managed devices that aren't documented, documented devices that no longer appear in management (retired, lost, or renamed), and name or owner mismatches.

Don't change the documentation or any device. Save the result as a knowledge base article titled "Documentation gaps - <today's date>" so a technician can update IT Glue or Hudu.`,
  },
  {
    id: "monthly-report",
    name: "Monthly client health report",
    description: "One-page summary of identity, licensing, devices and alerts for a client review.",
    category: "Documentation & reporting",
    requires: DIRECTORY,
    changes: false,
    estimatedMinutes: 60,
    tags: ["report", "monthly", "qbr", "health", "summary", "client review"],
    tools: [
      "m365_list_users",
      "m365_get_user",
      "m365_list_licenses",
      "m365_list_devices",
      "m365_service_health",
      "gws_list_users",
      "ninja_list_devices",
      "ninja_list_alerts",
      "search_knowledge_base",
      "save_knowledge_article",
    ],
    instruction: `Write this month's health report for this client, suitable to share with their office manager.

Cover, using whatever is connected: user count and changes, license use and waste, MFA / 2SV coverage, device compliance and stale devices, NinjaOne alerts and offline devices, and any service incidents. Keep it plain-language, one page, with three recommended actions at the top.

Don't change anything. Save it as a knowledge base article titled "Health report - <month year>".`,
  },
  {
    id: "new-hire-kb",
    name: "Write the new-hire checklist",
    description: "Turn the client's actual setup into an onboarding checklist article.",
    category: "Documentation & reporting",
    requires: DIRECTORY,
    changes: false,
    estimatedMinutes: 45,
    tags: ["onboarding", "checklist", "knowledge base", "runbook", "new hire"],
    tools: [
      "m365_list_users",
      "m365_list_groups",
      "m365_list_licenses",
      "gws_list_users",
      "gws_list_groups",
      "gws_list_org_units",
      "search_knowledge_base",
      "read_knowledge_article",
      "save_knowledge_article",
    ],
    instruction: `Write a client-specific new-hire checklist.

Look at how existing users are set up: which license each department uses, which groups and shared mailboxes everyone has, and which ones are department-specific (Google: which org unit). Read any existing onboarding notes in the knowledge base.

Save a knowledge base article titled "Onboarding checklist" (update it if it exists) with: information to collect, the account naming convention, license per department, default groups, department groups, and steps you can't do (hardware, line-of-business apps) left for a technician. Don't create users or change anything.`,
  },
];

export interface TemplateAvailability {
  available: boolean;
  /** One entry per unmet requirement, e.g. "Microsoft 365" or "Microsoft 365 or Google Workspace". */
  missing: string[];
}

/** Whether a client with integrations for `providers` can run the recipe, and what it lacks. */
export function templateAvailability(template: TaskTemplate, providers: Iterable<string>, nameOf: (id: string) => string): TemplateAvailability {
  const have = new Set(providers);
  const missing = template.requires.filter((group) => !group.some((id) => have.has(id))).map((group) => group.map(nameOf).join(" or "));
  return { available: missing.length === 0, missing };
}
