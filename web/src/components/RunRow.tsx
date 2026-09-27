import { Ticket as TicketIcon, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import type { Run } from "../api";
import { RunModeBadge, RunStatusPill } from "./Pill";
import { RelativeTime } from "./RelativeTime";

/** One run in a list: kind icon, title, context line and status. */
export function RunRow({ run, showOrg = true, showModel }: { run: Run & { org_name?: string }; showOrg?: boolean; showModel?: boolean }) {
  return (
    <Link to={`/runs/${run.id}`} className="list-row">
      <span className="kind-icon" title={run.kind === "ticket" ? "Ticket run" : "Task"}>
        {run.kind === "ticket" ? <TicketIcon className="icon-sm" aria-hidden="true" /> : <Zap className="icon-sm" aria-hidden="true" />}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="title truncate" style={{ display: "block" }}>
          {run.title}
        </span>
        <span className="meta truncate" style={{ display: "block" }}>
          {showOrg && run.org_name ? `${run.org_name} · ` : ""}
          {run.created_by} · <RelativeTime iso={run.created_at} />
          {showModel && run.model && (
            <span title={`Served by ${run.model}`}>
              {" "}
              · served by <span className="run-model">{run.model}</span>
            </span>
          )}
        </span>
      </span>
      <RunModeBadge mode={run.mode} />
      <RunStatusPill status={run.status} />
    </Link>
  );
}
