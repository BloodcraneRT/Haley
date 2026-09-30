import {
  BookOpen,
  BrainCircuit,
  ChevronRight,
  CircleCheck,
  FileChartColumn,
  FlaskConical,
  Globe,
  Inbox,
  MessagesSquare,
  OctagonPause,
  Plug,
  Plus,
  Radar,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  TriangleAlert,
  Ticket as TicketIcon,
  Trash,
  Wrench,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  api,
  ApiError,
  errorMessage,
  type Autonomy,
  type Integration,
  type IntegrationMode,
  type ModelProfileListItem,
  type OrgDetail,
  type ProviderId,
  type ProviderInfo,
  type Risk,
} from "../api";
import { AutonomyPicker, PolicyMatrix } from "../components/AutonomyPicker";
import { Disclosure } from "../components/Disclosure";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { ConsentConnect, ConsentResultBanner, ConsentUnavailableNote, DiscoveryPanel, useDiscovery } from "../components/M365Onboarding";
import { ConfirmModal, Modal } from "../components/Modal";
import { PausedBanner, SafetySettingsForm, usePauseControl } from "../components/OrgSafety";
import { PageHeader } from "../components/PageHeader";
import { PolicyRulesSection } from "../components/PolicyRules";
import { IntegrationStatusPill, ModePill, Pill, RiskPill } from "../components/Pill";
import { ProviderLogo } from "../components/ProviderLogo";
import { RelativeTime } from "../components/RelativeTime";
import { RunRow } from "../components/RunRow";
import { SchedulesSection } from "../components/Schedules";
import { usePoll } from "../hooks/usePoll";
import { useDraft } from "../hooks/useDraft";
import { useApp } from "../lib/app-context";
import { AUTONOMY_META, isRunActive, PROVIDER_NAMES } from "../lib/format";

export function ClientDetailPage() {
  const { id = "" } = useParams();
  const { toast, refreshStats } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const org = usePoll(() => api.org(id), [id]);
  const runs = usePoll(() => api.runs({ orgId: id }), [id], (d) => (d?.some((r) => isRunActive(r.status)) ? 3000 : null));
  const openTickets = usePoll(() => api.tickets({ orgId: id, status: "open" }), [id]);
  const providers = usePoll(() => api.providers(), []);
  const models = usePoll(() => api.models(), []);
  const onboarding = usePoll(() => api.m365Onboarding(), []);
  const pause = usePauseControl(org.data, () => void org.reload());
  const m365 = org.data?.integrations.find((i) => i.provider === "m365");
  const discovery = useDiscovery(m365);
  const [consent, setConsent] = useState<{ ok: boolean; detail: string } | null>(null);

  // Microsoft's admin-consent redirect lands here with ?m365=connected|error&detail=…; show it once, then tidy the URL.
  const consentParam = params.get("m365");
  useEffect(() => {
    if (consentParam !== "connected" && consentParam !== "error") return;
    setConsent({ ok: consentParam === "connected", detail: params.get("detail") ?? "" });
    const next = new URLSearchParams(params);
    next.delete("m365");
    next.delete("detail");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consentParam]);
  const [savingAutonomy, setSavingAutonomy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const connectOpen = params.get("connect") === "1";
  const setConnectOpen = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set("connect", "1");
    else next.delete("connect");
    setParams(next, { replace: true });
  };

  if (org.error instanceof ApiError && org.error.status === 404) {
    return (
      <div className="card">
        <EmptyState title="Client not found" actions={<Link to="/clients" className="btn">Back to clients</Link>}>
          It may have been deleted.
        </EmptyState>
      </div>
    );
  }
  if (!org.data) return org.error ? <ErrorBanner error={org.error} onRetry={org.reload} /> : <Loading />;

  const o = org.data;

  const setAutonomy = async (autonomy: Autonomy) => {
    if (autonomy === o.autonomy) return;
    setSavingAutonomy(true);
    org.mutate((d) => d && { ...d, autonomy });
    try {
      await api.updateOrg(o.id, { autonomy });
      toast(`${o.name} is now ${AUTONOMY_META[autonomy].label}.`);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSavingAutonomy(false);
      void org.reload();
    }
  };

  const deleteOrg = async () => {
    setDeleting(true);
    try {
      await api.deleteOrg(o.id);
      toast(`${o.name} deleted.`);
      refreshStats();
      navigate("/clients");
    } catch (err) {
      toast(errorMessage(err), "error");
      setDeleting(false);
    }
  };

  const connected = new Set(o.integrations.map((i) => i.provider));
  const kindOf = (id: string) => providers.data?.find((p) => p.id === id)?.kind;
  const verifier = o.integrations.find((i) => kindOf(i.provider) === "verification");
  // Every provider is connected, counting a verification method as covering its whole group (one per client).
  const allConnected = providers.data ? providers.data.every((p) => connected.has(p.id) || (p.kind === "verification" && verifier)) : false;

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Link to="/clients">Clients</Link>
            <ChevronRight className="icon-sm" aria-hidden="true" />
            <span className="truncate">{o.name}</span>
          </>
        }
        title={o.name}
        subtitle={
          <span className="row row-wrap" style={{ gap: 12 }}>
            {o.domain && (
              <span className="row" style={{ gap: 5 }}>
                <Globe className="icon-sm" aria-hidden="true" /> {o.domain}
              </span>
            )}
            <span>
              Added <RelativeTime iso={o.created_at} />
            </span>
          </span>
        }
        actions={
          <>
            {!pause.paused && (
              <button className="btn btn-danger-ghost" onClick={pause.askToPause} title="Kill switch: stop Haley acting for this client">
                <OctagonPause className="icon-sm" aria-hidden="true" /> Pause Haley
              </button>
            )}
            <Link to={`/tasks?orgId=${o.id}`} className="btn">
              <Zap className="icon-sm" aria-hidden="true" /> Ask Haley
            </Link>
            <Link to={`/tickets?new=1&orgId=${o.id}`} className="btn btn-primary">
              <Plus className="icon-sm" aria-hidden="true" /> New ticket
            </Link>
          </>
        }
      />

      {pause.paused && <PausedBanner orgName={o.name} onResume={pause.resume} busy={pause.busy} />}
      {consent && <ConsentResultBanner result={consent} onDismiss={() => setConsent(null)} />}

      <nav className="row row-wrap" style={{ marginBottom: 20 }} aria-label="Client records">
        <Link to={`/tickets?orgId=${o.id}`} className="btn btn-sm">
          <TicketIcon className="icon-sm" aria-hidden="true" /> Tickets
          {openTickets.data && <span className="muted num">{openTickets.data.length} open</span>}
        </Link>
        <Link to={`/runs?orgId=${o.id}`} className="btn btn-sm">
          <Inbox className="icon-sm" aria-hidden="true" /> Runs
        </Link>
        <Link to={`/kb?orgId=${o.id}`} className="btn btn-sm">
          <BookOpen className="icon-sm" aria-hidden="true" /> Knowledge base
        </Link>
        <Link to={`/audit?orgId=${o.id}`} className="btn btn-sm">
          <ScrollText className="icon-sm" aria-hidden="true" /> Audit log
        </Link>
        <Link to={`/simulate?orgId=${o.id}`} className="btn btn-sm">
          <MessagesSquare className="icon-sm" aria-hidden="true" /> Try as end user
        </Link>
        <Link to={`/clients/${o.id}/report`} className="btn btn-sm">
          <FileChartColumn className="icon-sm" aria-hidden="true" /> Client report
        </Link>
      </nav>

      <div className="layout-main-side layout-client">
        <div className="stack" style={{ gap: 28 }}>
          <section aria-labelledby="int-title">
            <div className="section-title">
              <h2 id="int-title">Integrations</h2>
              <span className="count">{o.integrations.length}</span>
              <span className="spacer" />
              <button className="btn btn-sm" onClick={() => setConnectOpen(true)} disabled={allConnected}>
                <Plug className="icon-sm" aria-hidden="true" /> Connect
              </button>
            </div>
            {o.integrations.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon={<Plug className="icon" />}
                  title="No tenant connected"
                  compact
                  actions={
                    <button className="btn btn-primary" onClick={() => setConnectOpen(true)}>
                      <Plug className="icon-sm" aria-hidden="true" /> Connect Microsoft 365 or Google Workspace
                    </button>
                  }
                >
                  Without a connection Haley can only work with tickets and the knowledge base. Use a sandbox tenant to try her out safely. Slack
                  can be connected too, so employees can message Haley directly.
                </EmptyState>
              </div>
            ) : (
              <div className="integrations">
                {o.integrations.map((i) => (
                  <IntegrationCard
                    key={i.id}
                    integration={i}
                    kind={kindOf(i.provider)}
                    onChanged={() => void org.reload()}
                    discover={i.id === m365?.id ? { run: discovery.run, running: discovery.running, done: Boolean(discovery.data) } : undefined}
                  />
                ))}
              </div>
            )}
            {!m365 && onboarding.data && (
              <div style={{ marginTop: 10 }}>
                {onboarding.data.mspAppConfigured ? <ConsentConnect org={o} info={onboarding.data} /> : <ConsentUnavailableNote />}
              </div>
            )}
            {providers.data && <VerificationStrip integration={verifier} onConnect={() => setConnectOpen(true)} />}
          </section>

          <section aria-labelledby="aut-title">
            <div className="section-title">
              <h2 id="aut-title">Autonomy</h2>
              {savingAutonomy && <Spinner />}
            </div>
            <div className="card card-pad stack">
              <p className="secondary">
                How much Haley may do on her own for {o.name}. Reading, notes, replies and KB articles never need approval; this controls changes
                to the customer's systems.
              </p>
              <AutonomyPicker value={o.autonomy} onChange={setAutonomy} disabled={savingAutonomy} />
              <Disclosure summary="Approval rules by risk level" defaultOpen={o.autonomy === "unattended"}>
                <PolicyMatrix settings={o.settings} highlight={o.autonomy} />
              </Disclosure>
            </div>
          </section>

          {m365 && discovery.data && (
            <DiscoveryPanel
              org={o}
              discovery={discovery.data}
              running={discovery.running}
              onRerun={() => void discovery.run()}
              onApplied={() => void org.reload()}
            />
          )}

          <PolicyRulesSection org={o} onSaved={() => void org.reload()} />

          <SafetySettingsForm org={o} onSaved={() => void org.reload()} pause={pause} />

          <SchedulesSection orgId={o.id} orgName={o.name} paused={o.settings.paused} />

          <section aria-labelledby="runs-title">
            <div className="section-title">
              <h2 id="runs-title">Recent runs</h2>
              <span className="spacer" />
              <Link to={`/runs?orgId=${o.id}`}>All runs</Link>
            </div>
            <div className="card">
              {runs.data && runs.data.length === 0 ? (
                <EmptyState icon={<Inbox className="icon" />} title="Haley hasn't worked for this client yet" compact>
                  Open a ticket or start a task to get going.
                </EmptyState>
              ) : !runs.data ? (
                <Loading />
              ) : (
                <ul className="list">
                  {runs.data.slice(0, 8).map((r) => (
                    <li key={r.id}>
                      <RunRow run={r} showOrg={false} showModel />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <aside className="stack">
          <ModelPicker org={o} models={models.data} error={models.error} onSaved={() => void org.reload()} />
          <OrgDetailsForm org={o} onSaved={() => void org.reload()} />
          <section className="card card-pad stack-sm">
            <h2 style={{ fontSize: "var(--text-md)" }}>Danger zone</h2>
            <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
              Deleting a client removes its integrations, tickets, runs and client-specific KB articles from Haley. Customer systems are not touched.
            </p>
            <div>
              <button className="btn btn-danger-ghost btn-sm" onClick={() => setConfirmDelete(true)}>
                <Trash className="icon-sm" aria-hidden="true" /> Delete client
              </button>
            </div>
          </section>
        </aside>
      </div>

      <ConnectModal
        open={connectOpen}
        org={o}
        consentAvailable={Boolean(onboarding.data?.mspAppConfigured)}
        onClose={() => setConnectOpen(false)}
        onConnected={() => {
          setConnectOpen(false);
          void org.reload();
          refreshStats();
        }}
      />
      <ConfirmModal
        open={confirmDelete}
        title={`Delete ${o.name}?`}
        confirmLabel="Delete client"
        busy={deleting}
        onConfirm={deleteOrg}
        onClose={() => setConfirmDelete(false)}
      >
        This permanently removes the client and everything Haley stored for it. The audit log keeps a record of the deletion.
      </ConfirmModal>
      {pause.dialog}
    </>
  );
}

function OrgDetailsForm({ org, onSaved }: { org: OrgDetail; onSaved: () => void }) {
  const { toast } = useApp();
  const saved = useMemo(() => ({ name: org.name, domain: org.domain, notes: org.notes }), [org.name, org.domain, org.notes]);
  const { draft: { name, domain, notes }, setDraft, patch, dirty, reset } = useDraft(saved);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return toast("Name can't be empty.", "error");
    setBusy(true);
    try {
      await api.updateOrg(org.id, {
        ...patch,
        ...(patch.name !== undefined ? { name: name.trim() } : {}),
        ...(patch.domain !== undefined ? { domain: domain.trim() } : {}),
      });
      setDraft((d) => ({
        ...d,
        ...(d.name === name ? { name: name.trim() } : {}),
        ...(d.domain === domain ? { domain: domain.trim() } : {}),
      }));
      toast("Client details saved.");
      onSaved();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={save} aria-labelledby="details-title">
      <div className="card-header">
        <h2 id="details-title">Details</h2>
      </div>
      <div className="card-body stack">
        <div className="field">
          <label htmlFor="org-name">Name</label>
          <input id="org-name" className="input" value={name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} required />
        </div>
        <div className="field">
          <label htmlFor="org-domain">Primary domain</label>
          <input id="org-domain" className="input" value={domain} onChange={(e) => setDraft((d) => ({ ...d, domain: e.target.value }))} placeholder="contoso.com" />
        </div>
        <div className="field">
          <label htmlFor="org-notes">Notes for Haley</label>
          <textarea
            id="org-notes"
            className="textarea"
            rows={6}
            value={notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            placeholder="Key contacts, approval rules, office hours…"
          />
          <span className="help">Included in Haley's context on every ticket and task.</span>
        </div>
      </div>
      <div className="card-footer">
        <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {dirty ? "Unsaved changes" : ""}
        </span>
        <span className="spacer" />
        {dirty && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={reset}
          >
            Discard
          </button>
        )}
        <button className="btn btn-primary btn-sm" type="submit" disabled={!dirty || busy}>
          {busy && <Spinner />} Save
        </button>
      </div>
    </form>
  );
}

function IntegrationCard({
  integration: i,
  kind,
  onChanged,
  discover,
}: {
  integration: Integration;
  kind: ProviderInfo["kind"] | undefined;
  onChanged: () => void;
  /** Microsoft 365 only: run a tenant discovery. */
  discover?: { run: () => Promise<void>; running: boolean; done: boolean };
}) {
  const { toast } = useApp();
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  // Slack is how end users reach Haley, and verifiers check who's asking; neither is a set of tools she acts with.
  const isChannel = (kind ?? (i.provider === "slack" ? "channel" : "directory")) === "channel";
  const isVerifier = kind === "verification";

  const test = async () => {
    setTesting(true);
    try {
      const result = await api.testIntegration(i.id);
      if (result.status === "connected") toast(`Connection OK. ${result.status_detail}`);
      else toast(`Connection failed: ${result.status_detail}`, "error");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setTesting(false);
      onChanged();
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await api.removeIntegration(i.id);
      toast(`${i.label} removed.`);
      setConfirmRemove(false);
      onChanged();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <article className="integration" aria-label={i.label}>
      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <ProviderLogo provider={i.provider} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }} className="truncate">
            {i.label}
          </div>
          <div className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {PROVIDER_NAMES[i.provider] ?? i.provider} · added <RelativeTime iso={i.created_at} />
          </div>
        </div>
      </div>
      <div className="row row-wrap">
        <IntegrationStatusPill status={i.status} />
        {isChannel ? (
          <Pill tone="blue">End-user channel</Pill>
        ) : isVerifier ? (
          <>
            <Pill tone="green" title="Haley can verify requesters with this before security-sensitive changes">
              Step-up verification
            </Pill>
            {i.mode === "sandbox" && (
              <Pill tone="violet" title="Codes appear on the ticket timeline instead of being texted">
                Sandbox
              </Pill>
            )}
          </>
        ) : (
          <ModePill mode={i.mode} />
        )}
      </div>
      {i.status_detail && <p className={`status-detail ${i.status === "error" ? "error" : ""}`}>{i.status_detail}</p>}
      <div className="integration-actions">
        <button className="btn btn-sm" onClick={test} disabled={testing}>
          {testing ? <Spinner /> : <RefreshCw className="icon-sm" aria-hidden="true" />} Test
        </button>
        {!isChannel && !isVerifier && (
          <button className="btn btn-sm" onClick={() => setToolsOpen(true)}>
            <Wrench className="icon-sm" aria-hidden="true" /> View tools
          </button>
        )}
        {discover && (
          <button
            className="btn btn-sm"
            onClick={() => void discover.run()}
            disabled={discover.running}
            title="Read the tenant's domains, licenses, devices and admins, and suggest settings"
          >
            {discover.running ? <Spinner /> : <Radar className="icon-sm" aria-hidden="true" />} {discover.done ? "Discover again" : "Discover tenant"}
          </button>
        )}
        <span className="spacer" />
        <button className="btn btn-sm btn-danger-ghost" onClick={() => setConfirmRemove(true)}>
          <Trash className="icon-sm" aria-hidden="true" /> Remove
        </button>
      </div>
      <ToolsModal integration={i} open={toolsOpen} onClose={() => setToolsOpen(false)} />
      <ConfirmModal
        open={confirmRemove}
        title={`Remove ${i.label}?`}
        confirmLabel="Remove integration"
        busy={removing}
        onConfirm={remove}
        onClose={() => setConfirmRemove(false)}
      >
        {isChannel
          ? "Employees will no longer be able to message Haley from this workspace."
          : isVerifier
            ? "Haley will no longer be able to verify requesters herself; security-sensitive requests from weaker identities go to the approval queue."
            : "Haley will lose access to this tenant immediately."}{" "}
        Stored credentials are deleted; you can reconnect at any time.
        {i.mode === "sandbox" && !isVerifier && " The simulated tenant's state is discarded."}
      </ConfirmModal>
    </article>
  );
}

const RISK_ORDER: Risk[] = ["read", "internal", "write", "destructive"];

function ToolsModal({ integration, open, onClose }: { integration: Integration; open: boolean; onClose: () => void }) {
  const [filter, setFilter] = useState<Risk | "">("");
  const tools = usePoll(() => (open ? api.integrationTools(integration.id) : Promise.resolve(undefined)), [open, integration.id]);
  const list = tools.data ?? [];
  const counts = useMemo(() => {
    const c: Partial<Record<Risk, number>> = {};
    for (const t of list) c[t.risk] = (c[t.risk] ?? 0) + 1;
    return c;
  }, [list]);
  const visible = list.filter((t) => !filter || t.risk === filter);

  return (
    <Modal open={open} onClose={onClose} title={`Tools · ${integration.label}`} size="wide">
      <p className="secondary">
        What Haley can do through this connection. Whether a tool runs immediately or waits for approval depends on its risk level and the client's
        autonomy policy.
      </p>
      {tools.error && <ErrorBanner error={tools.error} onRetry={tools.reload} />}
      {!tools.data && !tools.error ? (
        <Loading />
      ) : (
        <>
          <div className="segmented" role="group" aria-label="Filter by risk" style={{ alignSelf: "flex-start", flexWrap: "wrap" }}>
            <button aria-pressed={filter === ""} onClick={() => setFilter("")}>
              All {list.length}
            </button>
            {RISK_ORDER.filter((r) => counts[r]).map((r) => (
              <button key={r} aria-pressed={filter === r} onClick={() => setFilter(r)}>
                {r[0].toUpperCase() + r.slice(1)} {counts[r]}
              </button>
            ))}
          </div>
          <div className="card" style={{ boxShadow: "none" }}>
            <ul className="list">
              {visible.map((t) => (
                <li key={t.name} className="list-row" style={{ alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <code style={{ fontWeight: 560 }}>{t.name}</code>
                    <p className="muted" style={{ fontSize: "var(--text-sm)", marginTop: 2 }}>
                      {t.description}
                    </p>
                  </div>
                  <RiskPill risk={t.risk} />
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </Modal>
  );
}

function ConnectModal({
  open,
  org,
  consentAvailable,
  onClose,
  onConnected,
}: {
  open: boolean;
  org: OrgDetail;
  /** The MSP app is configured, so Microsoft 365 can be connected with admin consent instead. */
  consentAvailable?: boolean;
  onClose: () => void;
  onConnected: (i: Integration) => void;
}) {
  const { toast } = useApp();
  const providers = usePoll(() => (open ? api.providers() : Promise.resolve(undefined)), [open]);
  const taken = new Set(org.integrations.map((i) => i.provider));
  const currentVerifier = org.integrations.find((i) => providers.data?.find((p) => p.id === i.provider)?.kind === "verification");
  // Only one verification method per client (the server answers 409 otherwise).
  const unavailable = (p: ProviderInfo) => taken.has(p.id) || (p.kind === "verification" && Boolean(currentVerifier));
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [mode, setMode] = useState<IntegrationMode>("sandbox");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preselect the first available provider each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfig({});
    setLabel("");
    setMode("sandbox");
    setProvider(null);
  }, [open]);
  useEffect(() => {
    if (open && !provider && providers.data) {
      const first = providers.data.find((p) => !unavailable(p));
      if (first) choose(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providers.data, provider]);

  const info: ProviderInfo | undefined = providers.data?.find((p) => p.id === provider);

  const choose = (p: ProviderInfo) => {
    setProvider(p.id);
    setConfig({});
    setError(null);
    // Providers without a simulated tenant (Slack) can only connect live.
    setMode(p.supportsSandbox ? "sandbox" : "live");
  };

  const groups: Array<{ kind: ProviderInfo["kind"]; title: string; help: string }> = [
    { kind: "directory", title: "Directories (tools for Haley)", help: "Where Haley looks things up and makes changes." },
    { kind: "channel", title: "Channels (how end users reach Haley)", help: "Employees message Haley here; she answers in the same place." },
    {
      kind: "verification",
      title: "Identity verification (step-up MFA)",
      help: "Lets Haley confirm a requester on their own registered device before security-sensitive changes. One method per client.",
    },
  ];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!info) return;
    if (mode === "live") {
      const missing = info.fields.filter((f) => !f.optional && !config[f.key]?.trim()).map((f) => f.label);
      if (missing.length) return setError(`Missing: ${missing.join(", ")}`);
    }
    setBusy(true);
    setError(null);
    try {
      const integration = await api.connectIntegration(org.id, {
        provider: info.id,
        mode,
        label: label.trim() || undefined,
        config: mode === "live" ? config : {},
      });
      if (integration.status === "connected") toast(`${info.name} connected. ${integration.status_detail}`);
      else toast(`${info.name} was added but the connection test failed: ${integration.status_detail}`, "error");
      onConnected(integration);
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
      title={`Connect ${org.name}`}
      size="wide"
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="connect-form" disabled={!info || busy}>
            {busy ? <Spinner /> : <Plug className="icon-sm" aria-hidden="true" />}
            {mode === "sandbox" && info?.supportsSandbox ? (info.kind === "verification" ? "Connect sandbox" : "Create sandbox") : "Connect & test"}
          </button>
        </>
      }
    >
      {providers.error && <ErrorBanner error={providers.error} onRetry={providers.reload} />}
      {!providers.data ? (
        !providers.error && <Loading />
      ) : (
        <form id="connect-form" className="stack" onSubmit={submit}>
          {groups.map((g) => {
            const items = providers.data!.filter((p) => (p.kind ?? "directory") === g.kind);
            if (!items.length) return null;
            return (
              <div className="field" key={g.kind}>
                <span className="field-label">{g.title}</span>
                <span className="help" style={{ marginTop: -3 }}>
                  {g.help}
                </span>
                <div className="choice-grid" role="radiogroup" aria-label={g.title}>
                  {items.map((p) => {
                    const isTaken = unavailable(p);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={provider === p.id}
                        className="choice"
                        disabled={isTaken}
                        style={isTaken ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                        onClick={() => choose(p)}
                      >
                        <span className="choice-title">
                          <ProviderLogo provider={p.id} />
                          {p.name}
                        </span>
                        <span className="choice-desc">
                          {taken.has(p.id)
                            ? "Already connected for this client. Remove it first to reconnect."
                            : isTaken
                              ? `${currentVerifier?.label ?? "Another method"} is this client's verification method. Remove it first to switch.`
                              : p.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {info && (
            <>
              {info.supportsSandbox && (
              <div className="field">
                <span className="field-label">Mode</span>
                <div className="choice-grid" role="radiogroup" aria-label="Mode">
                  <button type="button" role="radio" aria-checked={mode === "sandbox"} className="choice" onClick={() => setMode("sandbox")}>
                    <span className="choice-title">
                      <FlaskConical className="icon-sm" aria-hidden="true" /> Sandbox
                    </span>
                    <span className="choice-desc">
                      {info.kind === "verification"
                        ? "No texts are sent: codes appear on the ticket timeline, so testers can type them back. No credentials needed."
                        : `A simulated ${info.name} tenant with realistic users and data. No credentials needed.`}
                    </span>
                  </button>
                  <button type="button" role="radio" aria-checked={mode === "live"} className="choice" onClick={() => setMode("live")}>
                    <span className="choice-title">
                      <Plug className="icon-sm" aria-hidden="true" /> Live
                    </span>
                    <span className="choice-desc">
                      {info.kind === "verification"
                        ? `Send real codes through your ${info.name.includes("Twilio") ? "Twilio" : info.name} account.`
                        : "Connect the customer's real tenant with an app registration or service account."}
                    </span>
                  </button>
                </div>
              </div>
              )}

              {info.id === "m365" && mode === "live" && consentAvailable && (
                <div className="banner banner-info" role="note">
                  <ShieldCheck className="icon" aria-hidden="true" />
                  <span>
                    <strong>Easier: admin consent.</strong> Close this and use <strong>Connect with admin consent</strong> on the client page. No app
                    registration or secret needed.
                  </span>
                </div>
              )}

              {info.warning && (
                <div className="banner banner-warn" role="note">
                  <TriangleAlert className="icon" aria-hidden="true" />
                  <span>{info.warning}</span>
                </div>
              )}

              <div className="field">
                <span className="field-label">{info.kind === "verification" ? "How it works" : "What Haley can do"}</span>
                <div className="row row-wrap" style={{ gap: 6 }}>
                  {info.capabilities.map((c) => (
                    <span key={c} className="chip">
                      {c}
                    </span>
                  ))}
                </div>
              </div>

              {mode === "sandbox" && info.kind === "verification" ? (
                <div className="banner banner-info">
                  <FlaskConical className="icon" aria-hidden="true" />
                  <span>
                    Sandbox verification is for testing Haley end to end. When she verifies a requester, the "text message" with the code appears on
                    the ticket timeline (and in the <strong>Try as end user</strong> chat) instead of going to a phone. Codes go to the number on the
                    user's directory account, so connect a Microsoft 365 or Google sandbox too.
                  </span>
                </div>
              ) : mode === "sandbox" ? (
                <div className="banner banner-info">
                  <FlaskConical className="icon" aria-hidden="true" />
                  <span>
                    Sandbox mode is for trying Haley safely. She works against a simulated tenant
                    {org.domain ? (
                      <>
                        {" "}
                        on <strong>{org.domain}</strong>
                      </>
                    ) : null}{" "}
                    that behaves like {info.name}: lookups, password resets, license and group changes all "work", but nothing real is touched.
                    Approvals and the audit log behave exactly as they would live.
                  </span>
                </div>
              ) : (
                <div className="grid-2" style={{ alignItems: "start" }}>
                  <div className="stack-sm">
                    <span className="field-label">
                      {info.kind === "channel" ? `Setup in ${org.name}'s ${info.name}` : info.kind === "verification" ? "Setup" : "Setup in the customer's tenant"}
                    </span>
                    <ol className="steps">
                      {info.setupSteps.map((s, n) => (
                        <li key={n}>
                          <span>{s}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="stack">
                    {info.fields.map((f) => (
                      <div className="field" key={f.key}>
                        <label htmlFor={`cf-${f.key}`}>
                          {f.label} {f.optional && <span className="muted">(optional)</span>}
                        </label>
                        {f.multiline ? (
                          <textarea
                            id={`cf-${f.key}`}
                            className={`textarea mono ${f.secret ? "masked" : ""}`}
                            rows={6}
                            placeholder={f.placeholder}
                            value={config[f.key] ?? ""}
                            onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                            spellCheck={false}
                            autoComplete="off"
                          />
                        ) : (
                          <input
                            id={`cf-${f.key}`}
                            className={`input ${f.secret ? "" : "mono"}`}
                            type={f.secret ? "password" : "text"}
                            placeholder={f.placeholder}
                            value={config[f.key] ?? ""}
                            onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                            spellCheck={false}
                            autoComplete={f.secret ? "new-password" : "off"}
                          />
                        )}
                        {f.help && <span className="help">{f.help}</span>}
                        {f.secret && <span className="help">Encrypted at rest; never shown again.</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="field">
                <label htmlFor="cf-label">
                  Label <span className="muted">(optional)</span>
                </label>
                <input
                  id="cf-label"
                  className="input"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={`${org.name} ${info.name}${mode === "sandbox" ? " (sandbox)" : ""}`}
                />
              </div>
            </>
          )}
          {providers.data.every((p) => unavailable(p)) && (
            <div className="banner banner-success">
              <CircleCheck className="icon" aria-hidden="true" />
              <span>Every supported provider is already connected for this client.</span>
            </div>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}

/** Which step-up verification method the client has, or a nudge to add one. */
function VerificationStrip({ integration, onConnect }: { integration: Integration | undefined; onConnect: () => void }) {
  if (!integration) {
    return (
      <div className="verify-strip">
        <ShieldCheck className="icon-sm muted" aria-hidden="true" />
        <span className="spacer">
          <strong>No step-up verification.</strong> Connect Duo, Okta Verify or SMS codes so Haley can confirm who's asking before a password reset
          instead of sending it to the approval queue.
        </span>
        <button className="btn btn-sm" onClick={onConnect}>
          <Plug className="icon-sm" aria-hidden="true" /> Add
        </button>
      </div>
    );
  }
  const name = PROVIDER_NAMES[integration.provider] ?? integration.provider;
  return (
    <div className={`verify-strip is-on ${integration.status === "error" ? "is-error" : ""}`}>
      <ShieldCheck className="icon-sm" aria-hidden="true" />
      <span className="spacer">
        <strong>Step-up verification: {name}</strong>
        {integration.mode === "sandbox" ? " (sandbox: codes appear on the ticket timeline)" : ""}.{" "}
        {integration.status === "error"
          ? "The last connection test failed, so verification requests will fail."
          : `Haley can verify requesters on their own device; a verified requester counts as MFA verified for 30 minutes.`}
      </span>
    </div>
  );
}

/** Which AI model works this client's tickets: the workspace default or a pinned profile. */
function ModelPicker({
  org,
  models,
  error,
  onSaved,
}: {
  org: OrgDetail;
  models: ModelProfileListItem[] | undefined;
  error: Error | undefined;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const current = org.settings.modelProfileId ?? "";
  const def = models?.find((m) => m.is_default);
  const pinned = models?.find((m) => m.id === current);
  const effective = pinned ?? def;
  const missing = Boolean(current && models && !pinned);

  const change = async (value: string) => {
    setBusy(true);
    try {
      await api.updateOrg(org.id, { settings: { modelProfileId: value } });
      const name = value ? models?.find((m) => m.id === value)?.name : `the workspace default${def ? ` (${def.name})` : ""}`;
      toast(`${org.name} now uses ${name}.`);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
      onSaved();
    }
  };

  return (
    <section className="card" aria-labelledby="model-title">
      <div className="card-header">
        <BrainCircuit className="icon-sm" style={{ color: "var(--tone-violet-fg)" }} aria-hidden="true" />
        <h2 id="model-title">AI model</h2>
        {busy && <Spinner />}
        <span className="spacer" />
        <Link to="/models" style={{ fontSize: "var(--text-sm)" }}>
          Manage models
        </Link>
      </div>
      <div className="card-body stack-sm">
        {error && !models ? (
          <p className="error-text">{error.message}</p>
        ) : (
          <>
            <label htmlFor="org-model" className="sr-only">
              AI model for {org.name}
            </label>
            <select id="org-model" className="select" value={missing ? "" : current} onChange={(e) => void change(e.target.value)} disabled={!models || busy}>
              <option value="">Workspace default{def ? ` (${def.name})` : ""}</option>
              {(models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            {effective && (
              <span className="muted mono truncate" style={{ fontSize: "var(--text-sm)" }} title={`${effective.provider}/${effective.model}`}>
                {effective.provider}/{effective.model}
              </span>
            )}
            <span className="help" style={{ fontSize: "var(--text-sm)", color: "var(--text-3)" }}>
              The model only proposes; {org.name}'s autonomy policy decides what runs, whichever model you pick.
            </span>
          </>
        )}
      </div>
    </section>
  );
}
