# Haley

**An AI IT technician for managed service providers.** Connect each client's Microsoft 365 or Google Workspace tenant, and Haley works their tickets and IT tasks: she investigates, fixes what she's allowed to, asks a technician before anything risky, replies to the end user, documents what she learned, and hands off cleanly when a human is needed.

End users just message Haley by **email, Slack, Microsoft Teams or chat**. When the channel proves who they are, she fixes their problem end to end with no technician involved: password resets, lost-phone sign-in passes, sign-outs, licenses, out-of-office. Anything risky, unverified, or affecting someone else falls back to a technician automatically. The full rules are in [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md).

Haley is **AI-agnostic**. She runs on Claude by default, and any other model with tool calling works too: OpenAI, Azure OpenAI, Gemini, Mistral, Groq, Together, OpenRouter, DeepSeek or xAI. So do open-weight models you host yourself with Ollama, vLLM or LM Studio. Add as many keys and models as you like, set a default, choose a model per client, and chain fallbacks.

## What it does

| | |
|---|---|
| **Plug in client platforms** | Microsoft 365 through Microsoft Graph: Entra ID, licenses, groups, MFA methods, mailbox auto-replies and service health, plus **Intune** (device details, installed apps, BitLocker recovery keys, sync, restart, retire, wipe, and on-demand remediation scripts). MSPs connect clients with **one admin-consent link** and a tenant discovery that pre-fills the client's settings ([docs/M365_ONBOARDING.md](docs/M365_ONBOARDING.md)). Google Workspace (users, groups, org units, 2SV status, suspensions, sign-outs) through the Admin SDK. Each has a **sandbox mode**, a simulated tenant you can try Haley against without credentials. Also **NinjaOne RMM** (device health, alerts, pending patches, running your existing automation scripts and normal reboots, all policy-gated), **SyncroMSP RMM** (device health flags, missing and failed patches, installed software, alerts, running the scripts you allow for each client, and muting or clearing alerts, with an optional **ticket for each new alert** that Haley works herself), **IT Glue** and **Hudu** documentation (read-only, never passwords), and a **generic REST API** connector for any other SaaS with an API key (read-only unless you allow writes). |
| **Talk to end users where they are** | Email (DMARC-checked, threaded by `[#1234]`), Slack (DMs and @mentions), Microsoft Teams (Entra-verified), and a signed chat bridge for anything else. Haley acknowledges immediately, replies on the same channel, and picks up follow-up messages on her own. See [docs/CHANNELS.md](docs/CHANNELS.md). |
| **Work tickets** | Haley triages (category, priority), investigates with read-only tools, makes the fix, replies to the requester, and writes a summary for technicians. SLA timers per priority escalate breaches automatically. |
| **Fix things unattended, safely** | The **Unattended** policy resolves verified self-service requests with no technician. Identity assurance levels, authorized approvers, protected accounts, per-person and hourly limits, and a per-client **Pause Haley** kill switch keep it safe. |
| **Human approval where it matters** | Each client has an autonomy policy plus optional **policy rules** (deny, require approval from named technicians, or allow) matched by tool, target, department and requester. Every change to a customer system is checked and either runs, waits in the approval queue, or is blocked. **Hard rails** that no setting can relax cover device wipes, admin groups, and credentials that get past someone else's MFA. |
| **Keep secrets away from the model** | Temporary passwords and Temporary Access Passes are encrypted. They go straight to a verified requester's private chat or are revealed to a technician on click (audited). The model only ever sees a placeholder. |
| **Run IT tasks** | A library of 39 **recipes** (onboarding, offboarding, license clean-up, mailbox access, BitLocker, stale devices, NinjaOne and Syncro patching and alert triage, documentation and more), each showing whether the client has the integrations it needs, with recipes that make changes opening in plan mode first. Run them once or on a schedule; Haley can also schedule her own follow-ups (for example, "remove this temporary access Friday"). |
| **Verify identity like a pro** | Step-up MFA before sensitive self-service: **Duo push**, **Okta Verify push**, or a **one-time code by SMS** to the mobile number on the user's account. Email requesters who pass get their fix, and their credential arrives as a view-once link. Denials escalate as possible impersonation and lock the ticket. |
| **Live in your PSA** | Two-way sync with **SyncroMSP**, **ConnectWise PSA**, **Autotask PSA**, **HaloPSA** and **Dynamics 365 Customer Service**. PSA tickets for mapped customers are imported and worked by Haley, customer comments continue them, and her replies, notes and status go back. Tickets that start in Haley are created in the PSA, so billing sees them. Haley can also **log her time** on the PSA ticket in Syncro, ConnectWise, Autotask or HaloPSA: either her actual working time, or your minutes-per-ticket estimate. Entries are non-billable, and your technicians decide what to bill. She also:
- uses your **saved replies** (canned responses);
- **checks the client's contracts** before work that may be billable;
- **books on-site appointments** when she escalates.

A **Syncro webhook** makes changes sync within seconds. |
| **Plan before acting** | Plan mode is a dry run against the real tenant. Every change is simulated and the run reports which steps would run automatically, which need approval, and why. |
| **Help technicians help people** | Every ticket shows a **requester snapshot**, read live from the client's systems: account status, MFA, licenses, groups, their devices and any problems with them, and their recent tickets. It also shows **similar past tickets** with how they were fixed, and matching knowledge articles.<br><br>When several people report the same thing within an hour, Haley flags a **possible outage**. A technician can then update everyone affected at once, on the channel each person used, or resolve them all together.<br><br>On any ticket, technicians can ask Haley to **draft a reply**, **suggest next steps**, or **summarize** the ticket. She writes; the technician decides. |
| **Keep end users in the loop** | Every email from Haley links to a private **status page**: the request's status and conversation, a reply box, and "It's fixed" / "Still broken" buttons, with no sign-in. Technicians can copy the link for any other channel. |
| **Prove value** | A per-client report for QBRs: tickets, % resolved by Haley alone, % the user confirmed fixed, SLA compliance, changes made, and estimated hours saved. After resolving, Haley asks the requester to confirm; unanswered tickets close on their own. |
| **Bill for it** | A monthly **Usage & billing** page: AI cost per client and per run at the prices you set for each model, an optional markup for passing it through, hours saved, and active technicians, with CSV export. Pricing options are in [docs/PRICING.md](docs/PRICING.md). |
| **Document and remember** | Haley searches the knowledge base before troubleshooting and writes or updates Markdown articles (runbooks, environment overviews, audit reports) as she goes. She also keeps short **per-client notes** (quirks, who approves what, recurring fixes) that she sees on every later run. Notes picked up from an end user's ticket wait for a technician to confirm them. |
| **Audit everything** | Every approval, rejection, executed change, blocked action, credential reveal and policy change is logged. |

### Autonomy policies

|                | Read / Haley-internal | Write (licenses, groups, new users) | Destructive (password resets, TAPs, blocking sign-in, revoking sessions) |
|----------------|------|------|------|
| **Read only**  | runs | blocked; Haley recommends it instead | blocked |
| **Supervised** (default) | runs | needs approval | needs approval |
| **Autonomous** | runs | runs | needs approval |
| **Unattended** | runs | runs for the requester's own account or an authorized approver; access grants need an approver | runs for the requester's **own** account with Slack/Teams/chat identity (never email alone), within per-person limits |

Protected accounts always need a technician, in every mode. The details are in [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md).

## Quick start

### In your browser (GitHub Codespaces)

On GitHub, click **Code → Codespaces → Create codespace**, or open [codespaces.new/BloodcraneRT/Haley](https://codespaces.new/BloodcraneRT/Haley). It installs, builds and starts Haley, then opens the dashboard on a forwarded port that only your GitHub account can reach. To let Haley work tickets, add `ANTHROPIC_API_KEY` as a [Codespaces secret](https://github.com/settings/codespaces) or add any provider's key on the **AI models** page.

### On your machine

Requires Node.js 22.13 or later.

```bash
npm run install:all
cp .env.example .env            # optional; dev/start load it automatically
export ANTHROPIC_API_KEY=sk-ant-...

npm run dev:server              # API on http://localhost:8787
npm run dev:web                 # dashboard on http://localhost:5173
```

`dev:server` and `start` load the root `.env`, then an optional `server/.env`. Server-specific values override the root file; existing environment variables take precedence over both.

Open the dashboard and click **Load demo workspace**. Then try the **End-user simulator**: set Contoso to Unattended and message Haley as `megan.bowen@contoso.example`. It creates two sandbox clients (Contoso on Microsoft 365, Acme Health Clinic on Google Workspace), some runbooks, and realistic tickets, including a lockout, a mailbox access request, an Exchange degradation, and a new hire. Open a ticket and click **Run Haley**.

Without an Anthropic API key the whole app works except the agent itself; runs fail with a clear credentials error.

### Production

```bash
npm run build
NODE_ENV=production HALEY_API_TOKEN=... HALEY_SECRET_KEY=$(openssl rand -hex 32) ANTHROPIC_API_KEY=... npm start
```

or with Docker:

```bash
docker build -t haley .
docker run -p 8787:8787 -v haley-data:/data \
  -e HALEY_API_TOKEN=... -e HALEY_SECRET_KEY=... -e ANTHROPIC_API_KEY=... haley
```

The server serves the built dashboard and the API from one port. In production it refuses to start without `HALEY_API_TOKEN` and `HALEY_SECRET_KEY`. All settings are listed in [`.env.example`](.env.example).

## Connecting a real client

**Microsoft 365:** register one multi-tenant app for your MSP, set `HALEY_M365_CLIENT_ID` and `HALEY_M365_CLIENT_SECRET`, and connect each client with **Connect with admin consent**. That link works for the client's Global Admin, or for your partner admin through GDAP. Haley then discovers the tenant and suggests settings. See [docs/M365_ONBOARDING.md](docs/M365_ONBOARDING.md). Alternatively, register an app in each client's tenant and paste the tenant ID, client ID and secret.

**Google Workspace:** create a service account with the Admin SDK enabled, authorize its client ID for domain-wide delegation with the directory scopes shown in the connect dialog, and paste the JSON key plus a super admin email for Haley to act as.

Credentials are encrypted at rest (AES-256-GCM) and never returned by the API.

## Channels and intake

Email, Slack, Teams and the chat bridge are enabled by setting their secrets (see [`.env.example`](.env.example)), and each is set up as described in [docs/CHANNELS.md](docs/CHANNELS.md). PSAs can also post tickets to `POST /api/intake` with the API token.

## Project layout

```
server/   Fastify API, SQLite store, connectors, agent runner (TypeScript)
web/      React dashboard (Vite)
docs/     Architecture and extension guide
```

```bash
npm test            # server test suite (policy, connectors, agent loop, API)
npm run typecheck
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the agent loop, approvals, channels, AI providers, PSA sync and connectors fit together, and how to add a new platform. [docs/research/INTEGRATION_API_NOTES.md](docs/research/INTEGRATION_API_NOTES.md) has the source-checked API details behind the Syncro, ConnectWise, Autotask, HaloPSA, Dynamics, Duo, Okta and Twilio integrations. For the competitive landscape and where these features came from, see [docs/research/COMPETITIVE_LANDSCAPE.md](docs/research/COMPETITIVE_LANDSCAPE.md), [docs/research/DEX_COMPARISON.md](docs/research/DEX_COMPARISON.md), [docs/research/SYNCRO_COMPARISON.md](docs/research/SYNCRO_COMPARISON.md) and [docs/research/NEOAGENT_COMPARISON.md](docs/research/NEOAGENT_COMPARISON.md).
