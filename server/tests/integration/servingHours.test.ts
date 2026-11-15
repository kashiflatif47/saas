/**
 * Serving hours through the real API with a fixed clock (Asia/Karachi): the whole menu is always returned;
 * hours only decide whether a dish can be ordered, and the server enforces that for storefront and QR orders.
 */
import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app';
import { scheduleClock } from '../../src/lib/schedule';

let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let T: Awaited<ReturnType<typeof provisionTenant>>;
const R = (rupees: number) => rupees * 100;
const ids: Record<string, any> = {};
const realNow = scheduleClock.now;
// Karachi wall clock (UTC+5). 2026-11-16 is a Monday.
const at = (date: number, hh: number, mm = 0) => { scheduleClock.now = () => new Date(Date.UTC(2026, 10, date, hh - 5, mm)); };

const pub = (p: string) => `/api/public/tenants/${T.slug}${p}`;
let guest = 0;
const order = (productId: string, extra: any = {}) =>
  request(app).post(pub('/orders')).set('X-Forwarded-For', `10.8.0.${++guest}`).send({ type: 'takeaway', customer: { name: 'Sana' }, items: [{ productId, quantity: 1 }], ...extra });
const menu = async () => (await request(app).get(pub('/menu'))).body;
const dish = (m: any, id: string) => m.products.find((p: any) => p._id === id);

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  T = await provisionTenant(app, p.saToken, p.planId, 'nashta-ghar');
  await request(app).patch('/api/staff/tenant/settings').set(auth(T.token)).send({ settings: { timezone: 'Asia/Karachi' } }).expect(200);
  const mk = async (name: string, schedule?: any) => (await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: name }, ...(schedule ? { schedule } : {}) })).body._id;
  ids.breakfast = await mk('Breakfast', { days: [], from: '07:00', to: '12:00' });
  ids.allDay = await mk('Drinks');
  ids.night = await mk('Late night', { days: [5], from: '18:00', to: '02:00' });
  const prod = async (categoryId: string, name: string, extra: any = {}) => (await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ categoryId, name: { en: name }, price: R(500), ...extra })).body._id;
  ids.halwa = await prod(ids.breakfast, 'Halwa Puri');
  ids.paratha = await prod(ids.breakfast, 'Aloo Paratha', { scheduleOverride: true, schedule: { days: [], from: '06:00', to: '23:00' } });
  ids.chai = await prod(ids.allDay, 'Doodh Patti');
  ids.offDish = await prod(ids.allDay, 'Lassi', { isAvailable: false });
  ids.soldOut = await prod(ids.allDay, 'Kulfi', { trackStock: true, stockQty: 0 });
  ids.bbq = await prod(ids.night, 'Seekh Kabab');
  const table = await request(app).post('/api/staff/tables').set(auth(T.token)).send({ label: 'T1' });
  ids.qr = table.body.items[0].qrToken;
});

after(async () => {
  scheduleClock.now = realNow;
  await stopDb(mongod);
});

test('before 7 AM: breakfast dishes are in the menu but not orderable, with their next opening', async () => {
  at(16, 6, 30);
  const m = await menu();
  const h = dish(m, ids.halwa);
  assert.ok(h, 'visible');
  assert.equal(h.availability.isAvailableNow, false);
  assert.equal(h.availability.reason, 'closed');
  assert.equal(h.availability.nextAvailableAt, '2026-11-16T02:00:00.000Z', '07:00 Karachi');
  assert.deepEqual(m.categories.find((c: any) => c._id === ids.breakfast).availability.schedule, { days: [], from: '07:00', to: '12:00' });
  const r = await order(ids.halwa);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'NOT_SERVING_NOW');
  assert.match(r.body.error.message, /Halwa Puri is not being served right now \(available again Mon 07:00\)/);
});

test('at 7 AM: visible and orderable', async () => {
  at(16, 7, 0);
  assert.equal(dish(await menu(), ids.halwa).availability.isAvailableNow, true);
  const r = await order(ids.halwa);
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('at 12 PM and after: still in the menu (search and category navigation have it), ordering disabled; next opening tomorrow 7 AM', async () => {
  for (const [h, m] of [[12, 0], [15, 45]]) {
    at(16, h, m);
    const data = await menu();
    const d = dish(data, ids.halwa);
    assert.ok(d, `present at ${h}:${m}`);
    assert.equal(d.categoryId, ids.breakfast, 'still under its category');
    assert.ok(data.categories.some((c: any) => c._id === ids.breakfast), 'category still listed');
    assert.equal(d.availability.isAvailableNow, false);
    assert.equal(d.availability.nextAvailableAt, '2026-11-17T02:00:00.000Z');
    assert.equal((await order(ids.halwa)).status, 409);
  }
  at(17, 7, 0);
  assert.equal((await order(ids.halwa)).status, 201, 'orderable again at the next opening, no admin action');
});

test('a category without hours is available 24/7', async () => {
  for (const h of [0, 3, 12, 23]) {
    at(16, h, 30);
    const d = dish(await menu(), ids.chai);
    assert.equal(d.availability.isAvailableNow, true, `${h}:30`);
    assert.equal(d.availability.schedule, null);
    assert.equal((await order(ids.chai)).status, 201);
  }
});

test('a dish inherits its category hours unless it has its own override', async () => {
  at(16, 6, 30);
  const m = await menu();
  assert.equal(dish(m, ids.halwa).availability.isAvailableNow, false, 'inherits breakfast');
  assert.equal(dish(m, ids.paratha).availability.isAvailableNow, true, 'own hours 06:00–23:00');
  assert.equal((await order(ids.paratha)).status, 201);
  at(16, 23, 30);
  assert.equal((await order(ids.paratha)).status, 409);
});

test('switched-off and sold-out dishes stay visible but never orderable, even inside hours', async () => {
  at(16, 10, 0);
  const m = await menu();
  for (const id of [ids.offDish, ids.soldOut]) {
    const d = dish(m, id);
    assert.ok(d, 'visible');
    assert.equal(d.availability.isAvailableNow, false);
    assert.equal(d.availability.reason, 'unavailable');
  }
  assert.equal((await order(ids.offDish)).status, 400);
  assert.equal((await order(ids.soldOut)).status, 409);
});

test('table QR orders cannot bypass serving hours; staff (POS) orders are not restricted', async () => {
  at(16, 14, 0);
  const qr = await order(ids.halwa, { type: 'dine_in', tableToken: ids.qr });
  assert.equal(qr.status, 409);
  assert.equal(qr.body.error.code, 'NOT_SERVING_NOW');
  const pos = await request(app).post('/api/staff/orders').set(auth(T.token)).send({ type: 'takeaway', items: [{ productId: ids.halwa, quantity: 1 }] });
  assert.equal(pos.status, 201, 'POS behaviour unchanged');
});

test('overnight Friday 18:00–02:00 works across midnight', async () => {
  at(20, 17, 59);
  assert.equal((await order(ids.bbq)).status, 409);
  at(21, 1, 30); // Saturday 01:30 is still Friday night
  assert.equal(dish(await menu(), ids.bbq).availability.isAvailableNow, true);
  assert.equal((await order(ids.bbq)).status, 201);
  at(21, 2, 0);
  const d = dish(await menu(), ids.bbq);
  assert.equal(d.availability.isAvailableNow, false);
  assert.equal(d.availability.nextAvailableAt, '2026-11-27T13:00:00.000Z', 'next Friday 18:00 Karachi');
});

test('admin sees each category\'s status: open now / closed with next opening / 24-7', async () => {
  at(16, 6, 30);
  const cats = (await request(app).get('/api/staff/menu/categories').set(auth(T.token))).body.items;
  const by = (id: string) => cats.find((c: any) => c._id === id);
  assert.deepEqual([by(ids.breakfast).openNow, by(ids.breakfast).nextOpenAt, by(ids.breakfast).hasSchedule], [false, '2026-11-16T02:00:00.000Z', true]);
  assert.deepEqual([by(ids.allDay).openNow, by(ids.allDay).hasSchedule], [true, false]);
});

test('"coming soon" condition: the menu is never empty because of hours; only a restaurant with no dishes is empty', async () => {
  at(16, 3, 0); // everything scheduled is closed
  const m = await menu();
  assert.equal(m.products.length, 6, 'every published dish is returned at 3 AM');
  const empty = await bootstrapEmpty();
  assert.equal(empty.products.length, 0);
});

async function bootstrapEmpty() {
  const r = await request(app).post('/api/platform/tenants').set(auth((await request(app).post('/api/auth/login').send({ email: 'sa@test.local', password: 'Sup3r-Secret-Pass!' })).body.accessToken))
    .send({ name: 'Empty Place', slug: 'empty-place', planId: (await request(app).get('/api/platform/plans').set(auth((await request(app).post('/api/auth/login').send({ email: 'sa@test.local', password: 'Sup3r-Secret-Pass!' })).body.accessToken))).body[0]._id, owner: { name: 'Owner', email: 'o@empty.test', password: 'Sup3r-Secret-Pass!' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return (await request(app).get('/api/public/tenants/empty-place/menu')).body;
}
