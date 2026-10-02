import type { HaleyTool } from "./connectors/types.js";
import type { Store } from "./store.js";
import type { Ticket } from "./types.js";

/** Each source gets this long before the snapshot shows it as unavailable. */
const SOURCE_TIMEOUT_MS = 15_000;
const STALE_DEVICE_DAYS = 7;

export type FlagLevel = "warning" | "info";
export interface SnapshotFlag {
  level: FlagLevel;
  text: string;
}

export interface SnapshotDevice {
  source: "Intune" | "Syncro";
  name: string;
  id: string;
  os: string | null;
  lastSeen: string | null;
  issues: string[];
}

export interface RequesterSnapshot {
  email: string;
  generatedAt: string;
  account: {
    source: "Microsoft 365" | "Google Workspace";
    name: string;
    enabled: boolean;
    title: string | null;
    department: string | null;
    licenses: string[];
    groups: string[];
    mfaMethods: string[] | null;
    lastSignIn: string | null;
    isAdmin: boolean | null;
  } | null;
  devices: SnapshotDevice[];
  recentTickets: Array<{ id: string; number: number; title: string; status: string; created_at: string }>;
  flags: SnapshotFlag[];
  /** Sources that failed or timed out, with why; the rest of the snapshot still shows. */
  unavailable: Array<{ source: string; error: string }>;
}

type Json = Record<string, any>;

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} didn't answer within ${SOURCE_TIMEOUT_MS / 1000}s`)), SOURCE_TIMEOUT_MS).unref())]);
}

const days = (iso: string | null | undefined, now: number) => (iso ? (now - Date.parse(iso)) / 86_400_000 : null);
const names = (items: unknown): string[] =>
  Array.isArray(items) ? items.map((x) => (typeof x === "string" ? x : String((x as Json)?.displayName ?? (x as Json)?.name ?? (x as Json)?.email ?? ""))).filter(Boolean) : [];

/** Microsoft's method types read as plain names; "password" alone means no MFA. */
const MFA_LABELS: Record<string, string> = {
  microsoftAuthenticator: "Authenticator app",
  phone: "Phone (SMS/call)",
  fido2: "Security key",
  windowsHelloForBusiness: "Windows Hello",
  softwareOath: "Authenticator code",
  temporaryAccessPass: "Temporary Access Pass",
  email: "Email",
  password: "Password",
};

/**
 * Who the requester is and what state their account and devices are in, gathered from the client's
 * connected systems with read-only tools, plus their recent tickets. For the technician's side panel;
 * nothing here goes to the model.
 */
export async function requesterSnapshot(store: Store, ticket: Ticket, tools: Map<string, HaleyTool>, nowMs = Date.now()): Promise<RequesterSnapshot> {
  const email = ticket.requester_email.toLowerCase();
  const snapshot: RequesterSnapshot = { email, generatedAt: new Date(nowMs).toISOString(), account: null, devices: [], recentTickets: [], flags: [], unavailable: [] };
  const ctx = { orgId: ticket.org_id, runId: "", ticketId: ticket.id };
  const call = async (name: string, input: unknown, label: string): Promise<Json | Json[] | null> => {
    const tool = tools.get(name);
    if (!tool || tool.risk !== "read") return null;
    try {
      return (await withTimeout(tool.run(input, ctx), label)) as Json | Json[];
    } catch (err) {
      snapshot.unavailable.push({ source: label, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  const recent = store
    .listTickets({ orgId: ticket.org_id, limit: 500 })
    .filter((t) => t.id !== ticket.id && email && t.requester_email.toLowerCase() === email)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  snapshot.recentTickets = recent.slice(0, 8).map((t) => ({ id: t.id, number: t.number, title: t.title, status: t.status, created_at: t.created_at }));
  const lastMonth = recent.filter((t) => (days(t.created_at, nowMs) ?? 99) <= 30).length;
  if (lastMonth >= 3) snapshot.flags.push({ level: "info", text: `${lastMonth} other tickets in the last 30 days` });

  if (!email) {
    snapshot.flags.push({ level: "info", text: "No requester email on this ticket, so their account and devices can't be looked up." });
    return snapshot;
  }

  const [m365, google, intune, syncro] = await Promise.all([
    call("m365_get_user", { user: email }, "Microsoft 365"),
    call("gws_get_user", { email }, "Google Workspace"),
    call("m365_list_devices", { user: email }, "Intune"),
    call("syncro_list_devices", { user: email }, "Syncro"),
  ]);

  if (m365 && !Array.isArray(m365)) {
    const methods = Array.isArray(m365.mfaMethods)
      ? (m365.mfaMethods as Json[]).filter((m) => m.type !== "unavailable").map((m) => MFA_LABELS[String(m.type)] ?? String(m.type))
      : null;
    const mfaUnavailable = Array.isArray(m365.mfaMethods) && (m365.mfaMethods as Json[]).some((m) => m.type === "unavailable");
    snapshot.account = {
      source: "Microsoft 365",
      name: String(m365.displayName ?? email),
      enabled: m365.accountEnabled !== false,
      title: m365.jobTitle ?? null,
      department: m365.department ?? null,
      licenses: names(m365.licenses),
      groups: names(m365.groups),
      mfaMethods: mfaUnavailable ? null : methods,
      lastSignIn: null,
      isAdmin: null,
    };
  } else if (google && !Array.isArray(google)) {
    snapshot.account = {
      source: "Google Workspace",
      name: String(google.name ?? email),
      enabled: !google.suspended,
      title: null,
      department: google.orgUnitPath ?? null,
      licenses: [],
      groups: names(google.groups),
      mfaMethods: google.isEnrolledIn2Sv ? ["2-Step Verification"] : [],
      lastSignIn: google.lastLoginTime ?? null,
      isAdmin: Boolean(google.isAdmin),
    };
  }

  const account = snapshot.account;
  if (account) {
    if (!account.enabled) snapshot.flags.push({ level: "warning", text: account.source === "Google Workspace" ? "Account is suspended" : "Sign-in is blocked (account disabled)" });
    if (account.mfaMethods && !account.mfaMethods.some((m) => m !== "Password")) snapshot.flags.push({ level: "warning", text: "No MFA method registered" });
    if (account.source === "Microsoft 365" && !account.licenses.length) snapshot.flags.push({ level: "warning", text: "No license assigned" });
    if (account.isAdmin) snapshot.flags.push({ level: "info", text: "Has admin rights" });
  } else if (tools.has("m365_get_user") || tools.has("gws_get_user")) {
    if (!snapshot.unavailable.length) snapshot.flags.push({ level: "warning", text: `${email} wasn't found in the client's directory` });
  }

  for (const d of Array.isArray(intune) ? intune : []) {
    const issues: string[] = [];
    const state = String(d.complianceState ?? "").toLowerCase();
    if (state && state !== "compliant" && state !== "unknown") issues.push(`Not compliant (${d.complianceState})`);
    const stale = days(d.lastSyncDateTime, nowMs);
    if (stale !== null && stale > STALE_DEVICE_DAYS) issues.push(`No check-in for ${Math.floor(stale)} days`);
    if (typeof d.freeStorageSpaceInBytes === "number" && typeof d.totalStorageSpaceInBytes === "number" && d.totalStorageSpaceInBytes > 0) {
      const free = d.freeStorageSpaceInBytes / d.totalStorageSpaceInBytes;
      if (free < 0.1) issues.push(`Low disk (${Math.round(free * 100)}% free)`);
    }
    if (d.isEncrypted === false) issues.push("Not encrypted");
    snapshot.devices.push({
      source: "Intune",
      name: String(d.deviceName ?? d.id),
      id: String(d.id),
      os: [d.operatingSystem, d.osVersion].filter(Boolean).join(" ") || null,
      lastSeen: d.lastSyncDateTime ?? null,
      issues,
    });
  }
  const syncroDevices = syncro && !Array.isArray(syncro) && Array.isArray(syncro.devices) ? (syncro.devices as Json[]) : [];
  for (const d of syncroDevices) {
    snapshot.devices.push({
      source: "Syncro",
      name: String(d.name ?? d.id),
      id: String(d.id),
      os: null,
      lastSeen: d.updated ?? null,
      issues: Array.isArray(d.healthIssues) ? d.healthIssues.map(String) : [],
    });
  }
  const troubled = snapshot.devices.filter((d) => d.issues.length);
  if (troubled.length) snapshot.flags.push({ level: "warning", text: `${troubled.length} device${troubled.length === 1 ? " has" : "s have"} issues: ${troubled.map((d) => d.name).join(", ")}` });
  return snapshot;
}
