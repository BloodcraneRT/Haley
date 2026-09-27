# Haley's trust model

This page describes exactly what Haley can do on her own, what she can't, and why. MSPs can share it with a client's security team. The authority is the code: `server/src/agent/policy.ts` decides every call, and `server/test/unit.test.ts` pins the rules.

## Four inputs to every decision

Every tool call Haley makes is judged on:

1. **Risk of the tool**:
   - `read`: no side effects.
   - `internal`: writes only inside Haley (ticket fields, notes, replies, knowledge base).
   - `write`: routine and reversible changes to a customer system, such as licenses, groups, new users and out-of-office.
   - `destructive`: security-sensitive or hard to undo, such as password resets, Temporary Access Passes, blocking sign-in, revoking sessions and suspending users.

   Tools that grant access to data (group or shared mailbox membership) are also marked as *access grants*.
2. **The client's autonomy policy**: read only, supervised, autonomous or unattended.
3. **Who is asking, and how sure Haley is of it**: the identity assurance level (below), and whether the requester is an *authorized approver* for the client, such as a manager or the IT contact.
4. **Whose account is affected**: the requester's own, someone else's, or a *protected account*.

Calls that don't pass never fail silently. They go to the technician approval queue with the reason attached, or, in read-only mode, they come back to Haley as "recommend this instead".

## Identity assurance

| Level | How the requester reached Haley | What it proves |
|---|---|---|
| `none` | Anything unauthenticated: an email without DMARC, a Slack guest, a chat user the bridge didn't verify | Nothing |
| `email` | Email with DMARC pass, or a DKIM signature aligned with the sender's domain | The sending domain vouches for the message. Mailboxes still get phished, so this is never enough for security-sensitive changes. |
| `chat` | A Slack workspace member (not a guest) whose profile email is on the client's domains, or a chat bridge that says it authenticated the user | The person is signed in to the client's workspace |
| `directory` | Microsoft Teams, with a valid Bot Framework token from the client's tenant, and the sender's Entra object ID matched to an active account through the client's Microsoft 365 connection | The person signed in to the client's directory |
| `technician` | Entered in the Haley dashboard by a technician | The MSP vouches for the request |

## The matrix

|                | Read / internal | Write | Destructive |
|----------------|-----------------|-------|-------------|
| **Read only**  | runs | blocked; Haley recommends it | blocked |
| **Supervised** | runs | technician approval | technician approval |
| **Autonomous** | runs | runs | technician approval |
| **Unattended** | runs | runs on the requester's own account (email level or above), or for an authorized approver. Access grants need an authorized approver. | runs on the requester's own account with chat or directory identity, within the daily limit per person, or for an authorized approver with chat identity or better |

These rules hold in every mode:
- **Protected accounts** (admins, executives, break-glass accounts; listed per client) always wait for a technician.
- **Unverified requesters** never cause customer changes without a technician.
- **Email alone never authorizes a security-sensitive change**, even from an authorized approver.
- **Volume limits**: in unattended mode, at most N automatic changes per client per hour (default 20) and M security-sensitive self-service changes per person per day (default 3). Past either, requests fall back to approval.
- **Kill switch**: pausing Haley for a client stops new runs, stops in-flight runs before their next step, and routes every new message to technicians.

## Credentials never reach the model

Password resets, new accounts and Temporary Access Passes produce credentials inside the tool. The model only sees a placeholder. The credential is stored encrypted (AES-256-GCM) and handled one of two ways:
- **Self-service**: if the requester changed their *own* account and has chat or directory identity, the credential goes straight to them in their **private** Slack DM or Teams chat. It is never sent by email or in a shared channel.
- **Otherwise** a technician reveals it in the dashboard and delivers it (by phone, SMS or in person). Every reveal is audited.

## Prompt injection

Ticket text, emails and chat messages come from end users. Haley treats them as data, but the defense doesn't rely on the model behaving:
- Customer changes are gated by the policy above, whatever the model has been talked into.
- Credentials never enter the model's context.
- Tools only reach the ticket's own client.
- Follow-ups Haley schedules for herself run with the original requester's authority, not a technician's.

## Accountability

- Every tool call is recorded with its input, risk, Haley's stated rationale, the policy's reason and the outcome.
- Every approval, rejection, credential reveal or delivery, policy change, pause and escalation goes into the audit log.
- Each ticket records how the requester was verified.

## Try it without risk

- **Sandbox tenants** simulate Microsoft 365 and Google Workspace, so you can run Haley against realistic data.
- **Plan mode** runs Haley against a real tenant without changing anything. Every write is simulated, and the run reports which steps would run automatically, which would need approval, and why.
- **The end-user simulator** lets a technician message Haley as any user at any assurance level.
