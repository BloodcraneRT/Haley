import { ArrowDown, ArrowUp, Ban, CircleCheck, ListChecks, Lock, Pencil, Plus, Trash, UserCheck } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, errorMessage, type OrgDetail, type PolicyEffect, type PolicyRule, type PolicyRuleInput } from "../api";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { ASSURANCE_META, type Tone } from "../lib/format";
import { Disclosure } from "./Disclosure";
import { EmptyState, Spinner } from "./Feedback";
import { ConfirmModal, Modal } from "./Modal";
import { ListEditor } from "./OrgSafety";
import { Pill } from "./Pill";
import { Switch } from "./Switch";

export const EFFECT_META: Record<PolicyEffect, { label: string; tone: Tone; help: string; icon: typeof Ban }> = {
  deny: { label: "Deny", tone: "red", help: "Blocked. Haley tells the requester she can't do it.", icon: Ban },
  approve: { label: "Needs approval", tone: "amber", help: "Goes to the approval queue, to the named approvers if you set any.", icon: UserCheck },
  allow: {
    label: "Allow",
    tone: "green",
    help: "Runs without sign-off where the autonomy level would only have asked for one.",
    icon: CircleCheck,
  },
};

const ASSURANCE_CHOICES: PolicyRule["minAssurance"][] = ["email", "chat", "directory", "mfa", "technician"];

/** Change tools users commonly target; the connected tenants' real tool lists are merged in. */
const COMMON_TOOLS = [
  "m365_reset_password",
  "m365_issue_temporary_access_pass",
  "m365_set_account_enabled",
  "m365_revoke_sessions",
  "m365_add_group_member",
  "m365_remove_group_member",
  "m365_assign_license",
  "m365_remove_license",
  "m365_create_user",
  "m365_set_auto_reply",
  "m365_get_bitlocker_key",
  "m365_sync_device",
  "m365_restart_device",
  "m365_run_remediation",
  "m365_retire_device",
  "m365_wipe_device",
  "m365_*_device",
  "gws_*",
];

/** Haley's hard rails: not configurable, listed so nobody expects a rule to relax them. */
const HARD_RAILS = [
  "Wiping or retiring a device always needs a technician.",
  "Temporary Access Passes and BitLocker keys only go to the account's own owner without a technician.",
  "Adding someone to an admin or role-assignable group always needs a technician.",
];

const list = (items: string[], max = 3) => (items.length > max ? `${items.slice(0, max).join(", ")} +${items.length - max}` : items.join(", "));

/** One line describing what a rule matches, e.g. "m365_wipe_device · for *@contoso.com · approvers: Jordan". */
export function ruleSummary(r: Pick<PolicyRule, "tools" | "risks" | "targets" | "departments" | "requesters" | "effect" | "approvers" | "minAssurance">): string {
  const parts: string[] = [];
  parts.push(r.tools.length ? list(r.tools) : "Any tool");
  if (r.risks.length === 1) parts.push(`${r.risks[0]} only`);
  if (r.targets.length) parts.push(`for ${list(r.targets)}`);
  if (r.departments.length) parts.push(`in ${list(r.departments)}`);
  if (r.requesters.length) parts.push(`asked by ${list(r.requesters)}`);
  if (r.effect === "approve") parts.push(r.approvers.length ? `approver${r.approvers.length === 1 ? "" : "s"}: ${list(r.approvers)}` : "any technician approves");
  if (r.effect === "allow") parts.push(`requester ${ASSURANCE_META[r.minAssurance]?.label.toLowerCase() ?? r.minAssurance} or better`);
  return parts.join(" · ");
}

/** Client-specific rules layered on the autonomy level: list, reorder, toggle, add, edit, delete. */
export function PolicyRulesSection({ org, onSaved }: { org: OrgDetail; onSaved: () => void }) {
  const { toast } = useApp();
  const rules = org.settings.policyRules ?? [];
  const [editing, setEditing] = useState<PolicyRule | "new" | null>(null);
  const [deleting, setDeleting] = useState<PolicyRule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /** Saves the whole list (the server replaces it); order matters. */
  const save = async (next: PolicyRuleInput[], message: string, key: string): Promise<boolean> => {
    setBusy(key);
    try {
      await api.updateOrg(org.id, { settings: { policyRules: next } });
      toast(message);
      return true;
    } catch (err) {
      toast(errorMessage(err), "error");
      return false;
    } finally {
      setBusy(null);
      onSaved();
    }
  };

  const move = (index: number, delta: -1 | 1) => {
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    next.splice(index + delta, 0, rule);
    void save(next, `Moved "${rule.name}" ${delta < 0 ? "up" : "down"}.`, rule.id);
  };

  const toggle = (rule: PolicyRule, enabled: boolean) =>
    void save(
      rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)),
      enabled ? `"${rule.name}" is on.` : `"${rule.name}" is off.`,
      rule.id,
    );

  const remove = async () => {
    if (!deleting) return;
    const ok = await save(
      rules.filter((r) => r.id !== deleting.id),
      `Deleted "${deleting.name}".`,
      deleting.id,
    );
    if (ok) setDeleting(null);
  };

  return (
    <section aria-labelledby="rules-title">
      <div className="section-title">
        <h2 id="rules-title">Policy rules</h2>
        {rules.length > 0 && <span className="count">{rules.length}</span>}
        {busy && <Spinner />}
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => setEditing("new")}>
          <Plus className="icon-sm" aria-hidden="true" /> Add rule
        </button>
      </div>
      <div className="card">
        <p className="rules-intro secondary">
          Client-specific exceptions to the autonomy level. Rules apply to changes only, and Haley uses the first enabled rule that matches.
        </p>
        {rules.length === 0 ? (
          <EmptyState
            icon={<ListChecks className="icon" />}
            title="No rules yet"
            compact
            actions={
              <button className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
                <Plus className="icon-sm" aria-hidden="true" /> Add rule
              </button>
            }
          >
            For example: block device wipes, or send finance account changes to one approver.
          </EmptyState>
        ) : (
          <ol className="list rules-list">
            {rules.map((r, i) => {
              const meta = EFFECT_META[r.effect];
              return (
                <li key={r.id} className={`rule-row ${r.enabled ? "" : "is-disabled"}`}>
                  <span className="rule-order num" aria-label={`Rule ${i + 1}`}>
                    {i + 1}
                  </span>
                  <div className="rule-main">
                    <div className="row row-wrap" style={{ gap: 6 }}>
                      <span className="title">{r.name}</span>
                      <Pill tone={meta.tone} title={meta.help}>
                        {meta.label}
                      </Pill>
                      {!r.enabled && <Pill>Off</Pill>}
                    </div>
                    <p className="rule-summary" title={ruleSummary(r)}>
                      {ruleSummary(r)}
                    </p>
                  </div>
                  <div className="rule-actions">
                    <Switch
                      checked={r.enabled}
                      onChange={(v) => toggle(r, v)}
                      label={r.enabled ? `Turn off ${r.name}` : `Turn on ${r.name}`}
                      disabled={busy !== null}
                    />
                    <span className="rule-move">
                      <button
                        className="btn btn-sm btn-ghost btn-icon"
                        onClick={() => move(i, -1)}
                        disabled={i === 0 || busy !== null}
                        aria-label={`Move ${r.name} up`}
                        title="Move up"
                      >
                        <ArrowUp className="icon-sm" aria-hidden="true" />
                      </button>
                      <button
                        className="btn btn-sm btn-ghost btn-icon"
                        onClick={() => move(i, 1)}
                        disabled={i === rules.length - 1 || busy !== null}
                        aria-label={`Move ${r.name} down`}
                        title="Move down"
                      >
                        <ArrowDown className="icon-sm" aria-hidden="true" />
                      </button>
                    </span>
                    <button className="btn btn-sm btn-ghost btn-icon" onClick={() => setEditing(r)} disabled={busy !== null} aria-label={`Edit ${r.name}`} title="Edit">
                      <Pencil className="icon-sm" aria-hidden="true" />
                    </button>
                    <button
                      className="btn btn-sm btn-ghost btn-icon"
                      onClick={() => setDeleting(r)}
                      disabled={busy !== null}
                      aria-label={`Delete ${r.name}`}
                      title="Delete"
                    >
                      <Trash className="icon-sm" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <div className="rules-foot">
          <Disclosure summary="Always on, whatever the rules say">
            <ul className="policy-notes">
              {HARD_RAILS.map((r) => (
                <li key={r}>
                  <Lock className="icon-xs" aria-hidden="true" />
                  {r}
                </li>
              ))}
              <li>
                <Lock className="icon-xs" aria-hidden="true" />
                Allow rules never override protected accounts, identity checks or rate limits.
              </li>
            </ul>
          </Disclosure>
        </div>
      </div>

      <RuleModal
        org={org}
        rule={editing}
        onClose={() => setEditing(null)}
        onSave={async (rule) => {
          const isNew = editing === "new";
          const next: PolicyRuleInput[] = isNew ? [...rules, rule] : rules.map((r) => (r.id === rule.id ? { ...r, ...rule } : r));
          await api.updateOrg(org.id, { settings: { policyRules: next } });
          toast(isNew ? `Added "${rule.name}".` : `Saved "${rule.name}".`);
          setEditing(null);
          onSaved();
        }}
      />
      <ConfirmModal
        open={deleting !== null}
        title={`Delete "${deleting?.name ?? ""}"?`}
        confirmLabel="Delete rule"
        busy={busy !== null}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(null)}
      >
        Haley goes back to the autonomy level for changes this rule matched. Decisions already made aren't affected.
      </ConfirmModal>
    </section>
  );
}

type RuleDraft = PolicyRuleInput;

const emptyRule = (): RuleDraft => ({
  name: "",
  enabled: true,
  tools: [],
  risks: [],
  targets: [],
  departments: [],
  requesters: [],
  effect: "approve",
  approvers: [],
  minAssurance: "directory",
});

function RuleModal({
  org,
  rule,
  onClose,
  onSave,
}: {
  org: OrgDetail;
  rule: PolicyRule | "new" | null;
  onClose: () => void;
  /** Throws to keep the dialog open with the server's message. */
  onSave: (rule: RuleDraft) => Promise<void>;
}) {
  const { user } = useApp();
  const open = rule !== null;
  const [draft, setDraft] = useState<RuleDraft>(emptyRule);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(rule === "new" ? emptyRule() : { ...rule! });
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule === "new" ? "new" : rule?.id]);

  // The client's real change tools, for autocomplete. Reads never hit a rule, so they're left out.
  const directories = org.integrations.filter((i) => i.provider === "m365" || i.provider === "google");
  const tools = usePoll(
    () => (open && directories.length ? Promise.all(directories.map((i) => api.integrationTools(i.id).catch(() => []))) : Promise.resolve(undefined)),
    [open, directories.map((i) => i.id).join(",")],
  );
  const toolSuggestions = useMemo(() => {
    const live = (tools.data ?? []).flat().filter((t) => t.risk === "write" || t.risk === "destructive");
    return [...new Set([...live.map((t) => t.name), ...COMMON_TOOLS])];
  }, [tools.data]);

  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };
  const toggleRisk = (risk: "write" | "destructive", on: boolean) =>
    set("risks", on ? [...new Set([...draft.risks, risk])] : draft.risks.filter((r) => r !== risk));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim()) return setError("Give the rule a name.");
    setBusy(true);
    setError(null);
    try {
      await onSave({
        ...draft,
        name: draft.name.trim(),
        // Only the fields for the chosen effect are meaningful.
        approvers: draft.effect === "approve" ? draft.approvers : [],
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const domain = org.domain || "client.com";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rule === "new" ? "Add policy rule" : "Edit policy rule"}
      size="wide"
      footer={
        <>
          <span className="muted rule-preview truncate" title={ruleSummary(draft)}>
            {ruleSummary(draft)}
          </span>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="rule-form" disabled={busy}>
            {busy && <Spinner />} {rule === "new" ? "Add rule" : "Save rule"}
          </button>
        </>
      }
    >
      <form id="rule-form" className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="rule-name">Name</label>
          <input
            id="rule-name"
            className="input"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Finance changes need the controller"
            maxLength={120}
            autoFocus
          />
        </div>

        <div className="field">
          <span className="field-label" id="rule-effect">
            When it matches
          </span>
          <div className="choice-grid" role="radiogroup" aria-labelledby="rule-effect">
            {(["deny", "approve", "allow"] as PolicyEffect[]).map((effect) => {
              const meta = EFFECT_META[effect];
              const Icon = meta.icon;
              return (
                <button
                  key={effect}
                  type="button"
                  role="radio"
                  aria-checked={draft.effect === effect}
                  className="choice"
                  onClick={() => set("effect", effect)}
                >
                  <span className="choice-title">
                    <Icon className={`icon-sm effect-${effect}`} aria-hidden="true" /> {meta.label}
                  </span>
                  <span className="choice-desc">{meta.help}</span>
                </button>
              );
            })}
          </div>
        </div>

        {draft.effect === "approve" && (
          <ListEditor
            id="rule-approvers"
            label="Approvers"
            kind="text"
            values={draft.approvers}
            onChange={(v) => set("approvers", v)}
            placeholder="Technician name"
            suggestions={user ? [user] : undefined}
            help="Technician names as they sign in to the dashboard. Leave empty to let any technician approve."
          />
        )}
        {draft.effect === "allow" && (
          <div className="field">
            <label htmlFor="rule-assurance">Requester identity needed</label>
            <select
              id="rule-assurance"
              className="select"
              style={{ maxWidth: 340 }}
              value={draft.minAssurance}
              onChange={(e) => set("minAssurance", e.target.value as RuleDraft["minAssurance"])}
            >
              {ASSURANCE_CHOICES.map((a) => (
                <option key={a} value={a}>
                  {ASSURANCE_META[a].label}
                </option>
              ))}
            </select>
            <span className="help">Weaker identities still need approval. Protected accounts, rate limits and Haley's hard rails always apply.</span>
          </div>
        )}

        <fieldset className="options-fieldset stack">
          <legend className="settings-legend">Matches</legend>
          <p className="muted" style={{ fontSize: "var(--text-sm)", marginTop: -4 }}>
            Leave a list empty to match anything.
          </p>
          <ListEditor
            id="rule-tools"
            label="Tools"
            kind="tool"
            values={draft.tools}
            onChange={(v) => set("tools", v)}
            placeholder="m365_wipe_device"
            suggestions={toolSuggestions}
            help='Use * as a wildcard, e.g. "m365_*_device" or "gws_*".'
          />
          <div className="field">
            <span className="field-label">Risk</span>
            <div className="row row-wrap" style={{ gap: 16 }}>
              {(["write", "destructive"] as const).map((risk) => (
                <label key={risk} className="checkbox">
                  <input type="checkbox" checked={draft.risks.includes(risk)} onChange={(e) => toggleRisk(risk, e.target.checked)} />
                  {risk === "write" ? "Write" : "Destructive"}
                </label>
              ))}
            </div>
          </div>
          <div className="form-grid">
            <ListEditor
              id="rule-targets"
              label="Target accounts"
              kind="account"
              values={draft.targets}
              onChange={(v) => set("targets", v)}
              placeholder={`*@${domain}`}
              help="Whose account is changed: an address, *@domain or @domain."
            />
            <ListEditor
              id="rule-requesters"
              label="Requested by"
              kind="account"
              values={draft.requesters}
              onChange={(v) => set("requesters", v)}
              placeholder={`manager@${domain}`}
              help="Who asked for the change, same patterns."
            />
          </div>
          <ListEditor
            id="rule-departments"
            label="Target departments"
            kind="text"
            values={draft.departments}
            onChange={(v) => set("departments", v)}
            placeholder="Finance"
            help="The target's Microsoft 365 department. Separate with commas."
          />
        </fieldset>

        <label className="checkbox">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          Rule is on
        </label>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
