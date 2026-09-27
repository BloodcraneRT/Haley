import { Inbox, Zap } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type RunKind, type RunStatus } from "../api";
import { EmptyState, ErrorBanner, Loading } from "../components/Feedback";
import { OrgSelect } from "../components/OrgSelect";
import { PageHeader } from "../components/PageHeader";
import { RunRow } from "../components/RunRow";
import { usePoll } from "../hooks/usePoll";
import { isRunActive, RUN_STATUS_META } from "../lib/format";

export function RunsPage() {
  const [params, setParams] = useSearchParams();
  const orgId = params.get("orgId") ?? "";
  const kind = (params.get("kind") ?? "") as RunKind | "";
  const status = (params.get("status") ?? "") as RunStatus | "";
  const orgs = usePoll(() => api.orgs(), []);
  const runs = usePoll(
    () => api.runs({ orgId: orgId || undefined, kind: kind || undefined }),
    [orgId, kind],
    (d) => (d?.some((r) => isRunActive(r.status)) ? 3000 : 15_000),
  );

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const list = (runs.data ?? []).filter((r) => !status || r.status === status);

  return (
    <>
      <PageHeader title="Runs" subtitle="Every time Haley works a ticket or a task. Open a run to see exactly what she looked at, decided and changed." />
      <div className="toolbar">
        <label htmlFor="r-org" className="sr-only">
          Client
        </label>
        <OrgSelect id="r-org" orgs={orgs.data ?? []} value={orgId} onChange={(v) => update("orgId", v)} allLabel="All clients" />
        <div className="segmented" role="group" aria-label="Kind">
          {(
            [
              ["", "All"],
              ["ticket", "Tickets"],
              ["task", "Tasks"],
            ] as const
          ).map(([k, label]) => (
            <button key={k || "all"} aria-pressed={kind === k} onClick={() => update("kind", k)}>
              {label}
            </button>
          ))}
        </div>
        <label htmlFor="r-status" className="sr-only">
          Status
        </label>
        <select id="r-status" className="select" value={status} onChange={(e) => update("status", e.target.value)}>
          <option value="">Any status</option>
          {(Object.keys(RUN_STATUS_META) as RunStatus[]).map((s) => (
            <option key={s} value={s}>
              {RUN_STATUS_META[s].label}
            </option>
          ))}
        </select>
      </div>
      {runs.error && <ErrorBanner error={runs.error} onRetry={runs.reload} />}
      <div className="card">
        {runs.loading && !runs.data ? (
          <Loading />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Inbox className="icon" />}
            title={runs.data?.length ? "No runs match" : "No runs yet"}
            actions={
              !runs.data?.length && (
                <Link to="/tasks" className="btn btn-primary">
                  <Zap className="icon-sm" aria-hidden="true" /> Ask Haley
                </Link>
              )
            }
          >
            {runs.data?.length ? "Try a different filter." : "Runs appear when Haley works a ticket or when you give her a task."}
          </EmptyState>
        ) : (
          <ul className="list">
            {list.map((r) => (
              <li key={r.id}>
                <RunRow run={r} showModel />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
