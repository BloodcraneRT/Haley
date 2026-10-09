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
- **Owners (`psa/owners.ts`):** every adapter reads the ticket's owner (`ExternalTicket.owner`). It's matched to a directory technician by their saved PSA id, then email, then name, and the id is saved. A changed owner assigns the Haley ticket; the link's `last_owner` stops an unchanged owner from overwriting an assignment made in Haley. With the connection's `syncOwner` option, assignments go back through `setOwner`. Tickets closed in the PSA credit their assignee in dispatch.
- **Working hours (`workingHours.ts`):** technicians' weekly hours in their own time zone (via `Intl`, no date library) and a last day away. Dispatch leaves out people who are off and never auto-assigns them.
- **Technicians' time:** `listTimeEntries` lets the close check warn when no technician time is on a PSA-linked ticket. Haley's own entries are known by the ids kept on the link (`time_entry_ids`) or by her note. Advisory only: `require` mode doesn't enforce it, and a PSA failure is a hint.
- **Attachments:** `listAttachments` and `getAttachment` bring in files on changed tickets (`seen_attachment_ids`, capped per ticket and per sync). Customer files go through the hub like a message's; technicians' files are stored on an internal note with `technicianFiles`, which keeps them out of Haley's runs.
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

## Help desk features

- **`snapshot.ts`:** builds the requester snapshot by calling the client's read tools directly, each with a 15-second timeout: `m365_get_user` / `gws_get_user`, `m365_list_devices` and `syncro_list_devices`.
- **`similar.ts`:** keyword similarity with stop words, light stemming and doubled title weight, behind `/api/tickets/:id/similar` and incident detection.
- **`incidents.ts`:** hooks `Store.onTicketCreated`. A new ticket joins an open incident it matches. Otherwise, 3 or more matching tickets from 2 or more people within an hour start one. Matching is stricter here: they must name the same service or share several words.
- **Incident context:** Haley's run intro gets an `<incident>` block for tickets in an open incident.
- **`routes/incidents.ts`:** message-all, resolve-all and dismiss.
- **`copilot.ts`:** makes one tool-less model call, and `model_usage` rows can now have no run (migration 12, `purpose = 'assist'`).
- **`routes/statusPage.ts`:** serves `/t/<ticket>.<expiry>.<hmac>` as a server-rendered page with a strict CSP. The forms post url-encoded bodies to a scoped parser.

## Attachments

- **`attachments.ts`:**
  - `storeAttachments()` sniffs each file's bytes, applies the limits, extracts PDF text (`unpdf`, pure JS) or text and `.eml` bodies, and stores everything in the `attachments` table (migration 17, bytes in SQLite).
  - `attachmentParts()` builds a run's attachment text and image parts.
  - `withImageData()` loads the 4 most recent images just before each model call. Stored conversations keep only `attachmentId`.
  - `downloadFile()` is the size-capped, host-allow-listed downloader the Slack and Teams adapters use.
- **AI layer:** a neutral `image` part. Anthropic gets base64 image blocks and OpenAI-compatible models get content arrays. `ModelOptions.vision` (`supportsVision()`) turns images into text placeholders for text-only models.
- **Intake:** `InboundMessage.attachments`. `ChannelHub` stores files before starting Haley, and for follow-ups links them to the message, so untrusted continuations stay out of runs.

## "What would Haley handle?" reports

- **`PsaAdapter.listClosedTickets(from, to, { max })`** (optional): all five PSAs return closed tickets with subject, the start of the description, recorded time and category. No comments are read.
- **`insights.ts`:**
  - `clusterTickets()` is leader clustering over subject and description words (`similar.ts`). Groups need three tickets; the rest are "Other".
  - `buildInsights()` names the 30 biggest groups with one model call (the workspace's default model, if any) and matches them to `CAPABILITIES` and recipes. The answer is validated, and coverage is capped at what the matched capability allows. Without a model, or when its answer doesn't parse, `matchCluster()` matches by words.
  - Hours use the median recorded time where at least half a group has it, else the minutes-per-ticket setting, scaled to a 30-day month.
  - `InsightService` runs reports in the background (at most 5,000 tickets) and stores only aggregates and three example subjects per group (`insight_reports`, migration 18).
- **Checking queries (`psa/probe.ts`):** a read-only probe reports which fields a PSA returned and how often they were filled in, never values. It runs from the PSA page (**Check fields**, `POST /api/psa/:id/probe`) or `npm run probe:psa`. Unchecked queries are marked `preview` in `psa/registry.ts`, and the dashboard says so.
- **Prospects:** `POST /api/insights { prospect: { kind, config } }` builds a throwaway adapter. Credentials are never stored or audited.

## Help desk quality: checks before close, needs-care flags, dispatch, lessons

- **`qa.ts`:** deterministic checks before close (no reply since the requester's last message, no resolution note, an unkept promise) plus an optional model check (purpose `qa`). `PATCH /api/tickets/:id` enforces `require` mode with `qaOverride` (audited). The setting is `HelpdeskSettings` in workspace settings.
- **`frustration.ts`:**
  - `FrustrationDetector` hooks `Store.onTicketCreated` and the new `Store.onTicketEvent`. It scores free signals, sets `tickets.flags` (migration 15), and optionally confirms with a model call (purpose `sentiment`).
  - VIPs (`OrgSettings.vipRequesters`) get a priority bump.
  - `careContext()` adds a `<care>` block to the run intro.
  - `ChannelHub.appendToTicket` escalates instead of re-running when a frustrated requester says the fix didn't hold.
- **`dispatch.ts`:**
  - `rankTechnicians()` scores directory technicians: similar-ticket resolvers, client and category familiarity, minus load. It uses `Store.resolutionsSince()` and `openTicketsByAssignee()`.
  - `onEscalated()` is a status listener registered before the notifier. It stores `tickets.suggested_assignee` and optionally assigns.
- **`lessons.ts`:**
  - `LessonService` is a second `ApprovalEvents` listener, so `AgentService` now keeps a list of them. `decided` is emitted after the resume is queued, so listeners can wait for the run to settle.
  - It collects feedback, makes one model call (purpose `lesson`), and validates the result with the shared `policyRuleSchema.ts`. Notes become pending `client_memories` (`source: "lesson"`), rules become `rule_suggestions` (migration 16), and copilot drafts are kept in `assist_drafts` so a reply's `draftEditRatio` can be recorded.

## Technicians and chat approvals

- **`technicians` table (migration 13):** name (the sign-in name), email, Slack user id, Teams object id, active. Behind `routes/technicians.ts`; renaming rewrites approver names in client rules.
- **`AgentService.attachApprovalEvents()`:**
  - `pending()` fires after a run parks actions, with the run's read steps as evidence.
  - `decided()` fires after `decideAction` (approve, reject or `changes`), and when a failed run rejects what was still pending.
- **`approvals/notify.ts`:** turns those events into cards for each `ApprovalChannel`, and records each post in `approval_posts` (migration 14) so every card can be updated later. It also posts escalation notices from `Store.onTicketStatusChanged`, only when the actor is Haley, the scheduler or the system.
  - **Direct messages:** with `dmApprovers`, named approvers also get the card through `postDirect` (Slack `conversations.open`; Teams `POST /v3/conversations`, which needs the app installed for them, so a 403 or 404 becomes `DirectMessageUnavailable`, audited once a day). Recorded with `kind: "dm"` and updated like channel cards.
  - **Reminders:** `remind()` runs on each scheduler tick when `reminderMinutes` is set. It claims each overdue action with `actions.reminded_at` (migration 20), so a reminder is sent once. It replies under channel cards (`postReminder`, recorded as `kind: "reminder"` and never updated) and sends the card again to the approvers, or to the ticket's assigned technician.
- **`approvals/slack.ts`:**
  - posts Block Kit cards with `chat.postMessage` and updates them with `chat.update`;
  - `/hooks/slack/interactivity` (`routes/approvals.ts`, with a scoped url-encoded parser that keeps the raw body for the signature) handles `block_actions` and the `views.open` modal for reject and changes.
- **`approvals/teams.ts`:**
  - posts Adaptive Cards and updates them with a PUT to the activity;
  - `/hooks/teams/messages` hands `adaptiveCard/action` invokes and "approvals here" to it before end-user handling (`HookDeps.teamsIntercept`).
- **Settings:** `ApprovalSettings` is a workspace setting. The Slack bot token is a sealed workspace secret (`Store.getWorkspaceSecret`), and a client can override the channel with `OrgSettings.approvalSlackChannel`.

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
| `psa_connections`, `ticket_links` | PSA credentials (encrypted), customer→client map, sync cursor and options; ticket ↔ PSA ticket links with seen comments and attachments, mirrored events, Haley's time entries and the last PSA owner. |
| `assist_drafts`, `rule_suggestions` | Copilot reply drafts (30 days, to see how they were edited) and policy rules Haley suggested from technicians' feedback. |
| `technicians`, `approval_posts` | The MSP's technicians with their Slack and Teams ids; approval cards and escalation notices posted to chat, so they can be updated. |
| `attachments` | Files that came with messages (bytes, sniffed type, extracted text), purged after the retention period. |
| `insight_reports` | "What would Haley handle?" reports: parameters, status, and the aggregated result. |
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
