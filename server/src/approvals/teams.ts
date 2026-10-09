import type { TeamsChannel } from "../channels/teams.js";
import type { Store } from "../store.js";
import type { ApprovalDecision, Org, Technician } from "../types.js";
import { DirectMessageUnavailable, type ApprovalCard, type ApprovalChannel, type EscalationNotice } from "./notify.js";
import type { DecideFn } from "./slack.js";

type Json = Record<string, any>;

const CARD = "application/vnd.microsoft.card.adaptive";
const REGISTER = /\bapprovals\s+here\b/i;
const VERBS: Record<string, ApprovalDecision> = { approve: "approve", reject: "reject", changes: "changes" };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** Adaptive Card text renders a little Markdown; break link syntax so ticket text can't plant a clickable link. */
export const plain = (text: string) => text.replace(/\]\s*\(/g, "]​(").replace(/<[^>]*>/g, "");

const RISK_LABEL: Record<string, string> = { read: "Read", internal: "Internal", write: "Change", destructive: "Sensitive change" };

function decidedText(a: ApprovalCard["action"]): string | null {
  const who = a.decided_by === "system" ? "Haley" : plain(a.decided_by ?? "someone");
  const note = a.decision_note ? `: “${plain(clip(a.decision_note, 300))}”` : "";
  switch (a.status) {
    case "pending_approval":
      return null;
    case "approved":
    case "executed":
      return `✅ Approved by ${who}${note}`;
    case "failed":
      return `⚠️ Approved by ${who}, but the change failed${note}`;
    case "changes_requested":
      return `↩️ Changes requested by ${who}${note}`;
    case "blocked":
      return "⛔ Blocked by current policy after approval";
    default:
      return a.decided_by === "system" ? "No longer needed: the run ended" : `❌ Rejected by ${who}${note}`;
  }
}

/** The Adaptive Card (Universal Actions) for an approval. */
export function approvalCard(card: ApprovalCard): Json {
  const a = card.action;
  const t = card.ticket;
  const body: Json[] = [
    { type: "TextBlock", text: `Approval needed · ${plain(card.orgName)}`, weight: "Bolder", size: "Medium", wrap: true },
    {
      type: "TextBlock",
      text: t ? `#${t.number} ${plain(clip(t.title, 120))} · ${plain(t.requester)} (${t.identity})` : plain(card.runTitle),
      isSubtle: true,
      wrap: true,
    },
    {
      type: "FactSet",
      facts: [
        { title: "Change", value: plain(clip(a.description, 400)) },
        { title: "Risk", value: RISK_LABEL[a.risk] ?? a.risk },
        { title: "Why approval", value: plain(clip(a.policy_reason || "Client policy", 400)) },
      ],
    },
  ];
  if (a.rationale) body.push({ type: "TextBlock", text: `Haley's reasoning: ${plain(clip(a.rationale, 600))}`, wrap: true });
  if (card.evidence.length) {
    body.push({ type: "TextBlock", text: "She checked", weight: "Bolder", spacing: "Medium" });
    body.push({ type: "TextBlock", text: card.evidence.map((e) => `- ${plain(clip(e, 160))}`).join("\n"), wrap: true });
  }
  const decided = decidedText(a);
  const open = card.url ? [{ type: "Action.OpenUrl", title: card.decidableInChat || decided ? "Open in Haley" : "Approve in Haley", url: card.url }] : [];
  if (decided) {
    body.push({ type: "TextBlock", text: decided, weight: "Bolder", wrap: true, spacing: "Medium" });
    return { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4", body, actions: open };
  }
  body.push({ type: "TextBlock", text: a.approvers.length ? `Only ${plain(a.approvers.join(", "))} can decide (client policy).` : "Any technician can decide.", isSubtle: true, wrap: true });
  if (!card.decidableInChat) {
    body.push({ type: "TextBlock", text: "Changes this sensitive are approved in the Haley dashboard (workspace setting).", isSubtle: true, wrap: true });
    return { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4", body, actions: open };
  }
  body.push({ type: "Input.Text", id: "note", isMultiline: true, maxLength: 1000, placeholder: "Note for Haley and the audit log (needed to ask for changes)" });
  const execute = (verb: string, title: string, style?: string) => ({ type: "Action.Execute", verb, title, data: { actionId: a.id }, ...(style ? { style } : {}) });
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
    actions: [execute("approve", "Approve", "positive"), execute("reject", "Reject"), execute("changes", "Ask for changes"), ...open],
  };
}

const message = (text: string) => ({ statusCode: 200, type: "application/vnd.microsoft.activity.message", value: text });

/**
 * Approval cards in the MSP's own Microsoft Teams, through the Haley bot. A technician registers the channel
 * by posting "@Haley approvals here"; card buttons arrive as signed `adaptiveCard/action` invokes on the bot's
 * messages endpoint and are answered with the refreshed card.
 */
export class TeamsApprovals implements ApprovalChannel {
  readonly channel = "teams" as const;

  constructor(
    private readonly store: Store,
    private readonly teams: TeamsChannel,
    /** HALEY_TEAMS_TENANT_ID: the bot's home tenant, used when no MSP tenant is set. */
    private readonly defaultTenantId: string,
  ) {}

  configured(_org: Org): boolean {
    return this.store.getApprovalSettings().teamsConversation !== null;
  }

  private mspTenant(): string {
    return (this.store.getApprovalSettings().mspTenantId || this.defaultTenantId).toLowerCase();
  }

  private activityUrl(serviceUrl: string, conversationId: string, activityId?: string): string {
    const base = `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
    return activityId ? `${base}/${encodeURIComponent(activityId)}` : base;
  }

  async postApproval(card: ApprovalCard, _org: Org): Promise<Record<string, string> | null> {
    const to = this.store.getApprovalSettings().teamsConversation;
    if (!to) return null;
    const res = await this.teams.botRequest("POST", this.activityUrl(to.serviceUrl, to.conversationId), {
      type: "message",
      attachments: [{ contentType: CARD, content: approvalCard(card) }],
    });
    return { serviceUrl: to.serviceUrl, conversationId: to.conversationId, activityId: String(res.id ?? "") };
  }

  /**
   * The card in the technician's 1:1 chat with the bot, on the same Teams service as the approvals channel.
   * Teams refuses (403/404) unless they have the Haley app installed.
   */
  async postDirect(card: ApprovalCard, technician: Technician): Promise<Record<string, string> | null> {
    const to = this.store.getApprovalSettings().teamsConversation;
    if (!to || !technician.teams_aad_id) return null;
    let conversationId: string;
    try {
      conversationId = await this.teams.personalConversation(to.serviceUrl, to.tenantId || this.mspTenant(), technician.teams_aad_id);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) throw new DirectMessageUnavailable(`${technician.name} doesn't have the Haley app in Teams`);
      throw err;
    }
    const res = await this.teams.botRequest("POST", this.activityUrl(to.serviceUrl, conversationId), {
      type: "message",
      attachments: [{ contentType: CARD, content: approvalCard(card) }],
    });
    return { serviceUrl: to.serviceUrl, conversationId, activityId: String(res.id ?? "") };
  }

  async postReminder(ref: Record<string, string>, text: string): Promise<void> {
    if (!ref.activityId) return;
    // Posting to an activity's URL makes the message a reply to it.
    await this.teams.botRequest("POST", this.activityUrl(ref.serviceUrl, ref.conversationId, ref.activityId), { type: "message", text });
  }

  async updateApproval(ref: Record<string, string>, card: ApprovalCard): Promise<void> {
    if (!ref.activityId) return;
    await this.teams.botRequest("PUT", this.activityUrl(ref.serviceUrl, ref.conversationId, ref.activityId), {
      type: "message",
      id: ref.activityId,
      attachments: [{ contentType: CARD, content: approvalCard(card) }],
    });
  }

  async postEscalation(notice: EscalationNotice, _org: Org): Promise<Record<string, string> | null> {
    const to = this.store.getApprovalSettings().teamsConversation;
    if (!to) return null;
    const content = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        { type: "TextBlock", text: `🚨 Escalated to a technician · ${plain(notice.orgName)}`, weight: "Bolder", wrap: true },
        { type: "TextBlock", text: `#${notice.ticket.number} ${plain(clip(notice.ticket.title, 120))} · ${plain(notice.ticket.requester)}`, isSubtle: true, wrap: true },
        ...(notice.care.length ? [{ type: "TextBlock", text: `⚠️ ${plain(notice.care.join(" · "))}`, wrap: true, color: "Warning" }] : []),
        ...(notice.suggested
          ? [{ type: "TextBlock", text: `${notice.suggested.assigned ? "Assigned to" : "Suggested:"} ${plain(notice.suggested.name)} (${plain(notice.suggested.reasons.join(", "))})`, wrap: true }]
          : []),
        { type: "TextBlock", text: plain(clip(notice.reason, 600)), wrap: true },
      ],
      actions: notice.url ? [{ type: "Action.OpenUrl", title: "Open in Haley", url: notice.url }] : [],
    };
    const res = await this.teams.botRequest("POST", this.activityUrl(to.serviceUrl, to.conversationId), { type: "message", attachments: [{ contentType: CARD, content }] });
    return { serviceUrl: to.serviceUrl, conversationId: to.conversationId, activityId: String(res.id ?? "") };
  }

  /** The directory technician who sent this activity, by linked Entra id or by the email Teams reports (then linked). */
  private async technicianFor(activity: Json): Promise<Technician | null> {
    const aad = String(activity.from?.aadObjectId ?? "");
    if (aad) {
      const linked = this.store.findTechnician({ teamsAadId: aad });
      if (linked) return linked;
    }
    const member = await this.teams.member(String(activity.serviceUrl ?? ""), String(activity.conversation?.id ?? ""), String(activity.from?.id ?? ""));
    if (!member?.email) return null;
    const tech = this.store.findTechnician({ email: member.email });
    const objectId = (aad || member.aadObjectId || "").toLowerCase();
    // Without an Entra id the sender can't be tied to one account; a technician already linked to another id isn't them.
    if (!tech || !objectId) return null;
    if (tech.teams_aad_id) return tech.teams_aad_id === objectId ? tech : null;
    const updated = this.store.updateTechnician(tech.id, { teamsAadId: objectId });
    this.store.audit({ actor: tech.name, action: "technician.linked", target: tech.id, detail: { teams: objectId } });
    return updated;
  }

  private fromMspTenant(activity: Json): boolean {
    const tenant = String(activity.conversation?.tenantId ?? activity.channelData?.tenant?.id ?? "").toLowerCase();
    const msp = this.mspTenant();
    return Boolean(msp) && tenant === msp;
  }

  /**
   * Handles what the approvals feature owns on the Teams messages endpoint: card button invokes and the
   * "approvals here" registration. Returns null for anything else (end-user messages carry on as usual).
   */
  async intercept(
    activity: Json,
    deps: { decide: DecideFn; cardFor: (actionId: string) => ApprovalCard | null },
  ): Promise<{ status: number; body?: unknown } | null> {
    if (activity.type === "invoke" && activity.name === "adaptiveCard/action") {
      if (!this.fromMspTenant(activity)) return { status: 200, body: message("This card can only be used in the MSP's own Teams.") };
      const action = activity.value?.action ?? {};
      const decision = VERBS[String(action.verb ?? "")];
      const actionId = String(action.data?.actionId ?? "");
      const note = String(action.data?.note ?? "").trim();
      if (!decision || !actionId) return { status: 200, body: message("This card is out of date.") };
      const tech = await this.technicianFor(activity);
      if (!tech) return { status: 200, body: message("You're not set up as a technician in Haley, so you can't decide approvals here. Ask an admin to add you (with your work email) on the Technicians page.") };
      const current = this.store.getAction(actionId);
      if (!current) return { status: 200, body: message("That approval no longer exists.") };
      if (current.status !== "pending_approval") return { status: 200, body: message(`Already decided${current.decided_by ? ` by ${current.decided_by}` : ""}.`) };
      if (current.risk === "destructive" && this.store.getApprovalSettings().chatApprovalMaxRisk === "write") {
        return { status: 200, body: message("Changes this sensitive are approved in the Haley dashboard.") };
      }
      if (decision === "changes" && note.length < 3) return { status: 200, body: message("Type what should change in the note, then click Ask for changes.") };
      try {
        await deps.decide(actionId, decision, tech.name, note);
      } catch (err) {
        return { status: 200, body: message(err instanceof Error ? err.message : String(err)) };
      }
      const card = deps.cardFor(actionId);
      return { status: 200, body: card ? { statusCode: 200, type: CARD, value: approvalCard(card) } : message("Done.") };
    }

    if (activity.type === "message" && REGISTER.test(String(activity.text ?? "").replace(/<at>[^<]*<\/at>/g, ""))) {
      const conversationType = activity.conversation?.conversationType;
      // Only in the MSP's tenant, and only in a team channel or group chat (not a 1:1 with the bot).
      if (!this.fromMspTenant(activity) || conversationType === "personal") return null;
      const reply = (text: string) =>
        this.teams.botRequest("POST", this.activityUrl(String(activity.serviceUrl), String(activity.conversation.id)), { type: "message", text }).catch(() => undefined);
      const tech = await this.technicianFor(activity);
      if (!tech) {
        await reply("Only technicians in the Haley directory can choose where approvals go. Ask an admin to add you on the Technicians page.");
        return { status: 202 };
      }
      this.store.setApprovalSettings({
        teamsConversation: {
          serviceUrl: String(activity.serviceUrl),
          conversationId: String(activity.conversation.id),
          tenantId: String(activity.conversation?.tenantId ?? activity.channelData?.tenant?.id ?? ""),
          registeredBy: tech.name,
          registeredAt: new Date().toISOString(),
        },
      });
      this.store.audit({ actor: tech.name, action: "approvals.teams_registered", target: "approvals", detail: { conversationType: conversationType ?? "channel" } });
      await reply("Done: I'll post approval cards here. Technicians in the Haley directory can approve, reject or ask for changes from the card.");
      return { status: 202 };
    }
    return null;
  }
}
