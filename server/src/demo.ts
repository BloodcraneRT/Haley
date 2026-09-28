import type { Store } from "./store.js";

const GLOBAL_ARTICLES = [
  {
    title: "Runbook: Password reset requests",
    tags: ["runbook", "account-access"],
    body: `## When to use
A user is locked out, forgot their password, or their password expired.

## Verify identity first
- The request must come from the user themselves (from their own mailbox or phone number on file), their manager, or the client's named IT contact.
- Never reset based on a request from an external or personal email address.

## Steps
1. Confirm the account exists and whether sign-in is blocked (blocked accounts are usually intentional; check with the client before unblocking).
2. Reset to a temporary password and require change at next sign-in.
3. If compromise is suspected (unexpected MFA prompts, mail rules, sign-ins from abroad), also revoke sessions and escalate as a security incident.
4. The technician delivers the temporary password by phone or SMS, never by email to the same mailbox.`,
  },
  {
    title: "Runbook: Employee offboarding",
    tags: ["runbook", "offboarding"],
    body: `## Order matters
1. Block sign-in / suspend the account.
2. Revoke all sessions.
3. Set an out-of-office pointing to the replacement contact.
4. Remove from groups that grant access to data or apps.
5. Remove licenses (Microsoft keeps the mailbox for 30 days after license removal; convert to a shared mailbox first if the client wants to retain it).
6. Record every change on the ticket so it can be reversed if the departure is rescinded.`,
  },
  {
    title: "Runbook: New employee onboarding",
    tags: ["runbook", "onboarding"],
    body: `## Information needed
Name, job title, department, start date, manager, and license tier.

## Steps
1. Create the account with a temporary password (change at first sign-in) and the correct usage location.
2. Assign the license used by peers in the same department, checking seat availability first. If no seats are free, escalate for purchasing.
3. Add the same groups / shared mailboxes as a peer in the department unless the request lists them.
4. Reply to the requester with the username and start-day instructions; the technician delivers the temporary password separately.`,
  },
];

/** Creates a ready-to-explore workspace: two sandbox clients, sample tickets and global runbooks. */
export function seedDemo(store: Store): { orgIds: string[] } {
  const contoso = store.createOrg({
    name: "Contoso Ltd",
    domain: "contoso.example",
    autonomy: "supervised",
    notes:
      "Main contact: Grady Archie (IT Coordinator). Finance data is sensitive: any change to Finance group membership must be approved by Lynne Robbins. Office hours 8-5 ET.",
  });
  store.createIntegration({ orgId: contoso.id, provider: "m365", label: "Contoso Microsoft 365", mode: "sandbox", config: { domain: "contoso.example" } });

  const acme = store.createOrg({
    name: "Acme Health Clinic",
    domain: "acme-health.example",
    autonomy: "autonomous",
    notes: "HIPAA-covered entity. Clinical staff belong in /Staff/Clinical. Practice manager and IT contact: Maria Lopez.",
  });
  store.createIntegration({ orgId: acme.id, provider: "google", label: "Acme Google Workspace", mode: "sandbox", config: { domain: "acme-health.example" } });

  for (const a of GLOBAL_ARTICLES) store.saveArticle({ orgId: null, ...a, source: "manual" });

  store.createTicket({
    orgId: contoso.id,
    title: "Isaiah can't get into email after returning from leave",
    description: "Hi, this is Grady. Isaiah Langer is back from leave today and says his password doesn't work anymore and Outlook keeps prompting. Can you help him get back in? He's at his desk, ext 4411.",
    requesterName: "Grady Archie",
    requesterEmail: "grady.archie@contoso.example",
    priority: "high",
  });
  store.createTicket({
    orgId: contoso.id,
    title: "Add Alex to the AP mailbox",
    description: "Alex Wilber is covering accounts payable while Lynne is out next week, please give him access to the AP mailbox. Lynne approved this. - Grady",
    requesterName: "Grady Archie",
    requesterEmail: "grady.archie@contoso.example",
  });
  store.createTicket({
    orgId: contoso.id,
    title: "Is email down?",
    description: "Several people say Outlook is slow and some emails are delayed by 20+ minutes. Is something going on?",
    requesterName: "Megan Bowen",
    requesterEmail: "megan.bowen@contoso.example",
    priority: "high",
  });
  store.createTicket({
    orgId: acme.id,
    title: "New hire starting Monday - Dana Whitfield (RN)",
    description: "Dana Whitfield is joining as a registered nurse on Monday. Please set up her account like Sam Chen's. Thanks! - Maria",
    requesterName: "Maria Lopez",
    requesterEmail: "maria@acme-health.example",
  });

  store.audit({ actor: "system", action: "demo.seeded", detail: { orgs: [contoso.id, acme.id] } });
  return { orgIds: [contoso.id, acme.id] };
}
