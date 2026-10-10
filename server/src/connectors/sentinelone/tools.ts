import { z } from "zod";
import { ConnectorError, defineTool, type HaleyTool } from "../types.js";
import type { S1Agent, S1Threat, SentinelOneApi } from "./api.js";

function agentSummary(a: S1Agent) {
  return {
    id: a.id,
    name: a.computerName,
    os: a.osName ?? null,
    type: a.machineType ?? null,
    network: a.networkStatus ?? null,
    active: a.isActive ?? null,
    infected: Boolean(a.infected),
    activeThreats: a.activeThreats ?? 0,
    lastActive: a.lastActiveDate ?? null,
    lastUser: a.lastLoggedInUserName ?? null,
    agentVersion: a.agentVersion ?? null,
  };
}

export function threatSummary(t: S1Threat) {
  const i = t.threatInfo ?? {};
  return {
    id: t.id,
    name: i.threatName ?? null,
    classification: i.classification ?? null,
    confidence: i.confidenceLevel ?? null,
    mitigation: i.mitigationStatus ?? null,
    verdict: i.analystVerdict ?? null,
    incidentStatus: i.incidentStatus ?? null,
    detected: i.createdAt ?? null,
    device: t.agentRealtimeInfo?.agentComputerName ?? null,
    deviceId: t.agentRealtimeInfo?.agentId ?? null,
    user: t.agentDetectionInfo?.agentLastLoggedInUserName ?? null,
    filePath: i.filePath ?? null,
    sha1: i.sha1 ?? null,
    detectedBy: i.detectionType ?? i.initiatedBy ?? null,
  };
}

const threatId = z.string().regex(/^\d+$/, "SentinelOne threat ids are numbers").describe("SentinelOne threat id");

/**
 * SentinelOne tools for one client (one site). Reads are free; changing a threat's status is a change; stopping or
 * quarantining a process is destructive; cutting a device off the network always waits for a technician.
 */
export function sentinelOneTools(api: SentinelOneApi): HaleyTool[] {
  const mustThreat = async (id: string) => {
    const threat = await api.threat(id);
    if (!threat) throw new ConnectorError(`Threat ${id} isn't on this client's SentinelOne site.`);
    return threat;
  };
  const mustAgent = async (device: string) => {
    const agent = await api.agent(device);
    if (!agent) throw new ConnectorError(`No device "${device}" on this client's SentinelOne site (use the exact name or the agent id).`);
    return agent;
  };

  return [
    defineTool({
      name: "s1_list_devices",
      description: "List this client's devices in SentinelOne with network status, infection state and active threat count. Optional search matches the computer name.",
      input: z.object({ search: z.string().optional(), infectedOnly: z.boolean().optional() }),
      risk: "read",
      run: async ({ search, infectedOnly }) => (await api.agents({ search, infected: infectedOnly ? true : undefined }, 200)).map(agentSummary),
    }),
    defineTool({
      name: "s1_get_device",
      description: "One SentinelOne device by exact computer name or agent id: network status (connected or disconnected from the network), infection state, last user and agent version.",
      input: z.object({ device: z.string().min(1).describe("Computer name or agent id") }),
      risk: "read",
      run: async ({ device }) => agentSummary(await mustAgent(device)),
    }),
    defineTool({
      name: "s1_list_threats",
      description: "List this client's SentinelOne threats, newest first: name, classification, confidence, mitigation status, analyst verdict, incident status and device.",
      input: z.object({ unresolvedOnly: z.boolean().default(true), sinceDays: z.number().int().min(1).max(90).optional() }),
      risk: "read",
      run: async ({ unresolvedOnly, sinceDays }) =>
        (await api.threats({ unresolvedOnly, since: sinceDays ? new Date(Date.now() - sinceDays * 86_400_000).toISOString() : undefined }, 100)).map(threatSummary),
    }),
    defineTool({
      name: "s1_get_threat",
      description: "One SentinelOne threat with its file path, hash, detection source, device and user.",
      input: z.object({ threatId }),
      risk: "read",
      run: async ({ threatId: id }) => threatSummary(await mustThreat(id)),
    }),
    defineTool({
      name: "s1_update_threat",
      description:
        "Set a SentinelOne threat's incident status (resolved, in progress) and optionally the analyst verdict (true_positive, false_positive, suspicious). Use after investigating; marking a real threat a false positive needs good evidence.",
      input: z.object({
        threatId,
        incidentStatus: z.enum(["resolved", "in_progress", "unresolved"]),
        verdict: z.enum(["true_positive", "false_positive", "suspicious"]).optional(),
      }),
      risk: "write",
      describe: ({ threatId: id, incidentStatus, verdict }) => `Mark SentinelOne threat ${id} ${incidentStatus.replace("_", " ")}${verdict ? ` (${verdict.replace("_", " ")})` : ""}`,
      run: async ({ threatId: id, incidentStatus, verdict }) => {
        await mustThreat(id);
        if (verdict) await api.setVerdict(id, verdict);
        const affected = await api.setIncidentStatus(id, incidentStatus);
        return { threatId: id, incidentStatus, verdict: verdict ?? null, affected };
      },
    }),
    defineTool({
      name: "s1_mitigate_threat",
      description:
        "Act on a SentinelOne threat on the device: kill the process, quarantine the file, remediate (undo its changes), or roll back (Windows, restores files from shadow copies). Only for threats confirmed as malicious.",
      input: z.object({ threatId, action: z.enum(["kill", "quarantine", "remediate", "rollback-remediation"]) }),
      risk: "destructive",
      describe: ({ threatId: id, action }) => `${action === "rollback-remediation" ? "Roll back" : action[0].toUpperCase() + action.slice(1)} SentinelOne threat ${id}`,
      run: async ({ threatId: id, action }) => {
        const threat = await mustThreat(id);
        const affected = await api.mitigate(id, action);
        return { threatId: id, action, device: threat.agentRealtimeInfo?.agentComputerName ?? null, affected };
      },
    }),
    defineTool({
      name: "s1_disconnect_device",
      description:
        "Disconnect a device from the network with SentinelOne (it can still reach the SentinelOne console). For active compromise only: the user loses all network access until it's reconnected. Always needs a technician.",
      input: z.object({ device: z.string().min(1).describe("Computer name or agent id"), reason: z.string().min(1).max(500) }),
      risk: "destructive",
      rail: "technician_only",
      describe: ({ device, reason }) => `Disconnect ${device} from the network (${reason})`,
      run: async ({ device }) => {
        const agent = await mustAgent(device);
        const affected = await api.disconnect(agent.id);
        return { device: agent.computerName, agentId: agent.id, disconnected: affected > 0 };
      },
    }),
    defineTool({
      name: "s1_reconnect_device",
      description: "Reconnect a device SentinelOne disconnected from the network, once it's clean. Needs approval.",
      input: z.object({ device: z.string().min(1).describe("Computer name or agent id") }),
      risk: "destructive",
      describe: ({ device }) => `Reconnect ${device} to the network`,
      run: async ({ device }) => {
        const agent = await mustAgent(device);
        const affected = await api.reconnect(agent.id);
        return { device: agent.computerName, agentId: agent.id, reconnected: affected > 0 };
      },
    }),
  ];
}
