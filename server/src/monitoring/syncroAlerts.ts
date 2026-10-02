import type { AgentService } from "../agent/runner.js";
import { clip } from "../connectors/http.js";
import { SyncroRmmApi, type SyncroAlert } from "../connectors/syncro/api.js";
import type { Store } from "../store.js";
import type { Integration } from "../types.js";

/** How often each client's Syncro alerts are checked. */
export const ALERT_POLL_INTERVAL_MS = 2 * 60_000;
/** New alert tickets per client per check, and per hour: an alert storm becomes a handful of tickets, not hundreds. */
export const MAX_ALERT_TICKETS_PER_POLL = 5;
export const MAX_ALERT_TICKETS_PER_HOUR = 20;
/** Re-read a little before the cursor so alerts stamped in the same second aren't missed; seen ids dedupe. */
const OVERLAP_MS = 10 * 60_000;
const MAX_SEEN = 1000;

interface AlertState {
  /** created_at of the newest alert handled. Null until the first check, which only sets the starting point. */
  cursor: string | null;
  seen: number[];
  lastPollAt: string | null;
  lastError?: string;
}

export interface AlertPollResult {
  created: string[];
  updated: string[];
  errors: string[];
}

const enabled = (config: Record<string, string>) => (config.alertTickets ?? "").trim().toLowerCase() === "true";

/**
 * Opens a Haley ticket for each new SyncroMSP RMM alert on clients that turned it on, and puts Haley on it.
 * Alerts that existed before it was turned on, alerts Syncro already ticketed, and repeats of an alert that
 * already has an open ticket don't open new tickets.
 */
export class SyncroAlertTickets {
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly agent: AgentService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async poll(nowMs = Date.now()): Promise<AlertPollResult> {
    const result: AlertPollResult = { created: [], updated: [], errors: [] };
    if (this.running) return result;
    this.running = true;
    try {
      for (const integration of this.store.listIntegrations().filter((i) => i.provider === "syncro_rmm")) {
        try {
          await this.pollOne(integration, nowMs, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(`${integration.label}: ${message}`);
          const state = this.state(integration);
          this.store.setIntegrationState(integration.id, { ...state, lastPollAt: new Date(nowMs).toISOString(), lastError: message });
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

  private async pollOne(integration: Integration, nowMs: number, result: AlertPollResult) {
    const config = this.store.getIntegrationConfig(integration.id);
    const org = this.store.getOrg(integration.org_id);
    if (!org || !enabled(config)) return;
    // While Haley is paused, technicians own the client; alerts wait in Syncro and are picked up on resume.
    if (org.settings.paused) return;
    const state = this.state(integration);
    if (state.lastPollAt && nowMs - Date.parse(state.lastPollAt) < ALERT_POLL_INTERVAL_MS) return;
    const now = new Date(nowMs).toISOString();
    if (!state.cursor) {
      // First check after turning it on: start from now rather than ticketing every existing alert.
      this.store.setIntegrationState(integration.id, { ...state, cursor: now, lastPollAt: now, lastError: undefined });
      return;
    }

    const customerId = Number(config.customerId);
    const api = new SyncroRmmApi({ subdomain: config.subdomain, apiKey: config.apiKey }, this.fetchImpl);
    const sinceMs = Date.parse(state.cursor) - OVERLAP_MS;
    // Syncro times carry their own UTC offset ("…-07:00"), so compare instants, never strings.
    const alerts = (await api.activeAlerts(new Date(sinceMs).toISOString()))
      .map((a) => ({ alert: a, at: Date.parse(a.created_at) }))
      .filter(({ alert, at }) => Number(alert.customer_id) === customerId && Number.isFinite(at) && at >= sinceMs)
      .sort((a, b) => a.at - b.at);

    const seen = new Set(state.seen);
    let cursor = state.cursor;
    let createdNow = 0;
    let hourly = this.store.countAlertTicketsSince(org.id, new Date(nowMs - 3_600_000).toISOString());
    for (const { alert, at } of alerts) {
      if (seen.has(alert.id)) continue;
      if (alert.resolved || alert.ticket_number) {
        // Already over, or Syncro opened its own ticket (the PSA sync brings that one in).
        seen.add(alert.id);
      } else {
        const key = `${alert.asset_id ?? alert.computer_name ?? ""}:${(alert.description ?? "").trim().toLowerCase()}`;
        const open = this.store.findOpenAlertTicket(org.id, key);
        if (open) {
          this.store.addTicketEvent(open.id, "agent_note", "Syncro RMM", `Syncro raised this alert again (#${alert.id}) at ${alert.created_at}.`, { alertId: alert.id });
          result.updated.push(open.id);
          seen.add(alert.id);
        } else {
          // Stop here and keep the cursor so the rest are picked up on a later check.
          if (createdNow >= MAX_ALERT_TICKETS_PER_POLL || hourly >= MAX_ALERT_TICKETS_PER_HOUR) break;
          result.created.push(this.openTicket(integration, alert, key));
          createdNow++;
          hourly++;
          seen.add(alert.id);
        }
      }
      if (at > Date.parse(cursor)) cursor = new Date(at).toISOString();
    }
    this.store.setIntegrationState(integration.id, { cursor, seen: [...seen].slice(-MAX_SEEN), lastPollAt: now, lastError: undefined });
  }

  private openTicket(integration: Integration, alert: SyncroAlert, alertKey: string): string {
    const device = alert.computer_name || (alert.asset_id ? `asset ${alert.asset_id}` : "a device");
    const what = alert.description?.trim() || "Syncro alert";
    const ticket = this.store.createTicket({
      orgId: integration.org_id,
      title: clip(`${device}: ${what}`, 110).replace(/\n.*$/s, "…"),
      description: [
        `SyncroMSP RMM alert #${alert.id} on ${device}${alert.asset_id ? ` (Syncro asset id ${alert.asset_id})` : ""}, raised ${alert.created_at}.`,
        what,
        alert.formatted_output ? clip(alert.formatted_output, 3000) : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      requesterName: "Syncro RMM",
      author: "Syncro RMM",
      channel: "monitoring",
      channelRef: {
        source: "syncro_rmm",
        integrationId: integration.id,
        alertId: String(alert.id),
        ...(alert.asset_id ? { assetId: String(alert.asset_id) } : {}),
        alertKey,
      },
      assurance: "none",
      verification: "Raised by SyncroMSP monitoring",
    });
    this.store.audit({ orgId: integration.org_id, actor: "syncro_rmm", action: "ticket.created", target: ticket.id, detail: { number: ticket.number, alertId: alert.id } });
    try {
      this.agent.startTicketRun(ticket.id, "monitoring");
    } catch (err) {
      this.store.addTicketEvent(ticket.id, "agent_note", "system", `Haley couldn't start on this alert: ${err instanceof Error ? err.message : String(err)}`);
    }
    return ticket.id;
  }
}
