# Architecture

```
            ┌──────────────┐        ┌────────────────────────────── server ─────────────────────────────┐
 browser ──▶│  web (React) │──/api─▶│ app.ts (Fastify routes, auth, validation)                          │
            └──────────────┘        │   │                                                               │
 email/PSA ──── POST /api/intake ──▶│   ├─ Store (SQLite: orgs, integrations, tickets, runs, actions,   │
                                    │   │         kb_articles, audit_log; credentials sealed AES-GCM)   │
                                    │   │                                                               │
                                    │   └─ AgentService (agent/runner.ts)                               │
                                    │        │  tool-use loop ──▶ Claude API (LlmClient)                │
                                    │        │  policy.ts decides run / approve / block per call        │
                                    │        ├─ built-in tools: tickets, replies, KB, escalation        │
                                    │        └─ connectors: m365 (Graph), google (Admin SDK)            │
                                    │                 each with a live client and a sandbox tenant      │
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

### Risk levels

Every tool declares one:

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
| `orgs` | Client organizations, their autonomy policy and MSP notes (fed to the agent). |
| `integrations` | One per provider per org; `config_sealed` holds encrypted credentials, `state` holds sandbox tenant state. |
| `tickets`, `ticket_events` | Tickets and their timeline (comments, replies, agent notes, field changes, actions, escalations). |
| `runs` | Agent runs: conversation, pending approval state, summary, token usage. |
| `actions` | Every tool call Haley made: input, risk, rationale, decision, result, sealed secrets. |
| `kb_articles` | Markdown knowledge base, per client or global. |
| `audit_log` | Append-only record of security-relevant events. |

SQLite (built into Node 22) keeps deployment to a single process and a single file. The `Store` class is the only thing that touches SQL, so moving to Postgres later is contained.

## Roadmap ideas

- Per-technician accounts with SSO (Entra ID / Google) and roles, replacing the shared API token.
- PSA sync (ConnectWise, Autotask, HaloPSA) and outbound email for replies.
- More connectors: Intune device actions, Exchange Online (shared mailboxes, forwarding, message trace), Okta, RMM tools (NinjaOne, Datto) for endpoint scripts.
- Scheduled tasks (weekly license audit, monthly security review per client).
- Live run streaming over SSE instead of polling.
- Teams / Slack bot so end users can open and follow tickets in chat.
