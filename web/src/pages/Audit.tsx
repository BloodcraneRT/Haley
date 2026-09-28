import { ChevronDown, ChevronRight, ScrollText, Search } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Avatar, displayName } from "../components/Avatar";
import { CodeBlock } from "../components/Disclosure";
import { EmptyState, ErrorBanner, Loading } from "../components/Feedback";
import { OrgSelect } from "../components/OrgSelect";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { usePoll } from "../hooks/usePoll";
import { absoluteTime, type Tone } from "../lib/format";

const TARGET_ROUTES: Record<string, (id: string) => string> = {
  org: (id) => `/clients/${id}`,
  tkt: (id) => `/tickets/${id}`,
  run: (id) => `/runs/${id}`,
  kb: (id) => `/kb/${id}`,
  psa: (id) => `/psa/${id}/customers`,
  mdl: () => "/models",
};

function targetLink(target: string) {
  const prefix = target.split("_")[0];
  const route = TARGET_ROUTES[prefix];
  return route ? <Link to={route(target)} className="mono">{target}</Link> : <span className="mono muted">{target || "—"}</span>;
}

function actionTone(action: string): Tone {
  if (/failed|deleted|removed|revealed|rejected/.test(action)) return action.includes("revealed") ? "amber" : "red";
  if (/blocked/.test(action)) return "neutral";
  if (/executed|approved|completed|connected/.test(action)) return "green";
  if (/started|created/.test(action)) return "blue";
  return "neutral";
}

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const orgId = params.get("orgId") ?? "";
  const [limit, setLimit] = useState(200);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const orgs = usePoll(() => api.orgs(), []);
  const audit = usePoll(() => api.audit({ orgId: orgId || undefined, limit }), [orgId, limit], 15_000);
  const orgNames = useMemo(() => new Map((orgs.data ?? []).map((o) => [o.id, o.name])), [orgs.data]);

  const needle = filter.trim().toLowerCase();
  const list = (audit.data ?? []).filter(
    (e) => !needle || e.action.toLowerCase().includes(needle) || e.actor.toLowerCase().includes(needle) || e.target.toLowerCase().includes(needle),
  );

  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every change, approval, credential reveal and run, by technicians and by Haley. Newest first."
      />
      <div className="toolbar">
        <div className="input-with-icon">
          <Search className="icon" aria-hidden="true" />
          <label htmlFor="au-filter" className="sr-only">
            Filter
          </label>
          <input id="au-filter" className="input" placeholder="Filter by action, actor or target" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <label htmlFor="au-org" className="sr-only">
          Client
        </label>
        <OrgSelect
          id="au-org"
          orgs={orgs.data ?? []}
          value={orgId}
          onChange={(v) => {
            const next = new URLSearchParams(params);
            if (v) next.set("orgId", v);
            else next.delete("orgId");
            setParams(next, { replace: true });
          }}
          allLabel="All clients"
        />
        <label htmlFor="au-limit" className="sr-only">
          Entries
        </label>
        <select id="au-limit" className="select" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          {[100, 200, 500, 1000].map((n) => (
            <option key={n} value={n}>
              Last {n}
            </option>
          ))}
        </select>
      </div>
      {audit.error && <ErrorBanner error={audit.error} onRetry={audit.reload} />}
      <div className="card">
        {audit.loading && !audit.data ? (
          <Loading />
        ) : list.length === 0 ? (
          <EmptyState icon={<ScrollText className="icon" />} title={audit.data?.length ? "No entries match" : "Nothing logged yet"} compact>
            {audit.data?.length ? "Try a different filter." : "Actions by technicians and Haley are recorded here as they happen."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" style={{ width: 28 }}>
                    <span className="sr-only">Expand</span>
                  </th>
                  <th scope="col">Time</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col" className="hide-sm">
                    Target
                  </th>
                  <th scope="col" className="hide-md">
                    Client
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((e) => {
                  const open = expanded.has(e.id);
                  const hasDetail = Object.keys(e.detail ?? {}).length > 0;
                  return (
                    <Fragment key={e.id}>
                      <tr className={`clickable ${open ? "expanded" : ""}`} onClick={(ev) => !(ev.target as HTMLElement).closest("a") && toggle(e.id)}>
                        <td style={{ paddingRight: 0 }}>
                          <button
                            className="btn btn-ghost btn-sm btn-icon"
                            aria-expanded={open}
                            aria-label={open ? "Hide detail" : "Show detail"}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              toggle(e.id);
                            }}
                          >
                            {open ? <ChevronDown className="icon-sm" /> : <ChevronRight className="icon-sm" />}
                          </button>
                        </td>
                        <td className="nowrap muted" title={absoluteTime(e.created_at)}>
                          <RelativeTime iso={e.created_at} />
                        </td>
                        <td>
                          <span className="row" style={{ gap: 6 }}>
                            <Avatar name={e.actor} />
                            <span className="truncate" style={{ maxWidth: 160 }}>
                              {displayName(e.actor)}
                            </span>
                          </span>
                        </td>
                        <td>
                          <Pill tone={actionTone(e.action)}>
                            <span className="mono">{e.action}</span>
                          </Pill>
                        </td>
                        <td className="hide-sm">{targetLink(e.target)}</td>
                        <td className="hide-md secondary nowrap">
                          {e.org_id ? orgNames.get(e.org_id) ?? <span className="muted mono">{e.org_id}</span> : <span className="muted">—</span>}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={6} className="detail-cell">
                            <div className="stack-sm">
                              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                                {absoluteTime(e.created_at)} · entry <span className="mono">{e.id}</span>
                                {e.target && (
                                  <>
                                    {" "}
                                    · target {targetLink(e.target)}
                                  </>
                                )}
                              </span>
                              {hasDetail ? <CodeBlock value={e.detail} /> : <span className="muted">No additional detail.</span>}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
