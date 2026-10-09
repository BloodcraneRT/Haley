import { ChevronRight, CircleCheck, Download, Hourglass, Lightbulb, Plus, Printer, Sparkles, Ticket as TicketIcon, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  ApiError,
  errorMessage,
  type InsightCluster,
  type InsightCoverage,
  type InsightInput,
  type InsightReport,
  type InsightReportSummary,
  type PsaConnectionListItem,
  type PsaKind,
  type PsaProviderInfo,
} from "../api";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { Wordmark } from "../components/Layout";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { Switch } from "../components/Switch";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { formatNumber, type Tone } from "../lib/format";
import "../styles/insights.css";

const COVERAGE: Record<InsightCoverage, { tone: Tone; label: string; help: string }> = {
  unattended: { tone: "green", label: "Unattended", help: "Haley can resolve these on her own once the integration is connected." },
  "with approval": { tone: "blue", label: "With approval", help: "Haley does the work after a technician approves the change." },
  "assist only": { tone: "amber", label: "Assist only", help: "Haley gathers facts and drafts the fix; a technician finishes it." },
  "not covered": { tone: "neutral", label: "Not covered", help: "Nothing in Haley's tools or recipes does this yet." },
};
const DAYS = [30, 60, 90] as const;
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const STATUS_TONE: Record<InsightReportSummary["status"], Tone> = { running: "blue", done: "green", failed: "red" };

export function InsightsPage() {
  const { toast } = useApp();
  const navigate = useNavigate();
  const reports = usePoll(() => api.insights(), [], (data) => (data?.some((r) => r.status === "running") ? 3000 : null));
  const [creating, setCreating] = useState(false);

  const remove = async (r: InsightReportSummary) => {
    if (!window.confirm(`Delete the report for ${r.params.source.label}?`)) return;
    try {
      await api.deleteInsight(r.id);
      reports.mutate((list) => list?.filter((x) => x.id !== r.id));
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const list = reports.data;
  return (
    <>
      <PageHeader
        title="What would Haley handle?"
        subtitle="Groups 30–90 days of closed PSA tickets and estimates how many Haley could take each month: for your own help desk, or a prospect's."
        actions={
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus className="icon-sm" aria-hidden="true" /> New report
          </button>
        }
      />
      {reports.error && <ErrorBanner error={reports.error} onRetry={reports.reload} />}
      {!list ? (
        !reports.error && <Loading />
      ) : list.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Lightbulb className="icon" />}
            title="No reports yet"
            actions={
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                <Plus className="icon-sm" aria-hidden="true" /> New report
              </button>
            }
          >
            Point Haley at a PSA (yours, or a prospect's with a read-only API user) to see which tickets she could take and the hours that frees up. Only totals and a few
            example subjects are kept.
          </EmptyState>
        </div>
      ) : (
        <section className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Help desk</th>
                  <th scope="col" className="hide-sm">
                    Period
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col" className="hide-sm">
                    Created
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <td className="cell-title">
                      <Link to={`/insights/${r.id}`}>{r.params.source.label}</Link>
                      <div className="cell-sub">{r.params.source.connectionId ? "Your PSA" : "Prospect"}</div>
                    </td>
                    <td className="hide-sm">{r.params.days} days</td>
                    <td>
                      <Pill tone={STATUS_TONE[r.status]} dot>
                        {r.status === "running" ? "Building…" : r.status === "done" ? "Ready" : "Failed"}
                      </Pill>
                      {r.error && <div className="cell-sub insight-error">{r.error}</div>}
                    </td>
                    <td className="hide-sm">
                      <RelativeTime iso={r.created_at} />
                      <div className="cell-sub">{r.created_by}</div>
                    </td>
                    <td className="col-actions">
                      <button className="btn btn-ghost btn-sm btn-icon" aria-label={`Delete the report for ${r.params.source.label}`} title="Delete" onClick={() => void remove(r)}>
                        <Trash2 className="icon-sm" aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <NewReportModal
        open={creating}
        onClose={() => setCreating(false)}
        onStarted={(id) => {
          setCreating(false);
          navigate(`/insights/${id}`);
        }}
      />
    </>
  );
}

function NewReportModal({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: (id: string) => void }) {
  const { toast } = useApp();
  const providers = usePoll(() => (open ? api.psaProviders() : Promise.resolve(undefined)), [open]);
  const connections = usePoll(() => (open ? api.psaConnections() : Promise.resolve(undefined)), [open]);
  const supported = (providers.data ?? []).filter((p) => p.insights);
  const usable = (connections.data ?? []).filter((c) => supported.some((p) => p.id === c.kind));

  const [mode, setMode] = useState<"connection" | "prospect">("connection");
  const [connectionId, setConnectionId] = useState("");
  const [kind, setKind] = useState<PsaKind | "">("");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [days, setDays] = useState<number>(90);
  const [minutes, setMinutes] = useState("");
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setConfig({});
      setName("");
      setMinutes("");
      setBusy(false);
    }
  }

  // Prefer a saved connection when there is one; otherwise go straight to a prospect's details.
  const effectiveMode = connections.data && usable.length === 0 ? "prospect" : mode;
  const chosenConnection: PsaConnectionListItem | undefined = usable.find((c) => c.id === connectionId) ?? usable[0];
  const provider: PsaProviderInfo | undefined = supported.find((p) => p.id === kind) ?? supported[0];
  const minutesValue = minutes.trim() === "" ? undefined : Number(minutes);
  const minutesOk = minutesValue === undefined || (Number.isFinite(minutesValue) && minutesValue >= 1 && minutesValue <= 600);
  const missing = effectiveMode === "prospect" && provider ? provider.fields.filter((f) => !f.optional && !config[f.key]?.trim()) : [];
  const valid = minutesOk && (effectiveMode === "connection" ? Boolean(chosenConnection) : Boolean(provider) && missing.length === 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const base = { days, minutesPerTicket: minutesValue };
    const input: InsightInput =
      effectiveMode === "connection"
        ? { ...base, connectionId: chosenConnection!.id }
        : { ...base, prospect: { kind: provider!.id, name: name.trim() || undefined, config: Object.fromEntries(Object.entries(config).filter(([, v]) => v.trim())) } };
    try {
      const report = await api.startInsight(input);
      setConfig({});
      onStarted(report.id);
    } catch (err) {
      toast(errorMessage(err), "error");
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="New report"
      onClose={onClose}
      footer={
        <>
          {busy && <Spinner />}
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="insight-form" disabled={!valid || busy}>
            <Sparkles className="icon-sm" aria-hidden="true" /> Build report
          </button>
        </>
      }
    >
      {providers.error || connections.error ? (
        <ErrorBanner error={(providers.error ?? connections.error)!} />
      ) : !providers.data || !connections.data ? (
        <Loading />
      ) : (
        <form id="insight-form" className="stack" style={{ gap: 14 }} onSubmit={submit}>
          {usable.length > 0 && (
            <div className="segmented" role="group" aria-label="Whose tickets">
              <button type="button" aria-pressed={effectiveMode === "connection"} onClick={() => setMode("connection")}>
                Your PSA
              </button>
              <button type="button" aria-pressed={effectiveMode === "prospect"} onClick={() => setMode("prospect")}>
                A prospect's PSA
              </button>
            </div>
          )}

          {effectiveMode === "connection" ? (
            <div className="field">
              <label htmlFor="insight-connection">PSA connection</label>
              <select id="insight-connection" className="select" value={chosenConnection?.id ?? ""} onChange={(e) => setConnectionId(e.target.value)}>
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <>
              <div className="banner banner-info" role="note">
                <span>
                  A prospect's details are used for this report only and never saved. Ask them for a read-only API user; Haley only reads closed tickets. Reports work with{" "}
                  {supported.map((p) => p.name).join(", ")}.
                </span>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="insight-kind">PSA</label>
                  <select id="insight-kind" className="select" value={provider?.id ?? ""} onChange={(e) => (setKind(e.target.value as PsaKind), setConfig({}))}>
                    {supported.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="insight-name">
                    Prospect name <span className="muted">(optional)</span>
                  </label>
                  <input id="insight-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Northwind Traders" />
                </div>
              </div>
              {provider?.fields
                .filter((f) => !f.optional)
                .map((f) => (
                  <div className="field" key={f.key}>
                    <label htmlFor={`insight-${f.key}`}>{f.label}</label>
                    <input
                      id={`insight-${f.key}`}
                      className={`input ${f.secret ? "" : "mono"}`}
                      type={f.secret ? "password" : "text"}
                      placeholder={f.placeholder}
                      value={config[f.key] ?? ""}
                      onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                      spellCheck={false}
                      autoComplete={f.secret ? "new-password" : "off"}
                    />
                    {f.help && <span className="help">{f.help}</span>}
                  </div>
                ))}
            </>
          )}

          <div className="form-grid">
            <div className="field">
              <span className="field-label" id="insight-days-label">
                Closed in the last
              </span>
              <div className="segmented" role="group" aria-labelledby="insight-days-label">
                {DAYS.map((d) => (
                  <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
                    {d} days
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="insight-minutes">
                Minutes per ticket <span className="muted">(optional)</span>
              </label>
              <div className="input-suffix">
                <input
                  id="insight-minutes"
                  className="input"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={600}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  placeholder="Billing setting"
                  aria-invalid={!minutesOk}
                />
                <span aria-hidden="true">min</span>
              </div>
              <span className="help">Used where the PSA hasn't recorded time on most of a group's tickets.</span>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ one report

export function InsightReportPage() {
  const { id = "" } = useParams();
  const { user, toast } = useApp();
  const report = usePoll(() => api.insight(id), [id], (data) => (data?.status === "running" ? 2500 : null));
  const [samples, setSamples] = useState(false);

  if (report.error instanceof ApiError && report.error.status === 404) {
    return (
      <div className="card">
        <EmptyState title="Report not found" actions={<Link to="/insights" className="btn">Back to reports</Link>}>
          It may have been deleted.
        </EmptyState>
      </div>
    );
  }

  const r = report.data;
  const res = r?.result;
  const label = r?.params.source.label ?? "Report";

  return (
    <div className="report insight-report">
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
        docTitle={`${label}: what Haley could handle`}
        breadcrumb={
          <>
            <Link to="/insights">What would Haley handle?</Link>
            <ChevronRight className="icon-sm" aria-hidden="true" />
            <span>{label}</span>
          </>
        }
        title={
          <>
            {label} <span className="report-title-sub">What Haley could handle</span>
          </>
        }
        subtitle={r ? `Tickets closed ${dateFmt.format(new Date(r.params.from))} – ${dateFmt.format(new Date(r.params.to))} (${r.params.days} days)` : " "}
        actions={
          res && (
            <div className="row row-wrap no-print" style={{ gap: 8 }}>
              <label className="row insight-samples-toggle" style={{ gap: 8 }}>
                <Switch checked={samples} onChange={setSamples} label="Show example ticket subjects" />
                <span>Examples</span>
              </label>
              <button className="btn" onClick={() => void api.downloadInsightCsv(id, samples).catch((err) => toast(errorMessage(err), "error"))}>
                <Download className="icon-sm" aria-hidden="true" /> CSV
              </button>
              <button className="btn btn-primary" onClick={() => window.print()}>
                <Printer className="icon-sm" aria-hidden="true" /> Print / Save PDF
              </button>
            </div>
          )
        }
      />

      {report.error && <ErrorBanner error={report.error} onRetry={report.reload} />}
      {!r ? (
        !report.error && <Loading />
      ) : r.status === "running" ? (
        <div className="card">
          <Loading label="Reading closed tickets and grouping them… This can take a minute for a busy help desk." />
        </div>
      ) : r.status === "failed" || !res ? (
        <ErrorBanner error={r.error || "The report failed."} />
      ) : (
        <InsightBody report={r} samples={samples} />
      )}
    </div>
  );
}

function InsightBody({ report, samples }: { report: InsightReport; samples: boolean }) {
  const res = report.result!;
  const t = res.totals;
  const share = t.ticketsPerMonth ? Math.round((t.coveredTicketsPerMonth / t.ticketsPerMonth) * 100) : 0;
  const rows = [...res.clusters].sort((a, b) => b.hoursPerMonth - a.hoursPerMonth || b.tickets - a.tickets);
  const anyEstimate = res.clusters.some((c) => c.minutesSource === "estimate");
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="insight-headline card">
        <p>
          Haley could take about <strong>{formatNumber(t.coveredTicketsPerMonth)} tickets a month</strong> ({share}% of {formatNumber(t.ticketsPerMonth)}), freeing about{" "}
          <strong>{formatNumber(t.coveredHoursPerMonth)} technician hours</strong>.
        </p>
        <p className="secondary">Counts tickets she can resolve on her own or after a technician approves; assist-only work isn't included.</p>
      </section>

      <div className="kpis" style={{ marginBottom: 0 }}>
        <Kpi icon={<TicketIcon className="icon-sm" />} label="Closed tickets" value={formatNumber(t.tickets)} hint={`${formatNumber(t.ticketsPerMonth)} a month`} />
        <Kpi icon={<CircleCheck className="icon-sm" />} label="Haley could take" value={`${formatNumber(t.coveredTicketsPerMonth)}/mo`} hint={`${share}% of tickets`} />
        <Kpi icon={<Hourglass className="icon-sm" />} label="Hours freed" value={`${formatNumber(t.coveredHoursPerMonth)}/mo`} hint={anyEstimate ? "PSA time where recorded, else your estimate" : "from time recorded in the PSA"} />
        <Kpi icon={<Lightbulb className="icon-sm" />} label="Grouped" value={formatNumber(t.groupedTickets)} hint={`${formatNumber(res.other.tickets)} one-offs not grouped`} />
      </div>

      {res.truncated && (
        <div className="banner banner-warn" role="status">
          <span>This help desk closed more tickets than one report reads (5,000), so only the most recent were used. Try a shorter period.</span>
        </div>
      )}

      <section className="card">
        <div className="card-header">
          <h2>Ticket groups</h2>
          <span className="count">{rows.length}</span>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No repeat work found" compact>
            None of the closed tickets were similar enough to group. Try a longer period.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table insight-table">
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col" className="col-num">
                    Per month
                  </th>
                  <th scope="col" className="col-num hide-sm">
                    Min / ticket
                  </th>
                  <th scope="col" className="col-num">
                    Hours / month
                  </th>
                  <th scope="col">Haley</th>
                  <th scope="col" className="hide-md">
                    Needs
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <InsightRow key={c.id} cluster={c} samples={samples} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="secondary usage-notes">
        Tickets are grouped by the words their subjects and descriptions share; groups of fewer than three are left out. {res.model.used ? "An AI model named the groups and matched them to Haley's skills; matches are capped at what her tools allow." : "Groups were matched to Haley's skills by keyword (no AI model was available)."}{" "}
        Minutes per ticket are the median time recorded in the PSA where most of a group has it, otherwise {formatNumber(report.params.minutesPerTicket)} minutes. Monthly figures are
        scaled to 30 days. Only these totals and up to three example subjects per group are stored.
      </p>
    </div>
  );
}

function InsightRow({ cluster: c, samples }: { cluster: InsightCluster; samples: boolean }) {
  const cov = COVERAGE[c.coverage];
  return (
    <tr>
      <td className="cell-title">
        <span>{c.label}</span>
        <div className="cell-sub">
          {formatNumber(c.tickets)} tickets · {c.terms.slice(0, 4).join(", ")}
        </div>
        {samples && c.samples.length > 0 && (
          <ul className="insight-samples">
            {c.samples.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}
      </td>
      <td className="col-num">{formatNumber(c.ticketsPerMonth)}</td>
      <td className="col-num hide-sm">
        {formatNumber(c.minutesPerTicket)}
        <div className="cell-sub">{c.minutesSource === "psa" ? "from PSA" : "estimate"}</div>
      </td>
      <td className="col-num">{formatNumber(c.hoursPerMonth)}</td>
      <td>
        <Pill tone={cov.tone} title={cov.help}>
          {cov.label}
        </Pill>
        {c.recipes.length > 0 && <div className="cell-sub">{c.recipes.map((r) => r.name).join(" · ")}</div>}
      </td>
      <td className="hide-md">
        {c.integrations.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <ul className="insight-needs">
            {c.integrations.map((i) => (
              <li key={i.providers.join("|")} className={i.connected ? "is-connected" : ""}>
                {i.connected && <CircleCheck className="icon-xs" aria-label="Connected" />}
                {i.names.join(" or ")}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function Kpi({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label" title={label}>
        {icon}
        <span>{label}</span>
      </span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-hint">{hint}</span>
    </div>
  );
}
