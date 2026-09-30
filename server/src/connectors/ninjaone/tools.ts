import { z } from "zod";
import { matches } from "../http.js";
import { ConnectorError, defineTool, type HaleyTool } from "../types.js";
import type { NinjaDevice, NinjaOneApi } from "./api.js";

/** NinjaOne timestamps are epoch seconds (with fractions); a few fields use milliseconds. */
function iso(ts: number | undefined | null): string | null {
  if (!ts) return null;
  return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
}

const gb = (bytes?: number) => (typeof bytes === "number" ? Math.round((bytes / 1024 ** 3) * 10) / 10 : null);

/** Scripts whose names suggest they destroy data or disable things wait for a technician in every mode. */
const RISKY_SCRIPT = /\b(wipe|format|erase|factory|re-?image|decommission|uninstall|disable|bitlocker|encrypt|shutdown|delete|remove)\b/i;

interface NinjaScript {
  id: number;
  name: string;
  description?: string;
  active?: boolean;
  language?: string;
  operatingSystems?: string[];
  scriptParameters?: unknown[];
  scriptVariables?: Array<{ name?: string; description?: string; type?: string; required?: boolean; defaultValue?: string }>;
}

function summary(d: NinjaDevice) {
  return {
    id: d.id,
    name: d.systemName || d.displayName || d.dnsName || String(d.id),
    displayName: d.displayName ?? null,
    class: d.nodeClass ?? null,
    offline: d.offline ?? null,
    lastContact: iso(d.lastContact),
  };
}

/**
 * NinjaOne RMM tools for one client. Every call is scoped to the client's NinjaOne organization: device
 * lookups check the device's organizationId, and lists only return that organization's devices and alerts.
 */
export function ninjaOneTools(api: NinjaOneApi, orgId: number): HaleyTool[] {
  const inOrg = (d: NinjaDevice, ref: string) => {
    if (d.organizationId !== orgId) throw new ConnectorError(`Device ${ref} isn't in this client's NinjaOne organization.`);
    return d;
  };

  const resolveDevice = async (ref: string): Promise<NinjaDevice> => {
    const value = ref.trim();
    if (/^\d+$/.test(value)) {
      const d = await api.device(Number(value)).catch((err: ConnectorError) => {
        if (err.status === 404) throw new ConnectorError(`No NinjaOne device with id ${value}. Use ninja_list_devices to find it.`, 404);
        throw err;
      });
      return inOrg(d, value);
    }
    const lower = value.toLowerCase();
    const found = (await api.organizationDevices(orgId)).filter((d) =>
      [d.systemName, d.displayName, d.dnsName].some((n) => n?.toLowerCase() === lower || n?.toLowerCase().split(".")[0] === lower),
    );
    if (!found.length) throw new ConnectorError(`No NinjaOne device named "${value}" for this client. Use ninja_list_devices to find it.`);
    if (found.length > 1) throw new ConnectorError(`"${value}" matches ${found.length} devices (ids ${found.map((d) => d.id).join(", ")}). Use the device id.`);
    return inOrg(await api.device(found[0].id), value);
  };

  const scripts = async (): Promise<NinjaScript[]> => (await api.request<NinjaScript[]>("GET", "/v2/automation/scripts")) ?? [];
  const resolveScript = async (ref: string): Promise<NinjaScript> => {
    const value = ref.trim();
    const all = (await scripts()).filter((s) => s.active !== false);
    const byId = /^\d+$/.test(value) ? all.find((s) => s.id === Number(value)) : undefined;
    const matchesName = all.filter((s) => s.name.toLowerCase() === value.toLowerCase());
    const script = byId ?? (matchesName.length === 1 ? matchesName[0] : undefined);
    if (!script) {
      throw new ConnectorError(
        matchesName.length > 1
          ? `Several NinjaOne scripts are named "${value}" (ids ${matchesName.map((s) => s.id).join(", ")}). Use the script id.`
          : `No active NinjaOne script "${value}". Use ninja_list_scripts to find it.`,
      );
    }
    return script;
  };

  /** The device's owner (assigned end user) or, failing that, a last logged-in user that is an email/UPN. */
  const ownerOf = async ({ device }: { device: string }): Promise<string[]> => {
    const d = await resolveDevice(device);
    if (d.assignedOwnerUid) {
      const owner = (await api.endUsers(orgId)).find((u) => u.uid === d.assignedOwnerUid);
      if (owner?.email) return [owner.email.toLowerCase()];
    }
    const last = d.lastLoggedInUser?.split("\\").pop()?.trim().toLowerCase();
    return last && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(last) ? [last] : [];
  };

  const device = z.string().min(1).describe("NinjaOne device name (e.g. CON-LT-014) or numeric device id from ninja_list_devices");

  return [
    defineTool({
      name: "ninja_list_devices",
      description:
        "List this client's devices in NinjaOne RMM (workstations, servers, network devices) with online state and last contact. Use it to find a device's name or id, or to answer 'which machines are offline'.",
      input: z.object({
        search: z.string().optional().describe("Part of the device name to filter by"),
        offlineOnly: z.boolean().default(false),
      }),
      risk: "read",
      run: async ({ search, offlineOnly }) => {
        const devices = (await api.organizationDevices(orgId))
          .filter((d) => matches(search, d.systemName, d.displayName, d.dnsName))
          .filter((d) => !offlineOnly || d.offline);
        return { count: devices.length, devices: devices.slice(0, 200).map(summary) };
      },
    }),
    defineTool({
      name: "ninja_get_device",
      description:
        "Get one NinjaOne device: OS and build, last boot, pending reboot, last contact, last logged-in user, hardware, disk volumes with free space, and pending OS patches. Use it when troubleshooting a specific machine.",
      input: z.object({ device }),
      risk: "read",
      run: async ({ device: ref }) => {
        const d = await resolveDevice(ref);
        const [volumes, patches] = await Promise.allSettled([
          api.request<Array<{ name?: string; driveLetter?: string; label?: string; capacity?: number; freeSpace?: number; fileSystem?: string }>>("GET", `/v2/device/${d.id}/volumes`),
          api.request<Array<{ name?: string; kbNumber?: string; severity?: string; status?: string; type?: string }>>("GET", `/v2/device/${d.id}/os-patches`, { status: "PENDING" }),
        ]);
        return {
          ...summary(d),
          organizationId: d.organizationId,
          os: d.os ? { name: d.os.name, build: d.os.buildNumber, release: d.os.releaseId, lastBoot: iso(d.os.lastBootTime), needsReboot: d.os.needsReboot ?? null } : null,
          hardware: d.system ? { manufacturer: d.system.manufacturer, model: d.system.model, serialNumber: d.system.serialNumber ?? d.system.biosSerialNumber, domain: d.system.domain } : null,
          lastLoggedInUser: d.lastLoggedInUser ?? null,
          publicIP: d.publicIP ?? null,
          ipAddresses: d.ipAddresses ?? [],
          volumes:
            volumes.status === "fulfilled"
              ? (volumes.value ?? []).map((v) => ({ name: v.driveLetter || v.name, label: v.label, fileSystem: v.fileSystem, totalGB: gb(v.capacity), freeGB: gb(v.freeSpace) }))
              : `unavailable (${(volumes.reason as Error).message})`,
          pendingPatches:
            patches.status === "fulfilled"
              ? { count: (patches.value ?? []).length, items: (patches.value ?? []).slice(0, 15).map((p) => ({ name: p.name, kb: p.kbNumber, severity: p.severity, type: p.type })) }
              : `unavailable (${(patches.reason as Error).message})`,
        };
      },
    }),
    defineTool({
      name: "ninja_list_alerts",
      description:
        "List active NinjaOne alerts (triggered monitoring conditions: disk space, offline, CPU, AV, failed patches…) for this client's devices, newest first. Check it when a user reports a slow, full or failing machine.",
      input: z.object({ device: z.string().optional().describe("Only alerts for this device (name or id)") }),
      risk: "read",
      run: async ({ device: ref }) => {
        const devices = await api.organizationDevices(orgId);
        const names = new Map(devices.map((d) => [d.id, d.systemName || d.displayName || String(d.id)]));
        const only = ref ? (await resolveDevice(ref)).id : null;
        const alerts =
          (await api.request<Array<Record<string, unknown> & { deviceId?: number; createTime?: number }>>("GET", "/v2/alerts", { df: `org = ${orgId}` })) ?? [];
        // The device filter scopes the request; this keeps the result to the client's devices even if it were ignored.
        return alerts
          .filter((a) => typeof a.deviceId === "number" && names.has(a.deviceId) && (only === null || a.deviceId === only))
          .sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0))
          .slice(0, 100)
          .map((a) => ({
            uid: a.uid,
            device: names.get(a.deviceId!),
            deviceId: a.deviceId,
            severity: a.severity ?? null,
            priority: a.priority ?? null,
            subject: a.subject ?? a.conditionName ?? null,
            message: a.message ?? null,
            source: a.sourceName ?? a.sourceType ?? null,
            created: iso(a.createTime),
          }));
      },
    }),
    defineTool({
      name: "ninja_list_scripts",
      description:
        "List the MSP's NinjaOne automation scripts (id, name, language, OS, parameters). Use it before ninja_run_script to pick an existing, approved script; you can't write new scripts.",
      input: z.object({ search: z.string().optional().describe("Part of the script name or description") }),
      risk: "read",
      run: async ({ search }) =>
        (await scripts())
          .filter((s) => s.active !== false && matches(search, s.name, s.description))
          .slice(0, 100)
          .map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description ?? "",
            language: s.language,
            operatingSystems: s.operatingSystems ?? [],
            variables: (s.scriptVariables ?? []).map((v) => ({ name: v.name, type: v.type, required: v.required ?? false, description: v.description })),
          })),
    }),
    defineTool({
      name: "ninja_run_script",
      description:
        "Run one of the MSP's existing NinjaOne automation scripts on one of this client's devices (e.g. clear the print spooler, flush DNS, restart a service, run a cleanup). The device must be online; results show up in NinjaOne's activity log, so check the device afterwards. Pick the script from ninja_list_scripts.",
      input: z.object({
        device,
        script: z.string().min(1).describe("Script name exactly as listed by ninja_list_scripts, or its numeric id"),
        parameters: z.string().max(2000).optional().describe("Script parameters as a single string, if the script takes any"),
        runAs: z.enum(["system", "loggedonuser"]).default("system").describe("Run as SYSTEM (default) or as the logged-on user"),
      }),
      risk: "write",
      describe: (i) => `Run NinjaOne script "${i.script}" on ${i.device}${i.parameters ? ` with parameters "${i.parameters}"` : ""}${i.runAs === "loggedonuser" ? " as the logged-on user" : ""}`,
      resolveTargets: ownerOf,
      guard: async ({ device: ref, script }) => {
        await resolveDevice(ref);
        const s = await resolveScript(script);
        return RISKY_SCRIPT.test(s.name) ? `The script "${s.name}" looks like it removes or disables something, so a technician reviews it.` : null;
      },
      run: async ({ device: ref, script, parameters, runAs }) => {
        const d = await resolveDevice(ref);
        const s = await resolveScript(script);
        await api.request("POST", `/v2/device/${d.id}/script/run`, undefined, {
          type: "SCRIPT",
          id: s.id,
          ...(parameters ? { parameters } : {}),
          runAs,
        });
        return { started: true, device: summary(d).name, deviceId: d.id, script: s.name, scriptId: s.id, note: "NinjaOne queued the script; check the device's activities for the result." };
      },
    }),
    defineTool({
      name: "ninja_reboot_device",
      description:
        "Restart one of this client's devices through NinjaOne (normal reboot; the user's apps are asked to close, unsaved work may be lost). Confirm with the user that they've saved their work first. Forced reboots aren't available.",
      input: z.object({ device, reason: z.string().max(200).optional().describe("Reason recorded in NinjaOne") }),
      risk: "destructive",
      describe: (i) => `Restart ${i.device} (normal reboot) via NinjaOne${i.reason ? `: ${i.reason}` : ""}`,
      resolveTargets: ownerOf,
      run: async ({ device: ref, reason }) => {
        const d = await resolveDevice(ref);
        await api.request("POST", `/v2/device/${d.id}/reboot/NORMAL`, undefined, { reason: reason ?? "Requested through Haley" });
        return { rebooting: true, device: summary(d).name, deviceId: d.id, mode: "NORMAL" };
      },
    }),
  ];
}
