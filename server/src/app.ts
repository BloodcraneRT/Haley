import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { AnthropicLlm, type LlmClient, type MessageParam } from "./agent/llm.js";
import { AgentService, RunConflictError } from "./agent/runner.js";
import { TASK_TEMPLATES } from "./agent/templates.js";
import type { HaleyConfig } from "./config.js";
import { buildConnector, PROVIDERS, providerInfo } from "./connectors/registry.js";
import { ConnectorError, type Connector } from "./connectors/types.js";
import { openDb } from "./db.js";
import { seedDemo } from "./demo.js";
import { Store } from "./store.js";
import { buildTranscript } from "./transcript.js";
import { TICKET_PRIORITIES, TICKET_STATUSES, type Integration } from "./types.js";

export interface AppDeps {
  config: HaleyConfig;
  llm?: LlmClient;
  fetchImpl?: typeof fetch;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const notFound = (what: string) => new HttpError(404, `${what} not found`);

function body<S extends z.ZodType>(schema: S, req: FastifyRequest): z.infer<S> {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

function query<S extends z.ZodType>(schema: S, req: FastifyRequest): z.infer<S> {
  const parsed = schema.safeParse(req.query ?? {});
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

/** Technician display name from the UI; used for attribution in audit and approvals. */
const actor = (req: FastifyRequest) => {
  const raw = req.headers["x-haley-user"];
  const name = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return name ? name.slice(0, 80) : "technician";
};

export interface HaleyApp {
  app: FastifyInstance;
  store: Store;
  agent: AgentService;
}

export async function buildApp({ config, llm, fetchImpl = fetch }: AppDeps): Promise<HaleyApp> {
  const db = openDb(config.dbPath);
  const store = new Store(db, config.secretKey);

  // Connector instances hold auth tokens (live) or tenant state (sandbox), so reuse them.
  const connectorCache = new Map<string, Connector>();
  const connectorFor = (integration: Integration): Connector => {
    let connector = connectorCache.get(integration.id);
    if (!connector) {
      connector = buildConnector(store, integration, fetchImpl);
      connectorCache.set(integration.id, connector);
    }
    return connector;
  };
  const connectorsFor = (orgId: string): Connector[] =>
    store.listIntegrations(orgId).flatMap((integration) => {
      try {
        return [connectorFor(integration)];
      } catch (err) {
        store.setIntegrationStatus(integration.id, "error", err instanceof Error ? err.message : String(err));
        return [];
      }
    });

  const agent = new AgentService(store, llm ?? new AnthropicLlm(config), config, connectorsFor);
  agent.recoverInterrupted();

  const app = Fastify({ logger: config.production ? { level: "info" } : false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: config.production ? false : true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof RunConflictError) return reply.status(409).send({ error: err.message });
    if (err instanceof ConnectorError) return reply.status(502).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: "Internal error" });
  });

  const expectedToken = Buffer.from(`Bearer ${config.apiToken}`);
  app.addHook("onRequest", async (req, reply) => {
    if (!config.apiToken || !req.url.startsWith("/api/") || req.url === "/api/health") return;
    const got = Buffer.from(req.headers.authorization ?? "");
    if (got.length !== expectedToken.length || !timingSafeEqual(got, expectedToken)) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
  });

  // --------------------------------------------------------------- meta

  app.get("/api/health", async () => ({
    ok: true,
    model: config.model,
    authRequired: Boolean(config.apiToken),
    claudeCredentials: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE),
  }));

  app.get("/api/stats", async () => store.stats());
  app.get("/api/providers", async () => PROVIDERS);
  app.get("/api/templates", async () => TASK_TEMPLATES);

  app.post("/api/demo", async () => {
    if (store.listOrgs().length > 0) throw new HttpError(409, "Demo data can only be loaded into an empty workspace.");
    return { ok: true, ...seedDemo(store) };
  });

  // --------------------------------------------------------------- orgs

  const orgInput = z.object({
    name: z.string().trim().min(1),
    domain: z.string().trim().default(""),
    autonomy: z.enum(["read_only", "supervised", "autonomous"]).default("supervised"),
    notes: z.string().default(""),
  });

  app.get("/api/orgs", async () => {
    const tickets = store.listTickets({ status: "open", limit: 10_000 });
    return store.listOrgs().map((org) => ({
      ...org,
      integrations: store.listIntegrations(org.id),
      openTickets: tickets.filter((t) => t.org_id === org.id).length,
    }));
  });

  app.post("/api/orgs", async (req) => {
    const input = body(orgInput, req);
    const org = store.createOrg(input);
    store.audit({ orgId: org.id, actor: actor(req), action: "org.created", target: org.id, detail: { name: org.name } });
    return org;
  });

  app.get<{ Params: { id: string } }>("/api/orgs/:id", async (req) => {
    const org = store.getOrg(req.params.id);
    if (!org) throw notFound("Organization");
    return { ...org, integrations: store.listIntegrations(org.id) };
  });

  app.patch<{ Params: { id: string } }>("/api/orgs/:id", async (req) => {
    const patch = body(
      z.object({
        name: z.string().trim().min(1).optional(),
        domain: z.string().trim().optional(),
        autonomy: z.enum(["read_only", "supervised", "autonomous"]).optional(),
        notes: z.string().optional(),
      }),
      req,
    );
    const before = store.getOrg(req.params.id);
    const org = store.updateOrg(req.params.id, patch);
    if (!org) throw notFound("Organization");
    store.audit({
      orgId: org.id,
      actor: actor(req),
      action: before?.autonomy !== org.autonomy ? "org.autonomy_changed" : "org.updated",
      target: org.id,
      detail: before?.autonomy !== org.autonomy ? { from: before?.autonomy, to: org.autonomy } : { fields: Object.keys(patch) },
    });
    return org;
  });

  app.delete<{ Params: { id: string } }>("/api/orgs/:id", async (req) => {
    for (const i of store.listIntegrations(req.params.id)) connectorCache.delete(i.id);
    if (!store.deleteOrg(req.params.id)) throw notFound("Organization");
    store.audit({ actor: actor(req), action: "org.deleted", target: req.params.id });
    return { ok: true };
  });

  // -------------------------------------------------------- integrations

  const testIntegration = async (integration: Integration) => {
    connectorCache.delete(integration.id);
    try {
      const detail = await connectorFor(integration).test();
      store.setIntegrationStatus(integration.id, "connected", detail);
    } catch (err) {
      connectorCache.delete(integration.id);
      store.setIntegrationStatus(integration.id, "error", err instanceof Error ? err.message : String(err));
    }
    return store.getIntegration(integration.id)!;
  };

  app.post<{ Params: { id: string } }>("/api/orgs/:id/integrations", async (req) => {
    const org = store.getOrg(req.params.id);
    if (!org) throw notFound("Organization");
    const input = body(
      z.object({
        provider: z.enum(["m365", "google"]),
        mode: z.enum(["live", "sandbox"]).default("live"),
        label: z.string().trim().optional(),
        config: z.record(z.string(), z.string()).default({}),
      }),
      req,
    );
    const info = providerInfo(input.provider)!;
    if (input.mode === "live") {
      const missing = info.fields.filter((f) => !input.config[f.key]?.trim()).map((f) => f.label);
      if (missing.length) throw new HttpError(400, `Missing: ${missing.join(", ")}`);
    }
    if (store.listIntegrations(org.id).some((i) => i.provider === input.provider)) {
      throw new HttpError(409, `${org.name} already has a ${info.name} integration. Remove it first to reconnect.`);
    }
    const integration = store.createIntegration({
      orgId: org.id,
      provider: input.provider,
      mode: input.mode,
      label: input.label || `${org.name} ${info.name}${input.mode === "sandbox" ? " (sandbox)" : ""}`,
      config: input.mode === "sandbox" ? { domain: org.domain || "" } : input.config,
    });
    store.audit({ orgId: org.id, actor: actor(req), action: "integration.connected", target: integration.id, detail: { provider: input.provider, mode: input.mode } });
    return testIntegration(integration);
  });

  app.post<{ Params: { id: string } }>("/api/integrations/:id/test", async (req) => {
    const integration = store.getIntegration(req.params.id);
    if (!integration) throw notFound("Integration");
    return testIntegration(integration);
  });

  app.delete<{ Params: { id: string } }>("/api/integrations/:id", async (req) => {
    const integration = store.getIntegration(req.params.id);
    if (!integration) throw notFound("Integration");
    connectorCache.delete(integration.id);
    store.deleteIntegration(integration.id);
    store.audit({ orgId: integration.org_id, actor: actor(req), action: "integration.removed", target: integration.id, detail: { provider: integration.provider } });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/integrations/:id/tools", async (req) => {
    const integration = store.getIntegration(req.params.id);
    if (!integration) throw notFound("Integration");
    return connectorFor(integration).tools.map((t) => ({ name: t.name, description: t.description, risk: t.risk }));
  });

  // ------------------------------------------------------------ tickets

  app.get("/api/tickets", async (req) => {
    const q = query(z.object({ orgId: z.string().optional(), status: z.string().optional(), search: z.string().optional() }), req);
    const orgs = new Map(store.listOrgs().map((o) => [o.id, o.name]));
    return store.listTickets(q).map((t) => ({ ...t, org_name: orgs.get(t.org_id) ?? "" }));
  });

  const ticketInput = z.object({
    orgId: z.string(),
    title: z.string().trim().min(1),
    description: z.string().default(""),
    requesterName: z.string().default(""),
    requesterEmail: z.string().default(""),
    priority: z.enum(TICKET_PRIORITIES as [string, ...string[]]).default("normal"),
    autoRun: z.boolean().default(true),
  });

  app.post("/api/tickets", async (req) => {
    const input = body(ticketInput, req);
    if (!store.getOrg(input.orgId)) throw notFound("Organization");
    const ticket = store.createTicket({ ...input, priority: input.priority as never, author: actor(req) });
    store.audit({ orgId: input.orgId, actor: actor(req), action: "ticket.created", target: ticket.id, detail: { number: ticket.number } });
    const run = input.autoRun ? agent.startTicketRun(ticket.id, actor(req)) : null;
    return { ...ticket, runId: run?.id ?? null };
  });

  /** Inbound email / PSA webhook: routes to the org whose domain matches the sender. */
  app.post("/api/intake", async (req) => {
    const input = body(
      z.object({
        from: z.string().email(),
        fromName: z.string().default(""),
        subject: z.string().trim().min(1),
        body: z.string().default(""),
        orgId: z.string().optional(),
        autoRun: z.boolean().default(true),
      }),
      req,
    );
    const domain = input.from.split("@")[1].toLowerCase();
    const org = input.orgId ? store.getOrg(input.orgId) : store.listOrgs().find((o) => o.domain.toLowerCase() === domain);
    if (!org) throw new HttpError(422, `No organization matches sender domain ${domain}.`);
    const ticket = store.createTicket({
      orgId: org.id,
      title: input.subject,
      description: input.body,
      requesterName: input.fromName,
      requesterEmail: input.from,
      author: input.fromName || input.from,
    });
    store.audit({ orgId: org.id, actor: "intake", action: "ticket.created", target: ticket.id, detail: { from: input.from } });
    const run = input.autoRun ? agent.startTicketRun(ticket.id, "intake") : null;
    return { ...ticket, runId: run?.id ?? null };
  });

  app.get<{ Params: { id: string } }>("/api/tickets/:id", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw notFound("Ticket");
    const runs = store.listRuns({ ticketId: ticket.id });
    return {
      ticket: { ...ticket, org_name: store.getOrg(ticket.org_id)?.name ?? "" },
      events: store.listTicketEvents(ticket.id),
      runs,
      actions: runs.flatMap((r) => store.listActions({ runId: r.id })),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/tickets/:id", async (req) => {
    const patch = body(
      z.object({
        status: z.enum(TICKET_STATUSES as [string, ...string[]]).optional(),
        priority: z.enum(TICKET_PRIORITIES as [string, ...string[]]).optional(),
        category: z.string().optional(),
        assignee: z.string().optional(),
        title: z.string().min(1).optional(),
      }),
      req,
    );
    const ticket = store.updateTicket(req.params.id, patch as never, actor(req));
    if (!ticket) throw notFound("Ticket");
    return ticket;
  });

  app.post<{ Params: { id: string } }>("/api/tickets/:id/comments", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw notFound("Ticket");
    const input = body(
      z.object({
        body: z.string().trim().min(1),
        kind: z.enum(["comment", "reply"]).default("comment"),
        author: z.string().optional(),
        runAgent: z.boolean().default(false),
      }),
      req,
    );
    // Check before saving so a 409 never leaves a half-applied request behind.
    const active = input.runAgent ? agent.activeRun(ticket.id) : undefined;
    if (active) throw new RunConflictError(`Haley is already working this ticket (run ${active.id}).`);
    const event = store.addTicketEvent(ticket.id, input.kind, input.author || actor(req), input.body);
    if (ticket.status === "waiting_on_customer" && input.kind === "comment" && input.author) {
      store.setTicketStatus(ticket.id, "in_progress", "system");
    }
    const run = input.runAgent ? agent.startTicketRun(ticket.id, actor(req)) : null;
    return { event, runId: run?.id ?? null };
  });

  app.post<{ Params: { id: string } }>("/api/tickets/:id/run", async (req) => {
    if (!store.getTicket(req.params.id)) throw notFound("Ticket");
    return agent.startTicketRun(req.params.id, actor(req));
  });

  // --------------------------------------------------------------- runs

  app.get("/api/runs", async (req) => {
    const q = query(z.object({ orgId: z.string().optional(), kind: z.enum(["ticket", "task"]).optional() }), req);
    const orgs = new Map(store.listOrgs().map((o) => [o.id, o.name]));
    return store.listRuns(q).map((r) => ({ ...r, org_name: orgs.get(r.org_id) ?? "" }));
  });

  app.post("/api/runs", async (req) => {
    const input = body(z.object({ orgId: z.string(), title: z.string().trim().min(1), instruction: z.string().trim().min(1) }), req);
    if (!store.getOrg(input.orgId)) throw notFound("Organization");
    return agent.startTaskRun(input.orgId, input.title, input.instruction, actor(req));
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req) => {
    const run = store.getRun(req.params.id);
    if (!run) throw notFound("Run");
    const actions = store.listActions({ runId: run.id });
    return {
      run: { ...run, org_name: store.getOrg(run.org_id)?.name ?? "" },
      actions,
      transcript: buildTranscript(store.getRunMessages<MessageParam>(run.id), actions),
    };
  });

  // ---------------------------------------------------------- approvals

  app.get("/api/approvals", async () => {
    const orgs = new Map(store.listOrgs().map((o) => [o.id, o.name]));
    return store.listActions({ status: "pending_approval" }).map((a) => {
      const run = store.getRun(a.run_id)!;
      const ticket = run.ticket_id ? store.getTicket(run.ticket_id) : null;
      return {
        ...a,
        org_name: orgs.get(a.org_id) ?? "",
        run_title: run.title,
        ticket: ticket ? { id: ticket.id, number: ticket.number, title: ticket.title } : null,
      };
    });
  });

  const decision = z.object({ note: z.string().default("") });

  app.post<{ Params: { id: string } }>("/api/actions/:id/approve", async (req) => {
    if (!store.getAction(req.params.id)) throw notFound("Action");
    return agent.decideAction(req.params.id, true, actor(req), body(decision, req).note);
  });

  app.post<{ Params: { id: string } }>("/api/actions/:id/reject", async (req) => {
    if (!store.getAction(req.params.id)) throw notFound("Action");
    return agent.decideAction(req.params.id, false, actor(req), body(decision, req).note);
  });

  app.post<{ Params: { id: string } }>("/api/actions/:id/reveal", async (req) => {
    const action = store.getAction(req.params.id);
    if (!action) throw notFound("Action");
    const secrets = store.revealActionSecrets(action.id);
    if (!secrets) throw notFound("Secret");
    store.audit({ orgId: action.org_id, actor: actor(req), action: "secret.revealed", target: action.id, detail: { tool: action.tool } });
    return secrets;
  });

  // ----------------------------------------------------------------- kb

  const articleInput = z.object({
    orgId: z.string().nullable().default(null),
    title: z.string().trim().min(1),
    body: z.string().default(""),
    tags: z.array(z.string()).default([]),
  });

  app.get("/api/kb", async (req) => {
    const q = query(z.object({ orgId: z.string().optional(), q: z.string().optional() }), req);
    const orgs = new Map(store.listOrgs().map((o) => [o.id, o.name]));
    return store.searchArticles({ orgId: q.orgId, query: q.q }).map((a) => ({ ...a, org_name: a.org_id ? orgs.get(a.org_id) ?? "" : "Global" }));
  });

  app.get<{ Params: { id: string } }>("/api/kb/:id", async (req) => {
    const article = store.getArticle(req.params.id);
    if (!article) throw notFound("Article");
    return article;
  });

  app.post("/api/kb", async (req) => {
    const input = body(articleInput, req);
    const article = store.saveArticle({ ...input, source: "manual" });
    store.audit({ orgId: input.orgId, actor: actor(req), action: "kb.created", target: article.id, detail: { title: article.title } });
    return article;
  });

  app.put<{ Params: { id: string } }>("/api/kb/:id", async (req) => {
    const existing = store.getArticle(req.params.id);
    if (!existing) throw notFound("Article");
    // Not articleInput.partial(): zod keeps defaults on partial fields, which would blank omitted ones.
    const input = body(z.object({ title: z.string().trim().min(1).optional(), body: z.string().optional(), tags: z.array(z.string()).optional() }), req);
    const article = store.saveArticle({
      id: existing.id,
      orgId: existing.org_id,
      title: input.title ?? existing.title,
      body: input.body ?? existing.body,
      tags: input.tags ?? existing.tags,
    });
    store.audit({ orgId: existing.org_id, actor: actor(req), action: "kb.updated", target: existing.id, detail: { title: article.title } });
    return article;
  });

  app.delete<{ Params: { id: string } }>("/api/kb/:id", async (req) => {
    const existing = store.getArticle(req.params.id);
    if (!existing || !store.deleteArticle(existing.id)) throw notFound("Article");
    store.audit({ orgId: existing.org_id, actor: actor(req), action: "kb.deleted", target: existing.id, detail: { title: existing.title } });
    return { ok: true };
  });

  // -------------------------------------------------------------- audit

  app.get("/api/audit", async (req) => {
    const q = query(z.object({ orgId: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }), req);
    return store.listAudit(q);
  });

  // ---------------------------------------------------------------- web

  const webDist = config.webDist ? resolve(config.webDist) : null;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => db.close());
  return { app, store, agent };
}
