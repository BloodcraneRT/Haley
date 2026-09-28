import { CalendarClock, ClipboardList, Play, Plus, Repeat, Ticket as TicketIcon, Trash } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, CADENCES, errorMessage, type Cadence, type RunMode, type Schedule, type ScheduleListItem } from "../api";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { absoluteTime, CADENCE_META } from "../lib/format";
import { EmptyState, ErrorBanner, Loading, Spinner } from "./Feedback";
import { ConfirmModal, Modal } from "./Modal";
import { Pill, RunModeBadge } from "./Pill";
import { RelativeTime } from "./RelativeTime";
import { Switch } from "./Switch";

// ------------------------------------------------------------------ date helpers

const pad = (n: number) => String(n).padStart(2, "0");

/** A datetime-local value ("YYYY-MM-DDTHH:mm") for the next full hour, in the browser's time zone. */
export function defaultStartLocal(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Converts a datetime-local value to an ISO timestamp the server accepts. */
export function localInputToIso(value: string): string | null {
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

const timeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "local time";
  }
})();

// ------------------------------------------------------------------ shared fields

/** Cadence + first run inputs, shared by the schedule dialog and "Schedule this" on the Tasks page. */
export function CadenceFields({
  idPrefix,
  cadence,
  onCadence,
  startAt,
  onStartAt,
}: {
  idPrefix: string;
  cadence: Cadence;
  onCadence: (c: Cadence) => void;
  startAt: string;
  onStartAt: (v: string) => void;
}) {
  return (
    <>
      <div className="field">
        <span className="field-label" id={`${idPrefix}-cadence`}>
          Repeats
        </span>
        <div className="segmented" role="group" aria-labelledby={`${idPrefix}-cadence`} style={{ alignSelf: "flex-start" }}>
          {CADENCES.map((c) => (
            <button key={c} type="button" aria-pressed={cadence === c} onClick={() => onCadence(c)}>
              {CADENCE_META[c].label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-start`}>{cadence === "once" ? "Run at" : "First run"}</label>
        <input id={`${idPrefix}-start`} className="input" type="datetime-local" value={startAt} onChange={(e) => onStartAt(e.target.value)} required />
        <span className="help">{timeZone}</span>
      </div>
    </>
  );
}

/** Live vs plan (dry run) choice. */
export function ModeToggle({ value, onChange, id }: { value: RunMode; onChange: (m: RunMode) => void; id?: string }) {
  return (
    <div className="segmented" role="group" aria-label="Run mode" id={id} style={{ alignSelf: "flex-start" }}>
      <button type="button" aria-pressed={value === "live"} onClick={() => onChange("live")} title="Haley acts, following the client's approval policy">
        <Play className="icon-sm seg-icon" aria-hidden="true" />
        Live
      </button>
      <button type="button" aria-pressed={value === "plan"} onClick={() => onChange("plan")} title="Dry run: Haley investigates and reports the exact plan; nothing changes">
        <ClipboardList className="icon-sm seg-icon" aria-hidden="true" />
        Plan only
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ list

export function ScheduleRow({ schedule: s, onChanged }: { schedule: Schedule | ScheduleListItem; onChanged: () => void }) {
  const { toast, refreshStats } = useApp();
  const [busy, setBusy] = useState<"toggle" | "run" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lastStarted, setLastStarted] = useState<string | null>(null);
  const ticket = "ticket" in s ? s.ticket : null;

  const toggle = async (enabled: boolean) => {
    setBusy("toggle");
    try {
      // A one-time schedule that already ran has no next run; re-enabling it would never fire, so give it one.
      const restart = enabled && !s.next_run_at ? localInputToIso(defaultStartLocal()) : null;
      await api.updateSchedule(s.id, restart ? { enabled, startAt: restart } : { enabled });
      toast(enabled ? (restart ? `"${s.title}" enabled; next run ${absoluteTime(restart)}.` : `"${s.title}" enabled.`) : `"${s.title}" paused.`);
      refreshStats();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const runNow = async () => {
    setBusy("run");
    try {
      const started = await api.runSchedule(s.id);
      setLastStarted(started.runId);
      toast(`Started "${s.title}".`);
      refreshStats();
    } catch (err) {
      toast(errorMessage(err), err instanceof ApiError && err.status === 409 ? "info" : "error");
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const remove = async () => {
    setBusy("delete");
    try {
      await api.deleteSchedule(s.id);
      toast(`"${s.title}" deleted.`);
      setConfirmDelete(false);
      refreshStats();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return (
    <li className={`schedule-row ${s.enabled ? "" : "is-disabled"}`}>
      <span className="kind-icon" aria-hidden="true">
        {s.cadence === "once" ? <CalendarClock className="icon-sm" /> : <Repeat className="icon-sm" />}
      </span>
      <div className="schedule-main">
        <div className="row row-wrap" style={{ gap: 6 }}>
          <span className="title">{s.title}</span>
          <Pill tone={s.cadence === "once" ? "neutral" : "blue"}>{CADENCE_META[s.cadence].every}</Pill>
          <RunModeBadge mode={s.mode} />
        </div>
        <div className="meta">
          {s.enabled && s.next_run_at ? (
            <span title={absoluteTime(s.next_run_at)}>
              Next <RelativeTime iso={s.next_run_at} /> · {absoluteTime(s.next_run_at)}
            </span>
          ) : s.enabled ? (
            <span>No upcoming run</span>
          ) : (
            <span>Paused</span>
          )}
          {s.last_run_at && (
            <span>
              {" "}
              · last ran{" "}
              {s.last_run_id ? (
                <Link to={`/runs/${s.last_run_id}`}>
                  <RelativeTime iso={s.last_run_at} />
                </Link>
              ) : (
                <RelativeTime iso={s.last_run_at} />
              )}
            </span>
          )}
          {ticket && (
            <span>
              {" "}
              · <TicketIcon className="icon-xs" aria-hidden="true" style={{ verticalAlign: "-1px" }} />{" "}
              <Link to={`/tickets/${ticket.id}`}>#{ticket.number}</Link>
            </span>
          )}
          <span> · by {s.created_by}</span>
          {lastStarted && (
            <span>
              {" "}
              · <Link to={`/runs/${lastStarted}`}>Watch the run you just started</Link>
            </span>
          )}
        </div>
        <p className="schedule-instruction" title={s.instruction}>
          {s.instruction}
        </p>
      </div>
      <div className="schedule-actions">
        <Switch checked={s.enabled} onChange={toggle} label={s.enabled ? `Disable ${s.title}` : `Enable ${s.title}`} disabled={busy !== null} />
        <button className="btn btn-sm" onClick={runNow} disabled={busy !== null} title="Start this now without changing its schedule">
          {busy === "run" ? <Spinner /> : <Play className="icon-sm" aria-hidden="true" />} Run now
        </button>
        <button className="btn btn-sm btn-ghost btn-icon" onClick={() => setConfirmDelete(true)} disabled={busy !== null} aria-label={`Delete ${s.title}`} title="Delete">
          <Trash className="icon-sm" aria-hidden="true" />
        </button>
      </div>
      <ConfirmModal
        open={confirmDelete}
        title={`Delete "${s.title}"?`}
        confirmLabel="Delete schedule"
        busy={busy === "delete"}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      >
        Haley won't run it again. Past runs stay in the run history and audit log.
      </ConfirmModal>
    </li>
  );
}

/** A client's schedules with enable/disable, run now, delete and "New schedule". */
export function SchedulesSection({ orgId, orgName, paused }: { orgId: string; orgName: string; paused: boolean }) {
  const schedules = usePoll(() => api.schedules({ orgId }), [orgId], 30_000);
  const [creating, setCreating] = useState(false);
  const list = schedules.data ?? [];

  return (
    <section aria-labelledby="sched-title">
      <div className="section-title">
        <h2 id="sched-title">Schedules</h2>
        {list.length > 0 && <span className="count">{list.length}</span>}
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => setCreating(true)}>
          <Plus className="icon-sm" aria-hidden="true" /> New schedule
        </button>
      </div>
      {schedules.error && <ErrorBanner error={schedules.error} onRetry={schedules.reload} />}
      <div className="card">
        {paused && list.length > 0 && (
          <p className="card-note">Haley is paused for {orgName}, so schedules are skipped until she's resumed.</p>
        )}
        {!schedules.data ? (
          !schedules.error && <Loading />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<CalendarClock className="icon" />}
            title="Nothing scheduled"
            compact
            actions={
              <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                <Plus className="icon-sm" aria-hidden="true" /> New schedule
              </button>
            }
          >
            Recurring audits and checks Haley runs on her own, like a monthly license review. Follow-ups she sets on tickets show up here too.
          </EmptyState>
        ) : (
          <ul className="list">
            {list.map((s) => (
              <ScheduleRow key={s.id} schedule={s} onChanged={() => void schedules.reload()} />
            ))}
          </ul>
        )}
      </div>
      <NewScheduleModal
        open={creating}
        orgId={orgId}
        orgName={orgName}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void schedules.reload();
        }}
      />
    </section>
  );
}

export function NewScheduleModal({
  open,
  orgId,
  orgName,
  onClose,
  onCreated,
}: {
  open: boolean;
  orgId: string;
  orgName: string;
  onClose: () => void;
  onCreated: (s: Schedule) => void;
}) {
  const { toast, refreshStats } = useApp();
  const templates = usePoll(() => (open ? api.templates() : Promise.resolve(undefined)), [open]);
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [startAt, setStartAt] = useState(defaultStartLocal);
  const [mode, setMode] = useState<RunMode>("live");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTemplateId("");
    setTitle("");
    setInstruction("");
    setCadence("monthly");
    setStartAt(defaultStartLocal());
    setMode("live");
    setError(null);
  }, [open]);

  const pickTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.data?.find((x) => x.id === id);
    if (t) {
      setTitle(t.name);
      setInstruction(t.instruction);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError("Give the schedule a title.");
    if (!instruction.trim()) return setError("Tell Haley what to do each time.");
    const iso = localInputToIso(startAt);
    if (!iso) return setError("Choose when it should first run.");
    setBusy(true);
    setError(null);
    try {
      const schedule = await api.createSchedule({ orgId, title: title.trim(), instruction: instruction.trim(), cadence, mode, startAt: iso });
      toast(`Scheduled "${schedule.title}" (${CADENCE_META[cadence].every.toLowerCase()}).`);
      refreshStats();
      onCreated(schedule);
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
      title={`New schedule for ${orgName}`}
      size="wide"
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="new-schedule-form" disabled={busy}>
            {busy ? <Spinner /> : <CalendarClock className="icon-sm" aria-hidden="true" />} Create schedule
          </button>
        </>
      }
    >
      <form id="new-schedule-form" className="stack" onSubmit={submit}>
        <div className="form-grid">
          <div className="field span-2">
            <label htmlFor="ns-template">Start from a template</label>
            <select id="ns-template" className="select" value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
              <option value="">{templates.data ? "None: write my own" : "Loading templates…"}</option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}: {t.description}
                </option>
              ))}
            </select>
          </div>
          <div className="field span-2">
            <label htmlFor="ns-title">Title</label>
            <input id="ns-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Monthly license audit" required />
          </div>
          <div className="field span-2">
            <label htmlFor="ns-instruction">Instruction</label>
            <textarea
              id="ns-instruction"
              className="textarea"
              rows={7}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="What Haley should do each time. Be specific about what 'done' looks like and what to report."
            />
          </div>
          <CadenceFields idPrefix="ns" cadence={cadence} onCadence={setCadence} startAt={startAt} onStartAt={setStartAt} />
          <div className="field span-2">
            <span className="field-label">Mode</span>
            <ModeToggle value={mode} onChange={setMode} />
            <span className="help">
              {mode === "live"
                ? "Haley acts, following the client's approval policy. Changes that need sign-off wait in the approval queue."
                : "Each run is a dry run: Haley investigates and reports exactly what she would change. Good for audits you want to review first."}
            </span>
          </div>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
