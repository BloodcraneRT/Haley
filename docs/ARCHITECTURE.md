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
3. For every `tool_use` block the runner validates the input with the tool's zod schema, then asks `policy.decide(autonomy, risk)`:
   - **run**: executes now and records an `actions` row.
   - **block**: records a blocked action and returns an error result telling the model to recommend the step instead.
   - **approve**: records a `pending_approval` action and keeps going through the other calls in the turn.
4. If anything is pending, the run is saved as `awaiting_approval` together with the results already produced (`runs.pending`), and the ticket moves to `awaiting_approval`.
5. When the last pending action of a run is approved or rejected, `resume()` executes the approved ones, turns rejections into error results that carry the technician's note, sends all results back **in the order the model called them**, and continues the loop.
6. The loop ends on `end_turn` (the final text becomes the technician summary on the ticket), on a refusal, context or iteration limit (the run fails and the ticket is escalated), or on an API error.

Requests use `claude-opus-5` with adaptive thinking, streaming (`finalMessage()`), prompt caching on the system prompt and conversation, eager input streaming for tool inputs (validated before execution), and server-side refusal fallbacks (`fallbacks: "default"`). The model, effort level and fallbacks are configurable (`HALEY_MODEL`, `HALEY_EFFORT`, `HALEY_FALLBACKS`).

### End-user channels

`channels/hub.ts` is the single entry point for messages from end users (see [CHANNELS.md](CHANNELS.md) for setup).

1. **Verify the caller.** Each webhook checks its own proof: a shared secret for email, Slack's HMAC signature with a replay window, the Bot Framework JWT for Teams (checked against Microsoft's published signing keys), and HMAC for the chat bridge.
2. **Resolve the client and the person.** The client comes from the email domain, the Slack workspace, the Entra tenant or the bridge. The person's **assurance level** comes from DMARC/DKIM alignment, the Slack profile email (guests excluded), or the Teams Entra object ID matched in the client's directory.
3. **Thread.** A message continues an open ticket if it matches the email subject tag or message ID, the Slack thread or DM, the Teams conversation, or the bridge thread. Otherwise it opens a ticket, sends an acknowledgement and starts Haley.
4. **Follow-ups.** A message on a busy ticket sets `needs_followup`, and a fresh pass starts when the current run ends. Messages on escalated tickets wait for the technician.
5. **Replies.** `reply_to_requester`, technician replies and automatic notices ("needs a quick sign-off", "passed to the IT team") all go out on the ticket's channel, and the delivery result is stored on the timeline.

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
- `destructive`: security-sensitive or hard to undo. Always needs a human.

### Secrets

A tool can return `new SensitiveResult(visible, secrets)`. The runner stores `secrets` sealed in `actions.secrets_sealed`, passes only `visible` to the model and stores only `visible` in the action result. Technicians fetch secrets with `POST /api/actions/:id/reveal`, which writes a `secret.revealed` audit entry.

### Prompt injection

Ticket text comes from end users. The system prompt tells the model to treat it as data, and the real defenses are structural: customer changes are gated by policy and approvals regardless of what the model is convinced of, credentials never enter the model's context, and tools are scoped to the ticket's own organization.

## Adding a connector

1. Define a normalized API interface for the platform (see `connectors/m365/api.ts`).
2. Implement it against the real service (`connectors/m365/graph.ts`) and, ideally, as an in-memory sandbox (`connectors/sandbox/m365.ts`) so it can be demoed and tested without credentials.
3. Write tools with `defineTool({ name, description, input: zodSchema, risk, describe, run })` (see `connectors/m365/tools.ts`). Prefix tool names with the provider (`okta_…`) so they don't collide. Write descriptions for the model: say when to use the tool, not just what it does. Give every non-read tool a `describe()`, since that's the line technicians approve.
4. Register the provider in `connectors/registry.ts`: its `ProviderInfo` (form fields, setup steps, capabilities) and a branch in `buildConnector`.
5. Add the provider id to `ProviderId` in `types.ts` and to the provider enum in the integration route in `app.ts`.

The dashboard renders the connect form from `ProviderInfo`, so no UI work is needed.

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
| `audit_log` | Append-only record of security-relevant events. |

Schema changes are forward-only migrations in `db.ts`, tracked with `PRAGMA user_version`. SQLite (built into Node 22) keeps deployment to a single process and a single file. The `Store` class is the only thing that touches SQL, so moving to Postgres later is contained.

## Roadmap ideas

These are ranked from the [competitive research](research/COMPETITIVE_LANDSCAPE.md).

- **Step-up verification**: a Duo or Okta push, or a one-time code to a second factor already on file, before self-service changes when the channel's assurance is too low. That would let email-only users self-serve too.
- **Compromised-account playbook**: investigate sign-ins, inbox rules, forwarding and OAuth grants with read-only tools, then contain with approval.
- **Exchange Online depth**: shared mailbox and calendar permissions, forwarding, message trace, and converting a mailbox to shared on offboarding.
- **Client onboarding through GDAP or a multi-tenant partner app**, instead of an app registration per tenant.
- **PSA two-way sync** (HaloPSA first, then ConnectWise and Autotask) and an **RMM connector** for endpoint scripts.
- **Per-technician accounts** with SSO and roles, replacing the shared API token.
- **Service catalog** forms feeding deterministic tools; **tenant standards and drift** checks.
- **Live run streaming** over SSE instead of polling.
