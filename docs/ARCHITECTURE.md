# Architecture

```
            ┌──────────────┐        ┌────────────────────────────── server ─────────────────────────────┐
 browser ──▶│  web (React) │──/api─▶│ app.ts (Fastify routes, token auth, validation)                    │
            └──────────────┘        │                                                                    │
 email ─────── /hooks/email ───────▶│ routes/hooks.ts ─▶ channels/* (verify caller, resolve identity)    │
 Slack ─────── /hooks/slack/events ▶│        │                     email · slack · teams · chat         │
 Teams ─────── /hooks/teams/messages│        ▼                                                           │
 chat bridge ─ /hooks/chat ────────▶│   ChannelHub: open/continue ticket, ack, start Haley, deliver ◀─┐  │
                                    │        │                                             replies  │  │
                                    │        ▼                                                      │  │
                                    │   AgentService (agent/runner.ts) ── tool-use loop ─▶ Claude API │  │
                                    │        │  policy.ts: run / approve / block per call ──────────┘  │
                                    │        ├─ built-in tools: tickets, replies, KB, follow-ups         │
                                    │        └─ connectors: m365 (Graph), google (Admin SDK), slack      │
                                    │           ninjaone (RMM), itglue, hudu (docs), rest (any API)      │
                                    │                                                                    │
                                    │   Scheduler: recurring tasks, Haley's follow-ups, SLA escalation   │
                                    │   Store (SQLite): orgs, integrations, tickets, runs, actions,      │
                                    │     schedules, kb_articles, audit_log; credentials AES-256-GCM     │
                                    └────────────────────────────────────────────────────────────────────┘
```

## The agent loop

`AgentService` (`server/src/agent/runner.ts`) runs a manual Claude tool-use loop rather than the SDK's tool runner, because a run must be able to **pause for hours** while a technician decides on an action, then resume from a different HTTP request or after the approval arrives.

1. A run starts from a ticket or a task. The first user message holds today's date, the organization context (autonomy policy, connected systems, MSP notes) and the ticket with its history. The system prompt (`agent/prompts.ts`) is identical for every run so it caches.
2. Each model turn is appended to `runs.messages` exactly as returned: the history is append-only, which keeps prompt caching and thinking-block replay valid.
3. For every `tool_use` block the runner validates the input with the tool's zod schema, resolves targets and safety checks, then evaluates the client's current policy and requester authority. Pause is checked before every call and again after asynchronous lookups:
   - **run**: executes now and records an `actions` row.
   - **block**: records a blocked action and returns an error result telling the model to recommend the step instead.
   - **approve**: records a `pending_approval` action and keeps going through the other calls in the turn.
4. If anything is pending, the run is saved as `awaiting_approval` together with the results already produced (`runs.pending`), and the ticket moves to `awaiting_approval`.
5. When the last pending action of a run is approved or rejected, `resume()` checks the kill switch and current policy before executing the approved ones. New blocks, failed verification and changed named approvers invalidate the old approval. Rejections become error results that carry the technician's note; all results return **in the order the model called them**, and the loop continues.
6. The loop ends on `end_turn` (the final text becomes the technician summary on the ticket), on a refusal, context or iteration limit (the run fails and the ticket is escalated), or on an API error.

### Any model: `server/src/ai/`

The runner stores conversations in a **provider-neutral format**: text, tool calls and tool results (`ai/types.ts`). Adapters translate to each provider's wire format.

- **`ai/anthropic.ts`, native Claude:**
  - adaptive thinking;
  - streaming with `finalMessage()`;
  - prompt caching of the system prompt and conversation;
  - eager input streaming;
  - server-side refusal fallbacks.

  Claude's own turns, thinking blocks included, are replayed untouched when the run continues on the same model.
- **`ai/openai.ts`, any OpenAI-compatible `/chat/completions` endpoint with function calling.** It handles tool calls without ids, non-JSON arguments and misreported finish reasons.
- **Model profiles** (`model_profiles` table, `ai/registry.ts`) hold the provider, model, base URL, an encrypted API key, options and a fallback profile.
  - There is one workspace default, and a client can override it (`settings.modelProfileId`).
  - `FallbackLlm` walks the fallback chain on errors.
  - Because the conversation is neutral, a run can continue on a different model: after a fallback, a default change, or a pause for approval.
  - Runs record which provider/model served them.
  - `POST /api/models/:id/test` checks that a model can call tools, since Haley can't work with one that can't.

On first start, a Claude profile is created from `HALEY_MODEL`, `HALEY_EFFORT` and `HALEY_FALLBACKS`, using the server's environment credentials.

### End-user channels

`channels/hub.ts` is the single entry point for messages from end users (see [CHANNELS.md](CHANNELS.md) for setup).

1. **Verify the caller.** Each webhook checks its own proof: a shared secret for email, Slack's HMAC signature with a replay window, the Bot Framework JWT for Teams (checked against Microsoft's published signing keys), and HMAC for the chat bridge.
2. **Resolve the client and the person.** The client comes from the email domain, the Slack workspace, the Entra tenant or the bridge. The person's **assurance level** comes from DMARC/DKIM alignment, the Slack profile email (guests excluded), or the Teams Entra object ID matched in the client's directory.
3. **Thread.** A message continues an open ticket if it matches the email subject tag or message ID, the Slack thread or DM, the Teams conversation, or the bridge thread, and establishes the same requester with at least the original channel's identity assurance. Unverified messages cannot reuse an earlier MFA step-up. Otherwise it opens a separate ticket, sends an acknowledgement and starts Haley. PSA comments that cannot establish a safe continuation remain visible to technicians but are excluded from later agent context.
4. **Follow-ups.** A message on a busy ticket sets `needs_followup`, and a fresh pass starts when the current run ends. Messages on escalated tickets wait for the technician.
5. **Replies.** `reply_to_requester`, technician replies and automatic notices ("needs a quick sign-off", "passed to the IT team") all go out on the ticket's channel, and the delivery result is stored on the timeline.

### Step-up verification

- **Providers:** verification providers are ordinary client integrations with `kind: "verification"`: Duo (`verification/duo.ts`, Auth API with v5 HMAC-SHA512 signing), Okta (`verification/okta.ts`, Factors API) and SMS code (`verification/sms.ts`, Twilio).
- **Phone lookup:** the SMS provider finds the user's mobile number through the client's other connectors (Microsoft 365 phone methods or the Google recovery phone).
- **Tools:** `verify_requester_identity` and, for codes, `confirm_verification_code` are available on ticket runs when a verifier exists.
- **Approval:** an approval stamps `mfa_verified_at`, and `effectiveAssurance()` counts it as the `mfa` level for 30 minutes.
- **Denial:** a denial escalates the ticket, and the runner blocks every customer change on it from then on.
- **Records:** attempts are stored in `verification_attempts`, which also drives the fatigue limits.
- **Credential links:** after step-up, email requesters receive credentials via `secret_links`, view-once and hashed (`routes/secretLinks.ts`).

### PSA sync: `server/src/psa/`

- **One interface:** `PsaAdapter` covers customers, changed tickets with comments, adding a comment, setting status and creating a ticket. Implementations are `psa/syncro.ts` (SyncroMSP REST v1), `psa/connectwise.ts` (ConnectWise PSA REST 3.0, tickets and notes), `psa/autotask.ts` (Autotask REST v1.0, tickets and ticket notes), `psa/halopsa.ts` (HaloPSA REST, tickets and actions) and `psa/dynamics.ts` (Dataverse Web API v9.2, cases and notes).
- **`PsaSync` pulls** changed tickets for mapped customers:
  - New tickets go through the channel hub (acknowledgement, then Haley works them).
  - A customer comment continues the ticket.
  - A technician comment is recorded without waking Haley.
  - Closing the ticket upstream resolves it in Haley.
- **Replies:** PSA-originated tickets are answered through a channel adapter as public PSA comments. Dynamics and Autotask notes don't notify customers (nor do ConnectWise notes unless the MSP says its board emails contacts), so those replies are also emailed.
- **Mirroring:** Haley's notes, actions and conversations from other channels go back upstream as internal comments. Tickets that start in Haley are created in the PSA.
- **Loop prevention:** `ticket_links` tracks the comment ids Haley posted and the events already mirrored, so nothing echoes back.
- **Schedule:** the scheduler syncs each connection every 2 minutes, and `POST /api/psa/:id/sync` syncs on demand.

### Plan mode

A run with `mode: "plan"` works like a live run with one difference: every tool that isn't `read` is simulated. For each simulated step, the action is recorded as `planned`, together with the decision the live policy *would* have made and its reason. The model is told the same thing, so its final message is an exact plan. Plan runs don't touch the ticket's status and never message the requester.

### Scheduler

`scheduler.ts` runs on a 30-second tick and does three things:
- **Recurring task runs** that technicians create (for example, a weekly security review).
- **One-off follow-ups Haley creates with `schedule_follow_up`.** These run *on the original ticket*, so they carry that requester's authority rather than a technician's.
- **SLA escalation.** Tickets past their resolution target are escalated to a technician once.

### Risk levels

Every tool declares one. The full decision matrix, including identity assurance, authorized approvers, protected accounts and volume limits, is in [TRUST_MODEL.md](TRUST_MODEL.md).

- `read`: no side effects.
- `internal`: writes only inside Haley (ticket fields, notes, replies, KB articles). Never gated.
- `write`: changes a customer system in a routine, reversible way.
- `destructive`: security-sensitive or hard to undo.

After the matrix, `applyRules` applies the client's policy rules (first match wins), then `applyRails` applies each tool's hard rail:
- `rail: "technician_only"` always escalates to approval;
- `rail: "self_only"` escalates unless the target is the requester or a technician;
- `guard(input)` can force approval based on the real input, such as an admin group.

Tools whose input doesn't name the affected account (devices) implement `resolveTargets(input)`, so identity and self-service checks use the device's owner.

### Secrets

A tool can return `new SensitiveResult(visible, secrets, owners?)`. `owners` names whose secret it is when the input doesn't, as with a BitLocker key and the device's owner. The runner stores `secrets` sealed in `actions.secrets_sealed`, passes only `visible` to the model and stores only `visible` in the action result. Technicians fetch secrets with `POST /api/actions/:id/reveal`, which writes a `secret.revealed` audit entry.

### Prompt injection

Ticket text comes from end users. The system prompt tells the model to treat it as data, and the real defenses are structural: customer changes are gated by policy and approvals regardless of what the model is convinced of, credentials never enter the model's context, and tools are scoped to the ticket's own organization.

## Monitoring alerts

`monitoring/syncroAlerts.ts` runs on the scheduler tick for each `syncro_rmm` integration with `alertTickets` turned on, at most every two minutes per client.
- **Starting point:** the first check only records a cursor, so existing alerts aren't ticketed.
- **New alerts:** after that, each new active alert for the client's Syncro customer opens a ticket on the `monitoring` channel and starts a run.
- **Skipped alerts:** alerts Syncro already ticketed are skipped (the PSA sync imports those). An alert that fires again while its ticket is open is noted on that ticket instead of opening another.
- **Limits:** at most 5 tickets per check and 20 per client per hour; the rest wait for later checks.
- **Policy:** the runner gives monitoring tickets a requester flagged `monitoring`, so in Unattended mode routine fixes run as in Autonomous mode (see [TRUST_MODEL.md](TRUST_MODEL.md)).

## PSA tools and the Syncro webhook

`psa/tools.ts` gives Haley tools from the client's PSA beyond ticket sync, for the first enabled PSA connection that maps the client. Each tool exists only when the adapter implements the optional method behind it:
- `psa_find_canned_response` (`findCannedResponses`)
- `psa_list_contracts` (`listContracts`)
- `psa_book_appointment` (`createAppointment`), which is write risk and linked to the PSA ticket when the Haley ticket is synced

Syncro implements all three.

`routes/syncroWebhook.ts` serves `POST /hooks/syncro/:secret`. The secret is a sealed workspace setting, shown and rotated on the PSA page. A valid delivery runs a `Debouncer`: at most one run per 10 seconds, plus one trailing run. That run syncs every enabled Syncro connection and forces an alert check. The request body is never parsed.

## Adding a connector

1. Define a normalized API interface for the platform (see `connectors/m365/api.ts`).
2. Implement it against the real service (`connectors/m365/graph.ts`) and, ideally, as an in-memory sandbox (`connectors/sandbox/m365.ts`) so it can be demoed and tested without credentials.
3. Write tools with `defineTool({ name, description, input: zodSchema, risk, describe, run })` (see `connectors/m365/tools.ts`). Prefix tool names with the provider (`okta_…`) so they don't collide. Write descriptions for the model: say when to use the tool, not just what it does. Give every non-read tool a `describe()`, since that's the line technicians approve.
4. Register the provider in `connectors/registry.ts`: its `ProviderInfo` (form fields, setup steps, capabilities) and a branch in `buildConnector`.
5. Add the provider id to `ProviderId` in `types.ts` and to the provider enum in the integration route in `app.ts`.

The dashboard renders the connect form from `ProviderInfo`, so no UI work is needed.

Connectors that call an MSP-configured host or tenant (NinjaOne, SyncroMSP RMM, IT Glue, Hudu, generic REST) share `connectors/http.ts`: base URLs must be https with a public hostname (no IP literals, localhost or internal names; nothing is resolved, so DNS rebinding isn't covered), requests use `redirect: "manual"` and a 20-second timeout, and `stripSecrets()` drops password/secret/token/OTP-like fields from documentation results. Each connector is scoped to one client-side tenant (NinjaOne organization, Syncro customer, IT Glue organization, Hudu company) and checks that id on every item it returns, so a tool can't read or act on another client's records even with a guessed id. The generic REST connector exposes `api_<name>_get` (read) and, only with `allowWrites`, `api_<name>_write` (write) and `api_<name>_delete` (destructive); the auth value is scrubbed from every response.

## Data model

| Table | Purpose |
|---|---|
| `orgs` | Client organizations: autonomy policy, MSP notes (fed to the agent), and `settings` (approvers, protected accounts, email domains, Teams tenant, limits, SLA targets, pause). |
| `integrations` | One per provider per org; `config_sealed` holds encrypted credentials, `state` holds sandbox tenant state. |
| `tickets`, `ticket_events` | Tickets (channel, reply routing, requester assurance, SLA timestamps) and their timeline (comments, replies with delivery status, agent notes, field changes, actions, escalations). |
| `runs` | Agent runs: conversation, pending approval state, summary, token usage. |
| `actions` | Every tool call Haley made: input, risk, rationale, decision, result, sealed secrets. |
| `kb_articles` | Markdown knowledge base, per client or global. |
| `schedules` | Recurring tasks and Haley's one-off ticket follow-ups. |
| `model_profiles` | AI models: provider, model, base URL, encrypted key, options, fallback, default flag. |
| `verification_attempts`, `secret_links` | Step-up verification history (drives fatigue limits) and view-once credential links (hashed tokens). |
| `psa_connections`, `ticket_links` | PSA credentials (encrypted), customer→client map, sync cursor and options; ticket ↔ PSA ticket links with seen comments and mirrored events. |
| `audit_log` | Append-only record of security-relevant events. |

Schema changes are forward-only migrations in `db.ts`, tracked with `PRAGMA user_version`. SQLite (built into Node 22) keeps deployment to a single process and a single file. The `Store` class is the only thing that touches SQL, so moving to Postgres later is contained.

## Roadmap ideas

These are ranked from the [competitive research](research/COMPETITIVE_LANDSCAPE.md).

- **Compromised-account playbook**: investigate sign-ins, inbox rules, forwarding and OAuth grants with read-only tools, then contain with approval.
- **Exchange Online depth**: shared mailbox and calendar permissions, forwarding, message trace, and converting a mailbox to shared on offboarding.
- **More PSAs** (HaloPSA, ConnectWise, Autotask) on the same `PsaAdapter` interface, and more **RMM connectors** (Datto RMM, ConnectWise Automate) alongside NinjaOne.
- **Per-technician accounts** with SSO and roles, replacing the shared API token.
- **Service catalog** forms feeding deterministic tools; **tenant standards and drift** checks.
- **Live run streaming** over SSE instead of polling.
