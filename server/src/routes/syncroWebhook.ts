import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AlertTickets } from "../monitoring/alerts.js";
import type { PsaSync } from "../psa/sync.js";
import type { Store } from "../store.js";

/** Deliveries closer together than this collapse into one sync (plus one trailing sync for the latest change). */
export const WEBHOOK_MIN_GAP_MS = 10_000;

/** Runs `work` now, or once more after the gap if it's asked for again while running or too soon. */
export class Debouncer {
  private lastStart = 0;
  private running: Promise<void> | null = null;
  private trailing: NodeJS.Timeout | null = null;

  constructor(
    private readonly work: () => Promise<unknown>,
    private readonly gapMs = WEBHOOK_MIN_GAP_MS,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  trigger(): "started" | "queued" {
    const wait = this.lastStart + this.gapMs - Date.now();
    if (!this.running && wait <= 0) {
      this.start();
      return "started";
    }
    if (!this.trailing) {
      this.trailing = setTimeout(() => {
        this.trailing = null;
        // Still busy: chain after it rather than overlapping.
        void (this.running ?? Promise.resolve()).then(() => this.start());
      }, Math.max(wait, 0) + 50);
      this.trailing.unref();
    }
    return "queued";
  }

  private start() {
    this.lastStart = Date.now();
    this.running = this.work()
      .then(() => undefined, this.onError)
      .finally(() => {
        this.running = null;
      });
  }

  /** For tests and shutdown: wait for the current run, if any. */
  async idle(): Promise<void> {
    await this.running;
  }

  stop() {
    if (this.trailing) clearTimeout(this.trailing);
    this.trailing = null;
  }
}

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * POST /hooks/syncro/:secret — the URL MSPs paste into a Syncro Notification Set (ticket and RMM alert events).
 * Syncro doesn't sign webhooks, so a delivery is only a hint: the payload is ignored and Haley re-reads
 * everything from Syncro's API, exactly as the two-minute sync would, just sooner.
 */
export function registerSyncroWebhook(
  app: FastifyInstance,
  deps: { store: Store; psa: PsaSync; alerts: AlertTickets; publicUrl: string; actor: (req: FastifyRequest) => string; log: (err: unknown) => void },
): Debouncer {
  const { store, psa, alerts } = deps;
  const debouncer = new Debouncer(async () => {
    for (const connection of store.listPsaConnections()) {
      if (connection.kind === "syncro" && connection.enabled) await psa.sync(connection.id);
    }
    await alerts.pollNow(Date.now(), "syncro_rmm");
  }, WEBHOOK_MIN_GAP_MS, deps.log);

  const url = (secret: string) => `${deps.publicUrl}/hooks/syncro/${secret}`;

  // Scoped so Syncro can post JSON, a form or nothing at all: the body is never read.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 256 * 1024 }, (_req, _body, done) => done(null, undefined));
    scope.post<{ Params: { secret: string } }>("/hooks/syncro/:secret", async (req, reply) => {
      if (!sameSecret(req.params.secret, store.webhookSecret("syncro"))) return reply.status(404).send({ error: "Not found" });
      return { ok: true, sync: debouncer.trigger() };
    });
  });

  app.get("/api/syncro/webhook", async () => ({ url: url(store.webhookSecret("syncro")), minGapSeconds: WEBHOOK_MIN_GAP_MS / 1000 }));

  app.post("/api/syncro/webhook/rotate", async (req) => {
    const secret = store.webhookSecret("syncro", true);
    store.audit({ actor: deps.actor(req), action: "syncro.webhook_rotated", target: "syncro" });
    return { url: url(secret), minGapSeconds: WEBHOOK_MIN_GAP_MS / 1000 };
  });

  return debouncer;
}
