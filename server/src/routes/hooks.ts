import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ChannelConfig } from "../config.js";
import { verifyChatSignature } from "../channels/chat.js";
import { conversationRoot, stripQuotedReply, ticketNumberFromSubject, verifyEmailSender } from "../channels/email.js";
import type { ChannelHub } from "../channels/hub.js";
import { verifySlackSignature, type SlackChannel } from "../channels/slack.js";
import type { TeamsChannel } from "../channels/teams.js";
import type { Store } from "../store.js";
import type { IncomingFile } from "../attachments.js";

export const rawBody = (req: FastifyRequest) => (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";

const header = (req: FastifyRequest, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function secretMatches(expected: string, got: string | undefined): boolean {
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Files posted with an email or chat message: base64 content, as relays and bridges send it. */
const attachmentInput = z
  .array(
    z.object({
      filename: z.string().max(300).default("attachment"),
      contentType: z.string().max(200).default("application/octet-stream"),
      content: z.string().max(20 * 1024 * 1024),
    }),
  )
  .max(20)
  .default([]);

const toFiles = (items: z.infer<typeof attachmentInput>): IncomingFile[] =>
  items.map((a) => ({ filename: a.filename, contentType: a.contentType, data: Buffer.from(a.content, "base64") })).filter((f) => f.data.length > 0);

/** Messages with attachments can be large; only these two webhooks accept bodies this big. */
const ATTACHMENT_BODY_LIMIT = 25 * 1024 * 1024;

const emailSchema = z.object({
  from: z.string().email(),
  fromName: z.string().default(""),
  subject: z.string().default("(no subject)"),
  text: z.string().default(""),
  messageId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.string().optional(),
  authenticationResults: z.string().optional(),
  dmarc: z.string().optional(),
  dkim: z.string().optional(),
  spf: z.string().optional(),
  attachments: attachmentInput,
});

const chatSchema = z.object({
  orgId: z.string().optional(),
  threadId: z.string().min(1),
  user: z.object({
    email: z.string().email(),
    name: z.string().default(""),
    /** The bridge vouches that it authenticated this user (e.g. signed-in portal, verified phone). */
    verified: z.boolean().default(false),
    verification: z.string().default(""),
  }),
  text: z.string().trim().default(""),
  attachments: attachmentInput,
  callbackUrl: z.string().url().optional(),
  /** The bridge can show a message to this user alone, so credentials may be sent to them. */
  private: z.boolean().default(false),
});

export interface HookDeps {
  config: ChannelConfig;
  store: Store;
  hub: ChannelHub;
  slack: SlackChannel | null;
  teams: TeamsChannel | null;
  log: (err: unknown) => void;
  /** Handles approval-card invokes and "approvals here" before end-user handling; null passes the activity on. */
  teamsIntercept?: (activity: Record<string, any>) => Promise<{ status: number; body?: unknown } | null>;
}

/**
 * Public webhooks for end-user channels. They sit outside /api (no technician token) and each one
 * authenticates its caller its own way: shared secret, Slack signature, Bot Framework JWT, or HMAC.
 */
export function registerHooks(app: FastifyInstance, deps: HookDeps) {
  const { config, store, hub, log } = deps;

  app.post("/hooks/email", { bodyLimit: ATTACHMENT_BODY_LIMIT }, async (req, reply) => {
    const key = header(req, "x-haley-hook-secret") ?? (req.query as Record<string, string>)?.key;
    if (!secretMatches(config.emailHookSecret, key)) return reply.status(401).send({ error: "Unauthorized" });
    const parsed = emailSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: z.prettifyError(parsed.error) });
    const mail = parsed.data;
    const org = store.findOrgByEmailDomain(mail.from);
    if (!org) return reply.status(422).send({ error: `No organization matches ${mail.from.split("@")[1]}.` });
    const identity = verifyEmailSender(mail);
    const root = conversationRoot(mail);
    const result = await hub.receive({
      channel: "email",
      org,
      sender: {
        name: mail.fromName,
        email: mail.from.toLowerCase(),
        assurance: identity.verified ? "email" : "none",
        verification: identity.detail,
      },
      subject: mail.subject.replace(/^(re|fw|fwd):\s*/i, "").replace(/\[(?:haley\s*)?#\d+\]\s*/i, ""),
      text: stripQuotedReply(mail.text),
      ticketNumber: ticketNumberFromSubject(mail.subject),
      thread: root ? { key: "messageId", value: root } : null,
      ref: mail.messageId ? { messageId: mail.messageId } : {},
      attachments: toFiles(mail.attachments),
    });
    return result;
  });

  app.post("/hooks/slack/events", async (req, reply) => {
    if (!deps.slack) return reply.status(404).send({ error: "Slack is not configured" });
    const ok = verifySlackSignature(
      config.slackSigningSecret,
      header(req, "x-slack-request-timestamp"),
      header(req, "x-slack-signature"),
      rawBody(req),
    );
    if (!ok) return reply.status(401).send({ error: "Bad signature" });
    const payload = req.body as Record<string, unknown>;
    if (payload.type === "url_verification") return { challenge: payload.challenge };
    // Slack wants a response within 3 seconds; do the work after acknowledging.
    void (async () => {
      const inbound = await deps.slack!.toInbound(payload);
      if (inbound) await hub.receive(inbound);
    })().catch(log);
    return { ok: true };
  });

  app.post("/hooks/teams/messages", async (req, reply) => {
    if (!deps.teams) return reply.status(404).send({ error: "Teams is not configured" });
    const activity = req.body as Record<string, any>;
    try {
      await deps.teams.verify(header(req, "authorization"), activity);
    } catch (err) {
      return reply.status(401).send({ error: err instanceof Error ? err.message : "Unauthorized" });
    }
    const intercepted = deps.teamsIntercept ? await deps.teamsIntercept(activity) : null;
    if (intercepted) return reply.status(intercepted.status).send(intercepted.body ?? "");
    void (async () => {
      const inbound = await deps.teams!.toInbound(activity);
      if (inbound) await hub.receive(inbound);
    })().catch(log);
    return reply.status(202).send();
  });

  app.post("/hooks/chat", { bodyLimit: ATTACHMENT_BODY_LIMIT }, async (req, reply) => {
    if (!verifyChatSignature(config.chatWebhookSecret, header(req, "x-haley-signature"), rawBody(req))) {
      return reply.status(401).send({ error: "Bad signature" });
    }
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: z.prettifyError(parsed.error) });
    const msg = parsed.data;
    if (!msg.text && !msg.attachments.length) return reply.status(400).send({ error: "Send text or at least one attachment." });
    const org = msg.orgId ? store.getOrg(msg.orgId) : store.findOrgByEmailDomain(msg.user.email);
    if (!org) return reply.status(422).send({ error: "No organization matches this user." });
    return hub.receive({
      channel: "chat",
      org,
      sender: {
        name: msg.user.name,
        email: msg.user.email.toLowerCase(),
        assurance: msg.user.verified ? "chat" : "none",
        verification: msg.user.verification || (msg.user.verified ? "Verified by the chat bridge" : "Unverified chat user"),
      },
      text: msg.text,
      thread: { key: "threadId", value: msg.threadId },
      ref: { threadId: msg.threadId, callbackUrl: msg.callbackUrl ?? "", private: msg.private ? "1" : "0" },
      attachments: toFiles(msg.attachments),
    });
  });
}
