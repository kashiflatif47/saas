/**
 * Serving hours (lib/schedule.ts): boundaries, weekdays, overnight windows, midnight, empty/incomplete
 * schedules (= 24/7), precedence and the next opening time — all in the restaurant's time zone (Asia/Karachi, UTC+5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityAt, effectiveSchedule, hasSchedule, isOpenAt, localParts, nextOpenAt, zonedTime } from '../../src/lib/schedule';

const TZ = 'Asia/Karachi';
// Karachi wall-clock time → instant. 2026-11-15 is a Sunday (day 0); 16 Mon … 20 Fri, 21 Sat.
const K = (date: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 10, date, hh - 5, mm));
const breakfast = { days: [], from: '07:00', to: '12:00' };

test('Karachi local time is used, not UTC', () => {
  assert.deepEqual({ day: localParts(K(16, 7), TZ).day, minutes: localParts(K(16, 7), TZ).minutes }, { day: 1, minutes: 420 });
  assert.equal(zonedTime(2026, 11, 16, 7, 0, TZ).toISOString(), '2026-11-16T02:00:00.000Z');
  // 07:30 UTC is 12:30 in Karachi: breakfast is over there even though it is "07:30" in UTC.
  assert.equal(isOpenAt(breakfast, TZ, new Date('2026-11-16T07:30:00Z')), false);
});

test('breakfast 07:00–12:00: closed before 7, open at 7, closed at 12', () => {
  assert.equal(isOpenAt(breakfast, TZ, K(16, 6, 59)), false);
  assert.equal(isOpenAt(breakfast, TZ, K(16, 7, 0)), true);
  assert.equal(isOpenAt(breakfast, TZ, K(16, 11, 59)), true);
  assert.equal(isOpenAt(breakfast, TZ, K(16, 12, 0)), false);
  assert.equal(isOpenAt(breakfast, TZ, K(16, 18, 0)), false);
});

test('next opening: same morning before 7; next morning after 12', () => {
  assert.equal(nextOpenAt(breakfast, TZ, K(16, 5, 30))?.toISOString(), K(16, 7).toISOString());
  assert.equal(nextOpenAt(breakfast, TZ, K(16, 12, 0))?.toISOString(), K(17, 7).toISOString());
  assert.equal(nextOpenAt(breakfast, TZ, K(16, 9, 0)), null, 'open now');
  assert.deepEqual(availabilityAt(breakfast, TZ, K(16, 13)), { openNow: false, nextOpenAt: K(17, 7).toISOString(), schedule: breakfast });
});

test('no schedule, empty or incomplete schedules mean 24/7 (never "closed")', () => {
  for (const s of [null, undefined, {}, { days: [] }, { days: [0, 1, 2, 3, 4, 5, 6] }, { from: '07:00' }, { to: '12:00' }, { from: '', to: '' }, { from: '09:00', to: '09:00' }, { from: '25:00', to: '12:00' }]) {
    assert.equal(hasSchedule(s as any), false, JSON.stringify(s));
    for (const h of [0, 3, 7, 12, 23]) assert.equal(isOpenAt(s as any, TZ, K(16, h)), true, `${JSON.stringify(s)} at ${h}:00`);
    assert.equal(nextOpenAt(s as any, TZ, K(16, 3)), null);
  }
});

test('selected weekdays: whole day on listed days only; next opening is the next listed day', () => {
  const weekend = { days: [5, 6] }; // Fri, Sat
  assert.equal(isOpenAt(weekend, TZ, K(20, 0, 0)), true, 'Friday 00:00');
  assert.equal(isOpenAt(weekend, TZ, K(21, 23, 59)), true, 'Saturday 23:59');
  assert.equal(isOpenAt(weekend, TZ, K(22, 0, 0)), false, 'Sunday 00:00');
  assert.equal(nextOpenAt(weekend, TZ, K(16, 10))?.toISOString(), K(20, 0).toISOString());
  const thuToSat = { days: [4, 5, 6], from: '07:59', to: '00:00' }; // Lzzat's breakfast: until midnight
  assert.equal(isOpenAt(thuToSat, TZ, K(19, 23, 59)), true, 'Thursday 23:59');
  assert.equal(isOpenAt(thuToSat, TZ, K(20, 0, 0)), false, 'Friday 00:00 (to 00:00 = until midnight)');
  assert.equal(isOpenAt(thuToSat, TZ, K(15, 2, 25)), false, 'Sunday 02:25');
  assert.equal(nextOpenAt(thuToSat, TZ, K(15, 2, 25))?.toISOString(), K(19, 7, 59).toISOString(), 'next is Thursday 07:59');
});

test('overnight 18:00–02:00 on Fridays: the part after midnight belongs to Friday', () => {
  const fridayNight = { days: [5], from: '18:00', to: '02:00' };
  assert.equal(isOpenAt(fridayNight, TZ, K(20, 17, 59)), false);
  assert.equal(isOpenAt(fridayNight, TZ, K(20, 18, 0)), true, 'Friday 18:00');
  assert.equal(isOpenAt(fridayNight, TZ, K(21, 0, 0)), true, 'Saturday 00:00 (still Friday night)');
  assert.equal(isOpenAt(fridayNight, TZ, K(21, 1, 59)), true, 'Saturday 01:59');
  assert.equal(isOpenAt(fridayNight, TZ, K(21, 2, 0)), false, 'Saturday 02:00 closed');
  assert.equal(isOpenAt(fridayNight, TZ, K(21, 18, 0)), false, 'Saturday evening is not a listed day');
  assert.equal(isOpenAt(fridayNight, TZ, K(20, 1, 0)), false, 'Friday 01:00 belongs to Thursday night, not listed');
  assert.equal(nextOpenAt(fridayNight, TZ, K(21, 3))?.toISOString(), K(27, 18).toISOString(), 'next Friday 18:00');
  const daily = { days: [], from: '14:00', to: '01:49' };
  assert.equal(isOpenAt(daily, TZ, K(16, 1, 30)), true);
  assert.equal(isOpenAt(daily, TZ, K(16, 2, 25)), false);
  assert.equal(nextOpenAt(daily, TZ, K(16, 2, 25))?.toISOString(), K(16, 14).toISOString());
});

test('precedence: dish override > category > parent category > 24/7', () => {
  const cat = { schedule: breakfast };
  const parent = { schedule: { days: [5] } };
  assert.equal(effectiveSchedule({}, cat, parent), breakfast, 'inherits its category');
  assert.deepEqual(effectiveSchedule({}, { schedule: { days: [] } }, parent), { days: [5] }, 'empty category hours → parent');
  assert.equal(effectiveSchedule({}, { schedule: {} }, null), null, 'nothing configured → 24/7');
  const own = { days: [1], from: '19:00', to: '23:00' };
  assert.equal(effectiveSchedule({ scheduleOverride: true, schedule: own }, cat, parent), own, 'dish override wins');
  assert.equal(effectiveSchedule({ scheduleOverride: true, schedule: { days: [] } }, cat, parent), null, 'override with no hours = 24/7');
  assert.equal(effectiveSchedule({ scheduleOverride: false, schedule: own }, cat, null), breakfast, 'a saved but unused dish schedule is ignored');
});
