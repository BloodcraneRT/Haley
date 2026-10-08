import type { Store } from "../store.js";
import type { Action, ApprovalDecision, Org, Technician } from "../types.js";
import type { ApprovalCard, ApprovalChannel, EscalationNotice } from "./notify.js";

type Json = Record<string, any>;

/** Workspace secret holding the bot token of the Haley Slack app installed in the MSP's own workspace. */
export const SLACK_TOKEN_SECRET = "slack_bot_token";

const ACTION_IDS = { approve: "haley_approve", reject: "haley_reject", changes: "haley_changes" } as const;
const MODAL_CALLBACK = "haley_decide";

/** Slack mrkdwn: escape the three control characters so ticket text can't mention @channel or forge links. */
export const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class SlackApiError extends Error {}

/** What deciding an action needs from the agent; thrown errors carry the message shown to the technician. */
export type DecideFn = (actionId: string, decision: ApprovalDecision, technician: string, note: string) => Promise<Action>;

const RISK_LABEL: Record<string, string> = { read: "Read", internal: "Internal", write: "Change", destructive: "Sensitive change" };

function decidedLine(a: ApprovalCard["action"]): string | null {
  const who = a.decided_by === "system" ? "Haley" : esc(a.decided_by ?? "someone");
  const note = a.decision_note ? ` — “${esc(clip(a.decision_note, 300))}”` : "";
  switch (a.status) {
    case "pending_approval":
      return null;
    case "approved":
    case "executed":
      return `:white_check_mark: *Approved* by ${who}${note}`;
    case "failed":
      return `:warning: Approved by ${who}, but the change failed${note}`;
    case "changes_requested":
      return `:leftwards_arrow_with_hook: *Changes requested* by ${who}${note}`;
    case "blocked":
      return `:no_entry: Blocked by current policy after approval`;
    default:
      return a.decided_by === "system" ? ":heavy_minus_sign: No longer needed: the run ended" : `:x: *Rejected* by ${who}${note}`;
  }
}

/** The Block Kit card for an approval: what, why, what Haley looked at, and the buttons while it's pending. */
export function approvalBlocks(card: ApprovalCard): Json[] {
  const a = card.action;
  const where = card.ticket ? `<${card.url ?? ""}|#${card.ticket.number} ${esc(clip(card.ticket.title, 120))}>` : esc(card.runTitle);
  const ticketLine = card.ticket
    ? `${card.url ? where : `#${card.ticket.number} ${esc(clip(card.ticket.title, 120))}`} · ${esc(card.ticket.requester)} (${card.ticket.identity})`
    : esc(card.runTitle);
  const blocks: Json[] = [
    { type: "section", text: { type: "mrkdwn", text: `*Approval needed* · ${esc(card.orgName)}\n${ticketLine}` } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Change*\n${esc(clip(a.description, 400))}` },
        { type: "mrkdwn", text: `*Risk*\n${RISK_LABEL[a.risk] ?? a.risk}` },
      ],
    },
  ];
  const why = [`*Why approval:* ${esc(clip(a.policy_reason || "Client policy", 400))}`];
  if (a.rationale) why.push(`*Haley's reasoning:* ${esc(clip(a.rationale, 600))}`);
  blocks.push({ type: "section", text: { type: "mrkdwn", text: why.join("\n") } });
  if (card.evidence.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*She checked*\n${card.evidence.map((e) => `• ${esc(clip(e, 160))}`).join("\n")}` } });
  }
  const decided = decidedLine(a);
  if (decided) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: decided }] });
    return blocks;
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: a.approvers.length ? `Only ${esc(a.approvers.join(", "))} can decide (client policy).` : "Any technician can decide." }],
  });
  const buttons: Json[] = card.decidableInChat
    ? [
        { type: "button", action_id: ACTION_IDS.approve, value: a.id, style: "primary", text: { type: "plain_text", text: "Approve" } },
        { type: "button", action_id: ACTION_IDS.reject, value: a.id, text: { type: "plain_text", text: "Reject…" } },
        { type: "button", action_id: ACTION_IDS.changes, value: a.id, text: { type: "plain_text", text: "Ask for changes…" } },
      ]
    : [];
  if (card.url) buttons.push({ type: "button", action_id: "haley_open", url: card.url, text: { type: "plain_text", text: card.decidableInChat ? "Open in Haley" : "Approve in Haley" } });
  if (!card.decidableInChat) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Changes this sensitive are approved in the Haley dashboard (workspace setting)." }] });
  }
  if (buttons.length) blocks.push({ type: "actions", block_id: "haley_approval", elements: buttons });
  return blocks;
}

const fallbackText = (card: ApprovalCard) =>
  `${decidedLine(card.action) ? "Approval decided" : "Approval needed"} for ${card.orgName}: ${card.action.description}`;

/**
 * Approval cards in the MSP's own Slack workspace, through the same Slack app clients use (installed once more
 * in the MSP's workspace, with its bot token saved on the Approvals settings). Button clicks arrive at
 * /hooks/slack/interactivity, signed like events.
 */
export class SlackApprovals implements ApprovalChannel {
  readonly channel = "slack" as const;

  constructor(
    private readonly store: Store,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private token(): string | null {
    return this.store.getWorkspaceSecret(SLACK_TOKEN_SECRET);
  }

  async call(method: string, body: Json, token = this.token()): Promise<Json> {
    if (!token) throw new SlackApiError("Slack isn't connected for approvals.");
    const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || !data.ok) throw new SlackApiError(`Slack ${method} failed: ${data.error ?? res.status}`);
    return data;
  }

  /** Checks a bot token and returns its workspace, for the settings page. */
  async identify(token: string): Promise<{ teamId: string; team: string }> {
    const data = await this.call("auth.test", {}, token);
    return { teamId: String(data.team_id), team: String(data.team ?? "") };
  }

  private destination(org: Org): string | null {
    if (!this.token()) return null;
    return org.settings.approvalSlackChannel || this.store.getApprovalSettings().slackChannel || null;
  }

  async postApproval(card: ApprovalCard, org: Org): Promise<Record<string, string> | null> {
    const channel = this.destination(org);
    if (!channel) return null;
    const data = await this.call("chat.postMessage", { channel, text: fallbackText(card), blocks: approvalBlocks(card), unfurl_links: false });
    return { channel: String(data.channel), ts: String(data.ts) };
  }

  async updateApproval(ref: Record<string, string>, card: ApprovalCard): Promise<void> {
    await this.call("chat.update", { channel: ref.channel, ts: ref.ts, text: fallbackText(card), blocks: approvalBlocks(card) });
  }

  async postEscalation(notice: EscalationNotice, org: Org): Promise<Record<string, string> | null> {
    const channel = this.destination(org);
    if (!channel) return null;
    const title = `#${notice.ticket.number} ${esc(clip(notice.ticket.title, 120))}`;
    const text = `:rotating_light: *Escalated to a technician* · ${esc(notice.orgName)}\n${notice.url ? `<${notice.url}|${title}>` : title} · ${esc(notice.ticket.requester)}\n>${esc(clip(notice.reason, 600)).replace(/\n/g, "\n>")}`;
    const data = await this.call("chat.postMessage", {
      channel,
      text: `Escalated: ${notice.orgName} #${notice.ticket.number} ${notice.ticket.title}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      unfurl_links: false,
    });
    return { channel: String(data.channel), ts: String(data.ts) };
  }

  /** Posts a test message to a channel, for the settings page. */
  async test(channel: string): Promise<void> {
    await this.call("chat.postMessage", { channel, text: "Haley will post approval cards here. Technicians in the Haley directory can approve, reject or ask for changes from the card." });
  }

  /**
   * The directory technician behind a Slack user: by linked Slack id, else by the email on their Slack
   * profile (which links them for next time). Null when they aren't in the directory.
   */
  async technicianFor(slackUserId: string): Promise<Technician | null> {
    const linked = this.store.findTechnician({ slackUserId });
    if (linked) return linked;
    const info = await this.call("users.info", { user: slackUserId }).catch(() => null);
    const email = info?.user?.profile?.email as string | undefined;
    if (!email || info?.user?.is_restricted || info?.user?.is_bot) return null;
    const tech = this.store.findTechnician({ email });
    if (!tech || tech.slack_user_id) return null;
    const updated = this.store.updateTechnician(tech.id, { slackUserId });
    this.store.audit({ actor: tech.name, action: "technician.linked", target: tech.id, detail: { slack: slackUserId } });
    return updated;
  }

  /**
   * Handles an interactivity payload. Button clicks are acknowledged straight away and finished in the
   * background (errors come back as a private message); modal submissions return Slack's response body.
   */
  async interact(payload: Json, decide: DecideFn): Promise<{ body: Json | null; background?: Promise<void> }> {
    const settings = this.store.getApprovalSettings();
    // Only the MSP's own workspace can decide; client workspaces use the same app for end-user chat.
    if (!settings.slackTeamId || payload.team?.id !== settings.slackTeamId) return { body: null };
    const userId = String(payload.user?.id ?? "");

    if (payload.type === "block_actions") {
      const button = (payload.actions ?? [])[0] as Json | undefined;
      const decision = (Object.entries(ACTION_IDS).find(([, id]) => id === button?.action_id)?.[0] ?? null) as ApprovalDecision | null;
      if (!button || !decision) return { body: null };
      const actionId = String(button.value ?? "");
      const respond = (text: string) =>
        payload.response_url
          ? this.fetchImpl(String(payload.response_url), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
            }).then(() => undefined)
          : Promise.resolve();
      const background = (async () => {
        try {
          const tech = await this.technicianFor(userId);
          if (!tech) return await respond("You're not set up as a technician in Haley, so you can't decide approvals here. Ask an admin to add you (with your work email) on the Technicians page.");
          const problem = this.chatProblem(actionId);
          if (problem) return await respond(problem);
          if (decision === "approve") {
            await decide(actionId, "approve", tech.name, "");
            return;
          }
          await this.call("views.open", { trigger_id: payload.trigger_id, view: this.modal(actionId, decision) });
        } catch (err) {
          await respond(err instanceof Error ? err.message : String(err)).catch(() => undefined);
        }
      })();
      return { body: null, background };
    }

    if (payload.type === "view_submission" && payload.view?.callback_id === MODAL_CALLBACK) {
      let meta: { actionId?: string; decision?: ApprovalDecision } = {};
      try {
        meta = JSON.parse(String(payload.view.private_metadata ?? "{}"));
      } catch {
        // Treated as missing below.
      }
      const note = String(payload.view.state?.values?.note?.value?.value ?? "").trim();
      const fail = (message: string) => ({ body: { response_action: "errors", errors: { note: message } } });
      if (!meta.actionId || (meta.decision !== "reject" && meta.decision !== "changes")) return fail("This form is out of date. Use the card again.");
      if (meta.decision === "changes" && note.length < 3) return fail("Say what should change.");
      const tech = await this.technicianFor(userId);
      if (!tech) return fail("You're not set up as a technician in Haley.");
      const problem = this.chatProblem(meta.actionId);
      if (problem) return fail(problem);
      try {
        await decide(meta.actionId, meta.decision, tech.name, note);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      return { body: null };
    }
    return { body: null };
  }

  /** Why this action can't be decided from chat right now, or null. */
  private chatProblem(actionId: string): string | null {
    const action = this.store.getAction(actionId);
    if (!action) return "That approval no longer exists.";
    if (action.status !== "pending_approval") return `Already decided${action.decided_by ? ` by ${action.decided_by}` : ""}.`;
    const max = this.store.getApprovalSettings().chatApprovalMaxRisk;
    if (action.risk === "destructive" && max === "write") return "Changes this sensitive are approved in the Haley dashboard.";
    return null;
  }

  private modal(actionId: string, decision: "reject" | "changes"): Json {
    const action = this.store.getAction(actionId);
    const changes = decision === "changes";
    return {
      type: "modal",
      callback_id: MODAL_CALLBACK,
      private_metadata: JSON.stringify({ actionId, decision }),
      title: { type: "plain_text", text: changes ? "Ask for changes" : "Reject change" },
      submit: { type: "plain_text", text: changes ? "Send to Haley" : "Reject" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: esc(clip(action?.description ?? "", 400)) } },
        {
          type: "input",
          block_id: "note",
          optional: !changes,
          label: { type: "plain_text", text: changes ? "What should change?" : "Reason (optional)" },
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: true,
            max_length: 1000,
            placeholder: { type: "plain_text", text: changes ? "e.g. Use the E3 licence, not E5" : "Recorded in the audit log and told to Haley" },
          },
        },
      ],
    };
  }
}
