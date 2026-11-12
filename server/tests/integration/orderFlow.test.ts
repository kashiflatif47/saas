import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb, PW } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { InventoryItem, StockMovement } from '../../src/models/inventory';
import { Tenant } from '../../src/models/platform';
import { encryptSecret } from '../../src/lib/crypto';
import { Payment } from '../../src/models/operations';
import { runSubscriptionSweep } from '../../src/jobs/subscriptions';
import { invalidateTenantCache } from '../../src/services/tenantResolver';

let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let T: Awaited<ReturnType<typeof provisionTenant>>;
let saToken: string;
const s: Record<string, any> = {};

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  saToken = p.saToken;
  T = await provisionTenant(app, p.saToken, p.planId, 'flow');
  // 10% tax exclusive, 5% service
  const set = await request(app).patch('/api/staff/tenant/settings').set(auth(T.token)).send({ settings: { taxRatePercent: 10, taxInclusive: false, serviceChargePercent: 5, currency: 'PKR' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
});
after(async () => stopDb(mongod));

test('onboarding: owner creates staff for every role and they can log in', async () => {
  for (const role of ['admin', 'manager', 'waiter', 'cashier', 'kitchen', 'inventory_manager']) {
    const r = await request(app).post('/api/staff/staff').set(auth(T.token)).send({ name: role, email: `${role}@flow.test`, password: PW, role });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const login = await request(app).post('/api/auth/login').send({ email: `${role}@flow.test`, password: PW, tenantSlug: 'flow' });
    assert.equal(login.status, 200);
    s[role] = login.body.accessToken;
  }
});

test('RBAC: kitchen cannot edit menu, waiter cannot refund, cashier cannot manage staff', async () => {
  assert.equal((await request(app).post('/api/staff/menu/categories').set(auth(s.kitchen)).send({ name: { en: 'x' } })).status, 403);
  assert.equal((await request(app).get('/api/staff/staff').set(auth(s.cashier))).status, 403);
  assert.equal((await request(app).get('/api/staff/analytics/summary').set(auth(s.waiter))).status, 403);
  assert.equal((await request(app).patch('/api/staff/tenant/payments').set(auth(s.admin)).send({ cashEnabled: true })).status, 403);
});

test('menu CRUD with variants, add-ons, inventory recipe and QR table', async () => {
  const inv = await request(app).post('/api/staff/inventory/items').set(auth(s.inventory_manager)).send({ name: 'Chicken', unit: 'kg', lowStockThreshold: 1, openingQuantity: 2 });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  s.chicken = inv.body._id;
  const station = await request(app).post('/api/staff/menu/stations').set(auth(T.token)).send({ name: 'Grill' });
  assert.equal(station.status, 201);
  const cat = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Grill', ur: 'گرل', ar: 'مشويات' }, stationId: station.body._id });
  assert.equal(cat.status, 201);
  const prod = await request(app).post('/api/staff/menu/products').set(auth(s.manager)).send({
    categoryId: cat.body._id, name: { en: 'Tikka' }, price: 1000_00,
    variants: [{ name: 'Leg', priceDelta: 0 }, { name: 'Breast', priceDelta: 200_00 }],
    addons: [{ name: 'Naan', price: 50_00 }],
    recipe: [{ inventoryItemId: s.chicken, quantity: 0.5 }],
  });
  assert.equal(prod.status, 201, JSON.stringify(prod.body));
  s.product = prod.body;
  s.stationId = station.body._id;
  const tbl = await request(app).post('/api/staff/tables').set(auth(T.token)).send({ label: 'T1' });
  s.table = tbl.body.items[0];
  const qr = await request(app).get(`/api/staff/tables/${s.table._id}/qr`).set(auth(T.token));
  assert.equal(qr.status, 200);
  assert.equal(qr.headers['content-type'], 'image/png');
  const pdf = await request(app).get('/api/staff/tables/qr/print').set(auth(T.token));
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
});

test('customer orders via QR; server computes prices and ignores client totals', async () => {
  const breast = s.product.variants.find((v: any) => v.name === 'Breast')._id;
  const naan = s.product.addons[0]._id;
  const res = await request(app).post('/api/public/orders').set('Host', T.host).send({
    type: 'dine_in', tableToken: s.table.qrToken, customer: { name: 'Ali', phone: '+923001234567' },
    items: [{ productId: s.product._id, variantId: breast, addonIds: [naan], quantity: 2, unitPrice: 1, total: 1 }],
    total: 1,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const o = res.body.order;
  // unit 1250.00 × 2 = 2500.00 ; service 5% = 125.00 ; tax 10% of 2625 = 262.50 ; total 2887.50
  assert.equal(o.subtotal, 2500_00);
  assert.equal(o.serviceCharge, 125_00);
  assert.equal(o.tax, 262_50);
  assert.equal(o.total, 2887_50);
  assert.equal(o.status, 'pending');
  assert.equal(o.paymentStatus, 'unpaid');
  assert.equal(o.tableLabel, 'T1');
  assert.equal(String(o.items[0].stationId), s.stationId, 'routed to category station');
  s.order = o;
  s.tracking = res.body.trackingToken;
});

test('regenerated QR invalidates the old token', async () => {
  const regen = await request(app).post(`/api/staff/tables/${s.table._id}/regenerate`).set(auth(T.token));
  assert.equal(regen.status, 200);
  assert.equal((await request(app).get(`/api/public/tables/${s.table.qrToken}`).set('Host', T.host)).status, 404);
  assert.equal((await request(app).get(`/api/public/tables/${regen.body.qrToken}`).set('Host', T.host)).status, 200);
});

test('accept → kitchen marks items → parent becomes ready; inventory consumed', async () => {
  const acc = await request(app).post(`/api/staff/orders/${s.order._id}/status`).set(auth(s.waiter)).send({ status: 'accepted' });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  const chicken = await InventoryItem.findOne({ tenantId: T.tenantId, _id: s.chicken }).lean();
  assert.equal(chicken!.quantity, 1, '2 kg - 2 × 0.5 kg');
  assert.equal(await StockMovement.countDocuments({ tenantId: T.tenantId, type: 'consumption' }), 1);

  const q = await request(app).get(`/api/staff/kitchen/queue?stationId=${s.stationId}`).set(auth(s.kitchen));
  assert.equal(q.status, 200);
  assert.equal(q.body.items.length, 1);
  const itemId = q.body.items[0].items[0]._id;

  const prep = await request(app).post(`/api/staff/orders/${s.order._id}/items/${itemId}/status`).set(auth(s.kitchen)).send({ status: 'preparing' });
  assert.equal(prep.body.status, 'preparing');
  const ready = await request(app).post(`/api/staff/orders/${s.order._id}/items/${itemId}/status`).set(auth(s.kitchen)).send({ status: 'ready' });
  assert.equal(ready.body.status, 'ready');

  const waiterReady = await request(app).post(`/api/staff/orders/${s.order._id}/items/${itemId}/status`).set(auth(s.waiter)).send({ status: 'preparing' });
  assert.equal(waiterReady.status, 403, 'waiter cannot move kitchen states');

  const track = await request(app).get(`/api/public/orders/${s.order._id}?token=${s.tracking}`).set('Host', T.host);
  assert.equal(track.body.status, 'ready');
});

test('invalid transitions are refused', async () => {
  const r = await request(app).post(`/api/staff/orders/${s.order._id}/status`).set(auth(T.token)).send({ status: 'pending' });
  assert.equal(r.status, 400);
});

test('partial cash payments, overpayment guard, delivery and completion', async () => {
  const p1 = await request(app).post(`/api/staff/orders/${s.order._id}/payments/cash`).set(auth(s.cashier)).send({ amount: 1000_00 });
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  let o = (await request(app).get(`/api/staff/orders/${s.order._id}`).set(auth(T.token))).body.order;
  assert.equal(o.paymentStatus, 'partially_paid');
  assert.equal(o.status, 'ready', 'order status independent of payment');
  const over = await request(app).post(`/api/staff/orders/${s.order._id}/payments/cash`).set(auth(s.cashier)).send({ amount: 999999_00 });
  assert.equal(over.status, 400);
  const p2 = await request(app).post(`/api/staff/orders/${s.order._id}/payments/cash`).set(auth(s.cashier)).send({ amount: 1887_50 });
  assert.equal(p2.status, 201);
  s.charge = p2.body._id;
  await request(app).post(`/api/staff/orders/${s.order._id}/status`).set(auth(s.waiter)).send({ status: 'delivered' }).expect(200);
  await request(app).post(`/api/staff/orders/${s.order._id}/status`).set(auth(s.waiter)).send({ status: 'completed' }).expect(200);
  o = (await request(app).get(`/api/staff/orders/${s.order._id}`).set(auth(T.token))).body.order;
  assert.equal(o.paymentStatus, 'paid');
  assert.equal(o.amountPaid, 2887_50);
  assert.equal(o.status, 'completed');
});

test('customer feedback after completion', async () => {
  const before = await request(app).get(`/api/public/orders/${s.order._id}?token=${s.tracking}`).set('Host', T.host);
  assert.equal(before.body.feedbackGiven, false);
  const fb = await request(app).post(`/api/public/orders/${s.order._id}/feedback`).set('Host', T.host).send({ token: s.tracking, rating: 5, comment: 'Great' });
  assert.equal(fb.status, 201);
  const after = await request(app).get(`/api/public/orders/${s.order._id}?token=${s.tracking}`).set('Host', T.host);
  assert.equal(after.body.feedbackGiven, true, 'tracking page must know feedback was given');
});

test('refunds: waiter forbidden, manager allowed, cannot exceed charge', async () => {
  assert.equal((await request(app).post(`/api/staff/orders/payments/${s.charge}/refund`).set(auth(s.waiter)).send({ amount: 100_00, reason: 'cold' })).status, 403);
  const r = await request(app).post(`/api/staff/orders/payments/${s.charge}/refund`).set(auth(s.manager)).send({ amount: 100_00, reason: 'Item was cold' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const too = await request(app).post(`/api/staff/orders/payments/${s.charge}/refund`).set(auth(s.manager)).send({ amount: 1887_50, reason: 'again' });
  assert.equal(too.status, 400);
  const o = (await request(app).get(`/api/staff/orders/${s.order._id}`).set(auth(T.token))).body.order;
  assert.equal(o.paymentStatus, 'partially_refunded');
});

test('financial analytics match the transactions exactly', async () => {
  const r = await request(app).get('/api/staff/analytics/summary?period=today').set(auth(T.token));
  assert.equal(r.status, 200);
  const sm = r.body.summary;
  assert.equal(sm.orders, 1);
  assert.equal(sm.grossSales, 2500_00);
  assert.equal(sm.taxes, 262_50);
  assert.equal(sm.serviceCharges, 125_00);
  assert.equal(sm.netSales, 2887_50);
  assert.equal(sm.verifiedCollections, 2887_50);
  assert.equal(sm.refunds, 100_00);
  assert.equal(sm.netCollections, 2787_50);
  assert.equal(sm.pendingPayments, 0);
  const csv = await request(app).get('/api/staff/analytics/export?kind=orders&format=csv&period=today').set(auth(T.token));
  assert.equal(csv.status, 200);
  assert.match(csv.text, /2887\.50/);
  const pdf = await request(app).get('/api/staff/analytics/export?kind=summary&format=pdf&period=today').set(auth(T.token));
  assert.equal(pdf.headers['content-type'], 'application/pdf');
});

test('cancel restores stock; coupon usage is enforced', async () => {
  const c = await request(app).post('/api/staff/coupons').set(auth(T.token)).send({ code: 'once', type: 'fixed', value: 100_00, usageLimit: 1 });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const leg = s.product.variants.find((v: any) => v.name === 'Leg')._id;
  const o1 = await request(app).post('/api/public/orders').set('Host', T.host).send({ type: 'takeaway', couponCode: 'ONCE', items: [{ productId: s.product._id, variantId: leg, quantity: 1 }] });
  assert.equal(o1.status, 201, JSON.stringify(o1.body));
  assert.equal(o1.body.order.discount, 100_00);
  const o2 = await request(app).post('/api/public/orders').set('Host', T.host).send({ type: 'takeaway', couponCode: 'ONCE', items: [{ productId: s.product._id, variantId: leg, quantity: 1 }] });
  assert.equal(o2.status, 400, 'coupon used up');
  await request(app).post(`/api/staff/orders/${o1.body.order._id}/status`).set(auth(T.token)).send({ status: 'accepted' }).expect(200);
  const before = (await InventoryItem.findOne({ tenantId: T.tenantId, _id: s.chicken }).lean())!.quantity;
  await request(app).post(`/api/staff/orders/${o1.body.order._id}/status`).set(auth(T.token)).send({ status: 'cancelled', reason: 'Customer left' }).expect(200);
  const after = (await InventoryItem.findOne({ tenantId: T.tenantId, _id: s.chicken }).lean())!.quantity;
  assert.equal(after, before + 0.5);
  const o3 = await request(app).post('/api/public/orders').set('Host', T.host).send({ type: 'takeaway', couponCode: 'ONCE', items: [{ productId: s.product._id, variantId: leg, quantity: 1 }] });
  assert.equal(o3.status, 201, 'coupon usage released on cancel');
});

test('inventory: wastage, purchase order receipt, low stock alert', async () => {
  const sup = await request(app).post('/api/staff/inventory/suppliers').set(auth(s.inventory_manager)).send({ name: 'Poultry Co' });
  assert.equal(sup.status, 201);
  const w = await request(app).post(`/api/staff/inventory/items/${s.chicken}/adjust`).set(auth(s.inventory_manager)).send({ type: 'wastage', quantity: 0.5, reason: 'Spoiled' });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const tooMuch = await request(app).post(`/api/staff/inventory/items/${s.chicken}/adjust`).set(auth(s.inventory_manager)).send({ type: 'wastage', quantity: 9999, reason: 'x' });
  assert.equal(tooMuch.status, 400);
  const po = await request(app).post('/api/staff/inventory/purchase-orders').set(auth(s.inventory_manager)).send({ supplierId: sup.body._id, lines: [{ inventoryItemId: s.chicken, quantity: 10, unitCost: 900_00 }] });
  assert.equal(po.status, 201);
  const rec = await request(app).post(`/api/staff/inventory/purchase-orders/${po.body._id}/receive`).set(auth(s.inventory_manager));
  assert.equal(rec.status, 200);
  assert.equal((await request(app).post(`/api/staff/inventory/purchase-orders/${po.body._id}/receive`).set(auth(s.inventory_manager))).status, 400, 'no double receipt');
  const notes = await request(app).get('/api/staff/notifications').set(auth(s.inventory_manager));
  assert.ok(notes.body.items.some((n: any) => n.type === 'stock.low'));
});

test('reservations with double-booking guard', async () => {
  const at = new Date(Date.now() + 86400_000).toISOString();
  const r1 = await request(app).post('/api/staff/reservations').set(auth(s.waiter)).send({ name: 'Guest A', phone: '03001112222', partySize: 2, reservedFor: at, tableId: s.table._id, status: 'confirmed' });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const r2 = await request(app).post('/api/staff/reservations').set(auth(s.waiter)).send({ name: 'Guest B', phone: '03001113333', partySize: 2, reservedFor: at, tableId: s.table._id, status: 'confirmed' });
  assert.equal(r2.status, 400);
  const pub = await request(app).post('/api/public/reservations').set('Host', T.host).send({ name: 'Web', phone: '03009998888', partySize: 4, reservedFor: at });
  assert.equal(pub.status, 201);
});

test('online payments: refuses to start without configured provider; webhook requires valid signature', async () => {
  const placed = await request(app).post('/api/public/orders').set('Host', T.host).send({ type: 'takeaway', items: [{ productId: s.product._id, variantId: s.product.variants[0]._id, quantity: 1 }] });
  const pay = await request(app).post(`/api/public/orders/${placed.body.order._id}/pay`).set('Host', T.host).send({ token: placed.body.trackingToken });
  assert.equal(pay.status, 400, 'no fake success when provider not configured');

  // Simulate a configured tenant + a pending intent, then deliver a correctly signed webhook.
  const whsec = 'whsec_testsecret123';
  await Tenant.updateOne({ _id: T.tenantId }, { $set: { 'payments.provider': 'stripe', 'payments.providerSecretEnc': encryptSecret('sk_test_dummy', process.env.ENCRYPTION_KEY!), 'payments.webhookSecretEnc': encryptSecret(whsec, process.env.ENCRYPTION_KEY!) } });
  const p = await Payment.create({ tenantId: T.tenantId, orderId: placed.body.order._id, kind: 'charge', method: 'online', provider: 'stripe', amount: placed.body.order.total, currency: 'PKR', status: 'pending', providerRef: 'pi_123' });
  const event = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_123', amount_received: placed.body.order.total, currency: 'pkr', metadata: { tenantId: T.tenantId } } } });
  const bad = await request(app).post(`/api/webhooks/stripe/${T.tenantId}`).set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=deadbeef').send(event);
  assert.equal(bad.status, 400);
  assert.equal((await Payment.findOne({ tenantId: T.tenantId, _id: p._id }).lean())!.status, 'pending');
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', whsec).update(`${t}.${event}`).digest('hex');
  const good = await request(app).post(`/api/webhooks/stripe/${T.tenantId}`).set('Content-Type', 'application/json').set('stripe-signature', `t=${t},v1=${sig}`).send(event);
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal((await Payment.findOne({ tenantId: T.tenantId, _id: p._id }).lean())!.status, 'verified');
  const tr = await request(app).get(`/api/public/orders/${placed.body.order._id}?token=${placed.body.trackingToken}`).set('Host', T.host);
  assert.equal(tr.body.paymentStatus, 'paid');
});

test('subscription expiry blocks writes but keeps reads; suspension blocks storefront and login', async () => {
  await Tenant.updateOne({ _id: T.tenantId }, { $set: { 'subscription.status': 'trial', 'subscription.trialEndsAt': new Date(Date.now() - 1000) } });
  const sweep = await runSubscriptionSweep();
  assert.ok(sweep.trials >= 1);
  invalidateTenantCache();
  assert.equal((await request(app).get('/api/staff/menu/products').set(auth(T.token))).status, 200);
  assert.equal((await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'x' } })).status, 402);
  assert.equal((await request(app).get('/api/public/menu').set('Host', T.host)).status, 503);

  const renew = await request(app).post(`/api/platform/tenants/${T.tenantId}/subscription`).set(auth(saToken)).send({ action: 'renew', months: 1 });
  assert.equal(renew.status, 200);
  assert.equal((await request(app).get('/api/public/menu').set('Host', T.host)).status, 200);

  await request(app).post(`/api/platform/tenants/${T.tenantId}/status`).set(auth(saToken)).send({ status: 'suspended' }).expect(200);
  assert.equal((await request(app).get('/api/staff/menu/products').set(auth(T.token))).status, 401, 'sessions revoked on suspension');
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'owner@flow.test', password: PW, tenantSlug: 'flow' })).status, 401);
  await request(app).post(`/api/platform/tenants/${T.tenantId}/status`).set(auth(saToken)).send({ status: 'active' }).expect(200);
});

test('platform overview aggregates across tenants for super admin only', async () => {
  const r = await request(app).get('/api/platform/overview').set(auth(saToken));
  assert.equal(r.status, 200);
  assert.ok(r.body.totalTenants >= 1);
  assert.ok(r.body.orders30 >= 1);
});
