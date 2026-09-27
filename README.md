# Haley

**An AI IT technician for managed service providers.** Connect each client's Microsoft 365 or Google Workspace tenant, and Haley works their tickets and IT tasks: she investigates, fixes what she's allowed to, asks a technician before anything risky, replies to the end user, documents what she learned, and hands off cleanly when a human is needed.

End users just message Haley by **email, Slack, Microsoft Teams or chat**. When the channel proves who they are, she fixes their problem end to end with no technician involved: password resets, lost-phone sign-in passes, sign-outs, licenses, out-of-office. Anything risky, unverified, or affecting someone else falls back to a technician automatically. The full rules are in [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md).

Haley is **AI-agnostic**. She runs on Claude by default, and any other model with tool calling works too: OpenAI, Azure OpenAI, Gemini, Mistral, Groq, Together, OpenRouter, DeepSeek or xAI. So do open-weight models you host yourself with Ollama, vLLM or LM Studio. Add as many keys and models as you like, set a default, choose a model per client, and chain fallbacks.

## What it does

| | |
|---|---|
| **Plug in client platforms** | Microsoft 365 (Entra ID, licenses, groups, MFA methods, Intune devices, mailbox auto-replies, service health) through Microsoft Graph. Google Workspace (users, groups, org units, 2SV status, suspensions, sign-outs) through the Admin SDK. Each has a **sandbox mode**, a simulated tenant you can try Haley against without credentials. |
| **Talk to end users where they are** | Email (DMARC-checked, threaded by `[#1234]`), Slack (DMs and @mentions), Microsoft Teams (Entra-verified), and a signed chat bridge for anything else. Haley acknowledges immediately, replies on the same channel, and picks up follow-up messages on her own. See [docs/CHANNELS.md](docs/CHANNELS.md). |
| **Work tickets** | Haley triages (category, priority), investigates with read-only tools, makes the fix, replies to the requester, and writes a summary for technicians. SLA timers per priority escalate breaches automatically. |
| **Fix things unattended, safely** | The **Unattended** policy resolves verified self-service requests with no technician. Identity assurance levels, authorized approvers, protected accounts, per-person and hourly limits, and a per-client **Pause Haley** kill switch keep it safe. |
| **Human approval where it matters** | Each client has an autonomy policy. Every change to a customer system is checked against it and either runs, waits in the approval queue, or is blocked. |
| **Keep secrets away from the model** | Temporary passwords and Temporary Access Passes are encrypted. They go straight to a verified requester's private chat or are revealed to a technician on click (audited). The model only ever sees a placeholder. |
| **Run IT tasks** | "Ask Haley" templates for onboarding, offboarding, license audits, security posture reviews, environment documentation, and service health checks. Run them once or on a schedule; Haley can also schedule her own follow-ups (for example, "remove this temporary access Friday"). |
| **Verify identity like a pro** | Step-up MFA before sensitive self-service: **Duo push**, **Okta Verify push**, or a **one-time code by SMS** to the mobile number on the user's account. Email requesters who pass get their fix, and their credential arrives as a view-once link. Denials escalate as possible impersonation and lock the ticket. |
| **Live in your PSA** | Two-way sync with **SyncroMSP** and **Dynamics 365 Customer Service**. PSA tickets for mapped customers are imported and worked by Haley, customer comments continue them, and her replies, notes and status go back. Tickets that start in Haley are created in the PSA, so billing sees them. |
| **Plan before acting** | Plan mode is a dry run against the real tenant. Every change is simulated and the run reports which steps would run automatically, which need approval, and why. |
| **Prove value** | A per-client report for QBRs: tickets, % resolved by Haley alone, SLA compliance, changes made, and estimated hours saved. |
| **Document** | Haley searches the knowledge base before troubleshooting and writes or updates Markdown articles (runbooks, environment overviews, audit reports) as she goes. |
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

Requires Node.js 22.13 or later.

```bash
npm run install:all
cp .env.example .env            # optional for local dev
export ANTHROPIC_API_KEY=sk-ant-...

npm run dev:server              # API on http://localhost:8787
npm run dev:web                 # dashboard on http://localhost:5173
```

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

**Microsoft 365:** register an app in the client's Entra admin center, grant the Graph application permissions listed in the connect dialog, give the service principal the User Administrator role if Haley should reset passwords, and paste the tenant ID, client ID and secret.

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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the agent loop, approvals, channels, AI providers, PSA sync and connectors fit together, and how to add a new platform. [docs/research/INTEGRATION_API_NOTES.md](docs/research/INTEGRATION_API_NOTES.md) has the source-checked API details behind the Syncro, Dynamics, Duo, Okta and Twilio integrations. For the competitive landscape and where these features came from, see [docs/research/COMPETITIVE_LANDSCAPE.md](docs/research/COMPETITIVE_LANDSCAPE.md).
