import { ChevronRight, Eye, Globe, Pencil, Sparkles, Trash } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, errorMessage, type KbArticle } from "../api";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { Markdown } from "../components/Markdown";
import { ConfirmModal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";

const parseTags = (s: string) =>
  s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

function ArticleEditor({
  initial,
  scopeField,
  busy,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { title: string; body: string; tags: string[] };
  scopeField: ReactNode;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (v: { title: string; body: string; tags: string[] }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [tags, setTags] = useState(initial.tags.join(", "));
  const [preview, setPreview] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ title: title.trim(), body, tags: parseTags(tags) });
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="card-body stack">
        <div className="form-grid">
          <div className="field span-2">
            <label htmlFor="kb-title">Title</label>
            <input id="kb-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Runbook: Shared mailbox access" required autoFocus />
          </div>
          {scopeField}
          <div className="field">
            <label htmlFor="kb-tags">Tags</label>
            <input id="kb-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="runbook, email" />
            <span className="help">Comma-separated.</span>
          </div>
        </div>
        <div className="field">
          <div className="row">
            <label htmlFor="kb-body" className="field-label">
              Body <span className="muted">(Markdown)</span>
            </label>
            <span className="spacer" />
            <div className="segmented" role="group" aria-label="Editor mode">
              <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
                <Pencil className="icon-sm" aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
                Write
              </button>
              <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
                <Eye className="icon-sm" aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
                Preview
              </button>
            </div>
          </div>
          {preview ? (
            <div className="code-block" style={{ fontFamily: "var(--font-sans)", fontSize: 14, whiteSpace: "normal", minHeight: 320, background: "var(--surface)" }}>
              {body.trim() ? <Markdown source={body} className="md-article" /> : <span className="muted">Nothing to preview.</span>}
            </div>
          ) : (
            <textarea
              id="kb-body"
              className="textarea mono"
              rows={18}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={"## When to use\n\n## Steps\n1. …"}
            />
          )}
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="card-footer">
        <span className="spacer" />
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>
          {busy && <Spinner />} {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function KbNewPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { toast, refreshStats } = useApp();
  const orgs = usePoll(() => api.orgs(), []);
  const [orgId, setOrgId] = useState(params.get("orgId") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (v: { title: string; body: string; tags: string[] }) => {
    if (!v.title) return setError("Title is required.");
    setBusy(true);
    setError(null);
    try {
      const article = await api.createArticle({ ...v, orgId: orgId || null });
      toast("Article created.");
      refreshStats();
      navigate(`/kb/${article.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Link to="/kb">Knowledge base</Link>
            <ChevronRight className="icon-sm" aria-hidden="true" />
            <span>New</span>
          </>
        }
        title="New article"
      />
      <ArticleEditor
        initial={{ title: "", body: "", tags: [] }}
        busy={busy}
        error={error}
        submitLabel="Create article"
        onSubmit={create}
        onCancel={() => navigate(-1)}
        scopeField={
          <div className="field">
            <label htmlFor="kb-scope">Applies to</label>
            <select id="kb-scope" className="select" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              <option value="">Global (every client)</option>
              {orgs.data?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} only
                </option>
              ))}
            </select>
          </div>
        }
      />
    </>
  );
}

export function KbArticlePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { toast, refreshStats } = useApp();
  const article = usePoll(() => api.article(id), [id]);
  const orgs = usePoll(() => api.orgs(), []);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (article.error instanceof ApiError && article.error.status === 404) {
    return (
      <div className="card">
        <EmptyState title="Article not found" actions={<Link to="/kb" className="btn">Back to knowledge base</Link>}>
          It may have been deleted.
        </EmptyState>
      </div>
    );
  }
  if (!article.data) return article.error ? <ErrorBanner error={article.error} onRetry={article.reload} /> : <Loading />;

  const a: KbArticle = article.data;
  const orgName = a.org_id ? (orgs.data?.find((o) => o.id === a.org_id)?.name ?? "Client") : "Global";

  const save = async (v: { title: string; body: string; tags: string[] }) => {
    if (!v.title) return setError("Title is required.");
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateArticle(a.id, v);
      article.mutate(() => updated);
      toast("Article saved.");
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteArticle(a.id);
      toast("Article deleted.");
      refreshStats();
      navigate("/kb", { replace: true });
    } catch (err) {
      toast(errorMessage(err), "error");
      setBusy(false);
    }
  };

  const scope = (
    <span className="row" style={{ gap: 5 }}>
      {a.org_id ? <Link to={`/clients/${a.org_id}`}>{orgName}</Link> : (
        <>
          <Globe className="icon-sm" aria-hidden="true" /> Global
        </>
      )}
    </span>
  );

  return (
    <>
      <PageHeader
        docTitle={a.title}
        breadcrumb={
          <>
            <Link to="/kb">Knowledge base</Link>
            <ChevronRight className="icon-sm" aria-hidden="true" />
            <span className="truncate">{orgName}</span>
          </>
        }
        title={editing ? "Edit article" : a.title}
        subtitle={
          !editing && (
            <span className="row row-wrap" style={{ gap: 8 }}>
              {scope}
              <span>·</span>
              <span>
                Updated <RelativeTime iso={a.updated_at} />
              </span>
              {a.source === "agent" && (
                <span className="haley-badge">
                  <Sparkles className="icon-sm" aria-hidden="true" /> Written by Haley
                </span>
              )}
              {a.run_id && <Link to={`/runs/${a.run_id}`}>View source run</Link>}
            </span>
          )
        }
        actions={
          !editing && (
            <>
              <button className="btn btn-danger-ghost" onClick={() => setConfirmDelete(true)}>
                <Trash className="icon-sm" aria-hidden="true" /> Delete
              </button>
              <button className="btn" onClick={() => setEditing(true)}>
                <Pencil className="icon-sm" aria-hidden="true" /> Edit
              </button>
            </>
          )
        }
      />
      {editing ? (
        <ArticleEditor
          initial={a}
          busy={busy}
          error={error}
          submitLabel="Save changes"
          onSubmit={save}
          onCancel={() => {
            setEditing(false);
            setError(null);
          }}
          scopeField={
            <div className="field">
              <span className="field-label">Applies to</span>
              <div className="input" style={{ display: "flex", alignItems: "center", background: "var(--surface-sunken)" }} aria-readonly="true">
                {a.org_id ? `${orgName} only` : "Global (every client)"}
              </div>
              <span className="help">Scope can't be changed after creation.</span>
            </div>
          }
        />
      ) : (
        <article className="card card-pad" style={{ padding: "24px 28px" }}>
          {a.tags.length > 0 && (
            <div className="row row-wrap" style={{ gap: 6, marginBottom: 16 }}>
              {a.tags.map((t) => (
                <Link key={t} to={`/kb?q=${encodeURIComponent(t)}`} className="tag">
                  {t}
                </Link>
              ))}
            </div>
          )}
          {a.body.trim() ? <Markdown source={a.body} className="md-article" /> : <p className="muted">This article is empty. Use Edit to add content.</p>}
        </article>
      )}
      <ConfirmModal
        open={confirmDelete}
        title="Delete this article?"
        confirmLabel="Delete article"
        busy={busy}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      >
        “{a.title}” will be removed for everyone, and Haley will no longer find it. This can't be undone.
      </ConfirmModal>
    </>
  );
}
