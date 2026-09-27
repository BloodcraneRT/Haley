import { BookOpen, Globe, Plus, Search, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { EmptyState, ErrorBanner, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { usePoll } from "../hooks/usePoll";

/** Scope filter: "" = everything, "global" = MSP-wide runbooks only, otherwise an org id (its articles plus global ones). */
export function KbPage() {
  const [params, setParams] = useSearchParams();
  const scope = params.get("orgId") ?? "";
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const [includeGlobal, setIncludeGlobal] = useState(true);
  const orgs = usePoll(() => api.orgs(), []);
  const articles = usePoll(() => api.kb({ orgId: scope && scope !== "global" ? scope : undefined, q: q || undefined }), [scope, q]);

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (search === q) return;
    const t = window.setTimeout(() => update("q", search.trim()), 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // The API always mixes global articles into org-scoped results; narrow client-side.
  const list = (articles.data ?? []).filter((a) => {
    if (scope === "global") return a.org_id === null;
    if (scope && !includeGlobal) return a.org_id === scope;
    return true;
  });

  return (
    <>
      <PageHeader
        title="Knowledge base"
        subtitle="Runbooks and client documentation. Haley searches it before troubleshooting and writes new articles as she learns."
        actions={
          <Link to={`/kb/new${scope && scope !== "global" ? `?orgId=${scope}` : ""}`} className="btn btn-primary">
            <Plus className="icon-sm" aria-hidden="true" /> New article
          </Link>
        }
      />
      <div className="toolbar" role="search">
        <div className="input-with-icon">
          <Search className="icon" aria-hidden="true" />
          <label htmlFor="kb-search" className="sr-only">
            Search articles
          </label>
          <input id="kb-search" className="input" placeholder="Search titles, content and tags" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label htmlFor="kb-scope" className="sr-only">
          Scope
        </label>
        <select id="kb-scope" className="select" value={scope} onChange={(e) => update("orgId", e.target.value)}>
          <option value="">All articles</option>
          <option value="global">Global runbooks only</option>
          <optgroup label="Client">
            {orgs.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </optgroup>
        </select>
        {scope && scope !== "global" && (
          <label className="checkbox">
            <input type="checkbox" checked={includeGlobal} onChange={(e) => setIncludeGlobal(e.target.checked)} />
            Include global runbooks
          </label>
        )}
        <span className="spacer" />
        {articles.data && (
          <span className="muted num" style={{ fontSize: "var(--text-sm)" }}>
            {list.length} article{list.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {articles.error && <ErrorBanner error={articles.error} onRetry={articles.reload} />}
      <div className="card">
        {articles.loading && !articles.data ? (
          <Loading />
        ) : list.length === 0 ? (
          q || scope ? (
            <EmptyState icon={<Search className="icon" />} title="No articles match" compact>
              Try other words, or widen the scope.
            </EmptyState>
          ) : (
            <EmptyState
              icon={<BookOpen className="icon" />}
              title="The knowledge base is empty"
              actions={
                <Link to="/kb/new" className="btn btn-primary">
                  <Plus className="icon-sm" aria-hidden="true" /> Write the first article
                </Link>
              }
            >
              Add your MSP's runbooks (password resets, onboarding, offboarding) so Haley follows your procedures. She'll add client docs as she works.
            </EmptyState>
          )
        ) : (
          <ul className="list article-list">
            {list.map((a) => (
              <li key={a.id}>
                <Link to={`/kb/${a.id}`} className="list-row">
                  <span className="kind-icon" aria-hidden="true">
                    {a.org_id ? <BookOpen className="icon-sm" /> : <Globe className="icon-sm" />}
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="title" style={{ display: "block" }}>
                      {a.title}
                    </span>
                    <span className="meta row row-wrap" style={{ gap: 6, marginTop: 3 }}>
                      <span>{a.org_id ? a.org_name : "Global"}</span>
                      <span>·</span>
                      <span>
                        updated <RelativeTime iso={a.updated_at} />
                      </span>
                      {a.tags.map((t) => (
                        <span key={t} className="tag">
                          {t}
                        </span>
                      ))}
                    </span>
                  </span>
                  {a.source === "agent" && (
                    <span className="haley-badge">
                      <Sparkles className="icon-sm" aria-hidden="true" /> Written by Haley
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
