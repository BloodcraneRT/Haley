import { CircleAlert, Info, Laptop, Link2, RefreshCw, ShieldCheck, ShieldOff, UserRound } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../api";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { Spinner } from "./Feedback";
import { Pill, TicketStatusPill } from "./Pill";
import { RelativeTime } from "./RelativeTime";

/**
 * The requester at a glance: their directory account, MFA, licenses and groups, their devices and any
 * problems with them, and their recent tickets. Read live from the client's connected systems.
 */
export function RequesterSnapshotCard({ ticketId }: { ticketId: string }) {
  const snap = usePoll(() => api.requesterSnapshot(ticketId), [ticketId]);
  const s = snap.data;
  const account = s?.account;
  return (
    <section className="card requester-snapshot" aria-labelledby="snapshot-title">
      <div className="card-header">
        <UserRound className="icon-sm muted" aria-hidden="true" />
        <h2 id="snapshot-title">Requester</h2>
        <span className="spacer" />
        <StatusLinkButton ticketId={ticketId} />
        {snap.loading ? (
          <Spinner />
        ) : (
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => void snap.reload()} aria-label="Refresh requester details" title="Refresh">
            <RefreshCw className="icon-sm" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="card-body stack-sm">
        {snap.error && !s && <p className="error-text">{errorMessage(snap.error)}</p>}
        {!s && !snap.error && <p className="muted snapshot-loading">Looking them up in the client's systems…</p>}
        {s && (
          <>
            {s.flags.length > 0 && (
              <ul className="snapshot-flags">
                {s.flags.map((f) => (
                  <li key={f.text} className={`snapshot-flag is-${f.level}`}>
                    {f.level === "warning" ? <CircleAlert className="icon-xs" aria-hidden="true" /> : <Info className="icon-xs" aria-hidden="true" />}
                    {f.text}
                  </li>
                ))}
              </ul>
            )}

            {account ? (
              <dl className="snapshot-facts">
                <dt>Account</dt>
                <dd>
                  <span className="snapshot-name">{account.name}</span>{" "}
                  <Pill tone={account.enabled ? "green" : "red"}>{account.enabled ? "Active" : account.source === "Google Workspace" ? "Suspended" : "Blocked"}</Pill>
                  <div className="muted">
                    {[account.title, account.department].filter(Boolean).join(" · ") || account.source}
                  </div>
                </dd>
                <dt>MFA</dt>
                <dd>
                  {account.mfaMethods === null ? (
                    <span className="muted">Couldn't read</span>
                  ) : account.mfaMethods.some((m) => m !== "Password") ? (
                    <span className="snapshot-mfa">
                      <ShieldCheck className="icon-xs" aria-hidden="true" /> {account.mfaMethods.filter((m) => m !== "Password").join(", ")}
                    </span>
                  ) : (
                    <span className="snapshot-mfa is-missing">
                      <ShieldOff className="icon-xs" aria-hidden="true" /> None registered
                    </span>
                  )}
                </dd>
                {account.licenses.length > 0 && (
                  <>
                    <dt>Licenses</dt>
                    <dd>{account.licenses.join(", ")}</dd>
                  </>
                )}
                {account.groups.length > 0 && (
                  <>
                    <dt>Groups</dt>
                    <dd title={account.groups.join(", ")}>
                      {account.groups.slice(0, 6).join(", ")}
                      {account.groups.length > 6 ? ` +${account.groups.length - 6} more` : ""}
                    </dd>
                  </>
                )}
                {account.lastSignIn && (
                  <>
                    <dt>Last sign-in</dt>
                    <dd>
                      <RelativeTime iso={account.lastSignIn} />
                    </dd>
                  </>
                )}
              </dl>
            ) : (
              s.email && !s.unavailable.length && !s.flags.length && <p className="muted">No directory connected for this client.</p>
            )}

            {s.devices.length > 0 && (
              <div className="snapshot-section">
                <h3>Devices</h3>
                <ul className="snapshot-devices">
                  {s.devices.map((d) => (
                    <li key={`${d.source}:${d.id}`}>
                      <Laptop className="icon-xs muted" aria-hidden="true" />
                      <div style={{ minWidth: 0 }}>
                        <div className="snapshot-device-name">
                          {d.name} <span className="muted">· {d.source}</span>
                        </div>
                        <div className="muted">
                          {d.os}
                          {d.lastSeen && (
                            <>
                              {d.os ? " · " : ""}seen <RelativeTime iso={d.lastSeen} />
                            </>
                          )}
                        </div>
                        {d.issues.length > 0 && <div className="snapshot-device-issues">{d.issues.join(" · ")}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {s.recentTickets.length > 0 && (
              <div className="snapshot-section">
                <h3>Recent tickets</h3>
                <ul className="snapshot-tickets">
                  {s.recentTickets.map((t) => (
                    <li key={t.id}>
                      <Link to={`/tickets/${t.id}`}>
                        #{t.number} {t.title}
                      </Link>
                      <TicketStatusPill status={t.status} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {s.unavailable.length > 0 && (
              <p className="muted snapshot-unavailable">
                Couldn't reach {s.unavailable.map((u) => u.source).join(", ")}.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Copies the requester's private status page link (signed, expires in 60 days) to share on any channel. */
function StatusLinkButton({ ticketId }: { ticketId: string }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const copy = async () => {
    setBusy(true);
    try {
      const { url } = await api.statusLink(ticketId);
      if (!url) throw new Error("Set HALEY_PUBLIC_URL so status links point at your Haley server.");
      await navigator.clipboard.writeText(url);
      toast("Status page link copied. Only share it with the requester: anyone with it can see and reply to this request.");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn btn-ghost btn-sm" onClick={() => void copy()} disabled={busy} title="Copy the requester's status page link">
      <Link2 className="icon-sm" aria-hidden="true" /> Status link
    </button>
  );
}

