import { clip } from "../connectors/http.js";
import { SyncroRmmApi, type SyncroAlert } from "../connectors/syncro/api.js";
import type { AlertSource } from "./alerts.js";

export { ALERT_POLL_INTERVAL_MS, MAX_ALERT_TICKETS_PER_HOUR, MAX_ALERT_TICKETS_PER_POLL, type AlertPollResult } from "./alerts.js";

/**
 * SyncroMSP RMM alerts for a client's Syncro customer. Alerts Syncro already opened a ticket for are left to the PSA
 * sync, and resolved ones are skipped.
 */
export function syncroAlertSource(fetchImpl: typeof fetch = fetch): AlertSource {
  return {
    provider: "syncro_rmm",
    label: "Syncro RMM",
    enabled: (config) => (config.alertTickets ?? "").trim().toLowerCase() === "true",
    async listActive(_integration, config, since) {
      const customerId = Number(config.customerId);
      const api = new SyncroRmmApi({ subdomain: config.subdomain, apiKey: config.apiKey }, fetchImpl);
      return (await api.activeAlerts(since))
        .filter((a) => Number(a.customer_id) === customerId)
        .map((a) => ({ id: String(a.id), createdAt: a.created_at, skip: Boolean(a.resolved || a.ticket_number), raw: a }));
    },
    // Kept as it was before alert sources were generalised, so tickets already open still match.
    dedupeKey: (item) => {
      const alert = item.raw as SyncroAlert;
      return `${alert.asset_id ?? alert.computer_name ?? ""}:${(alert.description ?? "").trim().toLowerCase()}`;
    },
    describe(item) {
      const alert = item.raw as SyncroAlert;
      const device = alert.computer_name || (alert.asset_id ? `asset ${alert.asset_id}` : "a device");
      const what = alert.description?.trim() || "Syncro alert";
      return {
        title: `${device}: ${what}`,
        body: [
          `SyncroMSP RMM alert #${alert.id} on ${device}${alert.asset_id ? ` (Syncro asset id ${alert.asset_id})` : ""}, raised ${alert.created_at}.`,
          what,
          alert.formatted_output ? clip(alert.formatted_output, 3000) : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        ref: alert.asset_id ? { assetId: String(alert.asset_id) } : ({} as Record<string, string>),
      };
    },
  };
}
