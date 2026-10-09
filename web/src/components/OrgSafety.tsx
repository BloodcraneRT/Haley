import { CirclePause, CirclePlay, OctagonPause, Plus, X } from "lucide-react";
import { useId, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage, TICKET_PRIORITIES, type OrgDetail, type OrgSettings, type TicketPriority } from "../api";
import { useApp } from "../lib/app-context";
import { useDraft } from "../hooks/useDraft";
import { formatMinutes, PRIORITY_META } from "../lib/format";
import { Spinner } from "./Feedback";
import { Modal } from "./Modal";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/;

// ------------------------------------------------------------------ kill switch

/** Pauses or resumes Haley for one client. Pausing asks for confirmation. */
export function usePauseControl(org: OrgDetail | undefined, onChanged: () => void) {
  const { toast, refreshStats } = useApp();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = async (paused: boolean) => {
    if (!org) return;
    setBusy(true);
    try {
      await api.updateOrg(org.id, { settings: { paused } });
      toast(paused ? `Haley is paused for ${org.name}. New requests go to your technicians.` : `Haley is back on for ${org.name}.`);
      setConfirming(false);
      refreshStats();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const dialog = org && (
    <Modal
      open={confirming}
      onClose={() => setConfirming(false)}
      title={`Pause Haley for ${org.name}?`}
      size="narrow"
      footer={
        <>
          <button className="btn" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={() => void set(true)} disabled={busy}>
            {busy ? <Spinner /> : <OctagonPause className="icon-sm" aria-hidden="true" />} Pause Haley
          </button>
        </>
      }
    >
      <div className="stack-sm secondary">
        <p>This is the kill switch. Until you resume her:</p>
        <ul className="plain-list">
          <li>Haley won't start work on {org.name}'s tickets or tasks, and scheduled runs are skipped.</li>
          <li>New requests from end users are acknowledged and left unassigned for your technicians.</li>
          <li>Runs already waiting on approval stay in the queue.</li>
        </ul>
        <p>The change is recorded in the audit log.</p>
      </div>
    </Modal>
  );

  return { paused: Boolean(org?.settings.paused), busy, askToPause: () => setConfirming(true), resume: () => void set(false), dialog };
}

/** Full-width notice shown on the client page while Haley is paused there. */
export function PausedBanner({ orgName, onResume, busy }: { orgName: string; onResume: () => void; busy: boolean }) {
  return (
    <div className="banner banner-error paused-banner" role="status">
      <OctagonPause className="icon" aria-hidden="true" />
      <span className="spacer">
        <strong>Haley is paused for {orgName}.</strong> She won't act on tickets, tasks or schedules here. End users are told a technician has their
        request, and new tickets are left unassigned.
      </span>
      <button className="btn btn-sm" onClick={onResume} disabled={busy}>
        {busy ? <Spinner /> : <CirclePlay className="icon-sm" aria-hidden="true" />} Resume Haley
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ list editor

export type ListKind = "email" | "domain" | "account" | "tool" | "text" | "phone";

/** How each kind of list splits pasted text, normalizes and validates entries. */
const LIST_KINDS: Record<ListKind, { split: RegExp; normalize: (v: string) => string; valid?: RegExp; noun: string }> = {
  email: { split: /[\s,;]+/, normalize: (v) => v.toLowerCase(), valid: EMAIL_RE, noun: "a valid email address" },
  domain: { split: /[\s,;]+/, normalize: (v) => v.toLowerCase().replace(/^@/, ""), valid: DOMAIN_RE, noun: "a valid domain" },
  // Policy rule account patterns: an address, "*@domain", "@domain" or "*".
  account: {
    split: /[\s,;]+/,
    normalize: (v) => v.toLowerCase(),
    valid: /^(\*|\*?@[^\s@*]+\.[^\s@*]+|[^\s@*]+@[^\s@*]+\.[^\s@*]+)$/,
    noun: "an address, *@domain or @domain",
  },
  tool: { split: /[\s,;]+/, normalize: (v) => v.toLowerCase(), valid: /^[a-z0-9_*-]+$/, noun: "a tool name (letters, digits, _ and *)" },
  phone: { split: /[,;\n]+/, normalize: (v) => v.replace(/\s+/g, " "), valid: /^\+?[\d\s().-]{7,20}$/, noun: "a phone number like +1 425 555 0100" },
  // Free text such as departments or people's names: only commas and semicolons separate.
  text: { split: /[,;\n]+/, normalize: (v) => v.replace(/\s+/g, " "), noun: "valid" },
};

/** Edits a list of emails or domains as removable chips. Enter, comma or paste adds. */
export function ListEditor({
  id,
  label,
  help,
  values,
  onChange,
  kind,
  placeholder,
  suggestions,
}: {
  id: string;
  label: string;
  help?: string;
  values: string[];
  onChange: (values: string[]) => void;
  kind: ListKind;
  placeholder?: string;
  /** Offered as autocomplete options. */
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const helpId = useId();
  const listId = useId();
  const spec = LIST_KINDS[kind];

  const add = (raw: string) => {
    const items = raw
      .split(spec.split)
      .map((v) => spec.normalize(v.trim()))
      .filter(Boolean);
    if (!items.length) return;
    const bad = spec.valid ? items.filter((v) => !spec.valid!.test(v)) : [];
    if (bad.length) {
      setError(`${bad.join(", ")} ${bad.length === 1 ? "isn't" : "aren't"} ${spec.noun}.`);
      return;
    }
    onChange([...new Set([...values, ...items])]);
    setDraft("");
    setError(null);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="list-editor">
        {values.length > 0 && (
          <ul className="list-editor-chips" aria-label={label}>
            {values.map((v) => (
              <li key={v} className="chip chip-removable">
                <span className="truncate">{v}</span>
                <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
                  <X className="icon-xs" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="row" style={{ gap: 6 }}>
          <input
            id={id}
            className="input input-sm"
            type="text"
            inputMode={kind === "email" ? "email" : kind === "domain" ? "url" : "text"}
            value={draft}
            placeholder={placeholder}
            list={suggestions?.length ? listId : undefined}
            aria-describedby={helpId}
            aria-invalid={Boolean(error)}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={onKey}
            onBlur={() => draft.trim() && add(draft)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (spec.split.test(text.trim())) {
                e.preventDefault();
                add(text);
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="btn btn-sm" onClick={() => add(draft)} disabled={!draft.trim()}>
            <Plus className="icon-sm" aria-hidden="true" /> Add
          </button>
        </div>
        {suggestions && suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions
              .filter((v) => !values.includes(v))
              .map((v) => (
                <option key={v} value={v} />
              ))}
          </datalist>
        )}
      </div>
      {error ? (
        <span className="error-text" role="alert" id={helpId}>
          {error}
        </span>
      ) : (
        help && (
          <span className="help" id={helpId}>
            {help}
          </span>
        )
      )}
    </div>
  );
}

// ------------------------------------------------------------------ settings form

// The kill switch, AI model and policy rules are saved on their own, outside this form.
// Policy rules have their own section.
type Draft = Omit<OrgSettings, "paused" | "modelProfileId" | "policyRules">;

const toDraft = (s: OrgSettings): Draft => ({
  emailDomains: s.emailDomains,
  teamsTenantId: s.teamsTenantId,
  approvalSlackChannel: s.approvalSlackChannel ?? "",
  authorizedRequesters: s.authorizedRequesters,
  protectedAccounts: s.protectedAccounts,
  vipRequesters: s.vipRequesters ?? [],
  phoneNumbers: s.phoneNumbers ?? [],
  maxAutoChangesPerHour: s.maxAutoChangesPerHour,
  maxSelfServicePerUserPerDay: s.maxSelfServicePerUserPerDay,
  sla: s.sla,
});

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Self-service & safety settings: who may ask for what, protected accounts, routing, limits and SLA targets. */
export function SafetySettingsForm({ org, onSaved, pause }: { org: OrgDetail; onSaved: () => void; pause: ReturnType<typeof usePauseControl> }) {
  const { toast } = useApp();
  const saved = useMemo(() => toDraft(org.settings), [org.settings]);
  const { draft, setDraft, patch, dirty, reset } = useDraft(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };
  const setSla = (p: TicketPriority, key: "responseMinutes" | "resolutionMinutes", value: number) =>
    setDraft((d) => ({ ...d, sla: { ...d.sla, [p]: { ...d.sla[p], [key]: value } } }));

  const unattended = org.autonomy === "unattended";

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const tenant = draft.teamsTenantId.trim();
    if (tenant && !GUID_RE.test(tenant)) return setError("The Teams tenant ID should be a GUID like 00000000-0000-0000-0000-000000000000.");
    const approvalChannel = draft.approvalSlackChannel.trim();
    if (approvalChannel && !/^[CG][A-Z0-9]{2,20}$/.test(approvalChannel)) return setError("The Slack channel for approvals should be a channel id like C0123ABCD.");
    for (const p of TICKET_PRIORITIES) {
      const t = draft.sla[p];
      if (!(t.responseMinutes >= 1) || !(t.resolutionMinutes >= 1)) return setError(`SLA targets for ${PRIORITY_META[p].label} must be at least 1 minute.`);
      if (t.resolutionMinutes < t.responseMinutes) return setError(`${PRIORITY_META[p].label}: resolution target is shorter than the response target.`);
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateOrg(org.id, {
        settings: {
          ...patch,
          ...(patch.teamsTenantId !== undefined ? { teamsTenantId: tenant } : {}),
          ...(patch.approvalSlackChannel !== undefined ? { approvalSlackChannel: approvalChannel } : {}),
        },
      });
      setDraft((d) => d.teamsTenantId === draft.teamsTenantId ? { ...d, teamsTenantId: tenant } : d);
      toast("Self-service & safety settings saved.");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={save} aria-labelledby="safety-title">
      <div className="card-header">
        <h2 id="safety-title">Self-service &amp; safety</h2>
        <span className="spacer" />
        {!unattended && <span className="muted hide-sm" style={{ fontSize: "var(--text-sm)" }}>Limits apply in Unattended mode</span>}
      </div>

      <div className={`killswitch ${pause.paused ? "is-paused" : ""}`}>
        <span className="killswitch-icon" aria-hidden="true">
          {pause.paused ? <CirclePause className="icon" /> : <OctagonPause className="icon" />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="killswitch-title">{pause.paused ? "Haley is paused for this client" : "Kill switch"}</div>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {pause.paused
              ? "Everything goes to your technicians until you resume her."
              : "Stop Haley from acting on this client's tickets, tasks and schedules immediately. Requests keep flowing to technicians."}
          </p>
        </div>
        {pause.paused ? (
          <button type="button" className="btn btn-primary" onClick={pause.resume} disabled={pause.busy}>
            {pause.busy ? <Spinner /> : <CirclePlay className="icon-sm" aria-hidden="true" />} Resume Haley
          </button>
        ) : (
          <button type="button" className="btn btn-danger" onClick={pause.askToPause} disabled={pause.busy}>
            <OctagonPause className="icon-sm" aria-hidden="true" /> Pause Haley
          </button>
        )}
      </div>

      <div className="card-body stack settings-groups">
        <div className="settings-group" role="group" aria-labelledby="sg-who">
          <h3 id="sg-who" className="settings-legend">Who can ask for what</h3>
          <ListEditor
            id="st-approvers"
            label="Authorized approvers"
            kind="email"
            values={draft.authorizedRequesters}
            onChange={(v) => set("authorizedRequesters", v)}
            placeholder="manager@client.com"
            help="Managers and the IT contact. They can request changes to other people's accounts and access grants (groups, shared mailboxes)."
          />
          <ListEditor
            id="st-protected"
            label="Protected accounts"
            kind="email"
            values={draft.protectedAccounts}
            onChange={(v) => set("protectedAccounts", v)}
            placeholder="ceo@client.com"
            help="Admins, executives, service accounts. Haley never changes these without a technician, in any mode."
          />
          <ListEditor
            id="st-vip"
            label="VIP requesters"
            kind="email"
            values={draft.vipRequesters}
            onChange={(v) => set("vipRequesters", v)}
            placeholder="ceo@client.com"
            help="Their tickets get priority raised one step and a VIP badge, and Haley is told to keep them informed and hand over sooner."
          />
        </div>

        <div className="settings-group" role="group" aria-labelledby="sg-routing">
          <h3 id="sg-routing" className="settings-legend">Routing end users to this client</h3>
          <ListEditor
            id="st-domains"
            label="Extra email domains"
            kind="domain"
            values={draft.emailDomains}
            onChange={(v) => set("emailDomains", v)}
            placeholder="client-subsidiary.com"
            help={`Besides ${org.domain || "the primary domain"}. Email, chat and API requests from these domains are routed to ${org.name}.`}
          />
          <ListEditor
            id="st-phones"
            label="Phone numbers callers dial"
            kind="phone"
            values={draft.phoneNumbers ?? []}
            onChange={(v) => set("phoneNumbers", v)}
            placeholder="+1 800 555 0100"
            help={`If you have a line just for ${org.name}, calls to it come here. Otherwise calls are matched by the caller's number in the client's directory.`}
          />
          <div className="field">
            <label htmlFor="st-tenant">Teams tenant ID</label>
            <input
              id="st-tenant"
              className="input mono"
              value={draft.teamsTenantId}
              onChange={(e) => set("teamsTenantId", e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              spellCheck={false}
              autoComplete="off"
            />
            <span className="help">Routes Microsoft Teams messages from this Entra tenant here. Not needed if a live Microsoft 365 integration is connected.</span>
          </div>
          <div className="field">
            <label htmlFor="st-approval-channel">Slack channel for approvals</label>
            <input
              id="st-approval-channel"
              className="input mono"
              value={draft.approvalSlackChannel}
              onChange={(e) => set("approvalSlackChannel", e.target.value)}
              placeholder="Workspace default"
              spellCheck={false}
              autoComplete="off"
            />
            <span className="help">
              A channel id (C0123ABCD) in your own Slack for this client's approval cards and escalations. Empty uses the default set on the <Link to="/approvals">Approvals</Link> page.
            </span>
          </div>
        </div>

        <div className="settings-group" role="group" aria-labelledby="sg-limits">
          <h3 id="sg-limits" className="settings-legend">Unattended safety limits</h3>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="st-hour">Max automatic changes per hour</label>
              <input
                id="st-hour"
                className="input num"
                type="number"
                min={0}
                max={1000}
                value={draft.maxAutoChangesPerHour}
                onChange={(e) => set("maxAutoChangesPerHour", clampInt(e.target.value, 0, 1000))}
              />
              <span className="help">Across the whole client. Past this, changes wait for approval: a guard against runaway volume.</span>
            </div>
            <div className="field">
              <label htmlFor="st-day">Max security-sensitive self-service per person per day</label>
              <input
                id="st-day"
                className="input num"
                type="number"
                min={0}
                max={50}
                value={draft.maxSelfServicePerUserPerDay}
                onChange={(e) => set("maxSelfServicePerUserPerDay", clampInt(e.target.value, 0, 50))}
              />
              <span className="help">Password resets, sign-outs and Temporary Access Passes on someone's own account.</span>
            </div>
          </div>
        </div>

        <div className="settings-group" role="group" aria-labelledby="sg-sla">
          <h3 id="sg-sla" className="settings-legend">SLA targets</h3>
          <div className="table-wrap">
            <table className="sla-table">
              <thead>
                <tr>
                  <th scope="col">Priority</th>
                  <th scope="col">First response</th>
                  <th scope="col">Resolution</th>
                </tr>
              </thead>
              <tbody>
                {(["urgent", "high", "normal", "low"] as TicketPriority[]).map((p) => (
                  <tr key={p}>
                    <th scope="row">{PRIORITY_META[p].label}</th>
                    {(["responseMinutes", "resolutionMinutes"] as const).map((k) => (
                      <td key={k}>
                        <div className="minutes-input">
                          <input
                            className="input input-sm num"
                            type="number"
                            min={1}
                            max={100000}
                            aria-label={`${PRIORITY_META[p].label} ${k === "responseMinutes" ? "response" : "resolution"} target in minutes`}
                            value={draft.sla[p][k]}
                            onChange={(e) => setSla(p, k, clampInt(e.target.value, 0, 100000))}
                          />
                          <span className="muted">min</span>
                          <span className="minutes-hint">{draft.sla[p][k] >= 60 ? `≈ ${formatMinutes(draft.sla[p][k])}` : ""}</span>
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <span className="help">24x7 clock from when the ticket is opened. Auto-acknowledgements don't count as a response; tickets that breach resolution are escalated to a technician.</span>
        </div>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="card-footer">
        <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {dirty ? "Unsaved changes" : ""}
        </span>
        <span className="spacer" />
        {dirty && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>
            Discard
          </button>
        )}
        <button className="btn btn-primary btn-sm" type="submit" disabled={!dirty || busy}>
          {busy && <Spinner />} Save settings
        </button>
      </div>
    </form>
  );
}

function clampInt(raw: string, min: number, max: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
