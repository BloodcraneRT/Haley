import { Building, Check, MessageSquareText, ShieldQuestion, Sparkles, Ticket as TicketIcon, Wrench, X, Zap } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, errorMessage, type Action, type Approval } from "../api";
import { useApp } from "../lib/app-context";
import { JsonDisclosure } from "./Disclosure";
import { Spinner } from "./Feedback";
import { Markdown } from "./Markdown";
import { RiskPill } from "./Pill";
import { RelativeTime } from "./RelativeTime";

type Decision = "approve" | "reject";

export function ApprovalCard({
  action,
  compact,
  hideContext,
  minimal,
  onDecided,
}: {
  action: Action | Approval;
  compact?: boolean;
  /** Only the decision controls (used inside the run feed, which already shows reasoning and input). */
  minimal?: boolean;
  /** Hide org / ticket / run context (e.g. when already on that ticket or run). */
  hideContext?: boolean;
  onDecided?: (action: Action, decision: Decision) => void;
}) {
  const { toast, refreshStats } = useApp();
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(!compact);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [leaving, setLeaving] = useState(false);
  const ctx = "org_name" in action ? action : null;

  const decide = async (decision: Decision) => {
    setBusy(decision);
    try {
      const updated = decision === "approve" ? await api.approve(action.id, note.trim()) : await api.reject(action.id, note.trim());
      toast(decision === "approve" ? `Approved: ${action.description}. Haley will continue.` : `Rejected: ${action.description}.`);
      setLeaving(true);
      window.setTimeout(() => onDecided?.(updated, decision), 180);
    } catch (err) {
      toast(errorMessage(err), "error");
      // 409: someone else already decided; let the parent refresh.
      if (err instanceof ApiError && err.status === 409) onDecided?.(action, decision);
      setBusy(null);
    } finally {
      refreshStats();
    }
  };

  const noteId = `note-${action.id}`;

  const controls = (
    <div className="approval-actions">
      <button className="btn btn-approve" onClick={() => decide("approve")} disabled={busy !== null}>
        {busy === "approve" ? <Spinner /> : <Check className="icon-sm" aria-hidden="true" />} Approve
      </button>
      <button className="btn" onClick={() => decide("reject")} disabled={busy !== null}>
        {busy === "reject" ? <Spinner /> : <X className="icon-sm" aria-hidden="true" />} Reject
      </button>
      {showNote ? (
        <>
          <label htmlFor={noteId} className="sr-only">
            Decision note
          </label>
          <input
            id={noteId}
            className="input"
            placeholder="Optional note for the audit log and Haley"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void decide("approve");
            }}
          />
        </>
      ) : (
        <button className="btn btn-ghost btn-sm" onClick={() => setShowNote(true)}>
          <MessageSquareText className="icon-sm" aria-hidden="true" /> Add note
        </button>
      )}
    </div>
  );

  if (minimal) {
    return (
      <div className={`approval-inline ${leaving ? "leaving" : ""}`} aria-label={`Approval: ${action.description}`} role="group">
        {controls}
      </div>
    );
  }

  return (
    <article
      className={`approval risk-${action.risk} ${compact ? "approval-compact" : ""} ${leaving ? "leaving" : ""}`}
      aria-label={`Approval: ${action.description}`}
    >
      <div className="approval-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row row-wrap" style={{ gap: 8 }}>
            <RiskPill risk={action.risk} />
            <h3 className="approval-title">{action.description}</h3>
          </div>
          <div className="approval-context">
            {ctx && !hideContext && (
              <>
                <span className="row" style={{ gap: 4 }}>
                  <Building className="icon-sm" aria-hidden="true" />
                  <Link to={`/clients/${action.org_id}`}>{ctx.org_name || "Unknown client"}</Link>
                </span>
                {ctx.ticket ? (
                  <span className="row" style={{ gap: 4, minWidth: 0 }}>
                    <TicketIcon className="icon-sm" aria-hidden="true" />
                    <Link to={`/tickets/${ctx.ticket.id}`} className="truncate">
                      #{ctx.ticket.number} {ctx.ticket.title}
                    </Link>
                  </span>
                ) : (
                  <span className="row" style={{ gap: 4, minWidth: 0 }}>
                    <Zap className="icon-sm" aria-hidden="true" />
                    <Link to={`/runs/${action.run_id}`} className="truncate">
                      {ctx.run_title}
                    </Link>
                  </span>
                )}
              </>
            )}
            <span>
              Requested <RelativeTime iso={action.created_at} />
            </span>
          </div>
        </div>
      </div>

      <div className="approval-body">
        {action.policy_reason?.trim() && <PolicyReason reason={action.policy_reason} />}
        {action.rationale.trim() && (
          <div className="rationale">
            <div className="rationale-label">
              <Sparkles className="icon-sm" aria-hidden="true" /> Haley's reasoning
            </div>
            <Markdown source={action.rationale} />
          </div>
        )}
        <div className="row row-wrap" style={{ gap: 12 }}>
          <span className="row muted" style={{ gap: 5, fontSize: "var(--text-sm)" }}>
            <Wrench className="icon-sm" aria-hidden="true" /> Tool <code>{action.tool}</code>
          </span>
          {ctx && !hideContext && ctx.ticket && (
            <Link to={`/runs/${action.run_id}`} style={{ fontSize: "var(--text-sm)" }}>
              View run
            </Link>
          )}
        </div>
        <JsonDisclosure label="Input" value={action.input} />
      </div>

      {controls}
    </article>
  );
}

/** Why the client's policy held this call for a technician (server/src/agent/policy.ts). */
export function PolicyReason({ reason, compact, label = "Why this needs approval" }: { reason: string; compact?: boolean; label?: string }) {
  return (
    <div className={`policy-reason ${compact ? "compact" : ""}`}>
      <ShieldQuestion className="icon-sm" aria-hidden="true" />
      <span>
        <strong>{label}:</strong> {reason}
      </span>
    </div>
  );
}
