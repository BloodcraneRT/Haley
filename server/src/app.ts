import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { PROVIDER_PRESETS, presetFor } from "./ai/providers.js";
import { ModelRegistry } from "./ai/registry.js";
import type { ChatMessage, LlmClient } from "./ai/types.js";
import { AgentService, RunConflictError } from "./agent/runner.js";
import { TASK_TEMPLATES } from "./agent/templates.js";
import type { HaleyConfig } from "./config.js";
import { buildConnector, PROVIDERS, providerInfo } from "./connectors/registry.js";
import { ConnectorError, type Connector } from "./connectors/types.js";
import { openDb } from "./db.js";
import { seedDemo } from "./demo.js";
import { Store } from "./store.js";
import { ChatWebhookAdapter } from "./channels/chat.js";
import { EmailAdapter } from "./channels/email.js";
import { ChannelHub } from "./channels/hub.js";
import { SlackChannel } from "./channels/slack.js";
import { TeamsChannel } from "./channels/teams.js";
import { clientReport } from "./report.js";
import { PSA_PROVIDERS, buildPsaAdapter } from "./psa/registry.js";
import "./psa/syncro.js";
import { PsaSync } from "./psa/sync.js";
import type { PsaAdapter, PsaConnection } from "./psa/types.js";
import { registerHooks } from "./routes/hooks.js";
import { registerSecretLinks } from "./routes/secretLinks.js";
import { nextOccurrence, Scheduler } from "./scheduler.js";
import { slaFor } from "./sla.js";
import { buildTranscript } from "./transcript.js";
import { AUTONOMY_LEVELS, TICKET_PRIORITIES, TICKET_STATUSES, type Integration, type Org, type Ticket } from "./types.js";

export interface AppDeps {
  config: HaleyConfig;
  llm?: LlmClient;
  fetchImpl?: typeof fetch;
  /** Overrides how PSA adapters are built (tests use in-memory PSAs). */
  psaFactory?: (connection: PsaConnection, config: Record<string, string>) => PsaAdapter;
  /** Outbound email transport; defaults to SMTP from HALEY_SMTP_URL. Tests pass a fake. */
  mailTransport?: { sendMail(options: Record<string, unknown>): Promise<unknown> };
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
  scheduler: Scheduler;
  psa: PsaSync;
}

export async function buildApp({ config, llm, fetchImpl = fetch, mailTransport, psaFactory }: AppDeps): Promise<HaleyApp> {
  const db = openDb(config.dbPath);
  const store = new Store(db, config.secretKey);

  // Connector instances hold auth tokens (live) or tenant state (sandbox), so reuse them.
  const connectorCache = new Map<string, Connector>();
  const connectorFor = (integration: Integration): Connector => {
    let connector = connectorCache.get(integration.id);
    if (!connector) {
      connector = buildConnector(store, integration, fetchImpl, () =>
        store
          .listIntegrations(integration.org_id)
          .filter((i) => i.id !== integration.id)
          .flatMap((i) => {
            try {
              return [connectorFor(i)];
            } catch {
              return [];
            }
          }),
      );
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

  // End-user channels. Each is enabled by its own secrets; the simulator-backed chat adapter is always on.
  const ch = config.channels;
  const hub = new ChannelHub(store, ch.publicUrl);
  hub.register(new ChatWebhookAdapter(ch.chatWebhookSecret, fetchImpl));
  if (mailTransport || ch.smtpUrl) hub.register(new EmailAdapter(mailTransport ?? ch.smtpUrl, ch.smtpFrom || "Haley <haley@localhost>"));
  const slack = ch.slackSigningSecret ? new SlackChannel(store, fetchImpl) : null;
  if (slack) hub.register(slack);
  const teams =
    ch.teamsAppId && ch.teamsAppPassword
      ? new TeamsChannel({ appId: ch.teamsAppId, appPassword: ch.teamsAppPassword, tenantId: ch.teamsTenantId }, store, connectorsFor, fetchImpl)
      : null;
  if (teams) hub.register(teams);

  const models = new ModelRegistry(store, fetchImpl);
  models.ensureDefault({ model: config.model, effort: config.effort, fallbacks: config.fallbacks });
  const psa = new PsaSync(store, hub, psaFactory ?? ((connection, cfg) => buildPsaAdapter(connection, cfg, fetchImpl)));
  hub.register(psa.channelAdapter("syncro"));
  hub.register(psa.channelAdapter("dynamics"));

  const agent = new AgentService(store, llm ? () => llm : (orgId) => models.clientFor(orgId), config, connectorsFor, hub);
  hub.attach(agent);
  agent.recoverInterrupted();
  const scheduler = new Scheduler(store, agent, psa);

  const withSla = (ticket: Ticket, org: Org | null | undefined) => ({ ...ticket, sla: org ? slaFor(ticket, org.settings.sla) : null });

  const app = Fastify({ logger: config.production ? { level: "info" } : false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: config.production ? false : true });

  // Keep the raw body: Slack and chat webhooks are authenticated by signatures over the exact bytes.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }), undefined);
    }
  });

  registerHooks(app, { config: ch, store, hub, slack, teams, log: (err) => app.log.error(err) });
  registerSecretLinks(app, store);

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
    model: store.getDefaultModelProfile()?.model ?? config.model,
    authRequired: Boolean(config.apiToken),
    // Kept for older dashboards; aiConfigured covers every provider.
    claudeCredentials: models.defaultConfigured(),
    aiConfigured: models.defaultConfigured(),
    defaultModel: (() => {
      const p = store.getDefaultModelProfile();
      return p ? { id: p.id, name: p.name, provider: p.provider, model: p.model } : null;
    })(),
  }));

  app.get("/api/stats", async () => {
    const orgs = new Map(store.listOrgs().map((o) => [o.id, o]));
    const open = store.listTickets({ status: "open", limit: 10_000 });
    const slaBreached = open.filter((t) => {
      const org = orgs.get(t.org_id);
      if (!org) return false;
      const sla = slaFor(t, org.settings.sla);
      return sla.response === "breached" || sla.resolution === "breached";
    }).length;
    return { ...store.stats(), slaBreached, schedules: store.listSchedules().filter((s) => s.enabled && s.next_run_at).length };
  });
  app.get("/api/providers", async () => PROVIDERS);
  app.get("/api/templates", async () => TASK_TEMPLATES);

  app.post("/api/demo", async () => {
    if (store.listOrgs().length > 0) throw new HttpError(409, "Demo data can only be loaded into an empty workspace.");
    return { ok: true, ...seedDemo(store) };
  });

  // --------------------------------------------------------------- orgs

  const emails = z.array(z.string().trim().toLowerCase().email());
  const settingsInput = z
    .object({
      emailDomains: z.array(z.string().trim().toLowerCase().min(3)),
      teamsTenantId: z.string().trim(),
      authorizedRequesters: emails,
      protectedAccounts: emails,
      maxAutoChangesPerHour: z.number().int().min(0).max(1000),
      maxSelfServicePerUserPerDay: z.number().int().min(0).max(50),
      paused: z.boolean(),
      modelProfileId: z.string(),
      sla: z.record(
        z.enum(["urgent", "high", "normal", "low"]),
        z.object({ responseMinutes: z.number().int().min(1).max(100_000), resolutionMinutes: z.number().int().min(1).max(100_000) }),
      ),
    })
    .partial();
  const autonomy = z.enum(AUTONOMY_LEVELS as [string, ...string[]]);
  const orgInput = z.object({
    name: z.string().trim().min(1),
    domain: z.string().trim().default(""),
    autonomy: autonomy.default("supervised"),
    notes: z.string().default(""),
    settings: settingsInput.default({}),
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
    const org = store.createOrg({ ...input, autonomy: input.autonomy as never });
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
        autonomy: autonomy.optional(),
        notes: z.string().optional(),
        settings: settingsInput.optional(),
      }),
      req,
    );
    const before = store.getOrg(req.params.id);
    if (patch.settings?.modelProfileId && !store.getModelProfile(patch.settings.modelProfileId)) {
      throw new HttpError(400, "That AI model doesn't exist.");
    }
    const org = store.updateOrg(req.params.id, patch as never);
    if (!before || !org) throw notFound("Organization");
    const who = actor(req);
    if (before.autonomy !== org.autonomy) {
      store.audit({ orgId: org.id, actor: who, action: "org.autonomy_changed", target: org.id, detail: { from: before.autonomy, to: org.autonomy } });
    }
    if (before.settings.paused !== org.settings.paused) {
      store.audit({ orgId: org.id, actor: who, action: org.settings.paused ? "org.haley_paused" : "org.haley_resumed", target: org.id });
    }
    const fields = Object.keys(patch).filter((k) => k !== "autonomy");
    if (fields.length) {
      store.audit({ orgId: org.id, actor: who, action: "org.updated", target: org.id, detail: { fields, settings: Object.keys(patch.settings ?? {}) } });
    }
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
        provider: z.enum(["m365", "google", "slack", "sms_code", "duo", "okta"]),
        mode: z.enum(["live", "sandbox"]).default("live"),
        label: z.string().trim().optional(),
        config: z.record(z.string(), z.string()).default({}),
      }),
      req,
    );
    const info = providerInfo(input.provider)!;
    if (input.mode === "sandbox" && !info.supportsSandbox) throw new HttpError(400, `${info.name} has no sandbox mode.`);
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
    const orgs = new Map(store.listOrgs().map((o) => [o.id, o]));
    return store.listTickets(q).map((t) => ({ ...withSla(t, orgs.get(t.org_id)), org_name: orgs.get(t.org_id)?.name ?? "" }));
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
    const org = store.getOrg(input.orgId)!;
    const ticket = store.createTicket({
      ...input,
      priority: input.priority as never,
      author: actor(req),
      channel: "portal",
      assurance: "technician",
      verification: `Entered by ${actor(req)}`,
    });
    store.audit({ orgId: input.orgId, actor: actor(req), action: "ticket.created", target: ticket.id, detail: { number: ticket.number } });
    const run = input.autoRun && !org.settings.paused ? agent.startTicketRun(ticket.id, actor(req)) : null;
    return { ...ticket, runId: run?.id ?? null };
  });

  /**
   * PSA / integration intake behind the API token. The caller relays a request on someone's behalf, so the
   * requester's identity is only as good as the caller says: pass verified=true when the PSA authenticated them.
   */
  app.post("/api/intake", async (req) => {
    const input = body(
      z.object({
        from: z.string().email(),
        fromName: z.string().default(""),
        subject: z.string().trim().min(1),
        body: z.string().default(""),
        orgId: z.string().optional(),
        verified: z.boolean().default(false),
        autoRun: z.boolean().default(true),
      }),
      req,
    );
    const domain = input.from.split("@")[1].toLowerCase();
    const org = input.orgId ? store.getOrg(input.orgId) : store.findOrgByEmailDomain(input.from);
    if (!org) throw new HttpError(422, `No organization matches sender domain ${domain}.`);
    if (!input.autoRun) {
      const ticket = store.createTicket({
        orgId: org.id,
        title: input.subject,
        description: input.body,
        requesterName: input.fromName,
        requesterEmail: input.from.toLowerCase(),
        author: input.fromName || input.from,
        channel: "api",
        assurance: input.verified ? "email" : "none",
        verification: input.verified ? "Verified by the submitting integration" : "Submitted through the API",
      });
      store.audit({ orgId: org.id, actor: "intake", action: "ticket.created", target: ticket.id, detail: { from: input.from } });
      return { ...ticket, runId: null };
    }
    const result = await hub.receive({
      channel: "api",
      org,
      sender: {
        name: input.fromName,
        email: input.from.toLowerCase(),
        assurance: input.verified ? "email" : "none",
        verification: input.verified ? "Verified by the submitting integration" : "Submitted through the API",
      },
      subject: input.subject,
      text: input.body,
      thread: null,
      ref: {},
    });
    return { ...store.getTicket(result.ticketId)!, runId: result.runId };
  });

  /** Lets a technician try the end-user experience: messages go through the same pipeline as Slack or Teams. */
  app.post("/api/simulate", async (req) => {
    const input = body(
      z.object({
        orgId: z.string(),
        email: z.string().trim().toLowerCase().email(),
        name: z.string().default(""),
        text: z.string().trim().min(1),
        assurance: z.enum(["none", "email", "chat", "directory"]).default("directory"),
        threadId: z.string().optional(),
      }),
      req,
    );
    const org = store.getOrg(input.orgId);
    if (!org) throw notFound("Organization");
    const threadId = input.threadId ?? `sim-${Date.now().toString(36)}`;
    const result = await hub.receive({
      channel: "chat",
      org,
      sender: { name: input.name, email: input.email, assurance: input.assurance, verification: `Simulated by ${actor(req)} (${input.assurance})` },
      text: input.text,
      thread: { key: "threadId", value: threadId },
      ref: { threadId, simulated: "1", private: "1" },
    });
    return { ...result, threadId };
  });

  app.get("/api/channels", async () => {
    const base = config.channels.publicUrl;
    return [
      { id: "email", name: "Email", enabled: hub.has("email") && Boolean(config.channels.emailHookSecret), inbound: Boolean(config.channels.emailHookSecret), outbound: hub.has("email"), webhookUrl: `${base}/hooks/email?key=…`, env: ["HALEY_EMAIL_HOOK_SECRET", "HALEY_SMTP_URL", "HALEY_SMTP_FROM"] },
      { id: "slack", name: "Slack", enabled: hub.has("slack"), inbound: hub.has("slack"), outbound: hub.has("slack"), webhookUrl: `${base}/hooks/slack/events`, env: ["HALEY_SLACK_SIGNING_SECRET"] },
      { id: "teams", name: "Microsoft Teams", enabled: hub.has("teams"), inbound: hub.has("teams"), outbound: hub.has("teams"), webhookUrl: `${base}/hooks/teams/messages`, env: ["HALEY_TEAMS_APP_ID", "HALEY_TEAMS_APP_PASSWORD", "HALEY_TEAMS_TENANT_ID"] },
      { id: "chat", name: "Chat bridge (Google Chat, SMS, custom)", enabled: Boolean(config.channels.chatWebhookSecret), inbound: Boolean(config.channels.chatWebhookSecret), outbound: Boolean(config.channels.chatWebhookSecret), webhookUrl: `${base}/hooks/chat`, env: ["HALEY_CHAT_WEBHOOK_SECRET"] },
    ];
  });

  app.get<{ Params: { id: string } }>("/api/tickets/:id", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw notFound("Ticket");
    const runs = store.listRuns({ ticketId: ticket.id });
    const org = store.getOrg(ticket.org_id);
    return {
      ticket: { ...withSla(ticket, org), org_name: org?.name ?? "" },
      schedules: store.listSchedules({ ticketId: ticket.id }),
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
    if (input.runAgent && store.getOrg(ticket.org_id)?.settings.paused) throw new RunConflictError("Haley is paused for this client.");
    const event = store.addTicketEvent(ticket.id, input.kind, input.author || actor(req), input.body);
    if (ticket.status === "waiting_on_customer" && input.kind === "comment" && input.author) {
      store.setTicketStatus(ticket.id, "in_progress", "system");
    }
    const run = input.runAgent ? agent.startTicketRun(ticket.id, actor(req)) : null;
    if (input.kind === "reply") {
      // A technician's public reply goes out on the requester's channel too.
      const delivery = await hub.deliverReply(ticket, input.body);
      event.meta = store.mergeEventMeta(event.id, { delivery });
    }
    return { event, runId: run?.id ?? null };
  });

  const runMode = z.object({ mode: z.enum(["live", "plan"]).default("live") });

  app.post<{ Params: { id: string } }>("/api/tickets/:id/run", async (req) => {
    if (!store.getTicket(req.params.id)) throw notFound("Ticket");
    return agent.startTicketRun(req.params.id, actor(req), body(runMode, req).mode);
  });

  // --------------------------------------------------------------- runs

  app.get("/api/runs", async (req) => {
    const q = query(z.object({ orgId: z.string().optional(), kind: z.enum(["ticket", "task"]).optional() }), req);
    const orgs = new Map(store.listOrgs().map((o) => [o.id, o.name]));
    return store.listRuns(q).map((r) => ({ ...r, org_name: orgs.get(r.org_id) ?? "" }));
  });

  app.post("/api/runs", async (req) => {
    const input = body(
      z.object({ orgId: z.string(), title: z.string().trim().min(1), instruction: z.string().trim().min(1), mode: z.enum(["live", "plan"]).default("live") }),
      req,
    );
    if (!store.getOrg(input.orgId)) throw notFound("Organization");
    return agent.startTaskRun(input.orgId, input.title, input.instruction, actor(req), input.mode);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req) => {
    const run = store.getRun(req.params.id);
    if (!run) throw notFound("Run");
    const actions = store.listActions({ runId: run.id });
    return {
      run: { ...run, org_name: store.getOrg(run.org_id)?.name ?? "" },
      actions,
      transcript: buildTranscript(store.getRunMessages<ChatMessage>(run.id), actions),
    };
  });

  // ---------------------------------------------------------- AI models

  app.get("/api/models/providers", async () => PROVIDER_PRESETS);

  app.get("/api/models", async () => {
    const orgs = store.listOrgs();
    return store.listModelProfiles().map((p) => ({ ...p, usedBy: orgs.filter((o) => o.settings.modelProfileId === p.id).map((o) => o.name) }));
  });

  const modelOptions = z
    .object({
      maxTokens: z.number().int().min(256).max(200_000),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
      refusalFallbacks: z.boolean(),
      temperature: z.number().min(0).max(2),
      tokenParam: z.enum(["max_tokens", "max_completion_tokens"]),
      reasoningEffort: z.string().max(20),
      apiVersion: z.string().max(40),
      extraHeaders: z.record(z.string(), z.string()),
    })
    .partial();
  const providerIds = PROVIDER_PRESETS.map((p) => p.id) as [string, ...string[]];

  const assertFallback = (id: string | null | undefined, self?: string) => {
    if (!id) return;
    if (id === self) throw new HttpError(400, "A model can't fall back to itself.");
    if (!store.getModelProfile(id)) throw new HttpError(400, "Fallback model not found.");
  };

  app.post("/api/models", async (req) => {
    const input = body(
      z.object({
        name: z.string().trim().min(1),
        provider: z.enum(providerIds),
        model: z.string().trim().min(1),
        baseUrl: z.string().trim().url().or(z.literal("")).default(""),
        apiKey: z.string().default(""),
        options: modelOptions.default({}),
        fallbackId: z.string().nullable().default(null),
        isDefault: z.boolean().default(false),
      }),
      req,
    );
    const preset = presetFor(input.provider)!;
    if (!preset.baseUrl && !input.baseUrl) throw new HttpError(400, `${preset.name} needs a base URL.`);
    assertFallback(input.fallbackId);
    const profile = store.createModelProfile({ ...input, isDefault: input.isDefault || !store.getDefaultModelProfile() });
    models.invalidate();
    store.audit({ actor: actor(req), action: "model.created", target: profile.id, detail: { name: profile.name, provider: profile.provider, model: profile.model } });
    return profile;
  });

  app.patch<{ Params: { id: string } }>("/api/models/:id", async (req) => {
    if (!store.getModelProfile(req.params.id)) throw notFound("Model");
    const patch = body(
      z.object({
        name: z.string().trim().min(1).optional(),
        model: z.string().trim().min(1).optional(),
        baseUrl: z.string().trim().url().or(z.literal("")).optional(),
        /** Omit to keep the stored key; "" to clear it. */
        apiKey: z.string().optional(),
        options: modelOptions.optional(),
        fallbackId: z.string().nullable().optional(),
        isDefault: z.literal(true).optional(),
      }),
      req,
    );
    assertFallback(patch.fallbackId, req.params.id);
    const profile = store.updateModelProfile(req.params.id, { ...patch, apiKey: patch.apiKey === undefined ? undefined : patch.apiKey || null });
    models.invalidate();
    store.audit({ actor: actor(req), action: "model.updated", target: req.params.id, detail: { fields: Object.keys(patch).filter((k) => k !== "apiKey"), keyChanged: patch.apiKey !== undefined } });
    return profile;
  });

  app.delete<{ Params: { id: string } }>("/api/models/:id", async (req) => {
    const profile = store.getModelProfile(req.params.id);
    if (!profile) throw notFound("Model");
    if (profile.is_default) throw new HttpError(409, "Make another model the default before deleting this one.");
    for (const org of store.listOrgs().filter((o) => o.settings.modelProfileId === profile.id)) {
      store.updateOrg(org.id, { settings: { modelProfileId: "" } });
    }
    store.deleteModelProfile(profile.id);
    models.invalidate();
    store.audit({ actor: actor(req), action: "model.deleted", target: profile.id, detail: { name: profile.name } });
    return { ok: true };
  });

  /** Checks the model answers and can call tools, which Haley can't work without. */
  app.post<{ Params: { id: string } }>("/api/models/:id/test", async (req) => {
    const profile = store.getModelProfile(req.params.id);
    if (!profile) throw notFound("Model");
    const started = Date.now();
    try {
      const response = await models.clientForProfile(profile, false).create({
        system: "You are a connectivity check. Call the tool exactly once.",
        messages: [{ role: "user", parts: [{ type: "text", text: "Call the ping tool with message set to \"pong\"." }] }],
        tools: [
          {
            name: "ping",
            description: "Returns the message it is given.",
            inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
          },
        ],
      });
      const call = response.parts.find((p) => p.type === "tool_call");
      return {
        ok: true,
        toolCalling: Boolean(call),
        latencyMs: Date.now() - started,
        servedBy: `${response.provider}/${response.model}`,
        detail: call ? "Responded and called a tool: ready for Haley." : "Responded but did not call the tool. Haley needs a model with tool calling.",
      };
    } catch (err) {
      return { ok: false, toolCalling: false, latencyMs: Date.now() - started, servedBy: null, detail: err instanceof Error ? err.message : String(err) };
    }
  });

  // ----------------------------------------------------------- PSA sync

  app.get("/api/psa/providers", async () => PSA_PROVIDERS);

  app.get("/api/psa", async () =>
    store.listPsaConnections().map((c) => ({ ...c, linkedTickets: store.listTicketLinks({ connectionId: c.id }).length })),
  );

  const psaOptions = z
    .object({
      importTickets: z.boolean(),
      exportTickets: z.boolean(),
      mirrorNotes: z.boolean(),
      requesterAssurance: z.enum(["none", "email"]),
    })
    .partial();

  const testPsa = async (id: string) => {
    psa.invalidate(id);
    const connection = store.getPsaConnection(id)!;
    try {
      const detail = await psa.adapterFor(connection).test();
      return store.updatePsaConnection(id, { status: "connected", statusDetail: detail });
    } catch (err) {
      psa.invalidate(id);
      return store.updatePsaConnection(id, { status: "error", statusDetail: err instanceof Error ? err.message : String(err) });
    }
  };

  app.post("/api/psa", async (req) => {
    const input = body(
      z.object({
        kind: z.enum(PSA_PROVIDERS.map((p) => p.id) as [string, ...string[]]),
        name: z.string().trim().min(1).optional(),
        config: z.record(z.string(), z.string()),
        options: psaOptions.default({}),
      }),
      req,
    );
    const info = PSA_PROVIDERS.find((p) => p.id === input.kind)!;
    const missing = info.fields.filter((f) => !f.optional && !input.config[f.key]?.trim()).map((f) => f.label);
    if (missing.length) throw new HttpError(400, `Missing: ${missing.join(", ")}`);
    const connection = store.createPsaConnection({ kind: input.kind as PsaConnection["kind"], name: input.name || info.name, config: input.config, options: input.options });
    store.audit({ actor: actor(req), action: "psa.connected", target: connection.id, detail: { kind: connection.kind } });
    return testPsa(connection.id);
  });

  app.patch<{ Params: { id: string } }>("/api/psa/:id", async (req) => {
    if (!store.getPsaConnection(req.params.id)) throw notFound("PSA connection");
    const patch = body(
      z.object({
        name: z.string().trim().min(1).optional(),
        config: z.record(z.string(), z.string()).optional(),
        options: psaOptions.optional(),
        enabled: z.boolean().optional(),
      }),
      req,
    );
    // Blank secret fields in an edit form mean "keep the stored value".
    const config = patch.config ? Object.fromEntries(Object.entries(patch.config).filter(([, v]) => v.trim() !== "")) : undefined;
    store.updatePsaConnection(req.params.id, { ...patch, config });
    psa.invalidate(req.params.id);
    store.audit({ actor: actor(req), action: "psa.updated", target: req.params.id, detail: { fields: Object.keys(patch) } });
    return patch.config ? testPsa(req.params.id) : store.getPsaConnection(req.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/psa/:id", async (req) => {
    if (!store.deletePsaConnection(req.params.id)) throw notFound("PSA connection");
    psa.invalidate(req.params.id);
    store.audit({ actor: actor(req), action: "psa.removed", target: req.params.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/psa/:id/test", async (req) => {
    if (!store.getPsaConnection(req.params.id)) throw notFound("PSA connection");
    return testPsa(req.params.id);
  });

  /** External customers with their current mapping and a suggested client by domain or name. */
  app.get<{ Params: { id: string } }>("/api/psa/:id/customers", async (req) => {
    const connection = store.getPsaConnection(req.params.id);
    if (!connection) throw notFound("PSA connection");
    const orgs = store.listOrgs();
    const customers = await psa.adapterFor(connection).listCustomers();
    return customers.map((c) => {
      const byDomain = orgs.find((o) =>
        c.domains.some((d) => d === o.domain.toLowerCase() || o.settings.emailDomains.map((x) => x.toLowerCase()).includes(d)),
      );
      const byName = orgs.find((o) => o.name.toLowerCase() === c.name.toLowerCase());
      return { ...c, orgId: connection.customer_map[c.id] ?? null, suggestedOrgId: (byDomain ?? byName)?.id ?? null };
    });
  });

  app.put<{ Params: { id: string } }>("/api/psa/:id/mapping", async (req) => {
    if (!store.getPsaConnection(req.params.id)) throw notFound("PSA connection");
    const map = body(z.record(z.string(), z.string()), req);
    for (const orgId of Object.values(map)) if (!store.getOrg(orgId)) throw new HttpError(400, `Unknown client ${orgId}`);
    store.updatePsaConnection(req.params.id, { customerMap: map });
    store.audit({ actor: actor(req), action: "psa.mapping_updated", target: req.params.id, detail: { customers: Object.keys(map).length } });
    return store.getPsaConnection(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/psa/:id/sync", async (req) => {
    if (!store.getPsaConnection(req.params.id)) throw notFound("PSA connection");
    return psa.sync(req.params.id);
  });

  // ---------------------------------------------------------- schedules

  const scheduleInput = z.object({
    orgId: z.string(),
    title: z.string().trim().min(1),
    instruction: z.string().trim().min(1),
    cadence: z.enum(["once", "daily", "weekly", "monthly"]),
    mode: z.enum(["live", "plan"]).default("live"),
    startAt: z.iso.datetime({ offset: true }),
  });

  app.get("/api/schedules", async (req) => {
    const q = query(z.object({ orgId: z.string().optional() }), req);
    const orgs = new Map(store.listOrgs().map((o) => [o.id, o.name]));
    return store.listSchedules(q).map((s) => {
      const ticket = s.ticket_id ? store.getTicket(s.ticket_id) : null;
      return { ...s, org_name: orgs.get(s.org_id) ?? "", ticket: ticket ? { id: ticket.id, number: ticket.number, title: ticket.title } : null };
    });
  });

  app.post("/api/schedules", async (req) => {
    const input = body(scheduleInput, req);
    if (!store.getOrg(input.orgId)) throw notFound("Organization");
    const schedule = store.createSchedule({ ...input, nextRunAt: new Date(input.startAt).toISOString(), createdBy: actor(req) });
    store.audit({ orgId: input.orgId, actor: actor(req), action: "schedule.created", target: schedule.id, detail: { title: input.title, cadence: input.cadence } });
    return schedule;
  });

  app.patch<{ Params: { id: string } }>("/api/schedules/:id", async (req) => {
    const current = store.getSchedule(req.params.id);
    if (!current) throw notFound("Schedule");
    const patch = body(
      z.object({
        title: z.string().trim().min(1).optional(),
        instruction: z.string().trim().min(1).optional(),
        cadence: z.enum(["once", "daily", "weekly", "monthly"]).optional(),
        mode: z.enum(["live", "plan"]).optional(),
        enabled: z.boolean().optional(),
        startAt: z.iso.datetime({ offset: true }).optional(),
      }),
      req,
    );
    const { startAt, ...rest } = patch;
    let nextRunAt = startAt ? new Date(startAt).toISOString() : current.next_run_at;
    if (patch.enabled && !current.enabled && !startAt) {
      // A one-time schedule that already fired has nowhere to go; a recurring one skips the runs it missed.
      if (!nextRunAt) throw new HttpError(400, "Choose when this schedule should next run (startAt).");
      if (Date.parse(nextRunAt) < Date.now()) nextRunAt = nextOccurrence(nextRunAt, patch.cadence ?? current.cadence, Date.now());
      if (!nextRunAt) throw new HttpError(400, "This one-time schedule's time has passed; choose a new startAt.");
    }
    const updated = store.updateSchedule(current.id, { ...rest, next_run_at: nextRunAt });
    store.audit({ orgId: current.org_id, actor: actor(req), action: "schedule.updated", target: current.id, detail: { fields: Object.keys(patch) } });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req) => {
    const current = store.getSchedule(req.params.id);
    if (!current || !store.deleteSchedule(current.id)) throw notFound("Schedule");
    store.audit({ orgId: current.org_id, actor: actor(req), action: "schedule.deleted", target: current.id, detail: { title: current.title } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (req) => {
    if (!store.getSchedule(req.params.id)) throw notFound("Schedule");
    const result = scheduler.runNow(req.params.id);
    if (!result.started.length) throw new HttpError(409, result.skipped[0]?.reason ?? "Could not start the schedule.");
    return result.started[0];
  });

  // ------------------------------------------------------------- reports

  app.get<{ Params: { id: string } }>("/api/orgs/:id/report", async (req) => {
    const org = store.getOrg(req.params.id);
    if (!org) throw notFound("Organization");
    const q = query(
      z.object({
        days: z.coerce.number().int().min(1).max(730).default(90),
        minutesPerTicket: z.coerce.number().min(0).max(600).default(20),
        minutesPerAction: z.coerce.number().min(0).max(120).default(5),
      }),
      req,
    );
    return clientReport(store, org, q);
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
  app.addHook("onClose", async () => scheduler.stop());
  return { app, store, agent, scheduler, psa };
}
