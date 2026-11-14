/**
 * Option pricing end to end through the real API: admin product configuration → public menu → storefront /
 * QR order → POS quote → staff order → items added to an open order → order details, kitchen, receipt,
 * payment, inventory and historical price preservation. The Halwa Puri scenario from the bug report.
 */
import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app';
import { InventoryItem, StockMovement } from '../../src/models/inventory';
import { Order } from '../../src/models/operations';

let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let T: Awaited<ReturnType<typeof provisionTenant>>;
const R = (rupees: number) => rupees * 100;
const ids: Record<string, any> = {};

const pub = (path: string) => `/api/public/tenants/${T.slug}${path}`;
// Each simulated guest has its own address, so the per-IP public order rate limit (15/min) is not what is tested.
let guest = 0;
const order = (items: any[], extra: any = {}) => request(app).post(pub('/orders')).set('X-Forwarded-For', `10.0.${Math.floor(++guest / 250)}.${guest % 250}`).send({ type: 'takeaway', customer: { name: 'Ayesha' }, items, ...extra });

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  T = await provisionTenant(app, p.saToken, p.planId, 'nashta');
  const cat = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Breakfast' } });
  ids.cat = cat.body._id;
  const puri = await request(app).post('/api/staff/inventory/items').set(auth(T.token)).send({ name: 'Puri', unit: 'pcs', lowStockThreshold: 0, openingQuantity: 100 });
  const halwa = await request(app).post('/api/staff/inventory/items').set(auth(T.token)).send({ name: 'Halwa', unit: 'kg', lowStockThreshold: 0, openingQuantity: 10 });
  ids.invPuri = puri.body._id;
  ids.invHalwa = halwa.body._id;
});

after(async () => stopDb(mongod));

const halwaPuriBody = () => ({
  categoryId: ids.cat,
  name: { en: 'Halwa Puri' },
  price: R(1000),
  promoPrice: R(850),
  variantPricing: 'replace',
  variantGroupName: 'Persons',
  variants: [
    { name: 'Single Person', price: R(500), recipeMultiplier: 1 },
    { name: 'Two Persons', price: R(1000), recipeMultiplier: 2 },
    { name: 'Three Persons', price: R(2000), recipeMultiplier: 3 },
  ],
  addons: [
    { name: 'Extra Cheese', price: R(100), maxQty: 2 },
    { name: 'Extra Puri', price: R(60), maxQty: 4, ingredient: { inventoryItemId: ids.invPuri, quantity: 1 } },
  ],
  recipe: [{ inventoryItemId: ids.invPuri, quantity: 2 }, { inventoryItemId: ids.invHalwa, quantity: 0.1 }],
});

test('admin creates Halwa Puri with replacement option prices; invalid configurations are refused', async () => {
  const bad = await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ ...halwaPuriBody(), variants: [{ name: 'Three Persons', price: R(2000), salePrice: R(2500) }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /sale price must be lower/);
  const missing = await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ ...halwaPuriBody(), variants: [{ name: 'Three Persons' }] });
  assert.equal(missing.status, 400, 'a replace option without its own price is ambiguous');
  assert.match(missing.body.error.message, /needs its full price/);

  const r = await request(app).post('/api/staff/menu/products').set(auth(T.token)).send(halwaPuriBody());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.variantPricing, 'replace');
  ids.hp = r.body._id;
  const v = Object.fromEntries(r.body.variants.map((x: any) => [x.name, x._id]));
  ids.single = v['Single Person'];
  ids.two = v['Two Persons'];
  ids.three = v['Three Persons'];
  ids.cheese = r.body.addons.find((a: any) => a.name === 'Extra Cheese')._id;
  ids.extraPuri = r.body.addons.find((a: any) => a.name === 'Extra Puri')._id;
});

test('public menu shows the real starting price and hides internal inventory links', async () => {
  const menu = await request(app).get(pub('/menu'));
  const hp = menu.body.products.find((p: any) => p._id === ids.hp);
  assert.deepEqual(hp.displayPrice, { amount: R(500), original: R(500), from: true });
  assert.equal(hp.recipe, undefined);
  assert.ok(hp.addons.every((a: any) => a.ingredient === undefined));
  assert.ok(hp.variants.every((v: any) => v.recipeMultiplier === undefined));
});

test('storefront orders: each person option is its own price; extras add; quantity multiplies', async () => {
  const cases: [any, number][] = [
    [{ variantId: ids.single }, R(500)],
    [{ variantId: ids.two }, R(1000)],
    [{ variantId: ids.three }, R(2000)],
    [{ variantId: ids.three, addons: [{ id: ids.cheese, quantity: 1 }] }, R(2100)],
    [{ variantId: ids.three, addons: [{ id: ids.cheese, quantity: 2 }] }, R(2200)],
    [{ variantId: ids.three, addonIds: [ids.cheese] }, R(2100)], // legacy client form
  ];
  for (const [sel, expected] of cases) {
    const r = await order([{ productId: ids.hp, quantity: 1, ...sel }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.order.total, expected, JSON.stringify(sel));
    assert.equal(r.body.order.items[0].unitPrice, expected);
  }
  const two = await order([{ productId: ids.hp, variantId: ids.three, quantity: 2 }]);
  assert.equal(two.body.order.total, R(4000), 'two Three-Person orders');
  ids.trackOrder = two.body.order._id;
  ids.trackToken = two.body.trackingToken;
});

test('missing, invalid or inactive options and over-limit extras are rejected with a clear message', async () => {
  const missing = await order([{ productId: ids.hp, quantity: 1 }]);
  assert.equal(missing.status, 400);
  assert.match(missing.body.error.message, /Please choose an option for Halwa Puri/);
  const invalid = await order([{ productId: ids.hp, variantId: ids.cat, quantity: 1 }]);
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error.message, /Invalid option/);
  const tooMany = await order([{ productId: ids.hp, variantId: ids.three, addons: [{ id: ids.cheese, quantity: 3 }] , quantity: 1 }]);
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error.message, /at most 2 × Extra Cheese/);

  // Retire "Single Person": it disappears from the menu and can no longer be ordered.
  const prod = (await request(app).get(`/api/staff/menu/products/${ids.hp}`).set(auth(T.token))).body;
  const patch = await request(app).patch(`/api/staff/menu/products/${ids.hp}`).set(auth(T.token)).send({ variants: prod.variants.map((v: any) => (v._id === ids.single ? { ...v, isActive: false } : v)) });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  const inactive = await order([{ productId: ids.hp, variantId: ids.single, quantity: 1 }]);
  assert.equal(inactive.status, 400);
  assert.match(inactive.body.error.message, /no longer available/);
  const menu = await request(app).get(pub('/menu'));
  assert.ok(!menu.body.products.find((p: any) => p._id === ids.hp).variants.some((v: any) => v._id === ids.single));
  await request(app).patch(`/api/staff/menu/products/${ids.hp}`).set(auth(T.token)).send({ variants: prod.variants }).expect(200);
});

test('prices sent by a client are ignored: the server prices from the database', async () => {
  const r = await order([{ productId: ids.hp, variantId: ids.three, quantity: 1, unitPrice: 1, price: 1, lineTotal: 1 }], { total: 1, subtotal: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.body.order.total, R(2000));
  assert.ok(r.body.order.items.every((i: any) => i.consumption === undefined), 'guests never see internal ingredient usage');
});

test('a repeated checkout (same key, e.g. double tap or retry) returns the first order instead of a second one', async () => {
  const items = [{ productId: ids.hp, variantId: ids.three, addons: [{ id: ids.cheese, quantity: 1 }], quantity: 1 }];
  const key = 'checkout-halwa-puri-0001';
  const first = await order(items, { idempotencyKey: key });
  const again = await order(items, { idempotencyKey: key });
  assert.equal(first.status, 201);
  assert.equal(again.body.order._id, first.body.order._id);
  assert.equal(await Order.countDocuments({ tenantId: T.tenantId, idempotencyKey: key }), 1);
  assert.equal(again.body.order.total, R(2100));
});

test('POS quote, staff order, order details, kitchen ticket and receipt all agree on 2,100', async () => {
  const items = [{ productId: ids.hp, variantId: ids.three, addons: [{ id: ids.cheese, quantity: 1 }], quantity: 1 }];
  const quote = await request(app).post('/api/staff/orders/quote').set(auth(T.token)).send({ type: 'takeaway', items });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.total, R(2100));
  assert.equal(quote.body.lines[0].unitPrice, R(2100));

  const placed = await request(app).post('/api/staff/orders').set(auth(T.token)).send({ type: 'takeaway', items, confirm: true });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const id = placed.body._id ?? placed.body.order?._id;
  ids.staffOrder = id;
  const detail = (await request(app).get(`/api/staff/orders/${id}`).set(auth(T.token))).body.order;
  const it = detail.items[0];
  assert.equal(detail.total, R(2100));
  assert.equal(it.unitPrice, R(2100));
  assert.equal(it.variantName, 'Three Persons');
  assert.equal(it.variantId, ids.three);
  assert.equal(it.pricingMode, 'replace');
  assert.equal(it.basePrice, R(2000));
  assert.deepEqual(it.addons.map((a: any) => [a.name, a.price, a.quantity]), [['Extra Cheese', R(100), 1]]);

  const kds = await request(app).get('/api/staff/kitchen/queue').set(auth(T.token));
  const ticket = kds.body.items?.find?.((o: any) => o._id === id) ?? (Array.isArray(kds.body) ? kds.body.find((o: any) => o._id === id) : undefined);
  assert.ok(ticket, 'order is on the kitchen display');
  assert.equal(ticket.items[0].variantName, 'Three Persons');
  assert.equal(ticket.items[0].addons[0].name, 'Extra Cheese');

  const receipt = await request(app).get(`/api/staff/orders/${id}/receipt`).set(auth(T.token));
  assert.equal(receipt.body.totals.total, R(2100));
  assert.equal(receipt.body.items[0].unitPrice, R(2100));
  assert.deepEqual(receipt.body.items[0].addons, ['Extra Cheese']);

  const pay = await request(app).post(`/api/staff/orders/${id}/payments/cash`).set(auth(T.token)).send({ amount: R(2100) });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  assert.equal((await request(app).get(`/api/staff/orders/${id}`).set(auth(T.token))).body.order.paymentStatus, 'paid');
});

test('items added to an open order use the same rules (no base price added to the option)', async () => {
  const o = await request(app).post('/api/staff/orders').set(auth(T.token)).send({ type: 'takeaway', items: [{ productId: ids.hp, variantId: ids.single, quantity: 1 }] });
  const id = o.body._id;
  const add = await request(app).post(`/api/staff/orders/${id}/items`).set(auth(T.token)).send({ items: [{ productId: ids.hp, variantId: ids.three, addons: [{ id: ids.cheese, quantity: 2 }], quantity: 1 }] });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.body.items[1].unitPrice, R(2200));
  assert.equal(add.body.total, R(500 + 2200));
});

test('customer tracking shows the same amount', async () => {
  const t = await request(app).get(pub(`/orders/${ids.trackOrder}?token=${encodeURIComponent(ids.trackToken)}`));
  assert.equal(t.status, 200);
  assert.equal(t.body.total, R(4000));
  assert.equal(t.body.items[0].unitPrice, R(2000));
});

test('historical orders keep their prices after the menu changes', async () => {
  const before = await Order.findOne({ tenantId: T.tenantId, _id: ids.staffOrder }).lean();
  const prod = (await request(app).get(`/api/staff/menu/products/${ids.hp}`).set(auth(T.token))).body;
  await request(app).patch(`/api/staff/menu/products/${ids.hp}`).set(auth(T.token)).send({ variants: prod.variants.map((v: any) => (v._id === ids.three ? { ...v, price: R(2400) } : v)), addons: prod.addons.map((a: any) => ({ ...a, price: R(150) })) }).expect(200);
  const after = (await request(app).get(`/api/staff/orders/${ids.staffOrder}`).set(auth(T.token))).body.order;
  assert.equal(after.total, before!.total);
  assert.equal(after.items[0].unitPrice, R(2100));
  assert.equal((await request(app).get(`/api/staff/orders/${ids.staffOrder}/receipt`).set(auth(T.token))).body.totals.total, R(2100));
  // New orders use the new prices.
  assert.equal((await order([{ productId: ids.hp, variantId: ids.three, addons: [{ id: ids.cheese, quantity: 1 }], quantity: 1 }])).body.order.total, R(2550));
  await request(app).patch(`/api/staff/menu/products/${ids.hp}`).set(auth(T.token)).send({ variants: prod.variants, addons: prod.addons }).expect(200);
});

test('variant sale price applies once; the dish promo is not added on top; coupon applies once', async () => {
  const prod = (await request(app).get(`/api/staff/menu/products/${ids.hp}`).set(auth(T.token))).body;
  await request(app).patch(`/api/staff/menu/products/${ids.hp}`).set(auth(T.token)).send({ variants: prod.variants.map((v: any) => (v._id === ids.three ? { ...v, salePrice: R(1800) } : v)) }).expect(200);
  await request(app).post('/api/staff/coupons').set(auth(T.token)).send({ code: 'NASHTA100', type: 'fixed', value: R(100), isActive: true }).expect(201);
  const r = await order([{ productId: ids.hp, variantId: ids.three, quantity: 1 }], { couponCode: 'NASHTA100' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.order.subtotal, R(1800));
  assert.equal(r.body.order.discount, R(100));
  assert.equal(r.body.order.total, R(1700));
  assert.equal(r.body.order.items[0].listPrice, R(2000), 'original price kept for display');
  await request(app).patch(`/api/staff/menu/products/${ids.hp}`).set(auth(T.token)).send({ variants: prod.variants }).expect(200);
});

test('choice groups and removable ingredients: validated, priced and shown to the kitchen', async () => {
  const burger = await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({
    categoryId: ids.cat, name: { en: 'Burger' }, price: R(700),
    variants: [{ name: 'Single patty', price: R(700) }, { name: 'Double patty', price: R(1000) }],
    addons: [{ name: 'Extra patty', price: R(300), maxQty: 2 }],
    modifierGroups: [
      { name: 'Sauce', minSelect: 1, maxSelect: 1, options: [{ name: 'Garlic mayo', price: 0 }, { name: 'Chipotle', price: 0 }] },
      { name: 'Make it a meal', minSelect: 0, maxSelect: 1, options: [{ name: 'Fries + drink', price: R(350) }] },
    ],
    removableIngredients: [{ name: 'Onions' }, { name: 'Pickles' }],
  });
  assert.equal(burger.status, 201, JSON.stringify(burger.body));
  assert.equal(burger.body.variantPricing, 'replace', 'options sent with a price default to replacement pricing');
  const b = burger.body;
  const dbl = b.variants[1]._id;
  const sauce = b.modifierGroups[0];
  const meal = b.modifierGroups[1];
  const noSauce = await order([{ productId: b._id, variantId: dbl, quantity: 1 }]);
  assert.equal(noSauce.status, 400);
  assert.match(noSauce.body.error.message, /Please choose Sauce for Burger/);
  const r = await order([{
    productId: b._id, variantId: dbl, quantity: 1,
    choices: [{ groupId: sauce._id, optionId: sauce.options[1]._id }, { groupId: meal._id, optionId: meal.options[0]._id }],
    removeIds: [b.removableIngredients[0]._id],
  }]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.order.total, R(1000 + 350), 'double patty replaces the price; meal upgrade adds; removal is free');
  const detail = (await request(app).get(`/api/staff/orders/${r.body.order._id}`).set(auth(T.token))).body.order;
  assert.deepEqual(detail.items[0].removed, ['Onions']);
  assert.deepEqual(detail.items[0].addons.map((a: any) => `${a.group}:${a.name}`), ['Sauce:Chipotle', 'Make it a meal:Fries + drink']);
});

test('legacy products created with priceDelta keep their additive meaning', async () => {
  const r = await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({ categoryId: ids.cat, name: { en: 'Chicken Tikka' }, price: R(1150), variants: [{ name: 'Leg', priceDelta: 0 }, { name: 'Breast', priceDelta: R(100) }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.variantPricing, 'add');
  const o = await order([{ productId: r.body._id, variantId: r.body.variants[1]._id, quantity: 1 }]);
  assert.equal(o.body.order.total, R(1250));
});

test('inventory: deducted once at acceptance by the chosen options; returned on cancellation', async () => {
  const placed = await order([{ productId: ids.hp, variantId: ids.three, addons: [{ id: ids.extraPuri, quantity: 2 }], quantity: 1 }]);
  const id = placed.body.order._id;
  const stock = async () => Object.fromEntries((await InventoryItem.find({ tenantId: T.tenantId, _id: { $in: [ids.invPuri, ids.invHalwa] } }).lean()).map((i: any) => [String(i._id), i.quantity]));
  const before = await stock();
  await request(app).post(`/api/staff/orders/${id}/status`).set(auth(T.token)).send({ status: 'accepted' }).expect(200);
  const afterAccept = await stock();
  assert.equal(before[ids.invPuri] - afterAccept[ids.invPuri], 3 * 2 + 2, 'three portions of 2 puris + 2 extra puris');
  assert.ok(Math.abs(before[ids.invHalwa] - afterAccept[ids.invHalwa] - 0.3) < 1e-9);
  // A second acceptance attempt cannot deduct again.
  await request(app).post(`/api/staff/orders/${id}/status`).set(auth(T.token)).send({ status: 'accepted' });
  assert.deepEqual(await stock(), afterAccept);
  assert.equal(await StockMovement.countDocuments({ tenantId: T.tenantId, refId: id, type: 'consumption' }), 2);
  await request(app).post(`/api/staff/orders/${id}/status`).set(auth(T.token)).send({ status: 'cancelled', reason: 'Customer left' }).expect(200);
  assert.deepEqual(await stock(), before, 'ingredients returned');
});
