import {
  CalendarClock,
  ClipboardList,
  Clock,
  CreditCard,
  FileText,
  HeartPulse,
  KeyRound,
  Laptop,
  Mail,
  PenLine,
  Plug,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  UserMinus,
  UserPlus,
  UserRound,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, errorMessage, type Cadence, type RecipeCategory, type RunMode, type TaskTemplate } from "../api";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { OrgSelect } from "../components/OrgSelect";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { RunRow } from "../components/RunRow";
import { CadenceFields, defaultStartLocal, localInputToIso, ModeToggle } from "../components/Schedules";
import { usePoll } from "../hooks/usePoll";
import { aiReady, useApp } from "../lib/app-context";
import { CADENCE_META, isRunActive } from "../lib/format";

const CATEGORIES: { id: RecipeCategory; icon: typeof Zap }[] = [
  { id: "Identity & access", icon: UserRound },
  { id: "Licensing & cost", icon: CreditCard },
  { id: "Email & collaboration", icon: Mail },
  { id: "Security", icon: ShieldCheck },
  { id: "Devices", icon: Laptop },
  { id: "RMM & endpoints", icon: Server },
  { id: "Documentation & reporting", icon: FileText },
];

const RECIPE_ICONS: Record<string, typeof Zap> = {
  onboard: UserPlus,
  offboard: UserMinus,
  "password-reset": KeyRound,
  "mfa-reregister": KeyRound,
  "bitlocker-recovery": KeyRound,
  "license-audit": ClipboardList,
  "health-check": HeartPulse,
};

/** "Microsoft 365", or "IT Glue or Hudu, and Microsoft 365 or NinjaOne RMM" for several requirements. */
const needs = (t: TaskTemplate) => t.missing.join(", and ");

const iconFor = (t: TaskTemplate) => RECIPE_ICONS[t.id] ?? CATEGORIES.find((c) => c.id === t.category)?.icon ?? Sparkles;

function matchesQuery(t: TaskTemplate, q: string) {
  if (!q) return true;
  const hay = [t.name, t.description, t.category, ...t.tags].join(" ").toLowerCase();
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

export function TasksPage() {
  const { toast, refreshStats, health } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const orgs = usePoll(() => api.orgs(), []);
  const runs = usePoll(() => api.runs({ kind: "task" }), [], (d) => (d?.some((r) => isRunActive(r.status)) ? 3000 : 15_000));

  const [templateId, setTemplateId] = useState<string | null>(null);
  const [orgId, setOrgId] = useState(params.get("orgId") ?? "");
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<RunMode>("live");
  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [cadence, setCadence] = useState<Cadence>("once");
  const [startAt, setStartAt] = useState(defaultStartLocal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<RecipeCategory | "all">("all");

  // Availability depends on the client's integrations, so re-fetch per client (keeping the last list meanwhile).
  const templates = usePoll(async () => ({ orgId, recipes: await api.templates(orgId || undefined) }), [orgId]);
  const [lastRecipes, setLastRecipes] = useState<TaskTemplate[] | undefined>(undefined);
  useEffect(() => {
    if (templates.data) setLastRecipes(templates.data.recipes);
  }, [templates.data]);
  const recipes = templates.data?.recipes ?? lastRecipes;
  const availabilityReady = templates.data?.orgId === orgId;

  useEffect(() => {
    if (!orgId && orgs.data?.length === 1) setOrgId(orgs.data[0].id);
  }, [orgs.data, orgId]);

  const recipe = recipes?.find((t) => t.id === templateId) ?? null;
  const orgName = orgs.data?.find((o) => o.id === orgId)?.name ?? "";

  const q = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (recipes ?? [])
        .filter((t) => category === "all" || t.category === category)
        .filter((t) => matchesQuery(t, q))
        // Recipes this client can run come first.
        .sort((a, b) => Number(b.available) - Number(a.available)),
    [recipes, category, q],
  );
  const counts = useMemo(() => {
    const byCategory = new Map<string, number>();
    for (const t of recipes ?? []) if (matchesQuery(t, q)) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + 1);
    return byCategory;
  }, [recipes, q]);
  const totalMatching = [...counts.values()].reduce((a, b) => a + b, 0);

  const pick = (id: string | null) => {
    setTemplateId(id);
    const t = recipes?.find((x) => x.id === id);
    setTitle(t ? t.name : "");
    setInstruction(t ? t.instruction : "");
    // Recipes that change things default to a dry run so the technician reviews the plan first.
    setMode(t?.changes ? "plan" : "live");
    setError(null);
    window.setTimeout(() => document.getElementById("task-instruction")?.focus(), 0);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!orgId) return setError("Choose which client this task is for.");
    if (recipe && !availabilityReady) return setError("Wait for this client's recipe availability to load, or retry if it failed.");
    if (recipe && !recipe.available) return setError(`This recipe needs ${needs(recipe)}, which ${orgName || "this client"} hasn't connected.`);
    if (!title.trim()) return setError("Give the task a title.");
    if (!instruction.trim()) return setError("Tell Haley what to do.");
    setBusy(true);
    setError(null);
    try {
      if (when === "schedule") {
        const iso = localInputToIso(startAt);
        if (!iso) {
          setBusy(false);
          return setError("Choose when it should run.");
        }
        await api.createSchedule({ orgId, title: title.trim(), instruction: instruction.trim(), cadence, mode, startAt: iso, ...(recipe ? { templateId: recipe.id } : {}) });
        toast(`Scheduled "${title.trim()}" (${CADENCE_META[cadence].every.toLowerCase()}). It's listed on the client's page.`);
        refreshStats();
        navigate(`/clients/${orgId}`);
        return;
      }
      const run = await api.startTask({ orgId, title: title.trim(), instruction: instruction.trim(), mode, ...(recipe ? { templateId: recipe.id } : {}) });
      toast(mode === "plan" ? "Planning started. Nothing will be changed." : "Task started.");
      refreshStats();
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const noOrgs = orgs.data?.length === 0;

  const card = (t: TaskTemplate, showCategory: boolean) => {
    const Icon = iconFor(t);
    return (
      <button
        key={t.id}
        type="button"
        className="template recipe"
        aria-pressed={templateId === t.id}
        disabled={!availabilityReady || !t.available}
        onClick={() => pick(t.id)}
        title={t.available ? undefined : `Needs ${needs(t)}`}
      >
        <span className="recipe-head">
          <span className="template-icon">
            <Icon className="icon-sm" aria-hidden="true" />
          </span>
          <span className="template-name">{t.name}</span>
        </span>
        <span className="template-desc">{t.description}</span>
        <span className="recipe-meta">
          {showCategory && <span className="recipe-category">{t.category}</span>}
          <span className="recipe-time" title="Typical technician time to do this by hand">
            <Clock className="icon-xs" aria-hidden="true" />~{t.estimatedMinutes} min by hand
          </span>
          {t.changes && (
            <Pill tone="amber" title="Changes customer systems. Preview it in Plan mode first.">
              Makes changes
            </Pill>
          )}
        </span>
        {!t.available && (
          <span className="recipe-missing">
            <Plug className="icon-xs" aria-hidden="true" />
            Needs {needs(t)}
          </span>
        )}
      </button>
    );
  };

  const modeHelp = recipe?.changes
    ? mode === "plan"
      ? "This recipe makes changes. Haley writes up the exact plan without changing anything; review it, then choose Run for real on the run page."
      : "Haley makes the changes now, following the client's approval policy. Previewing it in Plan mode first is recommended."
    : mode === "live"
      ? "Haley does the work. Changes follow the client's approval policy."
      : "Dry run: Haley investigates and writes up the exact plan. Nothing is changed.";

  return (
    <>
      <PageHeader
        title="Ask Haley"
        subtitle="Give Haley a task for a client: start from a recipe or write your own. Changes still follow the client's approval policy."
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
              <h2 id="tpl-title">Recipes</h2>
              {recipes && <span className="count">{recipes.length}</span>}
              {templates.loading && <Spinner />}
              <span className="spacer" />
              <button type="button" className="btn btn-sm recipe-custom" aria-pressed={templateId === "custom"} onClick={() => pick("custom")}>
                <PenLine className="icon-sm" aria-hidden="true" />
                Write your own
              </button>
            </div>

            <div className="toolbar recipe-toolbar">
              <div className="recipe-client">
                <label htmlFor="task-org" className="field-label">
                  Client
                </label>
                <OrgSelect id="task-org" orgs={orgs.data ?? []} value={orgId} onChange={setOrgId} required />
              </div>
              <div className="input-with-icon" role="search">
                <Search className="icon" aria-hidden="true" />
                <label htmlFor="recipe-search" className="sr-only">
                  Search recipes
                </label>
                <input
                  id="recipe-search"
                  className="input"
                  type="search"
                  placeholder="Search recipes, e.g. offboard, BitLocker, licenses"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="recipe-cats" role="group" aria-label="Filter by category">
              <button type="button" className={`chip chip-button ${category === "all" ? "is-on" : ""}`} aria-pressed={category === "all"} onClick={() => setCategory("all")}>
                All <span className="recipe-cat-count">{totalMatching}</span>
              </button>
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`chip chip-button ${category === c.id ? "is-on" : ""}`}
                  aria-pressed={category === c.id}
                  onClick={() => setCategory(category === c.id ? "all" : c.id)}
                >
                  <c.icon className="icon-xs" aria-hidden="true" />
                  {c.id} <span className="recipe-cat-count">{counts.get(c.id) ?? 0}</span>
                </button>
              ))}
            </div>

            {!orgId && recipes && <p className="recipe-note muted">Choose a client to see which recipes its connected tools support.</p>}

            {templates.error && <ErrorBanner error={templates.error} onRetry={templates.reload} />}
            {!recipes ? (
              !templates.error && <Loading />
            ) : shown.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon={<Search className="icon" />}
                  title="No recipes match"
                  compact
                  actions={
                    <>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setSearch("");
                          setCategory("all");
                        }}
                      >
                        Clear filters
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => pick("custom")}>
                        <PenLine className="icon-sm" aria-hidden="true" /> Write your own
                      </button>
                    </>
                  }
                >
                  Try other words, or describe the task yourself.
                </EmptyState>
              </div>
            ) : q ? (
              <div className="templates recipes">{shown.map((t) => card(t, true))}</div>
            ) : (
              <div className="recipe-groups">
                {CATEGORIES.filter((c) => shown.some((t) => t.category === c.id)).map((c) => (
                  <section key={c.id} className="recipe-group" aria-label={c.id}>
                    <h3 className="recipe-group-title">
                      <c.icon className="icon-sm" aria-hidden="true" />
                      {c.id}
                    </h3>
                    <div className="templates recipes">{shown.filter((t) => t.category === c.id).map((t) => card(t, false))}</div>
                  </section>
                ))}
              </div>
            )}
          </section>

          <form className="card" onSubmit={submit} aria-labelledby="task-form-title">
            <div className="card-header">
              <Sparkles className="icon-sm" style={{ color: "var(--tone-violet-fg)" }} aria-hidden="true" />
              <h2 id="task-form-title">Task</h2>
              {orgName && <span className="muted recipe-for">for {orgName}</span>}
              {recipe && (
                <>
                  <span className="spacer" />
                  <span className="recipe-form-meta">
                    <span className="muted">~{recipe.estimatedMinutes} min by hand</span>
                    {recipe.changes && <Pill tone="amber">Makes changes</Pill>}
                  </span>
                </>
              )}
            </div>
            <div className="card-body stack">
              {recipe && availabilityReady && !recipe.available && (
                <div className="banner banner-warn" role="note">
                  <Plug className="icon-sm icon" aria-hidden="true" />
                  <span>
                    {orgName || "This client"} doesn't have {needs(recipe)} connected, so Haley can't run this recipe for them.
                  </span>
                </div>
              )}
              <div className="form-grid">
                <div className="field span-2">
                  <label htmlFor="task-title">Title</label>
                  <input id="task-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. License audit for Q3" />
                </div>
                <div className="field span-2">
                  <label htmlFor="task-instruction">Instruction</label>
                  <textarea
                    id="task-instruction"
                    className="textarea"
                    rows={14}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="Pick a recipe above, or describe what you need. Be specific about names, dates and what 'done' looks like."
                  />
                  {recipe && <span className="help">Fill in the blank lines (User:, Device: …) before starting.</span>}
                </div>
                <div className="field">
                  <span className="field-label">Mode</span>
                  <ModeToggle value={mode} onChange={setMode} />
                  <span className="help">{modeHelp}</span>
                </div>
                <div className="field">
                  <span className="field-label">When</span>
                  <div className="segmented" role="group" aria-label="When" style={{ alignSelf: "flex-start" }}>
                    <button type="button" aria-pressed={when === "now"} onClick={() => setWhen("now")}>
                      <Zap className="icon-sm seg-icon" aria-hidden="true" />
                      Now
                    </button>
                    <button type="button" aria-pressed={when === "schedule"} onClick={() => setWhen("schedule")}>
                      <CalendarClock className="icon-sm seg-icon" aria-hidden="true" />
                      Schedule this
                    </button>
                  </div>
                  <span className="help">{when === "now" ? "Starts right away; you'll see her work live." : "Runs later, once or on a repeating cadence."}</span>
                </div>
                {when === "schedule" && <CadenceFields idPrefix="task" cadence={cadence} onCadence={setCadence} startAt={startAt} onStartAt={setStartAt} />}
              </div>
              {error && (
                <p className="error-text" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="card-footer">
              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                {aiReady(health)
                  ? when === "schedule"
                    ? "Scheduled runs are skipped while Haley is paused for the client."
                    : mode === "plan"
                      ? "Haley plans right away; nothing is changed."
                      : "Haley starts right away; you'll see her work live."
                  : "Haley's AI model has no credentials, so runs will fail."}
              </span>
              <span className="spacer" />
              <button className="btn btn-primary" type="submit" disabled={busy || Boolean(recipe && (!availabilityReady || !recipe.available))}>
                {busy ? <Spinner /> : when === "schedule" ? <CalendarClock className="icon-sm" aria-hidden="true" /> : mode === "plan" ? <ClipboardList className="icon-sm" aria-hidden="true" /> : <Zap className="icon-sm" aria-hidden="true" />}
                {when === "schedule" ? "Create schedule" : mode === "plan" ? "Start plan" : "Start task"}
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
