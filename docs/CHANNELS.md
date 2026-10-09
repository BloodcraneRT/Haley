# End-user channels

End users reach Haley by email, Slack, Microsoft Teams, or anything else through the chat bridge. Every channel feeds the same pipeline:
- A message opens a ticket, or continues the sender's open one.
- The sender's identity assurance is recorded.
- Haley acknowledges the message and starts working.
- Replies go back on the same channel.
- If the person writes again while Haley is busy, she takes another pass as soon as the current one finishes.

The webhooks live under `/hooks/*`. They are outside `/api` and don't use the technician token; each one authenticates its caller its own way. The dashboard's **Channels** page shows which channels are enabled and their webhook URLs. Set `HALEY_PUBLIC_URL` so the page shows your real address.

## Email

**Inbound.** Point a mail-to-webhook service (SendGrid Inbound Parse, Mailgun routes, Postmark inbound, Cloudflare Email Workers, or a Graph subscription relay) at:

```
POST {HALEY_PUBLIC_URL}/hooks/email?key={HALEY_EMAIL_HOOK_SECRET}
```

The `x-haley-hook-secret` header works instead of `?key=`. Map the provider's payload to this JSON:

```json
{
  "from": "priya@client.com",
  "fromName": "Priya Nair",
  "subject": "Locked out",
  "text": "plain-text body",
  "messageId": "<abc@client.com>",
  "inReplyTo": "<…>",
  "references": "<…> <…>",
  "authenticationResults": "mx.example; spf=pass …; dkim=pass header.d=client.com; dmarc=pass"
}
```

`dmarc`, `dkim` and `spf` are also accepted as separate fields.

**Attachments.** Add `"attachments": [{ "filename": "error.png", "contentType": "image/png", "content": "<base64>" }]`. Every relay listed above gives you the file content, as base64 or multipart; convert it to base64. The email route accepts bodies up to 25 MB. See [Attachments](#attachments) for what Haley reads.

- **Routing:** the sender's domain is matched to a client's primary domain or its extra email domains.
- **Identity:** the email gets `email` assurance only with DMARC pass, or a DKIM signature aligned with the From domain. Without `authenticationResults`, every email is treated as unverified.
- **Threading:** replies are matched by the `[#1234]` tag in the subject or by the first message ID in `References` / `In-Reply-To`. Quoted history is stripped.

**Outbound.** Set `HALEY_SMTP_URL` (for example `smtps://user:pass@smtp.example.com:465`) and `HALEY_SMTP_FROM`. Replies go out as `Re: [#1234] Subject`, threaded to the original message. Tickets created in the dashboard or through the API are also answered by email when the requester has an address.

## Slack

1. Create one Slack app for your MSP.
   - **Bot scopes:** `chat:write`, `im:history`, `app_mentions:read`, `users:read`, `users:read.email`, `files:read` so Haley can read screenshots people share, and `im:write` so she can send approval cards to approvers directly.
   - **Event Subscriptions:** Request URL `{HALEY_PUBLIC_URL}/hooks/slack/events`; bot events `message.im` and `app_mention`.
   - **App Home:** enable the Messages tab.
2. Set `HALEY_SLACK_SIGNING_SECRET` to the app's signing secret. Every request is checked against it, including a 5-minute replay window.
3. For each client, install the app to their workspace. Then in Haley, open the client and choose **Connect → Slack**, and paste the bot token. **Test** detects the workspace so messages route to that client.

How it behaves:
- **DMs:** a new message continues the person's open ticket; otherwise it opens one.
- **Channels:** each @mention thread is its own ticket.
- **Replies** go in the thread.
- **Identity:** workspace members whose profile email is on the client's domains get `chat` assurance. Guests and bots don't.

## Microsoft Teams

1. Create an **Azure Bot** resource (multi-tenant is simplest) and enable the Microsoft Teams channel. Set its messaging endpoint to `{HALEY_PUBLIC_URL}/hooks/teams/messages`.
2. Set `HALEY_TEAMS_APP_ID` and `HALEY_TEAMS_APP_PASSWORD`. For single-tenant bots, also set `HALEY_TEAMS_TENANT_ID`.
3. Publish the bot as a Teams app to each client's tenant, via their admin center or a sideloaded app package.
4. Map each tenant to a client. A live Microsoft 365 integration is matched by its tenant ID automatically. Otherwise, set **Teams tenant ID** in the client's self-service settings.

What Haley checks and does:
- **Token validation:** every activity's Bot Framework JWT is checked against Microsoft's published signing keys. That covers the signature, issuer, audience (your app ID), expiry, channel endorsement, and that the token's `serviceurl` claim matches the activity's.
- **Identity:** the sender's Entra object ID is looked up in the client's directory. Active accounts get `directory` assurance.
- **Conversations:** a personal chat is one continuing conversation, and the credentials it delivers are private.

## Chat bridge (Google Chat, SMS, WhatsApp, a web widget, anything else)

```
POST {HALEY_PUBLIC_URL}/hooks/chat
x-haley-signature: sha256=<hex HMAC-SHA256 of the raw body with HALEY_CHAT_WEBHOOK_SECRET>
```

```json
{
  "threadId": "conversation-123",
  "user": { "email": "jo@client.com", "name": "Jo", "verified": true, "verification": "Signed in to the client portal" },
  "text": "The VPN won't connect",
  "callbackUrl": "https://bridge.example/haley-replies",
  "private": true,
  "orgId": "optional; otherwise routed by email domain"
}
```

- **`verified: true`** means your bridge vouches that it authenticated the user. They get `chat` assurance.
- **`private: true`** means only this user sees replies in the thread, so self-service credentials may be sent there.
- **Replies** are POSTed to `callbackUrl` as `{ threadId, ticketNumber, text, private }` and signed the same way.

## SyncroMSP and Dynamics 365

PSA tickets are a channel too. Connect a PSA on the dashboard's **PSA sync** page and map its customers to Haley clients; Haley suggests mappings by email and website domains. What happens next:
- **New tickets** for mapped customers open in Haley, and she works them.
- **Replies** go back as public PSA comments; Syncro emails the customer, and for Dynamics Haley also emails them.
- **Customer comments** continue the ticket.
- **Closing a ticket** in the PSA resolves it in Haley.

Imported requesters get `none` identity by default, because the PSA doesn't tell Haley how they were authenticated. Step-up verification covers that gap. The API details are in [research/INTEGRATION_API_NOTES.md](research/INTEGRATION_API_NOTES.md).

## Attachments

Screenshots, PDFs and text files sent with a message are kept with the ticket. Haley reads them; technicians see them on the timeline.

| What | Kept and read | Limit |
|---|---|---|
| Images (PNG, JPEG, GIF, WebP, recognised by their bytes, not their name) | Shown to the model when it reads images (the model's **Screenshots** setting) | 5 MB |
| PDFs | Text extracted; scanned PDFs with no text are kept but can't be read | 10 MB |
| Text, log, CSV and `.eml` files | Read as text | 1 MB |
| Anything else, oversized files, and files past the fifth in a message | Listed by name only, with why | |

- **Where they come from:**
  - **Email and the chat bridge:** send base64 `attachments` (see above). A chat bridge message can be attachments only.
  - **Slack:** downloaded with the bot token, only from `files.slack.com`. Needs the `files:read` scope.
  - **Microsoft Teams:** pasted images are fetched with the bot's token and shared files from their pre-signed link, only from Microsoft hosts.
  - **Your PSA** (the connection's **Import attachments** option, on for new connections): files on synced tickets, from all five PSAs. Only tickets that changed are checked, at most 5 new files per ticket and 50 per sync (the rest come next sync). The customer's files go to Haley like their messages: on a new ticket from the start, on an existing one with their latest message. Technicians' files, and files on a technician's comment, are kept on an internal note for the record and aren't sent to Haley. Syncro files are downloaded only from Syncro's own storage, with no credentials sent.
- **How Haley reads them:**
  - Attachment content goes to the model inside untrusted `<attachment>` blocks, like the ticket text.
  - She sees the 4 most recent images per model call.
  - Files from someone who can't continue the ticket are left out, the same as their message.
- **Retention:** files are deleted 180 days after they arrive. Change this with `attachmentRetentionDays` in the help desk settings, where 0 keeps them.

## Approvals in your own Slack and Teams

These channels are for **technicians**, not end users. When a change needs approval, Haley posts a card to your team's channel. The card shows:
- the client, ticket and requester, with how the requester was verified;
- the change and its risk;
- why it needs approval, and Haley's reasoning;
- what she checked first.

Technicians in the directory (**Technicians** page) can **Approve**, **Reject** or **Ask for changes** from the card. A change request needs a note, which Haley gets back so she can adjust. When a change is decided anywhere, every card for it updates in place, and the dashboard queue stays the record. The same channel also gets a notice when Haley (or the SLA sweep) escalates a ticket to a person.

Configure it on **Approvals → Slack & Teams**.

**Slack** uses the same Slack app clients use, installed once more in your own workspace.
1. In the app's settings, turn on **Interactivity & Shortcuts**. Set the Request URL to `{HALEY_PUBLIC_URL}/hooks/slack/interactivity`; it is signed with the same signing secret as events.
2. Install the app in your workspace and paste its bot token. Haley stores it encrypted and records the workspace, and clicks from any other workspace are ignored.
3. Invite the app to the approvals channel (`/invite @Haley`), paste the channel id (C…), and use **Send test message**.
4. Optionally, give a client its own channel id in the client's **Self-service & safety** settings.

A technician's Slack account is linked the first time they click a card, by matching the email on their Slack profile to the directory. This uses the `users:read.email` scope, which the app already has.

**Microsoft Teams** uses the Haley bot.
1. Add the app to your team.
2. In the channel where approvals should go, post `@Haley approvals here`.
   - It works only from your own Microsoft 365 tenant: the tenant set on the settings page, or `HALEY_TEAMS_TENANT_ID`.
   - It works only in a channel or group chat, and only for a technician in the directory. Teams reports the sender's email, which is matched to the directory, and the Entra object id is linked.
3. Card buttons are Adaptive Card Universal Actions (`Action.Execute`). Teams delivers them to the bot's messages endpoint as signed `invoke` activities, and Haley answers with the refreshed card.

**Direct messages to approvers** (on by default): when a client rule names who must approve a change, each of them also gets the card directly, in a Slack DM (needs the `im:write` scope) or a Teams chat with the Haley bot. It's the same card: they can decide from it, and it updates when the change is decided anywhere. Changes anyone can approve stay in the channel.
- Teams only lets the bot message people who have the Haley app installed. A Teams admin can install it for every technician with an app setup policy (Teams admin center → Teams apps → Setup policies → Installed apps), with no extra Microsoft 365 permission for Haley. Until then, Haley falls back to the channel card and notes it in the audit log once a day.
- The settings show approvers named in client rules who can't be messaged yet (not in the directory, or no linked Slack or Teams account).

**Reminders** (off by default; 15, 30, 60 or 120 minutes): once per change, when it has waited that long, Haley replies under its channel card ("⏰ Still waiting for approval (45 min): …") and sends the card again to the named approvers, or, when anyone can approve, to the technician the ticket is assigned to. Only once, even across restarts.

**What can be approved from chat:** everything by default. Choose *Routine changes only* to keep sensitive changes (password resets, sign-in blocks, wipes) in the dashboard; their cards then show only **Approve in Haley**. Client rules that name approvers apply in chat as well, and hard rails are never approvable.

## PSA / API intake

`POST /api/intake` with the technician API token. The body is `{ from, fromName, subject, body, verified?, autoRun? }`. Use `verified: true` only when the PSA authenticated the requester, which gives `email` assurance.

## Try it without any of this

The dashboard's **End-user simulator** sends messages through the same pipeline as a chat channel. You pick the client, the requester and the identity level, then chat with Haley as that person.
