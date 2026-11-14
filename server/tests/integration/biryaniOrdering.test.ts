/**
 * Chicken Biryani through the real API: a dish created in the admin with full-price variants can be ordered at
 * its base price, as Half Plate or Double Chicken, with extras — identically from the storefront checkout,
 * a table QR, the POS quote and a staff (POS) order, and the receipt shows the same amounts.
 */
import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app';

let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let T: Awaited<ReturnType<typeof provisionTenant>>;
const R = (rupees: number) => rupees * 100;
const ids: Record<string, any> = {};

const pub = (path: string) => `/api/public/tenants/${T.slug}${path}`;
let guest = 0;
// Each simulated guest has its own address so the per-IP order rate limit is not what is being tested.
const checkout = (items: any[], extra: any = {}) =>
  request(app).post(pub('/orders')).set('X-Forwarded-For', `10.9.${Math.floor(++guest / 250)}.${guest % 250}`).send({ type: 'takeaway', customer: { name: 'Bilal' }, items, ...extra });

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  T = await provisionTenant(app, p.saToken, p.planId, 'biryani-house');
  const cat = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Rice' } });
  // Exactly what the admin editor sends (variantRequired omitted = API default).
  const r = await request(app).post('/api/staff/menu/products').set(auth(T.token)).send({
    categoryId: cat.body._id, name: { en: 'Chicken Biryani' }, price: R(700),
    variantGroupName: 'Choose your portion', baseOptionLabel: 'Full Plate',
    variants: [{ name: 'Half Plate', price: R(300) }, { name: 'Double Chicken', price: R(600) }],
    addons: [{ name: 'Extra Cheese', price: R(100), maxQty: 2 }, { name: 'Extra Egg', price: R(80), isAvailable: false }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.biryani = r.body._id;
  ids.half = r.body.variants[0]._id;
  ids.double = r.body.variants[1]._id;
  ids.cheese = r.body.addons[0]._id;
  ids.egg = r.body.addons[1]._id;
  const t = await request(app).post('/api/staff/tables').set(auth(T.token)).send({ label: 'T1' });
  ids.qr = t.body.items[0].qrToken;
});

after(async () => stopDb(mongod));

const B = () => ({ productId: ids.biryani });
const cheese = (quantity: number) => ({ addons: [{ id: ids.cheese, quantity }] });

test('new dishes are orderable at the base price by default; the menu shows variants as full prices', async () => {
  const p = (await request(app).get(`/api/staff/menu/products/${ids.biryani}`).set(auth(T.token))).body;
  assert.equal(p.variantPricing, 'replace');
  assert.equal(p.variantRequired, false);
  const menu = (await request(app).get(pub('/menu'))).body.products.find((x: any) => x._id === ids.biryani);
  assert.equal(menu.baseOptionLabel, 'Full Plate');
  assert.deepEqual(menu.variants.map((v: any) => [v.name, v.price]), [['Half Plate', R(300)], ['Double Chicken', R(600)]]);
  assert.deepEqual(menu.displayPrice, { amount: R(300), original: R(300), from: true });
  assert.ok(!menu.addons.some((a: any) => a._id === ids.egg), 'unavailable extra hidden');
});

test('storefront checkout: the full price table', async () => {
  const table: [string, any, number][] = [
    ['Base price, no selection', {}, R(700)],
    ['Half Plate', { variantId: ids.half }, R(300)],
    ['Double Chicken', { variantId: ids.double }, R(600)],
    ['Base + Extra Cheese', cheese(1), R(800)],
    ['Half Plate + Extra Cheese', { variantId: ids.half, ...cheese(1) }, R(400)],
    ['Double Chicken + Extra Cheese', { variantId: ids.double, ...cheese(1) }, R(700)],
    ['Half Plate + 2 Extra Cheese', { variantId: ids.half, ...cheese(2) }, R(500)],
    ['Double Chicken + 2 Extra Cheese', { variantId: ids.double, ...cheese(2) }, R(800)],
  ];
  for (const [label, sel, expected] of table) {
    const r = await checkout([{ ...B(), quantity: 1, ...sel }]);
    assert.equal(r.status, 201, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.order.total, expected, label);
    assert.equal(r.body.order.items[0].unitPrice, expected, label);
  }
  assert.equal((await checkout([{ ...B(), variantId: ids.half, quantity: 2 }])).body.order.total, R(600), 'two Half Plate');
  assert.equal((await checkout([{ ...B(), variantId: ids.double, quantity: 2 }])).body.order.total, R(1200), 'two Double Chicken');
});

test('one order with several configurations keeps them as separate lines with their own prices', async () => {
  const r = await checkout([{ ...B(), quantity: 1 }, { ...B(), variantId: ids.half, quantity: 1 }, { ...B(), variantId: ids.double, ...cheese(1), quantity: 1 }]);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.order.items.map((i: any) => [i.variantName ?? 'base', i.unitPrice]), [['base', R(700)], ['Half Plate', R(300)], ['Double Chicken', R(700)]]);
  assert.equal(r.body.order.total, R(1700));
});

test('table QR order, POS quote and POS order charge exactly what online checkout charges', async () => {
  const items = [{ ...B(), variantId: ids.half, ...cheese(1), quantity: 2 }, { ...B(), quantity: 1 }];
  const online = await checkout(items);
  const qr = await checkout(items, { type: 'dine_in', tableToken: ids.qr });
  const quote = await request(app).post('/api/staff/orders/quote').set(auth(T.token)).send({ type: 'takeaway', items });
  const pos = await request(app).post('/api/staff/orders').set(auth(T.token)).send({ type: 'takeaway', items });
  assert.equal(qr.status, 201, JSON.stringify(qr.body));
  assert.equal(pos.status, 201, JSON.stringify(pos.body));
  const expected = R(400 * 2 + 700);
  assert.equal(online.body.order.total, expected);
  assert.equal(qr.body.order.total, expected);
  assert.equal(quote.body.total, expected);
  assert.equal(pos.body.total, expected);
  assert.deepEqual(quote.body.lines.map((l: any) => l.unitPrice), [R(400), R(700)]);
  const receipt = await request(app).get(`/api/staff/orders/${pos.body._id}/receipt`).set(auth(T.token));
  assert.equal(receipt.body.totals.total, expected);
  assert.deepEqual(receipt.body.items.map((i: any) => [i.variantName ?? null, i.unitPrice, i.lineTotal]), [['Half Plate', R(400), R(800)], [null, R(700), R(700)]]);
});

test('invalid, inactive and unavailable selections, and client prices, are refused or ignored', async () => {
  const bad = await checkout([{ ...B(), variantId: ids.cheese, quantity: 1 }]);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /Invalid option/);
  const egg = await checkout([{ ...B(), addons: [{ id: ids.egg, quantity: 1 }], quantity: 1 }]);
  assert.equal(egg.status, 400, 'unavailable extra');
  const many = await checkout([{ ...B(), ...cheese(3), quantity: 1 }]);
  assert.equal(many.status, 400);
  const forged = await checkout([{ ...B(), variantId: ids.double, quantity: 1, unitPrice: 1, price: 1 }], { total: 1 });
  assert.equal(forged.body.order.total, R(600));

  const p = (await request(app).get(`/api/staff/menu/products/${ids.biryani}`).set(auth(T.token))).body;
  await request(app).patch(`/api/staff/menu/products/${ids.biryani}`).set(auth(T.token)).send({ variants: p.variants.map((v: any) => (v._id === ids.double ? { ...v, isActive: false } : v)) }).expect(200);
  const inactive = await checkout([{ ...B(), variantId: ids.double, quantity: 1 }]);
  assert.equal(inactive.status, 400);
  assert.match(inactive.body.error.message, /no longer available/);
  assert.equal((await checkout([{ ...B(), quantity: 1 }])).body.order.total, R(700), 'base price still orderable');
  await request(app).patch(`/api/staff/menu/products/${ids.biryani}`).set(auth(T.token)).send({ variants: p.variants }).expect(200);
});

test('out of stock: a dish with no portions left cannot be bought in any configuration', async () => {
  await request(app).patch(`/api/staff/menu/products/${ids.biryani}`).set(auth(T.token)).send({ trackStock: true, stockQty: 1 }).expect(200);
  assert.equal((await checkout([{ ...B(), variantId: ids.half, quantity: 1 }])).status, 201, 'last portion');
  const none = await checkout([{ ...B(), quantity: 1 }]);
  assert.equal(none.status, 409);
  assert.match(none.body.error.message, /out of stock/);
  await request(app).patch(`/api/staff/menu/products/${ids.biryani}`).set(auth(T.token)).send({ trackStock: false }).expect(200);
});

test('the owner can require a variant explicitly; then the base price alone is refused', async () => {
  await request(app).patch(`/api/staff/menu/products/${ids.biryani}`).set(auth(T.token)).send({ variantRequired: true }).expect(200);
  const r = await checkout([{ ...B(), quantity: 1 }]);
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /Please choose an option for Chicken Biryani/);
  await request(app).patch(`/api/staff/menu/products/${ids.biryani}`).set(auth(T.token)).send({ variantRequired: false }).expect(200);
  assert.equal((await checkout([{ ...B(), quantity: 1 }])).body.order.total, R(700));
});
