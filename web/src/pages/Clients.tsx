import { Building, Plus, Ticket as TicketIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, errorMessage, type Autonomy } from "../api";
import { AutonomyPicker } from "../components/AutonomyPicker";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { AutonomyPill } from "../components/Pill";
import { ProviderLogo } from "../components/ProviderLogo";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { INTEGRATION_STATUS_META, PROVIDER_NAMES } from "../lib/format";

export function ClientsPage() {
  const orgs = usePoll(() => api.orgs(), []);
  const [params, setParams] = useSearchParams();
  const creating = params.get("new") === "1";
  const setCreating = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set("new", "1");
    else next.delete("new");
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Clients"
        subtitle="Each client organization has its own connected tenants, autonomy policy and knowledge base."
        actions={
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus className="icon-sm" aria-hidden="true" /> Add client
          </button>
        }
      />
      {orgs.error && <ErrorBanner error={orgs.error} onRetry={orgs.reload} />}
      {orgs.loading && !orgs.data ? (
        <Loading />
      ) : orgs.data && orgs.data.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Building className="icon" />}
            title="No clients yet"
            actions={
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                <Plus className="icon-sm" aria-hidden="true" /> Add your first client
              </button>
            }
          >
            Add a client organization, then connect its Microsoft 365 or Google Workspace so Haley can work its tickets.
          </EmptyState>
        </div>
      ) : (
        <div className="org-grid">
          {orgs.data?.map((o) => (
            <Link key={o.id} to={`/clients/${o.id}`} className="org-card">
              <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
                <span className="org-initial" aria-hidden="true">
                  {o.name.slice(0, 1).toUpperCase()}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="org-name truncate">{o.name}</div>
                  <div className="muted truncate" style={{ fontSize: "var(--text-sm)" }}>
                    {o.domain || "No domain set"}
                  </div>
                </div>
                <AutonomyPill autonomy={o.autonomy} />
              </div>
              <div className="stack-sm">
                {o.integrations.length === 0 ? (
                  <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                    No integrations connected
                  </span>
                ) : (
                  o.integrations.map((i) => (
                    <span key={i.id} className="row" style={{ gap: 8, fontSize: "var(--text-sm)" }}>
                      <ProviderLogo provider={i.provider} />
                      <span className="truncate secondary" style={{ flex: 1 }}>
                        {PROVIDER_NAMES[i.provider] ?? i.provider}
                        {i.mode === "sandbox" && <span className="muted"> · sandbox</span>}
                      </span>
                      <span className={`pill pill-dot tone-${INTEGRATION_STATUS_META[i.status].tone}`}>{INTEGRATION_STATUS_META[i.status].label}</span>
                    </span>
                  ))
                )}
              </div>
              <div className="org-card-foot">
                <span className="row" style={{ gap: 5 }}>
                  <TicketIcon className="icon-sm" aria-hidden="true" />
                  <strong className="num" style={{ color: "var(--text-2)" }}>
                    {o.openTickets}
                  </strong>{" "}
                  open ticket{o.openTickets === 1 ? "" : "s"}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <NewClientModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function NewClientModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, refreshStats } = useApp();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [autonomy, setAutonomy] = useState<Autonomy>("supervised");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Name is required.");
    setBusy(true);
    setError(null);
    try {
      const org = await api.createOrg({ name: name.trim(), domain: domain.trim(), autonomy, notes });
      toast(`${org.name} added. Connect a tenant next.`);
      refreshStats();
      navigate(`/clients/${org.id}?connect=1`);
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
      title="Add client"
      size="wide"
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="new-client-form" disabled={busy}>
            {busy && <Spinner />} Create client
          </button>
        </>
      }
    >
      <form id="new-client-form" className="stack" onSubmit={submit}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="nc-name">Name</label>
            <input id="nc-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Contoso Ltd" autoFocus required />
          </div>
          <div className="field">
            <label htmlFor="nc-domain">Primary domain</label>
            <input id="nc-domain" className="input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="contoso.com" />
            <span className="help">Inbound email from this domain is routed to this client.</span>
          </div>
        </div>
        <div className="field">
          <span className="field-label" id="nc-autonomy">
            Autonomy
          </span>
          <AutonomyPicker value={autonomy} onChange={setAutonomy} />
        </div>
        <div className="field">
          <label htmlFor="nc-notes">Notes for Haley</label>
          <textarea
            id="nc-notes"
            className="textarea"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Key contacts, who can approve what, office hours, sensitive groups…"
          />
          <span className="help">Haley reads these on every ticket and task for this client.</span>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
