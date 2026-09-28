import { createHmac, timingSafeEqual } from "node:crypto";
import type { Ticket } from "../types.js";
import type { ChannelAdapter, DeliveryResult } from "./types.js";

export const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export function verifyChatSignature(secret: string, header: string | undefined, rawBody: string): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(sign(secret, rawBody));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Generic chat bridge for anything without a native adapter (Google Chat, SMS, WhatsApp, a web widget).
 * The bridge signs its requests with the shared secret, vouches for the user's identity, and gets replies
 * POSTed to its callback URL signed the same way.
 */
export class ChatWebhookAdapter implements ChannelAdapter {
  readonly channel = "chat" as const;
  readonly supportsPrivate = true;

  constructor(
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(ticket: Ticket, text: string, options: { private?: boolean } = {}): Promise<DeliveryResult> {
    const { callbackUrl, threadId } = ticket.channel_ref;
    // Conversations started from the dashboard's end-user simulator are read back from the ticket timeline.
    if (ticket.channel_ref.simulated === "1") return { delivered: true, detail: "End-user simulator" };
    if (!callbackUrl) return { delivered: false, detail: "The chat bridge gave no callback URL." };
    const body = JSON.stringify({ threadId, ticketNumber: ticket.number, text, private: Boolean(options.private) });
    const res = await this.fetchImpl(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-haley-signature": sign(this.secret, body) },
      body,
    });
    if (!res.ok) throw new Error(`Chat bridge returned ${res.status}`);
    return { delivered: true, detail: "Chat" };
  }
}
