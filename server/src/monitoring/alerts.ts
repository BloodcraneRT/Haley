import type { AgentService } from "../agent/runner.js";
import { clip } from "../connectors/http.js";
import type { Store } from "../store.js";
import type { Integration } from "../types.js";

/** How often each client's alerts are checked. */
export const ALERT_POLL_INTERVAL_MS = 2 * 60_000;
/** New alert tickets per client per check, and per hour: an alert storm becomes a handful of tickets, not hundreds. */
export const MAX_ALERT_TICKETS_PER_POLL = 5;
export const MAX_ALERT_TICKETS_PER_HOUR = 20;
/** Re-read a little before the cursor so alerts stamped in the same second aren't missed; seen ids dedupe. */
const OVERLAP_MS = 10 * 60_000;
const MAX_SEEN = 1000;

/** One alert as a source reports it. */
export interface AlertItem {
  id: string;
  /** When it was raised (any ISO format with an offset). */
  createdAt: string;
  /** Already over, or handled elsewhere (e.g. the RMM opened its own ticket): seen, but no ticket. */
  skip: boolean;
  /** The source's own record, for describe(). */
  raw: unknown;
}

/** A monitoring or security product whose alerts become tickets Haley works. */
export interface AlertSource {
  /** The integration provider id, e.g. "syncro_rmm", "sentinelone". */
  provider: string;
  /** Shown as the ticket's requester and in notes, e.g. "Syncro RMM". */
  label: string;
  /** Whether this client's integration has alert tickets turned on. */
  enabled(config: Record<string, string>): boolean;
  /** Alerts for this client raised at or after `since`. */
  listActive(integration: Integration, config: Record<string, string>, since: string): Promise<AlertItem[]>;
  /** The same problem on the same device: a repeat is added to its open ticket instead of opening another. */
  dedupeKey(alert: AlertItem): string;
  describe(alert: AlertItem): { title: string; body: string; ref: Record<string, string> };
}

interface AlertState {
  /** createdAt of the newest alert handled. Null until the first check, which only sets the starting point. */
  cursor: string | null;
  seen: Array<string | number>;
  lastPollAt: string | null;
  lastError?: string;
}

export interface AlertPollResult {
  created: string[];
  updated: string[];
  errors: string[];
}

/**
 * Opens a ticket for each new alert from a monitoring or security product on clients that turned it on, and puts
 * Haley on it. Alerts that existed before it was turned on, alerts already handled elsewhere, and repeats of an alert
 * that already has an open ticket don't open new tickets. Caps keep an alert storm to a handful of tickets.
 */
export class AlertTickets {
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly agent: AgentService,
    private readonly sources: AlertSource[],
  ) {}

  /** A webhook said something changed: check now, without waiting for the interval (one source, or all). */
  pollNow(nowMs = Date.now(), provider?: string): Promise<AlertPollResult> {
    return this.poll(nowMs, true, provider);
  }

  async poll(nowMs = Date.now(), force = false, provider?: string): Promise<AlertPollResult> {
    const result: AlertPollResult = { created: [], updated: [], errors: [] };
    if (this.running) return result;
    this.running = true;
    try {
      for (const source of this.sources.filter((s) => !provider || s.provider === provider)) {
        for (const integration of this.store.listIntegrations().filter((i) => i.provider === source.provider)) {
          try {
            await this.pollOne(source, integration, nowMs, result, force);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result.errors.push(`${integration.label}: ${message}`);
            this.store.setIntegrationState(integration.id, { ...this.state(integration), lastPollAt: new Date(nowMs).toISOString(), lastError: message });
          }
        }
      }
    } finally {
      this.running = false;
    }
    return result;
  }

  private state(integration: Integration): AlertState {
    return { cursor: null, seen: [], lastPollAt: null, ...(this.store.getIntegrationState<AlertState>(integration.id) ?? {}) };
  }

  private async pollOne(source: AlertSource, integration: Integration, nowMs: number, result: AlertPollResult, force: boolean) {
    const config = this.store.getIntegrationConfig(integration.id);
    const org = this.store.getOrg(integration.org_id);
    if (!org || !source.enabled(config)) return;
    // While Haley is paused, technicians own the client; alerts wait in the product and are picked up on resume.
    if (org.settings.paused) return;
    const state = this.state(integration);
    if (!force && state.lastPollAt && nowMs - Date.parse(state.lastPollAt) < ALERT_POLL_INTERVAL_MS) return;
    const now = new Date(nowMs).toISOString();
    if (!state.cursor) {
      // First check after turning it on: start from now rather than ticketing every existing alert.
      this.store.setIntegrationState(integration.id, { ...state, cursor: now, lastPollAt: now, lastError: undefined });
      return;
    }

    const sinceMs = Date.parse(state.cursor) - OVERLAP_MS;
    // Sources' times carry their own UTC offset, so compare instants, never strings.
    const alerts = (await source.listActive(integration, config, new Date(sinceMs).toISOString()))
      .map((alert) => ({ alert, at: Date.parse(alert.createdAt) }))
      .filter(({ at }) => Number.isFinite(at) && at >= sinceMs)
      .sort((a, b) => a.at - b.at);

    const seen = new Set(state.seen.map(String));
    let cursor = state.cursor;
    let createdNow = 0;
    let hourly = this.store.countAlertTicketsSince(org.id, new Date(nowMs - 3_600_000).toISOString());
    for (const { alert, at } of alerts) {
      if (seen.has(alert.id)) continue;
      if (alert.skip) {
        seen.add(alert.id);
      } else {
        const key = source.dedupeKey(alert);
        const open = this.store.findOpenAlertTicket(org.id, key);
        if (open) {
          this.store.addTicketEvent(open.id, "agent_note", source.label, `${source.label} raised this alert again (#${alert.id}) at ${alert.createdAt}.`, { alertId: alert.id });
          result.updated.push(open.id);
          seen.add(alert.id);
        } else {
          // Stop here and keep the cursor so the rest are picked up on a later check.
          if (createdNow >= MAX_ALERT_TICKETS_PER_POLL || hourly >= MAX_ALERT_TICKETS_PER_HOUR) break;
          result.created.push(this.openTicket(source, integration, alert, key));
          createdNow++;
          hourly++;
          seen.add(alert.id);
        }
      }
      if (at > Date.parse(cursor)) cursor = new Date(at).toISOString();
    }
    this.store.setIntegrationState(integration.id, { cursor, seen: [...seen].slice(-MAX_SEEN), lastPollAt: now, lastError: undefined });
  }

  private openTicket(source: AlertSource, integration: Integration, alert: AlertItem, alertKey: string): string {
    const { title, body, ref } = source.describe(alert);
    const ticket = this.store.createTicket({
      orgId: integration.org_id,
      title: clip(title, 110).replace(/\n.*$/s, "…"),
      description: body,
      requesterName: source.label,
      author: source.label,
      channel: "monitoring",
      channelRef: { source: source.provider, integrationId: integration.id, alertId: alert.id, ...ref, alertKey },
      assurance: "none",
      verification: `Raised by ${source.label}`,
    });
    this.store.audit({ orgId: integration.org_id, actor: source.provider, action: "ticket.created", target: ticket.id, detail: { number: ticket.number, alertId: alert.id } });
    try {
      this.agent.startTicketRun(ticket.id, "monitoring");
    } catch (err) {
      this.store.addTicketEvent(ticket.id, "agent_note", "system", `Haley couldn't start on this alert: ${err instanceof Error ? err.message : String(err)}`);
    }
    return ticket.id;
  }
}
