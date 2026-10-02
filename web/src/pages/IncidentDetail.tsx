import { CheckCheck, ChevronRight, Send, Siren, X } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, errorMessage } from "../api";
import { EmptyState, ErrorBanner, Loading } from "../components/Feedback";
import { ConfirmModal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { ChannelBadge, Pill, TicketStatusPill } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";

const STATUS = { open: { label: "Possible outage", tone: "amber" }, resolved: { label: "Resolved", tone: "green" }, dismissed: { label: "Dismissed", tone: "neutral" } } as const;

/** One shared problem: who's affected, and updating or resolving everyone at once. */
export function IncidentDetailPage() {
  const { id = "" } = useParams();
  const { toast, refreshStats } = useApp();
  const detail = usePoll(() => api.incident(id), [id], 20_000);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"message" | "resolve" | "dismiss" | null>(null);
  const [confirm, setConfirm] = useState<"resolve" | "dismiss" | null>(null);

  if (detail.error instanceof ApiError && detail.error.status === 404) {
    return (
      <div className="card">
        <EmptyState title="Incident not found" actions={<Link to="/tickets" className="btn">Back to tickets</Link>}>
          It may have been removed.
        </EmptyState>
      </div>
    );
  }
  if (!detail.data) return detail.error ? <ErrorBanner error={detail.error} onRetry={detail.reload} /> : <Loading />;
  const { incident: i, tickets } = detail.data;
  const open = tickets.filter((t) => t.status !== "resolved" && t.status !== "closed");

  const act = async (kind: NonNullable<typeof busy>, work: () => Promise<string>) => {
    setBusy(kind);
    try {
      toast(await work());
      setConfirm(null);
      refreshStats();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
      void detail.reload();
    }
  };

  const sendAll = () =>
    act("message", async () => {
      const r = await api.messageIncident(i.id, message.trim());
      setMessage("");
      return r.notDelivered.length
        ? `Sent to ${r.sent} tickets; ${r.notDelivered.length} couldn't be delivered automatically and are recorded on the ticket.`
        : `Sent to all ${r.sent} affected people.`;
    });

  return (
    <>
      <PageHeader
        docTitle={i.title}
        breadcrumb={
          <>
            <Link to="/tickets">Tickets</Link>
            <ChevronRight className="icon-sm" aria-hidden="true" />
            <span>Incident</span>
          </>
        }
        title={
          <span className="row" style={{ gap: 8 }}>
            <Siren className="icon" aria-hidden="true" style={{ color: i.status === "open" ? "var(--tone-amber-fg)" : undefined }} />
            {i.title}
          </span>
        }
        subtitle={
          <span className="row row-wrap" style={{ gap: 8 }}>
            <Pill tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Pill>
            <span>
              {i.org_name} · {i.ticketCount} tickets from {i.people} {i.people === 1 ? "person" : "people"} · {i.created_by === "haley" ? "detected by Haley" : `created by ${i.created_by}`}{" "}
              <RelativeTime iso={i.created_at} />
            </span>
          </span>
        }
        actions={
          i.status === "open" && (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => setConfirm("dismiss")} disabled={busy !== null}>
                <X className="icon-sm" aria-hidden="true" /> Not an outage
              </button>
              <button className="btn btn-primary" onClick={() => setConfirm("resolve")} disabled={busy !== null || open.length === 0}>
                <CheckCheck className="icon-sm" aria-hidden="true" /> Resolve all
              </button>
            </div>
          )
        }
      />

      <div className="stack">
        {i.status === "open" && (
          <section className="card" aria-labelledby="broadcast-title">
            <div className="card-header">
              <h2 id="broadcast-title">Update everyone affected</h2>
              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                {open.length} open ticket{open.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="card-body stack-sm">
              <textarea
                className="input"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="We're aware Outlook isn't connecting for several people and are working on it. We'll update you as soon as it's fixed."
                aria-label="Message to everyone affected"
              />
              <div className="row" style={{ gap: 8 }}>
                <span className="help" style={{ flex: 1 }}>
                  Each person gets it on the channel they used (email, Teams, Slack, chat or the PSA), and it's recorded on their ticket.
                </span>
                <button className="btn btn-primary btn-sm" onClick={() => void sendAll()} disabled={busy !== null || message.trim().length < 2 || open.length === 0}>
                  <Send className="icon-sm" aria-hidden="true" /> Send to {open.length}
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="card" aria-labelledby="affected-title">
          <div className="card-header">
            <h2 id="affected-title">Tickets</h2>
            <span className="count">{tickets.length}</span>
          </div>
          {tickets.length === 0 ? (
            <EmptyState title="No tickets" compact>
              Tickets were unlinked when this was dismissed.
            </EmptyState>
          ) : (
            <ul className="list">
              {tickets.map((t) => (
                <li key={t.id} className="list-row">
                  <Link to={`/tickets/${t.id}`} className="incident-ticket">
                    <span className="ticket-number">#{t.number}</span> {t.title}
                    <span className="muted"> · {t.requester_name || t.requester_email || "Unknown"}</span>
                  </Link>
                  <span className="spacer" />
                  {t.channel && <ChannelBadge channel={t.channel} iconOnly />}
                  <TicketStatusPill status={t.status} />
                  <span className="muted nowrap" style={{ fontSize: "var(--text-sm)" }}>
                    <RelativeTime iso={t.created_at} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ConfirmModal
        open={confirm === "resolve"}
        title={`Resolve all ${open.length} tickets?`}
        confirmLabel="Resolve all"
        busy={busy === "resolve"}
        onClose={() => setConfirm(null)}
        onConfirm={() =>
          void act("resolve", async () => {
            const r = await api.resolveIncident(i.id, message.trim());
            setMessage("");
            return `Resolved ${r.resolvedTickets} tickets${r.message ? " and sent your message" : ""}.`;
          })
        }
      >
        {message.trim()
          ? "Your message above goes to everyone affected, then their tickets are resolved."
          : "Their tickets are resolved without a message. Type a message above first if you want to tell them it's fixed."}
      </ConfirmModal>
      <ConfirmModal
        open={confirm === "dismiss"}
        title="Not a shared problem?"
        confirmLabel="Dismiss"
        busy={busy === "dismiss"}
        onClose={() => setConfirm(null)}
        onConfirm={() => void act("dismiss", async () => (await api.dismissIncident(i.id), "Dismissed. The tickets are handled one by one again."))}
      >
        The tickets are unlinked and handled individually. Nothing is sent to anyone.
      </ConfirmModal>
    </>
  );
}
