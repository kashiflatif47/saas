/**
 * Serving hours. They decide WHEN a dish can be ORDERED; they never decide whether it is SHOWN.
 * Pure and dependency-free: the server uses it for the public menu and to enforce orders; the browser uses a
 * VERBATIM copy (client/src/lib/schedule.ts, checked by a test) for the admin's live preview.
 *
 * RULES
 *  - No schedule (no days or all 7 days, and no complete from/to times) = available 24/7. An empty or
 *    incomplete schedule is never "closed".
 *  - days: 0 = Sunday … 6 = Saturday, in the restaurant's time zone. Empty = every day.
 *  - from/to "HH:mm": open from `from` (inclusive) until `to` (exclusive). Only one of them, or from === to,
 *    means the whole day. to "00:00" means until midnight.
 *  - Overnight (from > to, e.g. 18:00–02:00): opens on a listed day at `from` and stays open past midnight
 *    until `to` on the next calendar day. The part after midnight belongs to the day it STARTED.
 *  - Precedence for a dish: its own schedule when the owner set an override (an empty override = 24/7);
 *    otherwise its category's schedule; otherwise the parent category's; otherwise 24/7.
 */

export interface ServingSchedule {
  days?: number[] | null;
  from?: string | null;
  to?: string | null;
}

/** Tests replace `now` to check exact boundaries; everything else uses the real time. */
export const scheduleClock = { now: () => new Date() };

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (s: string | null | undefined) => {
  const m = HM.exec(s ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const validDays = (s: ServingSchedule | null | undefined) => [...new Set((s?.days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];

/** Only complete, real restrictions count; anything else means "always available". */
export function hasSchedule(s: ServingSchedule | null | undefined): boolean {
  if (!s) return false;
  const days = validDays(s);
  const f = toMinutes(s.from);
  const t = toMinutes(s.to);
  return (days.length > 0 && days.length < 7) || (f != null && t != null && f !== t);
}

/** Local weekday, minutes after midnight and calendar date of an instant in a time zone. */
export function localParts(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const hour = Number(get('hour')) % 24;
  return { day, minutes: hour * 60 + Number(get('minute')), year: Number(get('year')), month: Number(get('month')), date: Number(get('day')) };
}

/** UTC instant of a local wall-clock time in a time zone (exact for fixed-offset zones such as Asia/Karachi). */
export function zonedTime(year: number, month: number, date: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, date, hour, minute);
  const offset = (ts: number) => {
    const p = localParts(new Date(ts), tz);
    return Date.UTC(p.year, p.month - 1, p.date, Math.floor(p.minutes / 60), p.minutes % 60) - Math.floor(ts / 60000) * 60000;
  };
  let ts = guess - offset(guess);
  const second = offset(ts);
  if (guess - second !== ts) ts = guess - second;
  return new Date(ts);
}

/** Is this schedule open at `at` in time zone `tz`? */
export function isOpenAt(s: ServingSchedule | null | undefined, tz: string, at: Date): boolean {
  if (!hasSchedule(s)) return true;
  const days = validDays(s);
  const onDay = (d: number) => days.length === 0 || days.includes(d);
  const { day, minutes } = localParts(at, tz);
  const f = toMinutes(s!.from);
  const t = toMinutes(s!.to);
  if (f == null || t == null || f === t) return onDay(day);
  if (f < t) return onDay(day) && minutes >= f && minutes < t;
  return (onDay(day) && minutes >= f) || (onDay((day + 6) % 7) && minutes < t);
}

/** Next moment it opens (within the coming 8 days), or null when it is open now or always open. */
export function nextOpenAt(s: ServingSchedule | null | undefined, tz: string, at: Date): Date | null {
  if (!hasSchedule(s) || isOpenAt(s, tz, at)) return null;
  const f = toMinutes(s!.from);
  const t = toMinutes(s!.to);
  const startMin = f != null && t != null && f !== t ? f : 0;
  const today = localParts(at, tz);
  for (let k = 0; k <= 8; k++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.date + k));
    const candidate = zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(startMin / 60), startMin % 60, tz);
    if (candidate.getTime() > at.getTime() && isOpenAt(s, tz, candidate)) return candidate;
  }
  return null;
}

/** The schedule that applies to a dish (see precedence above); null = 24/7. */
export function effectiveSchedule(
  product: { scheduleOverride?: boolean | null; schedule?: ServingSchedule | null },
  category?: { schedule?: ServingSchedule | null } | null,
  parent?: { schedule?: ServingSchedule | null } | null,
): ServingSchedule | null {
  if (product.scheduleOverride) return hasSchedule(product.schedule) ? product.schedule! : null;
  if (category && hasSchedule(category.schedule)) return category.schedule!;
  if (parent && hasSchedule(parent.schedule)) return parent.schedule!;
  return null;
}

export interface Availability {
  /** Open by serving hours right now (stock and manual availability are separate). */
  openNow: boolean;
  /** ISO time it next opens, when closed and calculable. */
  nextOpenAt: string | null;
  schedule: ServingSchedule | null;
}

export function availabilityAt(schedule: ServingSchedule | null, tz: string, at: Date): Availability {
  const openNow = isOpenAt(schedule, tz, at);
  return { openNow, nextOpenAt: openNow ? null : nextOpenAt(schedule, tz, at)?.toISOString() ?? null, schedule: hasSchedule(schedule) ? schedule : null };
}
