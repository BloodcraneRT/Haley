import type { Ticket } from "./types.js";

/** Words that say nothing about what's wrong. */
const STOP = new Set(
  `a about after again all also am an and any are as at be been before being but by can cannot could did do does doing don't down during each few for from
  further get getting got had has have having he her here hers him his how i i'm if in into is it it's its just keep keeps let me more most my myself no nor
  not now of off on once only or other our out over own please same she should so some still such than thank thanks that the their them then there these
  they this those through to too under until up very was we were what when where which while who why will with would you your hi hello hey help issue
  issues problem problems working work works doesn't isn't won't cant can't anymore today morning since trying try tried need needs anyone someone
  thing something able unable error errors urgent asap regarding request re fw fwd`.split(/\s+/),
);

/** Services that make a shared outage likely when several people mention the same one. */
const SERVICES = new Set(
  "outlook teams vpn wifi wi-fi internet network printer printers sharepoint onedrive email mail exchange phone phones voip zoom citrix rdp remote server sso login okta duo quickbooks erp crm website".split(" "),
);

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Meaningful, lightly stemmed words from text. */
export function tokens(text: string, limit = 60): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9'-]+/)) {
    const word = raw.replace(/^['-]+|['-]+$/g, "");
    if (word.length < 3 || STOP.has(word) || /^\d+$/.test(word)) continue;
    out.push(stem(word));
    if (out.length >= limit) break;
  }
  return out;
}

/** The words a ticket is about: its title counts double, plus the start of its description. */
export function ticketTerms(t: Pick<Ticket, "title" | "description">): Map<string, number> {
  const terms = new Map<string, number>();
  for (const w of tokens(t.title, 20)) terms.set(w, (terms.get(w) ?? 0) + 2);
  for (const w of tokens(t.description, 40)) terms.set(w, (terms.get(w) ?? 0) + 1);
  return terms;
}

/** 0–1: how much two tickets are about the same thing (shared terms over the smaller ticket's terms). */
export function similarity(a: Map<string, number>, b: Map<string, number>): { score: number; shared: string[] } {
  if (!a.size || !b.size) return { score: 0, shared: [] };
  const shared = [...a.keys()].filter((k) => b.has(k));
  const weight = (m: Map<string, number>, keys: Iterable<string>) => [...keys].reduce((n, k) => n + Math.min(m.get(k) ?? 0, 3), 0);
  const overlap = Math.min(weight(a, shared), weight(b, shared));
  const smaller = Math.min(weight(a, a.keys()), weight(b, b.keys()));
  return { score: smaller ? overlap / smaller : 0, shared };
}

const SERVICE_STEMS = new Set([...SERVICES].map(stem));

/** Whether shared terms name a service (Outlook, VPN, Teams…), the usual subject of an outage. */
export function namesService(shared: string[]): boolean {
  return shared.some((w) => SERVICE_STEMS.has(w));
}

/** Whether shared terms are specific enough to call it the same problem. */
export function specificMatch(shared: string[]): boolean {
  return shared.length >= 2 || namesService(shared);
}

export interface ScoredTicket {
  ticket: Ticket;
  score: number;
  shared: string[];
}

/** The tickets most like `target`, best first, above `min`. */
export function rankSimilar(target: Ticket, candidates: Ticket[], min = 0.34, limit = 5): ScoredTicket[] {
  const terms = ticketTerms(target);
  return candidates
    .filter((c) => c.id !== target.id)
    .map((c) => ({ ticket: c, ...similarity(terms, ticketTerms(c)) }))
    .filter((s) => s.score >= min && specificMatch(s.shared))
    .sort((a, b) => b.score - a.score || b.ticket.created_at.localeCompare(a.ticket.created_at))
    .slice(0, limit);
}
