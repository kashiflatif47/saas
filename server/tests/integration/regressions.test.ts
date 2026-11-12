import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb, PW } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { Plan } from '../../src/models/platform';
import { Order, Payment } from '../../src/models/operations';
import { StockMovement } from '../../src/models/inventory';

/**
 * Regression tests for defects found in the 2026-11-11 bug audit (TABLESAAS_BUG_AUDIT.md).
 * Each test names the audit issue it covers.
 */
let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let saToken: string;
let planId: string;
let T: Awaited<ReturnType<typeof provisionTenant>>;
const s: Record<string, any> = {};

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  saToken = p.saToken;
  planId = p.planId;
  T = await provisionTenant(app, saToken, planId, 'regr');
  // Menu: one category, one product with an inventory recipe, one QR table.
  const inv = await request(app).post('/api/staff/inventory/items').set(auth(T.token)).send({ name: 'Rice', unit: 'kg', openingQuantity: 100 });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  s.rice = inv.body._id;
  const cat = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Mains' } });
  s.cat = cat.body._id;
  const prod = await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ categoryId: s.cat, name: { en: 'Biryani' }, price: 500_00, recipe: [{ inventoryItemId: s.rice, quantity: 0.25 }] });
  assert.equal(prod.status, 201, JSON.stringify(prod.body));
  s.product = prod.body._id;
  const tbl = await request(app).post('/api/staff/tables').set(auth(T.token)).send({ label: 'R1' });
  s.table = tbl.body.items[0];
});
after(async () => stopDb(mongod));

const placeQrOrder = (extra: Record<string, unknown> = {}) =>
  request(app).post('/api/public/orders').set('Host', T.host).send({ type: 'dine_in', tableToken: s.table.qrToken, items: [{ productId: s.product, quantity: 1 }], ...extra });

test('BUG-001: an invalid timezone is rejected instead of crashing the storefront menu and dashboard', async () => {
  const bad = await request(app).patch('/api/staff/tenant/settings').set(auth(T.token)).send({ settings: { timezone: 'Not/A_Zone' } });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  const good = await request(app).patch('/api/staff/tenant/settings').set(auth(T.token)).send({ settings: { timezone: 'Asia/Karachi' } });
  assert.equal(good.status, 200);
  // A scheduled category makes the public menu evaluate the timezone.
  const sched = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Breakfast' }, schedule: { days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59' } });
  assert.equal(sched.status, 201);
  assert.equal((await request(app).get('/api/public/menu').set('Host', T.host)).status, 200);
  assert.equal((await request(app).get('/api/staff/analytics/dashboard').set(auth(T.token))).status, 200);
});

test('BUG-001b: a bad timezone already stored in the database does not crash the menu or dashboard', async () => {
  const { Tenant } = await import('../../src/models/platform');
  const { invalidateTenantCache } = await import('../../src/services/tenantResolver');
  await Tenant.updateOne({ _id: T.tenantId }, { $set: { 'settings.timezone': 'Pakistan/Lahore' } }); // invalid, saved before validation
  invalidateTenantCache();
  try {
    assert.equal((await request(app).get('/api/public/menu').set('Host', T.host)).status, 200);
    assert.equal((await request(app).get('/api/staff/analytics/dashboard').set(auth(T.token))).status, 200);
    assert.equal((await request(app).get('/api/staff/analytics/summary?period=week').set(auth(T.token))).status, 200);
  } finally {
    await Tenant.updateOne({ _id: T.tenantId }, { $set: { 'settings.timezone': 'Asia/Karachi' } });
    invalidateTenantCache();
  }
});

test('BUG-004b: two cooks finishing different items of one order at the same moment both succeed', async () => {
  const o = await placeQrOrder({ items: [{ productId: s.product, quantity: 1, notes: 'a' }, { productId: s.product, quantity: 1, notes: 'b' }] });
  const id = o.body.order._id;
  assert.equal((await request(app).post(`/api/staff/orders/${id}/status`).set(auth(T.token)).send({ status: 'accepted' })).status, 200);
  const [i1, i2] = o.body.order.items.map((i: any) => i._id);
  const results = await Promise.all([i1, i2].map((itemId) => request(app).post(`/api/staff/orders/${id}/items/${itemId}/status`).set(auth(T.token)).send({ status: 'ready' })));
  assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results.map((r) => r.body)));
  const order = await Order.findOne({ tenantId: T.tenantId, _id: id }).lean();
  assert.deepEqual(order!.items.map((i: any) => i.status), ['ready', 'ready']);
  assert.equal(order!.status, 'ready');
});

test('BUG-002: owners on a plan without multi-language can save settings after provisioning', async () => {
  const starter = await Plan.create({ name: 'Starter', code: 'starter-regr', priceMonthly: 100, trialDays: 14, features: ['qr_ordering', 'kds'] });
  const U = await provisionTenant(app, saToken, String(starter._id), 'starter-regr');
  const tenant = await request(app).get('/api/staff/tenant').set(auth(U.token));
  assert.deepEqual(tenant.body.settings.languages, ['en'], 'new tenants only get the languages their plan includes');
  // The Settings page sends the whole settings object back.
  const save = await request(app).patch('/api/staff/tenant/settings').set(auth(U.token)).send({ settings: { ...tenant.body.settings, taxRatePercent: 5 } });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  // Expanding to several languages without the feature is still refused.
  const expand = await request(app).patch('/api/staff/tenant/settings').set(auth(U.token)).send({ settings: { languages: ['en', 'ar'] } });
  assert.equal(expand.status, 402);
});

test('BUG-002b: an existing tenant that already has several languages can still save other settings', async () => {
  const starter = await Plan.findOne({ code: 'starter-regr' }).lean();
  const V = await provisionTenant(app, saToken, String(starter!._id), 'legacy-langs');
  const { Tenant } = await import('../../src/models/platform');
  await Tenant.updateOne({ _id: V.tenantId }, { $set: { 'settings.languages': ['en', 'ur', 'ar'] } }); // data created before the fix
  const { invalidateTenantCache } = await import('../../src/services/tenantResolver');
  invalidateTenantCache();
  const tenant = await request(app).get('/api/staff/tenant').set(auth(V.token));
  const save = await request(app).patch('/api/staff/tenant/settings').set(auth(V.token)).send({ settings: { ...tenant.body.settings, serviceChargePercent: 3 } });
  assert.equal(save.status, 200, JSON.stringify(save.body));
});

test('BUG-003: concurrent cash payments cannot over-collect an order', async () => {
  const o = await placeQrOrder();
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const id = o.body.order._id;
  const total = o.body.order.total;
  const results = await Promise.all([1, 2, 3].map(() => request(app).post(`/api/staff/orders/${id}/payments/cash`).set(auth(T.token)).send({ amount: total })));
  const ok = results.filter((r) => r.status === 201);
  assert.equal(ok.length, 1, `exactly one payment may succeed, got ${results.map((r) => r.status).join(',')}`);
  for (const r of results.filter((x) => x.status !== 201)) assert.ok([400, 409].includes(r.status), `unexpected ${r.status}`);
  const verified = await Payment.countDocuments({ tenantId: T.tenantId, orderId: id, status: 'verified', kind: 'charge' });
  assert.equal(verified, 1);
  const order = await Order.findOne({ tenantId: T.tenantId, _id: id }).lean();
  assert.equal(order!.amountPaid, total);
  assert.equal(order!.paymentStatus, 'paid');
});

test('BUG-004: concurrent accepts are applied once (no double inventory deduction)', async () => {
  const o = await placeQrOrder();
  const id = o.body.order._id;
  const results = await Promise.all([1, 2, 3].map(() => request(app).post(`/api/staff/orders/${id}/status`).set(auth(T.token)).send({ status: 'accepted' })));
  assert.equal(results.filter((r) => r.status === 200).length, 1, results.map((r) => `${r.status}`).join(','));
  for (const r of results.filter((x) => x.status !== 200)) assert.ok([400, 409].includes(r.status), `unexpected ${r.status} ${JSON.stringify(r.body)}`);
  const moves = await StockMovement.countDocuments({ tenantId: T.tenantId, refType: 'Order', refId: id, type: 'consumption' });
  assert.equal(moves, 1);
  const order = await Order.findOne({ tenantId: T.tenantId, _id: id }).lean();
  assert.equal(order!.statusHistory.filter((h: any) => h.status === 'accepted').length, 1);
});

test('BUG-005: retrying checkout with the same idempotency key does not create a duplicate order', async () => {
  const key = crypto.randomUUID();
  const before = await Order.countDocuments({ tenantId: T.tenantId });
  const a = await placeQrOrder({ idempotencyKey: key });
  const b = await placeQrOrder({ idempotencyKey: key });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.order._id, a.body.order._id);
  assert.equal(b.body.trackingToken, a.body.trackingToken);
  // Simultaneous double-tap
  const key2 = crypto.randomUUID();
  const [c, d] = await Promise.all([placeQrOrder({ idempotencyKey: key2 }), placeQrOrder({ idempotencyKey: key2 })]);
  assert.equal(c.body.order._id, d.body.order._id);
  assert.equal(await Order.countDocuments({ tenantId: T.tenantId }), before + 2);
  // Keys are tenant-scoped and never leak: the key is not part of public order payloads.
  assert.equal(a.body.order.idempotencyKey, undefined);
  // Without a key, orders are independent (existing behaviour).
  const e = await placeQrOrder();
  const f = await placeQrOrder();
  assert.notEqual(e.body.order._id, f.body.order._id);
});

test('BUG-006: cash cannot be recorded against a cancelled order', async () => {
  const o = await placeQrOrder();
  const id = o.body.order._id;
  const c = await request(app).post(`/api/staff/orders/${id}/status`).set(auth(T.token)).send({ status: 'cancelled', reason: 'Guest left' });
  assert.equal(c.status, 200);
  const pay = await request(app).post(`/api/staff/orders/${id}/payments/cash`).set(auth(T.token)).send({ amount: 100 });
  assert.equal(pay.status, 400);
});

test('BUG-007: a category that has subcategories cannot be moved under another category', async () => {
  const a = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Drinks' } });
  const child = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Hot drinks' }, parentId: a.body._id });
  assert.equal(child.status, 201);
  const b = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Beverages' } });
  const move = await request(app).patch(`/api/staff/menu/categories/${a.body._id}`).set(auth(T.token)).send({ parentId: b.body._id });
  assert.equal(move.status, 400, JSON.stringify(move.body));
});

test('BUG-010: editing a staff profile only signs the person out when access actually changes', async () => {
  const me = await request(app).get('/api/auth/me').set(auth(T.token));
  const ownerId = me.body.user.id;
  // The Staff page always sends the full form, including unchanged permission overrides.
  const own = await request(app).patch(`/api/staff/staff/${ownerId}`).set(auth(T.token)).send({ name: 'Owner Renamed', phone: '0300', permissionOverrides: { grant: [], revoke: [] }, isActive: true });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal((await request(app).get('/api/auth/me').set(auth(T.token))).status, 200, 'owner must stay signed in after editing their own profile');

  const w = await request(app).post('/api/staff/staff').set(auth(T.token)).send({ name: 'Wendy', email: 'wendy@regr.test', password: PW, role: 'waiter' });
  const login = await request(app).post('/api/auth/login').send({ email: 'wendy@regr.test', password: PW, tenantSlug: 'regr' });
  const wt = login.body.accessToken;
  const phone = await request(app).patch(`/api/staff/staff/${w.body._id}`).set(auth(T.token)).send({ name: 'Wendy', phone: '0301', role: 'waiter', permissionOverrides: { grant: [], revoke: [] }, isActive: true });
  assert.equal(phone.status, 200);
  assert.equal((await request(app).get('/api/auth/me').set(auth(wt))).status, 200, 'a phone change must not sign the waiter out');
  // A real access change still revokes immediately.
  const role = await request(app).patch(`/api/staff/staff/${w.body._id}`).set(auth(T.token)).send({ role: 'cashier' });
  assert.equal(role.status, 200);
  assert.equal((await request(app).get('/api/auth/me').set(auth(wt))).status, 401);
});

test('BUG-011: pressing "Pay online" again reuses the open payment intent instead of creating a second one', async () => {
  const { Tenant } = await import('../../src/models/platform');
  const { encryptSecret } = await import('../../src/lib/crypto');
  await Tenant.updateOne({ _id: T.tenantId }, { $set: { 'payments.provider': 'stripe', 'payments.providerSecretEnc': encryptSecret('sk_test_dummy', process.env.ENCRYPTION_KEY!) } });
  const o = await placeQrOrder();
  const { order, trackingToken } = o.body;
  await Payment.create({ tenantId: T.tenantId, orderId: order._id, kind: 'charge', method: 'online', provider: 'stripe', amount: order.total, currency: 'PKR', status: 'pending', providerRef: 'pi_existing', clientSecret: 'pi_existing_secret_abc' });
  // No real provider calls in tests: count any attempt.
  const realFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls++;
    throw new Error('network disabled in tests');
  }) as any;
  try {
    const r = await request(app).post(`/api/public/orders/${order._id}/pay`).set('Host', T.host).send({ token: trackingToken });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.clientSecret, 'pi_existing_secret_abc');
    assert.equal(providerCalls, 0);
    assert.equal(await Payment.countDocuments({ tenantId: T.tenantId, orderId: order._id, kind: 'charge' }), 1);
  } finally {
    globalThis.fetch = realFetch;
    await Tenant.updateOne({ _id: T.tenantId }, { $set: { 'payments.provider': 'none' } });
  }
});

test('BUG-012: deactivating staff or suspending a restaurant closes their live socket connections', async () => {
  const http = await import('node:http');
  const { io: ioClient } = await import('socket.io-client');
  const { initSockets } = await import('../../src/sockets');
  const server = http.createServer(app);
  const io = initSockets(server);
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const within = <X>(p: Promise<X>, what: string, ms = 5000) =>
    Promise.race([p, new Promise<X>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms))]);
  const W = await provisionTenant(app, saToken, planId, 'sockets-regr');
  const k = await request(app).post('/api/staff/staff').set(auth(W.token)).send({ name: 'Kim', email: 'kim@sock.test', password: PW, role: 'kitchen' });
  const kt = (await request(app).post('/api/auth/login').send({ email: 'kim@sock.test', password: PW, tenantSlug: 'sockets-regr' })).body.accessToken;
  const kitchen = ioClient(url, { auth: { token: kt }, transports: ['websocket'], reconnection: false });
  const owner = ioClient(url, { auth: { token: W.token }, transports: ['websocket'], reconnection: false });
  try {
    await within(Promise.all([new Promise<void>((r) => kitchen.once('connect', () => r())), new Promise<void>((r) => owner.once('connect', () => r()))]), 'sockets to connect');
    const kitchenGone = new Promise((r) => kitchen.once('disconnect', r));
    assert.equal((await request(app).delete(`/api/staff/staff/${k.body._id}`).set(auth(W.token))).status, 200);
    await within(kitchenGone, 'deactivated user socket to be closed');
    assert.ok(owner.connected, 'other staff stay connected');
    const ownerGone = new Promise((r) => owner.once('disconnect', r));
    const sus = await request(app).post(`/api/platform/tenants/${W.tenantId}/status`).set(auth(saToken)).send({ status: 'suspended', reason: 'test' });
    assert.equal(sus.status, 200);
    await within(ownerGone, 'suspended tenant socket to be closed');
  } finally {
    kitchen.close();
    owner.close();
    await new Promise<void>((r) => io.close(() => r()));
  }
});

test('BUG-008: reactivating a staff account respects the plan staff limit', async () => {
  const small = await Plan.create({ name: 'Tiny', code: 'tiny-regr', priceMonthly: 100, trialDays: 14, features: [], limits: { maxStaff: 2 } });
  const U = await provisionTenant(app, saToken, String(small._id), 'tiny-regr');
  const w = await request(app).post('/api/staff/staff').set(auth(U.token)).send({ name: 'Waiter A', email: 'a@tiny.test', password: PW, role: 'waiter' });
  assert.equal(w.status, 201);
  assert.equal((await request(app).delete(`/api/staff/staff/${w.body._id}`).set(auth(U.token))).status, 200);
  const w2 = await request(app).post('/api/staff/staff').set(auth(U.token)).send({ name: 'Waiter B', email: 'b@tiny.test', password: PW, role: 'waiter' });
  assert.equal(w2.status, 201); // owner + B = 2 active
  const reactivate = await request(app).patch(`/api/staff/staff/${w.body._id}`).set(auth(U.token)).send({ isActive: true });
  assert.equal(reactivate.status, 402, JSON.stringify(reactivate.body));
});

test('BUG-013: restoring an archived dish respects the plan product limit', async () => {
  const small = await Plan.create({ name: 'OneDish', code: 'onedish-regr', priceMonthly: 100, trialDays: 14, features: [], limits: { maxProducts: 1 } });
  const U = await provisionTenant(app, saToken, String(small._id), 'onedish-regr');
  const cat = await request(app).post('/api/staff/menu/categories').set(auth(U.token)).send({ name: { en: 'Only' } });
  const a = await request(app).post('/api/staff/menu/products').set(auth(U.token)).send({ categoryId: cat.body._id, name: { en: 'A' }, price: 100 });
  assert.equal(a.status, 201);
  assert.equal((await request(app).delete(`/api/staff/menu/products/${a.body._id}`).set(auth(U.token))).status, 200);
  const b = await request(app).post('/api/staff/menu/products').set(auth(U.token)).send({ categoryId: cat.body._id, name: { en: 'B' }, price: 100 });
  assert.equal(b.status, 201);
  const restore = await request(app).patch(`/api/staff/menu/products/${a.body._id}`).set(auth(U.token)).send({ isArchived: false });
  assert.equal(restore.status, 402, JSON.stringify(restore.body));
  // Ordinary edits of an active dish are unaffected by the limit.
  assert.equal((await request(app).patch(`/api/staff/menu/products/${b.body._id}`).set(auth(U.token)).send({ price: 200 })).status, 200);
});

test('COVERAGE: changing your own password keeps this session, revokes older tokens and works for the next login', async () => {
  const V = await provisionTenant(app, saToken, planId, 'pw-regr');
  const wrong = await request(app).post('/api/auth/change-password').set(auth(V.token)).send({ currentPassword: 'not-the-password', newPassword: 'A-brand-new-Passw0rd' });
  assert.equal(wrong.status, 400);
  const short = await request(app).post('/api/auth/change-password').set(auth(V.token)).send({ currentPassword: PW, newPassword: 'short' });
  assert.equal(short.status, 400);
  const ok = await request(app).post('/api/auth/change-password').set(auth(V.token)).send({ currentPassword: PW, newPassword: 'A-brand-new-Passw0rd' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await request(app).get('/api/auth/me').set(auth(V.token))).status, 401, 'old access token revoked');
  assert.equal((await request(app).get('/api/auth/me').set(auth(ok.body.accessToken))).status, 200, 'new token from the response works');
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'owner@pw-regr.test', password: PW, tenantSlug: 'pw-regr' })).status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'owner@pw-regr.test', password: 'A-brand-new-Passw0rd', tenantSlug: 'pw-regr' })).status, 200);
});
