import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Store } from "../store.js";
import { WEEKDAYS } from "../types.js";
import { isTime, isTimeZone, isWorking, nextOn } from "../workingHours.js";

class TechnicianRouteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const name = z.string().trim().min(1).max(80);
const email = z.string().trim().toLowerCase().email().max(254);
const slackUserId = z.string().trim().regex(/^[UW][A-Z0-9]{2,20}$/, "Slack user ids look like U0123ABCD");
const teamsAadId = z.string().trim().uuid("Teams ids are Entra object ids (a GUID)");

const range = z.tuple([z.string().refine(isTime, "Times are HH:MM"), z.string().refine(isTime, "Times are HH:MM")]).refine(([a, b]) => a !== b, "A range can't start and end at the same time");
const workingHours = z.object({
  tz: z.string().trim().refine(isTimeZone, "Unknown time zone"),
  days: z.object(Object.fromEntries(WEEKDAYS.map((d) => [d, z.array(range).max(4).optional()])) as Record<(typeof WEEKDAYS)[number], z.ZodOptional<z.ZodArray<typeof range>>>),
  awayUntil: z.iso.date().nullable().default(null),
});
// PSA member/resource ids per connection; an empty value removes one.
const psaRefs = z.record(z.string().min(1).max(64), z.string().trim().max(64));

const SUGGESTION_DAYS = 90;
const isUnique = (err: unknown) => err instanceof Error && /UNIQUE constraint failed: technicians\.(\w+)/.exec(err.message)?.[1];

/**
 * The MSP's technicians: who they are, and their Slack and Teams identities so they can decide approvals
 * from chat. Names are the dashboard sign-in names, so renaming one also updates client policy rules that
 * name them as an approver.
 */
export function registerTechnicianRoutes(app: FastifyInstance, store: Store, actor: (req: FastifyRequest) => string): void {
  const parse = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> => {
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success) throw new TechnicianRouteError(400, z.prettifyError(parsed.error));
    return parsed.data;
  };
  const conflict = (err: unknown): never => {
    const column = isUnique(err);
    if (column) {
      const what = column === "name" ? "name" : column === "email" ? "email" : column === "slack_user_id" ? "Slack account" : "Teams account";
      throw new TechnicianRouteError(409, `Another technician already has that ${what}.`);
    }
    throw err;
  };

  /** Names seen as dashboard actors or as rule approvers that aren't in the directory yet. */
  const suggestions = (): string[] => {
    const known = new Set(store.listTechnicians().map((t) => t.name.toLowerCase()));
    const to = new Date();
    const from = new Date(to.getTime() - SUGGESTION_DAYS * 86_400_000);
    const names = new Map<string, string>();
    const add = (n: string) => {
      const key = n.trim().toLowerCase();
      if (key && !known.has(key) && !names.has(key)) names.set(key, n.trim());
    };
    store.activeTechnicians(from.toISOString(), to.toISOString()).forEach(add);
    for (const org of store.listOrgs()) for (const rule of org.settings.policyRules) rule.approvers.forEach(add);
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  };

  app.get("/api/technicians", async () => {
    const now = Date.now();
    const technicians = store.listTechnicians().map((t) => {
      const working = isWorking(t.working_hours, now);
      return { ...t, working, nextOn: working ? null : nextOn(t.working_hours, now) };
    });
    return { technicians, suggestions: suggestions() };
  });

  app.post("/api/technicians", async (req) => {
    const input = parse(z.object({ name, email: email.optional() }), req.body);
    const existing = store.listTechnicians().find((t) => t.name.toLowerCase() === input.name.toLowerCase());
    if (existing && !existing.active) {
      throw new TechnicianRouteError(409, `${existing.name} is in the directory but inactive. Reactivate them instead.`);
    }
    let created;
    try {
      created = store.createTechnician(input);
    } catch (err) {
      conflict(err);
    }
    store.audit({ orgId: null, actor: actor(req), action: "technician.created", target: created!.id, detail: { name: created!.name } });
    return created!;
  });

  app.patch<{ Params: { id: string } }>("/api/technicians/:id", async (req) => {
    const current = store.getTechnician(req.params.id);
    if (!current) throw new TechnicianRouteError(404, "Technician not found");
    const patch = parse(
      z.object({
        name: name.optional(),
        email: email.nullable().optional(),
        slackUserId: slackUserId.nullable().optional(),
        teamsAadId: teamsAadId.nullable().optional(),
        active: z.boolean().optional(),
        workingHours: workingHours.nullable().optional(),
        psaRefs: psaRefs.optional(),
      }),
      req.body,
    );
    if (patch.psaRefs) {
      for (const id of Object.keys(patch.psaRefs)) if (!store.getPsaConnection(id)) throw new TechnicianRouteError(400, `Unknown PSA connection ${id}`);
      patch.psaRefs = Object.fromEntries(Object.entries({ ...current.psa_refs, ...patch.psaRefs }).filter(([, v]) => v !== ""));
      for (const [connectionId, ref] of Object.entries(patch.psaRefs)) {
        const other = store.listTechnicians().find((t) => t.id !== current.id && t.psa_refs[connectionId] === ref);
        if (other) throw new TechnicianRouteError(409, `${other.name} already has that PSA id.`);
      }
    }
    let updated;
    try {
      updated = store.updateTechnician(current.id, patch)!;
    } catch (err) {
      conflict(err);
    }
    const who = actor(req);
    const renamed = patch.name !== undefined && patch.name !== current.name;
    const rulesUpdated = renamed ? renameApprover(store, current.name, updated!.name) : 0;
    store.audit({
      orgId: null,
      actor: who,
      action: patch.active === false && current.active ? "technician.deactivated" : patch.active && !current.active ? "technician.reactivated" : "technician.updated",
      target: current.id,
      detail: { fields: Object.keys(patch), ...(renamed ? { from: current.name, to: updated!.name, rulesUpdated } : {}) },
    });
    return updated!;
  });

  /** Technicians are deactivated, never deleted, so audit entries and past approvals keep their names. */
  app.delete<{ Params: { id: string } }>("/api/technicians/:id", async (req) => {
    const current = store.getTechnician(req.params.id);
    if (!current) throw new TechnicianRouteError(404, "Technician not found");
    const updated = store.updateTechnician(current.id, { active: false })!;
    if (current.active) store.audit({ orgId: null, actor: actor(req), action: "technician.deactivated", target: current.id, detail: { name: current.name } });
    return updated;
  });
}

/** Rewrites an approver name in every client's policy rules. Returns how many rules changed. */
function renameApprover(store: Store, from: string, to: string): number {
  let changed = 0;
  for (const org of store.listOrgs()) {
    let touched = false;
    const policyRules = org.settings.policyRules.map((rule) => {
      if (!rule.approvers.some((a) => a.toLowerCase() === from.toLowerCase())) return rule;
      touched = true;
      changed++;
      return { ...rule, approvers: rule.approvers.map((a) => (a.toLowerCase() === from.toLowerCase() ? to : a)) };
    });
    if (touched) store.updateOrg(org.id, { settings: { policyRules } });
  }
  return changed;
}
