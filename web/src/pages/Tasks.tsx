import { ClipboardList, FileSearch, HeartPulse, PenLine, ShieldCheck, Sparkles, UserMinus, UserPlus, Zap } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, errorMessage } from "../api";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { OrgSelect } from "../components/OrgSelect";
import { PageHeader } from "../components/PageHeader";
import { RunRow } from "../components/RunRow";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { isRunActive } from "../lib/format";

const TEMPLATE_ICONS: Record<string, typeof Zap> = {
  onboard: UserPlus,
  offboard: UserMinus,
  "license-audit": ClipboardList,
  "security-review": ShieldCheck,
  document: FileSearch,
  "health-check": HeartPulse,
};

export function TasksPage() {
  const { toast, refreshStats, health } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const templates = usePoll(() => api.templates(), []);
  const orgs = usePoll(() => api.orgs(), []);
  const runs = usePoll(() => api.runs({ kind: "task" }), [], (d) => (d?.some((r) => isRunActive(r.status)) ? 3000 : 15_000));

  const [templateId, setTemplateId] = useState<string | null>(null);
  const [orgId, setOrgId] = useState(params.get("orgId") ?? "");
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId && orgs.data?.length === 1) setOrgId(orgs.data[0].id);
  }, [orgs.data, orgId]);

  const pick = (id: string | null) => {
    setTemplateId(id);
    const t = templates.data?.find((x) => x.id === id);
    setTitle(t ? t.name : "");
    setInstruction(t ? t.instruction : "");
    setError(null);
    window.setTimeout(() => document.getElementById("task-instruction")?.focus(), 0);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!orgId) return setError("Choose which client this task is for.");
    if (!title.trim()) return setError("Give the task a title.");
    if (!instruction.trim()) return setError("Tell Haley what to do.");
    setBusy(true);
    setError(null);
    try {
      const run = await api.startTask({ orgId, title: title.trim(), instruction: instruction.trim() });
      toast("Task started.");
      refreshStats();
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const noOrgs = orgs.data?.length === 0;

  return (
    <>
      <PageHeader
        title="Ask Haley"
        subtitle="Give Haley a one-off task for a client: onboarding, audits, documentation, anything her tools can reach. Changes still follow the client's approval policy."
      />

      {noOrgs ? (
        <div className="card">
          <EmptyState
            icon={<Zap className="icon" />}
            title="Add a client first"
            actions={
              <Link to="/clients?new=1" className="btn btn-primary">
                Add client
              </Link>
            }
          >
            Tasks run against a client's connected tenant.
          </EmptyState>
        </div>
      ) : (
        <div className="stack" style={{ gap: 24 }}>
          <section aria-labelledby="tpl-title">
            <div className="section-title">
              <h2 id="tpl-title">Start from a template</h2>
            </div>
            {templates.error && <ErrorBanner error={templates.error} onRetry={templates.reload} />}
            {!templates.data ? (
              !templates.error && <Loading />
            ) : (
              <div className="templates">
                {templates.data.map((t) => {
                  const Icon = TEMPLATE_ICONS[t.id] ?? Sparkles;
                  return (
                    <button key={t.id} type="button" className="template" aria-pressed={templateId === t.id} onClick={() => pick(t.id)}>
                      <span className="template-icon">
                        <Icon className="icon-sm" aria-hidden="true" />
                      </span>
                      <span className="template-name">{t.name}</span>
                      <span className="template-desc">{t.description}</span>
                    </button>
                  );
                })}
                <button type="button" className="template" aria-pressed={templateId === "custom"} onClick={() => pick("custom")}>
                  <span className="template-icon">
                    <PenLine className="icon-sm" aria-hidden="true" />
                  </span>
                  <span className="template-name">Something else</span>
                  <span className="template-desc">Write your own instruction from scratch.</span>
                </button>
              </div>
            )}
          </section>

          <form className="card" onSubmit={submit} aria-labelledby="task-form-title">
            <div className="card-header">
              <Sparkles className="icon-sm" style={{ color: "var(--tone-violet-fg)" }} aria-hidden="true" />
              <h2 id="task-form-title">Task</h2>
            </div>
            <div className="card-body stack">
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="task-org">Client</label>
                  <OrgSelect id="task-org" orgs={orgs.data ?? []} value={orgId} onChange={setOrgId} required />
                </div>
                <div className="field">
                  <label htmlFor="task-title">Title</label>
                  <input id="task-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. License audit for Q3" />
                </div>
                <div className="field span-2">
                  <label htmlFor="task-instruction">Instruction</label>
                  <textarea
                    id="task-instruction"
                    className="textarea"
                    rows={12}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="Pick a template above, or describe what you need. Be specific about names, dates and what 'done' looks like."
                  />
                </div>
              </div>
              {error && (
                <p className="error-text" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="card-footer">
              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                {health.claudeCredentials ? "Haley starts right away; you'll see her work live." : "The server has no Claude credentials, so this run will fail."}
              </span>
              <span className="spacer" />
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? <Spinner /> : <Zap className="icon-sm" aria-hidden="true" />} Start task
              </button>
            </div>
          </form>

          <section aria-labelledby="task-runs-title">
            <div className="section-title">
              <h2 id="task-runs-title">Recent tasks</h2>
            </div>
            <div className="card">
              {!runs.data ? (
                <Loading />
              ) : runs.data.length === 0 ? (
                <EmptyState title="No tasks yet" compact>
                  Tasks you start appear here with their status.
                </EmptyState>
              ) : (
                <ul className="list">
                  {runs.data.slice(0, 20).map((r) => (
                    <li key={r.id}>
                      <RunRow run={r} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
