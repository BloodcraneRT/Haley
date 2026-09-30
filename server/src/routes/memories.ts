import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Store } from "../store.js";

class MemoryRouteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const content = z.string().trim().min(3).max(400);

/**
 * Technicians review, confirm, edit and remove what Haley remembers about each client. Notes Haley saved
 * from an end user's ticket stay "pending" (unused) until someone confirms them here.
 */
export function registerMemoryRoutes(app: FastifyInstance, store: Store, actor: (req: FastifyRequest) => string): void {
  const parse = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> => {
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success) throw new MemoryRouteError(400, z.prettifyError(parsed.error));
    return parsed.data;
  };
  const memory = (id: string) => {
    const m = store.getMemory(id);
    if (!m) throw new MemoryRouteError(404, "Note not found");
    return m;
  };

  app.get<{ Params: { id: string } }>("/api/orgs/:id/memories", async (req) => {
    if (!store.getOrg(req.params.id)) throw new MemoryRouteError(404, "Organization not found");
    return store.listMemories(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/orgs/:id/memories", async (req) => {
    const org = store.getOrg(req.params.id);
    if (!org) throw new MemoryRouteError(404, "Organization not found");
    const input = parse(z.object({ content }), req.body);
    const who = actor(req);
    const created = store.createMemory({ orgId: org.id, content: input.content, status: "active", source: "technician", createdBy: who });
    store.audit({ orgId: org.id, actor: who, action: "memory.created", target: created.id, detail: { status: "active" } });
    return created;
  });

  app.patch<{ Params: { id: string } }>("/api/memories/:id", async (req) => {
    const current = memory(req.params.id);
    const patch = parse(z.object({ content: content.optional(), status: z.literal("active").optional() }), req.body);
    const who = actor(req);
    const updated = store.updateMemory(current.id, { ...patch, reviewedBy: who })!;
    const confirmed = current.status === "pending" && updated.status === "active";
    store.audit({
      orgId: current.org_id,
      actor: who,
      action: confirmed ? "memory.confirmed" : "memory.updated",
      target: current.id,
      detail: { edited: patch.content !== undefined && patch.content !== current.content },
    });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/memories/:id", async (req) => {
    const current = memory(req.params.id);
    store.deleteMemory(current.id);
    store.audit({ orgId: current.org_id, actor: actor(req), action: current.status === "pending" ? "memory.discarded" : "memory.deleted", target: current.id });
    return { ok: true };
  });
}
