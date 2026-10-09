import { useState } from "react";
import { api, errorMessage, type HelpdeskSettings } from "../api";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { Spinner } from "./Feedback";
import { Switch } from "./Switch";

/** Workspace help desk behaviour: checks before close, frustration detection and dispatch. Each change saves at once. */
export function TeamSettingsCard() {
  const { toast } = useApp();
  const settings = usePoll(() => api.helpdeskSettings(), []);
  const [saving, setSaving] = useState<keyof HelpdeskSettings | null>(null);
  const s = settings.data;

  const save = async <K extends keyof HelpdeskSettings>(key: K, value: HelpdeskSettings[K]) => {
    setSaving(key);
    settings.mutate((d) => d && { ...d, [key]: value });
    try {
      await api.updateHelpdeskSettings({ [key]: value });
      toast("Saved.");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSaving(null);
      void settings.reload();
    }
  };

  return (
    <section className="card" aria-labelledby="team-settings">
      <div className="card-header">
        <h2 id="team-settings">How the team works</h2>
        {saving && <Spinner />}
      </div>
      {!s ? (
        <div className="card-body">{settings.error ? errorMessage(settings.error) : <Spinner />}</div>
      ) : (
        <div className="card-body stack">
          <div className="field">
            <label htmlFor="ts-qa">Before a technician closes a ticket</label>
            <select id="ts-qa" className="select" value={s.qaBeforeClose} onChange={(e) => void save("qaBeforeClose", e.target.value as HelpdeskSettings["qaBeforeClose"])} disabled={saving !== null}>
              <option value="warn">Show what's missing (no reply, no note, a promise not kept)</option>
              <option value="require">Require a reason to close despite a warning</option>
              <option value="off">Don't check</option>
            </select>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Switch id="ts-qa-model" checked={s.qaModelCheck} onChange={(v) => void save("qaModelCheck", v)} label="AI check before close" disabled={saving !== null || s.qaBeforeClose === "off"} />
            <label htmlFor="ts-qa-model">Also ask the AI model whether the note explains the fix and the reply answers the requester (one call per close)</label>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Switch id="ts-sentiment" checked={s.sentimentModelCheck} onChange={(v) => void save("sentimentModelCheck", v)} label="AI frustration check" disabled={saving !== null} />
            <label htmlFor="ts-sentiment">Confirm likely frustration with a short AI check, only for messages the free checks already flagged</label>
          </div>
          <div className="field">
            <label htmlFor="ts-assign">When Haley escalates a ticket</label>
            <select id="ts-assign" className="select" value={s.autoAssignOnEscalation} onChange={(e) => void save("autoAssignOnEscalation", e.target.value as HelpdeskSettings["autoAssignOnEscalation"])} disabled={saving !== null}>
              <option value="off">Suggest a technician</option>
              <option value="suggested">Assign the suggested technician</option>
            </select>
          </div>
        </div>
      )}
    </section>
  );
}
