import { Clock } from 'lucide-react';
import { Field, Input } from './ui';
import { cn } from '../lib/util';
import { hasSchedule, isOpenAt, nextOpenAt, type ServingSchedule } from '../lib/schedule';

/*
 * Serving hours editor + status, shared by categories and dishes. Uses the same rules as the server
 * (lib/schedule.ts is a verbatim copy). Serving hours decide when customers can ORDER; the menu stays visible.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatNextOpen(next: Date | string | null | undefined, tz: string) {
  if (!next) return '';
  const d = typeof next === 'string' ? new Date(next) : next;
  const same = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(x);
  const time = new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  return same(d) === same(new Date()) ? `opens at ${time}` : `opens ${new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'short' }).format(d)} ${time}`;
}

export function describeSchedule(s: ServingSchedule | null | undefined) {
  if (!hasSchedule(s)) return 'Every day, 24 hours';
  const days = s!.days?.length && s!.days.length < 7 ? [...s!.days].sort((a, b) => a - b).map((d) => DAYS[d]).join(', ') : 'Every day';
  return s!.from && s!.to && s!.from !== s!.to ? `${days} · ${s!.from}–${s!.to}` : `${days} · all day`;
}

/** Compact status: "24/7", "Open now", or "Closed · opens …". */
export function ServingStatus({ hasHours, openNow, nextOpenAt: next, tz, className }: { hasHours: boolean; openNow: boolean; nextOpenAt?: string | Date | null; tz: string; className?: string }) {
  if (!hasHours) return <span className={cn('rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-stone-500', className)} title="No serving hours: orderable 24/7">24/7</span>;
  return openNow
    ? <span className={cn('rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800', className)} title="Inside its serving hours: customers can order">Open now</span>
    : <span className={cn('rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800', className)} title="Outside its serving hours: still visible on the menu, but customers cannot order it">Closed{next ? ` · ${formatNextOpen(next, tz)}` : ''}</span>;
}

export function ServingHoursEditor({ value, onChange, tz, emptyHint = 'Leave empty to allow orders 24/7.' }: { value: ServingSchedule; onChange: (s: ServingSchedule) => void; tz: string; emptyHint?: string }) {
  const s = { days: value?.days ?? [], from: value?.from ?? '', to: value?.to ?? '' };
  const now = new Date();
  const scheduled = hasSchedule(s);
  const open = isOpenAt(s, tz, now);
  const next = open ? null : nextOpenAt(s, tz, now);
  const incomplete = (!!s.from) !== (!!s.to);
  return (
    <div>
      <p className="mb-2 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
        <Clock className="me-1 inline h-3.5 w-3.5" />Serving hours decide when customers can place orders. Your menu remains visible outside these hours.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {DAYS.map((d, i) => {
          const on = s.days.includes(i);
          return <button key={d} type="button" aria-pressed={on} onClick={() => onChange({ ...s, days: on ? s.days.filter((x) => x !== i) : [...s.days, i] })} className={cn('rounded-lg border px-3 py-1.5 text-xs font-medium', on ? 'border-brand bg-brand text-brand-ink' : 'border-stone-200')}>{d}</button>;
        })}
      </div>
      <div className="mt-2 flex gap-2">
        <Field label="From"><Input type="time" value={s.from} onChange={(e) => onChange({ ...s, from: e.target.value })} /></Field>
        <Field label="To"><Input type="time" value={s.to} onChange={(e) => onChange({ ...s, to: e.target.value })} /></Field>
      </div>
      <p className="mt-1 text-xs text-stone-500">{emptyHint} No days selected = every day. A closing time before the opening time runs past midnight (e.g. 18:00–02:00).</p>
      {incomplete && <p className="mt-1 text-xs text-amber-700">Set both a From and a To time; with only one, the hours are not applied (orderable all day on the selected days).</p>}
      <p className="mt-2 text-sm" role="status">
        <span className="text-stone-500">Preview ({tz}): </span>
        <span className="font-medium">{describeSchedule(s)}</span>
        {' — '}
        {!scheduled ? <span className="font-medium text-stone-700">Available 24/7</span> : open ? <span className="font-medium text-emerald-700">Available now</span> : <span className="font-medium text-amber-700">Unavailable now{next ? `, ${formatNextOpen(next, tz)}` : ''}</span>}
      </p>
    </div>
  );
}
