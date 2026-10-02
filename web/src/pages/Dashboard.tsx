import {
  Activity,
  ArrowRight,
  BookOpen,
  Building,
  CalendarClock,
  CircleCheck,
  FlaskConical,
  Flag,
  Inbox,
  MessagesSquare,
  OctagonPause,
  Plus,
  ShieldCheck,
  Ticket as TicketIcon,
  TimerOff,
  TriangleAlert,
  Wrench,
  Zap,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, errorMessage } from "../api";
import { ApprovalCard } from "../components/ApprovalCard";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { OpenIncidentsBanner } from "../components/Incidents";
import { PageHeader } from "../components/PageHeader";
import { Priority } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { RunRow } from "../components/RunRow";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { formatNumber, isRunActive } from "../lib/format";

function Kpi({
  label,
  value,
  icon,
  to,
  hint,
  variant,
}: {
  label: string;
  value: number | undefined;
  icon: ReactNode;
  to?: string;
  hint?: string;
  variant?: "attention" | "alert";
}) {
  const body = (
    <>
      <span className="kpi-label" title={label}>
        {icon}
        <span>{label}</span>
      </span>
      <span className="kpi-value">{value === undefined ? <span className="skeleton" style={{ display: "inline-block", width: 36, height: 24 }} /> : formatNumber(value)}</span>
      {hint && <span className="kpi-hint">{hint}</span>}
    </>
  );
  const cls = `kpi ${variant ?? ""}`;
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function greeting(name: string) {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const first = name.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

export function DashboardPage() {
  const { stats, refreshStats, user, toast } = useApp();
  const navigate = useNavigate();
  const orgs = usePoll(() => api.orgs(), []);
  const approvals = usePoll(() => api.approvals(), [], 10_000);
  const runs = usePoll(() => api.runs(), [], (d) => (d?.some((r) => isRunActive(r.status)) ? 3000 : 15_000));
  const escalated = usePoll(() => api.tickets({ status: "escalated" }), [], 30_000);
  const [seeding, setSeeding] = useState(false);

  useEffect(() => refreshStats(), [refreshStats]);

  const loadDemo = async () => {
    setSeeding(true);
    try {
      await api.loadDemo();
      toast("Demo workspace loaded: two sandbox clients, four tickets and global runbooks.");
      await Promise.all([orgs.reload(), approvals.reload(), runs.reload(), escalated.reload()]);
      refreshStats();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSeeding(false);
    }
  };

  const noOrgs = orgs.data !== undefined && orgs.data.length === 0;
  const paused = (orgs.data ?? []).filter((o) => o.settings?.paused);
  const queue = approvals.data ?? [];
  const recentRuns = (runs.data ?? []).slice(0, 8);

  return (
    <>
      <PageHeader
        title={greeting(user)}
        docTitle="Dashboard"
        subtitle={
          noOrgs
            ? "Let's get your first client connected."
            : stats
              ? `${formatNumber(stats.openTickets)} open tickets across ${formatNumber(stats.orgs)} client${stats.orgs === 1 ? "" : "s"}.`
              : " "
        }
        actions={
          !noOrgs && (
            <>
              <Link to="/simulate" className="btn">
                <MessagesSquare className="icon-sm" aria-hidden="true" /> Try as end user
              </Link>
              <Link to="/tasks" className="btn">
                <Zap className="icon-sm" aria-hidden="true" /> Ask Haley
              </Link>
              <Link to="/tickets?new=1" className="btn btn-primary">
                <Plus className="icon-sm" aria-hidden="true" /> New ticket
              </Link>
            </>
          )
        }
      />

      {orgs.error && <ErrorBanner error={orgs.error} onRetry={orgs.reload} />}

      {paused.length > 0 && (
        <div className="banner banner-error" role="status" style={{ marginBottom: 20 }}>
          <OctagonPause className="icon" aria-hidden="true" />
          <span>
            <strong>Haley is paused for {paused.length === 1 ? "1 client" : `${paused.length} clients`}:</strong>{" "}
            {paused.map((o, i) => (
              <span key={o.id}>
                {i > 0 && ", "}
                <Link to={`/clients/${o.id}`}>{o.name}</Link>
              </span>
            ))}
            . Their tickets go straight to technicians and scheduled runs are skipped until she's resumed.
          </span>
        </div>
      )}

      {noOrgs && (
        <section className="card welcome" aria-labelledby="welcome-title">
          <div className="stack">
            <div>
              <h2 id="welcome-title">Welcome to Haley</h2>
              <p>
                Haley is your AI technician. Connect each client's Microsoft 365 or Google Workspace, and she works tickets and ad-hoc tasks, asks
                before changing anything you haven't pre-approved, documents what she learns, and logs every step.
              </p>
            </div>
            <div className="row row-wrap">
              <button className="btn btn-primary btn-lg" onClick={loadDemo} disabled={seeding}>
                {seeding ? <Spinner /> : <FlaskConical className="icon-sm" aria-hidden="true" />} Load demo workspace
              </button>
              <button className="btn btn-lg" onClick={() => navigate("/clients?new=1")}>
                <Plus className="icon-sm" aria-hidden="true" /> Add your first client
              </button>
            </div>
            <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
              The demo creates two clients on simulated (sandbox) tenants with sample tickets, so nothing real is touched.
            </p>
          </div>
          <ol aria-label="How it works">
            <li>
              <span>
                <strong>Add a client</strong> and choose how much autonomy Haley has there.
              </span>
            </li>
            <li>
              <span>
                <strong>Connect</strong> their Microsoft 365 or Google Workspace, live or sandbox.
              </span>
            </li>
            <li>
              <span>
                <strong>Open a ticket</strong> or ask for a task. Haley investigates and proposes changes.
              </span>
            </li>
            <li>
              <span>
                <strong>Approve</strong> changes from the queue. Everything lands in the audit log.
              </span>
            </li>
          </ol>
        </section>
      )}

      {!noOrgs && (
        <>
          <OpenIncidentsBanner />
          <div className="kpis kpis-dashboard">
            <Kpi label="Open tickets" value={stats?.openTickets} icon={<TicketIcon className="icon-sm" />} to="/tickets?status=open" />
            <Kpi
              label="To approve"
              value={stats?.awaitingApproval}
              icon={<ShieldCheck className="icon-sm" />}
              to="/approvals"
              variant={stats && stats.awaitingApproval > 0 ? "attention" : undefined}
            />
            <Kpi
              label="Escalated"
              value={stats?.escalated}
              icon={<Flag className="icon-sm" />}
              to="/tickets?status=escalated"
              variant={stats && stats.escalated > 0 ? "alert" : undefined}
            />
            <Kpi
              label="SLA breached"
              value={stats?.slaBreached}
              icon={<TimerOff className="icon-sm" />}
              to="/tickets?sla=breached"
              hint="Open tickets past target"
              variant={stats && stats.slaBreached > 0 ? "alert" : undefined}
            />
            <Kpi label="Resolved (7d)" value={stats?.resolvedThisWeek} icon={<CircleCheck className="icon-sm" />} to="/tickets?status=resolved" />
            <Kpi label="Changes (7d)" value={stats?.actionsExecutedThisWeek} icon={<Wrench className="icon-sm" />} hint="Customer-system changes" to="/audit" />
            <Kpi label="KB articles" value={stats?.kbArticles} icon={<BookOpen className="icon-sm" />} to="/kb" />
            <Kpi label="Active runs" value={stats?.activeRuns} icon={<Activity className="icon-sm" />} to="/runs" />
            <Kpi label="Clients" value={stats?.orgs} icon={<Building className="icon-sm" />} to="/clients" />
            <Kpi label="Schedules" value={stats?.schedules} icon={<CalendarClock className="icon-sm" />} hint="Enabled audits & follow-ups" to="/clients" />
          </div>

          <div className="layout-main-side layout-dashboard">
            <section aria-labelledby="queue-title" className="stack">
              <div className="section-title" style={{ marginBottom: 0 }}>
                <h2 id="queue-title">Approval queue</h2>
                {queue.length > 0 && <span className="count">{queue.length}</span>}
                <span className="spacer" />
                {queue.length > 3 && (
                  <Link to="/approvals" className="row" style={{ gap: 4 }}>
                    View all <ArrowRight className="icon-sm" aria-hidden="true" />
                  </Link>
                )}
              </div>
              {approvals.error && <ErrorBanner error={approvals.error} onRetry={approvals.reload} />}
              {approvals.loading && !approvals.data ? (
                <div className="card">
                  <Loading />
                </div>
              ) : queue.length === 0 ? (
                <div className="card">
                  <EmptyState icon={<CircleCheck className="icon" />} title="Nothing waiting on you" compact>
                    When Haley wants to change a customer system and the client's policy requires sign-off, it shows up here.
                  </EmptyState>
                </div>
              ) : (
                queue.slice(0, 3).map((a) => (
                  <ApprovalCard
                    key={a.id}
                    action={a}
                    compact
                    onDecided={() => {
                      approvals.mutate((list) => list?.filter((x) => x.id !== a.id));
                      void approvals.reload();
                      void runs.reload();
                    }}
                  />
                ))
              )}
            </section>

            <aside className="stack">
              {(escalated.data?.length ?? 0) > 0 && (
                <section className="card" aria-labelledby="esc-title">
                  <div className="card-header">
                    <TriangleAlert className="icon" style={{ color: "var(--tone-red-dot)" }} aria-hidden="true" />
                    <h2 id="esc-title">Escalated to a technician</h2>
                  </div>
                  <ul className="list">
                    {escalated.data!.slice(0, 5).map((t) => (
                      <li key={t.id}>
                        <Link to={`/tickets/${t.id}`} className="list-row">
                          <span className="ticket-number">#{t.number}</span>
                          <span style={{ minWidth: 0, flex: 1 }}>
                            <span className="title truncate" style={{ display: "block" }}>
                              {t.title}
                            </span>
                            <span className="meta">
                              {t.org_name} · <RelativeTime iso={t.updated_at} />
                            </span>
                          </span>
                          <Priority priority={t.priority} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section className="card" aria-labelledby="runs-title">
                <div className="card-header">
                  <h2 id="runs-title">Recent runs</h2>
                  <span className="spacer" />
                  <Link to="/runs" style={{ fontSize: "var(--text-sm)" }}>
                    All runs
                  </Link>
                </div>
                {runs.error && (
                  <div className="card-body">
                    <ErrorBanner error={runs.error} onRetry={runs.reload} />
                  </div>
                )}
                {runs.loading && !runs.data ? (
                  <Loading />
                ) : recentRuns.length === 0 ? (
                  <EmptyState icon={<Inbox className="icon" />} title="No runs yet" compact>
                    Open a ticket with "Let Haley work it" checked, or give her a task from <Link to="/tasks">Ask Haley</Link>.
                  </EmptyState>
                ) : (
                  <ul className="list">
                    {recentRuns.map((r) => (
                      <li key={r.id}>
                        <RunRow run={r} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
    </>
  );
}
