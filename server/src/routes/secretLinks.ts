import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";

const LABELS: Record<string, string> = {
  temporaryPassword: "Temporary password",
  temporaryAccessPass: "Temporary Access Pass",
  userPrincipalName: "Username",
  primaryEmail: "Username",
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A tiny standalone page. GET never reveals anything (mail link scanners follow links); the person
 * presses a button, which POSTs and consumes the link.
 */
const page = (token: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Your sign-in details</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#111827; --muted:#6b7280; --accent:#4f46e5; --line:#e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0d12; --card:#151922; --fg:#e5e7eb; --muted:#9ca3af; --line:#262b36; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; padding:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; max-width:420px; width:100%; }
  h1 { font-size:20px; margin:0 0 8px; } p { color:var(--muted); margin:0 0 20px; }
  button { background:var(--accent); color:#fff; border:0; border-radius:10px; padding:12px 18px; font-size:15px; cursor:pointer; width:100%; }
  dl { margin:0; } dt { color:var(--muted); font-size:13px; margin-top:14px; } dd { margin:4px 0 0; font:600 18px ui-monospace, monospace; word-break:break-all; }
  .note { font-size:13px; margin-top:20px; }
</style></head>
<body><main class="card">
  <h1>Your sign-in details</h1>
  <p id="intro">This link works once. Reveal it only when you're ready to sign in.</p>
  <button id="reveal">Reveal</button>
  <div id="out" hidden></div>
</main>
<script>
  document.getElementById("reveal").onclick = async (e) => {
    e.target.disabled = true;
    const res = await fetch(${JSON.stringify(`/s/${token}/reveal`)}, { method: "POST" });
    const out = document.getElementById("out");
    out.hidden = false; e.target.hidden = true;
    if (!res.ok) { document.getElementById("intro").textContent = "This link has expired or was already used. Contact your IT team."; return; }
    const data = await res.json();
    document.getElementById("intro").textContent = "Use these now. You'll be asked to set up your own password or sign-in method.";
    out.innerHTML = "<dl>" + data.items.map((i) => "<dt>" + i.label + "</dt><dd>" + i.value + "</dd>").join("") + "</dl><p class='note'>Don't share this. The link no longer works.</p>";
  };
</script></body></html>`;

export function registerSecretLinks(app: FastifyInstance, store: Store) {
  app.get<{ Params: { token: string } }>("/s/:token", async (req, reply) => {
    reply.header("cache-control", "no-store").header("x-robots-tag", "noindex").type("text/html; charset=utf-8");
    return page(req.params.token.replace(/[^A-Za-z0-9_-]/g, ""));
  });

  app.post<{ Params: { token: string } }>("/s/:token/reveal", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const link = store.getSecretLink(req.params.token);
    if (!link || !store.consumeSecretLink(req.params.token)) return reply.status(410).send({ error: "Expired or already used" });
    const secrets = store.revealActionSecrets(link.action_id) ?? {};
    const action = store.getAction(link.action_id);
    store.audit({ orgId: action?.org_id, actor: "requester", action: "secret.link_viewed", target: link.action_id, detail: { ticketId: link.ticket_id, ip: req.ip } });
    return { items: Object.entries(secrets).map(([k, v]) => ({ label: escape(LABELS[k] ?? k), value: escape(v) })) };
  });
}
