import { Ticket as TicketIcon, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import type { Run } from "../api";
import { RunStatusPill } from "./Pill";
import { RelativeTime } from "./RelativeTime";

/** One run in a list: kind icon, title, context line and status. */
export function RunRow({ run, showOrg = true }: { run: Run & { org_name?: string }; showOrg?: boolean }) {
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
        </span>
      </span>
      <RunStatusPill status={run.status} />
    </Link>
  );
}
