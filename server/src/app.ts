import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { PROVIDER_PRESETS, presetFor } from "./ai/providers.js";
import { ModelRegistry } from "./ai/registry.js";
import type { ChatMessage, LlmClient } from "./ai/types.js";
import { AgentService, ApproverNotAllowedError, RunConflictError } from "./agent/runner.js";
import { TASK_TEMPLATES, templateAvailability } from "./agent/templates.js";
import type { HaleyConfig } from "./config.js";
import { buildConnector, PROVIDERS, providerInfo, validateProviderConfig } from "./connectors/registry.js";
import { ConnectorError, type Connector, type HaleyTool } from "./connectors/types.js";
import { openDb } from "./db.js";
import { seedDemo } from "./demo.js";
import { Store } from "./store.js";
import { ChatWebhookAdapter } from "./channels/chat.js";
import { EmailAdapter } from "./channels/email.js";
import { ChannelHub } from "./channels/hub.js";
import { SlackChannel } from "./channels/slack.js";
import { TeamsChannel } from "./channels/teams.js";
import { clientReport } from "./report.js";
import { psaConnectorsFor } from "./psa/tools.js";
import { AlertTickets } from "./monitoring/alerts.js";
import { sentinelOneAlertSource } from "./monitoring/sentinelOneAlerts.js";
import { syncroAlertSource } from "./monitoring/syncroAlerts.js";
import { rankSimilar, tokens } from "./similar.js";
import { IncidentDetector } from "./incidents.js";
import { registerIncidentRoutes } from "./routes/incidents.js";
import { assist } from "./copilot.js";
import { registerStatusPage } from "./routes/statusPage.js";
import { requesterSnapshot } from "./snapshot.js";
import { runCost, usageCsv, usageReport } from "./usage.js";
import { probePsa } from "./psa/probe.js";
import { PSA_PROVIDERS, buildPsaAdapter } from "./psa/registry.js";
import "./psa/dynamics.js";
import "./psa/syncro.js";
import "./psa/connectwise.js";
import "./psa/autotask.js";
import "./psa/halopsa.js";
import { PsaSync } from "./psa/sync.js";
import { DEFAULT_PSA_OPTIONS, type PsaAdapter, type PsaConnection } from "./psa/types.js";
import { handleCall, PhoneDirectory } from "./channels/phone.js";
import { registerHooks } from "./routes/hooks.js";
import { registerM365Onboarding } from "./routes/m365Onboarding.js";
import { registerMemoryRoutes } from "./routes/memories.js";
import { registerTechnicianRoutes } from "./routes/technicians.js";
import { psaTimeIssues, qaChecks, qaReview } from "./qa.js";
import { policyRuleInput } from "./policyRuleSchema.js";
import { FrustrationDetector } from "./frustration.js";
import { onEscalated, rankTechnicians } from "./dispatch.js";
import { editRatio, LessonService } from "./lessons.js";
import { nextOn } from "./workingHours.js";
import { INLINE_TYPES } from "./attachments.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { ApprovalNotifier } from "./approvals/notify.js";
import { SlackApprovals } from "./approvals/slack.js";
import { TeamsApprovals } from "./approvals/teams.js";
import { Debouncer, registerSyncroWebhook } from "./routes/syncroWebhook.js";
import { InsightService, insightsCsv, type InsightResult } from "./insights.js";
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
  /** Syncro webhook deliveries trigger this (exposed for tests). */
  syncroWebhook: Debouncer;
  /** Posts and updates approval cards in Slack and Teams (exposed for tests to await). */
  approvalNotifier: ApprovalNotifier;
  /** Flags VIP and frustrated requesters (exposed for tests to await the optional model check). */
  frustration: FrustrationDetector;
  /** Suggests lessons from technicians' corrections (exposed for tests to await). */
  lessons: LessonService;
  /** Builds "What would Haley handle?" reports in the background (exposed for tests to await). */
  insights: InsightService;
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
        config.m365App,
      );
      connectorCache.set(integration.id, connector);
    }
    return connector;
  };
  const connectorsFor = (orgId: string): Connector[] => [
    ...store.listIntegrations(orgId).flatMap((integration) => {
      try {
        return [connectorFor(integration)];
      } catch (err) {
        store.setIntegrationStatus(integration.id, "error", err instanceof Error ? err.message : String(err));
        return [];
      }
    }),
    // Saved replies, contracts and appointments from the client's PSA (defined below; only called later).
    ...psaConnectorsFor(store, orgId, (connection) => psa.adapterFor(connection)),
  ];

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
  const buildPsa = psaFactory ?? ((connection: PsaConnection, cfg: Record<string, string>) => buildPsaAdapter(connection, cfg, fetchImpl));
  const psa = new PsaSync(store, hub, buildPsa);
  hub.register(psa.channelAdapter("syncro"));
  hub.register(psa.channelAdapter("dynamics"));
  hub.register(psa.channelAdapter("connectwise"));
  hub.register(psa.channelAdapter("autotask"));
  hub.register(psa.channelAdapter("halopsa"));

  const llmFor = llm ? () => llm : (orgId: string) => models.clientFor(orgId);
  const agent = new AgentService(store, llmFor, config, connectorsFor, hub);
  hub.attach(agent);
  agent.recoverInterrupted();
  // Needs-care flags: VIP requesters and frustrated ones (free signals, optionally confirmed by the model).
  const frustration = new FrustrationDetector(store, (orgId) => {
    try {
      return llmFor(orgId);
    } catch {
      return null;
    }
  });
  store.onTicketCreated((ticket) => frustration.onTicketCreated(ticket));
  store.onTicketEvent((event) => frustration.onEvent(event));

  // Lessons: technicians' corrections become suggested client notes or policy rules (accepted by a technician).
  const lessons = new LessonService(
    store,
    agent,
    (orgId) => {
      try {
        return llmFor(orgId);
      } catch {
        return null;
      }
    },
    (orgId) => connectorsFor(orgId).flatMap((c) => c.tools.filter((t) => t.risk !== "read").map((t) => t.name)),
  );
  agent.attachApprovalEvents(lessons);

  // "What would Haley handle?": closed PSA tickets grouped and matched to what Haley can do.
  store.failInterruptedInsightReports();
  const insights = new InsightService(store, () => {
    try {
      return llm ?? models.clientFor(null);
    } catch {
      return null;
    }
  });

  // Suggest (or assign) a technician whenever Haley escalates; registered before the notices so they can name them.
  store.onTicketStatusChanged((ticket, from, who) => onEscalated(store, ticket, from, who));

  // Approval cards and escalation notices in the MSP's own Slack (and Teams).
  const slackApprovals = new SlackApprovals(store, fetchImpl);
  const teamsApprovals = teams ? new TeamsApprovals(store, teams, ch.teamsTenantId) : null;
  const approvalNotifier = new ApprovalNotifier(store, teamsApprovals ? [slackApprovals, teamsApprovals] : [slackApprovals], ch.publicUrl);
  agent.attachApprovalEvents(approvalNotifier);
  store.onTicketStatusChanged((ticket, from, who) => approvalNotifier.escalated(ticket, from, who));
  const alertTickets = new AlertTickets(store, agent, [syncroAlertSource(fetchImpl), sentinelOneAlertSource(fetchImpl)]);
  const scheduler = new Scheduler(store, agent, psa, alertTickets, approvalNotifier);

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

  const phoneDirectory = new PhoneDirectory(store, connectorsFor);
  registerHooks(app, {
    config: ch,
    store,
    hub,
    phone: (call) => handleCall({ store, hub, directory: phoneDirectory }, call),
    slack,
    teams,
    log: (err) => app.log.error(err),
    // Approval card buttons and "approvals here" arrive on the Teams bot endpoint too.
    teamsIntercept: teamsApprovals
      ? (activity) =>
          teamsApprovals.intercept(activity, {
            decide: (id, decision, technician, note) => agent.decideAction(id, decision, technician, note),
            cardFor: (id) => {
              const action = store.getAction(id);
              const post = store.listApprovalPosts(id).find((p) => p.channel === "teams");
              let evidence: string[] = [];
              try {
                evidence = JSON.parse(post?.ref.evidence ?? "[]");
              } catch {
                evidence = [];
              }
              return action ? approvalNotifier.card(action, evidence) : null;
            },
          })
      : undefined,
  });
  registerSecretLinks(app, store);
  const incidents = new IncidentDetector(store);
  store.onTicketCreated((ticket) => void incidents.onTicketCreated(ticket));
  registerIncidentRoutes(app, { store, hub, detector: incidents, actor });
  registerStatusPage(app, { store, hub });
  const syncroWebhook = registerSyncroWebhook(app, { store, psa, alerts: alertTickets, publicUrl: ch.publicUrl, actor, log: (err) => app.log.error(err) });
  app.addHook("onClose", async () => syncroWebhook.stop());
  registerMemoryRoutes(app, store, actor);
  registerTechnicianRoutes(app, store, actor);
  registerApprovalRoutes(app, {
    store,
    agent,
    slack: slackApprovals,
    slackSigningSecret: ch.slackSigningSecret,
    teamsEnabled: Boolean(teams),
    teamsDefaultTenantId: ch.teamsTenantId,
    publicUrl: ch.publicUrl,
    actor,
    log: (err) => app.log.error(err),
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof RunConflictError) return reply.status(409).send({ error: err.message });
    if (err instanceof ApproverNotAllowedError) return reply.status(403).send({ error: err.message });
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
    const nowMs = Date.now();
    let slaBreached = 0;
    for (const t of store.openTicketsForSla()) {
      const org = orgs.get(t.org_id);
      if (!org) continue;
      const sla = slaFor(t, org.settings.sla, nowMs);
      if (sla.response === "breached" || sla.resolution === "breached") slaBreached++;
    }
    return { ...store.stats(), slaBreached, schedules: store.listSchedules().filter((s) => s.enabled && s.next_run_at).length };
  });
  app.get("/api/providers", async () => PROVIDERS);
  app.get("/api/templates", async (req) => {
    const { orgId } = query(z.object({ orgId: z.string().optional() }), req);
    if (!orgId) return TASK_TEMPLATES.map((t) => ({ ...t, available: true, missing: [] }));
    if (!store.getOrg(orgId)) throw notFound("Organization");
    const connected = store.listIntegrations(orgId).map((i) => i.provider);
    return TASK_TEMPLATES.map((t) => ({ ...t, ...templateAvailability(t, connected, (id) => providerInfo(id)?.name ?? id) }));
  });

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
      policyRules: z.array(policyRuleInput).max(100),
      vipRequesters: emails.max(200),
      phoneNumbers: z.array(z.string().trim().regex(/^\+?[\d\s().-]{7,20}$/, "Phone numbers look like +1 425 555 0100")).max(20),
      approvalSlackChannel: z.union([z.literal(""), z.string().trim().regex(/^[CG][A-Z0-9]{2,20}$/, "Slack channel ids look like C0123ABCD")]),
    })
    .partial();
  /** Gives new client rules a stable id. */
  const withRuleIds = <T extends { policyRules?: Array<{ id?: string }> }>(settings: T | undefined): T | undefined => {
    if (!settings?.policyRules) return settings;
    return { ...settings, policyRules: settings.policyRules.map((r) => ({ ...r, id: r.id || `rule_${randomUUID().slice(0, 8)}` })) };
  };
  const autonomy = z.enum(AUTONOMY_LEVELS as [string, ...string[]]);
  const orgInput = z.object({
    name: z.string().trim().min(1),
    domain: z.string().trim().default(""),
    autonomy: autonomy.default("supervised"),
    notes: z.string().default(""),
    settings: settingsInput.default({}),
  });

  app.get("/api/orgs", async () => {
    const openCounts = store.countOpenTicketsByOrg();
    const integrationsByOrg = new Map<string, Integration[]>();
    for (const integration of store.listIntegrations()) {
      const integrations = integrationsByOrg.get(integration.org_id) ?? [];
      integrations.push(integration);
      integrationsByOrg.set(integration.org_id, integrations);
    }
    return store.listOrgs().map((org) => ({
      ...org,
      integrations: integrationsByOrg.get(org.id) ?? [],
      openTickets: openCounts.get(org.id) ?? 0,
    }));
  });

  app.post("/api/orgs", async (req) => {
    const input = body(orgInput, req);
    const org = store.createOrg({ ...input, settings: withRuleIds(input.settings) as never, autonomy: input.autonomy as never });
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
    const org = store.updateOrg(req.params.id, { ...patch, settings: withRuleIds(patch.settings) } as never);
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

  registerM365Onboarding(app, { config, store, connectorFor, testIntegration, actor });

  app.post<{ Params: { id: string } }>("/api/orgs/:id/integrations", async (req) => {
    const org = store.getOrg(req.params.id);
    if (!org) throw notFound("Organization");
    const input = body(
      z.object({
        provider: z.enum(["m365", "google", "slack", "sms_code", "duo", "okta", "ninjaone", "syncro_rmm", "itglue", "hudu", "rest"]),
        mode: z.enum(["live", "sandbox"]).default("live"),
        label: z.string().trim().optional(),
        config: z.record(z.string(), z.string()).default({}),
      }),
      req,
    );
    const info = providerInfo(input.provider)!;
    // Admin-consent connections are only created by the Microsoft consent callback.
    delete input.config.authMode;
    if (input.mode === "sandbox" && !info.supportsSandbox) throw new HttpError(400, `${info.name} has no sandbox mode.`);
    if (input.mode === "live") {
      const missing = info.fields.filter((f) => !f.optional && !input.config[f.key]?.trim()).map((f) => f.label);
      if (missing.length) throw new HttpError(400, `Missing: ${missing.join(", ")}`);
      const invalid = validateProviderConfig(input.provider, input.config);
      if (invalid) throw new HttpError(400, invalid);
    }
    if (info.kind === "verification" && store.listIntegrations(org.id).some((i) => providerInfo(i.provider)?.kind === "verification")) {
      throw new HttpError(409, `${org.name} already has an identity verification method. Remove it first to switch.`);
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
    const q = query(
      z.object({ orgId: z.string().optional(), status: z.string().optional(), search: z.string().optional(), flag: z.enum(["frustrated", "vip"]).optional() }),
      req,
    );
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
      // Calls come in as transcripts; replies go by email to the matched person, so there's no phone outbound.
      { id: "phone", name: "Phone (call-answering service)", enabled: Boolean(config.channels.voiceWebhookSecret), inbound: Boolean(config.channels.voiceWebhookSecret), outbound: false, webhookUrl: `${base}/hooks/voice`, env: ["HALEY_VOICE_WEBHOOK_SECRET"] },
    ];
  });

  /** The technician copilot: a reply draft, next steps or a summary for a ticket. Nothing is sent or changed. */
  app.post<{ Params: { id: string } }>("/api/tickets/:id/assist", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw notFound("Ticket");
    const input = body(z.object({ mode: z.enum(["draft_reply", "next_steps", "summarize"]), instruction: z.string().trim().max(1000).default("") }), req);
    const org = store.getOrg(ticket.org_id);
    if (org?.settings.paused) throw new HttpError(409, `Haley is paused for ${org.name}.`);
    const result = await assist({ store, llm: llmFor(ticket.org_id) }, ticket, input.mode, input.instruction);
    store.audit({ orgId: ticket.org_id, actor: actor(req), action: "ticket.assist", target: ticket.id, detail: { mode: input.mode, model: result.model } });
    // Drafts are kept so the reply sent from one can be compared (lessons from heavy edits).
    const draftId = input.mode === "draft_reply" ? store.createAssistDraft({ ticketId: ticket.id, mode: input.mode, text: result.text, createdBy: actor(req) }) : null;
    return { ...result, draftId };
  });

  /** Past tickets like this one (with how they were fixed) and matching knowledge base articles. */
  app.get<{ Params: { id: string } }>("/api/tickets/:id/similar", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw notFound("Ticket");
    const candidates = store.listTickets({ orgId: ticket.org_id, limit: 2000 });
    const tickets = rankSimilar(ticket, candidates, 0.34, 6).map(({ ticket: t, score, shared }) => {
      const run = store.listRuns({ ticketId: t.id }).find((r) => r.status === "completed" && r.mode === "live" && r.summary.trim());
      return {
        id: t.id,
        number: t.number,
        title: t.title,
        status: t.status,
        created_at: t.created_at,
        resolved_at: t.resolved_at,
        score: Math.round(score * 100) / 100,
        matched: shared.slice(0, 6),
        resolution: run ? run.summary.trim().slice(0, 400) : null,
      };
    });
    const query = tokens(`${ticket.title} ${ticket.description}`, 8).join(" ");
    const articles = query
      ? store.searchArticles({ orgId: ticket.org_id, query: tokens(ticket.title, 4).join(" ") || query, limit: 5 }).map((a) => ({ id: a.id, title: a.title, scope: a.org_id ? "client" : "global" }))
      : [];
    return { tickets, articles };
  });

  /** The requester's status page link, for a technician to share. */
  app.get<{ Params: { id: string } }>("/api/tickets/:id/status-link", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw notFound("Ticket");
    store.audit({ orgId: ticket.org_id, actor: actor(req), action: "ticket.status_link", target: ticket.id });
    return { url: hub.statusLink(ticket) };
  });

  /** The requester's account, devices and recent tickets, from the client's connected systems (read-only). */
  app.get<{ Params: { id: string } }>("/api/tickets/:id/requester", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw notFound("Ticket");
    const tools = new Map<string, HaleyTool>();
    for (const connector of connectorsFor(ticket.org_id)) for (const tool of connector.tools) tools.set(tool.name, tool);
    return requesterSnapshot(store, ticket, tools);
  });

  app.get<{ Params: { id: string } }>("/api/tickets/:id", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw notFound("Ticket");
    const runs = store.listRuns({ ticketId: ticket.id });
    const org = store.getOrg(ticket.org_id);
    return {
      ticket: { ...withSla(ticket, org), org_name: org?.name ?? "" },
      schedules: store.listSchedules({ ticketId: ticket.id }),
      psaLinks: store.listTicketLinks({ ticketId: ticket.id }).map((l) => {
        const connection = store.getPsaConnection(l.connection_id);
        return { connectionId: l.connection_id, name: connection?.name ?? "PSA", kind: connection?.kind ?? null, externalId: l.external_id, externalNumber: l.external_number };
      }),
      events: store.listTicketEvents(ticket.id),
      runs,
      actions: runs.flatMap((r) => store.listActions({ runId: r.id })),
      attachments: store.listAttachments(ticket.id),
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
        /** Why the technician is closing despite the checks before close (see /qa). */
        qaOverride: z.string().trim().min(3).max(500).optional(),
      }),
      req,
    );
    const { qaOverride, ...changes } = patch;
    const current = store.getTicket(req.params.id);
    if (!current) throw notFound("Ticket");
    const closing = (changes.status === "resolved" || changes.status === "closed") && current.status !== changes.status;
    if (closing) {
      const mode = store.getHelpdeskSettings().qaBeforeClose;
      const blocking = mode === "off" ? [] : qaChecks(current, store.listTicketEvents(current.id)).filter((i) => i.level === "warning");
      if (mode === "require" && blocking.length && !qaOverride) {
        throw new HttpError(409, `Before you close: ${blocking.map((i) => i.text).join(" ")} Add a reason to close anyway.`);
      }
      if (blocking.length && qaOverride) {
        store.audit({ orgId: current.org_id, actor: actor(req), action: "ticket.qa_override", target: current.id, detail: { issues: blocking.map((i) => i.code), reason: qaOverride } });
      }
    }
    const ticket = store.updateTicket(req.params.id, changes as never, actor(req));
    if (!ticket) throw notFound("Ticket");
    if (changes.assignee !== undefined && changes.assignee !== current.assignee) {
      store.audit({ orgId: current.org_id, actor: actor(req), action: "ticket.assigned", target: current.id, detail: { from: current.assignee, to: changes.assignee } });
    }
    return ticket;
  });

  /** Looks for a lasting lesson in technicians' corrections on this ticket; suggestions wait for a technician. */
  app.post<{ Params: { id: string } }>("/api/tickets/:id/lesson", async (req) => {
    if (!store.getTicket(req.params.id)) throw notFound("Ticket");
    return lessons.suggest(req.params.id, actor(req));
  });

  app.get<{ Params: { id: string } }>("/api/orgs/:id/rule-suggestions", async (req) => {
    if (!store.getOrg(req.params.id)) throw notFound("Organization");
    return store.listRuleSuggestions(req.params.id);
  });

  /** Adds a suggested rule (optionally as the technician edited it) to the end of the client's rules. */
  app.post<{ Params: { id: string } }>("/api/rule-suggestions/:id/accept", async (req) => {
    const suggestion = store.getRuleSuggestion(req.params.id);
    if (!suggestion) throw notFound("Suggestion");
    const { rule } = body(z.object({ rule: policyRuleInput.optional() }), req);
    const org = store.getOrg(suggestion.org_id);
    if (!org) throw notFound("Organization");
    if (!store.decideRuleSuggestion(suggestion.id, "accepted", actor(req))) throw new HttpError(409, "This suggestion was already decided.");
    const added = { ...(rule ?? suggestion.rule), id: `rule_${randomUUID().slice(0, 8)}` };
    store.updateOrg(org.id, { settings: { policyRules: [...org.settings.policyRules, added as never] } });
    store.audit({ orgId: org.id, actor: actor(req), action: "rule.suggestion_accepted", target: suggestion.id, detail: { rule: added.id, edited: Boolean(rule), effect: added.effect } });
    return { rule: added };
  });

  app.post<{ Params: { id: string } }>("/api/rule-suggestions/:id/dismiss", async (req) => {
    const suggestion = store.getRuleSuggestion(req.params.id);
    if (!suggestion) throw notFound("Suggestion");
    if (!store.decideRuleSuggestion(suggestion.id, "dismissed", actor(req))) throw new HttpError(409, "This suggestion was already decided.");
    store.audit({ orgId: suggestion.org_id, actor: actor(req), action: "rule.suggestion_dismissed", target: suggestion.id });
    return { ok: true };
  });

  /**
   * An attachment's bytes for technicians. Never rendered as a page: images keep their checked type for
   * previews, everything else downloads, and the CSP forbids running anything.
   */
  app.get<{ Params: { id: string } }>("/api/attachments/:id/content", async (req, reply) => {
    const attachment = store.getAttachment(req.params.id);
    if (!attachment) throw notFound("Attachment");
    const data = store.attachmentData(attachment.id);
    if (!data) throw new HttpError(404, "This file wasn't kept (it's listed by name only).");
    const ticket = store.getTicket(attachment.ticket_id);
    store.audit({ orgId: ticket?.org_id ?? null, actor: actor(req), action: "attachment.downloaded", target: attachment.id, detail: { ticket: ticket?.number } });
    const inline = INLINE_TYPES.has(attachment.media_type);
    return reply
      .header("content-type", inline ? attachment.media_type : "application/octet-stream")
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${attachment.filename.replace(/[^\w.\- ]/g, "_")}"`)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, no-store")
      .send(Buffer.from(data));
  });

  /** The best technicians for a ticket, with why (no model call). */
  app.get<{ Params: { id: string } }>("/api/tickets/:id/assignee-suggestions", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw notFound("Ticket");
    // People who are working come first; the rest say when they're next on.
    return rankTechnicians(store, ticket)
      .sort((a, b) => Number(b.working) - Number(a.working))
      .slice(0, 3)
      .map((c) => {
        const next = c.working ? null : nextOn(c.technician.working_hours);
        return { name: c.technician.name, score: c.score, reasons: c.working ? c.reasons : [`off now${next ? `, next on ${next}` : ""}`, ...c.reasons], working: c.working };
      });
  });

  /** A technician clears a needs-care flag (e.g. the requester is fine now). */
  app.delete<{ Params: { id: string; flag: string } }>("/api/tickets/:id/flags/:flag", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw notFound("Ticket");
    if (req.params.flag !== "frustrated" && req.params.flag !== "vip") throw new HttpError(400, "Unknown flag");
    const updated = store.setTicketFlags(ticket.id, { [req.params.flag]: null })!;
    store.audit({ orgId: ticket.org_id, actor: actor(req), action: "ticket.flag_cleared", target: ticket.id, detail: { flag: req.params.flag } });
    return updated;
  });

  /** Checks before a technician closes a ticket: is the requester answered, is the fix written down, was a promise kept. */
  app.post<{ Params: { id: string } }>("/api/tickets/:id/qa", async (req) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) throw notFound("Ticket");
    const settings = store.getHelpdeskSettings();
    if (settings.qaBeforeClose === "off") return { mode: "off", issues: [], modelChecked: false };
    const org = store.getOrg(ticket.org_id);
    const useModel = settings.qaModelCheck && !org?.settings.paused;
    const [result, psaTime] = await Promise.all([
      qaReview({ store, llm: useModel ? llmFor(ticket.org_id) : null }, ticket, useModel),
      psaTimeIssues(store, (c) => psa.adapterFor(c), ticket),
    ]);
    return { mode: settings.qaBeforeClose, ...result, issues: [...result.issues, ...psaTime] };
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
        /** The copilot draft this reply started from, if any. */
        draftId: z.string().max(64).optional(),
      }),
      req,
    );
    // Check before saving so a 409 never leaves a half-applied request behind.
    const active = input.runAgent ? agent.activeRun(ticket.id) : undefined;
    if (active) throw new RunConflictError(`Haley is already working this ticket (run ${active.id}).`);
    if (input.runAgent && store.getOrg(ticket.org_id)?.settings.paused) throw new RunConflictError("Haley is paused for this client.");
    const draft = input.draftId && input.kind === "reply" ? store.getAssistDraft(input.draftId) : null;
    const draftMeta = draft && draft.ticket_id === ticket.id ? { draftId: draft.id, draftEditRatio: editRatio(draft.text, input.body) } : {};
    const event = store.addTicketEvent(ticket.id, input.kind, input.author || actor(req), input.body, draftMeta);
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
      z.object({
        orgId: z.string(),
        title: z.string().trim().min(1),
        instruction: z.string().trim().min(1),
        mode: z.enum(["live", "plan"]).default("live"),
        templateId: z.string().trim().min(1).max(64).optional(),
      }),
      req,
    );
    if (!store.getOrg(input.orgId)) throw notFound("Organization");
    return agent.startTaskRun(input.orgId, input.title, input.instruction, actor(req), input.mode, input.templateId && TASK_TEMPLATES.some((t) => t.id === input.templateId) ? input.templateId : null);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req) => {
    const run = store.getRun(req.params.id);
    if (!run) throw notFound("Run");
    const actions = store.listActions({ runId: run.id });
    const usage = store.runModelUsage(run.id);
    return {
      run: { ...run, org_name: store.getOrg(run.org_id)?.name ?? "" },
      usage: {
        modelCalls: usage.reduce((n, u) => n + u.calls, 0),
        inputTokens: usage.reduce((n, u) => n + u.input_tokens, 0),
        outputTokens: usage.reduce((n, u) => n + u.output_tokens, 0),
        ...runCost(store, run.id),
      },
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
      inputUsdPerMTok: z.number().min(0).max(10_000),
      outputUsdPerMTok: z.number().min(0).max(10_000),
      vision: z.boolean(),
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
        /** Merged into the stored options; a null value removes that option. */
        options: z.record(z.string(), z.unknown()).optional(),
        fallbackId: z.string().nullable().optional(),
        isDefault: z.literal(true).optional(),
      }),
      req,
    );
    assertFallback(patch.fallbackId, req.params.id);
    const current = store.getModelProfile(req.params.id)!;
    let options: Record<string, unknown> | undefined;
    if (patch.options) {
      const merged = Object.fromEntries(Object.entries({ ...current.options, ...patch.options }).filter(([, v]) => v !== null && v !== undefined));
      const valid = modelOptions.safeParse(merged);
      if (!valid.success) throw new HttpError(400, z.prettifyError(valid.error));
      options = valid.data;
    }
    const profile = store.updateModelProfile(req.params.id, { ...patch, options, apiKey: patch.apiKey === undefined ? undefined : patch.apiKey || null });
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
      timeEntries: z.enum(["off", "actual", "estimate"]),
      syncOwner: z.boolean(),
      importAttachments: z.boolean(),
    })
    .partial();

  /** Stamps when time entries were turned on, so earlier work isn't logged retroactively. */
  const withTimeEntriesSince = <O extends { timeEntries?: string; timeEntriesSince?: string }>(next: O, previous?: { timeEntries?: string }): O =>
    next.timeEntries && next.timeEntries !== "off" && (!previous?.timeEntries || previous.timeEntries === "off")
      ? { ...next, timeEntriesSince: new Date().toISOString() }
      : next;

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
    // Attachment import is on for new connections (older ones keep it off until turned on, so no backlog downloads).
    const options = withTimeEntriesSince({ importAttachments: true, ...input.options });
    const connection = store.createPsaConnection({ kind: input.kind as PsaConnection["kind"], name: input.name || info.name, config: input.config, options });
    store.audit({ actor: actor(req), action: "psa.connected", target: connection.id, detail: { kind: connection.kind } });
    return testPsa(connection.id);
  });

  app.patch<{ Params: { id: string } }>("/api/psa/:id", async (req) => {
    const current = store.getPsaConnection(req.params.id);
    if (!current) throw notFound("PSA connection");
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
    store.updatePsaConnection(req.params.id, { ...patch, config, options: patch.options ? withTimeEntriesSince(patch.options, current.options) : undefined });
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

  // Read-only: which fields the PSA returns for the newer queries, never their values.
  app.post<{ Params: { id: string } }>("/api/psa/:id/probe", async (req) => {
    const connection = store.getPsaConnection(req.params.id);
    if (!connection) throw notFound("PSA connection");
    const steps = await probePsa(psa.adapterFor(connection));
    store.audit({ actor: actor(req), action: "psa.probed", target: connection.id, detail: { ok: steps.filter((s) => s.ok).map((s) => s.method) } });
    return { connectionId: connection.id, kind: connection.kind, at: new Date().toISOString(), steps };
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
    templateId: z.string().trim().min(1).max(64).optional(),
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
    const schedule = store.createSchedule({ ...input, templateId: input.templateId && TASK_TEMPLATES.some((t) => t.id === input.templateId) ? input.templateId : null, nextRunAt: new Date(input.startAt).toISOString(), createdBy: actor(req) });
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
    const billing = store.getBillingSettings();
    const q = query(
      z.object({
        days: z.coerce.number().int().min(1).max(730).default(90),
        minutesPerTicket: z.coerce.number().min(0).max(600).default(billing.minutesPerTicket),
        minutesPerAction: z.coerce.number().min(0).max(120).default(billing.minutesPerAction),
      }),
      req,
    );
    return clientReport(store, org, q);
  });

  // ------------------------------------------------------ insight reports

  app.post("/api/insights", async (req) => {
    const input = body(
      z.object({
        // A saved PSA connection, or a prospect's credentials (used for this report only, never stored).
        connectionId: z.string().optional(),
        prospect: z
          .object({
            kind: z.enum(PSA_PROVIDERS.map((p) => p.id) as [string, ...string[]]),
            name: z.string().trim().max(120).optional(),
            config: z.record(z.string(), z.string()),
          })
          .optional(),
        days: z.number().int().min(30).max(90).default(90),
        minutesPerTicket: z.number().min(1).max(600).optional(),
      }),
      req,
    );
    if (Boolean(input.connectionId) === Boolean(input.prospect)) throw new HttpError(400, "Pick a saved PSA connection or enter a prospect's PSA details.");
    let adapter: PsaAdapter;
    let source: { kind: string; label: string; connectionId: string | null };
    if (input.connectionId) {
      const connection = store.getPsaConnection(input.connectionId);
      if (!connection) throw notFound("PSA connection");
      adapter = psa.adapterFor(connection);
      source = { kind: connection.kind, label: connection.name, connectionId: connection.id };
    } else {
      const prospect = input.prospect!;
      const info = PSA_PROVIDERS.find((p) => p.id === prospect.kind)!;
      const missing = info.fields.filter((f) => !f.optional && !prospect.config[f.key]?.trim()).map((f) => f.label);
      if (missing.length) throw new HttpError(400, `Missing: ${missing.join(", ")}`);
      const label = prospect.name || `Prospect (${info.name})`;
      const connection: PsaConnection = {
        id: "insights-prospect",
        kind: info.id,
        name: label,
        customer_map: {},
        options: DEFAULT_PSA_OPTIONS,
        cursor: null,
        enabled: true,
        status: "unknown",
        status_detail: "",
        last_sync_at: null,
        created_at: new Date().toISOString(),
      };
      adapter = buildPsa(connection, prospect.config);
      source = { kind: info.id, label, connectionId: null };
    }
    if (!adapter.listClosedTickets) throw new HttpError(400, `Reports from ${PSA_PROVIDERS.find((p) => p.id === source.kind)?.name ?? source.kind} aren't supported yet.`);
    const minutesPerTicket = input.minutesPerTicket ?? (store.getBillingSettings().minutesPerTicket || 15);
    const id = insights.start({ adapter, source, days: input.days, minutesPerTicket, createdBy: actor(req) });
    // The prospect's credentials stay out of the audit log and the report.
    store.audit({ actor: actor(req), action: "insights.started", target: id, detail: { kind: source.kind, prospect: !source.connectionId, days: input.days } });
    return store.getInsightReport(id);
  });

  app.get("/api/insights", async () => store.listInsightReports());

  app.get<{ Params: { id: string } }>("/api/insights/:id", async (req) => {
    const report = store.getInsightReport(req.params.id);
    if (!report) throw notFound("Report");
    return report;
  });

  app.get<{ Params: { id: string } }>("/api/insights/:id/csv", async (req, reply) => {
    const report = store.getInsightReport(req.params.id);
    if (!report) throw notFound("Report");
    if (report.status !== "done") throw new HttpError(409, "This report isn't finished.");
    const q = query(z.object({ samples: z.enum(["0", "1"]).default("0") }), req);
    const name = `haley-insights-${report.created_at.slice(0, 10)}.csv`;
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}"`)
      .send(insightsCsv(report.result as InsightResult, q.samples === "1"));
  });

  app.delete<{ Params: { id: string } }>("/api/insights/:id", async (req) => {
    if (!store.deleteInsightReport(req.params.id)) throw notFound("Report");
    store.audit({ actor: actor(req), action: "insights.deleted", target: req.params.id });
    return { ok: true };
  });

  // ------------------------------------------------------ usage & billing

  const billingSettings = z.object({
    aiMarkupPercent: z.number().min(0).max(1000),
    autoCloseResolvedDays: z.number().int().min(0).max(90),
    minutesPerTicket: z.number().min(0).max(600),
    minutesPerAction: z.number().min(0).max(120),
  });

  /** A billing period: ?month=YYYY-MM, or ?from=&to= dates; defaults to the current month so far. */
  const usagePeriod = (req: FastifyRequest) => {
    const q = query(
      z.object({
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
      }),
      req,
    );
    if (q.month) {
      const [y, m] = q.month.split("-").map(Number);
      return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
    }
    const today = new Date();
    const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    // `to` is inclusive for callers, so the period ends at the start of the next day.
    const to = q.to ? new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000) : today;
    if (to <= from) throw new HttpError(400, "The end date must be on or after the start date.");
    if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new HttpError(400, "Pick a period of a year or less.");
    return { from, to };
  };

  app.get("/api/usage", async (req) => {
    const { from, to } = usagePeriod(req);
    return usageReport(store, from, to);
  });

  app.get("/api/usage.csv", async (req, reply) => {
    const { from, to } = usagePeriod(req);
    const name = `haley-usage-${from.toISOString().slice(0, 10)}.csv`;
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}"`).send(usageCsv(usageReport(store, from, to)));
  });

  app.get("/api/billing/settings", async () => store.getBillingSettings());

  app.patch("/api/billing/settings", async (req) => {
    const patch = body(billingSettings.partial(), req);
    const before = store.getBillingSettings();
    const next = store.setBillingSettings(patch);
    store.audit({ actor: actor(req), action: "billing.settings_changed", target: "billing", detail: { from: before, to: next } });
    return next;
  });

  const helpdeskSettings = z
    .object({
      qaBeforeClose: z.enum(["off", "warn", "require"]),
      qaModelCheck: z.boolean(),
      sentimentModelCheck: z.boolean(),
      autoAssignOnEscalation: z.enum(["off", "suggested"]),
      attachmentRetentionDays: z.number().int().min(0).max(3650),
    })
    .partial();

  app.get("/api/helpdesk/settings", async () => store.getHelpdeskSettings());

  app.patch("/api/helpdesk/settings", async (req) => {
    const patch = body(helpdeskSettings, req);
    const before = store.getHelpdeskSettings();
    const next = store.setHelpdeskSettings(patch);
    store.audit({ actor: actor(req), action: "helpdesk.settings_changed", target: "helpdesk", detail: { from: before, to: next } });
    return next;
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

  /** Send a change back to Haley with what should be different; she adjusts and may propose it again. */
  app.post<{ Params: { id: string } }>("/api/actions/:id/request-changes", async (req) => {
    if (!store.getAction(req.params.id)) throw notFound("Action");
    const { note } = body(z.object({ note: z.string().trim().min(3, "Say what should change.").max(1000) }), req);
    return agent.decideAction(req.params.id, "changes", actor(req), note);
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

  // Let approval posts already in flight finish before the database closes.
  app.addHook("onClose", async () => approvalNotifier.idle());
  app.addHook("onClose", async () => frustration.idle());
  app.addHook("onClose", async () => lessons.idle());
  app.addHook("onClose", async () => insights.idle());
  app.addHook("onClose", async () => db.close());
  app.addHook("onClose", async () => scheduler.stop());
  return { app, store, agent, scheduler, psa, syncroWebhook, approvalNotifier, frustration, lessons, insights };
}
