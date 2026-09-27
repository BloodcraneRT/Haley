import { createHmac, timingSafeEqual } from "node:crypto";
import type { Store } from "../store.js";
import type { Org, Ticket } from "../types.js";
import type { ChannelAdapter, DeliveryResult, InboundMessage } from "./types.js";

type Json = Record<string, any>;

/** Slack signs every request: v0=HMAC-SHA256(signing secret, "v0:{timestamp}:{raw body}"). */
export function verifySlackSignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  nowMs = Date.now(),
): boolean {
  if (!secret || !timestamp || !signature) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false; // replay window
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`);
  const got = Buffer.from(signature);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Slack uses its own mrkdwn: *bold*, ~strike~, <url|text>. */
export function toSlackMrkdwn(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";
const orgOwnsDomain = (org: Org, domain: string) =>
  org.domain.toLowerCase() === domain || org.settings.emailDomains.some((d) => d.toLowerCase() === domain);

/**
 * Slack app (Events API) for end users: DM the Haley app or @mention it. Each client workspace installs
 * the app and is connected to its org as a "Slack" integration holding the bot token.
 */
export class SlackChannel implements ChannelAdapter {
  readonly channel = "slack" as const;
  readonly supportsPrivate = true;
  private readonly seenEvents: string[] = [];

  constructor(
    private readonly store: Store,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private workspace(teamId: string): { org: Org; token: string } | null {
    for (const integration of this.store.listIntegrations()) {
      if (integration.provider !== "slack") continue;
      const state = this.store.getIntegrationState<{ teamId?: string }>(integration.id);
      if (state?.teamId !== teamId) continue;
      const org = this.store.getOrg(integration.org_id);
      const token = this.store.getIntegrationConfig(integration.id).botToken;
      if (org && token) return { org, token };
    }
    return null;
  }

  private async api(token: string, method: string, params: Record<string, string>, post = false): Promise<Json> {
    const url = `https://slack.com/api/${method}`;
    const res = post
      ? await this.fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(params),
        })
      : await this.fetchImpl(`${url}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } });
    const data = (await res.json()) as Json;
    if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error ?? res.status}`);
    return data;
  }

  /** Slack retries deliveries it thinks timed out; handle each event once. */
  private firstSighting(eventId: string | undefined): boolean {
    if (!eventId) return true;
    if (this.seenEvents.includes(eventId)) return false;
    this.seenEvents.push(eventId);
    if (this.seenEvents.length > 1000) this.seenEvents.shift();
    return true;
  }

  /** Turns an Events API callback into an inbound message, or null when it isn't one Haley should answer. */
  async toInbound(payload: Json): Promise<InboundMessage | null> {
    const event = payload.event as Json | undefined;
    if (payload.type !== "event_callback" || !event || !this.firstSighting(payload.event_id)) return null;
    if (event.bot_id || event.subtype || !event.user || !event.text) return null;
    const isDm = event.type === "message" && event.channel_type === "im";
    if (!isDm && event.type !== "app_mention") return null;

    const workspace = this.workspace(payload.team_id ?? event.team);
    if (!workspace) return null;
    const { org, token } = workspace;
    const info = await this.api(token, "users.info", { user: event.user });
    const user = info.user as Json;
    const email = (user.profile?.email as string | undefined)?.toLowerCase() ?? null;
    const guest = Boolean(user.is_restricted || user.is_ultra_restricted || user.is_bot);
    const verified = Boolean(email) && !guest && orgOwnsDomain(org, domainOf(email!));
    const threadTs = (event.thread_ts as string | undefined) ?? (event.ts as string);

    return {
      channel: "slack",
      org,
      sender: {
        name: user.real_name || user.profile?.real_name || user.name || "Slack user",
        email,
        assurance: verified ? "chat" : "none",
        verification: verified
          ? "Slack workspace member (email from their Slack profile)"
          : guest
            ? "Slack guest or bot account"
            : "Slack user whose email isn't on the organization's domains",
      },
      text: String(event.text).replace(/<@[A-Z0-9]+>\s*/g, "").trim(),
      // In a DM, a new top-level message continues the person's open ticket; in channels, threads are tickets.
      thread: isDm && !event.thread_ts ? { key: "channel", value: event.channel } : { key: "threadTs", value: threadTs },
      ref: { channel: event.channel, threadTs, user: event.user, private: isDm ? "1" : "0", teamId: payload.team_id ?? "" },
    };
  }

  async send(ticket: Ticket, text: string): Promise<DeliveryResult> {
    const workspace = this.workspace(ticket.channel_ref.teamId);
    if (!workspace) return { delivered: false, detail: "The client's Slack workspace is no longer connected." };
    await this.api(
      workspace.token,
      "chat.postMessage",
      { channel: ticket.channel_ref.channel, thread_ts: ticket.channel_ref.threadTs, text: toSlackMrkdwn(text) },
      true,
    );
    return { delivered: true, detail: ticket.channel_ref.private === "1" ? "Slack direct message" : "Slack thread" };
  }
}
