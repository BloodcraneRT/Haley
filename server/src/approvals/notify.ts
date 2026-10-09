import type { ApprovalEvents } from "../agent/runner.js";
import type { Store } from "../store.js";
import type { Action, Assurance, Org, Run, Ticket, TicketStatus } from "../types.js";

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
}

/** Slack or Teams, as seen by the notifier. Each returns the ref needed to update the post later, or null if it isn't set up. */
export interface ApprovalChannel {
  readonly channel: "slack" | "teams";
  /** Whether this client's cards have somewhere to go, checked before doing any work. */
  configured(org: Org): boolean;
  postApproval(card: ApprovalCard, org: Org): Promise<Record<string, string> | null>;
  updateApproval(ref: Record<string, string>, card: ApprovalCard): Promise<void>;
  postEscalation(notice: EscalationNotice, org: Org): Promise<Record<string, string> | null>;
}

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
    }
  }

  decided(action: Action): void {
    for (const post of this.store.listApprovalPosts(action.id)) {
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
