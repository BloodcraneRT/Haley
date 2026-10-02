import { BookOpen, ChevronRight, History, Siren } from "lucide-react";
import { Link } from "react-router-dom";
import { api, type Incident } from "../api";
import { usePoll } from "../hooks/usePoll";
import { Spinner } from "./Feedback";
import { TicketStatusPill } from "./Pill";
import { RelativeTime } from "./RelativeTime";

/** Open likely outages, as banners linking to each incident (Tickets page, dashboard). */
export function OpenIncidentsBanner({ orgId }: { orgId?: string }) {
  const incidents = usePoll(() => api.incidents({ status: "open", orgId }), [orgId], 30_000);
  const list = incidents.data ?? [];
  if (!list.length) return null;
  return (
    <div className="incident-banners">
      {list.map((i) => (
        <IncidentBanner key={i.id} incident={i} />
      ))}
    </div>
  );
}

export function IncidentBanner({ incident: i, compact }: { incident: Incident; compact?: boolean }) {
  return (
    <Link to={`/incidents/${i.id}`} className={`incident-banner ${compact ? "is-compact" : ""}`}>
      <Siren className="icon-sm" aria-hidden="true" />
      <span className="incident-banner-text">
        <strong>{i.status === "open" ? "Possible outage" : i.status === "resolved" ? "Resolved incident" : "Dismissed incident"}</strong>
        {i.org_name ? ` at ${i.org_name}` : ""}: {i.title}
        <span className="muted">
          {" "}
          · {i.ticketCount} ticket{i.ticketCount === 1 ? "" : "s"} from {i.people} {i.people === 1 ? "person" : "people"}, latest <RelativeTime iso={i.lastTicketAt} />
        </span>
      </span>
      <ChevronRight className="icon-sm" aria-hidden="true" />
    </Link>
  );
}

/** On a ticket: the incident it's part of, if any. */
export function TicketIncidentBanner({ incidentId }: { incidentId: string }) {
  const detail = usePoll(() => api.incident(incidentId), [incidentId]);
  if (!detail.data) return null;
  return <IncidentBanner incident={detail.data.incident} compact />;
}

/** Past tickets like this one and matching knowledge base articles (ticket sidebar). */
export function SimilarTicketsCard({ ticketId }: { ticketId: string }) {
  const similar = usePoll(() => api.similarTickets(ticketId), [ticketId]);
  const s = similar.data;
  if (s && !s.tickets.length && !s.articles.length) return null;
  return (
    <section className="card similar-tickets" aria-labelledby="similar-title">
      <div className="card-header">
        <History className="icon-sm muted" aria-hidden="true" />
        <h2 id="similar-title">Similar tickets</h2>
        <span className="spacer" />
        {similar.loading && !s && <Spinner />}
      </div>
      {s && (
        <div className="card-body stack-sm">
          {s.tickets.length > 0 && (
            <ul className="similar-list">
              {s.tickets.map((t) => (
                <li key={t.id}>
                  <div className="similar-head">
                    <Link to={`/tickets/${t.id}`}>
                      #{t.number} {t.title}
                    </Link>
                    <TicketStatusPill status={t.status} />
                  </div>
                  {t.resolution ? (
                    <p className="similar-resolution">{t.resolution}</p>
                  ) : (
                    <p className="muted similar-resolution">
                      Opened <RelativeTime iso={t.created_at} />
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {s.articles.length > 0 && (
            <div>
              <h3 className="similar-subhead">Knowledge base</h3>
              <ul className="similar-articles">
                {s.articles.map((a) => (
                  <li key={a.id}>
                    <BookOpen className="icon-xs muted" aria-hidden="true" />
                    <Link to={`/kb/${a.id}`}>{a.title}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
