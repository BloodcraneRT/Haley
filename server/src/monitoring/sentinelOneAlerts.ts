import { SentinelOneApi, type S1Threat } from "../connectors/sentinelone/api.js";
import { threatSummary } from "../connectors/sentinelone/tools.js";
import type { AlertSource } from "./alerts.js";

/**
 * New SentinelOne threats on a client's site become tickets Haley triages with the device's SentinelOne,
 * RMM and Microsoft 365 context. Threats already marked resolved are skipped.
 */
export function sentinelOneAlertSource(fetchImpl: typeof fetch = fetch): AlertSource {
  return {
    provider: "sentinelone",
    label: "SentinelOne",
    enabled: (config) => (config.alertTickets ?? "").trim().toLowerCase() === "true",
    async listActive(_integration, config, since) {
      const api = new SentinelOneApi({ consoleUrl: config.consoleUrl, apiToken: (config.apiToken ?? "").trim() }, (config.siteId ?? "").trim(), fetchImpl);
      return (await api.threats({ since }, 200)).map((t) => ({
        id: String(t.id),
        createdAt: t.threatInfo?.createdAt ?? "",
        skip: t.threatInfo?.incidentStatus === "resolved",
        raw: t,
      }));
    },
    // The same threat on the same device is one ticket, however often it's detected again.
    dedupeKey: (item) => {
      const t = item.raw as S1Threat;
      return `sentinelone:${t.agentRealtimeInfo?.agentId ?? ""}:${(t.threatInfo?.sha1 || t.threatInfo?.threatName || "").toLowerCase()}`;
    },
    describe(item) {
      const s = threatSummary(item.raw as S1Threat);
      const device = s.device || "a device";
      const lines = [
        `SentinelOne threat #${s.id} on ${device}, detected ${s.detected ?? "recently"}.`,
        [
          s.name ? `Threat: ${s.name}` : "",
          s.classification ? `Classification: ${s.classification}` : "",
          s.confidence ? `Confidence: ${s.confidence}` : "",
          s.mitigation ? `Mitigation status: ${s.mitigation}` : "",
          s.verdict ? `Analyst verdict: ${s.verdict}` : "",
          s.user ? `Last user: ${s.user}` : "",
          s.filePath ? `File: ${s.filePath}` : "",
          s.sha1 ? `SHA1: ${s.sha1}` : "",
          s.detectedBy ? `Detected by: ${s.detectedBy}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        "Triage it: check the threat and device in SentinelOne, and the user's recent sign-ins if Microsoft 365 is connected. Don't kill, quarantine, roll back or disconnect anything without a technician's approval.",
      ];
      return {
        title: `${device}: ${s.classification ?? "Threat"} ${s.name ?? ""}`.trim(),
        body: lines.filter(Boolean).join("\n\n"),
        ref: { threatId: s.id, ...(s.deviceId ? { agentId: s.deviceId } : {}) },
      };
    },
  };
}
