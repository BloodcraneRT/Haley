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

- **Routing:** the sender's domain is matched to a client's primary domain or its extra email domains.
- **Identity:** the email gets `email` assurance only with DMARC pass, or a DKIM signature aligned with the From domain. Without `authenticationResults`, every email is treated as unverified.
- **Threading:** replies are matched by the `[#1234]` tag in the subject or by the first message ID in `References` / `In-Reply-To`. Quoted history is stripped.

**Outbound.** Set `HALEY_SMTP_URL` (for example `smtps://user:pass@smtp.example.com:465`) and `HALEY_SMTP_FROM`. Replies go out as `Re: [#1234] Subject`, threaded to the original message. Tickets created in the dashboard or through the API are also answered by email when the requester has an address.

## Slack

1. Create one Slack app for your MSP.
   - **Bot scopes:** `chat:write`, `im:history`, `app_mentions:read`, `users:read`, `users:read.email`.
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

## PSA / API intake

`POST /api/intake` with the technician API token. The body is `{ from, fromName, subject, body, verified?, autoRun? }`. Use `verified: true` only when the PSA authenticated the requester, which gives `email` assurance.

## Try it without any of this

The dashboard's **End-user simulator** sends messages through the same pipeline as a chat channel. You pick the client, the requester and the identity level, then chat with Haley as that person.
