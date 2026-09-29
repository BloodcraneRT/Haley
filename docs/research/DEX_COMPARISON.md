# Haley vs Dex (dex365.ai)

Researched 2026-09-28 from Dex's public site, docs, cookbook, changelog and launch coverage. Dex's figures (90% resolution, 3,000 organizations, $67K saved) are its own marketing claims and have not been independently verified. Haley has not yet been run against live customer tenants either.

## TL;DR

Dex is the same product idea as Haley, built by the team behind SysAid, with far more integrations and device-level reach. Haley is ahead on identity assurance, the email channel, credential delivery, running on any AI model, and self-hosting. Dex's biggest advantages to close: Intune and device actions, guided M365 onboarding, a finer-grained policy engine, and integration breadth.

## What Dex is

- **Company:** built by the team behind SysAid (Israel Lifshitz, founder of both). Marketed as "the world's first Autonomous IT Engineer" for MSPs, internal IT and service desks.
- **Dex Go** (end users): an agent in Microsoft Teams and Slack. Claims "90% of issues resolved before becoming a ticket." End users can only act on their own account ("current user only").
- **Dex Pro** (technicians): admin work described in plain English across M365, Google Workspace, Okta, JumpCloud and Auth0. It plans, asks for approval on sensitive or irreversible steps, executes, and verifies.
- **Integrations:** 60–70+, with 1–2 new ones a week.
  - PSA/RMM: ConnectWise (Manage, Automate, Asio), Autotask, HaloPSA, NinjaOne, Datto RMM, Kaseya (BMS, VSA), Syncro, Atera, N-able, Level, Action1, SuperOps.
  - ITSM: ServiceNow, Jira, Zendesk, Freshservice, Freshdesk, SysAid, TOPdesk, Zoho Desk.
  - Documentation: IT Glue, Hudu, Notion, Confluence.
  - Security: CrowdStrike, Huntress, DNSFilter, KnowBe4, PowerDMARC, CyberQP, Duo.
  - Network: Meraki, UniFi, Auvik, Cloudflare, NordLayer.
  - Distribution: Pax8, Sherweb.
  - MDM: Intune, Jamf, Addigy.
  - SaaS: Adobe, DocuSign, Salesforce, HubSpot.
- **Device agent (Windows, deployed via Intune):** PowerShell diagnostics, autonomous remediation (killing processes, removing scheduled tasks), visual remote control.
- **Onboarding:** claims "live in 24 hours."
  - M365 discovery scans licensing, users, groups, Exchange, SharePoint, Teams and enterprise apps.
  - An admin reviews what was found.
  - Dex then creates its own app registration, security groups and Teams app automatically.
- **Permissions:** delegated, per-user permissions (it acts as the signed-in admin or user) rather than a broad standing app key.
- **Policy engine:** enforced in code ("even if the LLM is tricked, the execution layer blocks prohibited operations").
  - Six layers:
    1. global (hardcoded)
    2. tenant
    3. target rules
    4. department
    5. action
    6. runtime guardrails
  - Every operation needs a matching policy.
  - Hardcoded rails: no MFA bypass, no direct admin-role grants, no destructive operations without explicit coverage.
  - Approvals can route to admin groups, to resource owners (for example SharePoint site owners), or be auto-granted for low risk.
- **Agent:**
  - Three model tiers, with switching mid-task.
  - "Extended thinking," up to 40 reasoning steps per task.
  - Persistent memory of API quirks, environment patterns and solutions.
  - A sandboxed script container whose HTTP calls are limited to read-only.
  - Creates new integrations mid-conversation for any REST API.
- **Knowledge:** uploaded documents (Docs, PDFs, CSVs), plus IT Glue, Hudu and Notion. A public cookbook of about 130 recipes, heavy on Intune, Entra, licensing and SharePoint.
- **Reporting:**
  - Activity Log with every API call and tool call.
  - "Dex time vs estimated manual effort" metrics.
  - Per-tenant usage attribution for MSP margin.
- **Pricing (current):** $89 per technician per month (Standard) and $189 (Max, about 3× capacity). End users are free.
  - Capacity refreshes weekly; Dex pauses rather than overcharging.
  - 30-day free trial, no card.
  - At launch it was $1.99 per resolved ticket with $100 of free credit, so the pricing model has already changed once.
- **Trust:**
  - SysAid holds ISO 27001/27017/27018 and SOC 2 Type II; Dex's own SOC 2 is "in process."
  - Hosted on AWS with a separate encrypted database per organization, AES-256 at rest and TLS 1.2+ in transit.
  - SSO and MFA; GDPR; HIPAA "in process."
  - Launch coverage mentions white-labelling for MSPs.
- **Positioning (compare page):** against Atera Robin, Console, Serval, ServiceNow, Freshservice, Moveworks, Aisera, Pia, Jira SM, Microsoft Copilot, ChatGPT, Claude and AtomicWork. Its core line: "they advise or run templates; Dex investigates and does."

## Side by side

| Area | Dex | Haley |
|---|---|---|
| End-user channels | Teams, Slack | **Email (DMARC/DKIM-checked)**, Slack, Teams, HMAC chat bridge |
| Requester identity | Teams/Slack sign-in, "current user only" | **Identity levels (none → email → chat → directory → MFA → technician) with MFA step-up** via Duo, Okta Verify or SMS code |
| Delivering passwords or temporary credentials | Not described | **Sealed; sent by private message or view-once link, never in email and never shown to the model** |
| AI models | Their own hosted models | **Any provider (Claude, OpenAI, Azure, Gemini, Mistral, Groq, local Ollama or vLLM); bring your own key; fallback chains; per-client model** |
| Hosting | SaaS only | **Self-host (Docker) or SaaS** |
| Dry run | Not described | **Plan mode: simulates changes and shows the live policy decision** |
| PSA sync | Many PSAs; sync depth unknown | Syncro and **Dynamics 365** (Dex doesn't list Dynamics); two-way with comment mirroring and loop prevention |
| SLA timers, client value report, end-user simulator | Not described | **Yes** |
| Integration breadth | **60–70+** | M365, Google, Slack, Duo, Okta, Twilio, 2 PSAs |
| Intune and device actions | **Yes, plus a Windows agent** | **No → being added** |
| Permissions model | **Delegated, per-user** | App credential per tenant |
| Policy detail | **Six layers, resource-owner approvals** | Autonomy × risk × identity, protected accounts, rate caps, kill switch → **being extended** |
| Onboarding | **Automatic discovery and consent** | Paste credentials → **being replaced by admin consent and discovery** |
| Memory and learning | **Yes** | Knowledge base only |
| Ready-made recipes | **About 130** | A few demo runbooks |
| Compliance | SysAid certifications; SOC 2 in progress | None yet |
| Pricing | Per technician; end users free | Not set |

## Where Haley is ahead (keep and market)

1. **Email as a first-class, safe channel.** A large share of real tickets still arrive by email. Dex is chat-only.
2. **Identity assurance and MFA step-up.** Dex relies on the chat sign-in. Haley can verify an email or chat requester with a push or code to their own registered device before a self-service reset.
3. **Credential hygiene.** Temporary passwords and TAPs never pass through email or the model.
4. **Any AI model, self-hostable.** A strong answer for MSPs with data-residency or cost concerns, and for anyone who wants to run open-weight models locally.
5. **Plan mode, SLA, client value report and simulator.** These are useful for selling to and demonstrating with MSP clients.

## What to incorporate (prioritized)

1. **Intune and device actions (in progress).**
   - List a user's devices; list installed apps; check compliance.
   - Look up the BitLocker recovery key as a sealed secret.
   - Sync, restart, retire or wipe a device, each gated by the policy engine.
   - Run an Intune remediation on demand.
   - Later: a lightweight Windows agent for local diagnostics.
2. **Guided M365 onboarding (in progress).**
   - One multi-tenant Haley app registration, with an admin-consent link per client.
   - Tenant discovery (domains, licences, users, admins, Intune) that suggests client settings: email domains, Teams tenant, protected admin accounts.
   - Document GDAP (Microsoft's delegated admin access for partners) for MSPs.
3. **Per-client policy rules (in progress).**
   - Allow, require approval or deny, matched by tool, risk, target, department and requester.
   - Approvals routed to named approvers.
   - Hardcoded rails that no rule can loosen: no MFA bypass for someone else, no admin-role grants, no wiping without a technician.
4. **Top MSP integrations:** ConnectWise Manage, Autotask and HaloPSA on the existing PSA sync framework; NinjaOne; IT Glue and Hudu as knowledge sources.
5. **A generic REST connector,** read-only by default, with writes going through the policy engine.
6. **Per-client memory:** learnings saved after each run and fed back into later ones.
7. **Recipe library:** around 30 tested runbooks with a plan-mode preview (licence clean-up, offboarding, shared mailbox access, BitLocker, stale devices).
8. **Metrics MSPs can bill from:** time saved vs manual per run, AI cost per run and per client, and a resolution check with the user before closing a ticket.
9. **Packaging:** per-technician pricing with end users free. Or lean on self-hosting, bring-your-own-model, and per-client pass-through costs.
10. **Trust:** an encryption key per organization, a data-retention setting, a written security overview, and a SOC 2 roadmap.

## What not to copy

- **AI-written integrations mid-conversation.** Impressive in a demo, but risky for an MSP holding many clients' tenants. A fixed tool list plus policy checks is the safer pitch.
- **Unverified resolution-rate claims.** Publish measured numbers from real deployments instead.

## Sources

- https://dex365.ai/ · /products/dex-pro · /products/dex-go · /pricing · /how-it-works · /our-tech · /msp · /security · /docs · /cookbook · /changelog · /compare
- CIO Influence: https://cioinfluence.com/it-and-devops/sysaid-launches-dex-the-autonomous-ai-it-engineer-msps-pay-only-when-it-resolves-a-ticket/
- Intellyx: https://intellyx.com/?p=49266
- GA announcement: https://www.webull.com/news/15265316281590784
