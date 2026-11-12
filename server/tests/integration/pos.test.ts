import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb, PW } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { createApp } from '../../src/app';
import { initSockets } from '../../src/sockets';
import { Order, Payment } from '../../src/models/operations';
import { StockMovement, InventoryItem } from '../../src/models/inventory';

/**
 * Advanced POS + kitchen operations, end to end through the real API (in-memory MongoDB).
 * Tax 15% exclusive (Saudi-style VAT), service 0%, currency SAR, delivery fee 10.00.
 */
let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let T: Awaited<ReturnType<typeof provisionTenant>>;
let O: Awaited<ReturnType<typeof provisionTenant>>; // second restaurant (isolation)
const s: Record<string, any> = {};
const tok: Record<string, string> = {};

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  T = await provisionTenant(app, p.saToken, p.planId, 'posx');
  O = await provisionTenant(app, p.saToken, p.planId, 'other-pos');
  const set = await request(app).patch('/api/staff/tenant/settings').set(auth(T.token)).send({ settings: {
    currency: 'SAR', taxRatePercent: 15, taxInclusive: false, serviceChargePercent: 0, orderTypes: ['dine_in', 'takeaway', 'pickup', 'delivery'],
    deliveryFee: 10_00, maxManualDiscountPercent: 20, kitchenDelayGraceMinutes: 5, taxLabel: 'VAT', taxRegistrationNumber: '300000000000003', requireTableForDineIn: true,
  } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  for (const role of ['manager', 'waiter', 'cashier', 'kitchen']) {
    const r = await request(app).post('/api/staff/staff').set(auth(T.token)).send({ name: `${role} one`, email: `${role}@posx.test`, password: PW, role });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    tok[role] = (await request(app).post('/api/auth/login').send({ email: `${role}@posx.test`, password: PW, tenantSlug: 'posx' })).body.accessToken;
  }
  // Two stations: burger + fries -> Main Kitchen (default), drinks -> Drinks.
  const stations = await request(app).get('/api/staff/menu/stations').set(auth(T.token));
  s.main = stations.body.items.find((x: any) => x.isDefault)._id;
  s.drinks = (await request(app).post('/api/staff/menu/stations').set(auth(T.token)).send({ name: 'Drinks' })).body._id;
  const food = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Food' } });
  const drinks = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Drinks' }, stationId: s.drinks });
  const beef = await request(app).post('/api/staff/inventory/items').set(auth(T.token)).send({ name: 'Beef', unit: 'g', openingQuantity: 10_000 });
  s.beef = beef.body._id;
  s.burger = (await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ categoryId: food.body._id, name: { en: 'Burger' }, price: 30_00, prepMinutes: 12, variants: [{ name: 'Single', priceDelta: 0 }, { name: 'Double', priceDelta: 10_00 }], addons: [{ name: 'Cheese', price: 3_00 }], recipe: [{ inventoryItemId: s.beef, quantity: 150 }] })).body;
  s.fries = (await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ categoryId: food.body._id, name: { en: 'Fries' }, price: 10_00, prepMinutes: 6 })).body;
  s.cola = (await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ categoryId: drinks.body._id, name: { en: 'Cola' }, price: 5_00, prepMinutes: 1 })).body;
  s.off = (await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ categoryId: food.body._id, name: { en: 'Seasonal' }, price: 20_00, isAvailable: false })).body;
  const tables = await request(app).post('/api/staff/tables').set(auth(T.token)).send({ count: 3, prefix: 'T' });
  s.tables = tables.body.items;
  for (const k of ['burger', 'fries', 'cola', 'off']) assert.ok(s[k]._id, `${k} created`);
});
after(async () => stopDb(mongod));

const single = () => s.burger.variants.find((v: any) => v.name === 'Single')._id;
const double = () => s.burger.variants.find((v: any) => v.name === 'Double')._id;
const cheese = () => s.burger.addons[0]._id;
const post = (path: string, who: string, body: unknown) => request(app).post(path).set(auth(tok[who] ?? who)).send(body as any);
/** Burger (double + cheese) 43.00 + fries 10.00 + cola 5.00 = 58.00; VAT 15% = 8.70; total 66.70 */
const fullOrder = (extra: Record<string, unknown> = {}) => ({
  type: 'dine_in', tableId: s.tables[0]._id, confirm: true,
  items: [{ productId: s.burger._id, variantId: double(), addonIds: [cheese()], quantity: 1, notes: 'no onions' }, { productId: s.fries._id, quantity: 1 }, { productId: s.cola._id, quantity: 1 }],
  ...extra,
});

/* ------------------------------------------------------------------ POS orders & pricing */

test('POS: cashier creates a confirmed dine-in order; server prices variants, add-ons and VAT', async () => {
  const quote = await post('/api/staff/orders/quote', 'cashier', fullOrder());
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.subtotal, 58_00);
  assert.equal(quote.body.tax, 8_70);
  assert.equal(quote.body.total, 66_70);
  const r = await post('/api/staff/orders', 'cashier', { ...fullOrder(), subtotal: 1, total: 1, items: fullOrder().items.map((i: any) => ({ ...i, unitPrice: 1 })) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.total, 66_70, 'client prices are ignored');
  assert.equal(r.body.status, 'accepted', 'POS orders are confirmed by the cashier');
  assert.equal(r.body.source, 'staff');
  assert.equal(r.body.createdBy.name, 'cashier one');
  assert.ok(r.body.estimatedReadyAt, 'estimated ready time from prep minutes');
  assert.equal(r.body.items[0].prepMinutes, 12);
  s.order = r.body;
  // Kitchen routing: burger + fries at Main Kitchen, cola at Drinks.
  const drinksQ = await request(app).get(`/api/staff/kitchen/queue?stationId=${s.drinks}`).set(auth(tok.kitchen));
  const ticket = drinksQ.body.items.find((o: any) => o._id === s.order._id);
  assert.deepEqual(ticket.items.map((i: any) => i.name), ['Cola']);
  const mainQ = await request(app).get(`/api/staff/kitchen/queue?stationId=${s.main}`).set(auth(tok.kitchen));
  assert.deepEqual(mainQ.body.items.find((o: any) => o._id === s.order._id).items.map((i: any) => i.name), ['Burger', 'Fries']);
  assert.equal(mainQ.body.delayGraceMinutes, 5);
});

test('POS: takeaway, pickup and delivery keep their type and details; delivery fee is taxed', async () => {
  const take = await post('/api/staff/orders', 'cashier', { type: 'takeaway', items: [{ productId: s.fries._id, quantity: 2 }] });
  assert.equal(take.status, 201);
  assert.equal(take.body.type, 'takeaway');
  assert.equal(take.body.tableId, undefined);
  assert.equal((await post('/api/staff/orders', 'cashier', { type: 'pickup', items: [{ productId: s.fries._id, quantity: 1 }] })).status, 400, 'pickup needs a name or phone');
  const pick = await post('/api/staff/orders', 'cashier', { type: 'pickup', confirm: true, customer: { name: 'Sara' }, items: [{ productId: s.fries._id, quantity: 1 }] });
  assert.equal(pick.status, 201);
  assert.equal(pick.body.type, 'pickup');
  assert.equal((await post('/api/staff/orders', 'cashier', { type: 'delivery', customer: { phone: '0500000000' }, items: [{ productId: s.fries._id, quantity: 1 }] })).status, 400, 'delivery needs an address');
  const del = await post('/api/staff/orders', 'cashier', { type: 'delivery', confirm: true, customer: { name: 'Omar', phone: '0500000000' }, delivery: { address: '12 King Fahd Rd, Riyadh' }, items: [{ productId: s.fries._id, quantity: 1 }] });
  assert.equal(del.status, 201, JSON.stringify(del.body));
  assert.equal(del.body.deliveryFee, 10_00);
  assert.equal(del.body.delivery.address, '12 King Fahd Rd, Riyadh');
  assert.equal(del.body.tax, 3_00); // 15% of (10.00 fries + 10.00 delivery)
  assert.equal(del.body.total, 23_00);
  // The public storefront cannot add a delivery order without an address either.
  assert.equal((await request(app).post('/api/public/orders').set('Host', T.host).send({ type: 'delivery', customer: { phone: '0500000001' }, items: [{ productId: s.fries._id, quantity: 1 }] })).status, 400);
});

test('POS: unavailable products and bad options are refused with clear errors', async () => {
  const off = await post('/api/staff/orders', 'cashier', { type: 'takeaway', items: [{ productId: s.off._id, quantity: 1 }] });
  assert.equal(off.status, 400);
  assert.match(off.body.error.message, /unavailable/);
  const noVariant = await post('/api/staff/orders', 'cashier', { type: 'takeaway', items: [{ productId: s.burger._id, quantity: 1 }] });
  assert.match(noVariant.body.error.message, /choose an option/);
  const otherTenant = await request(app).post('/api/staff/orders').set(auth(O.token)).send({ type: 'takeaway', items: [{ productId: s.fries._id, quantity: 1 }] });
  assert.equal(otherTenant.status, 400, 'another restaurant cannot order this product');
});

test('Discounts: permission, reason, limit and server-side amounts', async () => {
  const base = { type: 'takeaway', items: [{ productId: s.fries._id, quantity: 10, discount: { type: 'percent', value: 10 } }] };
  assert.equal((await post('/api/staff/orders', 'cashier', { ...base, discountReason: 'regular' })).status, 403, 'cashiers cannot discount by default');
  assert.equal((await post('/api/staff/orders', 'manager', base)).status, 400, 'reason required');
  const tooMuch = await post('/api/staff/orders', 'manager', { type: 'takeaway', orderDiscount: { type: 'percent', value: 50 }, discountReason: 'friend', items: [{ productId: s.fries._id, quantity: 1 }] });
  assert.equal(tooMuch.status, 403, 'manager capped at 20%');
  const ok = await post('/api/staff/orders', 'manager', { ...base, confirm: true, orderDiscount: { type: 'fixed', value: 5_00 }, discountReason: 'Birthday' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  // 100.00 − 10.00 (line 10%) − 5.00 (order) = 85.00; VAT 12.75; total 97.75
  assert.equal(ok.body.subtotal, 100_00);
  assert.equal(ok.body.lineDiscountTotal, 10_00);
  assert.equal(ok.body.manualDiscount.amount, 5_00);
  assert.equal(ok.body.manualDiscount.reason, 'Birthday');
  assert.equal(ok.body.discount, 15_00);
  assert.equal(ok.body.total, 97_75);
  const owner = await request(app).post('/api/staff/orders').set(auth(T.token)).send({ type: 'takeaway', orderDiscount: { type: 'percent', value: 100 }, discountReason: 'Staff meal', items: [{ productId: s.fries._id, quantity: 1 }] });
  assert.equal(owner.status, 201, 'owner is not capped');
  assert.equal(owner.body.total, 0);
  // The storefront cannot send manual discounts.
  const pub = await request(app).post('/api/public/orders').set('Host', T.host).send({ type: 'takeaway', items: [{ productId: s.fries._id, quantity: 1, discount: { type: 'percent', value: 100 } }] });
  assert.equal(pub.status, 400);
});

test('Duplicate protection: the same POS order key creates one order', async () => {
  const key = crypto.randomUUID();
  const body = { type: 'takeaway', idempotencyKey: key, items: [{ productId: s.fries._id, quantity: 1 }] };
  const [a, b] = await Promise.all([post('/api/staff/orders', 'cashier', body), post('/api/staff/orders', 'cashier', body)]);
  assert.equal(a.body._id, b.body._id);
});

/* ------------------------------------------------------------------ kitchen */

test('Kitchen: item-level preparation, station bulk actions, partial and full readiness with timestamps', async () => {
  const o = s.order;
  const [burger, fries, cola] = o.items;
  const start = await post(`/api/staff/orders/${o._id}/items/bulk-status`, 'kitchen', { itemIds: [burger._id, fries._id], status: 'preparing' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.status, 'preparing');
  assert.ok(start.body.items[0].startedAt && start.body.items[0].startedBy === 'kitchen one');
  const drink = await post(`/api/staff/orders/${o._id}/items/${cola._id}/status`, 'kitchen', { status: 'ready' });
  assert.equal(drink.body.status, 'partially_ready', 'drinks done, food still cooking');
  const food = await post(`/api/staff/orders/${o._id}/items/bulk-status`, 'kitchen', { itemIds: [burger._id, fries._id], status: 'ready' });
  assert.equal(food.body.status, 'ready', 'ready only when every station is done');
  assert.ok(food.body.readyAt);
  assert.ok(food.body.items.every((i: any) => i.readyAt && i.readyBy));
  assert.equal((await post(`/api/staff/orders/${o._id}/items/bulk-status`, 'waiter', { itemIds: [burger._id], status: 'ready' })).status, 403, 'waiters cannot operate the kitchen');
  assert.equal((await post(`/api/staff/orders/${o._id}/items/${cola._id}/status`, 'kitchen', { status: 'cancelled' })).status, 400, 'item removal goes through the cancel workflow');
});

test('Real time: kitchen gets new and modified tickets; other restaurants get nothing; reconnect resyncs from the database', async () => {
  const server = http.createServer(app);
  const io = initSockets(server);
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const within = <X>(p: Promise<X>, what: string, ms = 5000) => Promise.race([p, new Promise<X>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms))]);
  const kds = ioClient(url, { auth: { token: tok.kitchen }, transports: ['websocket'], reconnection: false });
  const other = ioClient(url, { auth: { token: O.token }, transports: ['websocket'], reconnection: false });
  const otherEvents: string[] = [];
  other.onAny((e) => otherEvents.push(e));
  try {
    await within(Promise.all([new Promise<void>((r) => kds.once('connect', () => r())), new Promise<void>((r) => other.once('connect', () => r()))]), 'connect');
    const gotNew = new Promise<any>((r) => kds.once('kitchen:new', r));
    const created = await post('/api/staff/orders', 'cashier', { type: 'takeaway', confirm: true, items: [{ productId: s.fries._id, quantity: 1 }] });
    const ticket = await within(gotNew, 'kitchen:new');
    assert.equal(ticket._id, created.body._id);
    const gotMod = new Promise<any>((r) => kds.once('kitchen:modified', r));
    await post(`/api/staff/orders/${created.body._id}/items`, 'cashier', { items: [{ productId: s.cola._id, quantity: 2 }] });
    const mod = await within(gotMod, 'kitchen:modified');
    assert.equal(mod.change.action, 'items_added');
    assert.equal(mod.items.length, 2);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(otherEvents.filter((e) => e.startsWith('kitchen') || e.startsWith('order')).length, 0, 'no cross-tenant events');
    // After a reconnect the KDS reloads the queue: the database holds the same ticket exactly once.
    const q = await request(app).get('/api/staff/kitchen/queue').set(auth(tok.kitchen));
    assert.equal(q.body.items.filter((x: any) => x._id === created.body._id).length, 1);
  } finally {
    kds.close();
    other.close();
    await new Promise<void>((r) => io.close(() => r()));
  }
});

/* ------------------------------------------------------------------ modification */

test('Order modification: add, change, cancel items; prepared history is preserved; totals re-priced', async () => {
  const o = (await post('/api/staff/orders', 'waiter', { type: 'dine_in', tableId: s.tables[1]._id, confirm: true, items: [{ productId: s.burger._id, variantId: single(), quantity: 1 }, { productId: s.fries._id, quantity: 1 }] })).body;
  assert.equal(o.total, 46_00); // 40.00 + 15%
  const consumedBefore = await StockMovement.countDocuments({ tenantId: T.tenantId, refId: o._id, type: 'consumption' });
  assert.equal(consumedBefore, 1, 'burger recipe deducted once on confirmation');
  const added = await post(`/api/staff/orders/${o._id}/items`, 'waiter', { items: [{ productId: s.burger._id, variantId: single(), quantity: 1 }] });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.total, 80_50);
  assert.equal(added.body.modifications.at(-1).action, 'items_added');
  assert.equal(added.body.modifications.at(-1).by, 'waiter one');
  const newItem = added.body.items[2];
  assert.ok(newItem.addedAt);
  assert.equal(await StockMovement.countDocuments({ tenantId: T.tenantId, refId: o._id, type: 'consumption' }), 2, 'added burger deducts its recipe');
  const qty = await request(app).patch(`/api/staff/orders/${o._id}/items/${newItem._id}`).set(auth(tok.waiter)).send({ quantity: 2, notes: 'well done' });
  assert.equal(qty.status, 200, JSON.stringify(qty.body));
  assert.equal(qty.body.total, 115_00);
  // Kitchen starts the first burger: waiters can no longer change or remove it.
  await post(`/api/staff/orders/${o._id}/items/${o.items[0]._id}/status`, 'kitchen', { status: 'preparing' });
  assert.equal((await request(app).patch(`/api/staff/orders/${o._id}/items/${o.items[0]._id}`).set(auth(tok.waiter)).send({ quantity: 3 })).status, 400);
  assert.equal((await post(`/api/staff/orders/${o._id}/items/${o.items[0]._id}/cancel`, 'waiter', { reason: 'changed mind' })).status, 403);
  const mgr = await post(`/api/staff/orders/${o._id}/items/${o.items[0]._id}/cancel`, 'manager', { reason: 'Guest changed order' });
  assert.equal(mgr.status, 200, JSON.stringify(mgr.body));
  const cancelled = mgr.body.items[0];
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.startedAt, 'preparation history kept');
  assert.equal(cancelled.cancelledBy, 'manager one');
  assert.equal(mgr.body.total, 80_50); // fries 10 + 2 × burger 30 = 70 + 15%
  // Fries ready -> cannot be removed.
  await post(`/api/staff/orders/${o._id}/items/${o.items[1]._id}/status`, 'kitchen', { status: 'ready' });
  assert.equal((await post(`/api/staff/orders/${o._id}/items/${o.items[1]._id}/cancel`, 'manager', { reason: 'x x x' })).status, 400);
  const order = await Order.findOne({ tenantId: T.tenantId, _id: o._id }).lean();
  assert.ok(order!.modifications.length >= 3);
  s.modified = order;
});

test('Tables: transfer an order and merge tables (authorised staff only)', async () => {
  const o = s.modified;
  assert.equal((await post(`/api/staff/orders/${o._id}/transfer`, 'cashier', { tableId: s.tables[2]._id })).status, 403, 'cashiers cannot move tables');
  const moved = await post(`/api/staff/orders/${o._id}/transfer`, 'waiter', { tableId: s.tables[2]._id });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.tableLabel, s.tables[2].label);
  const tables = (await request(app).get('/api/staff/tables').set(auth(tok.waiter))).body.items;
  assert.equal(tables.find((t: any) => t._id === s.tables[2]._id).status, 'occupied');
  assert.equal(tables.find((t: any) => t._id === s.tables[1]._id).status, 'cleaning', 'old table freed');
  const merge = await post(`/api/staff/tables/${s.tables[2]._id}/merge`, 'waiter', { intoTableId: s.tables[0]._id });
  assert.equal(merge.status, 200, JSON.stringify(merge.body));
  assert.equal(merge.body.moved, 1);
  const reloaded = await Order.findOne({ tenantId: T.tenantId, _id: o._id }).lean();
  assert.equal(reloaded!.tableLabel, s.tables[0].label);
  assert.ok(reloaded!.modifications.some((m: any) => m.action === 'table_transfer'));
});

/* ------------------------------------------------------------------ payments */

test('Split bills: equal shares sum exactly; item split charges the item share; overpayment refused', async () => {
  const o = (await post('/api/staff/orders', 'cashier', { type: 'takeaway', confirm: true, items: [{ productId: s.fries._id, quantity: 1 }, { productId: s.cola._id, quantity: 2 }] })).body;
  assert.equal(o.total, 23_00); // 20.00 + 15%
  const eq = await post(`/api/staff/orders/${o._id}/split-quote`, 'cashier', { mode: 'equal', parts: 3 });
  assert.deepEqual(eq.body.parts.map((p: any) => p.amount), [7_67, 7_67, 7_66]);
  assert.equal(eq.body.parts.reduce((a: number, p: any) => a + p.amount, 0), 23_00);
  // Guest 1 pays their equal share in cash.
  const p1 = await post(`/api/staff/orders/${o._id}/payments/cash`, 'cashier', { method: 'cash', allocation: { mode: 'equal', parts: 3, part: 1 } });
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  assert.equal(p1.body.amount, 7_67);
  // A tampered amount is refused.
  assert.equal((await post(`/api/staff/orders/${o._id}/payments/cash`, 'cashier', { amount: 1, method: 'cash', allocation: { mode: 'equal', parts: 3, part: 2 } })).status, 400);
  // Card terminal for 5.00, recorded as a manually confirmed transaction.
  const p2 = await post(`/api/staff/orders/${o._id}/payments/cash`, 'cashier', { amount: 5_00, method: 'card_terminal' });
  assert.equal(p2.body.provider, 'manual');
  const mid = await Order.findOne({ tenantId: T.tenantId, _id: o._id }).lean();
  assert.equal(mid!.paymentStatus, 'partially_paid');
  assert.equal(mid!.amountPaid, 12_67);
  assert.equal((await post(`/api/staff/orders/${o._id}/payments/cash`, 'cashier', { amount: 20_00, method: 'cash' })).status, 400, 'overpayment refused');
  const rest = await post(`/api/staff/orders/${o._id}/payments/cash`, 'cashier', { amount: 10_33, method: 'cash' });
  assert.equal(rest.status, 201);
  const paid = await Order.findOne({ tenantId: T.tenantId, _id: o._id }).lean();
  assert.equal(paid!.paymentStatus, 'paid');
  assert.equal(paid!.status, 'accepted', 'payment status is separate from order status');

  // Item split on a fresh order: the fries guest pays 11.50 (10.00 + VAT), then the colas.
  const o2 = (await post('/api/staff/orders', 'cashier', { type: 'takeaway', items: [{ productId: s.fries._id, quantity: 1 }, { productId: s.cola._id, quantity: 2 }] })).body;
  const fries = o2.items[0];
  const cola = o2.items[1];
  const q = await post(`/api/staff/orders/${o2._id}/split-quote`, 'cashier', { mode: 'items', items: [{ itemId: fries._id, quantity: 1 }] });
  assert.equal(q.body.amount, 11_50);
  const pf = await post(`/api/staff/orders/${o2._id}/payments/cash`, 'cashier', { method: 'cash', allocation: { mode: 'items', items: [{ itemId: fries._id, quantity: 1 }], label: 'Ali' } });
  assert.equal(pf.body.amount, 11_50);
  assert.equal((await post(`/api/staff/orders/${o2._id}/split-quote`, 'cashier', { mode: 'items', items: [{ itemId: fries._id, quantity: 1 }] })).status, 400, 'fries already paid');
  const qc = await post(`/api/staff/orders/${o2._id}/split-quote`, 'cashier', { mode: 'items', items: [{ itemId: cola._id, quantity: 2 }] });
  assert.equal(qc.body.amount, 11_50, 'the last unpaid items equal the remaining balance');
  s.paidOrder = paid;
  s.cashPayment = p1.body;
});

test('Payments: same payment key is processed once; waiters cannot refund; refunds tracked per method', async () => {
  const o = (await post('/api/staff/orders', 'cashier', { type: 'takeaway', items: [{ productId: s.fries._id, quantity: 1 }] })).body;
  const key = crypto.randomUUID();
  const a = await post(`/api/staff/orders/${o._id}/payments/cash`, 'cashier', { amount: 5_00, method: 'cash', idempotencyKey: key });
  const b = await post(`/api/staff/orders/${o._id}/payments/cash`, 'cashier', { amount: 5_00, method: 'cash', idempotencyKey: key });
  assert.equal(a.status, 201);
  assert.equal(b.body._id, a.body._id);
  assert.equal(await Payment.countDocuments({ tenantId: T.tenantId, orderId: o._id, kind: 'charge' }), 1);
  assert.equal((await post(`/api/staff/orders/payments/${a.body._id}/refund`, 'waiter', { amount: 1_00, reason: 'cold' })).status, 403);
  assert.equal((await post(`/api/staff/orders/payments/${a.body._id}/refund`, 'cashier', { amount: 1_00, reason: 'cold' })).status, 403, 'refunds need payments:refund');
  // Paid orders cannot be cancelled until refunded.
  const cancel = await post(`/api/staff/orders/${o._id}/status`, 'manager', { status: 'cancelled', reason: 'kitchen closed' });
  assert.equal(cancel.status, 400);
  assert.match(cancel.body.error.message, /Refund/);
  assert.equal((await post(`/api/staff/orders/payments/${a.body._id}/refund`, 'manager', { amount: 5_00, reason: 'kitchen closed' })).status, 201);
  assert.equal((await post(`/api/staff/orders/${o._id}/status`, 'manager', { status: 'cancelled', reason: 'kitchen closed' })).status, 200);
  // Other restaurant can neither read nor pay this order.
  assert.equal((await request(app).get(`/api/staff/orders/${o._id}`).set(auth(O.token))).status, 404);
  assert.equal((await request(app).post(`/api/staff/orders/${o._id}/payments/cash`).set(auth(O.token)).send({ amount: 1_00 })).status, 404);
  assert.equal((await request(app).get(`/api/staff/orders/${o._id}/receipt`).set(auth(O.token))).status, 404);
});

/* ------------------------------------------------------------------ shifts */

test('Cash shifts: open, cash in/out, sales and refunds, expected vs counted, close once', async () => {
  const cashier = tok.cashier;
  const none = await request(app).get('/api/staff/shifts/current').set(auth(cashier));
  assert.equal(none.body.shift, null);
  const open = await post('/api/staff/shifts/open', 'cashier', { openingFloat: 200_00 });
  assert.equal(open.status, 201, JSON.stringify(open.body));
  assert.equal((await post('/api/staff/shifts/open', 'cashier', { openingFloat: 1 })).status, 409, 'one open drawer per cashier');
  const id = open.body._id;
  const o = (await post('/api/staff/orders', 'cashier', { type: 'takeaway', items: [{ productId: s.fries._id, quantity: 2 }] })).body; // 23.00
  await post(`/api/staff/orders/${o._id}/payments/cash`, 'cashier', { amount: 23_00, method: 'cash' });
  const o2 = (await post('/api/staff/orders', 'cashier', { type: 'takeaway', items: [{ productId: s.fries._id, quantity: 1 }] })).body; // 11.50 by card
  await post(`/api/staff/orders/${o2._id}/payments/cash`, 'cashier', { amount: 11_50, method: 'card_terminal' });
  assert.equal((await post(`/api/staff/shifts/${id}/movements`, 'cashier', { type: 'out', amount: 50_00, reason: 'Bought ice' })).status, 201);
  assert.equal((await post(`/api/staff/shifts/${id}/movements`, 'cashier', { type: 'in', amount: 20_00, reason: 'Change from bank' })).status, 201);
  const live = await request(app).get('/api/staff/shifts/current').set(auth(cashier));
  assert.equal(live.body.totals.cashSales, 23_00);
  assert.equal(live.body.totals.cardTerminal, 11_50);
  assert.equal(live.body.totals.expectedCash, 193_00); // 200 + 23 − 50 + 20
  // Another cashier cannot close it; the waiter cannot see shifts at all.
  assert.equal((await post(`/api/staff/shifts/${id}/close`, 'waiter', { countedCash: 0 })).status, 403);
  const closed = await post(`/api/staff/shifts/${id}/close`, 'cashier', { countedCash: 190_00, notes: 'short 3' });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.expectedCash, 193_00);
  assert.equal(closed.body.discrepancy, -3_00);
  assert.equal((await post(`/api/staff/shifts/${id}/close`, 'cashier', { countedCash: 190_00 })).status, 400, 'closed exactly once');
  assert.equal((await post(`/api/staff/shifts/${id}/movements`, 'cashier', { type: 'in', amount: 1_00, reason: 'late' })).status, 400);
  const list = await request(app).get('/api/staff/shifts').set(auth(tok.manager));
  assert.ok(list.body.items.some((x: any) => x._id === id), 'managers see every shift');
  // Requiring a shift for cash.
  await request(app).patch('/api/staff/tenant/settings').set(auth(T.token)).send({ settings: { requireOpenShiftForCash: true } });
  const o3 = (await post('/api/staff/orders', 'cashier', { type: 'takeaway', items: [{ productId: s.fries._id, quantity: 1 }] })).body;
  const refused = await post(`/api/staff/orders/${o3._id}/payments/cash`, 'cashier', { amount: 1_00, method: 'cash' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error.message, /shift/);
  await request(app).patch('/api/staff/tenant/settings').set(auth(T.token)).send({ settings: { requireOpenShiftForCash: false } });
  // Audit trail
  const auditLog = await request(app).get('/api/staff/audit?action=shift').set(auth(T.token));
  assert.ok(['shift.open', 'shift.cash_out', 'shift.cash_in', 'shift.close'].every((a) => auditLog.body.items.some((x: any) => x.action === a)));
});

/* ------------------------------------------------------------------ receipts & reports */

test('Receipts: correct items, VAT breakdown, payments and balance; PDF for 58/80 mm and A4', async () => {
  const r = await request(app).get(`/api/staff/orders/${s.paidOrder._id}/receipt`).set(auth(tok.cashier));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.restaurant.taxRegistrationNumber, '300000000000003');
  assert.equal(r.body.tax.label, 'VAT');
  assert.equal(r.body.tax.ratePercent, 15);
  assert.equal(r.body.totals.total, 23_00);
  assert.equal(r.body.totals.tax, 3_00);
  assert.equal(r.body.tax.taxable, 20_00);
  assert.equal(r.body.totals.paid, 23_00);
  assert.equal(r.body.totals.balance, 0);
  assert.equal(r.body.payments.length, 3);
  assert.equal(r.body.payments[0].label, 'Share 1/3');
  assert.equal(r.body.currency, 'SAR');
  assert.ok(r.body.order.cashiers.includes('cashier one'));
  for (const width of ['58', '80', 'a4']) {
    const pdf = await request(app).get(`/api/staff/orders/${s.paidOrder._id}/receipt?format=pdf&width=${width}`).set(auth(tok.cashier)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  }
});

test('Reports: sales by type, method and cashier; discounts; refunds; shifts; kitchen performance from real timestamps', async () => {
  const r = await request(app).get('/api/staff/analytics/operations?period=week').set(auth(tok.manager));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const types = Object.fromEntries(r.body.byType.map((x: any) => [x.type, x.orders]));
  assert.ok(types.dine_in >= 1 && types.takeaway >= 1 && types.pickup >= 1 && types.delivery >= 1);
  const cash = r.body.byMethod.find((m: any) => m.method === 'cash');
  assert.ok(cash.collected > 0 && cash.refunded >= 5_00);
  const cashier = r.body.cashiers.find((c: any) => c.name === 'cashier one');
  assert.ok(cashier.collected > 0 && cashier.orders > 0);
  assert.ok(r.body.discounts.lines >= 10_00 && r.body.discounts.manual >= 5_00);
  assert.ok(r.body.shifts.some((x: any) => x.discrepancy === -3_00));
  assert.ok(r.body.kitchen.ticketsReady >= 1);
  assert.ok(r.body.kitchen.averageTicketSeconds >= 0);
  assert.ok(r.body.kitchen.stations.some((x: any) => x.name === 'Drinks'));
  assert.ok(r.body.kitchen.peakHours.length >= 1);
  assert.equal((await request(app).get('/api/staff/analytics/operations').set(auth(tok.cashier))).status, 403);
});

test('Inventory: retries, repeated status calls and payment callbacks never deduct a recipe twice', async () => {
  const o = (await post('/api/staff/orders', 'cashier', { type: 'takeaway', items: [{ productId: s.burger._id, variantId: single(), quantity: 1 }] })).body;
  const before = (await InventoryItem.findOne({ tenantId: T.tenantId, _id: s.beef }).lean())!.quantity;
  const results = await Promise.all([1, 2, 3].map(() => post(`/api/staff/orders/${o._id}/status`, 'manager', { status: 'accepted' })));
  assert.equal(results.filter((x) => x.status === 200).length, 1);
  await post(`/api/staff/orders/${o._id}/payments/cash`, 'cashier', { amount: o.total, method: 'cash' });
  const after = (await InventoryItem.findOne({ tenantId: T.tenantId, _id: s.beef }).lean())!.quantity;
  assert.equal(before - after, 150);
  assert.equal(await StockMovement.countDocuments({ tenantId: T.tenantId, refId: o._id, type: 'consumption' }), 1);
});

test('Waiter: requests the bill (cashiers notified) and marks the order served', async () => {
  const o = (await post('/api/staff/orders', 'waiter', { type: 'dine_in', tableId: s.tables[1]._id, confirm: true, items: [{ productId: s.cola._id, quantity: 1 }] })).body;
  const bill = await post(`/api/staff/orders/${o._id}/request-bill`, 'waiter', {});
  assert.equal(bill.status, 200);
  assert.ok(bill.body.billRequestedAt);
  const notes = await request(app).get('/api/staff/notifications').set(auth(tok.cashier));
  assert.ok(notes.body.items.some((n: any) => n.type === 'order.bill'));
  await post(`/api/staff/orders/${o._id}/items/${o.items[0]._id}/status`, 'kitchen', { status: 'ready' });
  const served = await post(`/api/staff/orders/${o._id}/status`, 'waiter', { status: 'delivered' });
  assert.equal(served.status, 200);
  assert.equal((await post(`/api/staff/orders/${o._id}/status`, 'waiter', { status: 'pending' })).status, 400, 'no going back to pending');
});
