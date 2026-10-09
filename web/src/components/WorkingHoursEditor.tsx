import { WEEKDAYS, type Weekday, type WorkingHours } from "../api";
import { Switch } from "./Switch";

const LABEL: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const zones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();

/** Monday to Friday, 9 to 5, in the browser's time zone: a starting point when hours are first turned on. */
export function defaultHours(): WorkingHours {
  return { tz: browserZone(), days: Object.fromEntries(WEEKDAYS.slice(0, 5).map((d) => [d, [["09:00", "17:00"]]])), awayUntil: null };
}

/** What's wrong with a set of hours, or null. */
export function hoursProblem(hours: WorkingHours | null): string | null {
  if (!hours) return null;
  if (!hours.tz.trim() || (zones.length > 0 && !zones.includes(hours.tz) && hours.tz !== "UTC")) return "Pick a time zone from the list.";
  for (const [day, ranges] of Object.entries(hours.days)) {
    for (const [start, end] of ranges ?? []) {
      if (!TIME.test(start) || !TIME.test(end)) return `Enter ${LABEL[day as Weekday]}'s hours as HH:MM.`;
      if (start === end) return `${LABEL[day as Weekday]} starts and ends at the same time.`;
    }
  }
  return null;
}

/**
 * Weekly hours in the technician's own time zone, one range a day (an end before the start runs past midnight),
 * and a last day away. Off: always available. Days with more than one range keep the extra ones untouched.
 */
export function WorkingHoursEditor({ value, onChange }: { value: WorkingHours | null; onChange: (next: WorkingHours | null) => void }) {
  const setDay = (day: Weekday, range: [string, string] | null) => {
    if (!value) return;
    const days = { ...value.days };
    if (range) days[day] = [range, ...(value.days[day] ?? []).slice(1)];
    else delete days[day];
    onChange({ ...value, days });
  };
  return (
    <fieldset className="hours-editor">
      <legend className="field-label">Working hours</legend>
      <label className="row" style={{ gap: 8 }}>
        <Switch checked={value !== null} onChange={(on) => onChange(on ? defaultHours() : null)} label="Set working hours" />
        <span>{value ? "Suggested for tickets only during these hours" : "Always available"}</span>
      </label>
      {value && (
        <>
          <div className="field">
            <label htmlFor="hours-tz">Time zone</label>
            <input id="hours-tz" className="input" list="hours-tz-list" value={value.tz} onChange={(e) => onChange({ ...value, tz: e.target.value })} spellCheck={false} />
            <datalist id="hours-tz-list">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
          <div className="hours-grid" role="group" aria-label="Hours each day">
            {WEEKDAYS.map((day) => {
              const range = value.days[day]?.[0] ?? null;
              return (
                <div className="hours-row" key={day}>
                  <label className="row" style={{ gap: 6 }}>
                    <input type="checkbox" checked={range !== null} onChange={(e) => setDay(day, e.target.checked ? ["09:00", "17:00"] : null)} />
                    <span>{LABEL[day]}</span>
                  </label>
                  {range ? (
                    <span className="row" style={{ gap: 6 }}>
                      <input className="input hours-time" type="time" aria-label={`${LABEL[day]} start`} value={range[0]} onChange={(e) => setDay(day, [e.target.value, range[1]])} />
                      <span aria-hidden="true">–</span>
                      <input className="input hours-time" type="time" aria-label={`${LABEL[day]} end`} value={range[1]} onChange={(e) => setDay(day, [range[0], e.target.value])} />
                    </span>
                  ) : (
                    <span className="muted">Off</span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="field">
            <label htmlFor="hours-away">
              Away until <span className="muted">(optional, last day off)</span>
            </label>
            <input id="hours-away" className="input" type="date" value={value.awayUntil ?? ""} onChange={(e) => onChange({ ...value, awayUntil: e.target.value || null })} />
          </div>
        </>
      )}
    </fieldset>
  );
}
