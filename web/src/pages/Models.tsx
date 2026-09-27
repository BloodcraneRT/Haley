import {
  ArrowRight,
  BrainCircuit,
  CircleAlert,
  CircleCheck,
  CircleX,
  Gauge,
  KeyRound,
  Pencil,
  Plus,
  Route,
  ShieldCheck,
  Star,
  Trash,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  api,
  errorMessage,
  MODEL_EFFORTS,
  type ModelEffort,
  type ModelLicense,
  type ModelOptions,
  type ModelProfile,
  type ModelProfileListItem,
  type ModelProviderKind,
  type ModelProviderPreset,
  type ModelTestResult,
  type OrgSummary,
} from "../api";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { Switch } from "../components/Switch";
import { usePoll } from "../hooks/usePoll";
import { aiReady, useApp } from "../lib/app-context";
import { formatNumber, LICENSE_META } from "../lib/format";

// ------------------------------------------------------------------ helpers

const EFFORT_LABEL: Record<ModelEffort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** A profile followed by its fallbacks, stopping at cycles (mirrors server ModelRegistry.chain). */
function chainOf(profile: ModelProfile, byId: Map<string, ModelProfile>, max = 4): ModelProfile[] {
  const chain: ModelProfile[] = [];
  let current: ModelProfile | undefined = profile;
  while (current && chain.length < max && !chain.some((p) => p.id === current!.id)) {
    chain.push(current);
    current = current.fallback_id ? byId.get(current.fallback_id) : undefined;
  }
  return chain;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function shortProvider(preset: ModelProviderPreset | undefined, id: string): string {
  return preset ? preset.name.replace(/\s*\(.*\)$/, "") : id;
}

/** Monogram tile for a provider, tinted by license (closed / open-weight / both). */
const MONOGRAMS: Partial<Record<ModelProviderKind, string>> = {
  azure_openai: "Az",
  groq: "Gq",
  openrouter: "OR",
  deepseek: "DS",
  lmstudio: "LM",
  vllm: "vL",
  xai: "xAI",
  openai_compatible: "API",
};

function ModelGlyph({ preset, provider }: { preset: ModelProviderPreset | undefined; provider: ModelProviderKind }) {
  const letters = MONOGRAMS[provider] ?? shortProvider(preset, provider).charAt(0).toUpperCase();
  return (
    <span className={`model-glyph tone-${LICENSE_META[preset?.license ?? "both"].tone}`} aria-hidden="true">
      {letters}
    </span>
  );
}

export function LicensePill({ license }: { license: ModelLicense }) {
  const meta = LICENSE_META[license];
  return (
    <Pill tone={meta.tone} title={meta.help}>
      {meta.label}
    </Pill>
  );
}

function optionChips(p: ModelProfile): string[] {
  const o = p.options ?? {};
  const chips: string[] = [];
  if (o.effort) chips.push(`Effort ${EFFORT_LABEL[o.effort].toLowerCase()}`);
  if (o.maxTokens) chips.push(`${formatNumber(o.maxTokens)} max tokens`);
  if (o.tokenParam) chips.push(o.tokenParam);
  if (o.temperature !== undefined) chips.push(`Temperature ${o.temperature}`);
  if (o.reasoningEffort) chips.push(`Reasoning ${o.reasoningEffort}`);
  if (o.apiVersion) chips.push(`API ${o.apiVersion}`);
  if (p.provider === "anthropic" && o.refusalFallbacks === false) chips.push("Refusal fallbacks off");
  if (o.extraHeaders && Object.keys(o.extraHeaders).length) chips.push(`${Object.keys(o.extraHeaders).length} extra header(s)`);
  return chips;
}

// ------------------------------------------------------------------ page

interface TestState {
  busy: boolean;
  result?: ModelTestResult;
  at?: string;
}

export function ModelsPage() {
  const { toast, health, refreshHealth } = useApp();
  const [params, setParams] = useSearchParams();
  const models = usePoll(() => api.models(), []);
  const presets = usePoll(() => api.modelProviders(), []);
  const orgs = usePoll(() => api.orgs(), []);
  const [editing, setEditing] = useState<ModelProfileListItem | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ModelProfileListItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const adding = params.get("new") === "1";
  const setAdding = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set("new", "1");
    else next.delete("new");
    setParams(next, { replace: true });
  };

  const list = models.data ?? [];
  const presetById = useMemo(() => new Map((presets.data ?? []).map((p) => [p.id, p])), [presets.data]);
  const byId = useMemo(() => new Map(list.map((p) => [p.id, p as ModelProfile])), [list]);
  // Default first, then by name.
  const sorted = [...list].sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name));
  const onDefault = (orgs.data ?? []).filter((o) => !o.settings.modelProfileId || !byId.has(o.settings.modelProfileId));

  const changed = () => {
    void models.reload();
    void orgs.reload();
    refreshHealth();
  };

  const test = async (p: ModelProfile) => {
    setTests((t) => ({ ...t, [p.id]: { ...t[p.id], busy: true } }));
    try {
      const result = await api.testModel(p.id);
      setTests((t) => ({ ...t, [p.id]: { busy: false, result, at: new Date().toISOString() } }));
    } catch (err) {
      setTests((t) => ({ ...t, [p.id]: { busy: false } }));
      toast(errorMessage(err), "error");
    }
  };

  const makeDefault = async (p: ModelProfile) => {
    setBusy(p.id);
    try {
      await api.updateModel(p.id, { isDefault: true });
      toast(`${p.name} is now Haley's default model.`);
      changed();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(deleting.id);
    setDeleteError(null);
    try {
      await api.deleteModel(deleting.id);
      toast(`${deleting.name} deleted.`);
      setDeleting(null);
      changed();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const ready = aiReady(health);

  return (
    <>
      <PageHeader
        title="AI models"
        subtitle="The language models Haley thinks with: closed or open-weight, hosted or on your own hardware. Pick a default, chain fallbacks, and pin a different model per client."
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)} disabled={!presets.data}>
            <Plus className="icon-sm" aria-hidden="true" /> Add model
          </button>
        }
      />

      {models.error && <ErrorBanner error={models.error} onRetry={models.reload} />}
      {presets.error && <ErrorBanner error={presets.error} onRetry={presets.reload} />}

      <div className="layout-main-side layout-models">
        <div className="stack" style={{ gap: 16 }}>
          {!ready && list.length > 0 && (
            <div className="banner banner-warn" role="status">
              <KeyRound className="icon" aria-hidden="true" />
              <span>
                <strong>The default model has no credentials.</strong> Edit it and add an API key
                {health.defaultModel?.provider === "anthropic" ? <> (or set <code>ANTHROPIC_API_KEY</code> on the server)</> : null}, or make a
                model that has one the default. Runs fail until then.
              </span>
            </div>
          )}

          {models.loading && !models.data ? (
            <div className="card">
              <Loading />
            </div>
          ) : list.length === 0 ? (
            <div className="card">
              <EmptyState
                icon={<BrainCircuit className="icon" />}
                title="No AI models yet"
                actions={
                  <button className="btn btn-primary" onClick={() => setAdding(true)} disabled={!presets.data}>
                    <Plus className="icon-sm" aria-hidden="true" /> Add model
                  </button>
                }
              >
                Haley needs at least one model that can call tools. Add Claude, GPT, Gemini, or an open-weight model on your own hardware.
              </EmptyState>
            </div>
          ) : (
            <div className="model-grid">
              {sorted.map((p) => (
                <ModelCard
                  key={p.id}
                  profile={p}
                  preset={presetById.get(p.provider)}
                  byId={byId}
                  defaultClients={p.is_default ? onDefault : []}
                  missingKey={p.is_default && !ready}
                  test={tests[p.id]}
                  busy={busy === p.id}
                  onTest={() => void test(p)}
                  onMakeDefault={() => void makeDefault(p)}
                  onEdit={() => setEditing(p)}
                  onDelete={() => {
                    setDeleteError(null);
                    setDeleting(p);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="stack">
          <section className="card" aria-labelledby="policy-title">
            <div className="card-header">
              <ShieldCheck className="icon-sm" style={{ color: "var(--tone-green-fg)" }} aria-hidden="true" />
              <h2 id="policy-title">Every model gets the same guardrails</h2>
            </div>
            <div className="card-body stack-sm secondary" style={{ fontSize: "var(--text-sm)" }}>
              <p>
                The model only <em>proposes</em> tool calls. Haley's policy engine decides what actually runs: it checks each call against the
                client's autonomy level, the requester's verified identity, protected accounts and rate limits, and sends everything else to your
                approval queue.
              </p>
              <p>
                So a small self-hosted model and a frontier model are constrained exactly alike: a weaker model may work fewer tickets on its own,
                but it can't do more than the policy allows. Temporary passwords are never shown to any model.
              </p>
            </div>
          </section>
          <section className="card card-pad stack-sm" aria-labelledby="how-title" style={{ fontSize: "var(--text-sm)" }}>
            <h2 id="how-title" style={{ fontSize: "var(--text-md)" }}>
              How Haley picks a model
            </h2>
            <ul className="policy-notes models-notes">
              <li>
                <Star className="icon-xs" aria-hidden="true" />
                <span>
                  Clients use the <strong>default</strong> unless you pick a model on the client's page.
                </span>
              </li>
              <li>
                <Route className="icon-xs" aria-hidden="true" />
                <span>
                  If a model fails (outage, rate limit, bad key), the run continues on its <strong>fallback</strong>, up to four deep.
                </span>
              </li>
              <li>
                <Wrench className="icon-xs" aria-hidden="true" />
                <span>
                  Haley works through tools, so the model must support <strong>tool calling</strong>. <em>Test</em> checks exactly that.
                </span>
              </li>
              <li>
                <KeyRound className="icon-xs" aria-hidden="true" />
                <span>API keys are encrypted at rest and never shown again.</span>
              </li>
            </ul>
          </section>
        </aside>
      </div>

      {presets.data && (
        <ModelDialog
          open={adding || editing !== null}
          profile={editing}
          presets={presets.data}
          profiles={list}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={(saved, created) => {
            toast(created ? `${saved.name} added. Use Test to check it can call tools.` : `${saved.name} saved.`);
            setAdding(false);
            setEditing(null);
            changed();
          }}
        />
      )}

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete ${deleting.name}?` : ""}
        size="narrow"
        footer={
          <>
            <button className="btn" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={() => void remove()} disabled={busy !== null}>
              {busy === deleting?.id && <Spinner />} Delete model
            </button>
          </>
        }
      >
        {deleting && (
          <div className="stack-sm secondary">
            <p>Its stored API key is deleted with it.</p>
            {deleting.usedBy.length > 0 && (
              <p>
                {deleting.usedBy.join(", ")} {deleting.usedBy.length === 1 ? "is" : "are"} pinned to it and will switch to the workspace default.
              </p>
            )}
            {list.some((p) => p.fallback_id === deleting.id) && <p>Models that fall back to it will have no fallback.</p>}
            {deleteError && (
              <div className="banner banner-error" role="alert">
                <CircleAlert className="icon" aria-hidden="true" />
                <span>{deleteError}</span>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

// ------------------------------------------------------------------ card

function KeyState({ profile, preset, missing }: { profile: ModelProfile; preset: ModelProviderPreset | undefined; missing: boolean }) {
  if (profile.has_key)
    return (
      <Pill tone="green" dot title="Stored encrypted; never shown again">
        Key stored
      </Pill>
    );
  if (missing)
    return (
      <Pill tone="amber" dot>
        {profile.provider === "anthropic" ? "Missing: no key and no ANTHROPIC_API_KEY" : "Missing"}
      </Pill>
    );
  if (profile.provider === "anthropic")
    return (
      <Pill tone="neutral" dot title="Uses ANTHROPIC_API_KEY from the server environment">
        Server environment
      </Pill>
    );
  if (preset?.needsKey)
    return (
      <Pill tone="amber" dot>
        Missing
      </Pill>
    );
  return (
    <Pill tone="neutral" title="This endpoint doesn't need a key">
      Not needed
    </Pill>
  );
}

function TestPanel({ state }: { state: TestState }) {
  const r = state.result;
  if (!r) return null;
  const usable = r.ok && r.toolCalling;
  const tone = usable ? "green" : r.ok ? "amber" : "red";
  const Icon = usable ? CircleCheck : r.ok ? TriangleAlert : CircleX;
  return (
    <div className={`model-test tone-${tone}`} role="status">
      <Icon className="icon-sm" aria-hidden="true" />
      <div className="stack-sm" style={{ gap: 3, minWidth: 0, flex: 1 }}>
        <strong>{usable ? "Ready for Haley" : r.ok ? "Not usable for Haley: no tool calling" : "Test failed"}</strong>
        <span className="model-test-detail">{r.detail}</span>
        <span className="model-test-meta">
          <span className={`flow ${r.ok ? "on" : ""}`}>{r.ok ? "Responded" : "No response"}</span>
          <span className={`flow ${r.toolCalling ? "on" : ""}`}>{r.toolCalling ? "Called a tool" : "No tool call"}</span>
          <span>
            <Gauge className="icon-xs" aria-hidden="true" /> {formatNumber(r.latencyMs)} ms
          </span>
          {r.servedBy && <span className="mono">served by {r.servedBy}</span>}
          {state.at && (
            <span>
              tested <RelativeTime iso={state.at} />
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function ModelCard({
  profile: p,
  preset,
  byId,
  defaultClients,
  missingKey,
  test,
  busy,
  onTest,
  onMakeDefault,
  onEdit,
  onDelete,
}: {
  profile: ModelProfileListItem;
  preset: ModelProviderPreset | undefined;
  byId: Map<string, ModelProfile>;
  defaultClients: OrgSummary[];
  missingKey: boolean;
  test: TestState | undefined;
  busy: boolean;
  onTest: () => void;
  onMakeDefault: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const chain = chainOf(p, byId).slice(1);
  const brokenFallback = p.fallback_id && !byId.has(p.fallback_id);
  const endpoint = p.base_url || preset?.baseUrl || "";
  const chips = optionChips(p);

  return (
    <article className={`model-card ${p.is_default ? "is-default" : ""}`} aria-labelledby={`model-${p.id}`}>
      <header className="model-card-head">
        <ModelGlyph preset={preset} provider={p.provider} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 id={`model-${p.id}`} className="truncate" title={p.name}>
            {p.name}
          </h3>
          <div className="row row-wrap" style={{ gap: 6, marginTop: 3 }}>
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {shortProvider(preset, p.provider)}
            </span>
            {preset && <LicensePill license={preset.license} />}
          </div>
        </div>
        {p.is_default && (
          <span className="pill default-badge" title="Clients without their own model use this one">
            <Star className="icon-xs" aria-hidden="true" /> Default
          </span>
        )}
      </header>

      <dl className="props model-props">
        <dt>Model</dt>
        <dd className="mono truncate" title={p.model}>
          {p.model}
        </dd>
        <dt>Endpoint</dt>
        <dd className="mono truncate muted" title={endpoint}>
          {endpoint ? hostOf(endpoint) : "—"}
        </dd>
        <dt>API key</dt>
        <dd>
          <KeyState profile={p} preset={preset} missing={missingKey} />
        </dd>
        <dt>Fallback</dt>
        <dd className="fallback-chain">
          {brokenFallback ? (
            <span className="error-text">Missing fallback model</span>
          ) : chain.length ? (
            chain.map((f) => (
              <span key={f.id} className="row" style={{ gap: 4 }}>
                <ArrowRight className="icon-xs muted" aria-hidden="true" />
                <span className="truncate" title={`${f.provider}/${f.model}`}>
                  {f.name}
                </span>
              </span>
            ))
          ) : (
            <span className="muted">None</span>
          )}
        </dd>
        <dt>Used by</dt>
        <dd className="row row-wrap" style={{ gap: 4 }}>
          {p.is_default && (
            <span className="secondary" style={{ fontSize: "var(--text-sm)" }} title={defaultClients.map((o) => o.name).join(", ")}>
              {defaultClients.length ? `Default for ${defaultClients.length} client${defaultClients.length === 1 ? "" : "s"}` : "Workspace default"}
              {p.usedBy.length ? " ·" : ""}
            </span>
          )}
          {p.usedBy.map((name) => (
            <span key={name} className="tag">
              {name}
            </span>
          ))}
          {!p.is_default && p.usedBy.length === 0 && <span className="muted">No clients</span>}
        </dd>
        {chips.length > 0 && (
          <>
            <dt>Options</dt>
            <dd className="row row-wrap" style={{ gap: 4 }}>
              {chips.map((c) => (
                <span key={c} className="tag">
                  {c}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>

      {test && <TestPanel state={test} />}

      <div className="integration-actions">
        <button className="btn btn-sm" onClick={onTest} disabled={test?.busy} title="Checks the model answers and can call tools">
          {test?.busy ? <Spinner /> : <Wrench className="icon-sm" aria-hidden="true" />} {test?.busy ? "Testing…" : "Test"}
        </button>
        {!p.is_default && (
          <button className="btn btn-sm" onClick={onMakeDefault} disabled={busy}>
            {busy ? <Spinner /> : <Star className="icon-sm" aria-hidden="true" />} Make default
          </button>
        )}
        <button className="btn btn-sm" onClick={onEdit}>
          <Pencil className="icon-sm" aria-hidden="true" /> Edit
        </button>
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost btn-icon" onClick={onDelete} aria-label={`Delete ${p.name}`} title="Delete">
          <Trash className="icon-sm" aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ add / edit dialog

const GROUPS: Array<{ license: ModelLicense; title: string; help: string }> = [
  { license: "closed", title: "Closed models", help: "Hosted proprietary models." },
  { license: "open", title: "Open-weight & self-hosted", help: "Open models from a host, or on your own hardware." },
  { license: "both", title: "Other", help: "Gateways and anything that speaks the OpenAI chat API." },
];

interface Draft {
  provider: ModelProviderKind | null;
  name: string;
  nameTouched: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  clearKey: boolean;
  fallbackId: string;
  isDefault: boolean;
  maxTokens: string;
  effort: ModelEffort | "";
  refusalFallbacks: boolean;
  temperature: string;
  tokenParam: "" | "max_tokens" | "max_completion_tokens";
  reasoningEffort: string;
  apiVersion: string;
}

function draftFor(profile: ModelProfile | null, preset: ModelProviderPreset | undefined): Draft {
  const o = profile?.options ?? {};
  return {
    provider: profile?.provider ?? null,
    name: profile?.name ?? "",
    nameTouched: Boolean(profile),
    baseUrl: profile ? profile.base_url || preset?.baseUrl || "" : "",
    model: profile?.model ?? "",
    apiKey: "",
    clearKey: false,
    fallbackId: profile?.fallback_id ?? "",
    isDefault: false,
    maxTokens: o.maxTokens ? String(o.maxTokens) : "",
    effort: o.effort ?? "",
    refusalFallbacks: o.refusalFallbacks ?? true,
    temperature: o.temperature !== undefined ? String(o.temperature) : "",
    tokenParam: o.tokenParam ?? "",
    reasoningEffort: o.reasoningEffort ?? "",
    apiVersion: o.apiVersion ?? "",
  };
}

function autoName(preset: ModelProviderPreset | undefined, model: string): string {
  const provider = preset ? shortProvider(preset, preset.id) : "";
  if (!model.trim()) return provider;
  return preset?.id === "openai_compatible" ? model.trim() : `${provider} · ${model.trim()}`;
}

function ModelDialog({
  open,
  profile,
  presets,
  profiles,
  onClose,
  onSaved,
}: {
  open: boolean;
  profile: ModelProfileListItem | null;
  presets: ModelProviderPreset[];
  profiles: ModelProfileListItem[];
  onClose: () => void;
  onSaved: (saved: ModelProfile, created: boolean) => void;
}) {
  const editing = profile !== null;
  const [d, setD] = useState<Draft>(() => draftFor(profile, undefined));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setD(draftFor(profile, profile ? presets.find((p) => p.id === profile.provider) : undefined));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile?.id]);

  const preset = presets.find((p) => p.id === d.provider);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));
  const setModel = (model: string) => setD((cur) => ({ ...cur, model, name: cur.nameTouched ? cur.name : autoName(preset, model) }));

  const choose = (p: ModelProviderPreset) =>
    setD((cur) => ({
      ...draftFor(null, p),
      provider: p.id,
      baseUrl: p.baseUrl,
      name: cur.nameTouched ? cur.name : autoName(p, ""),
      nameTouched: cur.nameTouched,
      fallbackId: cur.fallbackId,
      isDefault: cur.isDefault,
    }));

  // A fallback can't be this model or anything that (eventually) falls back to it.
  const byId = new Map(profiles.map((p) => [p.id, p as ModelProfile]));
  const fallbackChoices = profiles.filter((p) => !profile || (p.id !== profile.id && !chainOf(p, byId, 16).some((x) => x.id === profile.id)));

  const anthropic = d.provider === "anthropic";
  const azure = d.provider === "azure_openai";
  const baseRequired = Boolean(preset && !preset.baseUrl);
  const firstParty = anthropic && (!d.baseUrl.trim() || d.baseUrl.trim().replace(/\/+$/, "") === preset?.baseUrl);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!preset) return setError("Choose a provider.");
    if (!d.model.trim()) return setError("Enter the model id.");
    if (baseRequired && !d.baseUrl.trim()) return setError(`${preset.name} needs a base URL.`);
    if (d.baseUrl.trim()) {
      try {
        new URL(d.baseUrl.trim());
      } catch {
        return setError("The base URL isn't a valid URL (include https:// or http://).");
      }
    }
    const options: ModelOptions = profile?.options?.extraHeaders ? { extraHeaders: profile.options.extraHeaders } : {};
    if (d.maxTokens.trim()) {
      const n = Number(d.maxTokens);
      if (!Number.isInteger(n) || n < 256 || n > 200_000) return setError("Max tokens must be a whole number between 256 and 200,000.");
      options.maxTokens = n;
    }
    if (anthropic) {
      if (d.effort) options.effort = d.effort;
      options.refusalFallbacks = d.refusalFallbacks;
    } else {
      if (d.temperature.trim()) {
        const t = Number(d.temperature);
        if (Number.isNaN(t) || t < 0 || t > 2) return setError("Temperature must be between 0 and 2.");
        options.temperature = t;
      }
      if (d.tokenParam) options.tokenParam = d.tokenParam;
      if (d.reasoningEffort) options.reasoningEffort = d.reasoningEffort;
      if (azure && d.apiVersion.trim()) options.apiVersion = d.apiVersion.trim();
    }
    const name = d.name.trim() || autoName(preset, d.model);
    setBusy(true);
    setError(null);
    try {
      if (profile) {
        const saved = await api.updateModel(profile.id, {
          name,
          model: d.model.trim(),
          baseUrl: d.baseUrl.trim(),
          ...(d.clearKey ? { apiKey: "" } : d.apiKey ? { apiKey: d.apiKey } : {}),
          options,
          fallbackId: d.fallbackId || null,
          ...(d.isDefault ? { isDefault: true as const } : {}),
        });
        onSaved(saved, false);
      } else {
        const saved = await api.createModel({
          name,
          provider: preset.id,
          model: d.model.trim(),
          baseUrl: d.baseUrl.trim(),
          apiKey: d.apiKey,
          options,
          fallbackId: d.fallbackId || null,
          isDefault: d.isDefault,
        });
        onSaved(saved, true);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={profile ? `Edit ${profile.name}` : "Add AI model"}
      size="wide"
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="model-form" disabled={!preset || busy}>
            {busy ? <Spinner /> : editing ? null : <Plus className="icon-sm" aria-hidden="true" />} {editing ? "Save" : "Add model"}
          </button>
        </>
      }
    >
      <form id="model-form" className="stack" onSubmit={submit} noValidate>
        {!editing ? (
          GROUPS.map((g) => {
            const items = presets.filter((p) => p.license === g.license);
            if (!items.length) return null;
            return (
              <div className="field" key={g.license}>
                <span className="field-label">{g.title}</span>
                <span className="help" style={{ marginTop: -3 }}>
                  {g.help}
                </span>
                <div className="choice-grid provider-grid" role="radiogroup" aria-label={g.title}>
                  {items.map((p) => (
                    <button key={p.id} type="button" role="radio" aria-checked={d.provider === p.id} className="choice choice-compact" onClick={() => choose(p)}>
                      <span className="choice-title">
                        <ModelGlyph preset={p} provider={p.id} />
                        <span className="truncate">{shortProvider(p, p.id)}</span>
                      </span>
                      <span className="choice-desc truncate">{p.baseUrl ? hostOf(p.baseUrl) : "Your endpoint"}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })
        ) : (
          preset && (
            <div className="row" style={{ gap: 10 }}>
              <ModelGlyph preset={preset} provider={preset.id} />
              <div>
                <div style={{ fontWeight: 600 }}>{preset.name}</div>
                <div className="row" style={{ gap: 6 }}>
                  <LicensePill license={preset.license} />
                  <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                    The provider can't be changed; add a new model instead.
                  </span>
                </div>
              </div>
            </div>
          )
        )}

        {preset && (
          <>
            {preset.notes && (
              <div className="banner banner-info">
                <BrainCircuit className="icon" aria-hidden="true" />
                <span>{preset.notes}</span>
              </div>
            )}

            <div className="form-grid">
              <div className="field span-2">
                <label htmlFor="md-model">Model id</label>
                <input
                  id="md-model"
                  className="input mono"
                  value={d.model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={preset.exampleModels[0] ?? "model-name"}
                  spellCheck={false}
                  autoComplete="off"
                  required
                />
                {preset.exampleModels.length > 0 && (
                  <div className="row row-wrap" style={{ gap: 6 }}>
                    <span className="help">Examples:</span>
                    {preset.exampleModels.map((m) => (
                      <button key={m} type="button" className={`chip chip-button chip-mono ${d.model === m ? "is-on" : ""}`} onClick={() => setModel(m)}>
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="field">
                <label htmlFor="md-name">Display name</label>
                <input id="md-name" className="input" value={d.name} onChange={(e) => set({ name: e.target.value, nameTouched: true })} autoComplete="off" />
              </div>

              <div className="field">
                <label htmlFor="md-base">
                  Base URL {!baseRequired && <span className="muted">(optional)</span>}
                </label>
                <input
                  id="md-base"
                  className="input mono"
                  value={d.baseUrl}
                  onChange={(e) => set({ baseUrl: e.target.value })}
                  placeholder={azure ? "https://NAME.openai.azure.com" : preset.baseUrl || "https://gateway.example.com/v1"}
                  spellCheck={false}
                  autoComplete="off"
                  required={baseRequired}
                />
                <span className="help">
                  {baseRequired
                    ? azure
                      ? "Required: your Azure OpenAI resource endpoint."
                      : "Required: the endpoint that serves /chat/completions."
                    : preset.baseUrl
                      ? "Change it for a proxy or gateway in front of the provider."
                      : ""}
                </span>
              </div>

              <div className="field">
                <label htmlFor="md-key">
                  API key{" "}
                  {!preset.needsKey && (
                    <span className="muted">
                      (optional{anthropic ? ": falls back to ANTHROPIC_API_KEY" : ""})
                    </span>
                  )}
                </label>
                <input
                  id="md-key"
                  className="input"
                  type="password"
                  value={d.apiKey}
                  onChange={(e) => set({ apiKey: e.target.value })}
                  placeholder={profile?.has_key ? "Stored. Leave blank to keep it" : preset.needsKey ? "Required to call the API" : "Not needed for most local servers"}
                  disabled={d.clearKey}
                  autoComplete="new-password"
                  spellCheck={false}
                />
                {profile?.has_key ? (
                  <label className="checkbox" style={{ fontSize: "var(--text-sm)" }}>
                    <input type="checkbox" checked={d.clearKey} onChange={(e) => set({ clearKey: e.target.checked, apiKey: "" })} />
                    Clear the stored key
                    {anthropic ? " (use ANTHROPIC_API_KEY instead)" : ""}
                  </label>
                ) : (
                  <span className="help">Encrypted at rest; never shown again.</span>
                )}
              </div>

              <div className="field">
                <label htmlFor="md-fallback">Fallback model</label>
                <select id="md-fallback" className="select" value={d.fallbackId} onChange={(e) => set({ fallbackId: e.target.value })}>
                  <option value="">No fallback</option>
                  {fallbackChoices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.model})
                    </option>
                  ))}
                </select>
                <span className="help">Used when this model errors: outage, rate limit or a bad key.</span>
              </div>
            </div>

            <fieldset className="options-fieldset">
              <legend className="settings-legend">{anthropic ? "Claude options" : azure ? "Azure OpenAI options" : "OpenAI-compatible options"}</legend>
              <div className="form-grid">
                {anthropic && (
                  <div className="field span-2">
                    <span className="field-label" id="md-effort">
                      Effort
                    </span>
                    <div className="segmented segmented-wrap" role="group" aria-labelledby="md-effort">
                      <button type="button" aria-pressed={d.effort === ""} onClick={() => set({ effort: "" })}>
                        Default
                      </button>
                      {MODEL_EFFORTS.map((e) => (
                        <button key={e} type="button" aria-pressed={d.effort === e} onClick={() => set({ effort: e })}>
                          {EFFORT_LABEL[e]}
                        </button>
                      ))}
                    </div>
                    <span className="help">How much the model thinks before acting. Higher is slower and costs more, and handles messy tickets better.</span>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="md-max">
                    Max tokens <span className="muted">(optional)</span>
                  </label>
                  <input
                    id="md-max"
                    className="input num"
                    inputMode="numeric"
                    value={d.maxTokens}
                    onChange={(e) => set({ maxTokens: e.target.value.replace(/[^\d]/g, "") })}
                    placeholder="Provider default"
                  />
                  <span className="help">Per response, 256–200,000.</span>
                </div>
                {anthropic ? (
                  <div className="field">
                    <span className="field-label" id="md-refusal">
                      Refusal fallbacks
                    </span>
                    <div className="row" style={{ gap: 8, minHeight: 32 }}>
                      <Switch
                        checked={d.refusalFallbacks && firstParty}
                        onChange={(v) => set({ refusalFallbacks: v })}
                        label="Refusal fallbacks"
                        disabled={!firstParty}
                      />
                      <span className="secondary" style={{ fontSize: "var(--text-sm)" }}>
                        {firstParty ? (d.refusalFallbacks ? "On" : "Off") : "Only on the first-party Claude API"}
                      </span>
                    </div>
                    <span className="help">If Claude declines a request, the API retries it on a fallback Claude model.</span>
                  </div>
                ) : (
                  <>
                    <div className="field">
                      <label htmlFor="md-tokparam">Token parameter</label>
                      <select id="md-tokparam" className="select" value={d.tokenParam} onChange={(e) => set({ tokenParam: e.target.value as Draft["tokenParam"] })}>
                        <option value="">Default (max_tokens)</option>
                        <option value="max_tokens">max_tokens</option>
                        <option value="max_completion_tokens">max_completion_tokens</option>
                      </select>
                      <span className="help">Newer OpenAI reasoning models need max_completion_tokens.</span>
                    </div>
                    <div className="field">
                      <label htmlFor="md-temp">
                        Temperature <span className="muted">(optional)</span>
                      </label>
                      <input
                        id="md-temp"
                        className="input num"
                        inputMode="decimal"
                        value={d.temperature}
                        onChange={(e) => set({ temperature: e.target.value.replace(/[^\d.]/g, "") })}
                        placeholder="Provider default"
                      />
                      <span className="help">0–2. Leave empty for reasoning models that reject it.</span>
                    </div>
                    <div className="field">
                      <label htmlFor="md-reason">Reasoning effort</label>
                      <select id="md-reason" className="select" value={d.reasoningEffort} onChange={(e) => set({ reasoningEffort: e.target.value })}>
                        <option value="">Not sent</option>
                        {["minimal", "low", "medium", "high"].map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                        {d.reasoningEffort && !["minimal", "low", "medium", "high"].includes(d.reasoningEffort) && (
                          <option value={d.reasoningEffort}>{d.reasoningEffort}</option>
                        )}
                      </select>
                      <span className="help">For reasoning models (o-series, GPT-5, DeepSeek R1…).</span>
                    </div>
                    {azure && (
                      <div className="field">
                        <label htmlFor="md-apiver">API version</label>
                        <input
                          id="md-apiver"
                          className="input mono"
                          value={d.apiVersion}
                          onChange={(e) => set({ apiVersion: e.target.value })}
                          placeholder="2024-10-21"
                          spellCheck={false}
                        />
                        <span className="help">Azure OpenAI api-version query parameter.</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </fieldset>

            {!profile?.is_default && (
              <label className="checkbox">
                <input type="checkbox" checked={d.isDefault} onChange={(e) => set({ isDefault: e.target.checked })} />
                <Star className="icon-sm" aria-hidden="true" style={{ color: "var(--tone-amber-dot)" }} />
                Make this Haley's default model
                {!editing && profiles.length === 0 && <span className="muted">(automatic for the first model)</span>}
              </label>
            )}
          </>
        )}

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {editing && (
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            Changes apply to the next model call, including runs already in progress. <Link to="/runs">Runs</Link> show which model served them.
          </p>
        )}
      </form>
    </Modal>
  );
}
