import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb, PW } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { Order, Payment, CashShift, SyncReceipt } from '../../src/models/operations';
import { Product } from '../../src/models/menu';
import { OfflineEngine, MAX_AUTO_RETRIES } from '../../../client/src/offline/engine';
import { MemoryStore } from '../../../client/src/offline/memoryStore';
import { createOfflineOrder } from '../../../client/src/offline/pos';
import { NetworkError, type Transport, type WireOp } from '../../../client/src/offline/types';

/**
 * Offline-first POS & kitchen: the REAL client sync engine (client/src/offline) running against the REAL API.
 * "Offline" = the transport throws NetworkError; a "restart" = a new engine over the same stored data.
 */
let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let saToken: string;
let planId: string;
let T: Awaited<ReturnType<typeof provisionTenant>>;
let B: Awaited<ReturnType<typeof provisionTenant>>;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};
const s: Record<string, any> = {};

const login = async (email: string, slug = 'offl') => (await request(app).post('/api/auth/login').send({ email, password: PW, tenantSlug: slug })).body;

/** Transport to the real API with switchable connectivity and "response lost after the server processed it". */
function makeTransport(getToken: () => string) {
  const state = { online: true, loseNextResponse: false, calls: 0, status503: 0 };
  const t: Transport = async (op: WireOp) => {
    state.calls++;
    if (!state.online) throw new NetworkError('offline');
    if (state.status503 > 0) {
      state.status503--;
      return { ok: false, httpStatus: 503, code: 'UNAVAILABLE', message: 'Service unavailable' };
    }
    const r = await request(app).post('/api/staff/sync').set(auth(getToken())).send(op);
    if (state.loseNextResponse) {
      state.loseNextResponse = false;
      throw new NetworkError('connection dropped before the response arrived');
    }
    if (r.status >= 200 && r.status < 300) return { ok: true, data: r.body };
    return { ok: false, httpStatus: r.status, code: r.body?.error?.code ?? 'ERROR', message: r.body?.error?.message ?? '', details: r.body?.error?.details };
  };
  return { t, state };
}

async function menuSnapshot(token: string) {
  const [p, c, tb, st, tenant] = await Promise.all([
    request(app).get('/api/staff/menu/products?limit=200').set(auth(token)),
    request(app).get('/api/staff/menu/categories').set(auth(token)),
    request(app).get('/api/staff/tables').set(auth(token)),
    request(app).get('/api/staff/menu/stations').set(auth(token)),
    request(app).get('/api/auth/me').set(auth(token)),
  ]);
  const set = tenant.body.tenant.settings;
  return {
    menu: { products: p.body.items, categories: c.body.items, stations: st.body.items },
    cfg: { currency: set.currency, taxRatePercent: set.taxRatePercent, taxInclusive: set.taxInclusive, serviceChargePercent: set.serviceChargePercent, deliveryFee: set.deliveryFee, orderTypes: set.orderTypes, requireTableForDineIn: set.requireTableForDineIn, maxManualDiscountPercent: set.maxManualDiscountPercent },
    tables: tb.body.items,
    pricesAsOf: new Date().toISOString(),
  };
}

function device(who: string, userId: string, userName: string, tenantId = T.tenantId, store = new MemoryStore()) {
  const { t, state } = makeTransport(() => tok[who]);
  const engine = new OfflineEngine(store, { tenantId, userId, userName, deviceId: `dev-${who}-${crypto.randomBytes(3).toString('hex')}` }, t);
  return { engine, state, store };
}

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  saToken = p.saToken;
  planId = p.planId;
  T = await provisionTenant(app, saToken, planId, 'offl');
  B = await provisionTenant(app, saToken, planId, 'offl-b');
  await request(app).patch('/api/staff/tenant/settings').set(auth(T.token)).send({ settings: { taxRatePercent: 15, taxInclusive: false, serviceChargePercent: 0, orderTypes: ['dine_in', 'takeaway', 'pickup', 'delivery'], requireTableForDineIn: false } });
  for (const role of ['cashier', 'kitchen', 'manager']) {
    const r = await request(app).post('/api/staff/staff').set(auth(T.token)).send({ name: `${role} off`, email: `${role}@offl.test`, password: PW, role });
    ids[role] = r.body._id;
    tok[role] = (await login(`${role}@offl.test`)).accessToken;
  }
  tok.owner = T.token;
  ids.owner = (await request(app).get('/api/auth/me').set(auth(T.token))).body.user.id;
  const cat = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Main' } });
  s.cat = cat.body._id;
  s.tea = (await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ categoryId: s.cat, name: { en: 'Tea' }, price: 10_00, prepMinutes: 3 })).body;
  s.cake = (await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ categoryId: s.cat, name: { en: 'Cake' }, price: 20_00, trackStock: true, stockQty: 2 })).body;
  s.soup = (await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ categoryId: s.cat, name: { en: 'Soup' }, price: 15_00 })).body;
  s.table = (await request(app).post('/api/staff/tables').set(auth(T.token)).send({ label: 'O1' })).body.items[0];
});
after(async () => stopDb(mongod));

const cashierActor = { name: 'cashier off', role: 'cashier', canDiscount: false };

test('offline orders are saved locally, survive a restart, sync once and never duplicate on repeated syncs', async () => {
  const snap = await menuSnapshot(tok.cashier);
  const d = device('cashier', ids.cashier, 'cashier off');
  await d.engine.init();
  d.state.online = false; // connection lost
  const o1 = await createOfflineOrder(d.engine, { ...snap, actor: cashierActor, tenantId: T.tenantId }, { type: 'takeaway', items: [{ productId: s.tea._id, quantity: 2 }] });
  const o2 = await createOfflineOrder(d.engine, { ...snap, actor: cashierActor, tenantId: T.tenantId }, { type: 'dine_in', tableId: s.table._id, items: [{ productId: s.soup._id, quantity: 1, notes: 'no salt' }] });
  assert.equal(o1.totals.total, 23_00); // 20.00 + 15 %
  assert.equal(o1.syncState, 'saved_local');
  assert.match(o1.localNumber, /^OFF-/);
  assert.equal((await d.engine.sync()).stop, 'offline');
  assert.equal(await Order.countDocuments({ tenantId: T.tenantId }), 0, 'nothing reached the server while offline');

  // Browser restart while still offline: a new engine over the same storage still has both orders.
  const restarted = new OfflineEngine(d.store.reopen(), { tenantId: T.tenantId, userId: ids.cashier, userName: 'cashier off', deviceId: 'same-device' }, d.engine['transport']);
  await restarted.init();
  assert.equal((await restarted.orders()).length, 2);
  const sum = await restarted.summary();
  assert.equal(sum.pendingOrders, 2);

  d.state.online = true; // connection back
  const r = await restarted.sync({ force: true });
  assert.equal(r.stop, 'done');
  const server = await Order.find({ tenantId: T.tenantId }).sort({ createdAt: 1 }).lean();
  assert.equal(server.length, 2);
  assert.equal(server[0].total, 23_00);
  assert.equal(server[0].status, 'accepted', 'offline POS orders are confirmed to the kitchen');
  assert.match(String(server[0].offline?.deviceId), /^dev-cashier-/, 'device that took the order is recorded');
  assert.ok(server[0].offline?.createdAt);
  assert.equal(server[1].items[0].notes, 'no salt');
  const local = await restarted.order(o1.localId);
  assert.equal(local!.syncState, 'confirmed');
  assert.equal(local!.serverOrderNumber, server[0].orderNumber);

  // Repeated syncs and a replayed operation create nothing new.
  await restarted.sync({ force: true });
  const op = (await restarted.ops())[0];
  const replay = await request(app).post('/api/staff/sync').set(auth(tok.cashier)).send({ id: op.id, type: op.type, tenantId: op.tenantId, userId: op.userId, deviceId: op.deviceId, createdAt: op.createdAt, payload: op.payload });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(await Order.countDocuments({ tenantId: T.tenantId }), 2);
  s.serverOrders = server;
});

test('interrupted sync (response lost after the server processed it) and a crash mid-sync are retried safely', async () => {
  const snap = await menuSnapshot(tok.cashier);
  const d = device('cashier', ids.cashier, 'cashier off');
  await d.engine.init();
  d.state.online = false;
  const o = await createOfflineOrder(d.engine, { ...snap, actor: cashierActor, tenantId: T.tenantId }, { type: 'takeaway', items: [{ productId: s.soup._id, quantity: 2 }] });
  await d.engine.recordCash({ localOrderId: o.localId }, 34_50); // 30.00 + 15 %
  await assert.rejects(d.engine.recordCash({ localOrderId: o.localId }, 1), /exceeds/, 'cannot take more cash than the order total');
  d.state.online = true;
  const before = await Order.countDocuments({ tenantId: T.tenantId });
  d.state.loseNextResponse = true;
  const first = await d.engine.sync({ force: true });
  assert.equal(first.stop, 'offline');
  assert.equal((await d.engine.op(o.opId))!.status, 'pending', 'not marked synced without a confirmed response');
  assert.equal(await Order.countDocuments({ tenantId: T.tenantId }), before + 1, 'the server did process it');

  // Simulate a tab closed while an operation was "syncing", then reopened.
  const payOp = (await d.engine.ops()).find((x) => x.type === 'payment.cash')!;
  await d.store.put('ops', payOp.id, { ...payOp, status: 'syncing' });
  const again = new OfflineEngine(d.store.reopen(), { tenantId: T.tenantId, userId: ids.cashier, userName: 'cashier off', deviceId: payOp.deviceId }, d.engine['transport']);
  await again.init();
  assert.equal((await again.op(payOp.id))!.lastError?.code, 'INTERRUPTED');
  await again.sync({ force: true });
  assert.equal(await Order.countDocuments({ tenantId: T.tenantId }), before + 1, 'retry did not duplicate the order');
  const server = await Order.findOne({ tenantId: T.tenantId, idempotencyKey: o.opId }).lean();
  assert.equal(await Payment.countDocuments({ tenantId: T.tenantId, orderId: server!._id }), 1, 'exactly one payment');
  assert.equal(server!.paymentStatus, 'paid');
  const local = await again.order(o.localId);
  assert.equal(local!.payments[0].status, 'confirmed');
});

test('offline card payments are refused; only verified cash is recorded', async () => {
  const order = s.serverOrders[1];
  const op = { id: crypto.randomUUID(), type: 'payment.cash', tenantId: T.tenantId, userId: ids.cashier, deviceId: 'dev-x', createdAt: new Date().toISOString(), payload: { orderId: String(order._id), amount: 100, method: 'card_terminal' } };
  const r = await request(app).post('/api/staff/sync').set(auth(tok.cashier)).send(op);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'OFFLINE_CARD_UNSUPPORTED');
  assert.equal(await Payment.countDocuments({ tenantId: T.tenantId, orderId: order._id }), 0);
});

test('price changed while offline: conflict, nothing charged silently; accepting the server price syncs order and payment', async () => {
  const snap = await menuSnapshot(tok.cashier); // tea at 10.00
  await request(app).patch(`/api/staff/menu/products/${s.tea._id}`).set(auth(T.token)).send({ price: 12_00 }); // changed meanwhile
  const d = device('cashier', ids.cashier, 'cashier off');
  await d.engine.init();
  const o = await createOfflineOrder(d.engine, { ...snap, actor: cashierActor, tenantId: T.tenantId }, { type: 'takeaway', items: [{ productId: s.tea._id, quantity: 1 }] });
  assert.equal(o.totals.total, 11_50);
  await d.engine.recordCash({ localOrderId: o.localId }, 11_50);
  await d.engine.sync({ force: true });
  const op = (await d.engine.op(o.opId))!;
  assert.equal(op.status, 'conflict');
  assert.equal(op.lastError?.code, 'PRICE_CHANGED');
  assert.deepEqual([(op.lastError?.details as any).expectedTotal, (op.lastError?.details as any).serverTotal], [11_50, 13_80]);
  const pay = (await d.engine.ops()).find((x) => x.type === 'payment.cash')!;
  assert.equal(pay.status, 'pending');
  assert.match(pay.waitingFor ?? '', /Waiting for its order/);
  assert.equal(await Order.countDocuments({ tenantId: T.tenantId, idempotencyKey: o.opId }), 0);
  assert.equal((await d.engine.order(o.localId))!.syncState, 'attention');

  await d.engine.acceptServerPrice(o.opId, 'manager off');
  await d.engine.sync({ force: true });
  const server = await Order.findOne({ tenantId: T.tenantId, idempotencyKey: o.opId }).lean();
  assert.equal(server!.total, 13_80, 'server price applied');
  assert.equal(server!.amountPaid, 11_50, 'cash taken offline recorded as it was');
  assert.equal(server!.paymentStatus, 'partially_paid', 'remaining balance is visible to staff');
  assert.ok(server!.modifications.some((m: any) => m.action === 'offline_synced' && m.detail.priceAccepted));
  await request(app).patch(`/api/staff/menu/products/${s.tea._id}`).set(auth(T.token)).send({ price: 10_00 });
});

test('disabled product: conflict; discarding requires a reason and turns the queued cash into a conflict', async () => {
  const snap = await menuSnapshot(tok.cashier);
  await request(app).patch(`/api/staff/menu/products/${s.soup._id}`).set(auth(T.token)).send({ isAvailable: false });
  const d = device('cashier', ids.cashier, 'cashier off');
  await d.engine.init();
  const o = await createOfflineOrder(d.engine, { ...snap, actor: cashierActor, tenantId: T.tenantId }, { type: 'takeaway', items: [{ productId: s.soup._id, quantity: 1 }] });
  await d.engine.recordCash({ localOrderId: o.localId }, 17_25);
  await d.engine.sync({ force: true });
  const op = (await d.engine.op(o.opId))!;
  assert.equal(op.status, 'conflict');
  assert.match(op.lastError!.message, /unavailable/);
  await assert.rejects(d.engine.discard(o.opId, 'manager off', ''), /reason/);
  await d.engine.discard(o.opId, 'manager off', 'Soup finished; cash returned to guest');
  const pay = (await d.engine.ops()).find((x) => x.type === 'payment.cash')!;
  assert.equal(pay.status, 'conflict');
  assert.equal(pay.lastError?.code, 'PARENT_DISCARDED');
  assert.equal((await d.engine.op(o.opId))!.resolution?.action, 'discarded', 'decision kept for the audit trail');
  assert.equal(await Order.countDocuments({ tenantId: T.tenantId, idempotencyKey: o.opId }), 0);
  const sum = await d.engine.summary();
  assert.ok(sum.conflict >= 1);
  await request(app).patch(`/api/staff/menu/products/${s.soup._id}`).set(auth(T.token)).send({ isAvailable: true });
});

test('stock: provisional local reservations; overselling across two offline devices is detected; server stock is never overwritten', async () => {
  const snap = await menuSnapshot(tok.cashier); // cake stock 2
  const d1 = device('cashier', ids.cashier, 'cashier off');
  const d2 = device('manager', ids.manager, 'manager off');
  await d1.engine.init();
  await d2.engine.init();
  const ctx1 = { ...snap, actor: cashierActor, tenantId: T.tenantId };
  await createOfflineOrder(d1.engine, ctx1, { type: 'takeaway', items: [{ productId: s.cake._id, quantity: 2 }] });
  await assert.rejects(createOfflineOrder(d1.engine, ctx1, { type: 'takeaway', items: [{ productId: s.cake._id, quantity: 1 }] }), /out of stock \(0 left on this device\)/);
  const o2 = await createOfflineOrder(d2.engine, { ...snap, actor: { name: 'manager off', role: 'manager', canDiscount: true }, tenantId: T.tenantId }, { type: 'takeaway', items: [{ productId: s.cake._id, quantity: 2 }] });
  await d1.engine.sync({ force: true });
  await d2.engine.sync({ force: true });
  const op2 = (await d2.engine.op(o2.opId))!;
  assert.equal(op2.status, 'conflict');
  assert.match(op2.lastError!.message, /out of stock/);
  assert.equal((await Product.findOne({ tenantId: T.tenantId, _id: s.cake._id }).lean())!.stockQty, 0, 'server stock stays authoritative');
});

test('kitchen offline: actions persist, sync without duplicates, and conflict when the order changed elsewhere', async () => {
  const order = (await request(app).post('/api/staff/orders').set(auth(tok.cashier)).send({ type: 'takeaway', confirm: true, items: [{ productId: s.tea._id, quantity: 1 }, { productId: s.soup._id, quantity: 1 }] })).body;
  const k = device('kitchen', ids.kitchen, 'kitchen off');
  await k.engine.init();
  k.state.online = false;
  const a = await k.engine.kitchen({ orderId: order._id }, [{ itemId: order.items[0]._id }, { itemId: order.items[1]._id }], 'preparing');
  await k.engine.kitchen({ orderId: order._id }, [{ itemId: order.items[0]._id }], 'ready');
  assert.equal((await k.engine.summary()).pendingKitchen, 2);
  k.state.online = true;
  k.state.loseNextResponse = true; // first response lost
  await k.engine.sync({ force: true });
  await k.engine.sync({ force: true });
  const srv = await Order.findOne({ tenantId: T.tenantId, _id: order._id }).lean();
  assert.deepEqual(srv!.items.map((i: any) => i.status), ['ready', 'preparing']);
  assert.equal(srv!.status, 'partially_ready');
  assert.equal(srv!.items[0].startedBy, 'kitchen off');
  assert.ok(new Date(srv!.items[0].startedAt!).getTime() <= Date.parse((await k.engine.op(a.id))!.createdAt) + 1000, 'offline timestamp kept');
  assert.equal(await SyncReceipt.countDocuments({ tenantId: T.tenantId, key: a.id }), 1);

  // Manager removes the soup on another device while the kitchen is offline.
  k.state.online = false;
  const late = await k.engine.kitchen({ orderId: order._id }, [{ itemId: order.items[1]._id }], 'ready');
  await request(app).post(`/api/staff/orders/${order._id}/items/${order.items[1]._id}/cancel`).set(auth(tok.manager)).send({ reason: 'Guest changed mind' });
  k.state.online = true;
  await k.engine.sync({ force: true });
  const op = (await k.engine.op(late.id))!;
  assert.equal(op.status, 'conflict');
  assert.equal(op.lastError?.code, 'ORDER_CHANGED');
});

test('kitchen action on an order created offline on the same device waits for the order, then maps to server items', async () => {
  const snap = await menuSnapshot(tok.owner);
  const d = device('owner', ids.owner, 'Owner offl');
  await d.engine.init();
  d.state.online = false;
  const o = await createOfflineOrder(d.engine, { ...snap, actor: { name: 'Owner offl', role: 'owner', canDiscount: true }, tenantId: T.tenantId }, { type: 'takeaway', items: [{ productId: s.tea._id, quantity: 1 }, { productId: s.soup._id, quantity: 1 }] });
  await d.engine.kitchen({ localOrderId: o.localId }, [{ index: 1 }], 'ready');
  assert.equal((await d.engine.order(o.localId))!.items[1].status, 'ready', 'applied locally at once');
  d.state.online = true;
  await d.engine.sync({ force: true });
  const srv = await Order.findOne({ tenantId: T.tenantId, idempotencyKey: o.opId }).lean();
  assert.deepEqual(srv!.items.map((i: any) => i.status), ['queued', 'ready']);
});

test('cash shift: an open shift continues offline; movements and close sync once; a shift closed elsewhere is a conflict', async () => {
  const open = await request(app).post('/api/staff/shifts/open').set(auth(tok.cashier)).send({ openingFloat: 100_00 });
  const shiftId = open.body._id;
  const d = device('cashier', ids.cashier, 'cashier off');
  await d.engine.init();
  d.state.online = false;
  await d.engine.shiftMovement(shiftId, 'out', 20_00, 'Bought milk');
  await d.engine.shiftClose(shiftId, 80_00, 'offline close');
  await assert.rejects(d.engine.shiftClose(shiftId, 80_00), /already waiting/, 'duplicate close prevented locally');
  d.state.online = true;
  d.state.loseNextResponse = true;
  await d.engine.sync({ force: true });
  await d.engine.sync({ force: true });
  const shift = await CashShift.findOne({ tenantId: T.tenantId, _id: shiftId }).lean();
  assert.equal(shift!.movements.length, 1, 'movement recorded once despite the lost response');
  assert.equal(shift!.status, 'closed');
  assert.equal(shift!.expectedCash, 80_00);
  assert.equal(shift!.discrepancy, 0);

  // Second device still thinks the shift is open.
  const d2 = device('cashier', ids.cashier, 'cashier off');
  await d2.engine.init();
  await d2.engine.shiftClose(shiftId, 70_00);
  await d2.engine.sync({ force: true });
  const op = (await d2.engine.ops())[0];
  assert.equal(op.status, 'conflict');
  assert.equal(op.lastError?.code, 'SHIFT_CLOSED');
});

test('tenant isolation: records of another restaurant or another user are refused; ids never collide across tenants', async () => {
  const snap = await menuSnapshot(tok.cashier);
  const d = device('cashier', ids.cashier, 'cashier off');
  await d.engine.init();
  const o = await createOfflineOrder(d.engine, { ...snap, actor: cashierActor, tenantId: T.tenantId }, { type: 'takeaway', items: [{ productId: s.tea._id, quantity: 1 }] });
  const op = (await d.engine.op(o.opId))!;
  const wire = { id: op.id, type: op.type, tenantId: op.tenantId, userId: op.userId, deviceId: op.deviceId, createdAt: op.createdAt, payload: op.payload };
  const other = await request(app).post('/api/staff/sync').set(auth(B.token)).send(wire);
  assert.equal(other.status, 403);
  assert.equal(other.body.error.code, 'TENANT_MISMATCH');
  // Even claiming its own tenant, restaurant B cannot order restaurant A's products.
  const bMe = (await request(app).get('/api/auth/me').set(auth(B.token))).body.user.id;
  const forged = await request(app).post('/api/staff/sync').set(auth(B.token)).send({ ...wire, tenantId: B.tenantId, userId: bMe });
  assert.equal(forged.status, 400);
  assert.equal(await Order.countDocuments({ tenantId: B.tenantId }), 0);
  // Another staff member of the same restaurant cannot send this cashier's records.
  const asManager = await request(app).post('/api/staff/sync').set(auth(tok.manager)).send(wire);
  assert.equal(asManager.body.error.code, 'USER_MISMATCH');
  // Same UUID reused for a different operation type.
  await d.engine.sync({ force: true });
  const reused = await request(app).post('/api/staff/sync').set(auth(tok.cashier)).send({ ...wire, type: 'shift.close', payload: { shiftId: String(o.tenantId), countedCash: 0 } });
  assert.equal(reused.body.error.code, 'KEY_REUSED');
  // The engine itself refuses records from another account found in its storage.
  const store = new MemoryStore();
  await store.put('ops', op.id, { ...op, tenantId: B.tenantId }); // records are always stored under their own id
  const e2 = new OfflineEngine(store, { tenantId: T.tenantId, userId: ids.cashier, userName: 'c', deviceId: 'd' }, async () => ({ ok: true, data: {} }));
  await e2.init();
  assert.equal((await e2.ops()).length, 0);
  assert.equal((await e2.quarantined()).length, 1);
});

test('permission changes are re-checked at sync: revoked → failed (kept), restored → retried and synced', async () => {
  const snap = await menuSnapshot(tok.cashier);
  const d = device('cashier', ids.cashier, 'cashier off');
  await d.engine.init();
  d.state.online = false;
  const o = await createOfflineOrder(d.engine, { ...snap, actor: cashierActor, tenantId: T.tenantId }, { type: 'takeaway', items: [{ productId: s.tea._id, quantity: 1 }] });
  await request(app).patch(`/api/staff/staff/${ids.cashier}`).set(auth(T.token)).send({ permissionOverrides: { grant: [], revoke: ['orders:create'] } });
  d.state.online = true;
  const r1 = await d.engine.sync({ force: true });
  assert.equal(r1.stop, 'auth', 'permission change revoked the old session');
  assert.equal((await d.engine.op(o.opId))!.status, 'pending', 'kept while signed out');
  tok.cashier = (await login('cashier@offl.test')).accessToken;
  await d.engine.sync({ force: true });
  assert.equal((await d.engine.op(o.opId))!.status, 'failed');
  assert.equal((await d.engine.op(o.opId))!.lastError?.httpStatus, 403);
  await request(app).patch(`/api/staff/staff/${ids.cashier}`).set(auth(T.token)).send({ permissionOverrides: { grant: [], revoke: [] } });
  tok.cashier = (await login('cashier@offl.test')).accessToken;
  await d.engine.retry(o.opId, 'cashier off');
  await d.engine.sync({ force: true });
  assert.equal((await d.engine.op(o.opId))!.status, 'synced');
});

test('temporary server errors back off exponentially, then wait for a person', async () => {
  const snap = await menuSnapshot(tok.cashier);
  let clock = Date.now();
  const store = new MemoryStore();
  const { t, state } = makeTransport(() => tok.cashier);
  const e = new OfflineEngine(store, { tenantId: T.tenantId, userId: ids.cashier, userName: 'cashier off', deviceId: 'dev-backoff' }, t, () => clock);
  await e.init();
  const o = await createOfflineOrder(e, { ...snap, actor: cashierActor, tenantId: T.tenantId }, { type: 'takeaway', items: [{ productId: s.tea._id, quantity: 1 }] });
  state.status503 = MAX_AUTO_RETRIES;
  await e.sync();
  let op = (await e.op(o.opId))!;
  assert.equal(op.status, 'pending');
  assert.equal(op.retryCount, 1);
  assert.ok(op.nextAttemptAt! > clock);
  const calls = state.calls;
  await e.sync(); // still backing off: not sent
  assert.equal(state.calls, calls);
  for (let i = 2; i <= MAX_AUTO_RETRIES; i++) {
    clock += 10 * 60_000;
    await e.sync();
  }
  op = (await e.op(o.opId))!;
  assert.equal(op.status, 'failed', 'gives up automatic retries, never discards');
  await e.retry(o.opId, 'manager off');
  await e.sync({ force: true });
  assert.equal((await e.op(o.opId))!.status, 'synced');
});

test('storage full and corrupted records: nothing is reported saved that was not stored; bad records are quarantined', async () => {
  const snap = await menuSnapshot(tok.cashier);
  const quotaErr = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
  const store = new MemoryStore();
  const e = new OfflineEngine(store, { tenantId: T.tenantId, userId: ids.cashier, userName: 'c', deviceId: 'dev-q' }, async () => ({ ok: true, data: {} }));
  await e.init();
  let writes = 0;
  store.failWrites = () => (++writes > 3 ? quotaErr : null); // the queue write fails after the order write
  await assert.rejects(createOfflineOrder(e, { ...snap, actor: cashierActor, tenantId: T.tenantId }, { type: 'takeaway', items: [{ productId: s.tea._id, quantity: 1 }] }), /quota/);
  store.failWrites = null;
  assert.equal((await e.orders()).length, 0, 'no orphan local order');
  assert.equal((await e.ops()).length, 0);
  store.rawPut('ops', 'broken-1', '{"id": "broken-1", "status": "pending"');
  store.rawPut('ops', 'broken-2', JSON.stringify({ id: 'broken-2', status: 'weird' }));
  await e.init();
  assert.equal((await e.quarantined()).length, 2);
  assert.equal((await e.summary()).quarantined, 2);
});

test('stale or future-dated offline records are not applied automatically', async () => {
  const base = { type: 'shift.movement', tenantId: T.tenantId, userId: ids.cashier, deviceId: 'dev-old', payload: { shiftId: T.tenantId, type: 'in', amount: 100, reason: 'old record' } };
  const old = await request(app).post('/api/staff/sync').set(auth(tok.cashier)).send({ ...base, id: crypto.randomUUID(), createdAt: new Date(Date.now() - 20 * 86400_000).toISOString() });
  assert.equal(old.body.error.code, 'STALE_OPERATION');
  const future = await request(app).post('/api/staff/sync').set(auth(tok.cashier)).send({ ...base, id: crypto.randomUUID(), createdAt: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(future.body.error.code, 'CLOCK_AHEAD');
});

test('connection drop mid-request: the offline copy reuses the online key, so no second order or payment', async () => {
  const snap = await menuSnapshot(tok.cashier);
  const key = crypto.randomUUID();
  // The online POS request reached the server, but the device never got the answer.
  const online = await request(app).post('/api/staff/orders').set(auth(tok.cashier)).send({ type: 'takeaway', confirm: true, idempotencyKey: key, items: [{ productId: s.tea._id, quantity: 3 }] });
  assert.equal(online.status, 201);
  const d = device('cashier', ids.cashier, 'cashier off');
  await d.engine.init();
  const o = await createOfflineOrder(d.engine, { ...snap, actor: cashierActor, tenantId: T.tenantId }, { type: 'takeaway', items: [{ productId: s.tea._id, quantity: 3 }] }, key);
  assert.equal(o.opId, key);
  await d.engine.sync({ force: true });
  assert.equal(await Order.countDocuments({ tenantId: T.tenantId, idempotencyKey: key }), 1);
  assert.equal((await d.engine.order(o.localId))!.serverOrderId, String(online.body._id));

  // Same for cash on an order already on the server.
  const payKey = crypto.randomUUID();
  const paid = await request(app).post(`/api/staff/orders/${online.body._id}/payments/cash`).set(auth(tok.cashier)).send({ amount: 10_00, method: 'cash', idempotencyKey: payKey });
  assert.equal(paid.status, 201);
  await d.engine.enqueue('payment.cash', { orderId: String(online.body._id), amount: 10_00, method: 'cash' }, { id: payKey });
  await d.engine.sync({ force: true });
  assert.equal(await Payment.countDocuments({ tenantId: T.tenantId, orderId: online.body._id, kind: 'charge' }), 1);
  assert.equal((await d.engine.op(payKey))!.status, 'synced');
});
