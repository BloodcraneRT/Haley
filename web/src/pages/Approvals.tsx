import { CircleCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Risk } from "../api";
import { ApprovalCard } from "../components/ApprovalCard";
import { EmptyState, ErrorBanner, Loading } from "../components/Feedback";
import { OrgSelect } from "../components/OrgSelect";
import { PageHeader } from "../components/PageHeader";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";

export function ApprovalsPage() {
  const { refreshStats } = useApp();
  const approvals = usePoll(() => api.approvals(), [], 5000);
  const [orgId, setOrgId] = useState("");
  const [risk, setRisk] = useState<"" | Risk>("");

  const items = approvals.data ?? [];
  const orgs = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of items) m.set(a.org_id, a.org_name);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);
  const visible = items.filter((a) => (!orgId || a.org_id === orgId) && (!risk || a.risk === risk));
  const destructive = items.filter((a) => a.risk === "destructive").length;

  // Keep the nav badge in sync with what this page shows.
  const count = items.length;
  useEffect(() => refreshStats(), [count, refreshStats]);

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Changes Haley wants to make to customer systems that need a technician's sign-off. Haley continues the run as soon as every pending action in it is decided."
      />

      {approvals.error && <ErrorBanner error={approvals.error} onRetry={approvals.reload} />}

      {items.length > 0 && (
        <div className="toolbar">
          <label className="sr-only" htmlFor="appr-org">
            Client
          </label>
          <OrgSelect id="appr-org" orgs={orgs} value={orgId} onChange={setOrgId} allLabel="All clients" />
          <div className="segmented" role="group" aria-label="Risk">
            {(["", "write", "destructive"] as const).map((r) => (
              <button key={r || "all"} aria-pressed={risk === r} onClick={() => setRisk(r)}>
                {r === "" ? `All ${items.length}` : r === "write" ? `Write ${items.length - destructive}` : `Destructive ${destructive}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {approvals.loading && !approvals.data ? (
        <Loading />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState icon={<CircleCheck className="icon" />} title="You're all caught up">
            No changes are waiting for approval. Clients on <strong>Supervised</strong> autonomy route every change here; <strong>Autonomous</strong>{" "}
            clients only route security-sensitive ones; <strong>Unattended</strong> clients route what a verified requester can't justify on their
            own. Adjust a client's policy on its <Link to="/clients">client page</Link>.
          </EmptyState>
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState title="No approvals match these filters" compact />
        </div>
      ) : (
        <div className="stack">
          {visible.map((a) => (
            <ApprovalCard
              key={a.id}
              action={a}
              onDecided={() => {
                approvals.mutate((list) => list?.filter((x) => x.id !== a.id));
                void approvals.reload();
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}
