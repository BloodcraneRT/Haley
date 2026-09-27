import { ArrowLeft, BookOpen, ChevronRight, CircleCheck, Clock, Hourglass, Printer, ShieldCheck, Ticket as TicketIcon, UserRoundCog, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, type ClientReport, type CountRow, type TicketChannel, type TicketPriority } from "../api";
import { Wordmark } from "../components/Layout";
import { EmptyState, ErrorBanner, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { AutonomyPill, ChannelIcon } from "../components/Pill";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { AUTONOMY_META, CHANNEL_META, formatMinutes, formatNumber, formatPercent, humanize, PRIORITY_META } from "../lib/format";

const PERIODS = [30, 90, 180, 365] as const;
const periodLabel = (d: number) => (d === 365 ? "12 months" : d === 180 ? "6 months" : `${d} days`);
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function ClientReportPage() {
  const { id = "" } = useParams();
  const { user } = useApp();
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get("days"));
  const days = (PERIODS as readonly number[]).includes(raw) ? raw : 90;
  const report = usePoll(() => api.report(id, days), [id, days]);

  const setDays = (d: number) => {
    const next = new URLSearchParams(params);
    if (d === 90) next.delete("days");
    else next.set("days", String(d));
    setParams(next, { replace: true });
  };

  if (report.error instanceof ApiError && report.error.status === 404) {
    return (
      <div className="card">
        <EmptyState title="Client not found" actions={<Link to="/clients" className="btn">Back to clients</Link>}>
          It may have been deleted.
        </EmptyState>
      </div>
    );
  }

  const r = report.data;
  const name = r?.org.name ?? "Client";

  return (
    <div className="report">
      <div className="report-print-head" aria-hidden="true">
        <span className="brand">
          <Wordmark />
        </span>
        <span className="spacer" />
        <span>
          Prepared {user ? `by ${user} ` : ""}on {dateFmt.format(new Date())}
        </span>
      </div>

      <PageHeader
        docTitle={`${name} report`}
        breadcrumb={
          <>
            <Link to="/clients">Clients</Link>
            <ChevronRight className="icon-sm" aria-hidden="true" />
            <Link to={`/clients/${id}`}>{name}</Link>
            <ChevronRight className="icon-sm" aria-hidden="true" />
            <span>Report</span>
          </>
        }
        title={
          <>
            {name} <span className="report-title-sub">IT service report</span>
          </>
        }
        subtitle={
          r ? (
            <span className="row row-wrap" style={{ gap: 8 }}>
              <span>
                {dateFmt.format(new Date(r.period.from))} – {dateFmt.format(new Date(r.period.to))} · last {periodLabel(r.period.days)}
              </span>
              <AutonomyPill autonomy={r.org.autonomy} />
            </span>
          ) : (
            " "
          )
        }
        actions={
          <div className="row row-wrap no-print" style={{ gap: 8 }}>
            <div className="segmented" role="group" aria-label="Report period">
              {PERIODS.map((d) => (
                <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
                  {d === 365 ? "12 mo" : d === 180 ? "6 mo" : `${d} days`}
                </button>
              ))}
            </div>
            <button className="btn btn-primary" onClick={() => window.print()} disabled={!r}>
              <Printer className="icon-sm" aria-hidden="true" /> Print / Save PDF
            </button>
          </div>
        }
      />

      {report.error && <ErrorBanner error={report.error} onRetry={report.reload} />}
      {!r ? (
        !report.error && <Loading label="Building the report…" />
      ) : (
        <ReportBody report={r} loading={report.loading} />
      )}

      <div className="no-print" style={{ marginTop: 28 }}>
        <Link to={`/clients/${id}`} className="row" style={{ gap: 4, fontSize: "var(--text-sm)" }}>
          <ArrowLeft className="icon-sm" aria-hidden="true" /> Back to {name}
        </Link>
      </div>
    </div>
  );
}

function ReportBody({ report: r, loading }: { report: ClientReport; loading: boolean }) {
  const t = r.tickets;
  const noTickets = t.opened === 0 && t.resolved === 0;
  return (
    <div className={`stack report-body ${loading ? "is-refreshing" : ""}`} style={{ gap: 24 }}>
      <section className="report-hero" aria-label="Time saved">
        <div className="report-hero-main">
          <span className="report-hero-label">
            <Hourglass className="icon-sm" aria-hidden="true" /> Estimated technician time saved
          </span>
          <span className="report-hero-value">
            {formatNumber(r.timeSaved.hours)}
            <span className="unit"> hours</span>
          </span>
          <p className="report-hero-note">Assumes {lowerFirst(r.timeSaved.assumptions)}</p>
        </div>
        <div className="report-hero-side">
          <HeroStat label="Resolved by Haley alone" value={formatPercent(t.automationRate)} hint={`${formatNumber(t.resolvedByHaleyAlone)} of ${formatNumber(t.resolved)} resolved tickets`} />
          <HeroStat label="Changes made automatically" value={formatNumber(r.changes.automatic)} hint={`of ${formatNumber(r.changes.executed)} changes to your systems`} />
        </div>
      </section>

      <section aria-labelledby="rep-tickets">
        <h2 id="rep-tickets" className="report-h2">
          Tickets
        </h2>
        <div className="report-tiles">
          <Tile icon={<TicketIcon className="icon-sm" />} label="Opened" value={formatNumber(t.opened)} hint={`${formatNumber(t.stillOpen)} open right now`} />
          <Tile icon={<CircleCheck className="icon-sm" />} label="Resolved" value={formatNumber(t.resolved)} hint={`${formatNumber(t.resolvedByHaleyAlone)} without a technician`} />
          <Tile icon={<UserRoundCog className="icon-sm" />} label="Escalated to a technician" value={formatNumber(t.escalated)} hint={t.opened ? `${formatPercent((t.escalated / t.opened) * 100)} of opened tickets` : "No tickets opened"} />
          <Tile icon={<Clock className="icon-sm" />} label="Median time to resolve" value={formatMinutes(t.medianResolutionMinutes)} hint="From request to resolution" />
          <Tile
            icon={<ShieldCheck className="icon-sm" />}
            label="Response SLA met"
            value={formatPercent(r.sla.responseCompliance)}
            hint={r.sla.responseCompliance == null ? "No settled tickets yet" : `${formatNumber(r.sla.responseBreaches)} breach${r.sla.responseBreaches === 1 ? "" : "es"}`}
            tone={complianceTone(r.sla.responseCompliance)}
          />
          <Tile
            icon={<ShieldCheck className="icon-sm" />}
            label="Resolution SLA met"
            value={formatPercent(r.sla.resolutionCompliance)}
            hint={r.sla.resolutionCompliance == null ? "No settled tickets yet" : `${formatNumber(r.sla.resolutionBreaches)} breach${r.sla.resolutionBreaches === 1 ? "" : "es"}`}
            tone={complianceTone(r.sla.resolutionCompliance)}
          />
        </div>
      </section>

      {noTickets ? (
        <div className="card">
          <EmptyState icon={<TicketIcon className="icon" />} title="No tickets in this period" compact>
            Try a longer period. Breakdowns appear once tickets come in.
          </EmptyState>
        </div>
      ) : (
        <section aria-labelledby="rep-breakdowns">
          <h2 id="rep-breakdowns" className="report-h2">
            What people needed
          </h2>
          <div className="report-grid">
            <BarList title="By category" rows={t.byCategory} format={(n) => (n && n !== "uncategorized" ? n : "Uncategorized")} />
            <BarList
              title="By channel"
              rows={t.byChannel}
              format={(n) => CHANNEL_META[n as TicketChannel]?.label ?? humanize(n)}
              icon={(n) => (n in CHANNEL_META ? <ChannelIcon channel={n as TicketChannel} /> : null)}
            />
            <BarList title="By priority" rows={sortPriority(t.byPriority)} format={(n) => PRIORITY_META[n as TicketPriority]?.label ?? humanize(n)} />
            <BarList title="Top requesters" rows={t.topRequesters} format={(n) => n} />
          </div>
        </section>
      )}

      <section aria-labelledby="rep-changes">
        <h2 id="rep-changes" className="report-h2">
          Changes to your systems
        </h2>
        <div className="report-grid">
          <div className="report-card">
            <dl className="report-facts">
              <Fact label="Changes made" value={r.changes.executed} />
              <Fact label="Made automatically under your policy" value={r.changes.automatic} />
              <Fact label="Approved by a technician first" value={r.changes.approvedByTechnician} />
              <Fact label="Declined by a technician" value={r.changes.rejected} />
              <Fact label="Stopped by policy" value={r.changes.blockedByPolicy} />
              <Fact label="Knowledge base articles Haley wrote" value={r.knowledge.articlesWrittenByHaley} icon={<BookOpen className="icon-sm" aria-hidden="true" />} />
            </dl>
            <p className="report-footnote">
              Autonomy policy: <strong>{AUTONOMY_META[r.org.autonomy].label}</strong>. {AUTONOMY_META[r.org.autonomy].summary} Every change is recorded in
              the audit log.
            </p>
          </div>
          <BarList title="Changes by tool" rows={r.changes.byTool} format={humanizeTool} empty="No changes in this period." icon={() => <Wrench className="icon-sm" />} />
        </div>
      </section>
    </div>
  );
}

function lowerFirst(s: string) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function complianceTone(pct: number | null): "green" | "amber" | "red" | undefined {
  if (pct == null) return undefined;
  return pct >= 95 ? "green" : pct >= 85 ? "amber" : "red";
}

const PRIORITY_ORDER: TicketPriority[] = ["urgent", "high", "normal", "low"];
function sortPriority(rows: CountRow[]) {
  return [...rows].sort((a, b) => PRIORITY_ORDER.indexOf(a.name as TicketPriority) - PRIORITY_ORDER.indexOf(b.name as TicketPriority));
}

/** m365_reset_password -> "Reset password (M365)" */
function humanizeTool(name: string) {
  const m = /^(m365|gws|google)_(.+)$/.exec(name);
  if (!m) return humanize(name);
  return `${humanize(m[2])} (${m[1] === "m365" ? "M365" : "Google"})`;
}

function HeroStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="report-hero-stat">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      <span className="hint">{hint}</span>
    </div>
  );
}

function Tile({ icon, label, value, hint, tone }: { icon: ReactNode; label: string; value: string; hint?: string; tone?: "green" | "amber" | "red" }) {
  return (
    <div className={`kpi report-tile ${tone ? `tile-${tone}` : ""}`}>
      <span className="kpi-label">
        {icon}
        <span>{label}</span>
      </span>
      <span className="kpi-value">{value}</span>
      {hint && <span className="kpi-hint">{hint}</span>}
    </div>
  );
}

function Fact({ label, value, icon }: { label: string; value: number; icon?: ReactNode }) {
  return (
    <>
      <dt>
        {icon}
        {label}
      </dt>
      <dd className="num">{formatNumber(value)}</dd>
    </>
  );
}

/** Horizontal bar list: one hue, direct count labels, share in the tooltip. */
function BarList({
  title,
  rows,
  format,
  icon,
  mono,
  empty = "Nothing in this period.",
}: {
  title: string;
  rows: CountRow[];
  format: (name: string) => string;
  icon?: (name: string) => ReactNode;
  mono?: boolean;
  empty?: string;
}) {
  const total = rows.reduce((n, r) => n + r.count, 0);
  const max = Math.max(1, ...rows.map((r) => r.count));
  const shown = rows.slice(0, 8);
  const rest = rows.slice(8).reduce((n, r) => n + r.count, 0);
  return (
    <div className="report-card">
      <h3 className="report-h3">{title}</h3>
      {rows.length === 0 ? (
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {empty}
        </p>
      ) : (
        <ul className="barlist">
          {[...shown, ...(rest ? [{ name: "__other", count: rest }] : [])].map((r) => {
            const label = r.name === "__other" ? `Other (${rows.length - 8})` : format(r.name);
            const share = total ? Math.round((r.count / total) * 100) : 0;
            return (
              <li key={r.name} className="barlist-row" title={`${label}: ${formatNumber(r.count)} (${share}%)`}>
                <span className={`barlist-label ${mono ? "is-mono" : ""}`}>
                  {icon && r.name !== "__other" && <span className="barlist-icon">{icon(r.name)}</span>}
                  <span className="truncate">{label}</span>
                </span>
                <span className="barlist-track" aria-hidden="true">
                  <span className="barlist-bar" style={{ width: `${Math.max(2, (r.count / max) * 100)}%` }} />
                </span>
                <span className="barlist-value num">
                  {formatNumber(r.count)}
                  <span className="barlist-share">{share}%</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
