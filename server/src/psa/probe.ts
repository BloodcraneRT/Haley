import type { PsaAdapter } from "./types.js";

/** One field across the items a probe read: its type(s) and how many items had it filled in. Never values. */
export interface ProbeField {
  field: string;
  types: string[];
  filled: number;
  total: number;
}

export interface ProbeStep {
  method: string;
  ok: boolean;
  ms: number;
  /** A count or the error message; never ticket content. */
  detail: string;
  fields: ProbeField[];
}

const LOOKBACK_DAYS = 30;
const SAMPLE = 5;

const typeOf = (v: unknown) => (v === null || v === undefined ? "null" : Array.isArray(v) ? "array" : typeof v);
const isFilled = (v: unknown) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

/**
 * Which fields a set of items had, by name, with their types and how many were filled in. Nested objects are
 * flattened one level ("owner.email"); arrays are counted, not opened, except where named in `open`.
 */
export function fieldShapes(items: Array<Record<string, unknown>>, open: string[] = []): ProbeField[] {
  const fields = new Map<string, { types: Set<string>; filled: number }>();
  const note = (name: string, value: unknown) => {
    const f = fields.get(name) ?? { types: new Set<string>(), filled: 0 };
    f.types.add(typeOf(value));
    if (isFilled(value)) f.filled++;
    fields.set(name, f);
  };
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [inner, v] of Object.entries(value)) note(`${key}.${inner}`, v);
      } else note(key, value);
    }
  }
  const shapes = [...fields].map(([field, f]) => ({ field, types: [...f.types].sort(), filled: f.filled, total: items.length }));
  for (const key of open) {
    const nested = items.flatMap((i) => (Array.isArray(i[key]) ? (i[key] as Array<Record<string, unknown>>) : []));
    if (nested.length) shapes.push(...fieldShapes(nested).map((s) => ({ ...s, field: `${key}[].${s.field}` })));
  }
  return shapes;
}

async function step(method: string, run: () => Promise<{ detail: string; fields?: ProbeField[] }>): Promise<ProbeStep> {
  const started = Date.now();
  try {
    const { detail, fields = [] } = await run();
    return { method, ok: true, ms: Date.now() - started, detail, fields };
  } catch (err) {
    return { method, ok: false, ms: Date.now() - started, detail: err instanceof Error ? err.message : String(err), fields: [] };
  }
}

/**
 * Read-only check of what a PSA actually returns, for verifying queries built from vendor docs against a live
 * tenant. Calls the connection test, the closed-ticket query (30 days, 5 tickets) and one ticket read, and
 * reports which fields came back and how often they were filled in. Makes no changes; returns no values.
 */
export async function probePsa(adapter: PsaAdapter, nowMs = Date.now()): Promise<ProbeStep[]> {
  const steps: ProbeStep[] = [];
  steps.push(await step("test", async () => ({ detail: await adapter.test() })));

  let sampleId: string | null = null;
  if (adapter.listClosedTickets) {
    const list = adapter.listClosedTickets.bind(adapter);
    steps.push(
      await step("listClosedTickets", async () => {
        const to = new Date(nowMs).toISOString();
        const from = new Date(nowMs - LOOKBACK_DAYS * 86_400_000).toISOString();
        const tickets = await list(from, to, { max: SAMPLE });
        sampleId = tickets[0]?.id ?? null;
        return { detail: `${tickets.length} closed in the last ${LOOKBACK_DAYS} days (reads at most ${SAMPLE})`, fields: fieldShapes(tickets as never) };
      }),
    );
  } else {
    steps.push({ method: "listClosedTickets", ok: false, ms: 0, detail: "Not supported by this PSA yet.", fields: [] });
  }

  if (sampleId) {
    const id = sampleId;
    steps.push(
      await step("getTicket", async () => {
        const ticket = await adapter.getTicket(id);
        return { detail: `1 ticket with ${ticket.comments.length} comments`, fields: fieldShapes([ticket as never], ["comments"]) };
      }),
    );
  }
  return steps;
}
