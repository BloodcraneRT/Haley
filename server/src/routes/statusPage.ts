import type { FastifyInstance, FastifyReply } from "fastify";
import type { ChannelHub } from "../channels/hub.js";
import type { Store } from "../store.js";
import type { Ticket, TicketEvent, TicketStatus } from "../types.js";

/** Replies from one status page per hour; enough for a conversation, not for flooding the ticket. */
const MAX_PAGE_MESSAGES_PER_HOUR = 10;

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STATUS_TEXT: Record<TicketStatus, { label: string; note: string }> = {
  new: { label: "Received", note: "We've got your request and will be on it shortly." },
  in_progress: { label: "Being worked on", note: "Someone is working on this now." },
  awaiting_approval: { label: "Being worked on", note: "A step needs a quick sign-off from the IT team; it will continue as soon as that's done." },
  waiting_on_customer: { label: "Waiting for you", note: "We need something from you to continue. See the latest message below." },
  escalated: { label: "With a technician", note: "A technician has picked this up." },
  resolved: { label: "Resolved", note: "We think this is fixed. Let us know if it works." },
  closed: { label: "Closed", note: "This request is closed. Reply below if you still need help." },
};

/** What the requester sees: their own messages and the replies they were sent. Never internal notes. */
function publicHistory(ticket: Ticket, events: TicketEvent[]) {
  return events
    .filter((e) => e.kind === "created" || e.kind === "reply" || (e.kind === "comment" && e.meta.fromRequester === true))
    .map((e) => ({
      at: e.created_at,
      fromRequester: e.kind !== "reply",
      who: e.kind === "reply" ? (e.author === "haley" ? "Haley (IT support)" : "IT support") : "You",
      // A request with no description still shows what was asked.
      body: e.kind === "created" && !e.body.trim() ? ticket.title : e.body,
    }))
    .filter((e) => e.body.trim());
}

const DONE: Record<string, string> = {
  reply: "Thanks, your message was added to the request.",
  confirm: "Thanks for confirming! We've closed this request.",
  reopen: "Thanks for letting us know. We're back on it.",
  limit: "You've sent several messages recently. Please wait a little before sending more.",
};

function page(token: string, ticket: Ticket, events: TicketEvent[], done: string | undefined): string {
  const status = STATUS_TEXT[ticket.status];
  const history = publicHistory(ticket, events);
  const when = (iso: string) => new Date(iso).toUTCString().replace(" GMT", " UTC");
  const action = (path: string) => `/t/${encodeURIComponent(token)}/${path}`;
  const resolved = ticket.status === "resolved";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Request #${ticket.number}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#111827; --muted:#6b7280; --accent:#4f46e5; --line:#e5e7eb; --you:#eef2ff; --ok:#047857; --okbg:#ecfdf5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0d12; --card:#151922; --fg:#e5e7eb; --muted:#9ca3af; --line:#262b36; --you:#1e2340; --ok:#6ee7b7; --okbg:#0f2a22; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui, sans-serif; padding:24px 16px; }
  main { max-width:640px; margin:0 auto; display:flex; flex-direction:column; gap:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; }
  h1 { font-size:20px; margin:0 0 4px; overflow-wrap:anywhere; } .muted { color:var(--muted); font-size:14px; }
  .status { display:inline-block; font-weight:600; font-size:14px; padding:3px 10px; border-radius:999px; background:var(--you); margin:10px 0 6px; }
  .done { background:var(--okbg); color:var(--ok); border-radius:10px; padding:10px 14px; font-size:15px; }
  ol { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:12px; }
  li { border:1px solid var(--line); border-radius:12px; padding:12px 14px; } li.you { background:var(--you); border-color:transparent; }
  .who { font-weight:600; font-size:14px; } .body { white-space:pre-wrap; overflow-wrap:anywhere; margin-top:4px; }
  textarea { width:100%; min-height:96px; border:1px solid var(--line); border-radius:10px; padding:10px; font:inherit; background:transparent; color:inherit; }
  .row { display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; }
  button { background:var(--accent); color:#fff; border:0; border-radius:10px; padding:11px 16px; font-size:15px; cursor:pointer; }
  button.secondary { background:transparent; color:var(--fg); border:1px solid var(--line); }
  form { margin:0; }
</style></head>
<body><main>
  ${done && DONE[done] ? `<div class="done" role="status">${escape(DONE[done])}</div>` : ""}
  <section class="card">
    <div class="muted">Request #${ticket.number}</div>
    <h1>${escape(ticket.title)}</h1>
    <div class="status">${escape(status.label)}</div>
    <div class="muted">${escape(status.note)}</div>
  </section>
  ${
    resolved
      ? `<section class="card"><strong>Is it working now?</strong>
    <div class="row">
      <form method="post" action="${action("confirm")}"><button type="submit">Yes, it's fixed</button></form>
      <form method="post" action="${action("reopen")}"><button type="submit" class="secondary">No, still having the problem</button></form>
    </div></section>`
      : ""
  }
  <section class="card"><ol>
    ${history
      .map(
        (h) => `<li class="${h.fromRequester ? "you" : ""}"><div class="who">${escape(h.who)} <span class="muted">· ${escape(when(h.at))}</span></div><div class="body">${escape(h.body)}</div></li>`,
      )
      .join("\n    ")}
  </ol></section>
  <section class="card">
    <form method="post" action="${action("reply")}">
      <label for="message"><strong>Add a message</strong></label>
      <textarea id="message" name="message" maxlength="4000" required placeholder="Anything to add? Never send passwords or codes."></textarea>
      <div class="row"><button type="submit">Send</button></div>
    </form>
  </section>
  <p class="muted">This private link was sent only to you. Please don't share it.</p>
</main></body></html>`;
}

/**
 * The end-user status page: /t/<signed token>. The requester sees their request's status and its public
 * conversation, replies, and confirms it's fixed (or not) without signing in. The link is the credential, so
 * replies count as email-level identity: on tickets that started on a stronger channel they're recorded for a
 * technician but don't let Haley act on the requester's authority.
 */
export function registerStatusPage(app: FastifyInstance, deps: { store: Store; hub: ChannelHub }): void {
  const { store, hub } = deps;

  const load = (token: string): Ticket | null => {
    const id = store.verifyStatusToken(token);
    return id ? store.getTicket(id) : null;
  };
  const html = (reply: FastifyReply) =>
    reply
      .header("cache-control", "no-store")
      .header("x-robots-tag", "noindex")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
      .type("text/html; charset=utf-8");
  const gone = (reply: FastifyReply) =>
    html(reply)
      .status(404)
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link expired</title><body style="font:16px system-ui;padding:32px;max-width:520px;margin:auto">This link has expired or isn't valid. Reply to your last message from IT support to get a new one.</body>`);
  const back = (reply: FastifyReply, token: string, done: string) => reply.status(303).header("location", `/t/${encodeURIComponent(token)}?done=${done}`).send();

  app.get<{ Params: { token: string }; Querystring: { done?: string } }>("/t/:token", async (req, reply) => {
    const ticket = load(req.params.token);
    if (!ticket) return gone(reply);
    return html(reply).send(page(req.params.token, ticket, store.listTicketEvents(ticket.id), req.query.done));
  });

  // Plain HTML forms post url-encoded bodies; scoped so the rest of the API still only takes JSON.
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    const recentPageMessages = (ticket: Ticket) =>
      store.listTicketEvents(ticket.id).filter((e) => e.meta.statusPage && Date.now() - Date.parse(e.created_at) < 3_600_000).length;

    const fromRequester = (ticket: Ticket, text: string) => {
      hub.appendToTicket(ticket, {
        channel: "portal",
        author: ticket.requester_name || ticket.requester_email || "Requester",
        email: ticket.requester_email || null,
        // The link may have been forwarded: it never proves more than an email address does.
        assurance: "email",
        text,
      });
      const added = store.listTicketEvents(ticket.id).findLast((e) => e.kind === "comment" && e.body === text);
      if (added) store.mergeTicketEventMeta(added.id, { statusPage: true });
    };

    scope.post<{ Params: { token: string }; Body: { message?: string } }>("/t/:token/reply", async (req, reply) => {
      const ticket = load(req.params.token);
      if (!ticket) return gone(reply);
      const message = String(req.body?.message ?? "").trim().slice(0, 4000);
      if (message.length < 1) return back(reply, req.params.token, "");
      if (recentPageMessages(ticket) >= MAX_PAGE_MESSAGES_PER_HOUR) return back(reply, req.params.token, "limit");
      fromRequester(ticket, message);
      return back(reply, req.params.token, "reply");
    });

    scope.post<{ Params: { token: string } }>("/t/:token/reopen", async (req, reply) => {
      const ticket = load(req.params.token);
      if (!ticket) return gone(reply);
      if (recentPageMessages(ticket) >= MAX_PAGE_MESSAGES_PER_HOUR) return back(reply, req.params.token, "limit");
      fromRequester(ticket, "It's still not fixed. I'm still having the problem.");
      return back(reply, req.params.token, "reopen");
    });

    scope.post<{ Params: { token: string } }>("/t/:token/confirm", async (req, reply) => {
      const ticket = load(req.params.token);
      if (!ticket) return gone(reply);
      // Confirming only closes a resolved ticket: it can't change anything else.
      if (ticket.status === "resolved" && !ticket.resolution_confirmed_at) {
        const who = ticket.requester_name || ticket.requester_email || "Requester";
        const resolvedAt = ticket.resolved_at;
        store.updateTicket(ticket.id, { status: "closed" }, who);
        store.markResolutionConfirmed(ticket.id, new Date().toISOString(), resolvedAt ?? undefined);
        store.addTicketEvent(ticket.id, "action", who, "Confirmed it's fixed on the status page.", { resolutionConfirmed: true, statusPage: true });
        store.audit({ orgId: ticket.org_id, actor: "requester", action: "ticket.resolution_confirmed", target: ticket.id, detail: { via: "status_page" } });
      }
      return back(reply, req.params.token, "confirm");
    });
  });
}
