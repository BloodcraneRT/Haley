import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentService } from "../agent/runner.js";
import { SLACK_TOKEN_SECRET, type SlackApprovals } from "../approvals/slack.js";
import { verifySlackSignature } from "../channels/slack.js";
import type { Store } from "../store.js";
import type { ApprovalSettings } from "../types.js";

class ApprovalRouteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const header = (req: FastifyRequest, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const channelId = z.union([z.literal(""), z.string().trim().regex(/^[CG][A-Z0-9]{2,20}$/, "Slack channel ids look like C0123ABCD")]);

/**
 * Approval cards in the MSP's Slack (and Teams): where they go, the bot token, and Slack's interactivity
 * endpoint for the card buttons.
 */
export function registerApprovalRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    agent: AgentService;
    slack: SlackApprovals;
    slackSigningSecret: string;
    teamsEnabled: boolean;
    /** HALEY_TEAMS_TENANT_ID, used as the MSP tenant when none is set. */
    teamsDefaultTenantId: string;
    publicUrl: string;
    actor: (req: FastifyRequest) => string;
    log: (err: unknown) => void;
  },
): void {
  const { store, slack } = deps;
  const base = deps.publicUrl.replace(/\/+$/, "");

  const view = (settings: ApprovalSettings = store.getApprovalSettings()) => ({
    ...settings,
    slackConnected: Boolean(store.getWorkspaceSecret(SLACK_TOKEN_SECRET)),
    /** Slack needs HALEY_SLACK_SIGNING_SECRET to verify button clicks. */
    slackAvailable: Boolean(deps.slackSigningSecret),
    teamsAvailable: deps.teamsEnabled,
    teamsDefaultTenantId: deps.teamsDefaultTenantId,
    interactivityUrl: base ? `${base}/hooks/slack/interactivity` : "/hooks/slack/interactivity",
  });

  app.get("/api/approvals/settings", async () => view());

  app.put("/api/approvals/settings", async (req) => {
    const parsed = z
      .object({
        slackBotToken: z.string().trim().regex(/^xoxb-[A-Za-z0-9-]+$/, "Use the bot token (xoxb-…)").nullable().optional(),
        slackChannel: channelId.optional(),
        chatApprovalMaxRisk: z.enum(["write", "destructive"]).optional(),
        escalationNotices: z.boolean().optional(),
        mspTenantId: z.union([z.literal(""), z.string().trim().toLowerCase().uuid("The tenant id is a GUID")]).optional(),
        /** Only clearing is allowed here; a Teams conversation is registered from Teams. */
        teamsConversation: z.null().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw new ApprovalRouteError(400, z.prettifyError(parsed.error));
    const { slackBotToken, ...patch } = parsed.data;
    const before = store.getApprovalSettings();
    const next: Partial<ApprovalSettings> = { ...patch };
    if (slackBotToken) {
      let team;
      try {
        team = await slack.identify(slackBotToken);
      } catch (err) {
        throw new ApprovalRouteError(400, `Slack didn't accept that token: ${err instanceof Error ? err.message : String(err)}`);
      }
      store.setWorkspaceSecret(SLACK_TOKEN_SECRET, slackBotToken);
      next.slackTeamId = team.teamId;
    } else if (slackBotToken === null) {
      store.setWorkspaceSecret(SLACK_TOKEN_SECRET, null);
      next.slackTeamId = "";
    }
    const saved = store.setApprovalSettings(next);
    store.audit({
      actor: deps.actor(req),
      action: "approvals.settings_changed",
      target: "approvals",
      detail: {
        fields: Object.keys(parsed.data),
        slackToken: slackBotToken ? "set" : slackBotToken === null ? "removed" : "unchanged",
        from: { slackChannel: before.slackChannel, chatApprovalMaxRisk: before.chatApprovalMaxRisk, escalationNotices: before.escalationNotices },
        to: { slackChannel: saved.slackChannel, chatApprovalMaxRisk: saved.chatApprovalMaxRisk, escalationNotices: saved.escalationNotices },
      },
    });
    return view(saved);
  });

  /** Posts a test message to the default channel, or a client's override, so setup problems show up now. */
  app.post("/api/approvals/test", async (req) => {
    const { orgId } = z.object({ orgId: z.string().optional() }).parse(req.body ?? {});
    const org = orgId ? store.getOrg(orgId) : null;
    const channel = org?.settings.approvalSlackChannel || store.getApprovalSettings().slackChannel;
    if (!channel) throw new ApprovalRouteError(400, "Choose a Slack channel first.");
    try {
      await slack.test(channel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = /not_in_channel|channel_not_found/.test(message) ? " Invite the Haley app to the channel (/invite @Haley) and try again." : "";
      throw new ApprovalRouteError(400, `${message}.${hint}`);
    }
    return { ok: true, channel };
  });

  // Slack sends button clicks and modal submissions as a form with one "payload" field, signed over the raw body.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 256 * 1024 }, (req, body, done) => {
      (req as typeof req & { rawBody?: string }).rawBody = body as string;
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    scope.post("/hooks/slack/interactivity", async (req, reply) => {
      if (!deps.slackSigningSecret) return reply.status(404).send({ error: "Slack is not configured" });
      const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
      if (!verifySlackSignature(deps.slackSigningSecret, header(req, "x-slack-request-timestamp"), header(req, "x-slack-signature"), raw)) {
        return reply.status(401).send({ error: "Bad signature" });
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String((req.body as Record<string, string>)?.payload ?? ""));
      } catch {
        return reply.status(400).send({ error: "Missing payload" });
      }
      const result = await slack.interact(payload, (id, decision, technician, note) => deps.agent.decideAction(id, decision, technician, note));
      result.background?.catch(deps.log);
      return reply.status(200).send(result.body ?? "");
    });
  });
}
