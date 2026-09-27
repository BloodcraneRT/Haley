import { createTransport } from "nodemailer";
import type { Ticket } from "../types.js";
import type { ChannelAdapter, DeliveryResult } from "./types.js";

/**
 * Normalized inbound email. Mail-to-webhook services (SendGrid Inbound Parse, Mailgun routes,
 * Postmark, Cloudflare Email Workers, a Graph subscription relay) map their payloads onto this.
 */
export interface InboundEmail {
  from: string;
  fromName?: string;
  subject: string;
  text: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  /** Raw Authentication-Results header added by the receiving mail server. */
  authenticationResults?: string;
  /** Explicit verdicts, when the provider reports them as fields. */
  dmarc?: string;
  dkim?: string;
  spf?: string;
}

const domainOf = (address: string) => address.split("@")[1]?.toLowerCase() ?? "";

/**
 * Email identity is only as good as sender authentication. DMARC pass (or a DKIM signature aligned with the
 * From domain) means the domain vouches for the message; anything else could be spoofed.
 */
export function verifyEmailSender(mail: InboundEmail): { verified: boolean; detail: string } {
  const results = (mail.authenticationResults ?? "").toLowerCase();
  const fromDomain = domainOf(mail.from);
  const dmarc = mail.dmarc?.toLowerCase() ?? /dmarc=(\w+)/.exec(results)?.[1];
  if (dmarc === "pass") return { verified: true, detail: "Email with DMARC pass" };
  const dkimDomains = [...results.matchAll(/dkim=pass[^;]*?header\.d=([a-z0-9.-]+)/g)].map((m) => m[1]);
  if (dkimDomains.some((d) => d === fromDomain || fromDomain.endsWith(`.${d}`))) {
    return { verified: true, detail: "Email with a DKIM signature aligned to the sender's domain" };
  }
  if (mail.dkim?.toLowerCase() === "pass" && mail.spf?.toLowerCase() === "pass" && !results) {
    return { verified: false, detail: "Email with SPF and DKIM pass but no alignment information" };
  }
  return { verified: false, detail: dmarc ? `Email with DMARC ${dmarc}` : "Email without sender authentication results" };
}

/** Drops quoted history and signatures' reply chains so the ticket shows only what the person just wrote. */
export function stripQuotedReply(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^On .+wrote:$/i.test(trimmed) || /^-{2,}\s*Original Message/i.test(trimmed) || /^_{5,}$/.test(trimmed)) break;
    if (out.length && /^From:\s/i.test(trimmed)) break;
    if (trimmed.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim() || text.trim();
}

/** "[#1004]" or "[Haley #1004]" in a subject threads the email onto that ticket. */
export function ticketNumberFromSubject(subject: string): number | undefined {
  const match = /\[(?:haley\s*)?#(\d+)\]/i.exec(subject);
  return match ? Number(match[1]) : undefined;
}

/** The first message id in a reply chain identifies the conversation. */
export function conversationRoot(mail: InboundEmail): string | undefined {
  const first = (mail.references ?? "").split(/\s+/).find(Boolean);
  return first ?? mail.inReplyTo ?? undefined;
}

type Transport = { sendMail(options: Record<string, unknown>): Promise<unknown> };

export class EmailAdapter implements ChannelAdapter {
  readonly channel = "email" as const;
  readonly supportsPrivate = false;
  private readonly transport: Transport;

  constructor(smtpUrlOrTransport: string | Transport, private readonly from: string) {
    this.transport = typeof smtpUrlOrTransport === "string" ? createTransport(smtpUrlOrTransport) : smtpUrlOrTransport;
  }

  async send(ticket: Ticket, text: string): Promise<DeliveryResult> {
    if (!ticket.requester_email) return { delivered: false, detail: "The requester has no email address." };
    const root = ticket.channel_ref.messageId;
    await this.transport.sendMail({
      from: this.from,
      to: ticket.requester_name ? `"${ticket.requester_name.replace(/"/g, "")}" <${ticket.requester_email}>` : ticket.requester_email,
      subject: `Re: [#${ticket.number}] ${ticket.title}`,
      text,
      ...(root ? { inReplyTo: root, references: root } : {}),
    });
    return { delivered: true, detail: `Emailed ${ticket.requester_email}` };
  }
}
