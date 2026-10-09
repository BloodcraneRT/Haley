# Haley's trust model

This page describes exactly what Haley can do on her own, what she can't, and why. MSPs can share it with a client's security team. The authority is the code: `server/src/agent/policy.ts` decides every call, and `server/test/unit.test.ts` and `server/test/devices-policy.test.ts` pin the rules.

## Four inputs to every decision

Every tool call Haley makes is judged on:

1. **Risk of the tool**:
   - `read`: no side effects.
   - `internal`: writes only inside Haley (ticket fields, notes, replies, knowledge base).
   - `write`: routine and reversible changes to a customer system, such as licenses, groups, new users and out-of-office.
   - `destructive`: security-sensitive or hard to undo, such as password resets, Temporary Access Passes, BitLocker recovery keys, blocking sign-in, revoking sessions, suspending users, and restarting, retiring or wiping devices.

   Tools that grant access to data (group or shared mailbox membership) are also marked as *access grants*.
2. **The client's autonomy policy**: read only, supervised, autonomous or unattended.
3. **Who is asking, and how sure Haley is of it**: the identity assurance level (below), and whether the requester is an *authorized approver* for the client, such as a manager or the IT contact.
4. **Whose account is affected**: the requester's own, someone else's, or a *protected account*.

Calls that don't pass never fail silently. They go to the technician approval queue with the reason attached, or, in read-only mode, they come back to Haley as "recommend this instead".

Account-changing tools resolve Microsoft 365 object IDs and Google aliases to the actual account email before applying account rules. Failed target, department or admin checks require technician review instead of authorizing an automatic change. The same canonical account owns any resulting credential.

Haley checks the kill switch after asynchronous policy lookups and before execution. Approved actions are checked against the current policy when the run resumes; a new block, failed verification or changed named approver prevents the old approval from executing the action. A change already sent to a provider cannot be recalled by the kill switch.

## Identity assurance

| Level | How the requester reached Haley | What it proves |
|---|---|---|
| `none` | Anything unauthenticated: an email without DMARC, a Slack guest, a chat user the bridge didn't verify | Nothing |
| `email` | Email with DMARC pass, or a DKIM signature aligned with the sender's domain | The sending domain vouches for the message. Mailboxes still get phished, so this is never enough for security-sensitive changes. |
| `chat` | A Slack workspace member (not a guest) whose profile email is on the client's domains, or a chat bridge that says it authenticated the user | The person is signed in to the client's workspace |
| `directory` | Microsoft Teams, with a valid Bot Framework token from the client's tenant, and the sender's Entra object ID matched to an active account through the client's Microsoft 365 connection | The person signed in to the client's directory |
| `mfa` | Step-up: in the last 30 minutes the requester approved a Duo or Okta Verify push on their own enrolled device, or confirmed a one-time code texted to the mobile number on their directory account | The person holds the account's registered second factor right now |
| `technician` | Entered in the Haley dashboard by a technician | The MSP vouches for the request |

## The matrix

|                | Read / internal | Write | Destructive |
|----------------|-----------------|-------|-------------|
| **Read only**  | runs | blocked; Haley recommends it | blocked |
| **Supervised** | runs | technician approval | technician approval |
| **Autonomous** | runs | runs | technician approval |
| **Unattended** | runs | runs on the requester's own account (email level or above), or for an authorized approver. Access grants need an authorized approver. | runs on the requester's own account with chat, directory or MFA step-up identity, within the daily limit per person, or for an authorized approver with chat identity or better |

These rules hold in every mode:
- **Protected accounts** (admins, executives, break-glass accounts; listed per client) always wait for a technician.
- **Unverified requesters** never cause customer changes without a technician.
- **Email alone never authorizes a security-sensitive change**, even from an authorized approver.
- **Volume limits**: in unattended mode, at most N automatic changes per client per hour (default 20) and M security-sensitive self-service changes per person per day (default 3). Past either, requests fall back to approval.
- **Kill switch**: pausing Haley for a client stops new runs, stops in-flight runs before their next step, and routes every new message to technicians.
- **Monitoring-alert tickets** have no requester, so there's no identity to verify and no "own account" to act on.
  - Only Haley's Syncro alert intake creates them. It's opt-in per client, and no channel or API call can mark a ticket as one.
  - In Unattended mode they're treated like Autonomous: routine (write) changes such as an allowed script or clearing the alert run within the hourly limit, while security-sensitive changes and access grants wait for a technician.
  - The other modes apply as usual.

Policy and requester authority are checked again after asynchronous directory lookups for each new tool call. Pausing also stops a newly returned batch of tool calls and prevents approved actions from executing while the client is paused.

## Client policy rules

Each client can add its own rules on top of the matrix (**Policy rules** on the client's page). They are checked in order and the first match wins. A rule can match on:
- the tool (with `*` wildcards, such as `m365_*_device`);
- the risk (write or destructive);
- the target accounts (`jane@contoso.com`, `*@contoso.com`);
- the target's Microsoft 365 department;
- who asked.

| Effect | What happens |
|---|---|
| **Deny** | The call is blocked. Haley recommends it to a technician instead. |
| **Approve** | The call goes to the approval queue even if the matrix would have let it run. It can name the technicians who may approve, for example only the client's account manager. Anyone else gets a 403. |
| **Allow** | The call runs without a sign-off where the matrix only asked for one because of the autonomy level: supervised mode, security-sensitive changes in autonomous mode, access grants, or someone else's account. The requester must still meet the rule's minimum identity level (directory by default). |

"Allow" never overrides protected accounts, unverified or email-only identity for security-sensitive changes, the hourly and per-person limits, a denied identity verification, or the hard rails below. Rules only apply to changes; reads always run.

## Hard rails

These are enforced in code for every client, in every mode. No rule or setting can relax them.

- **Wiping or retiring a device always needs a technician's approval**, even on a task a technician started.
- **Temporary Access Passes and BitLocker recovery keys only go to the account's own owner without a technician.** Both let the holder get past that person's MFA or disk encryption, so a manager or authorized approver asking for someone else's goes to the approval queue.
- **Adding someone to an admin group always needs a technician.** This covers Entra role-assignable groups and groups whose names mark them as admin, privileged or break-glass groups.

## Step-up verification (MFA push or SMS code)

Each client can have one verification method: **Duo push**, **Okta Verify push**, or an **SMS code** sent through Twilio to the mobile number on the user's Microsoft 365 or Google account. With one configured, Haley can raise a requester to the `mfa` level. Typically that's someone who emailed in and wants their own password reset.

- **Only the requester is ever verified.** The tool always targets the ticket's requester, never anyone else, and codes only go to the number already on the account, never to a number the requester gives.
- **MFA-fatigue protection:** at most 3 pushes or codes per ticket and 5 per person per hour.
- **Codes:** each lasts 10 minutes, allows 5 guesses, and is stored only as a hash.
- **A denied push, a fraud report or five wrong codes means possible impersonation.** Haley escalates the ticket, and she is then **blocked** (not merely held for approval) from any change to customer systems on it.
- **Accounts that can't prove anything aren't treated as verified:** users not enrolled in Duo or in Duo bypass mode, and users without an active Okta Verify push.
- **Unsupported methods aren't used.** Haley doesn't use Microsoft's undocumented helpdesk-push endpoint.

## Credentials never reach the model

Password resets, new accounts and Temporary Access Passes produce credentials inside the tool. The model only sees a placeholder. The credential is stored encrypted (AES-256-GCM) and handled one of three ways:
- **Self-service in chat**: if the requester changed their *own* account and has chat, directory or MFA identity, the credential goes straight to them in their **private** Slack DM or Teams chat.
- **Self-service by email, after MFA step-up**: the requester gets a **one-time link**, never the credential itself.
  - The link expires after 15 minutes and works once.
  - Only a hash of the token is stored.
  - The page reveals nothing until the person presses a button, so mail scanners that follow links can't use it up.
  - Every view is audited.
- **Otherwise** a technician reveals it in the dashboard and delivers it (by phone, SMS or in person). Every reveal is audited.

## Any AI model, same rules

Haley can run on Claude, OpenAI, Azure OpenAI, Gemini, Mistral, open-weight models on Groq, Together or OpenRouter, or self-hosted models via Ollama, vLLM or LM Studio. The rules on this page are enforced by Haley's server, not by the model. A smaller or self-hosted model is exactly as constrained as a frontier one; it may just need more approvals because it makes worse plans.

## Prompt injection

Ticket text, emails and chat messages come from end users. Haley treats them as data, but the defense doesn't rely on the model behaving:
- Customer changes are gated by the policy above, whatever the model has been talked into.
- Credentials never enter the model's context.
- Tools only reach the ticket's own client.
- The SyncroMSP webhook isn't signed by Syncro, so a delivery is only a nudge.
- Attachments are the requester's content too. A screenshot or PDF that says "reset the CEO's password" gets the same treatment as a message that says it: PDF and text content is marked untrusted, and the policy decides what runs.
- Attachment content is never saved to the knowledge base or client notes automatically.
- Phone callers are never more than unverified, whatever caller ID says: the server sets it, so no integration or prompt can raise it. Replies go to the matched person's directory email, and call recordings are links Haley never opens.
- "What would Haley handle?" reports send ticket subjects to the model as data, and the answer can only pick from Haley's fixed capability and recipe lists. A prospect's PSA credentials are used for one report and never stored; only totals and three example subjects per group are kept.
- Technicians download attachments through a route that never renders them as a page (`nosniff`, a sandboxed CSP, and a download for anything that isn't an image), and each download is audited.
  - Haley never reads its body; she re-reads tickets and alerts from Syncro's API, as the regular sync does.
  - The URL holds a 48-character secret that can be rotated.
  - Bursts are collapsed to at most one sync every 10 seconds.
- Booking a PSA appointment is a write, so it follows the client's policy like any other change.
- RMM alert text comes from the monitored machine, so it's handled like ticket text.
  - Syncro scripts are limited to a per-client allowlist the MSP enters.
  - Scripts whose names suggest removing or disabling something always wait for a technician.
  - Alert intake opens at most 5 tickets per check and 20 per client per hour.
- Follow-ups Haley schedules for herself run with the original requester's authority, not a technician's.
- A reply only continues a ticket when it comes from the same requester with at least the original channel's identity assurance. An unverified message cannot reuse an earlier MFA step-up. Other messages open a separate ticket; unmatched PSA comments stay on the technician timeline and are excluded from Haley's context.
- Ticket runs can read shared knowledge articles but can only create or update articles for their own client. Global procedures can be authored through technician tasks.
- **Client memory** (short notes Haley sees on every later run for a client) can't be planted by an end user. Notes Haley saves while working an end user's ticket stay *pending* and never reach the model until a technician confirms them on the client's page. Notes that look like credentials or codes are refused. Memory is per client and never shared across clients.

## Help desk features

- **Requester snapshot:** read-only lookups from the client's own systems, shown to technicians only. Nothing from it is sent to the model.
- **Copilot (draft reply, next steps, summary):** one model call with no tools. It can't change anything or contact anyone. The technician edits and sends any draft, and each use is audited and billed to the client.
- **Incidents:** these group tickets but change nothing on their own. Messaging everyone, or resolving everyone's tickets, is a technician action and is audited.
- **Status page links:**
  - A link is signed with the server's secret key, expires after 60 days, and is sent only to the requester.
  - The page shows the public conversation only, never internal notes or actions.
  - A link can be forwarded, so a reply from the page counts only as email-level identity. On tickets that began on Slack, Teams or chat, those replies are recorded for a technician without Haley acting on them.
  - "It's fixed" can only close a resolved ticket.
  - Messages are limited to 10 per hour per ticket.

## Technicians and chat approvals

- **The directory.** The **Technicians** page lists who the MSP's technicians are. A technician's name is the name they sign in to the dashboard with, so client rules that name approvers keep matching. Renaming someone renames them in those rules too.
- **Dashboard identity.** In the dashboard, the name a technician types is not verified: one shared API token protects the API.
- **Chat identity is stronger.** In Slack and Teams, a decision is accepted only when all of these hold:
  - the click is signed by Slack (signing secret) or by Bot Framework (JWT);
  - it comes from the MSP's own workspace or tenant;
  - the person is an active directory technician. They're matched by linked id, or by the email on their chat profile the first time, which then links the account.
- **Same rules everywhere.** Every decision from chat goes through the same path as the dashboard: named-approver rules, an atomic claim (only one decision wins), and the policy re-check before an approved change runs.
- **Workspace risk cap.** The workspace can keep sensitive changes approvable only in the dashboard; forged clicks are refused as well.
- **What cards never contain:** action inputs or tool results. "What she checked" lists Haley's read steps (for example "Look up isaiah@contoso.com"), not what they returned.
- **Untrusted text is escaped:** ticket titles, requester names and Haley's text. In Slack that stops `@channel` mentions and forged links; in Teams it breaks Markdown link syntax.
- **Ask for changes.** This sends a change back with a technician's note. Haley sees the note as the failed tool's result, so she can adjust and propose again; she can't treat it as approval.

## Learning from technicians, without changing policy on its own

- **Lessons are suggestions.** Haley can propose a client note or a policy rule from technicians' corrections: rejected or sent-back changes with a reason, heavily edited drafts, re-categorised tickets, or a requester saying a fix didn't hold. A note waits in "Waiting for review" and a rule in "Suggested by Haley". Neither is used until a technician accepts it, and a suggested rule that loosens policy is marked.
- **Suggested rules are checked like hand-written ones.** They go through the same validation, must name tools the client actually has, and can never match every change. Hard rails can't be expressed as rules.
- **Secrets are dropped.** Secret-looking notes are discarded, as they are for Haley's own notes.
- **Limits.** Lesson checks are capped at 20 per client per day.
- **Other help desk checks don't act on customer systems.** Checks before close, frustration flags and dispatch suggestions only inform technicians and Haley's tone. The one change they make on their own is handing a frustrated requester's reopened ticket to a person, and assigning an escalation when the workspace turns that on.

## Accountability

- Every tool call is recorded with its input, risk, Haley's stated rationale, the policy's reason and the outcome.
- Every approval, rejection, credential reveal or delivery, policy change, pause and escalation goes into the audit log.
- Each ticket records how the requester was verified.

## Try it without risk

- **Sandbox tenants** simulate Microsoft 365 and Google Workspace, so you can run Haley against realistic data.
- **Plan mode** runs Haley against a real tenant without changing anything. Every write is simulated, and the run reports which steps would run automatically, which would need approval, and why.
- **The end-user simulator** lets a technician message Haley as any user at any assurance level.
