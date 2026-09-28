import { ArrowUp, CornerDownLeft, ExternalLink, Info, MessageCircleDashed, MessageSquareText, OctagonPause, RotateCcw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, errorMessage, type Assurance, type Delivery, type TicketDetail, type TicketEvent } from "../api";
import { ApprovalCard } from "../components/ApprovalCard";
import { Avatar, isHaley } from "../components/Avatar";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { Markdown } from "../components/Markdown";
import { OrgSelect } from "../components/OrgSelect";
import { PageHeader } from "../components/PageHeader";
import { AssuranceBadge, RunModeBadge, RunStatusPill, TicketStatusPill } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { ASSURANCE_META, isRunActive, PROVIDER_NAMES } from "../lib/format";

const VERIFIERS = new Set(["duo", "okta", "sms_code"]);

type SimAssurance = Exclude<Assurance, "technician" | "mfa">;
const LEVELS: SimAssurance[] = ["none", "email", "chat", "directory"];
const LEVEL_AS: Record<SimAssurance, string> = {
  none: "an unverified user",
  email: "a DMARC-verified email sender",
  chat: "a signed-in Slack or chat user",
  directory: "a Teams user matched to the directory",
};

const SUGGESTIONS = [
  "I forgot my password and I'm locked out of my account",
  "I lost my phone. Can you sign me out everywhere?",
  "Can you add me to the Finance shared mailbox?",
  "Outlook keeps asking for my password",
];

interface Bubble {
  id: string;
  /** "sms": a sandbox verification text, shown like a phone notification. */
  side: "me" | "them" | "sms";
  author: string;
  text: string;
  at: string | null;
  delivery?: Delivery;
  pending?: boolean;
}

/** Turns a ticket timeline into what the end user would see: their messages and public replies. */
function toBubbles(events: TicketEvent[], requesterEmail: string): Bubble[] {
  const out: Bubble[] = [];
  for (const e of events) {
    if (e.kind === "created") {
      out.push({ id: e.id, side: "me", author: e.author, text: e.body, at: e.created_at });
    } else if (e.kind === "comment" && (e.meta.channel || e.meta.fromRequester)) {
      const mine = e.meta.fromRequester === true || (typeof e.meta.senderEmail === "string" && e.meta.senderEmail.toLowerCase() === requesterEmail.toLowerCase());
      out.push({ id: e.id, side: mine ? "me" : "them", author: e.author, text: e.body, at: e.created_at });
    } else if (e.kind === "agent_note" && e.meta.sandbox === true) {
      out.push({ id: e.id, side: "sms", author: "IT verification", text: e.body.replace(/^\[Sandbox text to [^\]]+\]\s*/, ""), at: e.created_at });
    } else if (e.kind === "reply") {
      const d = e.meta.delivery as Delivery | undefined;
      out.push({ id: e.id, side: "them", author: e.author, text: e.body, at: e.created_at, delivery: d && typeof d === "object" ? d : undefined });
    }
  }
  return out;
}

export function SimulatorPage() {
  const { toast, refreshStats } = useApp();
  const [params, setParams] = useSearchParams();
  const orgs = usePoll(() => api.orgs(), []);
  const orgId = params.get("orgId") ?? "";
  const org = orgs.data?.find((o) => o.id === orgId);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("Megan Bowen");
  const [assurance, setAssurance] = useState<SimAssurance>("directory");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // The message just sent, shown until the ticket timeline has it (avoids a flicker between POST and poll).
  const [outbox, setOutbox] = useState<{ text: string; ticketId: string | null; mineBefore: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Pick a client automatically when there's only one, and a plausible address on its domain.
  useEffect(() => {
    if (!orgId && orgs.data?.length) setOrg(orgs.data[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgs.data, orgId]);
  useEffect(() => {
    if (org && !threadId) setEmail(`${name.split(" ")[0]?.toLowerCase() || "megan"}@${org.domain || "example.com"}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  const detail = usePoll<TicketDetail | undefined>(() => (ticketId ? api.ticket(ticketId) : Promise.resolve(undefined)), [ticketId], ticketId ? 1500 : null);
  const d = detail.data;
  const bubbles = useMemo(() => (d ? toBubbles(d.events, d.ticket.requester_email || email) : []), [d, email]);
  const latestRun = d?.runs[0];
  const working = Boolean(latestRun && isRunActive(latestRun.status));
  const pending = d?.actions.filter((a) => a.status === "pending_approval") ?? [];

  const mine = bubbles.filter((b) => b.side === "me").length;
  const verifier = org?.integrations.find((i) => VERIFIERS.has(i.provider));
  const echoed = Boolean(outbox && d && outbox.ticketId === d.ticket.id && mine > outbox.mineBefore);
  const shown: Bubble[] =
    outbox && !echoed ? [...bubbles, { id: "sending", side: "me", author: name, text: outbox.text, at: null, pending: true }] : bubbles;

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, working, pending.length]);

  function setOrg(id: string) {
    const next = new URLSearchParams(params);
    if (id) next.set("orgId", id);
    else next.delete("orgId");
    setParams(next, { replace: true });
  }

  const reset = () => {
    setThreadId(null);
    setTicketId(null);
    setOutbox(null);
    setError(null);
    setDraft("");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const send = async (e?: FormEvent, text = draft) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    if (!orgId) return setError("Choose a client first.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("Enter the requester's email address.");
    setError(null);
    setSending(true);
    setDraft("");
    setOutbox({ text: body, ticketId, mineBefore: mine });
    try {
      const res = await api.simulate({ orgId, email: email.trim(), name: name.trim(), assurance, text: body, threadId: threadId ?? undefined });
      setThreadId(res.threadId);
      // A resolved conversation continues on a new ticket.
      setOutbox({ text: body, ticketId: res.ticketId, mineBefore: res.ticketId === ticketId ? mine : 0 });
      if (res.ticketId !== ticketId) setTicketId(res.ticketId);
      else await detail.reload();
      if (res.created) refreshStats();
    } catch (err) {
      setOutbox(null);
      setDraft(body);
      setError(errorMessage(err));
      toast(errorMessage(err), "error");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const started = Boolean(threadId);
  const noOrgs = orgs.data?.length === 0;

  return (
    <>
      <PageHeader
        title="Try Haley as an end user"
        subtitle="Chat the way a client's employee would from Slack, Teams or a chat widget. Messages go through the same pipeline: a real ticket, the client's autonomy policy and your approval queue."
        actions={
          <Link to="/channels" className="btn">
            Channel setup
          </Link>
        }
      />
      {orgs.error && <ErrorBanner error={orgs.error} onRetry={orgs.reload} />}
      {noOrgs ? (
        <div className="card">
          <EmptyState
            icon={<MessageCircleDashed className="icon" />}
            title="Add a client first"
            actions={
              <Link to="/clients?new=1" className="btn btn-primary">
                Add client
              </Link>
            }
          >
            The simulator sends messages as an employee of one of your clients. Load the demo workspace from the dashboard to try it quickly.
          </EmptyState>
        </div>
      ) : !orgs.data ? (
        <Loading />
      ) : (
        <div className="sim-layout">
          <aside className="card sim-setup" aria-labelledby="sim-setup-title">
            <div className="card-header">
              <h2 id="sim-setup-title">Who's asking</h2>
              <span className="spacer" />
              {started && (
                <button className="btn btn-sm" onClick={reset}>
                  <RotateCcw className="icon-sm" aria-hidden="true" /> New conversation
                </button>
              )}
            </div>
            <div className="card-body stack">
              <div className="field">
                <label htmlFor="sim-org">Client</label>
                <OrgSelect id="sim-org" orgs={orgs.data} value={orgId} onChange={(v) => { setOrg(v); reset(); }} />
              </div>
              <div className="form-grid sim-person">
                <div className="field">
                  <label htmlFor="sim-name">Name</label>
                  <input id="sim-name" className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={started} autoComplete="off" />
                </div>
                <div className="field">
                  <label htmlFor="sim-email">Email</label>
                  <input id="sim-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={started} autoComplete="off" spellCheck={false} />
                </div>
              </div>
              <div className="field">
                <span className="field-label" id="sim-level">
                  Identity
                </span>
                <div className="sim-levels" role="radiogroup" aria-labelledby="sim-level">
                  {LEVELS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      role="radio"
                      aria-checked={assurance === a}
                      className="choice choice-compact"
                      disabled={started}
                      onClick={() => setAssurance(a)}
                    >
                      <span className="choice-title">
                        <AssuranceBadge assurance={a} short />
                      </span>
                      <span className="choice-desc">As {LEVEL_AS[a]}</span>
                    </button>
                  ))}
                </div>
                <span className="help">{ASSURANCE_META[assurance].how}</span>
              </div>
              {org && (
                <div className="sim-policy">
                  <Info className="icon-sm" aria-hidden="true" />
                  <span>
                    {org.name} is on <strong>{org.autonomy.replace("_", "-")}</strong> autonomy.{" "}
                    {org.autonomy === "unattended"
                      ? "Verified requesters can get their own account fixed with no technician."
                      : "Changes follow that policy; switch to Unattended on the client page for full self-service."}{" "}
                    <Link to={`/clients/${org.id}`}>Client settings</Link>
                  </span>
                </div>
              )}
              {org && verifier && (
                <div className="sim-policy sim-verify">
                  <ShieldCheck className="icon-sm" aria-hidden="true" />
                  <span>
                    Haley can verify you with <strong>{PROVIDER_NAMES[verifier.provider] ?? verifier.provider}</strong>
                    {verifier.mode === "sandbox" ? " (sandbox)" : ""} before security-sensitive changes, e.g. a password reset for an email-verified
                    requester.
                    {verifier.provider === "sms_code" &&
                      (verifier.mode === "sandbox"
                        ? " The code arrives right in this conversation as a text; type it back to her."
                        : " The code goes to the real phone on the user's account.")}
                    {verifier.provider !== "sms_code" && " The push goes to the user's real enrolled device."}
                  </span>
                </div>
              )}
              {started && <p className="muted" style={{ fontSize: "var(--text-sm)" }}>Start a new conversation to change who's asking.</p>}
            </div>
          </aside>

          <section className="chat" aria-label="Conversation">
            <header className="chat-head">
              <Avatar name="haley" large />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="chat-title">Haley</div>
                <div className="chat-sub truncate">
                  {working ? "Working on it…" : org ? `IT help for ${org.name}` : "IT help"}
                </div>
              </div>
              {d && (
                <div className="row row-wrap chat-meta">
                  <Link to={`/tickets/${d.ticket.id}`} className="pill pill-outline" title="Open the ticket in the dashboard">
                    #{d.ticket.number} <ExternalLink className="icon-xs" aria-hidden="true" />
                  </Link>
                  <TicketStatusPill status={d.ticket.status} />
                  {latestRun && (
                    <Link to={`/runs/${latestRun.id}`} className="row" style={{ gap: 4 }} title="Open Haley's run">
                      <RunModeBadge mode={latestRun.mode} />
                      <RunStatusPill status={latestRun.status} />
                    </Link>
                  )}
                </div>
              )}
            </header>

            {verifier && !org?.settings?.paused && (
              <div className="chat-notice tone-green">
                <ShieldCheck className="icon-sm" aria-hidden="true" /> Haley can verify you with {PROVIDER_NAMES[verifier.provider] ?? verifier.provider}
                {verifier.mode === "sandbox" ? " (sandbox: codes appear here)" : ""}.
              </div>
            )}
            {org?.settings?.paused && (
              <div className="chat-notice tone-red">
                <OctagonPause className="icon-sm" aria-hidden="true" /> Haley is paused for {org.name}: requests are acknowledged and left for technicians.
              </div>
            )}

            <ol className="chat-log" ref={listRef} aria-live="polite">
              {shown.length === 0 && (
                <li className="chat-empty">
                  <Avatar name="haley" large />
                  <p>
                    <strong>Hi{name ? ` ${name.split(" ")[0]}` : ""}, I'm Haley from IT.</strong> What can I help with?
                  </p>
                  <div className="chat-suggestions">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} type="button" className="chip chip-button" onClick={() => void send(undefined, s)} disabled={!orgId || sending}>
                        {s}
                      </button>
                    ))}
                  </div>
                </li>
              )}
              {shown.map((b, i) => {
                if (b.side === "sms") {
                  const code = /\b\d{6}\b/.exec(b.text)?.[0];
                  return (
                    <li key={b.id} className="sms-notification" aria-label="Text message on the requester's phone">
                      <div className="sms-notification-card">
                        <div className="sms-notification-head">
                          <span className="sms-notification-app">
                            <MessageSquareText className="icon-xs" aria-hidden="true" />
                          </span>
                          <span className="sms-notification-title">Messages · IT verification</span>
                          <span className="spacer" />
                          <span className="sms-notification-time">
                            <RelativeTime iso={b.at} />
                          </span>
                        </div>
                        <p className="sms-notification-body">
                          {code
                            ? b.text.split(code).flatMap((part, n) => (n === 0 ? [part] : [<mark key={n} className="sms-code">{code}</mark>, part]))
                            : b.text}
                        </p>
                        <div className="sms-notification-foot">
                          <span>Sandbox text: arrives on the requester's phone in live mode</span>
                          {code && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                setDraft(code);
                                inputRef.current?.focus();
                              }}
                            >
                              <CornerDownLeft className="icon-sm" aria-hidden="true" /> Reply with {code}
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                }
                const prev = shown[i - 1];
                const grouped = prev && prev.side === b.side && prev.author === b.author;
                const them = b.side === "them";
                return (
                  <li key={b.id} className={`chat-msg ${them ? "them" : "me"} ${grouped ? "grouped" : ""} ${b.pending ? "is-pending" : ""}`}>
                    {them && <span className="chat-avatar">{!grouped && <Avatar name={b.author} />}</span>}
                    <div className="chat-stack">
                      {them && !grouped && <span className="chat-author">{isHaley(b.author) ? "Haley" : b.author === "system" ? "IT team" : b.author}</span>}
                      <div className="chat-bubble">
                        {them ? <Markdown source={b.text} /> : <div className="pre-wrap">{b.text}</div>}
                      </div>
                      <span className="chat-time">
                        {b.pending ? (
                          "Sending…"
                        ) : (
                          <>
                            <RelativeTime iso={b.at} />
                            {b.delivery && (
                              <span className={`delivery ${b.delivery.delivered ? "ok" : "failed"}`} title={b.delivery.detail}>
                                {" "}
                                · {b.delivery.delivered ? `Delivered via ${b.delivery.detail}` : "Not delivered"}
                              </span>
                            )}
                          </>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
              {pending.length > 0 && (
                <li className="chat-approvals">
                  <div className="chat-approvals-head">
                    <ShieldCheck className="icon-sm" aria-hidden="true" /> Waiting on a technician: {pending.length} change{pending.length === 1 ? "" : "s"} need
                    approval. The requester doesn't see this; you can decide right here.
                  </div>
                  {pending.map((a) => (
                    <ApprovalCard key={a.id} action={a} compact hideContext onDecided={() => void detail.reload()} />
                  ))}
                </li>
              )}
              {working && pending.length === 0 && (
                <li className="chat-msg them">
                  <span className="chat-avatar">
                    <Avatar name="haley" />
                  </span>
                  <div className="chat-bubble typing" aria-label="Haley is typing">
                    <span />
                    <span />
                    <span />
                  </div>
                </li>
              )}
            </ol>

            {error && (
              <p className="error-text chat-error" role="alert">
                {error}
              </p>
            )}
            <form className="chat-composer" onSubmit={send}>
              <label htmlFor="sim-input" className="sr-only">
                Message
              </label>
              <textarea
                id="sim-input"
                ref={inputRef}
                rows={1}
                value={draft}
                placeholder={orgId ? `Message Haley as ${name.split(" ")[0] || "the requester"}…` : "Choose a client to start"}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                disabled={!orgId}
              />
              <button className="btn btn-primary btn-icon chat-send" type="submit" disabled={!draft.trim() || sending || !orgId} aria-label="Send">
                {sending ? <Spinner /> : <ArrowUp className="icon" aria-hidden="true" />}
              </button>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
