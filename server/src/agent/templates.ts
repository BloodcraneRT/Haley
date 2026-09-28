export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  /** Pre-filled instruction the technician edits before starting. */
  instruction: string;
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "onboard",
    name: "Onboard a new employee",
    description: "Create the account, license it, and add the right groups.",
    instruction: `Onboard a new employee.
Name:
Job title:
Department:
Start date:
Email address to create:
License: (e.g. same as others in the department)
Groups / shared mailboxes: (e.g. same as their manager, or list them)
Manager:

Mirror access from a peer in the same department if groups aren't specified, and tell me which peer you used. Document the onboarding in the knowledge base as a client-specific checklist if one doesn't exist yet.`,
  },
  {
    id: "offboard",
    name: "Offboard an employee",
    description: "Block sign-in, revoke sessions, set out-of-office, reclaim licenses.",
    instruction: `Offboard a departing employee.
User:
Last day:
Forward email / out-of-office message to:
Reclaim licenses: yes

Standard order: block sign-in (or suspend), revoke sessions, set an out-of-office pointing to the contact above, remove from groups that grant access, then remove licenses. Record exactly what was changed so it can be reversed.`,
  },
  {
    id: "license-audit",
    name: "License audit",
    description: "Find wasted and missing licenses and estimate savings.",
    instruction: `Audit licensing for this organization. Report seats purchased vs. used per SKU, licenses assigned to blocked/suspended or inactive accounts, and active users with no license. Don't change anything; recommend actions. Save the findings as a knowledge base article titled "License audit - <today's date>".`,
  },
  {
    id: "security-review",
    name: "Security posture review",
    description: "MFA/2SV gaps, admin sprawl, stale accounts, non-compliant devices.",
    instruction: `Review this organization's identity security posture. Check for users without MFA / 2-Step Verification, admin accounts, accounts that are enabled but look stale, blocked accounts that still hold access, and non-compliant or long-unsynced devices. Don't change anything. Rank findings by risk with a concrete fix for each and save the report as a knowledge base article titled "Security review - <today's date>".`,
  },
  {
    id: "document",
    name: "Document the environment",
    description: "Generate an up-to-date environment overview for the client.",
    instruction: `Create or update the environment documentation for this organization: tenant/domain details, license inventory, group and shared-mailbox inventory with purpose, org units or departments, admin accounts, device fleet summary, and anything unusual a new technician should know. Save it as a knowledge base article titled "Environment overview" (update the existing one if present).`,
  },
  {
    id: "health-check",
    name: "Service health check",
    description: "Check for active incidents affecting the client.",
    instruction: `Check the current health of this organization's cloud services. Summarize any degraded services, who is likely affected, and a suggested message to send to users if an incident is active.`,
  },
];
