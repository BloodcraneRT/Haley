import { WEEKDAYS, type Weekday, type WorkingHours } from "./types.js";

const DAY = 86_400_000;
const LABEL: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether a string is an IANA time zone this runtime knows. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const isTime = (s: string) => TIME.test(s);

/** The local weekday, date (YYYY-MM-DD) and time (HH:MM) at an instant in a time zone. */
function local(nowMs: number, tz: string): { day: Weekday; date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(nowMs))
      .map((p) => [p.type, p.value]),
  );
  return { day: parts.weekday.slice(0, 3).toLowerCase() as Weekday, date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const previous = (day: Weekday): Weekday => WEEKDAYS[(WEEKDAYS.indexOf(day) + 6) % 7];

/**
 * Whether a technician is working at an instant. No hours set means always available. A range that ends before it
 * starts (22:00–06:00) runs past midnight, so its early hours count on the next day.
 */
export function isWorking(hours: WorkingHours | null, nowMs = Date.now()): boolean {
  if (!hours) return true;
  const now = local(nowMs, hours.tz);
  if (hours.awayUntil && now.date <= hours.awayUntil) return false;
  const today = hours.days[now.day] ?? [];
  if (today.some(([start, end]) => (start < end ? now.time >= start && now.time < end : now.time >= start))) return true;
  // The tail of yesterday's overnight range.
  return (hours.days[previous(now.day)] ?? []).some(([start, end]) => end <= start && now.time < end);
}

/** When a technician is next on, in their own time ("Mon 08:00"), within two weeks; null when never. */
export function nextOn(hours: WorkingHours | null, nowMs = Date.now()): string | null {
  if (!hours) return null;
  for (let d = 0; d < 14 + (hours.awayUntil ? 60 : 0); d++) {
    const at = local(nowMs + d * DAY, hours.tz);
    if (hours.awayUntil && at.date <= hours.awayUntil) continue;
    const starts = (hours.days[at.day] ?? [])
      .map(([start]) => start)
      .filter((start) => d > 0 || start > local(nowMs, hours.tz).time)
      .sort();
    if (starts.length) return `${d === 0 ? "today" : d === 1 ? "tomorrow" : LABEL[at.day]} ${starts[0]}`;
  }
  return null;
}
