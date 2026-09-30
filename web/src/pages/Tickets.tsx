import { Plus, Search, Sparkles, Ticket as TicketIcon, TimerOff } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, errorMessage, TICKET_PRIORITIES, TICKET_STATUSES, type OrgSummary, type TicketPriority } from "../api";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { OrgSelect } from "../components/OrgSelect";
import { PageHeader } from "../components/PageHeader";
import { ChannelBadge, IdentityBadge, Priority, psaRef, psaShortRef, SlaIndicator, TicketStatusPill } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { usePoll } from "../hooks/usePoll";
import { useDebouncedQuery } from "../hooks/useDebouncedQuery";
import { aiReady, useApp } from "../lib/app-context";
import { PRIORITY_META, TICKET_STATUS_META } from "../lib/format";

export function TicketsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const orgId = params.get("orgId") ?? "";
  const status = params.get("status") ?? "open";
  const q = params.get("q") ?? "";
  const slaBreached = params.get("sla") === "breached";
  const creating = params.get("new") === "1";

  const orgs = usePoll(() => api.orgs(), []);
  const tickets = usePoll(
    () => api.tickets({ orgId: orgId || undefined, status: status === "all" ? undefined : status, search: q || undefined }),
    [orgId, status, q],
    10_000,
  );

  const update = (key: string, value: string | null) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  };
  const [search, setSearch] = useDebouncedQuery(q, (value) => update("q", value));

  const all = tickets.data ?? [];
  const list = slaBreached ? all.filter((t) => t.sla && (t.sla.response === "breached" || t.sla.resolution === "breached")) : all;
  const filtered = Boolean(orgId || q || status !== "open" || slaBreached);
  const noOrgs = orgs.data?.length === 0;

  return (
    <>
      <PageHeader
        title="Tickets"
        subtitle="Requests from your clients. Haley can work any of them; you stay in the loop through approvals and the timeline."
        actions={
          <button className="btn btn-primary" onClick={() => update("new", "1")} disabled={noOrgs}>
            <Plus className="icon-sm" aria-hidden="true" /> New ticket
          </button>
        }
      />

      <div className="toolbar" role="search">
        <div className="input-with-icon">
          <Search className="icon" aria-hidden="true" />
          <label htmlFor="t-search" className="sr-only">
            Search tickets
          </label>
          <input
            id="t-search"
            className="input"
            placeholder="Search title, description, requester or #number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label htmlFor="t-org" className="sr-only">
          Client
        </label>
        <OrgSelect id="t-org" orgs={orgs.data ?? []} value={orgId} onChange={(v) => update("orgId", v)} allLabel="All clients" />
        <label htmlFor="t-status" className="sr-only">
          Status
        </label>
        <select id="t-status" className="select" value={status} onChange={(e) => update("status", e.target.value === "open" ? null : e.target.value)}>
          <option value="all">All statuses</option>
          <option value="open">Open (not resolved/closed)</option>
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TICKET_STATUS_META[s].label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`btn btn-sm toggle-btn ${slaBreached ? "is-on" : ""}`}
          aria-pressed={slaBreached}
          onClick={() => update("sla", slaBreached ? null : "breached")}
          title="Only tickets past their response or resolution target"
        >
          <TimerOff className="icon-sm" aria-hidden="true" /> SLA breached
        </button>
        {filtered && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setSearch("");
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            Clear filters
          </button>
        )}
        <span className="spacer" />
        {tickets.data && (
          <span className="muted num" style={{ fontSize: "var(--text-sm)" }}>
            {list.length} ticket{list.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {tickets.error && <ErrorBanner error={tickets.error} onRetry={tickets.reload} />}

      <div className="card">
        {tickets.loading && !tickets.data ? (
          <Loading />
        ) : list.length === 0 ? (
          noOrgs ? (
            <EmptyState
              icon={<TicketIcon className="icon" />}
              title="Add a client first"
              actions={
                <Link to="/clients?new=1" className="btn btn-primary">
                  Add client
                </Link>
              }
            >
              Tickets belong to a client organization. Add one (or load the demo workspace from the dashboard) to get started.
            </EmptyState>
          ) : slaBreached && all.length > 0 ? (
            <EmptyState icon={<TimerOff className="icon" />} title="No SLA breaches" compact>
              None of the {all.length} ticket{all.length === 1 ? "" : "s"} matching the other filters is past its response or resolution target.
            </EmptyState>
          ) : filtered ? (
            <EmptyState icon={<Search className="icon" />} title="No tickets match" compact>
              Try a different search or status, or clear the filters.
            </EmptyState>
          ) : (
            <EmptyState
              icon={<TicketIcon className="icon" />}
              title="No open tickets"
              actions={
                <button className="btn btn-primary" onClick={() => update("new", "1")}>
                  <Plus className="icon-sm" aria-hidden="true" /> New ticket
                </button>
              }
            >
              Nice. Create one by hand, connect an end-user <Link to="/channels">channel</Link> (email, Slack, Teams), or post to{" "}
              <code>POST /api/intake</code> from your PSA so requests arrive automatically.
            </EmptyState>
          )
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" className="col-num">
                    #
                  </th>
                  <th scope="col">Title</th>
                  <th scope="col" className="hide-sm">
                    Client
                  </th>
                  <th scope="col" className="hide-md">
                    Requester
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col" className="hide-sm">
                    SLA
                  </th>
                  <th scope="col" className="hide-sm">
                    Priority
                  </th>
                  <th scope="col" className="hide-lg">
                    Category
                  </th>
                  <th scope="col" className="hide-sm">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id} className="clickable" onClick={(e) => !(e.target as HTMLElement).closest("a") && navigate(`/tickets/${t.id}`)}>
                    <td className="col-num">{t.number}</td>
                    <td className="cell-title">
                      <div className="row title-cell" style={{ gap: 8 }}>
                        <ChannelBadge channel={t.channel} iconOnly externalNumber={psaRef(t) ? t.channel_ref.externalNumber : undefined} />
                        <Link to={`/tickets/${t.id}`} className="truncate" style={{ display: "block" }} title={t.title}>
                          {t.title}
                        </Link>
                        {psaRef(t) && (
                          <span className="psa-ref" title={psaRef(t) ?? undefined}>
                            {psaShortRef(t)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="hide-sm nowrap secondary">{t.org_name}</td>
                    <td className="hide-md">
                      <span className="row" style={{ gap: 6, maxWidth: 240 }}>
                        <span className="truncate" title={t.requester_email}>
                          {t.requester_name || t.requester_email || <span className="muted">—</span>}
                        </span>
                        {t.assurance && <IdentityBadge ticket={t} short />}
                      </span>
                    </td>
                    <td>
                      <TicketStatusPill status={t.status} />
                    </td>
                    <td className="hide-sm">
                      <SlaIndicator sla={t.sla} resolved={t.status === "resolved" || t.status === "closed"} />
                    </td>
                    <td className="hide-sm">
                      <Priority priority={t.priority} />
                    </td>
                    <td className="hide-lg secondary">{t.category && t.category !== "uncategorized" ? t.category : <span className="muted">—</span>}</td>
                    <td className="hide-sm muted">
                      <RelativeTime iso={t.updated_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <NewTicketModal open={creating} orgs={orgs.data ?? []} defaultOrgId={orgId} onClose={() => update("new", null)} />
    </>
  );
}

function NewTicketModal({ open, orgs, defaultOrgId, onClose }: { open: boolean; orgs: OrgSummary[]; defaultOrgId: string; onClose: () => void }) {
  const { toast, refreshStats, health } = useApp();
  const navigate = useNavigate();
  const [orgId, setOrgId] = useState(defaultOrgId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [requesterName, setRequesterName] = useState("");
  const [requesterEmail, setRequesterEmail] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [autoRun, setAutoRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setOrgId(defaultOrgId || (orgs.length === 1 ? orgs[0].id : ""));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!orgId) return setError("Choose a client.");
    if (!title.trim()) return setError("Give the ticket a title.");
    setBusy(true);
    setError(null);
    try {
      const ticket = await api.createTicket({ orgId, title: title.trim(), description, requesterName, requesterEmail, priority, autoRun });
      toast(ticket.runId ? `Ticket #${ticket.number} created. Haley is on it.` : `Ticket #${ticket.number} created.`);
      refreshStats();
      setTitle("");
      setDescription("");
      setRequesterName("");
      setRequesterEmail("");
      setPriority("normal");
      navigate(`/tickets/${ticket.id}`);
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
      title="New ticket"
      size="wide"
      footer={
        <>
          <label className="checkbox" style={{ marginRight: "auto" }}>
            <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
            <Sparkles className="icon-sm" aria-hidden="true" style={{ color: "var(--tone-violet-fg)" }} />
            Let Haley work it now
          </label>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="new-ticket-form" disabled={busy}>
            {busy && <Spinner />} Create ticket
          </button>
        </>
      }
    >
      <form id="new-ticket-form" className="stack" onSubmit={submit}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="nt-org">Client</label>
            <OrgSelect id="nt-org" orgs={orgs} value={orgId} onChange={setOrgId} required />
          </div>
          <div className="field">
            <label htmlFor="nt-priority">Priority</label>
            <select id="nt-priority" className="select" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_META[p].label}
                </option>
              ))}
            </select>
          </div>
          <div className="field span-2">
            <label htmlFor="nt-title">Title</label>
            <input id="nt-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="User can't sign in to Outlook" required />
          </div>
          <div className="field span-2">
            <label htmlFor="nt-desc">Description</label>
            <textarea
              id="nt-desc"
              className="textarea"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What the requester said, who's affected, anything already tried…"
            />
          </div>
          <div className="field">
            <label htmlFor="nt-rname">Requester name</label>
            <input id="nt-rname" className="input" value={requesterName} onChange={(e) => setRequesterName(e.target.value)} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="nt-remail">Requester email</label>
            <input id="nt-remail" className="input" type="email" value={requesterEmail} onChange={(e) => setRequesterEmail(e.target.value)} autoComplete="off" />
          </div>
        </div>
        {autoRun && !aiReady(health) && (
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            Note: Haley's AI model has no credentials, so her run will fail right away. The ticket is still created.
          </p>
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
