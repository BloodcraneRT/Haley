# Haley and Syncro (syncrosecure.com)

Researched 2026-10-01 from Syncro's site, docs, release notes and API spec (`api-docs.syncromsp.com/swagger.json`). The product claims, such as "resolves up to 20% of tickets" and "800k summaries", are Syncro's own marketing. Pricing comes from the live pricing page and should be rechecked before quoting it.

## TL;DR

Syncro is both a **platform Haley plugs into** and, since mid-2026, a **partial competitor**.

**As a platform:** Haley already syncs Syncro tickets in both directions. Most Syncro MSPs also run its RMM, and Haley uses none of it today. The biggest win is a Syncro RMM connector, similar to the NinjaOne one, so Haley can act on the requester's own computer, its patches and its alerts. The next most useful additions are logging Haley's time back to the PSA ticket and receiving Syncro webhooks instead of polling every two minutes.

**As a competitor:** Syncro now ships these AI features:
- AI ticket summaries.
- Automated triage and dispatch (beta).
- Guided Ticket Resolution (beta). It handles a short list of fixes, and **a technician approves every action**.
- An MCP server and a Claude plugin.

Haley's edge is unattended fixes for verified end users within per-client policy, plus email, Teams and Slack as channels. Haley also works across Syncro, Microsoft 365, NinjaOne and other PSAs at once, runs on any AI model, and can be self-hosted.

## What Syncro is today

- **Brand:** The company is still Syncro (Syncro Technologies). Marketing moved to syncrosecure.com and docs to docs.syncrosecure.com. The flagship product is **Syncro XMM**, launched in April 2025: RMM, PSA and Microsoft 365 multi-tenant management in one product. The API still lives at `https://{subdomain}.syncromsp.com/api/v1`.
- **Pricing:** per technician, with unlimited endpoints.
  - **Core:** $129 per user per month annually, $159 monthly. RMM and PSA.
  - **Team:** $179 annually, $209 monthly. Adds the Microsoft 365 security and identity suite, ticket automations, network discovery and session recording.
  - **Enterprise:** custom pricing.
  - **M365 Cloud Backup:** add-on, $1.90 per user.
- **Security:** no first-party EDR. Partner tools are billed through "Universal Billing": ThreatDown EDR/MDR, IRONSCALES, Proofpoint, AutoElevate, Guardz and Acronis.
- **AI (2025–2026):**
  - **AI Ticket Summaries:** generally available.
  - **Automated Triage & Dispatch:** beta since August 2026, Team plan. It sets priority by ITIL class and matches technicians by skill, availability and history.
  - **Guided Ticket Resolution:** beta since September 2026, Team plan.
    - It diagnoses the issue from the ticket.
    - It offers remediation for low disk space, the print spooler, performance problems, and Microsoft 365 password reset, sign-in block and session revoke.
    - "Nothing executes autonomously."
  - **Syncro MCP Server:** generally available August 2026, all plans. It covers tickets, billing, alerts, assets, appointments, clients and contacts. Reads run immediately, and writes need the user's approval. It uses OAuth 2.1 and respects the user's permissions.
  - **Syncro Service Desk plugin:** four Claude skills (call to ticket, research, onsite prep, documentation search).

## Feature areas

| Area | Syncro | Haley today |
|---|---|---|
| Tickets | Views, parent/child tickets, blueprints, automations, canned responses, worksheets, timers | Own ticketing, SLA timers, two-way sync with Syncro and four other PSAs |
| Device management | Windows/Mac agent, policies, monitors, 700+ script library, Windows and third-party patching, Splashtop | NinjaOne and Intune tools. **No Syncro RMM** |
| Microsoft 365 | Entra sync and actions, licence billing, CIS baselines with drift alerts (Team plan) | Entra, licences, MFA, mailboxes, Intune, admin-consent onboarding, security-review recipe |
| AI | Summaries, triage and dispatch, approval-only remediation, MCP | Autonomous within policy, MFA step-up, sealed credentials, 36 recipes, client memory |
| End-user channels | Portal, live chat, email to ticket | Email (DMARC-checked), Slack, Teams, chat bridge |
| Billing | Invoices, contracts, recurring billing, payments | AI cost and time-saved reporting only (billing is the PSA's job) |

## The Syncro API: what Haley can use

**Basics:**
- Auth is an API token, sent as a Bearer header or `api_key` parameter, with per-token permissions and an optional expiry.
- The rate limit is **180 requests per minute per IP**.
- Results are paged 25 per page in most lists.

| Need | Endpoint | Notes |
|---|---|---|
| The requester's computer | `GET /customer_assets/assets_by_contact/{contact_id}` | Pair with `GET /contacts?customer_id=` |
| Device details and health | `GET /customer_assets/{id}` | `rmm_store.triggers` flags: BSOD, no AV, firewall, low disk, SMART failure, agent offline, app crash, device manager. No live CPU/RAM fields in the spec |
| Installed software | `GET /customer_assets/{id}/installed_applications` | |
| Patch status | `GET /customer_assets/{id}/patches` | Read-only: installed, missing, failed. **No API to approve or deploy patches** |
| RMM alerts | `GET /rmm_alerts?status=active`, `GET /rmm_alerts/{id}` | |
| Silence or clear an alert | `POST /rmm_alerts/{id}/mute?mute_for=…`, `DELETE /rmm_alerts/{id}` | Clearing is a delete |
| Run a script | `POST /rmm/public_scripts/{asset_id}/schedule` | Needs "Scripts - Execute". Now or later only, not recurring. **Returns no job id. There is no endpoint to list scripts or read their output**, so script ids must be configured and results come back through alerts or the asset |
| Log time | `POST /tickets/{id}/timer_entry`, `/ticket_timers` | Duration, notes, product (labour type). Can create a charge |
| Contracts | `GET /contracts` | Covered products and non-billable products |
| Appointments | `/appointments` (full CRUD) | Optionally linked to a ticket and emailed to the customer |
| Canned responses | `GET /canned_responses?query=` | Needs the "Canned Responses - Manage" permission even to read |
| Search | `GET /search?query=`, `GET /tickets?asset_serial=` | |
| Webhooks | Not in the REST API | Configured in Notification Center → Notification Sets (Tickets, RMM Alert, Script, SLA and others). **No documented signing**, so treat each delivery as a hint and re-read the record from the API |

## What to incorporate (prioritized)

1. **Syncro RMM connector (done).** Model it on NinjaOne and gate everything through the policy engine.
   - **Read tools:** the requester's devices (by contact), device health flags, installed apps, missing or failed patches, and active alerts.
   - **Change tools:**
     - Run an approved script (a per-client allowlist of Syncro script ids, since the API can't list them).
     - Mute or clear an alert.
     - Everything is policy-gated; scripts are **write** risk by default.
   - **Recipes:** low disk cleanup, print spooler restart, and "is this PC patched?". These match Syncro's own guided fixes, but Haley can run them unattended for a verified requester when the client's policy allows.
   - **Why it matters:** most Syncro MSPs run its RMM. Without this connector, Haley sees the ticket but not the machine.
2. **Alert-driven tickets (done, by polling every two minutes; opt-in per client).** Pull active Syncro RMM alerts, or receive them by webhook. Haley then:
   - investigates;
   - fixes what a recipe covers;
   - clears the alert and notes it on the PSA ticket;
   - escalates the rest with findings.

   This takes alert noise off technicians and is where Syncro's own AI requires a person.
3. **Log Haley's time to the PSA (done for Syncro).** When Haley works a synced ticket, add a timer entry with the duration, a summary and a configurable labour product, billable or not. This makes Haley's work visible in the MSP's own billing and contracts.
   - Add it as an optional `logTime` on the PSA adapter. ConnectWise, Autotask and HaloPSA all have time-entry APIs.
   - It extends item 8 of the Dex comparison into the PSA.
4. **Webhooks instead of polling (done).** One workspace URL (PSA sync page); a delivery triggers an immediate Syncro sync and alert check, collapsed to at most one every 10 seconds. Add a receiver for Syncro Notification Center webhooks (ticket and RMM-alert events), at a long secret URL.
   - On each delivery, re-fetch the ticket or alert from the API rather than trusting the payload.
   - Keep the two-minute poll as a fallback.
   - Customers' replies get picked up in seconds.
5. **Use the MSP's canned responses (done: `psa_find_canned_response`).** Let Haley search Syncro canned responses and use them as reply templates, so replies sound like the MSP. This needs a token permission most MSPs will have to add.
6. **Contract awareness (done: `psa_list_contracts`, with guidance to flag uncovered work).** Before work that would be billable, check the client's Syncro contract. If the work isn't covered, flag it to the technician rather than doing it silently.
7. **On-site handoff (done: `psa_book_appointment`, policy-gated, linked to the Syncro ticket).** When escalating hardware or on-site work, offer to create a Syncro appointment linked to the ticket for a technician to confirm.
8. **Ideas from Syncro's AI:**
   - **Skill-based dispatch on escalation:** suggest a technician based on who handled this client and category before, and current load.
   - **A one-paragraph summary** at the top of every synced ticket.
   - **An optional 1–5 satisfaction rating** alongside the "confirm it's fixed" step.

## What not to copy

- **Invoicing, payments and inventory.** The PSA already does these. Haley should feed it time and value, not replace it.
- **Its own endpoint agent, remote control or EDR marketplace.** Integrate with the RMM and security tools MSPs already pay for.
- **"Approve every action."** It is safe but caps automation. Haley's policy engine already offers that mode (Supervised) and also allows unattended fixes where the client permits.

## Positioning against Syncro's AI

| | Syncro AI (Team plan) | Haley |
|---|---|---|
| Who acts | A technician approves every step | Policy decides: unattended for verified end users, approval for risky or sensitive steps |
| Who can ask | Technicians, inside Syncro | End users by email, Teams, Slack or chat, plus technicians |
| Systems | Syncro only (plus Microsoft 365 on Team) | Syncro, ConnectWise, Autotask, HaloPSA, Dynamics, Microsoft 365, Intune, Google, NinjaOne, IT Glue, Hudu |
| Identity | Not described | Identity levels with Duo, Okta or SMS step-up, and sealed credential delivery |
| Model and hosting | Syncro-hosted | Any model, self-hostable |

**Pricing implication:** a Syncro MSP already pays $129–$179 per technician. A Haley add-on priced per technician has to justify itself against Syncro's Team-plan AI, which is included in that price. The argument is unattended end-user resolution, measured as confirmed fixes and hours saved.

## Sources

- https://syncrosecure.com/ · /pricing/ · /platform/ · /platform/mcp-server/
- https://syncrosecure.com/resources/syncro-2026-release-kickoff/
- https://syncrosecure.com/media-release/syncro-joins-anthropics-claude-connector-ecosystem-becoming-the-most-extensible-unified-it-management-platform-live-now-for-all-customers/
- https://syncro.helpjuice.com/2026/august-2026-release-notes · https://syncro.helpjuice.com/2026/september-2026-release-notes
- https://api-docs.syncromsp.com/swagger.json (API spec, 125 paths)
- https://docs.syncrosecure.com/imported/api-tokens · /rmm-101 · /administration/create-notification-sets · /administration/notification-events-reference
