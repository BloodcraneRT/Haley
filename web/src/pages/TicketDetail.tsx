import {
  ArrowRight,
  CalendarClock,
  Check,
  ChevronRight,
  ClipboardList,
  CircleDot,
  CircleX,
  Flag,
  Hourglass,
  Lock,
  Mail,
  MessageCircle,
  PencilLine,
  Play,
  Reply,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Smartphone,
  Sparkles,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api,
  ApiError,
  errorMessage,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Action,
  type Delivery,
  type Run,
  type RunMode,
  type Schedule,
  type SlaState,
  type TicketDetail,
  type TicketEvent,
  type TicketPatch,
  type TicketPriority,
  type TicketStatus,
} from "../api";
import { ApprovalCard } from "../components/ApprovalCard";
import { Avatar, displayName, isHaley } from "../components/Avatar";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { Markdown } from "../components/Markdown";
import { PageHeader } from "../components/PageHeader";
import { ChannelBadge, IdentityBadge, Pill, psaRef, RunModeBadge, RunStatusPill, SlaStatePill, TicketStatusPill } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { RevealSecretButton } from "../components/RevealSecret";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { CopyButton } from "../components/CopyButton";
import { useNow } from "../hooks/useNow";
import {
  absoluteTime,
  ASSURANCE_META,
  CADENCE_META,
  CHANNEL_META,
  humanize,
  isRunActive,
  mfaExpiresAt,
  PRIORITY_META,
  TICKET_STATUS_META,
  VERIFICATION_META,
} from "../lib/format";

const runBusy = (r: Run) => r.status === "queued" || r.status === "running" || r.status === "awaiting_approval";

export function TicketDetailPage() {
  const { id = "" } = useParams();
  const { toast, refreshStats } = useApp();
  const detail = usePoll(() => api.ticket(id), [id], (d) => (d?.runs.some((r) => isRunActive(r.status)) ? 2000 : 15_000));
  const [starting, setStarting] = useState<RunMode | null>(null);

  if (detail.error instanceof ApiError && detail.error.status === 404) {
    return (
      <div className="card">
        <EmptyState title="Ticket not found" actions={<Link to="/tickets" className="btn">Back to tickets</Link>}>
          It may have been deleted along with its client.
        </EmptyState>
      </div>
    );
  }
  if (!detail.data) return detail.error ? <ErrorBanner error={detail.error} onRetry={detail.reload} /> : <Loading />;

  const { ticket, events, runs, actions } = detail.data;
  const schedules = detail.data.schedules ?? [];
  // Runs come newest first.
  const latest = runs[0];
  const active = runs.find(runBusy);
  const pending = actions.filter((a) => a.status === "pending_approval");
  const secrets = actions.filter((a) => a.has_secrets);
  const actionsById = new Map(actions.map((a) => [a.id, a]));

  const runHaley = async (mode: RunMode = "live") => {
    setStarting(mode);
    try {
      await api.runTicket(ticket.id, mode);
      toast(mode === "plan" ? "Haley is planning this ticket. Nothing will be changed." : "Haley is working this ticket.");
      refreshStats();
    } catch (err) {
      toast(err instanceof ApiError && err.status === 409 ? err.message : errorMessage(err), err instanceof ApiError && err.status === 409 ? "info" : "error");
    } finally {
      setStarting(null);
      void detail.reload();
    }
  };

  const patchTicket = async (patch: TicketPatch) => {
    detail.mutate((d) => d && { ...d, ticket: { ...d.ticket, ...patch } });
    try {
      await api.updateTicket(ticket.id, patch);
      refreshStats();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      void detail.reload();
    }
  };

  return (
    <>
      <PageHeader
        docTitle={`#${ticket.number} ${ticket.title}`}
        breadcrumb={
          <>
            <Link to="/tickets">Tickets</Link>
            <ChevronRight className="icon-sm" aria-hidden="true" />
            <Link to={`/clients/${ticket.org_id}`}>{ticket.org_name}</Link>
            <ChevronRight className="icon-sm" aria-hidden="true" />
            <span>#{ticket.number}</span>
          </>
        }
        title={
          <>
            <span className="ticket-number">#{ticket.number}</span> {ticket.title}
          </>
        }
        subtitle={
          <span className="row row-wrap" style={{ gap: 8 }}>
            <TicketStatusPill status={ticket.status} />
            {ticket.channel && <ChannelBadge channel={ticket.channel} externalNumber={psaRef(ticket) ? ticket.channel_ref.externalNumber : undefined} />}
            {ticket.assurance && <IdentityBadge ticket={ticket} />}
            <span>
              {ticket.requester_name || ticket.requester_email || "Unknown requester"} · opened <RelativeTime iso={ticket.created_at} />
            </span>
          </span>
        }
        actions={
          <>
            {!active && (
              <button
                className="btn"
                onClick={() => void runHaley("plan")}
                disabled={starting !== null}
                title="Dry run: Haley investigates and writes up exactly what she would do. Nothing is changed and the requester isn't contacted."
              >
                {starting === "plan" ? <Spinner /> : <ClipboardList className="icon-sm" aria-hidden="true" />} Plan (dry run)
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={() => void runHaley("live")}
              disabled={starting !== null || Boolean(active)}
              title={active ? "Haley is already working this ticket" : undefined}
            >
              {starting === "live" || (active && isRunActive(active.status)) ? <Spinner /> : <Play className="icon-sm" aria-hidden="true" />}
              {active
                ? active.status === "awaiting_approval"
                  ? "Waiting for approval"
                  : active.mode === "plan"
                    ? "Haley is planning…"
                    : "Haley is working…"
                : runs.length
                  ? "Run Haley again"
                  : "Run Haley"}
            </button>
          </>
        }
      />

      <div className="layout-main-side">
        <div className="stack" style={{ gap: 20 }}>
          {latest && <RunBanner run={latest} pendingCount={pending.length} onRunLive={() => void runHaley("live")} starting={starting === "live"} />}
          {ticket.needs_followup && (
            <div className="banner banner-info" role="status">
              <MessageCircle className="icon" aria-hidden="true" />
              <span>
                <strong>New message from the requester.</strong> It arrived while Haley was busy; she'll take another pass when the current run ends.
              </span>
            </div>
          )}

          {pending.length > 0 && (
            <section className="stack" aria-labelledby="pending-title">
              <div className="section-title" style={{ marginBottom: 0 }}>
                <ShieldCheck className="icon" style={{ color: "var(--tone-amber-dot)" }} aria-hidden="true" />
                <h2 id="pending-title">Needs your approval</h2>
                <span className="count">{pending.length}</span>
              </div>
              {pending.map((a) => (
                <ApprovalCard
                  key={a.id}
                  action={a}
                  hideContext
                  onDecided={() => {
                    detail.mutate((d) => d && { ...d, actions: d.actions.map((x) => (x.id === a.id ? { ...x, status: "approved" as const } : x)) });
                    void detail.reload();
                  }}
                />
              ))}
            </section>
          )}

          <section aria-labelledby="tl-title">
            <h2 id="tl-title" className="sr-only">
              Timeline
            </h2>
            <ol className="timeline">
              {events.map((e) => (
                <TimelineItem key={e.id} event={e} action={typeof e.meta.actionId === "string" ? actionsById.get(e.meta.actionId) : undefined} />
              ))}
            </ol>
          </section>

          <Composer ticketId={ticket.id} runActive={Boolean(active)} requester={ticket.requester_name || ticket.requester_email} onPosted={() => void detail.reload()} />
        </div>

        <aside className="stack">
          <TicketProps detail={detail.data} onPatch={patchTicket} />
          {ticket.sla && <SlaCard ticket={detail.data.ticket} />}
          {schedules.length > 0 && <FollowUps schedules={schedules} />}
          {secrets.length > 0 && (
            <section className="card" aria-labelledby="cred-title">
              <div className="card-header">
                <Lock className="icon-sm" aria-hidden="true" />
                <h2 id="cred-title">Temporary credentials</h2>
              </div>
              <ul className="list">
                {secrets.map((a) => (
                  <li key={a.id} className="list-row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
                    <span style={{ fontSize: "var(--text-sm)" }}>{a.description}</span>
                    <RevealSecretButton actionId={a.id} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="card" aria-labelledby="runs-title">
            <div className="card-header">
              <Sparkles className="icon-sm" style={{ color: "var(--tone-violet-fg)" }} aria-hidden="true" />
              <h2 id="runs-title">Haley's runs</h2>
            </div>
            {runs.length === 0 ? (
              <p className="muted card-body" style={{ fontSize: "var(--text-sm)" }}>
                Haley hasn't worked this ticket yet. Use <strong>Run Haley</strong> to start.
              </p>
            ) : (
              <ul className="list">
                {runs.map((r, n) => (
                  <li key={r.id}>
                    <Link to={`/runs/${r.id}`} className="list-row">
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="title row" style={{ gap: 6 }}>
                          Run {runs.length - n}
                          <RunModeBadge mode={r.mode} />
                        </span>
                        <span className="meta">
                          {r.created_by} · <RelativeTime iso={r.created_at} />
                        </span>
                      </span>
                      <RunStatusPill status={r.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function RunBanner({ run, pendingCount, onRunLive, starting }: { run: Run; pendingCount: number; onRunLive: () => void; starting: boolean }) {
  const plan = run.mode === "plan";
  if (run.status === "queued" || run.status === "running") {
    return (
      <div className="banner banner-info" role="status">
        <Spinner />
        <span className="spacer">
          {plan ? (
            <>
              <strong>Haley is planning this ticket (dry run).</strong> Nothing will be changed and the requester won't be contacted.
            </>
          ) : (
            <>
              <strong>Haley is working on this ticket.</strong> Updates appear below as she goes.
            </>
          )}
        </span>
        <Link to={`/runs/${run.id}`} className="row nowrap" style={{ gap: 4 }}>
          Watch live <ArrowRight className="icon-sm" aria-hidden="true" />
        </Link>
      </div>
    );
  }
  if (run.status === "awaiting_approval") {
    return (
      <div className="banner banner-warn" role="status">
        <ShieldCheck className="icon" aria-hidden="true" />
        <span className="spacer">
          <strong>Haley is paused</strong> until {pendingCount === 1 ? "the action below is" : `the ${pendingCount} actions below are`} approved or rejected.
        </span>
        <Link to={`/runs/${run.id}`} className="nowrap">
          View run
        </Link>
      </div>
    );
  }
  if (run.status === "completed" && plan) {
    return (
      <div className="banner banner-plan" role="status">
        <ClipboardList className="icon" aria-hidden="true" />
        <span className="spacer">
          <strong>Plan ready.</strong> Haley's dry run finished without changing anything. Review her plan below, then let her do it for real.
        </span>
        <Link to={`/runs/${run.id}`} className="nowrap">
          View plan run
        </Link>
        <button className="btn btn-primary btn-sm" onClick={onRunLive} disabled={starting}>
          {starting ? <Spinner /> : <Play className="icon-sm" aria-hidden="true" />} Run for real
        </button>
      </div>
    );
  }
  if (run.status === "failed") {
    return (
      <div className="banner banner-error" role="status">
        <TriangleAlert className="icon" aria-hidden="true" />
        <span className="spacer">
          <strong>{plan ? "Haley's plan run failed." : "Haley's last run failed."}</strong> {run.error}
        </span>
        <Link to={`/runs/${run.id}`} className="nowrap">
          View run
        </Link>
      </div>
    );
  }
  return null;
}

function TicketProps({ detail, onPatch }: { detail: TicketDetail; onPatch: (p: TicketPatch) => void }) {
  const t = detail.ticket;
  const [category, setCategory] = useState(t.category);
  const [assignee, setAssignee] = useState(t.assignee);
  useEffect(() => setCategory(t.category), [t.category]);
  useEffect(() => setAssignee(t.assignee), [t.assignee]);

  const commit = (field: "category" | "assignee", value: string) => {
    if (value.trim() !== t[field]) onPatch({ [field]: value.trim() });
  };

  return (
    <section className="card" aria-labelledby="props-title">
      <div className="card-header">
        <h2 id="props-title">Properties</h2>
      </div>
      <div className="card-body">
        <dl className="props">
          <dt>
            <label htmlFor="tp-status">Status</label>
          </dt>
          <dd>
            <select id="tp-status" className="select select-sm" value={t.status} onChange={(e) => onPatch({ status: e.target.value as TicketStatus })}>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TICKET_STATUS_META[s].label}
                </option>
              ))}
            </select>
          </dd>
          <dt>
            <label htmlFor="tp-priority">Priority</label>
          </dt>
          <dd>
            <select id="tp-priority" className="select select-sm" value={t.priority} onChange={(e) => onPatch({ priority: e.target.value as TicketPriority })}>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_META[p].label}
                </option>
              ))}
            </select>
          </dd>
          <dt>
            <label htmlFor="tp-category">Category</label>
          </dt>
          <dd>
            <input
              id="tp-category"
              className="input input-sm"
              value={category}
              placeholder="Uncategorized"
              onChange={(e) => setCategory(e.target.value)}
              onBlur={() => commit("category", category)}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </dd>
          <dt>
            <label htmlFor="tp-assignee">Assignee</label>
          </dt>
          <dd>
            <input
              id="tp-assignee"
              className="input input-sm"
              value={assignee}
              placeholder="Unassigned"
              onChange={(e) => setAssignee(e.target.value)}
              onBlur={() => commit("assignee", assignee)}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </dd>
          <dt>Client</dt>
          <dd className="truncate">
            <Link to={`/clients/${t.org_id}`}>{t.org_name}</Link>
          </dd>
          <dt>Requester</dt>
          <dd style={{ minWidth: 0 }}>
            <div className="truncate">{t.requester_name || <span className="muted">—</span>}</div>
            {t.requester_email && (
              <a href={`mailto:${t.requester_email}`} className="row truncate" style={{ gap: 4, fontSize: "var(--text-sm)" }}>
                <Mail className="icon-sm" aria-hidden="true" />
                <span className="truncate">{t.requester_email}</span>
              </a>
            )}
          </dd>
          {t.channel && (
            <>
              <dt>Channel</dt>
              <dd>
                <span title={CHANNEL_META[t.channel]?.help}>
                  <ChannelBadge channel={t.channel} externalNumber={psaRef(t) ? t.channel_ref.externalNumber : undefined} />
                </span>
              </dd>
            </>
          )}
          {(detail.psaLinks ?? []).filter((l) => !(psaRef(t) && l.externalId === t.channel_ref.externalId)).length > 0 && (
            <>
              <dt>Synced to</dt>
              <dd className="stack-sm" style={{ gap: 4 }}>
                {(detail.psaLinks ?? [])
                  .filter((l) => !(psaRef(t) && l.externalId === t.channel_ref.externalId))
                  .map((l) => (
                    <span key={l.connectionId}>
                      {l.name} #{l.externalNumber || l.externalId}
                    </span>
                  ))}
              </dd>
            </>
          )}
          {t.assurance && (
            <>
              <dt>Identity</dt>
              <dd className="stack-sm" style={{ gap: 4 }}>
                <span>
                  <IdentityBadge ticket={t} />
                </span>
                <span className="muted" style={{ fontSize: "var(--text-sm)", overflowWrap: "anywhere" }}>
                  {t.verification || ASSURANCE_META[t.assurance]?.how}
                </span>
                {t.mfa_verified_at && <MfaLine ticket={t} />}
              </dd>
            </>
          )}
          <dt>Updated</dt>
          <dd>
            <RelativeTime iso={t.updated_at} />
          </dd>
        </dl>
      </div>
    </section>
  );
}

function TimelineItem({ event: e, action }: { event: TicketEvent; action: Action | undefined }) {
  const who = displayName(e.author);
  const time = <RelativeTime iso={e.created_at} />;
  const runLink = typeof e.meta.runId === "string" ? <Link to={`/runs/${e.meta.runId}`}>View run</Link> : null;

  if (e.kind === "status_change" || e.kind === "field_change") {
    const field = typeof e.meta.field === "string" ? e.meta.field : "";
    const from = e.meta.from == null ? "" : String(e.meta.from);
    const to = e.meta.to == null ? "" : String(e.meta.to);
    return (
      <li className="tl-item">
        <div className="tl-gutter">
          <span className="tl-icon">
            {e.kind === "status_change" ? <CircleDot className="icon-sm" aria-hidden="true" /> : <PencilLine className="icon-sm" aria-hidden="true" />}
          </span>
        </div>
        <div className="tl-compact">
          <strong>{who}</strong>
          {e.kind === "status_change" && to in TICKET_STATUS_META ? (
            <>
              changed status {from in TICKET_STATUS_META && <TicketStatusPill status={from as TicketStatus} />} <span aria-hidden="true">→</span>{" "}
              <TicketStatusPill status={to as TicketStatus} />
            </>
          ) : field ? (
            <span>
              {from ? (
                <>
                  changed {field} from <strong>{humanize(from)}</strong> to <strong>{humanize(to) || "empty"}</strong>
                </>
              ) : (
                <>
                  set {field} to <strong>{humanize(to)}</strong>
                </>
              )}
            </span>
          ) : (
            <span>{e.body}</span>
          )}
          <span>· {time}</span>
        </div>
      </li>
    );
  }

  if (e.kind === "action" && typeof e.meta.verification === "string") {
    return <VerificationItem event={e} outcome={e.meta.verification} time={time} runLink={runLink} />;
  }

  if (e.kind === "agent_note" && e.meta.sandbox === true) {
    return <SandboxSmsItem event={e} time={time} />;
  }

  if (e.kind === "action") {
    const decision = typeof e.meta.decision === "string" ? e.meta.decision : null;
    const failed = e.body.startsWith("Failed:");
    const tone = decision === "rejected" ? "neutral" : failed ? "red" : decision === "approved" ? "amber" : "green";
    const Icon = decision === "rejected" ? X : failed ? CircleX : decision === "approved" ? ShieldCheck : Check;
    const hasSecrets = Boolean(e.meta.hasSecrets) || Boolean(action?.has_secrets);
    return (
      <li className="tl-item">
        <div className="tl-gutter">
          <span className={`tl-icon tone-${tone}`}>
            <Icon className="icon-sm" aria-hidden="true" />
          </span>
        </div>
        <div className="stack-sm" style={{ gap: 6 }}>
          <div className="tl-action">
            <span style={{ color: failed ? "var(--tone-red-fg)" : undefined, overflowWrap: "anywhere" }}>{e.body}</span>
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {decision ? `by ${who}` : isHaley(e.author) ? "by Haley" : `by ${who}`} · {time}
            </span>
            {action && (
              <Link to={`/runs/${action.run_id}`} style={{ fontSize: "var(--text-sm)" }}>
                Details
              </Link>
            )}
          </div>
          {hasSecrets && action && !decision && (
            <div>
              <RevealSecretButton actionId={action.id} />
            </div>
          )}
        </div>
      </li>
    );
  }

  let cardClass = "tl-card";
  let label: ReactNode = null;
  let body: ReactNode = <Markdown source={e.body} />;

  switch (e.kind) {
    case "created":
      label = <span>opened the ticket</span>;
      body = e.body.trim() ? <div className="pre-wrap">{e.body}</div> : <span className="muted">No description.</span>;
      break;
    case "comment":
      if (typeof e.meta.channel === "string") {
        // Messages that arrived from the requester's channel (email, Slack, Teams, chat) are theirs, not internal notes.
        cardClass += " inbound";
        label = (
          <span className="row" style={{ gap: 4 }}>
            <MessageCircle className="icon-sm" aria-hidden="true" /> wrote via {CHANNEL_META[e.meta.channel as keyof typeof CHANNEL_META]?.label ?? e.meta.channel}
          </span>
        );
        body = <div className="pre-wrap">{e.body}</div>;
        break;
      }
      cardClass += " note";
      label = (
        <span className="row" style={{ gap: 4 }}>
          <Lock className="icon-sm" aria-hidden="true" /> Internal note
        </span>
      );
      break;
    case "reply":
      cardClass += " reply";
      label = (
        <span className="row" style={{ gap: 4 }}>
          <Reply className="icon-sm" aria-hidden="true" /> {e.meta.auto ? "Automatic reply" : "Replied to requester"}
        </span>
      );
      break;
    case "agent_note":
      cardClass += " haley";
      if (e.meta.error) cardClass += " error";
      if (e.meta.plan) cardClass += " plan";
      label = e.meta.summary && e.meta.plan ? (
        <span className="row" style={{ gap: 6 }}>
          <RunModeBadge mode="plan" />
        </span>
      ) : e.meta.summary ? (
        <Pill tone="violet">Summary</Pill>
      ) : e.meta.error ? (
        <Pill tone="red">Stopped</Pill>
      ) : (
        <span className="row" style={{ gap: 4 }}>
          <Lock className="icon-sm" aria-hidden="true" /> Note
        </span>
      );
      break;
    case "escalation":
      cardClass += " escalation";
      label = (
        <span className="row" style={{ gap: 4, fontWeight: 600 }}>
          <Flag className="icon-sm" aria-hidden="true" /> Escalated to a technician
        </span>
      );
      break;
  }

  return (
    <li className="tl-item">
      <div className="tl-gutter">
        <Avatar name={e.author} />
      </div>
      <article className={cardClass}>
        <header className="tl-card-head">
          <span className="author">{who}</span>
          {label}
          <span>· {time}</span>
          <span className="spacer" />
          {runLink}
        </header>
        <div className="tl-card-body">{body}</div>
        {e.kind === "reply" && isDelivery(e.meta.delivery) && <DeliveryLine delivery={e.meta.delivery} />}
      </article>
    </li>
  );
}

const VERIFY_ICONS: Record<string, typeof Check> = {
  code_sent: Smartphone,
  approved: ShieldCheck,
  denied: ShieldX,
  timeout: Hourglass,
  unavailable: ShieldAlert,
  wrong_code: ShieldAlert,
};

/** verify_requester_identity / confirm_verification_code outcomes: "<method> for <email>: <outcome>. <detail>". */
function VerificationItem({ event: e, outcome, time, runLink }: { event: TicketEvent; outcome: string; time: ReactNode; runLink: ReactNode }) {
  const meta = VERIFICATION_META[outcome] ?? { label: humanize(outcome), tone: "neutral" as const };
  const Icon = VERIFY_ICONS[outcome] ?? ShieldCheck;
  const m = /^(.*?) for (\S+): [a-z ]+\.\s*([\s\S]*)$/.exec(e.body);
  const method = m?.[1] ?? "";
  const who = m?.[2] ?? "";
  const detail = m ? m[3] : e.body;
  return (
    <li className="tl-item">
      <div className="tl-gutter">
        <span className={`tl-icon tone-${meta.tone}`}>
          <Icon className="icon-sm" aria-hidden="true" />
        </span>
      </div>
      <div className={`tl-verify tone-${meta.tone}`}>
        <div className="tl-verify-head">
          <strong>Identity verification</strong>
          <Pill tone={meta.tone} dot>
            {meta.label}
          </Pill>
          {method && <span className="secondary">{method}</span>}
          {who && <span className="muted truncate">to {who}</span>}
          <span className="muted">· by Haley · {time}</span>
          <span className="spacer" />
          {runLink && <span style={{ fontSize: "var(--text-sm)" }}>{runLink}</span>}
        </div>
        {detail && <div className="tl-verify-body">{detail}</div>}
        {outcome === "approved" && (
          <div className="tl-verify-foot">Counts as MFA verified for 30 minutes: Haley may now make security-sensitive changes to this requester's own account.</div>
        )}
      </div>
    </li>
  );
}

/** A sandbox "text message": the SMS verifier's outbox. The code is shown on purpose so testers can reply with it. */
function SandboxSmsItem({ event: e, time }: { event: TicketEvent; time: ReactNode }) {
  const m = /^\[Sandbox text to ([^\]]+)\]\s*([\s\S]*)$/.exec(e.body);
  const phone = m?.[1] ?? "";
  const text = m ? m[2] : e.body;
  const code = /\b\d{6}\b/.exec(text)?.[0];
  return (
    <li className="tl-item">
      <div className="tl-gutter">
        <span className="tl-icon tone-violet">
          <Smartphone className="icon-sm" aria-hidden="true" />
        </span>
      </div>
      <article className="tl-card sms-card">
        <header className="tl-card-head">
          <span className="author">Sandbox text message</span>
          <Pill tone="violet">Not sent</Pill>
          {phone && <span className="mono">to {phone}</span>}
          <span>· {time}</span>
        </header>
        <div className="tl-card-body stack-sm">
          <div className="sms-bubble">
            {code
              ? text.split(code).flatMap((part, i) => (i === 0 ? [part] : [<mark key={i} className="sms-code">{code}</mark>, part]))
              : text}
          </div>
          <div className="row row-wrap" style={{ gap: 8 }}>
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
              For testers: the SMS verifier is in sandbox mode, so this text went to the timeline instead of a phone. Reply with the code as the
              requester.
            </span>
            {code && <CopyButton value={code} label="Copy code" />}
          </div>
        </div>
      </article>
    </li>
  );
}

const shortTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

function MfaLine({ ticket }: { ticket: TicketDetail["ticket"] }) {
  const now = useNow();
  const expires = mfaExpiresAt(ticket);
  if (!ticket.mfa_verified_at || expires === null) return null;
  const fresh = now < expires;
  return (
    <span className={`mfa-line ${fresh ? "is-fresh" : ""}`} title={`Verified ${absoluteTime(ticket.mfa_verified_at)}`}>
      <ShieldCheck className="icon-xs" aria-hidden="true" />
      <span>
        {ticket.mfa_method || "Step-up verification"} <RelativeTime iso={ticket.mfa_verified_at} />
        {fresh ? <> · valid until {shortTime.format(expires)}</> : " · expired (30 min window)"}
      </span>
    </span>
  );
}

function Composer({ ticketId, runActive, requester, onPosted }: { ticketId: string; runActive: boolean; requester: string; onPosted: () => void }) {
  const { toast, refreshStats } = useApp();
  const [kind, setKind] = useState<"comment" | "reply">("comment");
  const [body, setBody] = useState("");
  const [runAgent, setRunAgent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    const wantRun = runAgent && !runActive;
    try {
      const res = await api.addComment(ticketId, { body: body.trim(), kind, runAgent: wantRun });
      toast(res.runId ? "Posted. Haley is picking it up." : kind === "reply" ? "Reply posted." : "Note added.");
      setBody("");
      setRunAgent(false);
      if (res.runId) refreshStats();
    } catch (err) {
      // 409: Haley is already on this ticket; nothing was saved, so keep the draft.
      if (err instanceof ApiError && err.status === 409) {
        toast(`Not posted: ${err.message} Uncheck "ask Haley to continue" to post it now.`, "info");
      } else {
        toast(errorMessage(err), "error");
      }
    } finally {
      setBusy(false);
      onPosted();
    }
  };

  return (
    <form className={`composer ${kind === "reply" ? "reply-mode" : "note-mode"}`} onSubmit={submit} aria-label="Add to ticket">
      <div className="composer-head">
        <div className="segmented" role="group" aria-label="Message type">
          <button type="button" aria-pressed={kind === "comment"} onClick={() => setKind("comment")}>
            <Lock className="icon-sm" aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
            Internal note
          </button>
          <button type="button" aria-pressed={kind === "reply"} onClick={() => setKind("reply")}>
            <Reply className="icon-sm" aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
            Reply to requester
          </button>
        </div>
        <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {kind === "comment" ? "Only technicians and Haley see this." : `Public reply${requester ? ` to ${requester}` : ""}.`}
        </span>
      </div>
      <label htmlFor="composer-body" className="sr-only">
        {kind === "comment" ? "Internal note" : "Reply"}
      </label>
      <textarea
        id="composer-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={kind === "comment" ? "Add context for Haley and other technicians… (Markdown supported)" : "Write a reply to the requester… (Markdown supported)"}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="composer-foot">
        <label className="checkbox" title={runActive ? "Haley is already working this ticket" : undefined}>
          <input type="checkbox" checked={runAgent && !runActive} disabled={runActive} onChange={(e) => setRunAgent(e.target.checked)} />
          and ask Haley to continue
        </label>
        <span className="spacer" />
        <span className="muted hide-sm" style={{ fontSize: "var(--text-xs)" }}>
          <kbd className="kbd">Ctrl</kbd> + <kbd className="kbd">Enter</kbd>
        </span>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !body.trim()}>
          {busy ? <Spinner /> : <Send className="icon-sm" aria-hidden="true" />}
          {kind === "comment" ? "Add note" : "Send reply"}
        </button>
      </div>
    </form>
  );
}

function isDelivery(v: unknown): v is Delivery {
  return Boolean(v) && typeof v === "object" && typeof (v as Delivery).delivered === "boolean";
}

function DeliveryLine({ delivery }: { delivery: Delivery }) {
  return (
    <div className={`delivery-line ${delivery.delivered ? "ok" : "failed"}`}>
      {delivery.delivered ? <Check className="icon-xs" aria-hidden="true" /> : <Undo2 className="icon-xs" aria-hidden="true" />}
      <span>{delivery.delivered ? `Delivered: ${delivery.detail}` : `Not delivered: ${delivery.detail}`}</span>
    </div>
  );
}

function SlaRow({ label, state, due }: { label: string; state: SlaState; due: string }) {
  const done = state === "met";
  return (
    <div className="sla-row">
      <div className="sla-row-head">
        <span className="sla-label">{label}</span>
        <SlaStatePill state={state} />
      </div>
      <span className="muted" style={{ fontSize: "var(--text-sm)" }} title={absoluteTime(due)}>
        {done ? (
          <>Target {absoluteTime(due)}</>
        ) : (
          <>
            {state === "breached" ? "Was due " : "Due "}
            <RelativeTime iso={due} /> · {absoluteTime(due)}
          </>
        )}
      </span>
    </div>
  );
}

function SlaCard({ ticket }: { ticket: TicketDetail["ticket"] }) {
  const sla = ticket.sla!;
  const breached = sla.response === "breached" || sla.resolution === "breached";
  return (
    <section className={`card ${breached ? "card-alert" : ""}`} aria-labelledby="sla-title">
      <div className="card-header">
        <h2 id="sla-title">SLA</h2>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {PRIORITY_META[ticket.priority].label} priority
        </span>
      </div>
      <div className="card-body stack-sm" style={{ gap: 12 }}>
        <SlaRow label="First response" state={sla.response} due={sla.responseDue} />
        <SlaRow label="Resolution" state={sla.resolution} due={sla.resolutionDue} />
        {ticket.first_response_at && (
          <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
            First responded <RelativeTime iso={ticket.first_response_at} />
          </span>
        )}
      </div>
    </section>
  );
}

function FollowUps({ schedules }: { schedules: Schedule[] }) {
  return (
    <section className="card" aria-labelledby="fu-title">
      <div className="card-header">
        <CalendarClock className="icon-sm" aria-hidden="true" />
        <h2 id="fu-title">Scheduled follow-ups</h2>
      </div>
      <ul className="list">
        {schedules.map((s) => (
          <li key={s.id} className="list-row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
            <span className="row row-wrap" style={{ gap: 6 }}>
              <span className="title">{s.title}</span>
              {s.cadence !== "once" && <Pill tone="blue">{CADENCE_META[s.cadence].every}</Pill>}
              <RunModeBadge mode={s.mode} />
            </span>
            <span className="meta">
              {s.enabled && s.next_run_at ? (
                <>
                  Next <RelativeTime iso={s.next_run_at} />
                </>
              ) : s.last_run_id ? (
                <>
                  Ran <RelativeTime iso={s.last_run_at} /> · <Link to={`/runs/${s.last_run_id}`}>View run</Link>
                </>
              ) : (
                "Not scheduled"
              )}
            </span>
            <span className="secondary line-clamp-2" style={{ fontSize: "var(--text-sm)" }} title={s.instruction}>
              {s.instruction}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
