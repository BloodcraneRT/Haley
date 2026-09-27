# Haley

**An AI IT technician for managed service providers.** Connect each client's Microsoft 365 or Google Workspace tenant, and Haley works their tickets and IT tasks: she investigates, fixes what she's allowed to, asks a technician before anything risky, replies to the end user, documents what she learned, and hands off cleanly when a human is needed.

Haley is powered by Claude through the Anthropic API.

## What it does

| | |
|---|---|
| **Plug in client platforms** | Microsoft 365 (Entra ID, licenses, groups, MFA methods, Intune devices, mailbox auto-replies, service health) through Microsoft Graph. Google Workspace (users, groups, org units, 2SV status, suspensions, sign-outs) through the Admin SDK. Each has a **sandbox mode**, a simulated tenant you can try Haley against without credentials. |
| **Work tickets** | Tickets come from the dashboard or the email/PSA intake webhook. Haley triages (category, priority), investigates with read-only tools, makes the fix, replies to the requester, and writes a summary for technicians. |
| **Human approval where it matters** | Each client has an autonomy policy. Every change to a customer system is checked against it and either runs, waits in the approval queue, or is blocked. |
| **Keep secrets away from the model** | Temporary passwords from resets and new accounts are encrypted and shown only to technicians, on click, with an audit entry. The model only ever sees `[delivered securely to the technician]`. |
| **Run IT tasks** | "Ask Haley" templates for onboarding, offboarding, license audits, security posture reviews, environment documentation, and service health checks. |
| **Document** | Haley searches the knowledge base before troubleshooting and writes or updates Markdown articles (runbooks, environment overviews, audit reports) as she goes. |
| **Audit everything** | Every approval, rejection, executed change, blocked action, credential reveal and policy change is logged. |

### Autonomy policies

|                | Read | Haley-internal (notes, KB, ticket fields) | Write (licenses, groups, new users) | Destructive (password resets, blocking sign-in, revoking sessions, suspending) |
|----------------|------|------|------|------|
| **Read only**  | runs | runs | blocked; Haley recommends it instead | blocked |
| **Supervised** (default) | runs | runs | needs approval | needs approval |
| **Autonomous** | runs | runs | runs | needs approval |

Destructive actions always need a human.

## Quick start

Requires Node.js 22.13 or later.

```bash
npm run install:all
cp .env.example .env            # optional for local dev
export ANTHROPIC_API_KEY=sk-ant-...

npm run dev:server              # API on http://localhost:8787
npm run dev:web                 # dashboard on http://localhost:5173
```

Open the dashboard and click **Load demo workspace**. It creates two sandbox clients (Contoso on Microsoft 365, Acme Health Clinic on Google Workspace), some runbooks, and realistic tickets, including a lockout, a mailbox access request, an Exchange degradation, and a new hire. Open a ticket and click **Run Haley**.

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

## Ticket intake

Point a mail-to-webhook service or your PSA at `POST /api/intake`:

```json
{ "from": "megan@contoso.com", "fromName": "Megan Bowen", "subject": "Can't open Teams", "body": "..." }
```

The ticket is routed to the client whose domain matches the sender, and Haley starts on it right away (pass `"autoRun": false` to skip that).

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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the agent loop, approvals and connectors fit together, and how to add a new platform.
