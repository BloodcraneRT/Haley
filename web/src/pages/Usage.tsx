import { CircleCheck, Coins, Download, Hourglass, Settings2, TriangleAlert, Users } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, errorMessage, type BillingSettings, type UsageReport } from "../api";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { formatNumber, formatPercent, formatTokens, formatUsd } from "../lib/format";
import "../styles/usage.css";

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const monthLabel = (key: string) => new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${key}-01T00:00:00Z`));

/** This month and the eleven before it. */
function recentMonths(): string[] {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
}

export function UsagePage() {
  const { toast } = useApp();
  const months = recentMonths();
  const [params, setParams] = useSearchParams();
  const month = months.includes(params.get("month") ?? "") ? params.get("month")! : months[0];
  const usage = usePoll(() => api.usage(month), [month]);
  const [editing, setEditing] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const setMonth = (m: string) => {
    const next = new URLSearchParams(params);
    if (m === months[0]) next.delete("month");
    else next.set("month", m);
    setParams(next, { replace: true });
  };

  const download = async () => {
    setDownloading(true);
    try {
      await api.downloadUsageCsv(month);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setDownloading(false);
    }
  };

  const u = usage.data;
  return (
    <>
      <PageHeader
        title="Usage & billing"
        subtitle="What Haley did for each client and what it cost, for invoices and QBRs."
        actions={
          <div className="row row-wrap" style={{ gap: 8 }}>
            <select className="select usage-month" aria-label="Billing month" value={month} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m, i) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                  {i === 0 ? " (so far)" : ""}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => setEditing(true)} disabled={!u}>
              <Settings2 className="icon-sm" aria-hidden="true" /> Billing settings
            </button>
            <button className="btn btn-primary" onClick={() => void download()} disabled={!u || downloading}>
              <Download className="icon-sm" aria-hidden="true" /> {downloading ? "Downloading…" : "Download CSV"}
            </button>
          </div>
        }
      />

      {usage.error && <ErrorBanner error={usage.error} onRetry={usage.reload} />}
      {!u ? (
        !usage.error && <Loading label="Adding up usage…" />
      ) : (
        <UsageBody usage={u} refreshing={usage.loading} />
      )}

      {u && (
        <BillingSettingsModal
          open={editing}
          settings={u.settings}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast("Billing settings saved.");
            void usage.reload();
          }}
        />
      )}
    </>
  );
}

function UsageBody({ usage: u, refreshing }: { usage: UsageReport; refreshing: boolean }) {
  const t = u.totals;
  const markup = u.settings.aiMarkupPercent;
  const active = u.clients.filter((c) => c.modelCalls > 0 || c.ticketsResolvedByHaley > 0 || c.recipeRuns > 0);
  const confirmRate = t.ticketsResolvedByHaley ? (t.confirmedByRequester / t.ticketsResolvedByHaley) * 100 : null;
  return (
    <div className={`stack usage-body ${refreshing ? "is-refreshing" : ""}`} style={{ gap: 20 }}>
      {u.unpricedModels.length > 0 && (
        <div className="banner banner-warn" role="status">
          <TriangleAlert className="icon-sm" aria-hidden="true" />
          <span>
            No price set for {u.unpricedModels.join(", ")}, so {formatTokens(t.unpricedTokens)} tokens aren't in the AI cost. Add prices on the{" "}
            <Link to="/models">AI models</Link> page.
          </span>
        </div>
      )}

      <div className="kpis" style={{ marginBottom: 0 }}>
        <Kpi icon={<Coins className="icon-sm" />} label="AI cost" value={formatUsd(t.aiCostUsd)} hint={`${formatNumber(t.modelCalls)} model calls · ${formatTokens(t.inputTokens + t.outputTokens)} tokens`} />
        <Kpi
          icon={<Coins className="icon-sm" />}
          label="Billable AI"
          value={formatUsd(t.billableAiUsd)}
          hint={markup ? `with your ${formatNumber(markup)}% markup` : "no markup set"}
        />
        <Kpi icon={<Hourglass className="icon-sm" />} label="Hours saved" value={formatNumber(t.hoursSaved)} hint="estimated technician time" />
        <Kpi
          icon={<CircleCheck className="icon-sm" />}
          label="Confirmed fixed"
          value={formatPercent(confirmRate)}
          hint={`${formatNumber(t.confirmedByRequester)} of ${formatNumber(t.ticketsResolvedByHaley)} resolved by Haley alone`}
        />
        <Kpi icon={<Users className="icon-sm" />} label="Active technicians" value={formatNumber(u.technicians.count)} hint={u.technicians.names.slice(0, 3).join(", ") || "none this period"} />
      </div>

      <section className="card">
        <div className="card-header">
          <h2>By client</h2>
          <span className="count">{active.length}</span>
        </div>
        {active.length === 0 ? (
          <EmptyState icon={<Coins className="icon" />} title="Nothing this month" compact>
            Usage shows up here as Haley works tickets and tasks.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table usage-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col" className="col-num hide-sm">
                    Model calls
                  </th>
                  <th scope="col" className="col-num hide-md">
                    Tokens
                  </th>
                  <th scope="col" className="col-num">
                    AI cost
                  </th>
                  <th scope="col" className="col-num">
                    Billable
                  </th>
                  <th scope="col" className="col-num hide-sm">
                    Resolved alone
                  </th>
                  <th scope="col" className="col-num hide-md">
                    Confirmed
                  </th>
                  <th scope="col" className="col-num">
                    Hours saved
                  </th>
                </tr>
              </thead>
              <tbody>
                {active.map((c) => (
                  <tr key={c.orgId}>
                    <td className="cell-title">
                      <Link to={`/clients/${c.orgId}/report`}>{c.name}</Link>
                      {c.unpricedTokens > 0 && <div className="cell-sub">{formatTokens(c.unpricedTokens)} tokens unpriced</div>}
                    </td>
                    <td className="col-num hide-sm">{formatNumber(c.modelCalls)}</td>
                    <td className="col-num hide-md">{formatTokens(c.inputTokens + c.outputTokens)}</td>
                    <td className="col-num">{formatUsd(c.aiCostUsd)}</td>
                    <td className="col-num">{formatUsd(c.billableAiUsd)}</td>
                    <td className="col-num hide-sm">{formatNumber(c.ticketsResolvedByHaley)}</td>
                    <td className="col-num hide-md">{formatNumber(c.confirmedByRequester)}</td>
                    <td className="col-num">{formatNumber(c.hoursSaved)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="secondary usage-notes">
        Hours saved assumes {formatNumber(u.settings.minutesPerTicket)} minutes per ticket Haley resolved alone and {formatNumber(u.settings.minutesPerAction)} per automatic change, plus
        each completed recipe's estimate. AI cost uses the prices on the AI models page. {u.technicians.note} Resolved tickets with no reply close after{" "}
        {u.settings.autoCloseResolvedDays ? `${u.settings.autoCloseResolvedDays} day${u.settings.autoCloseResolvedDays === 1 ? "" : "s"}` : "never (auto-close is off)"}. Pricing options are in{" "}
        <code>docs/PRICING.md</code>.
      </p>
    </div>
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

const FIELDS: Array<{ key: keyof BillingSettings; label: string; help: string; min: number; max: number; step: number; suffix: string }> = [
  { key: "aiMarkupPercent", label: "AI markup", help: "Added to AI cost in the Billable column, for passing it through to clients.", min: 0, max: 1000, step: 1, suffix: "%" },
  { key: "minutesPerTicket", label: "Minutes per ticket", help: "Technician time a ticket Haley resolves alone would otherwise take.", min: 0, max: 600, step: 1, suffix: "min" },
  { key: "minutesPerAction", label: "Minutes per change", help: "Technician time per change Haley makes without approval.", min: 0, max: 120, step: 1, suffix: "min" },
  { key: "autoCloseResolvedDays", label: "Auto-close after", help: "Close resolved tickets when the requester doesn't reply. 0 turns it off.", min: 0, max: 90, step: 1, suffix: "days" },
];

function BillingSettingsModal({ open, settings, onClose, onSaved }: { open: boolean; settings: BillingSettings; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [wasOpen, setWasOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(settings[f.key])])));
  }
  const values = FIELDS.map((f) => ({ f, n: Number(draft[f.key]) }));
  const valid = values.every(({ f, n }) => draft[f.key]?.trim() !== "" && Number.isFinite(n) && n >= f.min && n <= f.max && (f.key !== "autoCloseResolvedDays" || Number.isInteger(n)));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      await api.updateBillingSettings(Object.fromEntries(values.map(({ f, n }) => [f.key, n])) as Partial<BillingSettings>);
      onSaved();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Billing settings"
      onClose={onClose}
      footer={
        <>
          {busy && <Spinner />}
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="billing-form" disabled={!valid || busy}>
            Save
          </button>
        </>
      }
    >
      <form id="billing-form" className="form-grid" onSubmit={save}>
        {FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`billing-${f.key}`}>{f.label}</label>
            <div className="input-suffix">
              <input
                id={`billing-${f.key}`}
                className="input"
                type="number"
                inputMode="decimal"
                min={f.min}
                max={f.max}
                step={f.step}
                value={draft[f.key] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
              <span aria-hidden="true">{f.suffix}</span>
            </div>
            <span className="help">{f.help}</span>
          </div>
        ))}
      </form>
    </Modal>
  );
}
