import type { AgentService } from "./agent/runner.js";
import { slaFor } from "./sla.js";
import type { Store } from "./store.js";
import type { Cadence, Schedule } from "./types.js";

/** The next occurrence strictly after `now`, skipping any runs missed while the server was down. */
export function nextOccurrence(from: string, cadence: Cadence, nowMs: number): string | null {
  if (cadence === "once") return null;
  const d = new Date(from);
  do {
    if (cadence === "daily") d.setUTCDate(d.getUTCDate() + 1);
    else if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + 1);
  } while (d.getTime() <= nowMs);
  return d.toISOString();
}

export interface TickResult {
  started: Array<{ scheduleId: string; runId: string }>;
  skipped: Array<{ scheduleId: string; reason: string }>;
  escalated: string[];
}

/**
 * Proactive work: fires due schedules (recurring audits, follow-ups Haley set on tickets) and escalates
 * tickets that blew their resolution SLA so a human picks them up.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly agent: AgentService,
  ) {}

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tick().catch(() => {}), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(nowMs = Date.now()): Promise<TickResult> {
    const result: TickResult = { started: [], skipped: [], escalated: [] };
    if (this.running) return result;
    this.running = true;
    try {
      for (const schedule of this.store.dueSchedules(new Date(nowMs).toISOString())) this.fire(schedule, nowMs, result);
      this.sweepSla(nowMs, result);
    } finally {
      this.running = false;
    }
    return result;
  }

  /** Starts a schedule now (from the tick or the "Run now" button). */
  runNow(scheduleId: string, nowMs = Date.now()): TickResult {
    const result: TickResult = { started: [], skipped: [], escalated: [] };
    const schedule = this.store.getSchedule(scheduleId);
    if (schedule) this.fire(schedule, nowMs, result, false);
    return result;
  }

  private fire(schedule: Schedule, nowMs: number, result: TickResult, advance = true) {
    const org = this.store.getOrg(schedule.org_id);
    const nowIso = new Date(nowMs).toISOString();
    const reschedule = () => {
      if (!advance) return;
      const next = nextOccurrence(schedule.next_run_at ?? nowIso, schedule.cadence, nowMs);
      this.store.updateSchedule(schedule.id, { next_run_at: next, enabled: next !== null });
    };
    if (!org || org.settings.paused) {
      result.skipped.push({ scheduleId: schedule.id, reason: "Haley is paused for this client" });
      reschedule();
      return;
    }
    try {
      let runId: string;
      if (schedule.ticket_id) {
        // A follow-up on a busy ticket waits for the next tick instead of being dropped.
        if (this.agent.activeRun(schedule.ticket_id)) {
          result.skipped.push({ scheduleId: schedule.id, reason: "ticket busy; retrying" });
          return;
        }
        runId = this.agent.startTicketRun(schedule.ticket_id, `schedule:${schedule.created_by}`, schedule.mode, schedule.instruction).id;
      } else {
        runId = this.agent.startTaskRun(schedule.org_id, schedule.title, schedule.instruction, `schedule:${schedule.created_by}`, schedule.mode).id;
      }
      this.store.updateSchedule(schedule.id, { last_run_at: nowIso, last_run_id: runId });
      this.store.audit({ orgId: schedule.org_id, actor: "scheduler", action: "schedule.fired", target: schedule.id, detail: { runId, title: schedule.title } });
      result.started.push({ scheduleId: schedule.id, runId });
    } catch (err) {
      result.skipped.push({ scheduleId: schedule.id, reason: err instanceof Error ? err.message : String(err) });
    }
    reschedule();
  }

  private sweepSla(nowMs: number, result: TickResult) {
    const orgs = new Map(this.store.listOrgs().map((o) => [o.id, o]));
    for (const ticket of this.store.listTickets({ status: "open", limit: 10_000 })) {
      if (ticket.sla_escalated || ticket.status === "escalated" || ticket.assignee !== "haley") continue;
      const org = orgs.get(ticket.org_id);
      const active = this.agent.activeRun(ticket.id);
      // A run waiting on approval still counts as stuck; one that's actively working gets to finish.
      if (!org || (active && active.status !== "awaiting_approval")) continue;
      const sla = slaFor(ticket, org.settings.sla, nowMs);
      if (sla.resolution !== "breached") continue;
      this.store.markSlaEscalated(ticket.id);
      this.store.updateTicket(ticket.id, { status: "escalated", assignee: "unassigned" }, "scheduler");
      this.store.addTicketEvent(
        ticket.id,
        "escalation",
        "scheduler",
        `Resolution SLA for ${ticket.priority} priority (${org.settings.sla[ticket.priority].resolutionMinutes} min) passed at ${sla.resolutionDue}. Escalated to a technician.`,
        { sla: true },
      );
      this.store.audit({ orgId: org.id, actor: "scheduler", action: "ticket.sla_escalated", target: ticket.id, detail: { number: ticket.number } });
      result.escalated.push(ticket.id);
    }
  }
}
