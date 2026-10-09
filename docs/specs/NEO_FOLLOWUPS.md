# Spec: features from the Neo Agent comparison

Status: **phases 1–3 built** (items 0, 1, 9; 6, 4, 2; 5, 3), 2026-10-08. Changes from this spec while building:

- **Item 3:** a prospect's PSA details are used for one report and never stored (no `purpose:"insights"` connection to clean up). Reports work on ConnectWise, HaloPSA and Syncro; Autotask and Dynamics don't list closed tickets yet. Groups join at a third of a ticket's words in common rather than 0.4, because subjects are short. Each capability names its own recipes, so the free fallback doesn't attach loosely related recipes. Reports still running when the server restarts are marked failed.
- **Item 5:** attachments are stored in SQLite rather than as files, and the chat bridge takes base64 only.

- Slack and Teams accounts are linked by the email on the chat profile on a technician's first click. Slack uses `users.info` and Teams uses the Bot Framework members API, so no access to the MSP's own Microsoft 365 is needed.
- The MSP's tenant for Teams is a setting, defaulting to `HALEY_TEAMS_TENANT_ID`.
- Failed posts go to the audit log, not the ticket timeline, so Haley doesn't see them as ticket history. Source: [research/NEOAGENT_COMPARISON.md](../research/NEOAGENT_COMPARISON.md), "What to incorporate".

This specs the nine items, plus one foundation they share (a technician directory). Each section says what changes, where in the code, the data model, the API and UI, safety rules, tests, and size. File references are to `main` at the time of writing. Migration numbers are indicative; the last one today is 12.

- **Size key:** S is about a day, M a few days, L a week or more.
- **Delivery:** one PR per section.

## Contents

0. [Foundation: technician directory](#0-foundation-technician-directory) (done)
1. [Approve from Teams and Slack](#1-approve-from-teams-and-slack) (done: channel posting; DMs to approvers and reminders not yet)
2. [Learn from technicians' decisions](#2-learn-from-technicians-decisions) (done; the automatic trigger is rejections and change requests, and other feedback is used on demand)
3. ["What would Haley handle?" report](#3-what-would-haley-handle-report)
4. [Suggest a technician on escalation](#4-suggest-a-technician-on-escalation) (done; PSA owner import and working hours not yet)
5. [Read screenshots and PDFs](#5-read-screenshots-and-pdfs)
6. [QA before close, and frustration flags](#6-qa-before-close-and-frustration-flags) (done; the PSA time check waits for adapters that read time entries)
7. [Integrations by demand](#7-integrations-by-demand)
8. [Phone through a partner](#8-phone-through-a-partner)
9. [Cost per resolved ticket](#9-cost-per-resolved-ticket) (done)
- [Suggested order](#suggested-order)
- [Open questions](#open-questions)

---

## 0. Foundation: technician directory

**Why:** Haley has no record of who its technicians are.
- The dashboard identity is the name typed at sign-in. It is sent as `x-haley-user` (`app.ts:86-90`), behind one shared API token (`app.ts:208-216`).
- Approvers in policy rules are free-text names, compared case-insensitively (`runner.ts:123`, `:227`).
- `assignee` is free text (`types.ts:180`).

Items 1 and 4 need to map a Slack user, a Teams user or a PSA member to a technician, so this has to come first.

**Data (migration 13):**
```sql
CREATE TABLE technicians (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- the sign-in name used today, so existing rules keep matching
  email TEXT,                                  -- matches PSA members/resources and M365 users
  slack_user_id TEXT,                          -- U…; set by "Link Slack" or matched by email via users.lookupByEmail
  teams_aad_id TEXT,                           -- Entra object id; matched by email via the M365 connector or set on first card click
  psa_refs TEXT NOT NULL DEFAULT '{}',         -- {connectionId: memberId}, filled by item 4
  working_hours TEXT,                          -- optional {tz, days:[1-5], start:"08:00", end:"17:00"}
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
```

**API:**
- `GET /api/technicians`
- `POST /api/technicians`
- `PATCH /api/technicians/:id`
- `DELETE /api/technicians/:id`, which deactivates and keeps history

Changes are audited.

**UI:** a Settings → **Technicians** page.
- It is pre-filled with suggestions from `store.activeTechnicians()` (distinct audit actors) and the names already used as approvers in policy rules.
- **Link Slack** and **Link Teams** match each technician by email: Slack `users.lookupByEmail` (needs the `users:read.email` scope, which we already request), and Teams through `m365_get_user` on the MSP's own tenant.

**Compatibility:**
- Sign-in still accepts any name, as today.
- The rule editor warns when an approver name isn't in the directory.
- No behaviour changes until items 1 and 4 use the directory.

**Not in scope:** real per-technician dashboard authentication. The directory makes it possible later (for example Entra sign-in matched on `teams_aad_id`). Until then, a Slack or Teams click is *more* strongly authenticated than a dashboard click: it is signed by Slack or Bot Framework and mapped to a known person. The trust model doc should say so.

**Tests:** CRUD, case-insensitive uniqueness, deactivate keeps audit names, and email matching with fake Slack and Graph.

**Size:** S.

---

## 1. Approve from Teams and Slack

**Today:**
- A pending action waits in `GET /api/approvals` (`app.ts:1126`). Technicians are never notified (no notify module exists). Only the requester hears "needs a quick sign-off" (`runner.ts:406-412`).
- Decisions go through `AgentService.decideAction` (`runner.ts:120-150`):
  - `claimPendingAction` is an atomic claim, so a second decision gets a 409.
  - The run resumes in place (`resume`, `runner.ts:210-249`), re-checking policy and approvers before executing.
- Only approve and reject exist. Each takes an optional `note` (`ApprovalCard.tsx`).

### Behaviour

1. When a run parks an action as `pending_approval`, Haley posts an **approval card** to the client's approval destination. If the client has none, it uses the workspace default.
2. **Card content.** It never includes action inputs that could carry secrets, and never raw tool results.
   - **Header:** client · `#1234 Title` · requester and identity level (for example "Megan Bowen · verified by Teams").
   - **Change:** `action.description` (already human-readable), targets, and a risk badge.
   - **Why approval:** `action.policy_reason`, for example "Needs approval under client rule 'Licences need Dana'".
   - **Haley's reasoning:** `action.rationale`.
   - **Evidence:** the read-tool calls Haley made earlier in the run, as one line each (tool label plus `describe(input)`), up to 6. Example: "Checked Megan's account in Microsoft 365 · Listed her devices in Intune". We don't show the results: they can contain personal data.
   - **Who can decide:** the `approvers` list, or "any technician".
   - **Buttons:**
     - **Approve**
     - **Reject…** asks for an optional reason
     - **Ask for changes…** requires a note
     - **Open in Haley**, a link to the ticket
3. **Who can click.**
   - The clicking Slack or Teams user is mapped to a technician (item 0). An unknown user gets a private reply: "You're not set up as a technician in Haley."
   - The decision then goes through `decideAction(id, approve, technician.name, note)`. Named-approver rules, the atomic claim and the re-check on resume all apply unchanged.
4. **Ask for changes** is a third decision, a new `ActionStatus` value `changes_requested`. On resume it is treated like a rejection with a different tool result:
   > A technician (Dana) asked for changes before this can run: "{note}". Adjust the plan and propose the change again if it's still needed. Don't repeat the same request unchanged.

   The dashboard `ApprovalCard` gets the same third button.
5. **Cards stay current.** Each posted card is recorded. When the action is decided anywhere (dashboard, the other chat, or the system when a run fails), every card for it is updated in place to "✅ Approved by Dana · 10:42" (or rejected, or changes requested, with the note), and the buttons are removed.
6. **Escalations too.** The same destination gets a plain notice when Haley escalates a ticket. That shares the plumbing and fills the "nobody is told" gap; it includes the item-4 suggestion when there is one.
7. **Optional reminder:** one re-post after N minutes if the action is still pending (workspace setting, off by default). No repeating loops.

### Destinations

- **Slack:**
  - A channel id per client (`org.settings.approvals.slackChannel`) or a workspace default.
  - The bot must be in the channel; the settings page tests this with `conversations.info`.
  - Optional: also DM the named approvers (`chat.postMessage` to their `slack_user_id`).
- **Teams:**
  - A channel or group chat where the Haley bot is installed. Bot Framework can't post into a conversation it has never seen, so registration is a message.
  - A technician @mentions the bot in the target channel with `approvals here`, and Haley stores that conversation's `{serviceUrl, conversationId, tenantId}`.
  - The command is accepted only from a directory technician on the **MSP's** tenant, not a client tenant.
  - DMs to approvers need proactive 1:1 conversations (`POST /v3/conversations`). That is phase 2.

### Server changes

- **Slack interactivity:**
  - New route `POST /hooks/slack/interactivity`. Slack sends `application/x-www-form-urlencoded` with `payload=<json>`.
  - Add a urlencoded parser that keeps the raw body, and reuse `verifySlackSignature` (`slack.ts:9-21`).
  - Handle `block_actions`:
    - **Approve** decides at once.
    - **Reject** and **Ask for changes** call `views.open` with the `trigger_id` (a modal with a text input). `view_submission` then decides.
  - Ack within 3 s, then do the work.
  - New Slack App setting: Interactivity Request URL. Documented in CHANNELS.md.
- **Slack outbound:** add `blocks` support to the `api()` helper (`slack.ts:61-73`), plus `chat.update` and `views.open`.
- **Teams invoke:**
  - Accept `activity.type === "invoke"` with `name === "adaptiveCard/action"` (Universal Actions, `Action.Execute`) on the existing `/hooks/teams/messages` route, with the same JWT verification (`teams.ts:49-74`).
  - Today `toInbound` drops anything that isn't a text message (`teams.ts:102`). Add a separate branch before it.
  - Respond synchronously with an invoke response containing the refreshed card.
  - The card's `Action.ShowCard` holds an `Input.Text` for the reason or note.
- **Teams outbound:**
  - Send adaptive cards (`attachments:[{contentType:"application/vnd.microsoft.card.adaptive", content}]`).
  - Update with `PUT {serviceUrl}/v3/conversations/{id}/activities/{activityId}`.
- **New module `server/src/approvals/notify.ts`:**
  - `notifyPending(action)`, `notifyDecided(action)` and `notifyEscalation(ticket)`.
  - Hooked into `runner.ts` after actions are parked (around `:393-414`), at the end of `decideAction`, at the system rejection on run failure (`runner.ts:588-590`), and in `escalate_to_human` and the other escalation paths.
  - Failures are logged on the ticket ("Couldn't post the approval to Slack: not_in_channel") and never block the run.
- **Text safety:** ticket titles and requester names are untrusted. Escape `& < >` in Slack mrkdwn, and use plain `TextBlock`s (no markdown) for those fields in adaptive cards.

### Data (migration 14)

```sql
CREATE TABLE approval_posts (
  id TEXT PRIMARY KEY,
  action_id TEXT,               -- null for escalation notices
  ticket_id TEXT,
  channel TEXT NOT NULL,        -- slack | teams
  ref TEXT NOT NULL,            -- {channel, ts} or {serviceUrl, conversationId, activityId}
  created_at TEXT NOT NULL
);
```
`ActionStatus` gains `changes_requested`. Statuses are stored as text, so the schema doesn't change. `report.ts:77` must count it as an incomplete run.

### Settings

- **Per client:** `org.settings.approvals = { slackChannel?, teamsConversation?, dmApprovers?: boolean }`.
- **Workspace:** defaults, plus `chatApprovalMaxRisk: "write" | "destructive"`. The default is `destructive`, so all risks can be approved from chat; MSPs can keep destructive changes dashboard-only.
- Hard rails are unaffected. They block before an approval exists.

### Tests

- A card is posted on park, with no secret inputs.
- A Slack click is signature-checked; a bad signature gets a 401.
- An unknown Slack user is refused.
- A named-approver rule refuses the wrong technician from Slack.
- Approve resumes the run and executes; "Ask for changes" feeds the note back and the run continues.
- A double click across Slack and the dashboard gives one decision, and the second surface shows "already decided by…".
- Cards update on every decision path, including a run failure.
- Teams invoke with a bad JWT is refused.
- `chatApprovalMaxRisk=write` hides the buttons on destructive cards ("Approve in Haley").
- An escalation notice is posted.

**Size:** M–L. Slack first (S–M), Teams second.

---

## 2. Learn from technicians' decisions

**Today:**
- Client notes: `client_memories`, with status `active` or `pending` and a technician confirm flow (`routes/memories.ts`, `ClientMemory.tsx`).
- Policy rules: `org.settings.policyRules`, saved as a whole array through `PATCH /api/orgs/:id`, edited in `PolicyRules.tsx`.
- The copilot's draft isn't stored: `POST /api/tickets/:id/assist` audits only the mode. So the server can't tell how the technician changed it before sending (`POST /api/tickets/:id/comments`).

### Signals

| Signal | Where it's captured |
|---|---|
| A change rejected with a reason, or "ask for changes" (item 1) | `actions.decision_note` |
| A copilot draft heavily edited before sending | New: link the draft to the sent reply (below) |
| A technician reopens a ticket Haley resolved, or the requester clicks "Still broken" | `status_change` events by a non-Haley author after a Haley resolution |
| A technician changes the category or priority Haley set | `field_change` events by a technician after Haley's |

**Linking drafts:**
- `assist` stores its output in `assist_drafts(id, ticket_id, mode, text, created_by, created_at)` and returns `draftId`.
- The Composer (`TicketDetail.tsx:776-805`) sends `draftId` with the reply.
- The server records an edit ratio (normalised token diff) on the reply's event meta.
- Drafts are deleted after 30 days.

### The lesson step

- **When it runs:**
  - Automatically, after a run finishes that had a rejection or change request with a note of 10+ characters, or a reopen.
  - On demand, from a **Suggest a lesson** button on a ticket or run.
  - Capped at 20 a day per client.
- **What it is:** one tool-less model call, like `copilot.ts`, recorded with purpose `lesson`.
- **Input:**
  - the ticket summary;
  - the actions with decisions and notes;
  - the draft and final reply when the edit ratio is above 0.3;
  - the client's current notes and rules, so it doesn't duplicate them.
- **Output:** strict JSON, one of:
  - `{kind:"note", text}`
  - `{kind:"rule", rule:{name, tools, targets, departments, requesters, effect, approvers, minAssurance}, why}`
  - `{kind:"none"}`
- **Validation:**
  - Notes go through the `SECRET_LIKE` check (`builtinTools.ts:326`) and the length cap.
  - Rules go through the existing `policyRuleInput` zod schema (`app.ts:262-274`), and their tool names are checked against the client's actual tools.
- **Where suggestions land:**
  - **Notes** become `client_memories` rows with `status:"pending"` and a new `source:"lesson"`. They appear in the existing "Waiting for review" list with a "Suggested from #1234" link.
  - **Rules** go into a new table `rule_suggestions(id, org_id, rule, why, run_id, ticket_id, status pending|accepted|dismissed, decided_by, created_at)` (migration 15). `PolicyRules.tsx` gets a "Suggested by Haley" strip:
    - **Review** opens `RuleModal` pre-filled, and saving it appends the rule.
    - **Dismiss** removes the suggestion.
    - Both are audited.

### Safety

- Nothing applies without a technician's click.
- A suggested rule with `effect:"allow"` is labelled "loosens policy" in amber.
- Hard rails can't be expressed as rules, so they can't be relaxed.
- Ticket text in the prompt is wrapped as untrusted data, as in the copilot. The technician review is the control.

### Tests

- A rejection with a note produces a pending note or rule suggestion (scripted LLM).
- Invalid JSON or an unknown tool is dropped.
- A secret-looking note is dropped.
- Accepting creates the rule; dismissing doesn't.
- The cap is enforced.
- The draft edit ratio is recorded.
- Lesson usage is billed to the client with purpose `lesson`.

**Size:** M.

---

## 3. "What would Haley handle?" report

**Today:** PSA adapters only have `listUpdatedTickets(since)`, with a 7-day first-sync lookback (`halopsa.ts:14`, `syncro.ts:12`). None lists closed tickets in a date range. `similar.ts` has `ticketTerms`, `similarity` and `rankSimilar`. Recipes (`templates.ts`) have `tags`, `requires` and `estimatedMinutes`.

### Adapter addition

Optional method on `PsaAdapter` (`psa/types.ts:41-68`):

```ts
listClosedTickets?(from: string, to: string, opts: { max: number }): Promise<HistoricTicket[]>;
interface HistoricTicket { id: string; subject: string; description: string /* first 2,000 chars */; customerId: string; customerName: string; createdAt: string; closedAt: string; minutesSpent: number | null; category: string | null }
```

No comments are fetched, to keep it cheap. Planned queries, each to be verified against a live tenant and recorded in INTEGRATION_API_NOTES:

| PSA | Query (to verify) |
|---|---|
| ConnectWise | `GET /service/tickets?conditions=closedFlag=true and closedDate>=[from] and closedDate<[to]&fields=id,summary,initialDescription,company,dateEntered,closedDate,actualHours,type,subType` |
| Autotask | `POST /Tickets/query` with `status eq Complete` and `completedDate` between the dates. Time is from `TimeEntries` totals per ticket only if cheap; otherwise null |
| HaloPSA | `GET /Tickets?closed_only=true&datesearch=dateclosed&startdate=&enddate=` (with `timetaken`) |
| Syncro | `GET /tickets?status=Resolved&since_updated_at=` and filter on `resolved_at` |
| Dynamics | `incidents?$filter=statecode eq 1 and modifiedon ge …` |

Capped at 5,000 tickets or 90 days, whichever comes first.

### Report job

- **Route:** `POST /api/insights { connectionId | config, days: 30-90, minutesPerTicket? }` starts a background job. Results go in `insight_reports(id, created_at, created_by, params, status, result, error)` (migration 16). `GET /api/insights/:id` returns progress and the result.
- **Prospect mode:** a PSA connection can be created with `purpose:"insights"`:
  - read-only, no customer mapping, never synced;
  - deleted with one click after the report;
  - the UI offers that deletion right away.
- **Clustering:** deterministic and cheap.
  - Leader clustering over `ticketTerms`: walk tickets in time order and join the best cluster whose centroid similarity is ≥ 0.4, otherwise start a new one.
  - Keep clusters of 3 or more tickets; the rest go into "Other".
- **Naming and matching:** one model call (purpose `insights`) with the top 30 clusters. For each it gets the top terms and up to 5 sample *subjects* (not descriptions), plus the recipe catalog (id, name, tags) and a fixed list of Haley capabilities:
  - password reset, unlock, MFA re-register;
  - licence change, shared mailbox access;
  - device restart, disk cleanup;
  - patch status, printer spooler (RMM).

  It returns `{clusterId, label, recipeIds[], capability, coverage}`, where coverage is `unattended`, `with approval`, `assist only` or `not covered`. The output is validated against the catalog, and a deterministic tag match is the fallback when the model call fails.
- **Hours:**
  - Use the PSA's `minutesSpent` median per cluster when it is present on at least half the tickets.
  - Otherwise use the request's `minutesPerTicket` (default: the workspace's minutes-per-ticket setting).
  - Monthly figures are normalised to a 30-day month.

### Output

A report page:
- Headline: "Haley could take ~N tickets / ~H hours a month".
- A ranked table: cluster, tickets per month, hours per month, coverage, the recipes that do it, and the integrations needed (from each recipe's `requires`), each marked connected or not.

Also available as CSV, and as a print stylesheet for a PDF handout.

### Data handling

- Raw ticket text is kept only while the job runs.
- The stored result keeps aggregates and up to 3 sample subjects per cluster. Samples can be hidden in exports, since subjects may contain names.
- The prospect's credentials are encrypted like other PSA connections and are deletable.

### Tests

- Clustering on a fixture of 200 tickets with known groups.
- Hours from `minutesSpent` versus the default.
- Model output validation and the deterministic fallback.
- Each adapter's `listClosedTickets` against `fakeFetch` fixtures, including paging and the cap.
- A prospect connection never syncs.

**Size:** M–L. The engine and two PSAs first (ConnectWise, HaloPSA), then the others.

---

## 4. Suggest a technician on escalation

**Today:**
- `escalate_to_human` (`builtinTools.ts:289-299`) sets `status:"escalated", assignee:"unassigned"`. So do the verification-failure, run-error and SLA paths.
- Nothing records who resolves tickets except `status_change` event authors.
- PSA owners aren't imported (`ExternalTicket` has no owner field).

### Scoring

- **Candidates:** active directory technicians (item 0), within `working_hours` when set.
- **Signals and weights:**

  | Signal | Weight | Measure |
  |---|---|---|
  | Similar-ticket resolver | 0.45 | Share of the top 10 similar tickets (`rankSimilar`, `min=0.34`) this technician resolved in the last 180 days |
  | Client familiarity | 0.30 | Share of this client's tickets the technician resolved in the last 90 days |
  | Category | 0.15 | Share of this category, across clients, in the last 90 days |
  | Load | −0.10 × open | Open tickets assigned to them, capped |

- **Resolver:** the author of the `status_change` event to resolved or closed, when that author isn't `haley` or `system` and is a directory name (case-insensitive). PSA-synced tickets also use the imported owner (below).
- **Explainable:** each suggestion carries reasons, for example "Resolved 4 similar tickets for Contoso · 2 open now".
- **No model call.**

### PSA owner (optional, per adapter)

- **Import:** `ExternalTicket.owner?: {id, name, email}`, from:
  - ConnectWise `owner` / `resources`
  - Autotask `assignedResourceID` (resource lookup, cached)
  - Halo `agent_id` / `agent_name`
  - Syncro `user`
  - Dynamics `ownerid`
- **Matching:** the owner is matched to a technician by email, then by name, and stored in `psa_refs`.
- **Export:** an optional `setOwner?(ticketId, memberId)` for when assignment should go back to the PSA.

### Behaviour

- On every escalation path, compute the best suggestion and store it in a new column `tickets.suggested_assignee` (migration 17), with the reasons in the escalation event's meta.
- **Ticket page:** "Suggested: **Dana Reyes**: resolved 4 similar for Contoso · 2 open now", with **Assign** (sends `PATCH assignee`) and **Pick someone else**. The free-text assignee input becomes a directory picker that still allows free text.
- **Escalation notice** (item 1): includes the suggestion. In Slack the suggested technician is @mentioned.
- **Workspace setting `autoAssignOnEscalation`:** `off` (default) or `suggested`, which assigns automatically and, if the PSA supports it, sets the owner. Audited.
- Today `PATCH /api/tickets/:id` doesn't audit assignee changes (`app.ts:645-659`); add that.

### Tests

- The scorer on a fixture: the similar-ticket resolver wins, load breaks ties, and out-of-hours technicians are excluded.
- No suggestion when the directory is empty.
- The escalation stores the suggestion.
- Auto-assign on and off.
- Owner import maps to a technician.

**Size:** M.

---

## 5. Read screenshots and PDFs

**Today:**
- Attachments are dropped everywhere:
  - The email schema has no attachments field (`hooks.ts:26-38`).
  - Slack ignores `file_share` and any message without text (`slack.ts:88`).
  - Teams reads only `activity.text` (`teams.ts:102-111`).
  - The chat bridge is text only.
  - PSA comments import only `body`.
- The AI layer has no image part (`ai/types.ts:6-9`). The OpenAI-compatible adapter flattens user text to one string (`openai.ts:57`), and there is no vision flag on model profiles.

### AI layer

- **New part:** `{type:"image"; mediaType:"image/png"|"image/jpeg"|"image/gif"|"image/webp"; data: string /* base64 */}`.
- **Anthropic** (`anthropic.ts:31-42`): `{type:"image", source:{type:"base64", media_type, data}}`.
- **OpenAI-compatible** (`openai.ts:34-60`): when a user message has images, send `content` as an array (`[{type:"text",text}, {type:"image_url", image_url:{url:"data:<type>;base64,<data>"}}]`) instead of the joined string.
- **Capability flag:** `ModelOptions.vision?: boolean`.
  - Defaults to true for the Anthropic, OpenAI, Azure OpenAI and Gemini presets, false otherwise; editable on the AI models page.
  - When the serving model (including a fallback) lacks vision, image parts are replaced with `[Screenshot "error.png" attached — this model can't read images]`.

### Storage

- New table (migration 18): `attachments(id, ticket_id, event_id, source, filename, media_type, size, sha256, created_at)`.
- Files live under `<dataDir>/attachments/<ticket_id>/<id>`.
- Deleted with the ticket; workspace retention setting, 180 days by default.
- **Limits:**
  - images up to 5 MB, PDFs up to 10 MB, 5 files per message;
  - anything else (including SVG, Office files, archives) is listed by name on the ticket but not stored or read in v1.

### Intake per channel

- **Email:** `emailSchema` gains `attachments?: [{filename, contentType, content /* base64 */}]`.
  - CHANNELS.md shows the mapping for SendGrid Inbound Parse, Mailgun, Postmark and Cloudflare Email Workers. They all provide base64 or multipart content, so the relay converts it.
  - The webhook body limit rises to 25 MB for this route only.
- **Slack:**
  - Accept the `file_share` subtype; text may be empty when files are present.
  - Download `url_private_download` with the bot token. This needs a new `files:read` scope, added to the docs and the integration's scope check.
- **Teams:**
  - Inline images: `activity.attachments[]` with `contentType` `image/*` and a `contentUrl`, fetched with the bot's token (the same token as replies).
  - Personal-chat files: the `application/vnd.microsoft.teams.file.download.info` `downloadUrl`.
  - Hosts are allow-listed to Microsoft domains.
- **Chat bridge:** `attachments?: [{filename, contentType, data?: base64, url?: string}]`. URLs go through `validatePublicHttpsUrl`, as the REST connector does.
- **PSA (phase 2):** an optional `listAttachments(ticketId)` and `getAttachment(id)` per adapter (ConnectWise documents, Autotask `TicketAttachments`, Halo `/Attachment`, Syncro ticket `attachments`). Imported alongside comments.

### To the model

- Images attached to the ticket's first message go into the run's intro message (`runner.ts:83-92`) as image parts after the text.
- Images on later messages go into the continuation message.
- At most the 4 most recent images per run, to control cost.
- **PDFs:** text is extracted server-side (a small pure-JS extractor; dependency to be chosen, no native modules). The first 15,000 characters go in `<attachment name="…" untrusted>` tags. The same applies to `.eml` and `.txt`.
- The prompt treats attachment content like ticket text: data, never instructions.

### Dashboard

- Thumbnails and file chips on the ticket timeline.
- Downloads are served with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and a strict CSP. Images show inline only from our own route.
- The status page shows the requester their own attachments by name only.

### Safety

- Screenshots can contain passwords. Attachment content is never written to the knowledge base or client notes automatically, and the `SECRET_LIKE` check still applies to anything Haley saves.
- Image content is untrusted, the same as the ticket body. The policy engine is unaffected by what an image says.

### Tests

- Each adapter converts image parts correctly.
- A non-vision fallback gets the placeholder.
- Email, Slack and Teams attachments are stored and passed to the model (fake fetch).
- Size and type limits.
- PDF text is extracted and wrapped as untrusted.
- Download headers.
- Retention purge.

**Size:** M–L. AI layer plus email and Slack first, then Teams and the chat bridge, then the PSAs.

---

## 6. QA before close, and frustration flags

### 6a. QA before close

- **Today:** technicians close tickets through `PATCH /api/tickets/:id {status}` (`app.ts:645-659` → `store.updateTicket`). There is no check.
- **New route:** `POST /api/tickets/:id/qa`, called by the UI when a technician picks Resolved or Closed.
- **Deterministic checks first:**
  - **No reply to the requester** since their last message. Not raised when the ticket came from monitoring.
  - **No resolution note:** no internal note, Haley summary or reply after the last status change to in progress.
  - **Promised follow-up not done:** a reply containing "I'll"/"we'll" and a time phrase, followed by no activity. A heuristic, shown as a hint only.
  - **PSA time:** when PSA time entries are on and the ticket is PSA-linked, no technician time is logged. Shown only where the adapter can read time entries, which is later.
- **Then optionally one model call** (purpose `qa`, workspace setting): "Does the resolution note explain the fix? Does the last reply answer the requester?" It returns `{ok, issues[]}`.
- **UI:** a short panel, "Before you close: …", with **Close anyway**, **Draft reply** (opens the copilot draft) and **Add note**.
- **Setting `qaBeforeClose`:** `off`, `warn` (default) or `require`. With `require`, closing despite issues needs a short reason, which is audited.
- **Haley's own resolutions:** Haley already summarises and asks for confirmation, so she is out of scope.

### 6b. Frustration flags

- **Heuristic score** on each inbound requester message, with no model call:
  - repeat contact: 3+ tickets from the same requester in 7 days (the snapshot already counts this);
  - a reopen or "Still broken" click;
  - an SLA breach;
  - anger cues: "third time", "still not", "unacceptable", "escalate", "manager", repeated "!!!", ALL-CAPS ratio.
- **Optional model check** (purpose `sentiment`): one short call, only when the heuristic score crosses a threshold, to confirm and phrase the reason.
- **VIP:** `org.settings.vipRequesters` (emails), plus a "VIP" chip in the requester snapshot. VIP tickets get a +1 priority suggestion.
- **Effects:**
  - A `frustrated` flag with its reason on the ticket (new column `tickets.flags`, JSON, migration 17), and a badge in the ticket list.
  - A filter "Needs care".
  - Haley's run intro gets a line telling her to acknowledge the frustration and avoid repeating questions already answered.
  - When a flagged ticket would be Haley's second unsuccessful attempt, she escalates instead of trying again.
  - Included in the escalation notice (item 1).

### Tests

- **QA:** each deterministic check, the model path (scripted LLM), all three modes, and the audit with `require`.
- **Frustration:** each heuristic signal, the threshold before the model check, VIP priority, the prompt line, and the escalate-sooner rule.

**Size:** S each.

---

## 7. Integrations by demand

**Refactor first (S):** generalise `SyncroAlertTickets` (`monitoring/syncroAlerts.ts`) into an `AlertSource` interface. Its caps, dedupe, pause check, cursor state and ticket creation become shared, so each new alert source is only an adapter.

```ts
interface AlertSource {
  key: string;                                   // "syncro_rmm" | "datto_rmm" | "huntress" | "sentinelone" …
  listActive(since: string | null): Promise<AlertItem[]>;
  dedupeKey(a: AlertItem): string;               // device + normalised description, as today
  describe(a: AlertItem): { title: string; body: string; assetId?: string };
}
```

Then one connector per PR. Each one follows the NinjaOne pattern (`connectors/ninjaone/api.ts`, `tools.ts`) and comes with:
- a registry entry (`registry.ts`);
- `fakeFetch` tests;
- recipes;
- an INTEGRATION_API_NOTES section verified against the vendor docs;
- live-tenant checks listed as open.

| Order | Integration | Read tools | Change tools (risk) | Alert tickets |
|---|---|---|---|---|
| 1 | **Datto RMM** (API v2, key/secret → OAuth token) | sites, devices, device by user, open alerts, components | run an allow-listed component as a quick job (write); resolve alert (write) | yes |
| 2 | **Huntress** (API key/secret, basic auth) | organisations, agents, incident reports, signals | none in v1, unless the API's remediation approval is confirmed: then "approve remediation" (destructive, `technician_only`) | yes: each incident report becomes a ticket Haley triages, adding RMM and M365 context |
| 3 | **SentinelOne** (API token, per console URL) | agents, threats, threat details | mark threat resolved (write); mitigate kill/quarantine (destructive); disconnect from network (destructive, `technician_only` rail) | yes |
| 4 | **CIPP** (Entra app, client credentials, to the MSP's CIPP API) | tenant list, users, standards and drift, alerts | none in v1. Haley already acts through Graph; CIPP adds standards/drift context and tenant discovery | drift alerts, optional |
| 5 | **N-central** (REST API, JWT) | customers, devices, active issues | run an allow-listed automation policy (write) | yes |

Customer mapping works as it does for PSAs: suggested by name or domain, confirmed by the MSP.

**Size:** M each, after the S refactor.

---

## 8. Phone through a partner

Haley doesn't build telephony. A voice-AI receptionist or phone system that can POST a webhook sends Haley a transcript, and Haley turns it into a ticket.

### Route

`POST /hooks/voice`, signed with HMAC like the chat bridge (`x-haley-signature`, `HALEY_VOICE_WEBHOOK_SECRET`). The body:

```json
{ "callId": "…", "from": "+15551234567", "to": "+15557654321", "startedAt": "…", "durationSec": 184,
  "callerName": "optional, as spoken", "company": "optional, as spoken",
  "summary": "optional", "transcript": "…", "recordingUrl": "optional https URL" }
```

CHANNELS.md documents the mapping for a generic provider. Provider-specific shims can come later.

### Identifying the caller

1. **Client:**
   - by the dialled number (`org.settings.phoneNumbers`, for MSPs with a number per client);
   - otherwise by matching the caller;
   - otherwise by the spoken company name against client names (fuzzy, at least 0.8 similarity), which is a suggestion only.
2. **Person:** `from` normalised to E.164 and matched against:
   - the client's M365 users (`mobilePhone` and `businessPhones` through Graph `$filter`, to verify; otherwise a cached directory scan);
   - an optional new PSA method `findContactByPhone?(e164)`.
3. **Assurance is always `none` for phone,** whatever caller ID says, because caller ID can be spoofed. That is enforced in code, with a test. The existing policy then keeps unattended and sensitive changes off until identity is raised.

### Behaviour

- Create the ticket with `channel:"phone"`. The description is the summary followed by the transcript, both untrusted. An unmatched caller is noted.
- Haley's run gets a phone-specific instruction:
  - investigate with read tools;
  - fix what doesn't depend on identity (for example a known outage);
  - for anything identity-sensitive, either send a step-up (Duo, Okta or SMS to the *directory* phone of the matched person, which raises assurance the normal way) or follow up on a verified channel ("We got your call about Outlook. Reply here to continue.") through email or Teams to the matched person.
- **Never reset a password or MFA method on the strength of a call alone.** That's a test, not just a prompt line.
- The recording URL is stored as a link only and is never fetched by the model.

**Tests:** signature check; client and person matching; assurance always `none`; a password reset from a phone ticket is blocked without step-up and allowed after a step-up approval; the follow-up is sent to the matched person, not to the caller's number.

**Size:** S–M.

---

## 9. Cost per resolved ticket

**Today:** `usageReport()` (`usage.ts:51`) gives per-client `aiCostUsd`, `billableAiUsd`, `ticketsResolvedByHaley` and so on. The Usage page (`Usage.tsx:147-167`) shows AI cost, billable, resolved alone, confirmed and hours saved.

### New columns

The usage row, CSV and page get:
- **AI cost per resolved ticket** = all AI cost on ticket runs ÷ tickets resolved by Haley alone. This is fully loaded: it includes the cost of tickets she escalated, which is the honest figure to compare with per-ticket pricing.
- **AI cost per ticket worked** = the same cost ÷ tickets Haley ran on.
- **Copilot cost**, shown separately: model usage with `purpose` `assist`, `lesson`, `qa`, `sentiment` or `insights`, which has no run, or runs that aren't ticket runs.
- **Billable per resolved ticket**, with the markup.

Each column shows "—" when there are no resolved tickets or the cost is unpriced.

**PRICING.md:**
- A short "benchmarks" section: a credit-priced competitor's agent-handled ticket is about $0.36–$0.60 (3 credits at $0.12–$0.20, October 2026). How to read Haley's figure against it.
- Note that per-ticket cost depends heavily on the model chosen.

**Tests:** the arithmetic on a fixture, including zero resolutions, unpriced models and copilot purposes being separated.

**Size:** S.

---

## Suggested order

| Phase | Items | Why |
|---|---|---|
| 1 | **9** cost per ticket (S), **0** directory (S), **1** approvals in Slack, then Teams (M–L) | A quick win, then the biggest day-to-day gap. The directory unblocks 1 and 4 |
| 2 | **6** QA and frustration (S+S), **4** dispatch (M), **2** lessons (M) | All build on item 1's notices and decisions |
| 3 | **5** attachments (M–L), **3** insights report (M–L) | Larger. Insights also needs per-PSA live checks |
| 4 | **8** phone webhook (S–M), **7** refactor plus integrations one by one (M each) | Demand-driven; pick integrations from what customers ask for |

## Open questions

1. **Teams approval destination:** is a channel (registered by @mentioning the bot) enough for v1, or do approvers need personal DMs from day one? DMs need proactive 1:1 conversations and that each technician has the app installed.
2. **Chat approvals for destructive changes:** should the default be *allowed* (as specced) or *dashboard only*?
3. **Insights hosting:** run prospect reports from the MSP's own Haley instance (as specced), or a separate shared instance?
4. **Attachment storage:** files in the data directory (as specced) or object storage (S3/Azure Blob) for hosted deployments?
5. **First integration after the refactor:** Datto RMM or Huntress?
6. **Per-technician sign-in:** the directory makes Entra sign-in for the dashboard straightforward. Should it be scheduled right after phase 1?
