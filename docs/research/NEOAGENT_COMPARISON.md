# Haley and Neo Agent (neoagent.io)

Researched 2026-10-08 from Neo's site, pricing page, docs (`docs.neoagent.io`), release notes and public changelog. Pricing, supervised mode and memory were checked against the primary pages. Customer numbers ("200+ MSPs", "34× faster onboarding", "$40K a year saved") are Neo's own marketing and weren't verified. Funding figures conflict between sources and are left out.

## TL;DR

Neo is the **closest competitor Haley has**. It is also an "AI technician for MSPs" that works inside the MSP's PSA, and it targets the same tickets: password resets, onboarding, triage, RMM scripts.

**Where Neo is ahead:**
- **Breadth.** About 50 integrations, including security, networking and backup tools, and a vendor-spec layer that ships several new ones a week.
- **Dispatch.** It assigns tickets using technician skills, shifts, calendars and Teams presence.
- **Approvals in Microsoft Teams.** Cards there show the action, the instruction behind it and the evidence. Approvers can approve, reject or ask for changes.
- **Inbound phone agent.**
- **Insights.** A "problem map" over closed tickets that ranks what to automate. A free version works as a sales tool for prospects.
- **QA.** Ticket, time-entry and sentiment checks on technicians' work.

**Where Haley is ahead:**
- **Real identity checks.** Neo verifies identity by writing "verify the requester's identity" into an agent's instructions. Its own Insights page lists Duo and Google Workspace as systems no Neo integration reaches. Haley has assurance levels, Duo/Okta/SMS step-up, protected accounts and hard rails no setting can relax.
- **Secrets never reach the model.**
- **Unattended fixes for verified end users.** These are bound by per-person and hourly limits and a kill switch.
- **Other platforms.** Google Workspace and the Dynamics 365 PSA.
- **Model choice and hosting.** Any AI model, with your own keys, and self-hosting. Neo doesn't disclose its model and runs only on its own Azure.
- **A no-sign-in status page for end users.** It has "fixed / still broken" buttons.
- **Outage detection.** It can broadcast to everyone affected.

**What to take, in order:**
1. Approval cards in Teams and Slack.
2. Learning from technicians' decisions.
3. A ticket-history "automation opportunities" report.
4. Dispatch suggestions.
5. Reading screenshots and attachments.

The full list is below.

## What Neo is

- **Company:** London, founded 2023. It was spun out of Transputec, a London MSP that was its first customer (a 65-person service desk).
  - CEO and co-founder: Nikhil Sehgal. CTO and co-founder: Anton Shumskih.
  - Hired a CMO in September 2026: Dana Liedholm, formerly at ID Agent and Kaseya.
  - SOC 2 Type 2 since July 2026.
  - Sold through Pax8 and listed as a Teams app on Microsoft Marketplace.
- **How it's built:**
  - **Building blocks:** triggers and schedules, ticket filters (rules plus AI), **workflows** (fixed chains of "Smart Actions") and **agents**.
  - **Agents:** an LLM given a plain-English brief, tools with None/Read/Write permission per integration, and on-demand "skills".
  - **How agents run:** on a ticket, on a schedule, or in chat.
  - **Built-in agent tools:** a Linux sandbox, sub-agents, web search, and Neo's own API (an agent can configure Neo).
- **Smart Actions:**
  - **Triage:** type, priority, due date.
  - **Ticket handling:** summary, merge candidates, similar and recurring tickets, suggested resolution, relevant configuration.
  - **Dispatch:** suggest a technician and assign.
  - **Messages:** acknowledge, build a message, chase the customer then auto-close, executive summary.
  - **QA and analysis:** sentiment, ticket QA, time-entry QA, technician work analysis, data analysis (AI-written Python), M365 onboard/offboard.
- **Approvals ("Technician-in-the-Loop"):**
  - **When it asks:** per tool, per permission group, by instruction, or for a whole run.
  - **Where cards go:** Teams people, channels or group chats, or the Neo Inbox.
  - **What approvers can do:** approve, reject or **ask for changes**.
  - **Test mode** simulates every write.
  - **Supervised mode** (September 2026):
    - It sends a **plan card** first, then **one card per change, per record**, each showing **Action / Because (the instruction) / Evidence (what it read)**.
    - It stops and asks when instructions leave a decision open, offering options and suggested wording for the instructions.
    - An approval lasts for that run only.
    - After a run, **Train** has Neo's support agent read every decision, rejection and note and propose an edit to the agent's instructions. Nothing changes until you apply it.
  - Also: an audit log (30 days), a live reasoning view, version history with rollback, and 90-day backfills over past tickets.
- **End users:**
  - Replies through the PSA (ConnectWise replies go under the technician's name and photo).
  - A white-label bot in Teams and Slack, priced per client company.
    - The bot is deliberately "a smart interface, not a powerful agent". It only takes intake (with intent forms) and the ticket is the security boundary.
    - It identifies people by M365 tenant or Slack workspace.
  - Outbound SMS.
- **Phone agent:** inbound only, local numbers in six countries.
  - Identifies callers by caller ID against the PSA, or by spoken company name.
  - Opens tickets, does warm or blind transfer, and covers after-hours and overflow.
  - Voices from ElevenLabs or Cartesia.
- **Technicians:**
  - Neo in Teams: "work the queue", "give me my next ticket", run scripts, onboard a starter, build reports.
  - Dashboard chat, and a support agent that builds agents for you.
- **Memory:** facts, rules and preferences, MSP-wide or per company. Up to 20 pins per company and 10 MSP-wide.
  - The docs say "Automatic discovery is **not enabled yet**; for now, you curate memory yourself." That contradicts a June release note.
  - Agents can review their own past runs.
- **Reporting:**
  - A Performance & Cost page.
  - **Insights**, which ranks automation opportunities by hours from closed tickets. A free read-only Insights report is offered to prospects.
  - QBRs are built as recipes from ScalePad, Huntress and PSA data, not as a dedicated feature.
- **Integrations:**
  - **PSA:** ConnectWise, Autotask, HaloPSA, Syncro, ServiceNow.
  - **RMM:** NinjaOne, Datto RMM, N-central, N-sight, ConnectWise Automate/Asio, VSA X, ScreenConnect, Syncro, Addigy.
  - **Documentation:** IT Glue, Hudu, SharePoint, Confluence, Lexful.
  - **Identity:** Entra, on-prem AD and Exchange (through the RMM), Intune, CIPP.
  - **Security:** Huntress, SentinelOne, ThreatLocker, AutoElevate, Proofpoint, Mimecast and others.
  - **Network:** UniFi, Meraki, Auvik, Domotz, WatchGuard.
  - **Other:** TimeZest, ScalePad, Pax8 and distributors.
  - Plus a custom API connector and a public REST API.
- **Pricing** (from the live pricing page): credits, month-to-month, no setup fee, 14-day trial with no card.

  | Plan | Price/mo | Credits | Per credit | Neo's estimate |
  |---|---|---|---|---|
  | Pilot | $500 | 2,500 | $0.20 | ~750 tickets, 64 h saved |
  | Starter | $1,300 | 10,000 | $0.13 | ~3,000 tickets, 257 h saved |
  | Growth | $2,340 | 20,000 | $0.12 | ~6,000 tickets, 513 h saved |
  | Custom | Sales | 20,000+ | — | — |

  - **How credits are spent:**
    - A workflow costs 1 credit per ticket.
    - A triggered agent pays once per run at the highest tool tier it uses (1, 2 or 3). Any write permission makes it tier 3.
    - Scheduled and chat agents pay per tool call.
  - **End-user bot:** $9, $29 or $79 per client company per month (up to 24, 99 or 499 active users). Clients nobody used it with that month are free.
  - **Phone agent:** $300/mo flat, and the docs add 1 credit per call minute.
- **Hosting:** SaaS on Microsoft Azure only, with per-tenant isolation and Azure Key Vault. MSPs whitelist Neo's IPs for self-hosted tools.
  - It doesn't train on customer data.
  - **The AI model isn't disclosed.** There is no model choice and no bring-your-own-key.

## Side by side

| Area | Neo | Haley today |
|---|---|---|
| Positioning | AI technician inside the MSP's PSA | The same, plus Haley's own ticketing and channels |
| PSAs | ConnectWise, Autotask, Halo, Syncro, ServiceNow | ConnectWise, Autotask, Halo, Syncro, **Dynamics 365**. No ServiceNow |
| RMM | ~10, including Datto, N-central, Automate, VSA X | NinjaOne, Syncro |
| Identity platforms | Entra, on-prem AD and Exchange through the RMM, Intune, CIPP | Entra, Intune, **Google Workspace**. No on-prem AD |
| Security, network and backup tools | ~20 | None (only the generic REST connector) |
| End-user channels | PSA email, white-label Teams/Slack bot, SMS out, **inbound phone** | Email (DMARC-checked), Teams, Slack, chat bridge, **status page with no sign-in** |
| Identity verification | An instruction in the agent's prompt; tenant and workspace matching for the bot | **Assurance levels, Duo/Okta push, SMS code**; denials lock the ticket as possible impersonation |
| Secrets | Generates passwords and "secure links" | **Sealed**: the model only sees a placeholder; view-once delivery to a verified requester |
| Autonomy controls | Per-tool approvals, permission groups, test mode, supervised mode | Four autonomy levels × risk × identity, per-client rules with named approvers, **hard rails**, per-person limits, kill switch, plan mode |
| Where approvals happen | **Teams cards** and Neo Inbox; approve, reject or **ask for changes** | Dashboard approval queue only; approve or reject |
| Learning | Curated memory; **Train** turns a run's decisions into a proposed instruction edit; `review_past_run` | Per-client notes, with end-user-sourced notes waiting for a technician |
| Dispatch | Skills, shifts, calendars, Teams presence, SLA slots, approval cards | None. Escalations go to the queue unassigned |
| Help for technicians | Teams chat, "next ticket", reports | Requester snapshot, similar tickets, outage detection and broadcast, draft reply / next steps / summary |
| QA | Ticket QA, time-entry QA, sentiment | None |
| Attachments | Screenshots read by vision; .eml and .pdf read | **Not read** |
| Reporting | Performance & Cost, **Insights** problem map | Per-client QBR report, usage and billing with AI cost and markup |
| AI model and hosting | Undisclosed model, Neo's Azure | Any provider, your own keys, self-hostable |
| Pricing | $500–$2,340/mo in credits, plus bot and phone add-ons | MSP-defined: AI cost pass-through with markup, per-seat options ([PRICING.md](../PRICING.md)) |

## What to incorporate (prioritized)

1. **Approve from Teams and Slack.** This is the biggest day-to-day gap. Approvals now wait in the dashboard, so an "approval required" change sits until someone looks.
   - Post an approval card to a per-client (or workspace) Teams or Slack channel, or DM the client's named approvers.
   - Show the change, the policy reason ("needs approval because …") and the evidence Haley read.
   - Buttons: **Approve**, **Reject**, and **Ask for changes** (a note that goes back into the run as a tool result).
   - Only listed approvers can decide, mapped by Entra or Slack identity, which reuses the approver checks in `runner.ts`.
   - Keep the dashboard queue as the record. Update the card when the change is decided anywhere.
   - Size **M**. Haley already has Teams and Slack adapters and decision routing.
2. **Learn from technicians' decisions.** This is Neo's "Train" button, with Haley's memory as the place it lands.
   - When a technician rejects a change, asks for changes, or edits a copilot draft before sending, record the reason.
   - At the end of the run, propose a **per-client note** or a **policy rule**, for example "Acme: never remove licenses, ask Dana". It is applied only on a technician's click, like end-user-sourced notes today.
   - This makes Haley better per client without anyone writing prompts. Size **S–M**.
3. **"What would Haley handle?" report from ticket history.** A version of Neo's Insights, and a strong pre-sales tool.
   - Read the last 90 days of closed tickets from the connected PSA (reusing the import path, without creating Haley tickets).
   - Cluster them with `similar.ts`, label each cluster, and match it to the recipes and tools Haley has.
   - Estimate hours a month from ticket counts × the workspace's minutes-per-ticket.
   - Output a ranked list: "Password resets: 112 tickets/mo, Haley handles unattended once Duo is connected."
   - It can run read-only against a prospect's PSA before anything else is set up. Size **M**.
4. **Dispatch suggestions on escalation.** It was also suggested by Syncro's AI (Syncro comparison, item 8).
   - When Haley escalates, suggest a technician from who closed similar tickets for that client and category, their open load, and working hours if configured.
   - Show the suggestion on the ticket with one-click assign. Optionally set the PSA owner when the policy allows.
   - Leave out calendar and Teams presence at first. Size **M**.
5. **Read screenshots and attachments.** End users send screenshots of error dialogs more often than they type the error.
   - Pass image attachments from email, Teams, Slack and the PSA to models that support images. Extract text from PDFs and forwarded .eml files.
   - Size the images down, keep them out of logs, and treat their text as untrusted like any ticket content.
   - Size **M**. It touches each channel's intake and the AI layer's message parts.
6. **Ticket QA and sentiment.** These are cheap wins on the copilot path.
   - **Before a technician closes a ticket**, run one model call to check:
     - the resolution note exists and explains the fix;
     - the requester was told;
     - the time entry matches the work.
   - **Flag frustrated or VIP requesters** (repeat contacts, angry tone) so the ticket is escalated or prioritized.
   - Size **S** each. Reuse `copilot.ts` and record usage under a new `purpose`.
7. **More integrations, chosen by MSP demand.** Neo's breadth is its headline. Haley shouldn't chase all ~50, but three are common enough to matter:
   - **Datto RMM** or **N-central**, the next most common RMMs after NinjaOne.
   - **Huntress** or **SentinelOne** alerts, as alert-driven tickets like Syncro's.
   - **CIPP**, which many Microsoft-heavy MSPs already use for multi-tenant actions.

   Each is **M**. Do them one by one, behind the policy engine.
8. **Inbound phone, as a partner integration rather than a build.** Voice is a large surface: telephony, voices, latency, recordings, regional numbers. Neo charges $300/mo for it.
   - Start with **voicemail and call transcript to ticket**: accept a transcript webhook from the MSP's phone system or a voice-AI provider, identify the caller by phone number against the PSA contact, and open the ticket.
   - Haley then follows up on a channel where identity can be verified.
   - Never do password resets from caller ID alone. Size **S** for the webhook.
9. **Pricing reference.** Neo makes "AI technician" cost about $0.12–$0.20 per credit, with one credit per simple workflow ticket and tier-3 agent runs costing more.
   - That gives MSPs a benchmark: roughly **$0.36–$0.60 for a tier-3 agent-handled ticket** (3 credits), before the $500 minimum.
   - Haley's usage page already shows real AI cost per client and per run. Add a "cost per resolved ticket" column to [PRICING.md](../PRICING.md)'s report so MSPs can compare directly. Size **S**.

## What not to copy

- **Identity checks as prompt text.** Neo's docs show identity verification as a line in the agent's instructions. A model can be talked out of an instruction. Haley's assurance levels, step-up and hard rails are enforced in code, and that is the main point of difference in a sale.
- **A general-purpose Linux sandbox and "AI writes Python" tools for the ticket agent.** They are useful for analysis, but they are a large new attack surface for an agent that reads untrusted ticket text. Keep analysis in fixed reports.
- **Credit tiers that change with the tools an agent *could* use.** They are hard to predict. Haley's per-run cost, with an MSP-set markup, is simpler to explain.
- **An undisclosed model on one cloud.** Model choice, your own keys and self-hosting are worth keeping prominent.
- **Approvals that only last one run.** Neo makes supervised runs ask again every time, which suits training mode. Haley's per-client rules and named approvers cover the steady state better.

## Worth noting

- **Neo's bot design follows the same principle as Haley's.** The chat surface is "a smart interface, not a powerful agent", and the ticket is the security boundary. Haley goes further: the chat surface can itself act for a verified requester under the Unattended policy, within limits. That is the feature to lead with.
- **Neo publishes comparison pages** against Rewst, Pia, Thread, MSPBots and Zofiq. Its line against Pia is "works the ticket before anyone opens it", which Haley also does. Expect Neo's new CMO to push MSP channel marketing hard (Pax8, events, Kaseya alumni).

## Sources

- https://www.neoagent.io/, /features, /pricing, /faqs, /case-studies, /privacy-policy, /compare/neo-vs-pia
- https://www.neoagent.io/blog/release-note-september-2026, /blog/release-note-june-2026, /blog/neo-agent-soc-2-type-2-compliant, /blog/neo-hires-dana-liedholm
- https://docs.neoagent.io/llms.txt and /llms-full.txt
- https://docs.neoagent.io/core/agents, /core/technician-in-the-loop, /core/supervised-mode, /core/memory, /core/phone-agent, /chat-agents/how-end-user-bots-work, /product/billing-and-credits
- https://feedback.neoagent.io/changelog
- https://itchanneloxygen.com/meet-the-msp-ai-copilot-gunning-for-90m-arr (origin story, October 2023)
