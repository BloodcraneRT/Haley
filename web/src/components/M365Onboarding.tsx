import { ExternalLink, KeyRound, Link2, Radar, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, errorMessage, type Integration, type M365Discovery, type M365OnboardingInfo, type OrgDetail } from "../api";
import { useApp } from "../lib/app-context";
import { CopyButton } from "./CopyButton";
import { Disclosure } from "./Disclosure";
import { Spinner } from "./Feedback";
import { Pill } from "./Pill";
import { ProviderLogo } from "./ProviderLogo";
import { RelativeTime } from "./RelativeTime";

// ------------------------------------------------------------------ admin consent

/** Matches the server's check: a tenant GUID or a domain. */
const TENANT_RE = /^([0-9a-f-]{36}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/;

/** One-click onboarding: the client's Global Admin (or a GDAP partner admin) approves Haley's multi-tenant app. */
export function ConsentConnect({ org, info }: { org: OrgDetail; info: M365OnboardingInfo }) {
  const [tenant, setTenant] = useState("");
  const [busy, setBusy] = useState<"go" | "link" | null>(null);
  const [link, setLink] = useState<{ url: string; expiresInMinutes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = async (kind: "go" | "link") => {
    const t = tenant.trim().toLowerCase();
    if (t && !TENANT_RE.test(t)) return setError("Use the customer's tenant ID or a verified domain, like fabrikam.onmicrosoft.com.");
    setBusy(kind);
    setError(null);
    try {
      const result = await api.m365ConsentLink(org.id, tenant);
      if (kind === "go") {
        // Microsoft sends the browser back to this page with ?m365=connected or ?m365=error.
        window.location.assign(result.url);
        return;
      }
      setLink(result);
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(null);
  };

  return (
    <div className="consent-card">
      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <ProviderLogo provider="m365" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row row-wrap" style={{ gap: 8 }}>
            <strong>Connect Microsoft 365 with admin consent</strong>
            <Pill tone="green">Recommended</Pill>
          </div>
          <p className="muted" style={{ fontSize: "var(--text-sm)", marginTop: 2 }}>
            {org.name}'s Global Admin approves Haley once. No app registration or secrets to copy. You can still connect manually instead.
          </p>
        </div>
      </div>

      <div className="consent-grid">
        <div className="field">
          <label htmlFor="consent-tenant">
            Customer tenant (for GDAP) <span className="muted">(optional)</span>
          </label>
          <input
            id="consent-tenant"
            className="input mono"
            value={tenant}
            onChange={(e) => {
              setTenant(e.target.value);
              setLink(null);
              setError(null);
            }}
            placeholder={org.domain ? `${org.domain.split(".")[0]}.onmicrosoft.com` : "Tenant ID or domain"}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="help">Only needed if you're consenting as your partner admin through GDAP.</span>
        </div>
        <div className="consent-actions">
          <button className="btn btn-primary" onClick={() => void request("go")} disabled={busy !== null}>
            {busy === "go" ? <Spinner /> : <ShieldCheck className="icon-sm" aria-hidden="true" />} Connect with admin consent
          </button>
          <button className="btn" onClick={() => void request("link")} disabled={busy !== null}>
            {busy === "link" ? <Spinner /> : <Link2 className="icon-sm" aria-hidden="true" />} Get link for their admin
          </button>
        </div>
      </div>

      {link && (
        <div className="stack-sm">
          <div className="copy-field">
            <code className="truncate" title={link.url}>
              {link.url}
            </code>
            <CopyButton value={link.url} label="Copy link" />
            <a className="btn btn-sm btn-ghost btn-icon" href={link.url} target="_blank" rel="noreferrer" aria-label="Open consent page in a new tab" title="Open">
              <ExternalLink className="icon-sm" aria-hidden="true" />
            </a>
          </div>
          <span className="help">Send this to {org.name}'s Global Admin. It expires in {link.expiresInMinutes} minutes.</span>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {info.permissions.length > 0 && (
        <Disclosure summary={`Permissions Haley asks for (${info.permissions.length})`}>
          <div className="row row-wrap" style={{ gap: 6 }}>
            {info.permissions.map((p) => (
              <span key={p} className="chip chip-mono">
                {p}
              </span>
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

/** Shown instead of the consent card when the MSP app isn't configured on the server. */
export function ConsentUnavailableNote() {
  return (
    <div className="verify-strip">
      <KeyRound className="icon-sm muted" aria-hidden="true" />
      <span className="spacer">
        <strong>One-click Microsoft 365 consent is off.</strong> Set <code className="env-var">HALEY_M365_CLIENT_ID</code> and{" "}
        <code className="env-var">HALEY_M365_CLIENT_SECRET</code> on the server to turn it on. See docs/M365_ONBOARDING.md.
      </span>
    </div>
  );
}

/** Outcome of the admin-consent redirect (?m365=connected|error&detail=…). */
export function ConsentResultBanner({ result, onDismiss }: { result: { ok: boolean; detail: string }; onDismiss: () => void }) {
  const tone = !result.ok ? "banner-error" : result.detail ? "banner-warn" : "banner-success";
  return (
    <div className={`banner ${tone} consent-result`} role={result.ok ? "status" : "alert"}>
      {result.ok && !result.detail ? <ShieldCheck className="icon" aria-hidden="true" /> : <TriangleAlert className="icon" aria-hidden="true" />}
      <span className="spacer">
        <strong>{result.ok ? "Microsoft 365 connected." : "Microsoft 365 wasn't connected."}</strong>{" "}
        {result.detail || (result.ok ? "Haley ran a tenant discovery; review the suggested settings below." : "")}
      </span>
      <button className="btn btn-sm btn-ghost" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ discovery

/** The last tenant discovery for an m365 integration, and a way to run a new one. */
export function useDiscovery(integration: Integration | undefined) {
  const { toast } = useApp();
  const id = integration?.id;
  const [data, setData] = useState<M365Discovery | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setData(null);
    if (!id) return;
    let live = true;
    api.m365Discovery(id).then(
      (d) => live && setData(d),
      (err) => {
        // 404: never discovered.
        if (live && !(err instanceof ApiError && err.status === 404)) toast(errorMessage(err), "error");
      },
    );
    return () => {
      live = false;
    };
  }, [id, toast]);

  const run = useCallback(async () => {
    if (!id) return;
    setRunning(true);
    try {
      const d = await api.discoverM365(id);
      setData(d);
      toast(`Discovered ${d.organization || "the tenant"}.`);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setRunning(false);
    }
  }, [id, toast]);

  return { data, running, run };
}

const fmt = new Intl.NumberFormat();

/** What discovery found in the tenant, plus settings Haley suggests from it. */
export function DiscoveryPanel({
  org,
  discovery: d,
  running,
  onRerun,
  onApplied,
}: {
  org: OrgDetail;
  discovery: M365Discovery;
  running: boolean;
  onRerun: () => void;
  onApplied: () => void;
}) {
  const licensed = d.licenses.filter((l) => l.purchased > 0 || l.assigned > 0);
  return (
    <section className="card discovery" aria-labelledby="disc-title">
      <div className="card-header">
        <Radar className="icon-sm" style={{ color: "var(--accent-text)" }} aria-hidden="true" />
        <h2 id="disc-title">Tenant discovery</h2>
        <span className="muted hide-sm truncate" style={{ fontSize: "var(--text-sm)" }}>
          {d.organization} · <RelativeTime iso={d.discoveredAt} />
        </span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={onRerun} disabled={running}>
          {running ? <Spinner /> : <RefreshCw className="icon-sm" aria-hidden="true" />} Run again
        </button>
      </div>
      <div className="card-body stack">
        {d.warnings.length > 0 && (
          <div className="banner banner-warn" role="note">
            <TriangleAlert className="icon" aria-hidden="true" />
            <div className="stack-sm" style={{ gap: 2 }}>
              <strong>Some things couldn't be read.</strong>
              <ul className="plain-list">
                {d.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <dl className="discovery-stats">
          <div>
            <dt>Users</dt>
            <dd className="num">
              {fmt.format(d.users.total)}
              {d.users.truncated && "+"}
            </dd>
            <span>{fmt.format(d.users.enabled)} enabled</span>
          </div>
          <div>
            <dt>Licensed</dt>
            <dd className="num">{fmt.format(d.users.licensed)}</dd>
            <span>{d.users.total ? Math.round((d.users.licensed / d.users.total) * 100) : 0}% of users</span>
          </div>
          <div>
            <dt>Intune devices</dt>
            <dd className="num">{d.devices ? fmt.format(d.devices.total) : "—"}</dd>
            <span title={d.devices ? `${d.devices.staleOver30Days} not synced in 30+ days` : undefined}>
              {d.devices ? `${d.devices.noncompliant} noncompliant · ${d.devices.staleOver30Days} stale` : "Not available"}
            </span>
          </div>
          <div>
            <dt>Admins</dt>
            <dd className="num">{new Set(d.admins.map((a) => a.userPrincipalName)).size}</dd>
            <span>
              {d.admins.length} role assignment{d.admins.length === 1 ? "" : "s"}
            </span>
          </div>
        </dl>
        {d.users.truncated && <span className="help">Haley read the first {fmt.format(d.users.total)} users; counts are a floor.</span>}

        <div className="field">
          <span className="field-label">Verified domains</span>
          <div className="row row-wrap" style={{ gap: 6 }}>
            {d.domains.map((dom) => (
              <span key={dom} className="chip chip-mono">
                {dom}
              </span>
            ))}
          </div>
        </div>

        <div className="grid-2 discovery-tables">
          <div className="field">
            <span className="field-label">Licenses</span>
            {licensed.length === 0 ? (
              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                No licenses found.
              </span>
            ) : (
              <div className="table-wrap discovery-table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col" className="sku">
                        SKU
                      </th>
                      <th scope="col" className="col-num">
                        Assigned
                      </th>
                      <th scope="col" className="col-num">
                        Purchased
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {licensed.map((l) => (
                      <tr key={l.sku}>
                        <td className="sku mono truncate" title={l.sku}>
                          {l.sku}
                        </td>
                        <td className={`col-num num ${l.assigned > l.purchased ? "over" : ""}`}>{fmt.format(l.assigned)}</td>
                        <td className="col-num num">{fmt.format(l.purchased)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="field">
            <span className="field-label">Admin roles</span>
            {d.admins.length === 0 ? (
              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                No admins found.
              </span>
            ) : (
              <ul className="list discovery-admins">
                {d.admins.map((a) => (
                  <li key={`${a.role}:${a.userPrincipalName}`}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="truncate" style={{ fontWeight: 520 }}>
                        {a.displayName || a.userPrincipalName}
                      </div>
                      <div className="muted mono truncate" style={{ fontSize: "var(--text-xs)" }}>
                        {a.userPrincipalName}
                      </div>
                    </div>
                    <Pill tone="violet">{a.role}</Pill>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <SuggestedSettings org={org} discovery={d} onApplied={onApplied} />
      </div>
    </section>
  );
}

type SuggestionKey = "emailDomains" | "teamsTenantId" | "protectedAccounts";

function SuggestedSettings({ org, discovery: d, onApplied }: { org: OrgDetail; discovery: M365Discovery; onApplied: () => void }) {
  const { toast } = useApp();
  const s = org.settings;
  const newDomains = d.suggestions.emailDomains.filter((x) => !s.emailDomains.includes(x.toLowerCase()));
  const newProtected = d.suggestions.protectedAccounts.filter((x) => !s.protectedAccounts.includes(x.toLowerCase()));
  const tenant = d.suggestions.teamsTenantId;
  const tenantSet = Boolean(tenant) && s.teamsTenantId.toLowerCase() === tenant.toLowerCase();
  const tenantReplaces = Boolean(tenant) && !tenantSet && Boolean(s.teamsTenantId);

  const available: Record<SuggestionKey, boolean> = useMemo(
    () => ({ emailDomains: newDomains.length > 0, teamsTenantId: Boolean(tenant) && !tenantSet, protectedAccounts: newProtected.length > 0 }),
    [newDomains.length, tenant, tenantSet, newProtected.length],
  );
  // Pre-check whatever only adds; replacing a Teams tenant someone typed in is opt-in.
  const defaults = (): Record<SuggestionKey, boolean> => ({
    emailDomains: available.emailDomains,
    teamsTenantId: available.teamsTenantId && !tenantReplaces,
    protectedAccounts: available.protectedAccounts,
  });
  const [pick, setPick] = useState(defaults);
  const [busy, setBusy] = useState(false);
  const key = `${available.emailDomains}|${available.teamsTenantId}|${available.protectedAccounts}|${tenantReplaces}`;
  useEffect(() => setPick(defaults()), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const anything = Object.values(available).some(Boolean);
  const chosen = (Object.keys(pick) as SuggestionKey[]).filter((k) => pick[k] && available[k]);

  const apply = async () => {
    setBusy(true);
    try {
      await api.applyM365Discovery(org.id, Object.fromEntries(chosen.map((k) => [k, true])));
      toast("Suggested settings applied.");
      onApplied();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const rows: Array<{ key: SuggestionKey; label: string; help: string; values: string[]; none: string }> = [
    {
      key: "emailDomains",
      label: "Email domains",
      help: "Route email, chat and API requests from these domains here.",
      values: newDomains,
      none: "All verified domains are already listed.",
    },
    {
      key: "teamsTenantId",
      label: "Teams tenant",
      help: tenantReplaces ? `Replaces ${s.teamsTenantId}.` : "Route Microsoft Teams messages from this tenant here.",
      values: tenant && !tenantSet ? [tenant] : [],
      none: tenant ? "Already set." : "No tenant ID found.",
    },
    {
      key: "protectedAccounts",
      label: "Protected accounts",
      help: "Admins found in the tenant. Haley never changes these without a technician.",
      values: newProtected,
      none: "Every admin is already protected.",
    },
  ];

  return (
    <div className="suggested">
      <div className="suggested-head">
        <strong>Suggested settings</strong>
        <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {anything ? "Adds to the client's settings; nothing is removed." : "Everything discovery suggests is already applied."}
        </span>
      </div>
      <ul className="suggested-list">
        {rows.map((r) => (
          <li key={r.key}>
            <label className={`checkbox ${available[r.key] ? "" : "is-disabled"}`}>
              <input
                type="checkbox"
                checked={available[r.key] && pick[r.key]}
                disabled={!available[r.key] || busy}
                onChange={(e) => setPick((p) => ({ ...p, [r.key]: e.target.checked }))}
              />
              <span className="suggested-label">{r.label}</span>
            </label>
            <div className="suggested-detail">
              {r.values.length ? (
                <div className="row row-wrap" style={{ gap: 5 }}>
                  {r.values.map((v) => (
                    <span key={v} className="chip chip-mono">
                      + {v}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="muted">{r.none}</span>
              )}
              {r.values.length > 0 && <span className="help">{r.help}</span>}
            </div>
          </li>
        ))}
      </ul>
      {anything && (
        <div className="suggested-foot">
          <button className="btn btn-primary btn-sm" onClick={() => void apply()} disabled={busy || chosen.length === 0}>
            {busy && <Spinner />} Apply {chosen.length ? `${chosen.length} setting${chosen.length === 1 ? "" : "s"}` : ""}
          </button>
        </div>
      )}
    </div>
  );
}
