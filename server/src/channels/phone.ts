import type { Connector } from "../connectors/types.js";
import type { Store } from "../store.js";
import type { Org } from "../types.js";
import type { ChannelHub } from "./hub.js";

/** A call as a voice service reports it, after the webhook's checks. */
export interface PhoneCall {
  callId: string;
  from: string;
  to: string;
  startedAt?: string;
  durationSec?: number;
  callerName?: string;
  company?: string;
  summary?: string;
  transcript: string;
  recordingUrl?: string;
}

export interface DirectoryPerson {
  name: string;
  email: string;
  phones: string[];
}

const DIRECTORY_TTL_MS = 24 * 3_600_000;
const MAX_TRANSCRIPT = 20_000;
const COMPANY_MATCH = 0.8;

const digits = (phone: string) => phone.replace(/x\d*$/i, "").replace(/\D/g, "");

/**
 * Whether two numbers are the same line. Directories store numbers every which way ("(425) 555-0109",
 * "+1 425 555 0109"), so the last ten digits decide when both have them; shorter numbers must match exactly.
 */
export function samePhone(a: string, b: string): boolean {
  const x = digits(a);
  const y = digits(b);
  if (x.length < 7 || y.length < 7) return false;
  return x.length >= 10 && y.length >= 10 ? x.slice(-10) === y.slice(-10) : x === y;
}

const SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|group|the)\b/g;
const simplify = (name: string) => name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(SUFFIXES, " ").replace(/\s+/g, " ").trim();

/** 0–1 similarity of two company names, ignoring case, punctuation and suffixes like "Ltd" (edit distance). */
export function nameSimilarity(a: string, b: string): number {
  const x = simplify(a);
  const y = simplify(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

/**
 * Who in each client's directory (Microsoft 365, Google Workspace) has which phone numbers, read with the
 * client's own read tools and kept for a day per client, so matching a caller doesn't call the directory each time.
 */
export class PhoneDirectory {
  private readonly cache = new Map<string, { at: number; people: DirectoryPerson[] }>();

  constructor(
    private readonly store: Store,
    private readonly connectorsFor: (orgId: string) => Connector[],
    private readonly nowMs: () => number = Date.now,
  ) {}

  async people(orgId: string): Promise<DirectoryPerson[]> {
    const hit = this.cache.get(orgId);
    if (hit && this.nowMs() - hit.at < DIRECTORY_TTL_MS) return hit.people;
    const people: DirectoryPerson[] = [];
    const ctx = { orgId, runId: "", ticketId: null };
    for (const connector of this.connectorsFor(orgId)) {
      for (const tool of connector.tools) {
        try {
          if (tool.name === "m365_list_users") {
            const users = (await tool.run({}, ctx)) as Array<{ displayName: string; mail: string | null; userPrincipalName: string; accountEnabled: boolean; phones?: string[] }>;
            for (const u of users) {
              if (u.accountEnabled && u.phones?.length) people.push({ name: u.displayName, email: (u.mail ?? u.userPrincipalName).toLowerCase(), phones: u.phones });
            }
          } else if (tool.name === "gws_list_users") {
            const users = (await tool.run({}, ctx)) as Array<{ name: string; primaryEmail: string; suspended: boolean; phones?: string[]; recoveryPhone: string | null }>;
            for (const u of users) {
              const phones = [...(u.phones ?? []), ...(u.recoveryPhone ? [u.recoveryPhone] : [])];
              if (!u.suspended && phones.length) people.push({ name: u.name, email: u.primaryEmail.toLowerCase(), phones });
            }
          }
        } catch {
          // A directory that can't be read just doesn't match anyone.
        }
      }
    }
    this.cache.set(orgId, { at: this.nowMs(), people });
    return people;
  }

  /** The one person in a client's directory with this number; null when nobody or more than one person has it. */
  async match(orgId: string, phone: string): Promise<DirectoryPerson | null> {
    const found = (await this.people(orgId)).filter((p) => p.phones.some((n) => samePhone(n, phone)));
    return found.length === 1 ? found[0] : null;
  }

  /** The client and person a number belongs to, across every client with a directory connected; null unless exactly one. */
  async find(phone: string): Promise<{ org: Org; person: DirectoryPerson } | null> {
    const hits: Array<{ org: Org; person: DirectoryPerson }> = [];
    for (const org of this.store.listOrgs()) {
      if (!this.store.listIntegrations(org.id).some((i) => i.provider === "m365" || i.provider === "google")) continue;
      const person = await this.match(org.id, phone);
      if (person) hits.push({ org, person });
    }
    return hits.length === 1 ? hits[0] : null;
  }
}

export type CallOutcome =
  | { status: "created"; ticketId: string; ticketNumber: number; orgId: string; matched: boolean; runId: string | null }
  | { status: "duplicate"; ticketId: string; ticketNumber: number }
  | { status: "unmatched" };

const when = (call: PhoneCall) => {
  const parts = [call.startedAt ? new Date(call.startedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "", call.durationSec ? `${Math.round(call.durationSec / 60) || 1} min` : ""].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
};

/**
 * Turns a transcribed call into a ticket. The client comes from the number dialled, else from the caller's number
 * in a client directory, else (as a guess a technician confirms) from the company the caller named. The caller is
 * never more than unverified: replies go to the matched person's email, and the recording is kept as a link only.
 */
export async function handleCall(deps: { store: Store; hub: ChannelHub; directory: PhoneDirectory }, call: PhoneCall): Promise<CallOutcome> {
  const { store, hub, directory } = deps;
  const existing = store.findTicketByChannelRef("phone", "callId", call.callId);
  if (existing) return { status: "duplicate", ticketId: existing.id, ticketNumber: existing.number };

  const orgs = store.listOrgs();
  let org: Org | null = orgs.find((o) => o.settings.phoneNumbers.some((n) => samePhone(n, call.to))) ?? null;
  let person: DirectoryPerson | null = org ? await directory.match(org.id, call.from) : null;
  if (!org) {
    const found = await directory.find(call.from);
    if (found) ({ org, person } = found);
  }
  let guessed = false;
  if (!org && call.company?.trim()) {
    const ranked = orgs.map((o) => ({ o, score: nameSimilarity(call.company!, o.name) })).sort((a, b) => b.score - a.score);
    if (ranked[0] && ranked[0].score >= COMPANY_MATCH && ranked[0].score > (ranked[1]?.score ?? 0)) {
      org = ranked[0].o;
      guessed = true;
    }
  }
  if (!org) {
    store.audit({ actor: "phone", action: "phone.unmatched", target: call.callId, detail: { from: call.from, to: call.to, company: call.company ?? "" } });
    return { status: "unmatched" };
  }

  const caller = person
    ? `Caller ID ${call.from} matches ${person.name} (${person.email}) in the client's directory. Caller ID can be faked: this is not proof of who called.`
    : `Caller ID ${call.from} doesn't match anyone in the client's directory.`;
  const said = [call.callerName ? `name "${call.callerName}"` : "", call.company ? `company "${call.company}"` : ""].filter(Boolean).join(", ");
  const description = [
    `Phone call from ${call.from} to ${call.to}${when(call)}.`,
    caller,
    said ? `The caller gave their ${said}.` : "",
    guessed ? `The client was guessed from the company the caller named; a technician should confirm it before working this ticket.` : "",
    call.summary?.trim() ? `\nSummary (from the call service):\n${call.summary.trim()}` : "",
    `\nTranscript:\n${call.transcript.trim().slice(0, MAX_TRANSCRIPT)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const firstLine = call.summary?.trim().split("\n")[0]?.slice(0, 120);
  const subject = firstLine || `Phone call from ${person?.name || call.callerName || call.from}`;
  const ref: Record<string, string> = { callId: call.callId, from: call.from, to: call.to, ...(call.recordingUrl ? { recordingUrl: call.recordingUrl } : {}) };

  if (guessed) {
    // Not sure whose ticket it is: a technician confirms it before anyone (Haley included) works it.
    const ticket = store.createTicket({
      orgId: org.id,
      title: subject,
      description,
      requesterName: call.callerName || call.from,
      requesterEmail: "",
      author: "phone",
      channel: "phone",
      channelRef: ref,
      assurance: "none",
      verification: `Phone call from ${call.from} (not verified)`,
    });
    store.updateTicket(ticket.id, { assignee: "unassigned" }, "system");
    store.addTicketEvent(ticket.id, "agent_note", "system", `Client guessed from the caller saying "${call.company}". Check it's right before working this ticket.`, { phoneGuess: true });
    store.audit({ orgId: org.id, actor: "phone", action: "ticket.created", target: ticket.id, detail: { number: ticket.number, from: call.from, guessed: true } });
    return { status: "created", ticketId: ticket.id, ticketNumber: ticket.number, orgId: org.id, matched: false, runId: null };
  }

  const received = await hub.receive({
    channel: "phone",
    org,
    sender: {
      name: person?.name || call.callerName || `Caller ${call.from}`,
      email: person?.email ?? null,
      assurance: "none",
      verification: person ? `Phone call; caller ID matched ${person.name}'s directory number (not proof of identity)` : `Phone call from ${call.from} (not verified)`,
    },
    subject,
    text: description,
    thread: null,
    ref,
  });
  return { status: "created", ticketId: received.ticketId, ticketNumber: received.ticketNumber, orgId: org.id, matched: Boolean(person), runId: received.runId };
}
