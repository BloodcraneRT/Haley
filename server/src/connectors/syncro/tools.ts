import { z } from "zod";
import { clip, matches, stripSecrets } from "../http.js";
import { ConnectorError, defineTool, type HaleyTool } from "../types.js";
import type { SyncroAlert, SyncroAsset, SyncroRmmApi } from "./api.js";

/** A Syncro script the MSP allowed Haley to run for this client. The API can't list scripts, so they're configured. */
export interface AllowedScript {
  id: number;
  name: string;
}

/** One script per line: "1234: Clear print spooler" (also "1234 - name", "1234, name" or just "1234"). */
export function parseAllowedScripts(raw: string | undefined): AllowedScript[] {
  const scripts: AllowedScript[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^\s*(\d{1,12})\s*(?:[:,\-–]\s*)?(.*)$/.exec(line);
    if (!m) throw new ConnectorError(`Couldn't read the script line "${line.trim()}". Use "<script id>: <name>", one per line.`);
    const id = Number(m[1]);
    if (scripts.some((s) => s.id === id)) continue;
    scripts.push({ id, name: m[2].trim() || `Script ${id}` });
  }
  return scripts;
}

/** Scripts whose names suggest they destroy data or disable things wait for a technician in every mode. */
const RISKY_SCRIPT = /\b(wipe|format|erase|factory|re-?image|decommission|uninstall|disable|bitlocker|encrypt|shutdown|delete|remove)\b/i;

const HEALTH_LABELS: Record<string, string> = {
  agent_offline_triggered: "Agent offline",
  low_hd_space_triggered: "Low disk space",
  smart_failure_triggered: "Disk SMART failure",
  bsod_triggered: "Blue screen (BSOD)",
  no_av_triggered: "No antivirus",
  firewall_triggered: "Firewall off",
  app_crash_triggered: "Application crashes",
  device_manager_triggered: "Device Manager errors",
  defrag_triggered: "Needs defragmentation",
  time_triggered: "Clock out of sync",
};

/** Syncro's own health checks that are currently tripped, as readable labels. */
export function healthIssues(asset: SyncroAsset): string[] {
  const triggers = asset.rmm_store?.triggers ?? {};
  return Object.entries(triggers)
    .filter(([, v]) => v === true || String(v).toLowerCase() === "true")
    .map(([k]) => HEALTH_LABELS[k] ?? k.replace(/_triggered$/, "").replace(/_/g, " "));
}

function summary(a: SyncroAsset) {
  return {
    id: a.id,
    name: a.name,
    type: a.asset_type ?? null,
    serial: a.asset_serial ?? null,
    healthIssues: healthIssues(a),
    updated: a.updated_at ?? null,
  };
}

function alertSummary(a: SyncroAlert, deviceNames: Map<number, string>) {
  return {
    id: a.id,
    device: (a.asset_id && deviceNames.get(a.asset_id)) || a.computer_name || null,
    deviceId: a.asset_id ?? null,
    description: a.description ?? null,
    detail: a.formatted_output ? clip(a.formatted_output, 600) : null,
    status: a.status ?? null,
    created: a.created_at,
    syncroTicket: a.ticket_number ?? null,
  };
}

const MUTE_FOR = ["1-hour", "1-day", "2-days", "1-week", "2-weeks", "1-month"] as const;

/**
 * SyncroMSP RMM tools for one client. Every call is scoped to the client's Syncro customer: device lookups
 * check the asset's customer_id, and alert lists only return that customer's alerts.
 */
export function syncroRmmTools(api: SyncroRmmApi, customerId: number, allowedScripts: AllowedScript[]): HaleyTool[] {
  const inCustomer = (a: SyncroAsset, ref: string) => {
    if (Number(a.customer_id) !== customerId) throw new ConnectorError(`Device ${ref} isn't one of this client's Syncro assets.`);
    return a;
  };

  const resolveDevice = async (ref: string): Promise<SyncroAsset> => {
    const value = ref.trim();
    if (/^\d+$/.test(value)) {
      const a = await api.asset(Number(value)).catch((err: ConnectorError) => {
        if (err.status === 404) throw new ConnectorError(`No Syncro asset with id ${value}. Use syncro_list_devices to find it.`, 404);
        throw err;
      });
      return inCustomer(a, value);
    }
    const lower = value.toLowerCase();
    const found = (await api.customerAssets(customerId, value)).filter((a) => a.name?.toLowerCase() === lower && Number(a.customer_id) === customerId);
    if (!found.length) throw new ConnectorError(`No Syncro device named "${value}" for this client. Use syncro_list_devices to find it.`);
    if (found.length > 1) throw new ConnectorError(`"${value}" matches ${found.length} devices (ids ${found.map((a) => a.id).join(", ")}). Use the device id.`);
    return inCustomer(await api.asset(found[0].id), value);
  };

  const resolveAlert = async (id: number): Promise<SyncroAlert> => {
    const alert = await api.alert(id).catch((err: ConnectorError) => {
      if (err.status === 404) throw new ConnectorError(`No Syncro alert ${id}.`, 404);
      throw err;
    });
    if (Number(alert.customer_id) !== customerId) throw new ConnectorError(`Alert ${id} isn't for this client.`);
    return alert;
  };

  const resolveScript = (ref: string): AllowedScript => {
    const value = ref.trim();
    const byId = /^\d+$/.test(value) ? allowedScripts.find((s) => s.id === Number(value)) : undefined;
    const byName = allowedScripts.filter((s) => s.name.toLowerCase() === value.toLowerCase());
    const script = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (!script) {
      throw new ConnectorError(
        byName.length > 1
          ? `Several allowed scripts are named "${value}" (ids ${byName.map((s) => s.id).join(", ")}). Use the script id.`
          : `"${value}" isn't one of the Syncro scripts this client allows Haley to run. Use syncro_list_scripts.`,
      );
    }
    return script;
  };

  /** The asset's assigned contact, so policy knows whose machine a change affects. */
  const ownerOf = async ({ device }: { device: string }): Promise<string[]> => {
    const a = await resolveDevice(device);
    if (!a.contact_id) return [];
    const contact = (await api.contacts(customerId)).find((c) => c.id === a.contact_id);
    return contact?.email ? [contact.email.toLowerCase()] : [];
  };

  const customerAlerts = async (): Promise<SyncroAlert[]> =>
    (await api.activeAlerts()).filter((a) => Number(a.customer_id) === customerId).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  const device = z.string().min(1).describe("Syncro device (asset) name, e.g. CON-LT-014, or its numeric id from syncro_list_devices");
  const alertId = z.number().int().positive().describe("Alert id from syncro_list_alerts");

  return [
    defineTool({
      name: "syncro_list_devices",
      description:
        "List this client's devices (assets) in SyncroMSP RMM with Syncro's health flags (agent offline, low disk, SMART failure, no antivirus, BSOD…). Pass user to find the computers assigned to a person, e.g. the requester.",
      input: z.object({
        search: z.string().optional().describe("Part of the device name or serial"),
        user: z.string().email().optional().describe("Only devices assigned to this contact's email"),
        withIssuesOnly: z.boolean().default(false),
      }),
      risk: "read",
      run: async ({ search, user, withIssuesOnly }) => {
        let assets: SyncroAsset[];
        if (user) {
          const contact = (await api.contacts(customerId)).find((c) => c.email?.toLowerCase() === user.toLowerCase());
          if (!contact) return { count: 0, devices: [], note: `${user} isn't a contact for this client in Syncro.` };
          assets = (await api.all<SyncroAsset>(`/customer_assets/assets_by_contact/${contact.id}`, "assets")).filter((a) => matches(search, a.name, a.asset_serial));
        } else {
          // Syncro applies the search itself (name, serial and other fields).
          assets = await api.customerAssets(customerId, search);
        }
        const devices = assets
          .filter((a) => Number(a.customer_id) === customerId)
          .map(summary)
          .filter((d) => !withIssuesOnly || d.healthIssues.length > 0);
        return { count: devices.length, devices: devices.slice(0, 200) };
      },
    }),
    defineTool({
      name: "syncro_get_device",
      description:
        "Get one Syncro device: type, serial, assigned contact, Syncro health flags, the properties the agent reports (OS, hardware…), and installed, missing and failed Windows patches. Use it when troubleshooting a specific machine.",
      input: z.object({ device }),
      risk: "read",
      run: async ({ device: ref }) => {
        const a = await resolveDevice(ref);
        type Patch = { kb?: string; title?: string; category?: string; status?: string };
        const [patches, contacts] = await Promise.allSettled([
          api.request<{ installed_patches?: Patch[]; available_patches?: Patch[]; available_patches_meta?: { total_entries?: number } }>("GET", `/customer_assets/${a.id}/patches`),
          a.contact_id ? api.contacts(customerId) : Promise.resolve([]),
        ]);
        const contact = contacts.status === "fulfilled" ? contacts.value.find((c) => c.id === a.contact_id) : undefined;
        const available = patches.status === "fulfilled" ? (patches.value.available_patches ?? []) : [];
        const byStatus = (s: string) => available.filter((p) => (p.status ?? "").toLowerCase().startsWith(s));
        const brief = (p: Patch) => ({ kb: p.kb, title: p.title, category: p.category });
        return {
          ...summary(a),
          assignedTo: contact ? { name: contact.name ?? null, email: contact.email ?? null } : null,
          // The agent's inventory varies by OS and agent version; secrets are stripped and the size capped.
          properties: clip(JSON.stringify(stripSecrets(a.properties ?? {})), 3000),
          patches:
            patches.status === "fulfilled"
              ? {
                  missing: byStatus("missing").length,
                  failed: byStatus("failed").length,
                  totalNotInstalled: patches.value.available_patches_meta?.total_entries ?? available.length,
                  failedItems: byStatus("failed").slice(0, 10).map(brief),
                  missingItems: byStatus("missing").slice(0, 15).map(brief),
                  recentlyInstalled: (patches.value.installed_patches ?? []).slice(0, 5).map(brief),
                }
              : `unavailable (${(patches.reason as Error).message})`,
        };
      },
    }),
    defineTool({
      name: "syncro_list_software",
      description: "List software installed on one of this client's Syncro devices (name, vendor, version). Use it to check whether an app is installed or which version.",
      input: z.object({ device, search: z.string().optional().describe("Part of the application name or vendor") }),
      risk: "read",
      run: async ({ device: ref, search }) => {
        const a = await resolveDevice(ref);
        const apps = await api.all<{ name: string; vendor?: string | null; version?: string | null; installed_at?: string | null }>(
          `/customer_assets/${a.id}/installed_applications`,
          "installed_applications",
          { per_page: 100 },
        );
        const found = apps.filter((x) => matches(search, x.name, x.vendor));
        return { device: a.name, count: found.length, applications: found.slice(0, 150) };
      },
    }),
    defineTool({
      name: "syncro_list_alerts",
      description:
        "List this client's active SyncroMSP RMM alerts (low disk, offline agent, failed services, event log errors, antivirus…), newest first. Check it when a user reports a slow, full or failing machine, or when working an alert ticket.",
      input: z.object({ device: z.string().optional().describe("Only alerts for this device (name or id)") }),
      risk: "read",
      run: async ({ device: ref }) => {
        const only = ref ? await resolveDevice(ref) : null;
        const alerts = (await customerAlerts()).filter((a) => !only || a.asset_id === only.id);
        const names = new Map(only ? [[only.id, only.name]] : []);
        return { count: alerts.length, alerts: alerts.slice(0, 100).map((a) => alertSummary(a, names)) };
      },
    }),
    defineTool({
      name: "syncro_list_scripts",
      description:
        "List the SyncroMSP scripts the MSP allowed Haley to run for this client (id and name). Use it before syncro_run_script; you can't run other scripts or write new ones.",
      input: z.object({}),
      risk: "read",
      run: async () => ({ scripts: allowedScripts, note: allowedScripts.length ? undefined : "No scripts are allowed for this client. A technician can add them on the client's Syncro integration." }),
    }),
    defineTool({
      name: "syncro_run_script",
      description:
        "Run one of the allowed SyncroMSP scripts on one of this client's devices now (e.g. clear the print spooler, clean temp files, restart a service). Syncro queues it for the agent; the result shows in Syncro's script history and the device's alerts, not here, so check the device or alerts afterwards.",
      input: z.object({
        device,
        script: z.string().min(1).describe("Script id or exact name from syncro_list_scripts"),
        variables: z
          .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(500))
          .optional()
          .describe("Runtime variables the script defines, as name → value"),
      }),
      risk: "write",
      describe: (i) => {
        const vars = i.variables && Object.keys(i.variables).length ? ` with ${Object.entries(i.variables).map(([k, v]) => `${k}=${v}`).join(", ")}` : "";
        return `Run Syncro script "${i.script}" on ${i.device}${vars}`;
      },
      resolveTargets: ownerOf,
      guard: async ({ device: ref, script }) => {
        await resolveDevice(ref);
        const s = resolveScript(script);
        return RISKY_SCRIPT.test(s.name) ? `The script "${s.name}" looks like it removes or disables something, so a technician reviews it.` : null;
      },
      run: async ({ device: ref, script, variables }) => {
        const a = await resolveDevice(ref);
        const s = resolveScript(script);
        await api.request("POST", `/rmm/public_scripts/${a.id}/schedule`, undefined, {
          script_id: s.id,
          run_type: "now",
          freq: "once",
          ...(variables && Object.keys(variables).length ? { script_options: { runtime_variables: variables } } : {}),
        });
        return { queued: true, device: a.name, deviceId: a.id, script: s.name, scriptId: s.id, note: "Syncro queued the script; check the device's alerts or ask the user in a few minutes." };
      },
    }),
    defineTool({
      name: "syncro_mute_alert",
      description: "Mute one of this client's SyncroMSP alerts for a while (e.g. while a fix takes effect or a part is on order). It stays open in Syncro.",
      input: z.object({ alertId, duration: z.enum(MUTE_FOR).default("1-day") }),
      risk: "write",
      describe: (i) => `Mute Syncro alert ${i.alertId} for ${i.duration}`,
      run: async ({ alertId: id, duration }) => {
        const alert = await resolveAlert(id);
        await api.request("POST", `/rmm_alerts/${id}/mute`, { mute_for: duration });
        return { muted: true, alertId: id, device: alert.computer_name ?? null, for: duration };
      },
    }),
    defineTool({
      name: "syncro_clear_alert",
      description:
        "Clear (resolve) one of this client's SyncroMSP alerts after you've confirmed the problem is fixed. Syncro raises it again if the condition comes back. Don't clear alerts you haven't fixed.",
      input: z.object({ alertId, reason: z.string().min(5).max(300).describe("What fixed it, for the record") }),
      risk: "write",
      describe: (i) => `Clear Syncro alert ${i.alertId}: ${i.reason}`,
      run: async ({ alertId: id }) => {
        const alert = await resolveAlert(id);
        await api.request("DELETE", `/rmm_alerts/${id}`);
        return { cleared: true, alertId: id, device: alert.computer_name ?? null, description: alert.description ?? null };
      },
    }),
  ];
}
