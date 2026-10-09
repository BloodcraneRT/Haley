import type { ApprovalEvents } from "../agent/runner.js";
import type { Store } from "../store.js";
import type { Action, Assurance, Org, Run, Technician, Ticket, TicketStatus } from "../types.js";

/** Everything an approval card shows. Built from the store; never includes action inputs or tool results. */
export interface ApprovalCard {
  action: Pick<Action, "id" | "tool" | "risk" | "description" | "rationale" | "policy_reason" | "approvers" | "status" | "decided_by" | "decision_note" | "decided_at">;
  orgName: string;
  runTitle: string;
  ticket: { id: string; number: number; title: string; requester: string; identity: string } | null;
  /** Haley's read steps before asking ("Checked Megan's account"), newest last. */
  evidence: string[];
  /** Link to the ticket (or the approvals queue) in the dashboard, when the public URL is known. */
  url: string | null;
  /** False when the change is riskier than the workspace allows deciding from chat. */
  decidableInChat: boolean;
}

export interface EscalationNotice {
  ticket: { id: string; number: number; title: string; requester: string };
  orgName: string;
  reason: string;
  url: string | null;
  /** Needs-care lines: "VIP requester", "Seems frustrated: …". */
  care: string[];
  /** The technician suggested (or assigned) for it, with their Slack id for a mention when linked. */
  suggested: { name: string; reasons: string[]; assigned: boolean; slackUserId: string | null } | null;
}

/** Slack or Teams, as seen by the notifier. Each returns the ref needed to update the post later, or null if it isn't set up. */
export interface ApprovalChannel {
  readonly channel: "slack" | "teams";
  /** Whether this client's cards have somewhere to go, checked before doing any work. */
  configured(org: Org): boolean;
  postApproval(card: ApprovalCard, org: Org): Promise<Record<string, string> | null>;
  updateApproval(ref: Record<string, string>, card: ApprovalCard): Promise<void>;
  postEscalation(notice: EscalationNotice, org: Org): Promise<Record<string, string> | null>;
  /**
   * Sends the card straight to one technician; null when they have no account on this platform. Throws
   * DirectMessageUnavailable when the platform won't let the bot message them.
   */
  postDirect?(card: ApprovalCard, technician: Technician): Promise<Record<string, string> | null>;
  /** A short line under an earlier card (a thread reply). */
  postReminder?(ref: Record<string, string>, text: string): Promise<void>;
}

/** The platform won't let the bot message this person directly (Teams: they don't have the app). */
export class DirectMessageUnavailable extends Error {}

const IDENTITY: Record<Assurance, string> = {
  none: "identity not verified",
  email: "verified email",
  chat: "verified chat account",
  directory: "verified in the client's directory",
  mfa: "verified with MFA",
  technician: "technician",
};

const RISK_ORDER = ["read", "internal", "write", "destructive"] as const;

/** Short needs-care lines for notices. */
export function careLines(ticket: Ticket): string[] {
  const lines: string[] = [];
  if (ticket.flags.vip) lines.push("VIP requester");
  if (ticket.flags.frustrated) lines.push(`Seems frustrated: ${ticket.flags.frustrated.reason}`);
  return lines;
}

/** Who raised the escalation automatically; a technician setting a ticket to escalated doesn't notify. */
const AUTOMATIC_ACTORS = new Set(["haley", "scheduler", "system"]);

/**
 * Posts approval cards and escalation notices to the MSP's Slack and Teams, and updates every card once its
 * action is decided anywhere (dashboard, the other chat, or the system when a run ends). Best effort: a
 * failure is audited and never affects the run; the dashboard approval queue stays the record.
 */
export class ApprovalNotifier implements ApprovalEvents {
  private readonly inflight = new Set<Promise<void>>();
  private readonly reportedUnreachable = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly channels: ApprovalChannel[],
    private readonly publicUrl: string,
  ) {}

  /** Resolves when every post and update started so far has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** Runs background work; it never rejects, since nothing awaits it except `idle()`. */
  private track(work: () => Promise<void>): void {
    const p = work()
      .catch(() => undefined)
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  private link(path: string): string | null {
    return this.publicUrl ? `${this.publicUrl.replace(/\/+$/, "")}${path}` : null;
  }

  card(action: Action, evidence: string[] = []): ApprovalCard | null {
    const run = this.store.getRun(action.run_id);
    const org = this.store.getOrg(action.org_id);
    if (!run || !org) return null;
    const ticket = run.ticket_id ? this.store.getTicket(run.ticket_id) : null;
    const max = this.store.getApprovalSettings().chatApprovalMaxRisk;
    return {
      action,
      orgName: org.name,
      runTitle: run.title,
      ticket: ticket
        ? {
            id: ticket.id,
            number: ticket.number,
            title: ticket.title,
            requester: ticket.requester_name || ticket.requester_email || "Unknown requester",
            identity: IDENTITY[ticket.assurance] ?? ticket.assurance,
          }
        : null,
      evidence,
      url: this.link(ticket ? `/tickets/${ticket.id}` : "/approvals"),
      decidableInChat: RISK_ORDER.indexOf(action.risk) <= RISK_ORDER.indexOf(max),
    };
  }

  pending({ run, actions, evidence }: { run: Run; actions: Action[]; evidence: string[] }): void {
    const org = this.store.getOrg(run.org_id);
    if (!org) return;
    const channels = this.channels.filter((c) => c.configured(org));
    if (!channels.length) return;
    const dm = this.store.getApprovalSettings().dmApprovers;
    for (const action of actions) {
      const card = this.card(action, evidence);
      if (!card) continue;
      for (const channel of channels) {
        this.track(async () => {
          try {
            const ref = await channel.postApproval(card, org);
            if (!ref) return;
            this.store.addApprovalPost({ actionId: action.id, ticketId: run.ticket_id, channel: channel.channel, ref: { ...ref, evidence: JSON.stringify(evidence) } });
          } catch (err) {
            this.failed(org.id, action.id, channel.channel, err);
          }
        });
      }
      // Named approvers also get it directly, so a change only they can approve doesn't wait on them noticing a channel.
      if (dm && action.approvers.length) this.sendDirect(org, action, card, run.ticket_id, this.technicians(action.approvers), evidence);
    }
  }

  /** Directory technicians for a list of names (people not in the directory can't be messaged). */
  private technicians(names: string[]): Technician[] {
    return names.map((name) => this.store.findTechnician({ name })).filter((t): t is Technician => t !== null);
  }

  /** Sends the card to each technician on every platform they're linked on, recording each so it's updated later. */
  private sendDirect(org: Org, action: Action, card: ApprovalCard, ticketId: string | null, people: Technician[], evidence: string[]) {
    for (const person of people) {
      for (const channel of this.channels.filter((c) => c.postDirect && c.configured(org))) {
        this.track(async () => {
          try {
            const ref = await channel.postDirect!(card, person);
            if (ref) this.store.addApprovalPost({ actionId: action.id, ticketId, channel: channel.channel, ref: { ...ref, evidence: JSON.stringify(evidence) }, kind: "dm" });
          } catch (err) {
            if (err instanceof DirectMessageUnavailable) this.unreachable(org.id, person, channel.channel, err.message);
            else this.failed(org.id, action.id, channel.channel, err);
          }
        });
      }
    }
  }

  /** Audited once a day per technician and platform, so a missing Teams app doesn't flood the log. */
  private unreachable(orgId: string, person: Technician, channel: string, reason: string) {
    const key = `${person.id}:${channel}:${new Date().toISOString().slice(0, 10)}`;
    if (this.reportedUnreachable.has(key)) return;
    this.reportedUnreachable.add(key);
    this.store.audit({ orgId, actor: "system", action: "approvals.dm_unavailable", target: person.id, detail: { channel, technician: person.name, reason } });
  }

  /**
   * One reminder for changes that have waited the workspace's reminder time: a line under each channel card, and
   * the card again to the named approvers (or, when anyone can approve, the technician the ticket is assigned to).
   * Called from the scheduler; does nothing when reminders are off.
   */
  remind(nowMs = Date.now()): void {
    const minutes = this.store.getApprovalSettings().reminderMinutes;
    if (!minutes) return;
    for (const action of this.store.listActionsToRemind(new Date(nowMs - minutes * 60_000).toISOString())) {
      // Claimed first, so overlapping ticks and restarts never send it twice.
      if (!this.store.markActionReminded(action.id)) continue;
      const org = this.store.getOrg(action.org_id);
      const run = this.store.getRun(action.run_id);
      if (!org || !run) continue;
      const waited = Math.max(minutes, Math.round((nowMs - Date.parse(action.created_at)) / 60_000));
      const ticket = run.ticket_id ? this.store.getTicket(run.ticket_id) : null;
      const link = this.link(ticket ? `/tickets/${ticket.id}` : "/approvals");
      const text = `⏰ Still waiting for approval (${waited} min): ${action.description.slice(0, 300)}${link ? ` · ${link}` : ""}`;
      const posts = this.store.listApprovalPosts(action.id);
      for (const post of posts.filter((p) => p.kind === "card")) {
        const channel = this.channels.find((c) => c.channel === post.channel);
        if (!channel?.postReminder) continue;
        this.track(async () => {
          try {
            await channel.postReminder!(post.ref, text);
            this.store.addApprovalPost({ actionId: action.id, ticketId: run.ticket_id, channel: channel.channel, ref: post.ref, kind: "reminder" });
          } catch (err) {
            this.failed(org.id, action.id, channel.channel, err);
          }
        });
      }
      const evidence = (() => {
        try {
          return JSON.parse(posts[0]?.ref.evidence ?? "[]") as string[];
        } catch {
          return [];
        }
      })();
      const card = this.card(action, evidence);
      const people = action.approvers.length ? this.technicians(action.approvers) : ticket?.assignee ? this.technicians([ticket.assignee]) : [];
      if (card && people.length) this.sendDirect(org, action, card, run.ticket_id, people, evidence);
      this.store.audit({ orgId: org.id, actor: "system", action: "approval.reminded", target: action.id, detail: { minutes: waited, to: people.map((p) => p.name) } });
    }
  }

  decided(action: Action): void {
    // Cards and direct messages are updated; reminder lines stay as they were.
    for (const post of this.store.listApprovalPosts(action.id).filter((p) => p.kind !== "reminder")) {
      const channel = this.channels.find((c) => c.channel === post.channel);
      if (!channel) continue;
      this.track(async () => {
        const evidence = (() => {
          try {
            return JSON.parse(post.ref.evidence ?? "[]") as string[];
          } catch {
            return [];
          }
        })();
        const card = this.card(action, evidence);
        if (!card) return;
        try {
          await channel.updateApproval(post.ref, card);
        } catch (err) {
          this.failed(action.org_id, action.id, channel.channel, err);
        }
      });
    }
  }

  /** Store listener: a ticket Haley (or the SLA sweep) escalated gets a notice, once the escalation reason is recorded. */
  escalated(ticket: Ticket, from: TicketStatus, actor: string): void {
    if (ticket.status !== "escalated" || from === "escalated" || !AUTOMATIC_ACTORS.has(actor)) return;
    if (!this.store.getApprovalSettings().escalationNotices) return;
    const org = this.store.getOrg(ticket.org_id);
    if (!org) return;
    const channels = this.channels.filter((c) => c.configured(org));
    if (!channels.length) return;
    // The escalation reason is written right after the status change; read it on the next tick.
    this.track(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      const events = this.store.listTicketEvents(ticket.id);
      const latest = [...events].reverse().find((e) => e.kind === "escalation" || (e.kind === "agent_note" && e.meta.error));
      const notice: EscalationNotice = {
        ticket: { id: ticket.id, number: ticket.number, title: ticket.title, requester: ticket.requester_name || ticket.requester_email || "Unknown requester" },
        orgName: org.name,
        reason: latest?.body.slice(0, 600) || (actor === "scheduler" ? "The SLA target was missed." : "Haley handed this to a person."),
        url: this.link(`/tickets/${ticket.id}`),
        care: careLines(this.store.getTicket(ticket.id) ?? ticket),
        suggested: (() => {
          const current = this.store.getTicket(ticket.id) ?? ticket;
          const s = current.suggested_assignee;
          if (!s) return null;
          return { name: s.name, reasons: s.reasons, assigned: current.assignee === s.name, slackUserId: this.store.findTechnician({ name: s.name })?.slack_user_id ?? null };
        })(),
      };
      for (const channel of channels) {
        try {
          const ref = await channel.postEscalation(notice, org);
          if (ref) this.store.addApprovalPost({ actionId: null, ticketId: ticket.id, channel: channel.channel, ref });
        } catch (err) {
          this.failed(org.id, ticket.id, channel.channel, err);
        }
      }
    });
  }

  private failed(orgId: string, target: string, channel: string, err: unknown) {
    this.store.audit({ orgId, actor: "system", action: "approval.notify_failed", target, detail: { channel, error: err instanceof Error ? err.message : String(err) } });
  }
}
