# Spec: phase 4, the deferred items

Status: **all built** (4a–4d), 2026-10-09. Phone uses the generic webhook with a setup guide (no provider-specific shim yet); SentinelOne is the first new integration. Changes from this spec while building:

- **4a:** the probe also runs from the dashboard (**Check fields** on the PSA page), not only as a script. Autotask categories come from `issueType`.
- **4b:**
  - All three sections share migration 19.
  - Tickets closed in the PSA credit their Haley assignee (set from the PSA owner) in dispatch, rather than a separate resolver row.
  - The PSA time check is advisory: `require` mode doesn't enforce it.
  - Haley's older time entries are recognised by her note text as well as by id.
  - PSA attachments are capped at 5 per ticket per sync (the per-message limit), not 10.
  - A file attached to a comment belongs to whoever wrote that comment, when the PSA links them (HaloPSA, Dynamics emails).
  - ConnectWise and Syncro files are treated as the customer's, since neither says who added them. That's safe: Haley reads them as untrusted, like ticket text.
- **4c:**
  - The "can't be DMed" list on the settings page names approvers from client rules who aren't in the directory or have no linked chat account. It doesn't track Teams installs; those are audited when a DM fails.
  - The reminder counts from when the change was proposed.
  - The reminder DM is the full card again (so it can be decided from there), not a text line.
- **4d:**
  - Phone: a call nobody can place gets a 422 (and an audit entry) so the service can alert someone, rather than a ticket on no client. A client guessed from the company name needs a technician to confirm it before Haley works the ticket.
  - Phone: the caller's number is matched by its last ten digits against users' phone numbers read from the client's directory tools (Microsoft 365 mobile and business phones, Google phones and recovery phone), cached a day per client. A number on more than one person matches nobody.
  - Alert sources: ticket dedupe keys from other sources are prefixed with the source (`sentinelone:…`); Syncro's stay as they were, so tickets already open keep matching.
  - SentinelOne: tools are `s1_list_devices`, `s1_get_device`, `s1_list_threats`, `s1_get_threat`, `s1_update_threat` (write), `s1_mitigate_threat` (destructive), `s1_disconnect_device` (destructive, technician-only rail) and `s1_reconnect_device` (destructive). Recipes: *SentinelOne threat triage* and *Contain a compromised device*.

Phases 1–3 of [NEO_FOLLOWUPS.md](NEO_FOLLOWUPS.md) are built. This spec covers what was left out of them, plus the two items that were always planned for phase 4 (phone and new integrations). Each section says what changes, where in the code, the data, the API and UI, safety rules, tests, and size. File references are to `main` after PR #14. The last migration today is 18; the numbers below follow the suggested order and are indicative.

- **Size key:** S is about a day, M a few days, L a week or more.
- **Delivery:** one PR per section, in the order at the end.

## Contents

1. [Approver DMs and reminders](#1-approver-dms-and-reminders) (built)
2. [PSA ticket owners and working hours](#2-psa-ticket-owners-and-working-hours) (built)
3. [PSA time entries in the close check](#3-psa-time-entries-in-the-close-check) (built)
4. [Attachments from the PSA](#4-attachments-from-the-psa) (built)
5. [Reports from Autotask and Dynamics](#5-reports-from-autotask-and-dynamics) (built)
6. [Phone through a partner](#6-phone-through-a-partner) (built)
7. [Alert sources and integrations by demand](#7-alert-sources-and-integrations-by-demand) (built: SentinelOne first)
8. [Live-tenant checks](#8-live-tenant-checks) (built)
- [Suggested order](#suggested-order)
- [Open questions](#open-questions)

---

## 1. Approver DMs and reminders

**Today:**
- `ApprovalNotifier` (`approvals/notify.ts`) posts one card per channel to the client's or workspace's Slack channel and Teams conversation, and updates every card when the action is decided. Posts are recorded in `approval_posts(action_id, channel, ref)`.
- Named approvers (`actions.approvers`, from client policy rules) see the card only if they watch that channel. Nothing reminds anyone about a change that has waited an hour.

### Behaviour

1. **DM the named approvers.** When an action has named approvers, Haley also sends each of them the same card as a direct message, if they are in the technician directory with a linked chat account. Actions without named approvers ("any technician") are not DMed; the channel card is enough.
2. **The DM is a normal card.** It is recorded in `approval_posts` like a channel card, so it is updated in place when the action is decided anywhere. Decisions from a DM go through the same `decideAction` path with the same checks.
3. **One reminder.** A workspace setting `approvalReminderMinutes` (`0` = off, the default; or 15, 30, 60 or 120). When an action is still `pending_approval` that long after it was parked, Haley:
   - posts a short reply under the original channel card ("Still waiting: Megan's licence change, 45 min"); in Teams, as a reply in the same conversation;
   - DMs the named approvers again, or, when there are none, the technician the ticket is assigned to.

   Only one reminder per action, ever. No repeating loops.
4. **Settings page:** "DM named approvers" (on by default when chat approvals are set up) and the reminder select, on the existing chat approvals panel (`ChatApprovals.tsx`).

### Slack

- `conversations.open { users: <slack_user_id> }` returns the DM channel. Then `chat.postMessage` as for channel cards (`approvals/slack.ts:141`).
- Needs the `im:write` scope. Add it to the setup steps (`connectors/registry.ts`) and to the scope check on the settings page.
- Reminder in the channel: `chat.postMessage` with `thread_ts` set to the card's `ts` (already in the post's `ref`).

### Teams

- A 1:1 conversation is created with `POST {serviceUrl}/v3/conversations` and the body `{ bot, members: [{ id: <aad object id> }], tenantId, isGroup: false }`. The `serviceUrl` and `tenantId` come from the registered approvals conversation (`ApprovalSettings.teamsConversation`).
- This only works if the technician has the Haley app installed in personal scope. If the call fails with 403 or 404, Haley falls back to the channel card and audits `approvals.dm_unavailable` once per technician per day. The settings page lists which technicians can't be DMed.
- Installing the app for everyone is a Teams admin setting (an app setup policy). Documented in CHANNELS.md, with no Graph permission needed on the MSP's tenant.
- Reminder in the channel: reply to the card's activity (`/v3/conversations/{id}/activities/{activityId}`).

### Data (migration 20)

- `actions.reminded_at TEXT`, set when the reminder goes out, so it is sent once even across restarts.
- `approval_posts.kind TEXT NOT NULL DEFAULT 'card'`: `card`, `dm` or `reminder`. Reminders aren't updated on decision; cards and DMs are.

### Where it runs

- DMs: in `ApprovalNotifier.pending`, after the channel cards.
- Reminders: a new `ApprovalNotifier.remind(nowMs)` called from `Scheduler.tick` (`scheduler.ts:52`). It reads pending actions older than the setting with `reminded_at` null. It is cheap when the setting is off: return before any query.

### Tests

- A named approver with a Slack id is DMed, and the DM is updated when the action is approved in the dashboard.
- No DM for "any technician" actions, or for an approver with no linked chat account.
- A Teams 403 falls back and is audited once.
- The reminder fires once after N minutes, never twice, and not at all for decided actions or when the setting is 0.

**Size:** M.

---

## 2. PSA ticket owners and working hours

**Today:**
- `rankTechnicians` (`dispatch.ts`) scores directory technicians from Haley's own resolution events. Tickets resolved by a technician inside the PSA count only if the resolver's name matches a directory name.
- `ExternalTicket` (`psa/types.ts:15`) has no owner. Who a PSA ticket is assigned to isn't imported, and assignments made in Haley don't reach the PSA.
- `technicians.working_hours` exists (migration 14) but nothing reads or writes it.

### Owner import

- `ExternalTicket.owner?: { id: string; name: string; email: string | null } | null`, filled by each adapter in `listUpdatedTickets` and `getTicket`:

  | PSA | Field (to verify) |
  |---|---|
  | ConnectWise | `owner { id, identifier, name }`; member email from `/system/members/{id}` (cached per sync) |
  | Autotask | `assignedResourceID`; name and email from `Resources` (cached per sync) |
  | HaloPSA | `agent_id`, `agent_name`; email from `/Agent/{id}` (cached) |
  | Syncro | `user_id` and `user { full_name, email }` |
  | Dynamics | `_ownerid_value` with the formatted-value annotation; email from `systemusers` (cached) |

- **Matching to a technician:** first by `technicians.psa_refs[connectionId]`, then by email, then by name (case-insensitive). A match by email or name is saved to `psa_refs` so later matches don't depend on names.
- **On sync:** when the owner changes and matches a directory technician, the Haley ticket's assignee is set to them (actor: the connection's name). The last owner seen is kept on the link, so an unchanged owner doesn't overwrite an assignment made in Haley.
- **Dispatch:** a ticket closed in the PSA counts for its owner as the resolver, in addition to Haley's resolution events. `store.resolutionsSince` gains these rows.

### Owner export (optional, per connection)

- `PsaAdapter.setOwner?(ticketId, ownerId)`. ConnectWise `PATCH owner`, Autotask `PATCH assignedResourceID` (plus `assignedResourceRoleID`, the resource's default service desk role), Halo `POST /Tickets [{ id, agent_id }]`, Syncro `PUT /tickets/{id} { user_id }`, Dynamics `PATCH ownerid@odata.bind`.
- New connection option `syncOwner: boolean` (default off). When on, an assignment in Haley to a technician with a `psa_refs` entry for this connection is pushed on the next sync. Assignments to someone with no PSA id are left alone and noted on the sync result ("Dana has no ConnectWise member; set it on the Technicians page").

### Working hours

- `technicians.working_hours` holds JSON: `{ "tz": "America/Chicago", "days": { "mon": [["08:00", "17:00"]], … }, "awayUntil": "2026-10-20" | null }`. Null means always available, as today.
- **Dispatch:** technicians outside their hours, or away, are left out of the ranking. If that leaves nobody, the best technician overall is still suggested, with the reason "nobody is working now; Dana is next on at 8:00".
- **Auto-assign:** never assigns to someone who is off. The suggestion is still shown.
- **Technicians page:** an hours editor (a weekly grid and time zone, "Away until"), and an "Off now" badge in the list. The PSA id per connection becomes editable there too.
- Time zone math uses `Intl.DateTimeFormat` with the IANA zone; no date library.

### Data (migration 19)

- `ticket_links.last_owner TEXT NOT NULL DEFAULT ''`.
- `psa_connections.options` gains `syncOwner` (JSON; no schema change).

### Tests

- Each adapter maps its owner fields (`fakeFetch` fixtures); lookups are cached within a sync.
- Matching by `psa_refs`, then email, then name, and the match is saved.
- An owner change in the PSA assigns in Haley; an unchanged owner doesn't overwrite a Haley assignment.
- `syncOwner` pushes the assignment once and skips technicians without a PSA id.
- Working hours: excluded when off, the "next on" fallback, auto-assign skips people who are off, and the time zone and day boundary are handled (Sunday-to-Monday wrap).

**Size:** M–L (five adapters). ConnectWise and HaloPSA first, then the rest.

---

## 3. PSA time entries in the close check

**Today:** the close check (`qa.ts`) checks for a reply, a resolution note and promised follow-ups. The spec's fourth check, "no technician time logged in the PSA", was left out because no adapter reads time entries. Haley's own entries are recorded in `ticket_links.logged_time` (migration 10).

### Adapter addition

`PsaAdapter.listTimeEntries?(ticketId): Promise<Array<{ id: string; minutes: number; member: string; createdAt: string }>>`:

| PSA | Query (to verify) |
|---|---|
| ConnectWise | `GET /time/entries?conditions=chargeToType="ServiceTicket" and chargeToId={id}&fields=id,actualHours,member,dateEntered` |
| Autotask | `POST /TimeEntries/query` with `ticketID eq {id}` |
| HaloPSA | `GET /Actions?ticket_id={id}` and use `timetaken` on each action (already read for comments) |
| Syncro | `GET /tickets/{id}` and its `ticket_timers` |
| Dynamics | not supported (no standard time entry on cases); the check is skipped |

### The check

- **When:** the ticket is PSA-linked, the connection has time entries on (`options.timeEntries` isn't `off`), and the adapter has `listTimeEntries`.
- **What:** entries whose id isn't in `logged_time` are technicians' entries. If there are none, add the issue "No technician time is logged on ConnectWise ticket #4512." at level `warning`.
- **Cost:** one PSA call when a technician closes a ticket, with a 5-second timeout. If it fails or times out, the check is skipped and the panel says "Couldn't check PSA time." It never blocks closing.
- **Where:** `POST /api/tickets/:id/qa` (`app.ts`) awaits the adapter call and passes the result to `qaChecks`. `qaChecks` stays synchronous and pure.

### Tests

- Missing time is a warning; Haley's own entries don't count; a timeout skips the check with a note; Dynamics and connections with time entries off don't run it.

**Size:** S–M.

---

## 4. Attachments from the PSA

**Today:** files arrive from email, Slack, Teams and the chat bridge (`attachments.ts`, migration 17). Files attached to a ticket inside the PSA are not imported, so Haley doesn't see a customer's screenshot sent through the PSA portal.

### Adapter addition

```ts
listAttachments?(ticketId: string): Promise<Array<{ id: string; filename: string; contentType: string | null; size: number | null; createdAt: string; fromCustomer: boolean }>>;
getAttachment?(ticketId: string, id: string, maxBytes: number): Promise<Uint8Array>;
```

| PSA | List / download (to verify) |
|---|---|
| ConnectWise | `GET /system/documents?recordType=Ticket&recordId={id}` / `GET /system/documents/{docId}/download` |
| Autotask | `POST /TicketAttachments/query` with `parentID eq {id}` / `GET /Tickets/{id}/Attachments/{attachmentId}` (base64 `data`) |
| HaloPSA | `GET /Attachment?ticket_id={id}` / `GET /Attachment/{id}` (base64) |
| Syncro | the ticket's `attachments[]` / the pre-signed file URL (allow-listed S3 host, no auth header) |
| Dynamics | `annotations` with `isdocument eq true` / `documentbody` (base64) |

### Behaviour

- **When:** in `PsaSync.sync` (`psa/sync.ts:253`), for a ticket already being processed because it changed. Attachments are listed only for those tickets, never for the whole PSA.
- **New attachments only:** ids are remembered on the link (`seen_attachment_ids`). Files Haley uploaded herself aren't imported back (she doesn't upload any today).
- **Limits:** the same as other channels (`storeAttachments`): type sniffed from bytes, images 5 MB, PDFs 10 MB, text 1 MB. Size is checked before downloading when the PSA reports it. At most 10 files per ticket per sync and 50 per sync overall; the rest wait for the next sync.
- **Whose files:**
  - Customer files on a new ticket go into Haley's intro, like an email attachment.
  - Customer files with a new public comment are linked to that comment's message, and Haley sees them when she picks the ticket up again.
  - Technician files (internal) are stored and shown on the timeline, but not sent to Haley.
  - Files from an untrusted source follow the same rule as other channels (`hub.ts`).
- **Option:** connection option `importAttachments` (default on for new connections, off for existing ones until the MSP turns it on, so an upgrade doesn't suddenly download a backlog).

### Data (migration 19, with section 2)

- `ticket_links.seen_attachment_ids TEXT NOT NULL DEFAULT '[]'`.

### Tests

- Each adapter's list and download against `fakeFetch`, including base64 decoding and the Syncro host allow-list.
- Only new files are imported; a size over the limit is listed by name without a download; the per-sync caps; customer versus technician files; the option off imports nothing.

**Size:** M–L (five adapters). HaloPSA and ConnectWise first.

---

## 5. Reports from Autotask and Dynamics

**Today:** `listClosedTickets` exists for ConnectWise, HaloPSA and Syncro (`psa/*.ts`), so "What would Haley handle?" refuses Autotask and Dynamics connections.

### Queries (to verify)

- **Autotask:** `POST /Tickets/query` with `status eq 5` (Complete; read the id from the `Tickets` field picklist instead of assuming 5) and `completedDate gte from` and `lt to`. Company names come from the cached `Companies` list. Time: `null` (tickets have no actual-hours field; summing `TimeEntries` per ticket is too many calls).
- **Dynamics:** `incidents?$filter=statecode eq 1 and modifiedon ge {from}` with `$expand=Incident_IncidentResolutions($select=actualend,timespent)`. `closedAt` is the resolution's `actualend`, filtered to the range by Haley. `timespent` is in minutes, which gives real hours.
- Both cap at `max` and page as the regular sync does (`query()` for Autotask, `@odata.nextLink` for Dynamics).
- Set `insights: true` on both in `psa/registry.ts`.

### Tests

- The query bodies and URLs, paging, the cap, the range filter and the Dynamics `timespent` mapping, against `fakeFetch`.

**Size:** S.

---

## 6. Phone through a partner

Unchanged in substance from [NEO_FOLLOWUPS §8](NEO_FOLLOWUPS.md#8-phone-through-a-partner). Haley doesn't build telephony: a voice-AI receptionist or phone system that can POST a webhook sends Haley a transcript, and Haley turns it into a ticket. Updated for the code as it is now:

### Route

- `POST /hooks/voice`, signed like the chat bridge: HMAC-SHA256 of the raw body in `x-haley-signature`, using the same helper as `channels/chat.ts`, with its own secret `HALEY_VOICE_WEBHOOK_SECRET`.
- Body: `{ callId, from, to, startedAt, durationSec, callerName?, company?, summary?, transcript, recordingUrl? }`. A repeated `callId` is ignored (idempotent).
- `TicketChannel` (`types.ts:27`) gains `"phone"`. The dashboard shows it with a phone icon (`CHANNEL_META`).

### Identifying the caller

1. **Client:** by the dialled number (`org.settings.phoneNumbers`, for MSPs with a number per client); otherwise by the person match below; otherwise by the spoken company name against client names. The last is a suggestion only: the ticket goes to the unassigned queue with "Caller said Contoso".
2. **Person:** `from` normalised to E.164 and matched against the client's directory (Graph `mobilePhone` and `businessPhones`, or Google `phones`), through a cached directory scan per client (refreshed daily). A `$filter` query is used only once it's verified to work on phone fields.
3. **Assurance is always `none` for phone,** whatever caller ID says, because caller ID can be spoofed. This is enforced in `hub.receive` for `channel:"phone"`, with a test.

### Behaviour

- The ticket's description is the summary followed by the transcript, both untrusted. An unmatched caller is noted.
- Haley's run gets a phone-specific instruction: investigate with read tools; fix what doesn't depend on identity (for example a known outage); for anything identity-sensitive, either send a step-up to the *directory* phone or account of the matched person (Duo, Okta or SMS), or follow up on a verified channel through email or Teams to the matched person ("We got your call about Outlook. Reply here to continue.").
- **Never reset a password or MFA method on the strength of a call alone.** The existing assurance policy already blocks it at `none`; a test proves the phone path can't raise assurance except through step-up.
- The recording URL is stored as a link only. It is never fetched and never shown to the model.
- Replies: phone has no reply route. Haley's replies go to the matched person's email, or stay as notes when nobody is matched.

### Docs

CHANNELS.md gets a "Phone" section with the generic body and how to map one provider's webhook to it. Provider-specific shims come later, by demand.

### Tests

- Signature check and replayed `callId`; client by dialled number, by caller, and the company-name suggestion; assurance always `none`; a password reset from a phone ticket is blocked without step-up and allowed after a step-up approval; the follow-up goes to the matched person's email, not the caller's number; the recording URL is never fetched.

**Size:** S–M.

---

## 7. Alert sources and integrations by demand

Unchanged from [NEO_FOLLOWUPS §7](NEO_FOLLOWUPS.md#7-integrations-by-demand): a refactor, then one integration per PR.

### Refactor (S)

Generalise `SyncroAlertTickets` (`monitoring/syncroAlerts.ts`) into `AlertTickets` over an `AlertSource` interface. Caps, dedupe, the pause check, cursor state and ticket creation are shared; each source is an adapter:

```ts
interface AlertSource {
  key: string;                                   // "syncro_rmm" | "datto_rmm" | "huntress" | "sentinelone" …
  listActive(since: string | null): Promise<AlertItem[]>;
  dedupeKey(a: AlertItem): string;               // device + normalised description, as today
  describe(a: AlertItem): { title: string; body: string; assetId?: string };
}
```

`Scheduler.tick` (`scheduler.ts:64`) calls the generic poller. The Syncro behaviour and its tests stay the same; the tests move to the generic class with Syncro as the fixture source.

### Integrations

One per PR, each following the NinjaOne pattern (`connectors/ninjaone/`), with a registry entry, `fakeFetch` tests, recipes, an INTEGRATION_API_NOTES section and the live checks listed in section 8:

| Candidate | Read tools | Change tools (risk) | Alert tickets |
|---|---|---|---|
| **Datto RMM** | sites, devices, device by user, open alerts | run an allow-listed component (write); resolve alert (write) | yes |
| **Huntress** | organisations, agents, incident reports | none in v1 | yes, incident reports |
| **SentinelOne** | agents, threats | mark resolved (write); quarantine (destructive); disconnect from network (destructive, technician-only rail) | yes |
| **CIPP** | tenants, standards and drift, alerts | none in v1 | drift alerts, optional |
| **N-central** | customers, devices, active issues | run an allow-listed automation policy (write) | yes |

Which one comes first is an open question: build what customers ask for.

**Size:** S for the refactor, then M each.

---

## 8. Live-tenant checks

Several queries are built from vendor documentation but haven't been run against a real tenant: the closed-ticket queries (INTEGRATION_API_NOTES), and everything marked "to verify" above. Rather than leaving that to chance:

- **A read-only probe:** `npm run probe:psa -- <connectionId>` (`server/scripts/probePsa.ts`) calls each optional read method on a saved connection (`listClosedTickets` for 7 days with `max: 5`, `listTimeEntries`, `listAttachments` and the owner fields on one recent ticket) and prints **which fields came back and their types, never their values**. It makes no changes and logs nothing to the database.
- **The checklist:** a table in INTEGRATION_API_NOTES with one row per PSA and method: verified (date, version) or not. The PR that adds a method adds its row.
- **In the product:** methods that haven't been verified for a PSA show "Preview" next to the feature in the dashboard (reports, owner sync, attachment import), so MSPs know to check the first results.

**Size:** S.

---

## Suggested order

| Step | Sections | Why |
|---|---|---|
| 4a | **5** Autotask and Dynamics reports (S), **8** probe and checklist (S) | Quick, and the probe makes the rest of the PSA work verifiable |
| 4b | **2** owners and working hours (M–L), **3** PSA time check (S–M), **4** PSA attachments (M–L) | All adapter work on the same five PSAs; share fixtures and the probe |
| 4c | **1** approver DMs and reminders (M) | Builds on owners: the reminder can go to the assigned technician |
| 4d | **6** phone (S–M), **7** refactor, then integrations one at a time (S, then M each) | Driven by what customers ask for |

## Open questions

1. **First integration (section 7):** which do customers ask for most: Datto RMM, Huntress, SentinelOne, CIPP or N-central?
2. **Phone partner (section 6):** is there a provider to support from day one, or is the generic webhook with a mapping guide enough?
3. **Owner sync (section 2):** should pushing Haley's assignments back to the PSA be on by default for new connections?
4. **Teams DMs (section 1):** is asking the MSP to install the Haley app for all technicians (a Teams admin policy) acceptable, or should Haley install it per user through Graph? That would need an extra application permission on the MSP's own tenant.
5. **Attachment import on upgrade (section 4):** off by default for existing connections (as specced), or on with a start date so the backlog isn't downloaded?
