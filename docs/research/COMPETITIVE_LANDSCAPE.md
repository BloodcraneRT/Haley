> Research compiled in September 2026 from public vendor pages, docs, comparison posts and GitHub. It informed the features listed in "What Haley took from this" at the end. Vendor claims are marketing unless noted otherwise; see the caveats below.

# Haley competitive research: AI service desk and MSP automation (Sept 2026)

**How much to trust this.** Most capability claims below come from vendor pages or from blogs run by competitors (rallied.ai, getthread.com, eesel.ai and siit.io all publish comparison posts). Resolution rates such as "95%" or "40-60%" are vendor-reported and I could not verify them. Where a vendor's docs say nothing about how it verifies identity, I say so. I did not trial any product. Several vendors, Atera among them, blocked fetching of their docs, so some Atera details come from search snippets only.

## 1. Landscape

### MSP-focused (Haley's direct competitors)

| Product | Target | Channels | Resolves with no human | Self-service identity check | Integrations | Pricing | Distinctive |
|---|---|---|---|---|---|---|---|
| **Rallied** ([site](https://rallied.ai/)) | MSPs | Teams, Slack, inside the PSA | Password resets and lockouts, on/offboarding, M365 user and mailbox admin, RMM scripts, triage, time entries | "MFA before credential changes"; autonomy level configurable per action | CW, Halo, Autotask, SuperOps, JSM; RMM; M365 | **$3 per resolved ticket**, $150/mo minimum | Closest to Haley's pitch ("AI technician"). **Plan Mode** shows a dry run first. Runbooks written in plain English. Per-client rules. SOC 2 Type II |
| **Mizo** ([site](https://mizo.tech/solutions/agentic-service-desk/)) | MSPs | Phone, email, chat, portal, Teams, Slack | Claims 15+ M365 scenarios (resets, MFA, licenses, mailbox) | An **"End User Verification Agent"**: M365 MFA push, Duo, or a verification link ([source](https://mizo.tech/solutions/ai-agent-for-msp/)) | CW, Autotask, Halo; IT Glue, Hudu; NinjaOne, Datto | Per ticket (third party says $0.50/ticket; not confirmed) | Separate agents for intake, triage, dispatch, resolution, documentation, QA and sentiment |
| **Pia** ([Pia Chat](https://pia.ai/platform/pia-chat)) | MSPs | Teams (Pia Chat), PSA | Onboarding, offboarding and group changes through AI-guided **SmartForms** | Not documented | Works inside the PSA; M365 | Platform is usage-based or flat. **Pia Chat is $10 per client per month**, LLM included | 100+ packaged automations. Claims 2-minute setup per client. Per-client branding. Per-MSP data isolation |
| **Thread** ([site](https://www.getthread.com/service-magic-blog/the-5-best-ai-service-desk-platforms-for-msps-in-2026)) | MSPs | Teams, Slack, desktop/mobile app, email, voice | Triage Agent gathers context and fixes "common issues". Full resolution comes from Pia or Rewst | **None built in.** Caller verification is "in development", and users say they use MSP Process instead ([feature request](https://getthread.canny.io/feature-requests/p/user-verification-through-thread-platform-when-user-initiates-service-request-ou)) | Two-way sync with CW, Autotask, Halo; Rewst, Pia, Hudu, IT Glue | Flat per seat | Owns the chat experience. AI writes time entries and sets priority |
| **Rewst** ([docs](https://docs.rewst.help/documentation/crates/existing-crate-documentation)) | MSPs | Forms, PSA triggers, Teams | Anything built as a workflow. Packaged "Crates" cover M365 onboarding, offboarding, MFA reset and compromised-user response | Up to the MSP to build | 40+ MSP tools | Quote only (third party estimates $500-2,000/mo) | Low-code workflows are deterministic. Each workflow takes an estimated 5-15 hours to build ([source](https://rallied.ai/blog/rewst-pricing/)) |
| **Atera Robin** (formerly IT Autopilot) ([support](https://support.atera.com/hc/en-us/articles/26035545466652-IT-Autopilot-is-now-Robin)) | MSPs and IT departments | Portal, email, Slack, Teams, web widget | Device health checks, pre-approved scripts, **password reset with MFA verification**, Azure AD group changes, approved app installs, lockout detection | MFA verification (mechanism not public). Admin accounts excluded when AD sync is on | Atera RMM and PSA; Azure AD | Paid add-on, per end user, no public rate | RMM and AI in one product, so endpoint fixes need no extra connector |
| **NeoAgent** ([pricing](https://www.neoagent.io/pricing)) | MSPs | PSA, voice, branded end-user bot | Triage, dispatch, RMM script run-and-verify, onboarding | Voice caller validation | Halo, CW, Autotask; Datto, N-central, NinjaOne, VSA | Credits, $500-2,340/mo (Oct 2026; see [NEOAGENT_COMPARISON.md](NEOAGENT_COMPARISON.md)). Bot is $9-79 per client per month | Picks the right RMM script from the alert and runs it |
| **MSP Process** ([verification](https://mspprocess.com/end-user-id-verification/)) | MSPs | Voice AI, Teams, SMS, WhatsApp, portal, email | Voice agent sends a password reset link and closes the ticket | **13 methods**: Authenticator push, Duo, Teams link or code, SMS or email code or link, portal, WhatsApp, voice. Writes the result, method and timestamp to the PSA | CW, Halo; Entra directory matching | Per minute for voice | Verification is the core product ("an attacker can't talk past an MFA push") |
| **CyberQP** ([site](https://cyberqp.com/qguard/)) | MSPs | Technician tool; end-user self-service password reset | Self-service password reset, unlocks | Push through the Quickpass app, SMS or email. Just-in-time admin accounts that are disabled and rotated when time expires | IT Glue, Hudu, PSA | Quote only | Privileged access management built for MSPs. Used by 1,200+ MSPs |
| **CloudRadial** ([site](https://www.cloudradial.com/unifiedclientportal)) | MSPs | Portal, Teams, desktop app | Intake, dynamic forms, approvals | Not the focus | CW, Autotask, Halo, Syncro, Kaseya BMS; RMM; M365 | Flat subscription | **On-demand QBRs from live data**, a shared vCIO roadmap, and about 550 daily compliance checks |
| **ConnectWise zofiQ** ([PR](https://www.connectwise.com/company/press/releases/connectwise-advances-ai-leadership-with-agentic-ai-zofiq)) and **Kaseya** agentic platform ([PR](https://www.kaseya.com/press-release/kaseya-unveils-the-first-agentic-it-management-platform-turning-data-into-autonomous-action/)) | Their own PSA customers | Inside their PSA | Triage, routing, documentation. Kaseya's Ticket Triage specialist is generally available on Autotask Ultimate | Not documented | Own stack only | Bundled or premium | Distribution advantage. The agent works on data already in the PSA |

Adjacent MSP tools, one line each:
- **SuperOps Monica**: agentic AI inside SuperOps' own PSA/RMM ([link](https://superops.com/monica-ai)).
- **NinjaOne**: AI is limited to patch and vulnerability work; it has no end-user agent ([link](https://rallied.ai/blog/ninjaone-ai/)).
- **Giant Rocketship**: dispatch, scheduling and **SLA Sentinel** breach prediction for Autotask and CW; about $30-50 per user per month ([link](https://giantrocketship.com/features)).
- **Inforcer and Augmentt**: M365 baselines and drift across tenants. Inforcer prices per tenant (20-tenant minimum); Augmentt prices per user ([link](https://www.inforcer.com/platform)).
- **M365 Lighthouse**: free baselines, deployment plans and GDAP management ([link](https://learn.microsoft.com/en-us/microsoft-365/lighthouse/m365-lighthouse-faq)).
- **Nerdio**: multi-tenant Intune, AVD and W365. Added PSA integrations in v7.0 ([link](https://getnerdio.com/blog/4-nerdio-manager-for-msp-v7-2-updates-that-make-multi-tenant-management-easier/)).

### Enterprise and internal-IT AI service desks

| Product | Channels | Resolves with no human | Identity and guardrails | Pricing |
|---|---|---|---|---|
| **Moveworks** (ServiceNow closed the $2.85B purchase in Dec 2025; now part of "Otto") ([docs](https://docs.moveworks.com/service-management/provision-management/account-access-assistant)) | Teams, Slack, web | Account unlock, MFA reset, access requests, lockout alerts pushed to the user seconds after they happen | **Never handles passwords in chat**; sends the user to the reset portal. With Ping, sends users to Ping to add a phone or QR code and never processes Ping codes. **A Duo reset only works if the user keeps the same phone number** ([Duo](https://docs.moveworks.com/service-management/provision-management/account-access-assistant/account-access-integration-specific-overview/account-access-integration-duo-mfa)) | Quote only |
| **Atomicwork** ([link](https://www.atomicwork.com/blog/self-service-password-reset)) | Slack, Teams | Entra password reset, groups and distribution lists, software; "Agentic IGA" for time-bound access | Admin chooses how identity is verified (methods not published) | Quote only |
| **Serval** ([link](https://www.computerworld.com/article/4216413/qa-serval-ceo-describes-building-an-ai-native-alternative-to-servicenow.html)) | Slack, email, forms | Resets, unlocks, **just-in-time access with approvals**, access reviews | A "Builder Agent" writes each automation as TypeScript, which is deterministic and reviewable | Pilot with "50% of tickets automated" guarantee |
| **Siit** ([pricing](https://www.siit.io/pricing)) | Slack, Teams | Service catalog with approval routing across IT, HR and Finance | Approver-based | $23/45/89 per admin; AI agents only on Pro |
| **Freshservice Freddy AI Agent** | Slack, Teams, email, portal | Answers from the KB, creates tickets, lookups | Not detailed | Enterprise plan only, 1,200 sessions per license per year ([link](https://www.eesel.ai/blog/freshservice-freddy-ai)) |
| **Zendesk AI agents** (Employee Service, via its Unleash acquisition) | Slack, Teams | Answers, actions | Resolutions are **checked twice** (the agent, then a separate evaluation model) before they are billed | About $1.50-2.00 per automated resolution ([link](https://www.cmswire.com/customer-experience/zendesk-unveils-autonomous-ai-workforce-at-relate-2026/)) |
| **JSM virtual agent and Rovo** (Halp is folded in) | Slack, Teams, portal, email | Intent flows, AI answers | Flows the admin builds | 1,000 conversations/mo free, then $0.30 each ([link](https://servicedeskagents.com/vs-atlassian/)) |
| **Rezolve.ai, Aisera** | Teams, Slack, voice | Resets and provisioning | Rezolve offers "optional identity verification before sensitive actions" and has an MSP program ([link](https://www.rezolve.ai/product/msp)) | Per seat / quote |

Identity verification products Haley could integrate with rather than build:
- **Nametag Autopilot** ([link](https://getnametag.com/newsroom/nametag-unveils-autopilot-self-service-account-recovery)): government ID plus selfie with deepfake defense, then self-service password or MFA reset in Okta, Entra or Duo.
- **Entra Verified ID with Face Check** ([MS Learn](https://learn.microsoft.com/en-us/entra/verified-id/helpdesk-with-verified-id)): Microsoft's reference pattern is "verify, then issue a TAP". It explicitly covers MSPs and CSPs through `acceptedIssuers`.
- **Caller Verify for Okta** ([link](https://sec.okta.com/articles/2025/06/building-confidence-in-support-comms-with-caller-verify-at-okta/)).

### Open source

| Repo | Stars | License | Relevance |
|---|---|---|---|
| [KelvinTegelaar/CIPP](https://github.com/KelvinTegelaar/CIPP) and [CIPP-API](https://github.com/KelvinTegelaar/CIPP-API) | 1.2k (about 7k forks, because each MSP forks it to deploy) | AGPL-3.0 | The M365 multi-tenant reference. Standards run every 12h (report, alert or remediate), drift review, Best Practice Analyzer, GDAP expiry monitoring, BEC investigation, TAP, **Send MFA Push**, offboarding wizard ([users](https://docs.cipp.app/user-documentation/identity/administration/users), [standards](https://docs.cipp.app/user-documentation/tenant/standards/alignment)). No AI. |
| [zammad/zammad](https://github.com/zammad/zammad) | 6.0k | AGPL-3.0 | 7.0 added AI summaries, a writing assistant and routing "agents", with bring-your-own-LLM including Anthropic and Ollama. It does not resolve tickets on its own ([link](https://zammad.com/en/product/releases/7-0)). |
| [glpi-project/glpi](https://github.com/glpi-project/glpi) | 6.4k | GPL-3.0 | ITSM plus CMDB and asset management. A possible ticket and asset source. |
| [osTicket/osTicket](https://github.com/osTicket/osTicket) | 3.9k | GPL-2.0 | Legacy ticketing. |
| [freescout-help-desk/freescout](https://github.com/freescout-help-desk/freescout) | 4.6k | AGPL-3.0 | Shared mailbox. A good model for threading email replies. |
| [Peppermint-Lab/peppermint](https://github.com/Peppermint-Lab/peppermint) | 3.2k | archived | TypeScript/Next helpdesk. No longer maintained. |
| [amidaware/tacticalrmm](https://github.com/amidaware/tacticalrmm) | 4.5k | **Custom license, not OSI**. Can't be offered as a commercial SaaS feature without permission | RMM an MSP self-hosts. Good first RMM connector for "run a script" work. |
| [Ylianst/MeshCentral](https://github.com/Ylianst/MeshCentral) | 7.3k | Apache-2.0 | Remote control. |
| [merill/lokka](https://github.com/merill/lokka) | 301 | MIT | MCP server for Graph, written by a Microsoft PM. |
| [maester365/maester](https://github.com/maester365/maester) | 1.1k | MIT | Entra/M365 security tests as code. Could feed Haley's security review. |
| [WYRE-AI/cipp-mcp](https://github.com/WYRE-AI/cipp-mcp) and [Servosity/msp-skills](https://github.com/Servosity/msp-skills) | 12 / 45 | – / Apache-2.0 | MCP servers for CIPP, PSA, RMM and M365. They show MSPs connecting Claude to these systems themselves. |
| [abhinavxd/libredesk](https://github.com/abhinavxd/libredesk) | 3.0k | AGPL-3.0 | Single-binary omnichannel desk with an AI agent. Aimed at customer support, not IT. |

There is **no serious open-source AI IT agent** that acts on tenants. The GitHub repos tagged `helpdesk` and `ai-agent` are customer-support RAG bots.

## 2. How the best ones do unattended self-service safely

**Pattern A: tie the chat identity to the directory, and never treat that as enough by itself.** A Teams bot receives `from.aadObjectId` and `conversation.tenantId` from Entra ([MS Learn](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)). Haley should require that the tenantId matches the client's connected tenant, and match users by object ID, not by display name or email. A Slack identity is only as strong as the workspace's SSO, and Slack Connect or guest users must never count. Email is the weakest channel because it is spoofable: require DMARC/DKIM alignment, and **never let email alone authorize a credential change.** Haley's `InboundMessage.sender.verified` is currently a single boolean set by the channel. Replace it with an **assurance level** (email < Slack < Teams < fresh MFA challenge < document plus biometric) and have each self-service action declare the minimum level it needs.

**Pattern B: step up with an out-of-band MFA challenge at the moment of the action.** This is now table stakes for MSPs. MSP Process, Mizo and Atera Robin send an Authenticator or Duo push before a reset, and so does CIPP's "Send MFA Push" button. CISA's Scattered Spider guidance asks for "two independent verification checks, one resistant to voice impersonation", and extra approval before MFA is reset ([CISA AA23-320A](https://www.cisa.gov/news-events/cybersecurity-advisories/aa23-320a)).
- **How CIPP does it on M365:** it provisions a credential on the tenant's MFA connector service principal, then calls the NPS-extension endpoint `adnotifications.windowsazure.com/StrongAuthenticationService.svc/Connector/BeginTwoWayAuthentication` with `SyncCall=true` and reads `AuthenticationResult` ([source](https://github.com/KelvinTegelaar/CIPP-API/blob/master/Modules/CIPPHTTP/Public/Entrypoints/HTTP%20Functions/Identity/Administration/Users/Invoke-ExecSendPush.ps1)).
- It accepts a typed code (`EndTwoWayAuthentication`) **only if the user has no Authenticator registered.**
- Caveat: **this endpoint is undocumented.** Microsoft Q&A says Entra has no supported "helpdesk push" API ([link](https://learn.microsoft.com/en-us/answers/questions/159563/enable-helpdesk-push-notification-for-user-verific)). Duo (Auth API) and Okta (Factors API) do have supported push APIs.
- Google Workspace has no third-party push. Use an OTP to the **recovery email or phone already on file** and treat it as lower assurance. Also treat Directory API `verificationCodes.generate` (2SV backup codes) as an MFA bypass, and therefore destructive.

**Pattern C: hand over a way to recover, not a secret.** Moveworks never touches passwords in chat and sends users to the IdP portal. MSP Process sends a branded reset link. Microsoft's pattern for total loss of all factors is to verify (Verified ID or Face Check, or an ID-verification partner) and then **issue a short-lived, one-time Temporary Access Pass**. The user registers new methods themselves. For Haley, TAP beats a temporary password: it is time-boxed, used once, needs no password change afterwards, and bootstraps passkey registration. When a secret must go out, send it only as a DM to the verified user (Haley's `supportsPrivate`), and never through the model.

**Pattern D: someone other than the requester approves access.** Access requests (groups, shared mailboxes, apps) go to the **resource owner or manager** for approval, not to the requester's own verification. That is how Siit, Serval, Atomicwork, CloudRadial and Pia SmartForms handle them. Serval and Atomicwork also make grants **time-bound, with automatic expiry**. Manager approval can come from a Teams Adaptive Card or an email link that is itself tied to the approver's identity.

**What they refuse to automate** (from docs, plus CISA):
- Anything on admin or privileged accounts. Atera excludes admin accounts when AD sync is on; CISA says to escalate high-risk accounts.
- Registering a new MFA device through chat. Moveworks sends the user to the IdP.
- A Duo reset when the phone number has changed.
- Handling OTP codes on the user's behalf.
- Recovery when the user has no working factor left. That falls back to a document-and-biometric check or a human.

**Limits on the damage a mistake can do.** These are common in docs and good practice for Haley:
- Exclude groups from self-service: admins, break-glass accounts, executives, finance and payroll staff.
- Per-user rate limits (for example, at most one MFA reset per 30 days) and per-tenant daily caps on each action.
- After any reset, revoke sessions and notify the user on a second channel and their manager. Monitor for "repeated password resets or MFA removals" (CISA).
- Record which verification method was used, and when, on the ticket. MSP Process writes this to the PSA.
- Have a kill switch per client.

## 3. Feature gaps for Haley (ranked by value relative to effort)

| # | Feature | Who has it | Why it matters to MSPs | Effort |
|---|---|---|---|---|
| 1 | **Step-up verification tool** (`verify_identity`: M365 push via the NPS connector endpoint with OTP fallback; Duo and Okta connectors; Google OTP to the recovery address), plus a per-action minimum assurance level in `policy.ts` | MSP Process, Mizo, Atera, CIPP, CyberQP | Unattended resets are only defensible with this. Thread lacks it, so it is an opening. Feeds the chat work already in progress | **S-M** |
| 2 | **Temporary Access Pass and self-service MFA re-registration** (`POST /users/{id}/authentication/temporaryAccessPassMethods`, delete old methods, require re-registration). Delivered by DM through `deliverSecret` | CIPP, Entra reference pattern | Solves the most common "lost my phone" ticket without a human. Safer than temporary passwords | **S** |
| 3 | **Self-service guardrails**: excluded groups, rate limits and caps, session revoke and notification after reset, anomaly alerts, kill switch | Implied by CISA; partly in Atera and Moveworks | Makes "no IT supervision" something an MSP can sell to a client's security reviewer | **S** |
| 4 | **Plan mode / dry run.** Run the agent against a snapshot of the client in the existing sandbox connector and show the diff before touching the live tenant | Rallied (Plan Mode) | Builds trust on day one. Haley already has sandbox tenants | **S-M** |
| 5 | **SLA timers and business hours** per client and priority, with breach warnings and auto-escalation | Giant Rocketship, every PSA | MSP contracts are written around SLAs. Also needed for QBR metrics | **S-M** |
| 6 | **Access requests with owner or manager approval and time-bound expiry** (Teams Adaptive Card or email approval; a scheduler removes the grant later) | Serval, Atomicwork, Siit | "Add me to X" is high volume. Needs someone other than the requester to approve, not just verification | **M** |
| 7 | **Scheduled and proactive work**: weekly license waste, stale accounts, MFA gaps, GDAP or secret expiry; alerts (service health, risky sign-ins) become tickets automatically | CIPP alerts, Atera, Moveworks lockout notices | Moves Haley from reacting to preventing. Already on the roadmap | **M** |
| 8 | **Exchange Online depth**: shared mailbox and calendar permissions, forwarding, message trace, convert to shared on offboarding | CIPP, Rallied, Mizo | Among the most common M365 tickets. Graph coverage is thin, so some of this needs the EXO REST/PowerShell endpoints | **M** |
| 9 | **Compromised account / BEC playbook**: sign-in review, inbox rules, forwarding, OAuth grants; then contain (revoke, block, reset) with approval | CIPP, Rewst crate | High stakes and time-critical. The investigation steps are read-only, so they can run with no approval | **M** |
| 10 | **Onboarding clients with GDAP or a partner multi-tenant app** instead of an app registration in each tenant | CIPP, Lighthouse | Today's per-client setup (app registration, secret, User Admin role) is the biggest adoption blocker. Secrets also expire | **M** |
| 11 | **Service catalog / dynamic forms** that feed deterministic tools (new hire, equipment, access), with an approval step | Pia SmartForms, Rewst, CloudRadial, Siit | Structured input gives more zero-touch resolutions and lets the MSP define its products | **M** |
| 12 | **QBR and value reports** per client: tickets, % resolved by Haley, minutes saved, SLA, license spend and waste, security posture trend | CloudRadial | Shows the MSP's value to the client. Haley's audit and actions data already contain most of it | **M** |
| 13 | **Contract and billing awareness**: agreement coverage and out-of-scope flags, auto time entries, license count checked against the distributor or invoice | Thread (time entries), CloudRadial, PSAs | Billing leakage is a real MSP profit problem. Needs PSA data | **M** (after #14) |
| 14 | **PSA two-way sync** (Halo first because its API is easiest, then CW and Autotask): tickets, notes, time, contacts, agreements | Everyone MSP-facing | Table stakes. MSPs won't switch PSAs, so Haley has to live alongside theirs | **L** |
| 15 | **RMM connector** (Tactical RMM or NinjaOne): device lookup and approved scripts classed as `write` risk | Atera, NeoAgent, Rallied, zofiQ | Many L1 tickets are about endpoints. Haley can't fix them today | **M-L** |
| 16 | **Tenant standards and drift** (report, alert or remediate), perhaps by importing CIPP or Maester templates | CIPP, Inforcer, Augmentt, Lighthouse | Recurring revenue for MSPs, but crowded and not an AI differentiator | **L** |

I would skip voice for now. MSP Process and Mizo own it, and it is costly to do well.

## 4. Differentiation angles

1. **Autonomy that is safe by design, with the trust model published.** Most vendors describe guardrails vaguely (Moveworks' and Atomicwork's docs don't say how they verify identity). Haley can publish exactly how it works:
   - a policy engine per action;
   - secrets that never reach the model;
   - the verification ladder from section 2;
   - a record of which method verified each action.

   Pair this with Plan Mode, so every client can rehearse against a sandbox. That makes Haley the answer when a client's security team asks whether an AI can reset passwords.
2. **An AI technician for Google Workspace and M365 alike.** Nearly every MSP tool I found targets only M365 (CIPP, Inforcer, Augmentt, Lighthouse, and Mizo's listed scenarios). MSPs with clients in education, healthcare clinics or startups on Google have little choice today.
3. **Owns the ticket end to end.** Thread is strong on conversation but hands the fix to Pia or Rewst, and Rewst needs 5-15 hours per workflow. Haley can talk to the user, verify them, act, document and report in one product, with no workflow building. Its knowledge base compounds as the agent writes runbooks, which rivals IT Glue and Hudu for small MSPs.
4. **Simple, self-hostable, clear pricing.** It runs as one Docker process with SQLite and can use the MSP's own Anthropic key. That suits MSPs worried about data mixing (Pia markets "your data is not mixed with other MSPs'") and those in regulated verticals. Price per client, or per resolution that is actually confirmed (like Zendesk's double check). Rallied ($3 per resolution) and Pia ($10 per client) set the price anchors.
5. **Works for internal IT teams too.** The same product covers MSPs and in-house IT, which Atera alone targets among the MSP tools. Siit and Serval charge enterprise prices for similar self-service.

## 5. What Haley took from this

| Research finding | What Haley does now |
|---|---|
| A single "verified" flag is too coarse; use assurance levels (section 2, pattern A) | Tickets carry an identity assurance level: none < email < chat < directory < technician. It is set by the channel (DMARC or aligned DKIM for email, the Slack profile email for workspace members but not guests, an Entra object ID matched to an active directory account for Teams). |
| Never let email alone authorize a credential change | In unattended mode, security-sensitive changes need at least the chat level, even for authorized approvers. |
| Access requests need someone other than the requester to approve (pattern D) | Tools that grant access (group and mailbox membership) need an authorized approver. The requester vouching for themselves is not enough. |
| Blast-radius limits and a kill switch per client | Protected accounts always go to a technician, plus an hourly cap on automatic changes, a per-person daily cap on self-service, and a "Pause Haley" switch for each client. |
| Temporary Access Pass beats temporary passwords (pattern C) | `m365_issue_temporary_access_pass` issues one, delivered only in the verified requester's private chat. |
| Plan Mode (Rallied) | Dry runs simulate every change and report what the live policy would do with each step. |
| Scheduled and proactive work; time-bound access | Recurring task schedules, plus `schedule_follow_up` so Haley can return to a ticket later (for example, to remove temporary access). |
| SLA timers (Giant Rocketship, PSAs) | Response and resolution targets per priority; breaches are escalated automatically. |
| QBR and value reports (CloudRadial) | A client report covering automation rate, SLA compliance, changes made and estimated time saved. |
| A published trust model is a differentiator | [docs/TRUST_MODEL.md](../TRUST_MODEL.md) |

Still open from the gap list: an out-of-band step-up MFA challenge (Duo or Okta push, or a code to a second factor on file), a compromised-account playbook, Exchange Online depth, onboarding clients through GDAP or a partner app, PSA sync (HaloPSA first), an RMM connector, a service catalog, and tenant standards and drift.
