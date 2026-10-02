import {
  ArrowLeftRight,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  KeyRound,
  Link2,
  MessageSquareText,
  Plug,
  RefreshCw,
  Search,
  Sparkles,
  Ticket as TicketIcon,
  Trash,
  Upload,
  Users,
  Wand2,
  X,
  Timer,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  api,
  ApiError,
  errorMessage,
  type OrgSummary,
  type PsaConnection,
  type PsaConnectionListItem,
  type PsaCustomer,
  type PsaKind,
  type PsaOptions,
  type PsaProviderInfo,
  type SyncResult,
} from "../api";
import { Disclosure } from "../components/Disclosure";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { ConfirmModal, Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { IntegrationStatusPill, Pill } from "../components/Pill";
import { ProviderLogo } from "../components/ProviderLogo";
import { RelativeTime } from "../components/RelativeTime";
import { Switch } from "../components/Switch";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { formatNumber, PSA_NAMES } from "../lib/format";

const DEFAULT_OPTIONS: PsaOptions = { importTickets: true, exportTickets: true, mirrorNotes: true, requesterAssurance: "none" };

const OPTION_ROWS: Array<{ key: "importTickets" | "exportTickets" | "mirrorNotes"; label: string; help: string; icon: typeof Download }> = [
  { key: "importTickets", label: "Import tickets", help: "New tickets for mapped customers open in Haley and she works them.", icon: Download },
  { key: "exportTickets", label: "Export Haley tickets", help: "Tickets that start in email, Slack or Teams are created in the PSA too, so billing sees them.", icon: Upload },
  { key: "mirrorNotes", label: "Mirror notes", help: "Haley's notes and actions are copied as internal (hidden) comments.", icon: MessageSquareText },
];

// ------------------------------------------------------------------ list page

export function PsaPage() {
  const [params, setParams] = useSearchParams();
  const connections = usePoll(() => api.psaConnections(), [], 30_000);
  const providers = usePoll(() => api.psaProviders(), []);
  const [results, setResults] = useState<Record<string, { result: SyncResult; at: string }>>({});

  const connectOpen = params.get("connect") === "1";
  const setConnectOpen = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set("connect", "1");
    else next.delete("connect");
    setParams(next, { replace: true });
  };

  const list = connections.data ?? [];

  return (
    <>
      <PageHeader
        title="PSA sync"
        subtitle="Keep Haley and your PSA or service desk in step: customer tickets flow in for Haley to work, her replies and notes flow back, and status stays in sync both ways."
        actions={
          <button className="btn btn-primary" onClick={() => setConnectOpen(true)} disabled={!providers.data}>
            <Plug className="icon-sm" aria-hidden="true" /> Connect PSA
          </button>
        }
      />

      {connections.error && <ErrorBanner error={connections.error} onRetry={connections.reload} />}

      {connections.loading && !connections.data ? (
        <div className="card">
          <Loading />
        </div>
      ) : list.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<ArrowLeftRight className="icon" />}
            title="No PSA connected"
            actions={
              <button className="btn btn-primary" onClick={() => setConnectOpen(true)} disabled={!providers.data}>
                <Plug className="icon-sm" aria-hidden="true" /> Connect SyncroMSP or Dynamics 365
              </button>
            }
          >
            Connect your PSA so customer tickets reach Haley without anyone copying them over, and your technicians see her work where they already
            live. Every sync is recorded in the audit log.
          </EmptyState>
        </div>
      ) : (
        <div className="psa-grid">
          {list.map((c) => (
            <PsaCard
              key={c.id}
              connection={c}
              provider={providers.data?.find((p) => p.id === c.kind)}
              lastResult={results[c.id]}
              onSynced={(result) => setResults((r) => ({ ...r, [c.id]: { result, at: new Date().toISOString() } }))}
              onDismissResult={() =>
                setResults((r) => {
                  const next = { ...r };
                  delete next[c.id];
                  return next;
                })
              }
              onChanged={() => void connections.reload()}
            />
          ))}
        </div>
      )}

      {list.length > 0 && (
        <p className="muted" style={{ fontSize: "var(--text-sm)", marginTop: 16 }}>
          Haley syncs enabled connections every couple of minutes. Tickets from a PSA show its number, e.g. <strong>Syncro #1234</strong>, and her
          replies go back as public comments so the PSA notifies the customer.
        </p>
      )}

      {providers.data && (
        <ConnectPsaModal
          open={connectOpen}
          providers={providers.data}
          onClose={() => setConnectOpen(false)}
          onConnected={() => {
            setConnectOpen(false);
            void connections.reload();
          }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ card

function PsaCard({
  connection: c,
  provider,
  lastResult,
  onSynced,
  onDismissResult,
  onChanged,
}: {
  connection: PsaConnectionListItem;
  provider: PsaProviderInfo | undefined;
  lastResult: { result: SyncResult; at: string } | undefined;
  onSynced: (r: SyncResult) => void;
  onDismissResult: () => void;
  onChanged: () => void;
}) {
  const { toast, refreshStats } = useApp();
  const [busy, setBusy] = useState<"test" | "sync" | "enabled" | "options" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [options, setOptions] = useState<PsaOptions>({ ...DEFAULT_OPTIONS, ...c.options });
  useEffect(() => setOptions({ ...DEFAULT_OPTIONS, ...c.options }), [c.options]);
  const mapped = Object.keys(c.customer_map).length;

  const run = async <T,>(kind: NonNullable<typeof busy>, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(kind);
    try {
      return await fn();
    } catch (err) {
      toast(errorMessage(err), "error");
      return undefined;
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const test = () =>
    run("test", async () => {
      const result = await api.testPsa(c.id);
      if (result.status === "connected") toast(`Connection OK. ${result.status_detail}`);
      else toast(`${c.name}: connection failed. ${result.status_detail}`, "error");
    });

  const sync = () =>
    run("sync", async () => {
      const result = await api.syncPsa(c.id);
      onSynced(result);
      if (result.imported || result.exported) refreshStats();
    });

  const setEnabled = (enabled: boolean) =>
    run("enabled", async () => {
      await api.updatePsa(c.id, { enabled });
      toast(enabled ? `${c.name} sync resumed.` : `${c.name} sync paused. Nothing is imported or pushed until you turn it back on.`);
    });

  const setOption = (patch: Partial<PsaOptions>) => {
    setOptions((o) => ({ ...o, ...patch }));
    void run("options", async () => {
      await api.updatePsa(c.id, { options: patch });
    });
  };

  const remove = () =>
    run("remove", async () => {
      await api.deletePsa(c.id);
      toast(`${c.name} disconnected.`);
      setConfirmRemove(false);
    });

  return (
    <article className={`psa-card ${c.enabled ? "" : "is-disabled"}`} aria-labelledby={`psa-${c.id}`}>
      <header className="channel-card-head">
        <ProviderLogo provider={c.kind} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 id={`psa-${c.id}`} className="truncate">
            {c.name}
          </h2>
          <div className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {provider?.name ?? PSA_NAMES[c.kind] ?? c.kind} · added <RelativeTime iso={c.created_at} />
          </div>
        </div>
        <label className="row psa-enabled" style={{ gap: 8 }}>
          <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {c.enabled ? "Syncing" : "Paused"}
          </span>
          <Switch checked={c.enabled} onChange={(v) => void setEnabled(v)} label={c.enabled ? `Pause ${c.name} sync` : `Resume ${c.name} sync`} disabled={busy !== null} />
        </label>
      </header>

      <div className="row row-wrap" style={{ gap: 6 }}>
        <IntegrationStatusPill status={c.status} />
        {!c.enabled && <Pill tone="neutral">Sync paused</Pill>}
      </div>
      {c.status_detail && <p className={`status-detail ${c.status === "error" ? "error" : ""}`}>{c.status_detail}</p>}

      <dl className="psa-stats">
        <div>
          <dt>Last sync</dt>
          <dd>{c.last_sync_at ? <RelativeTime iso={c.last_sync_at} /> : <span className="muted">Never</span>}</dd>
        </div>
        <div>
          <dt>Linked tickets</dt>
          <dd className="num">{formatNumber(c.linkedTickets)}</dd>
        </div>
        <div>
          <dt>{c.kind === "dynamics" ? "Accounts" : "Customers"}</dt>
          <dd className="num">
            {mapped ? `${formatNumber(mapped)} mapped` : <span style={{ color: "var(--tone-amber-fg)" }}>None mapped</span>}
          </dd>
        </div>
      </dl>

      {mapped === 0 && (
        <div className="banner banner-warn">
          <Users className="icon" aria-hidden="true" />
          <span className="spacer">
            Map {c.kind === "dynamics" ? "accounts" : "customers"} to Haley clients before the first sync. Tickets from unmapped customers are skipped.
          </span>
        </div>
      )}

      {lastResult && <SyncResultPanel result={lastResult.result} at={lastResult.at} connectionId={c.id} onDismiss={onDismissResult} />}

      <div className="psa-options">
        {OPTION_ROWS.map((o) => (
          <div key={o.key} className="psa-option">
            <o.icon className="icon-sm muted" aria-hidden="true" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="psa-option-label">{o.label}</div>
              <div className="psa-option-help">{o.help}</div>
            </div>
            <Switch checked={options[o.key]} onChange={(v) => setOption({ [o.key]: v })} label={o.label} disabled={busy === "options"} />
          </div>
        ))}
        <div className="psa-option">
          <KeyRound className="icon-sm muted" aria-hidden="true" />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="psa-option-label">Requester identity</div>
            <div className="psa-option-help">
              What imported tickets prove about who's asking. Choose <em>Email</em> only if the PSA verifies senders.
            </div>
          </div>
          <div className="segmented" role="group" aria-label="Requester identity for imported tickets">
            {(["none", "email"] as const).map((a) => (
              <button key={a} type="button" aria-pressed={options.requesterAssurance === a} onClick={() => setOption({ requesterAssurance: a })} disabled={busy === "options"}>
                {a === "none" ? "None" : "Email"}
              </button>
            ))}
          </div>
        </div>
        {provider?.timeEntries && <TimeEntriesOption value={options.timeEntries} onChange={(v) => setOption({ timeEntries: v })} disabled={busy === "options"} />}
      </div>

      <div className="integration-actions">
        <button className="btn btn-sm" onClick={() => void test()} disabled={busy !== null}>
          {busy === "test" ? <Spinner /> : <RefreshCw className="icon-sm" aria-hidden="true" />} Test
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => void sync()} disabled={busy !== null || !c.enabled} title={c.enabled ? "Sync now" : "Resume sync first"}>
          {busy === "sync" ? <Spinner /> : <ArrowLeftRight className="icon-sm" aria-hidden="true" />} {busy === "sync" ? "Syncing…" : "Sync now"}
        </button>
        <Link to={`/psa/${c.id}/customers`} className="btn btn-sm">
          <Users className="icon-sm" aria-hidden="true" /> Map customers
        </Link>
        <button className="btn btn-sm" onClick={() => setEditOpen(true)}>
          <KeyRound className="icon-sm" aria-hidden="true" /> Edit credentials
        </button>
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost btn-icon" onClick={() => setConfirmRemove(true)} aria-label={`Remove ${c.name}`} title="Remove">
          <Trash className="icon-sm" aria-hidden="true" />
        </button>
      </div>

      {provider && <EditPsaModal open={editOpen} connection={c} provider={provider} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); onChanged(); }} />}
      <ConfirmModal
        open={confirmRemove}
        title={`Disconnect ${c.name}?`}
        confirmLabel="Disconnect"
        busy={busy === "remove"}
        onConfirm={() => void remove()}
        onClose={() => setConfirmRemove(false)}
      >
        Haley stops syncing with {provider?.name ?? c.kind} and deletes the stored credentials. Tickets already imported stay in Haley, and nothing
        is deleted in the PSA. Reconnecting starts a fresh link.
      </ConfirmModal>
    </article>
  );
}

function SyncStat({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return (
    <div className={`sync-stat ${value ? "has-value" : ""}`}>
      <span className="sync-stat-label">
        {icon}
        {label}
      </span>
      <span className="sync-stat-value num">{formatNumber(value)}</span>
    </div>
  );
}

const TIME_ENTRY_CHOICES = [
  ["off", "Off"],
  ["actual", "Working time"],
  ["estimate", "Estimate"],
] as const;

/** Whether and how Haley's work becomes time entries on the PSA ticket. */
function TimeEntriesOption({ value, onChange, disabled }: { value: PsaOptions["timeEntries"]; onChange: (v: NonNullable<PsaOptions["timeEntries"]>) => void; disabled?: boolean }) {
  const current = value ?? "off";
  return (
    <div className="psa-option">
      <Timer className="icon-sm muted" aria-hidden="true" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="psa-option-label">Log Haley's time</div>
        <div className="psa-option-help">
          {current === "estimate"
            ? "When Haley resolves a ticket, add one time entry at your minutes-per-ticket estimate (Usage & billing settings)."
            : current === "actual"
              ? "Add a time entry for each piece of work Haley does on a ticket, with her actual working time and summary."
              : "Add Haley's work to the PSA ticket as time entries, so it shows in the PSA's billing and reports. Entries aren't charged; your technicians decide what to bill."}
        </div>
      </div>
      <div className="segmented" role="group" aria-label="Log Haley's time">
        {TIME_ENTRY_CHOICES.map(([v, label]) => (
          <button key={v} type="button" aria-pressed={current === v} onClick={() => onChange(v)} disabled={disabled}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SyncResultPanel({ result: r, at, connectionId, onDismiss }: { result: SyncResult; at: string; connectionId: string; onDismiss: () => void }) {
  const failed = r.errors.length > 0;
  const nothing = !r.imported && !r.commentsImported && !r.exported && !r.pushed && !r.statusUpdates && !r.timeLogged;
  return (
    <section className={`sync-result ${failed ? "is-error" : ""}`} aria-label="Sync result">
      <header className="sync-result-head">
        {failed ? <CircleAlert className="icon-sm" aria-hidden="true" /> : <CircleCheck className="icon-sm" aria-hidden="true" />}
        <strong>{failed ? `Synced with ${r.errors.length} error${r.errors.length === 1 ? "" : "s"}` : nothing ? "Up to date: nothing to sync" : "Sync complete"}</strong>
        <span className="muted">
          · <RelativeTime iso={at} />
        </span>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onDismiss} aria-label="Dismiss sync result">
          <X className="icon-sm" />
        </button>
      </header>
      <div className="sync-stats">
        <SyncStat label="Imported" value={r.imported} icon={<Download className="icon-xs" aria-hidden="true" />} />
        <SyncStat label="Comments" value={r.commentsImported} icon={<MessageSquareText className="icon-xs" aria-hidden="true" />} />
        <SyncStat label="Exported" value={r.exported} icon={<Upload className="icon-xs" aria-hidden="true" />} />
        <SyncStat label="Mirrored" value={r.pushed} icon={<ArrowLeftRight className="icon-xs" aria-hidden="true" />} />
        <SyncStat label="Status" value={r.statusUpdates} icon={<RefreshCw className="icon-xs" aria-hidden="true" />} />
        {r.timeLogged ? <SyncStat label="Time logged" value={r.timeLogged} icon={<Timer className="icon-xs" aria-hidden="true" />} /> : null}
      </div>
      {r.unmappedCustomers.length > 0 && (
        <div className="sync-note tone-amber">
          <Users className="icon-xs" aria-hidden="true" />
          <span>
            Skipped tickets from {r.unmappedCustomers.length} unmapped customer{r.unmappedCustomers.length === 1 ? "" : "s"}:{" "}
            <strong>{r.unmappedCustomers.slice(0, 6).join(", ")}</strong>
            {r.unmappedCustomers.length > 6 ? ` and ${r.unmappedCustomers.length - 6} more` : ""}. <Link to={`/psa/${connectionId}/customers`}>Map them</Link>
          </span>
        </div>
      )}
      {failed && (
        <ul className="sync-errors">
          {r.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ connect / edit

function PsaFields({
  provider,
  config,
  onChange,
  editing,
}: {
  provider: PsaProviderInfo;
  config: Record<string, string>;
  onChange: (key: string, value: string) => void;
  editing?: boolean;
}) {
  return (
    <>
      {provider.fields.map((f) => (
        <div className="field" key={f.key}>
          <label htmlFor={`psa-${f.key}`}>
            {f.label} {(f.optional || editing) && <span className="muted">({editing ? "leave blank to keep" : "optional"})</span>}
          </label>
          <input
            id={`psa-${f.key}`}
            className={`input ${f.secret ? "" : "mono"}`}
            type={f.secret ? "password" : "text"}
            placeholder={editing ? (f.secret ? "Stored. Leave blank to keep it" : "Unchanged") : f.placeholder}
            value={config[f.key] ?? ""}
            onChange={(e) => onChange(f.key, e.target.value)}
            spellCheck={false}
            autoComplete={f.secret ? "new-password" : "off"}
          />
          {f.help && <span className="help">{f.help}</span>}
          {f.secret && !editing && <span className="help">Encrypted at rest; never shown again.</span>}
        </div>
      ))}
    </>
  );
}

function ConnectPsaModal({
  open,
  providers,
  onClose,
  onConnected,
}: {
  open: boolean;
  providers: PsaProviderInfo[];
  onClose: () => void;
  onConnected: (c: PsaConnection) => void;
}) {
  const { toast } = useApp();
  const [kind, setKind] = useState<PsaKind>(providers[0]?.id ?? "syncro");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<PsaOptions>(DEFAULT_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(providers[0]?.id ?? "syncro");
    setName("");
    setConfig({});
    setOptions(DEFAULT_OPTIONS);
    setError(null);
  }, [open, providers]);

  const info = providers.find((p) => p.id === kind);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!info) return;
    const missing = info.fields.filter((f) => !f.optional && !config[f.key]?.trim()).map((f) => f.label);
    if (missing.length) return setError(`Missing: ${missing.join(", ")}`);
    setBusy(true);
    setError(null);
    try {
      const connection = await api.createPsa({ kind: info.id, name: name.trim() || undefined, config, options });
      if (connection.status === "connected") toast(`${info.name} connected. ${connection.status_detail} Next: map customers to clients.`);
      else toast(`${info.name} was added but the connection test failed: ${connection.status_detail}`, "error");
      onConnected(connection);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect a PSA"
      size="wide"
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="psa-form" disabled={!info || busy}>
            {busy ? <Spinner /> : <Plug className="icon-sm" aria-hidden="true" />} Connect & test
          </button>
        </>
      }
    >
      <form id="psa-form" className="stack" onSubmit={submit}>
        <div className="choice-grid" role="radiogroup" aria-label="PSA">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={kind === p.id}
              className="choice"
              onClick={() => {
                setKind(p.id);
                setConfig({});
                setError(null);
              }}
            >
              <span className="choice-title">
                <ProviderLogo provider={p.id} />
                {p.name}
              </span>
              <span className="choice-desc">{p.description}</span>
            </button>
          ))}
        </div>

        {info && (
          <>
            <div className="grid-2" style={{ alignItems: "start" }}>
              <div className="stack-sm">
                <span className="field-label">Setup in {info.name}</span>
                <ol className="steps">
                  {info.setupSteps.map((s, n) => (
                    <li key={n}>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="stack">
                <PsaFields provider={info} config={config} onChange={(k, v) => setConfig((c) => ({ ...c, [k]: v }))} />
                <div className="field">
                  <label htmlFor="psa-name">
                    Name <span className="muted">(optional)</span>
                  </label>
                  <input id="psa-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={info.name} />
                </div>
              </div>
            </div>

            <Disclosure summary="Sync options">
              <div className="psa-options" style={{ marginTop: 4 }}>
                {OPTION_ROWS.map((o) => (
                  <div key={o.key} className="psa-option">
                    <o.icon className="icon-sm muted" aria-hidden="true" />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="psa-option-label">{o.label}</div>
                      <div className="psa-option-help">{o.help}</div>
                    </div>
                    <Switch checked={options[o.key]} onChange={(v) => setOptions((x) => ({ ...x, [o.key]: v }))} label={o.label} />
                  </div>
                ))}
                <div className="psa-option">
                  <KeyRound className="icon-sm muted" aria-hidden="true" />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="psa-option-label">Requester identity</div>
                    <div className="psa-option-help">Imported requesters are unverified unless the PSA authenticates senders.</div>
                  </div>
                  <div className="segmented" role="group" aria-label="Requester identity">
                    {(["none", "email"] as const).map((a) => (
                      <button key={a} type="button" aria-pressed={options.requesterAssurance === a} onClick={() => setOptions((x) => ({ ...x, requesterAssurance: a }))}>
                        {a === "none" ? "None" : "Email"}
                      </button>
                    ))}
                  </div>
                </div>
                {info.timeEntries && <TimeEntriesOption value={options.timeEntries} onChange={(v) => setOptions((x) => ({ ...x, timeEntries: v }))} />}
              </div>
            </Disclosure>
          </>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function EditPsaModal({
  open,
  connection,
  provider,
  onClose,
  onSaved,
}: {
  open: boolean;
  connection: PsaConnection;
  provider: PsaProviderInfo;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(connection.name);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(connection.name);
    setConfig({});
    setError(null);
  }, [open, connection.name]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Give the connection a name.");
    setBusy(true);
    setError(null);
    try {
      const changed = Object.values(config).some((v) => v.trim());
      const result = await api.updatePsa(connection.id, { name: name.trim(), ...(changed ? { config } : {}) });
      if (!changed) toast("Saved.");
      else if (result.status === "connected") toast(`Credentials updated. ${result.status_detail}`);
      else toast(`Credentials saved but the test failed: ${result.status_detail}`, "error");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit ${connection.name}`}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form={`psa-edit-${connection.id}`} disabled={busy}>
            {busy && <Spinner />} Save & test
          </button>
        </>
      }
    >
      <form id={`psa-edit-${connection.id}`} className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="psa-edit-name">Name</label>
          <input id="psa-edit-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="secondary" style={{ fontSize: "var(--text-sm)" }}>
          Stored values are never shown. Fill in only what you want to change; blank fields keep their current value. New credentials are tested
          right away.
        </p>
        <PsaFields provider={provider} config={config} onChange={(k, v) => setConfig((c) => ({ ...c, [k]: v }))} editing />
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ customer mapping

export function PsaMappingPage() {
  const { id = "" } = useParams();
  const { toast } = useApp();
  const connections = usePoll(() => api.psaConnections(), []);
  const customers = usePoll(() => api.psaCustomers(id), [id]);
  const orgs = usePoll(() => api.orgs(), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const [saving, setSaving] = useState(false);

  const connection = connections.data?.find((c) => c.id === id);
  const list = useMemo(() => customers.data ?? [], [customers.data]);
  const orgList: OrgSummary[] = useMemo(() => orgs.data ?? [], [orgs.data]);
  const orgName = useMemo(() => new Map(orgList.map((o) => [o.id, o.name])), [orgList]);

  // The saved mapping, from the server's view of each customer.
  const saved = useMemo(() => Object.fromEntries(list.filter((c) => c.orgId).map((c) => [c.id, c.orgId as string])), [list]);
  useEffect(() => setDraft(saved), [saved]);

  const value = (c: PsaCustomer) => draft[c.id] ?? "";
  const dirtyIds = list.filter((c) => (draft[c.id] ?? "") !== (saved[c.id] ?? "")).map((c) => c.id);
  const pendingSuggestions = list.filter((c) => c.suggestedOrgId && orgName.has(c.suggestedOrgId) && !value(c));
  const mappedCount = list.filter((c) => value(c)).length;

  const q = filter.trim().toLowerCase();
  const visible = list.filter(
    (c) => (!onlyUnmapped || !value(c)) && (!q || c.name.toLowerCase().includes(q) || c.domains.some((d) => d.includes(q)) || c.id.includes(q)),
  );

  const acceptAll = () =>
    setDraft((d) => {
      const next = { ...d };
      for (const c of pendingSuggestions) next[c.id] = c.suggestedOrgId!;
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      // Only mapped rows: an unmapped customer is simply absent from the map.
      const map = Object.fromEntries(Object.entries(draft).filter(([cid, orgId]) => orgId && list.some((c) => c.id === cid)));
      await api.setPsaMapping(id, map);
      toast(`Mapping saved: ${Object.keys(map).length} customer${Object.keys(map).length === 1 ? "" : "s"} mapped. The next sync picks up their tickets.`);
      await customers.reload();
      void connections.reload();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const kindName = connection ? (PSA_NAMES[connection.kind] ?? connection.kind) : "the PSA";
  const noun = connection?.kind === "dynamics" ? "account" : "customer";

  if (connections.data && !connection) {
    return (
      <div className="card">
        <EmptyState title="Connection not found" actions={<Link to="/psa" className="btn">Back to PSA sync</Link>}>
          It may have been removed.
        </EmptyState>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Link to="/psa">PSA sync</Link>
            <ChevronRight className="icon-sm" aria-hidden="true" />
            <span className="truncate">{connection?.name ?? "…"}</span>
          </>
        }
        docTitle={`${connection?.name ?? "PSA"} customer mapping`}
        title={
          <span className="row" style={{ gap: 10 }}>
            {connection && <ProviderLogo provider={connection.kind} />}
            <span>Customer mapping</span>
          </span>
        }
        subtitle={`Tell Haley which Haley client each ${kindName} ${noun} is. Tickets from mapped ${noun}s are imported into that client; unmapped ones are skipped.`}
        actions={
          !customers.error && (
          <>
            {dirtyIds.length > 0 && (
              <button className="btn btn-ghost" onClick={() => setDraft(saved)} disabled={saving}>
                Discard
              </button>
            )}
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving || dirtyIds.length === 0}>
              {saving ? <Spinner /> : <Link2 className="icon-sm" aria-hidden="true" />} Save mapping
              {dirtyIds.length > 0 && <span className="btn-count">{dirtyIds.length}</span>}
            </button>
          </>
          )
        }
      />

      {customers.error ? (
        <div className="card">
          <EmptyState
            icon={<CircleAlert className="icon" />}
            title={`Couldn't load ${noun}s from ${kindName}`}
            actions={
              <>
                <button className="btn btn-primary" onClick={() => void customers.reload()}>
                  <RefreshCw className="icon-sm" aria-hidden="true" /> Try again
                </button>
                <Link to="/psa" className="btn">
                  Back to PSA sync
                </Link>
              </>
            }
          >
            {customers.error instanceof ApiError && customers.error.status >= 500 && customers.error.message === "Internal error"
              ? `Haley couldn't reach ${kindName} to list ${noun}s. `
              : `${customers.error.message} `}
            {connection?.status === "error" && connection.status_detail ? (
              <>
                The last connection test failed: <em>{connection.status_detail}</em>.{" "}
              </>
            ) : null}
            Check the credentials with <strong>Test</strong> on the PSA sync page.
          </EmptyState>
        </div>
      ) : customers.loading && !customers.data ? (
        <div className="card">
          <Loading label={`Loading ${noun}s from ${kindName}…`} />
        </div>
      ) : list.length === 0 ? (
        <div className="card">
          <EmptyState icon={<Users className="icon" />} title={`No ${noun}s in ${kindName}`}>
            Once {noun}s exist there, they appear here to map.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="toolbar" role="search">
            <div className="input-with-icon">
              <Search className="icon" aria-hidden="true" />
              <label htmlFor="map-search" className="sr-only">
                Search {noun}s
              </label>
              <input id="map-search" className="input" placeholder={`Search ${noun} name or domain`} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="segmented" role="group" aria-label="Show">
              <button type="button" aria-pressed={!onlyUnmapped} onClick={() => setOnlyUnmapped(false)}>
                All {list.length}
              </button>
              <button type="button" aria-pressed={onlyUnmapped} onClick={() => setOnlyUnmapped(true)}>
                Unmapped {list.length - mappedCount}
              </button>
            </div>
            <button className="btn btn-sm" onClick={acceptAll} disabled={pendingSuggestions.length === 0} title="Map every unmapped customer to its suggested client">
              <Wand2 className="icon-sm" aria-hidden="true" /> Accept all suggestions
              {pendingSuggestions.length > 0 && <span className="btn-count">{pendingSuggestions.length}</span>}
            </button>
            <span className="spacer" />
            <span className="muted num" style={{ fontSize: "var(--text-sm)" }}>
              {mappedCount} of {list.length} mapped
            </span>
          </div>

          <div className="card">
            {visible.length === 0 ? (
              <EmptyState icon={<Search className="icon" />} title={`No ${noun}s match`} compact />
            ) : (
              <div className="table-wrap">
                <table className="table mapping-table">
                  <thead>
                    <tr>
                      <th scope="col">{noun === "account" ? "Account" : "Customer"}</th>
                      <th scope="col" className="hide-sm">
                        Domains
                      </th>
                      <th scope="col" className="hide-sm">
                        Suggestion
                      </th>
                      <th scope="col">Haley client</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((c) => {
                      const v = value(c);
                      const suggestion = c.suggestedOrgId && orgName.has(c.suggestedOrgId) ? c.suggestedOrgId : null;
                      const dirty = (draft[c.id] ?? "") !== (saved[c.id] ?? "");
                      const suggestedUnmapped = suggestion && !v;
                      return (
                        <tr key={c.id} className={`${dirty ? "is-dirty" : ""} ${suggestedUnmapped ? "is-suggested" : ""}`}>
                          <td>
                            <div style={{ fontWeight: 560 }}>{c.name}</div>
                            <div className="cell-sub mono">#{c.id}</div>
                          </td>
                          <td className="hide-sm">
                            {c.domains.length ? (
                              <span className="row row-wrap" style={{ gap: 4 }}>
                                {c.domains.map((d) => (
                                  <span key={d} className="tag mono">
                                    {d}
                                  </span>
                                ))}
                              </span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="hide-sm">
                            {suggestion ? (
                              v === suggestion ? (
                                <span className="row muted" style={{ gap: 4, fontSize: "var(--text-sm)" }}>
                                  <CircleCheck className="icon-xs" aria-hidden="true" style={{ color: "var(--tone-green-fg)" }} /> Matches
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="suggestion-chip"
                                  onClick={() => setDraft((d) => ({ ...d, [c.id]: suggestion }))}
                                  title="Use the suggested client (matched by domain or name)"
                                >
                                  <Sparkles className="icon-xs" aria-hidden="true" /> {orgName.get(suggestion)}
                                </button>
                              )
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td>
                            <label htmlFor={`map-${c.id}`} className="sr-only">
                              Haley client for {c.name}
                            </label>
                            <select
                              id={`map-${c.id}`}
                              className={`select select-sm mapping-select ${v ? "" : "is-empty"}`}
                              value={v}
                              onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                            >
                              <option value="">Not mapped: skip</option>
                              {orgList.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name}
                                  {o.id === suggestion ? " (suggested)" : ""}
                                </option>
                              ))}
                            </select>
                            {suggestion && v !== suggestion && (
                              <button type="button" className="link-button show-sm" onClick={() => setDraft((d) => ({ ...d, [c.id]: suggestion }))}>
                                Suggested: {orgName.get(suggestion)}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <p className="muted" style={{ fontSize: "var(--text-sm)", marginTop: 12 }}>
            <TicketIcon className="icon-xs" aria-hidden="true" style={{ verticalAlign: "-1px" }} /> Suggestions match a {noun}'s email or web
            domains against each client's primary and extra domains, then exact names. Several {noun}s can map to the same client.
          </p>
        </>
      )}
    </>
  );
}
