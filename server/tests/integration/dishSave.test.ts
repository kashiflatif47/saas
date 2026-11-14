/**
 * Regression for "dishes are not saving" / "Coming soon" / "branding disappeared".
 * Uses the dish editor's REAL form code (client/src/pages/owner/productForm.ts) against the API, with products
 * stored exactly as older versions saved them (shapes copied from the live database, ids and customers removed).
 */
import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../src/app';
import { Product } from '../../src/models/menu';
import { uploadPathOf } from '../../src/services/assetCheck';
import { blankProduct, productFormToBody, productToForm } from '../../../client/src/pages/owner/productForm';

let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let T: Awaited<ReturnType<typeof provisionTenant>>;
const R = (rupees: number) => rupees * 100;
const ids: Record<string, any> = {};
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d70000000049454e44ae426082', 'hex');
const pub = (p: string) => `/api/public/tenants/${T.slug}${p}`;
let guest = 0;
const checkout = (items: any[]) => request(app).post(pub('/orders')).set('X-Forwarded-For', `10.7.0.${++guest}`).send({ type: 'takeaway', customer: { name: 'Test' }, items });
const getProduct = async (id: string) => (await request(app).get(`/api/staff/menu/products/${id}`).set(auth(T.token))).body;
const save = (form: any) => (form._id ? request(app).patch(`/api/staff/menu/products/${form._id}`) : request(app).post('/api/staff/menu/products')).set(auth(T.token)).send(productFormToBody(form, 2));

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  T = await provisionTenant(app, p.saToken, p.planId, 'lzzat-copy');
  ids.main = (await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Main Course' } })).body._id;
  // Stored with the raw driver, exactly as an older version left them (no new option fields at all).
  const tenantId = new Types.ObjectId(T.tenantId);
  const legacy = await Product.collection.insertOne({
    tenantId, categoryId: new Types.ObjectId(ids.main), name: { en: 'Chicken Biryani', ur: 'چکن بریانی' }, price: R(500), promoPrice: R(400), promoEndsAt: new Date(Date.now() + 30 * 86400_000),
    variants: [{ _id: new Types.ObjectId(), name: 'Half Plate ', priceDelta: R(300) }, { _id: new Types.ObjectId(), name: 'Double Chicken Piece ', priceDelta: R(600) }],
    addons: [{ _id: new Types.ObjectId(), name: 'Raita', price: R(50), isAvailable: true }],
    tags: ['Spicy'], images: ['/uploads/' + T.tenantId + '/products/lost-in-redeploy.png'], isFeatured: false, isAvailable: true, isArchived: false, trackStock: false, stockQty: 0, recipe: [], prepMinutes: 10, sortOrder: 0,
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
  ids.legacy = String(legacy.insertedId);
});

after(async () => stopDb(mongod));

test('legacy dish: opening and saving it unchanged in the editor works and keeps today\'s prices', async () => {
  const before = await getProduct(ids.legacy);
  const r = await save(productToForm(before, 2));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await getProduct(ids.legacy);
  assert.deepEqual(after.variants.map((v: any) => v.priceDelta), [R(300), R(600)]);
  assert.equal(after.variantPricing, 'add', 'nothing converted without the owner deciding');
  assert.deepEqual(after.images, before.images, 'image references untouched');
  // Today: promo 400 + 300 = 700, 400 + 600 = 1,000 (the amounts reported).
  assert.equal((await checkout([{ productId: ids.legacy, variantId: after.variants[0]._id, quantity: 1 }])).body.order.total, R(700));
  assert.equal((await checkout([{ productId: ids.legacy, variantId: after.variants[1]._id, quantity: 1 }])).body.order.total, R(1000));
});

test('legacy dish converted in the editor to full-price variants saves and charges 300 / 600, base orderable', async () => {
  const form = productToForm(await getProduct(ids.legacy), 2);
  form.variantPricing = 'replace';
  form.variants = form.variants.map((v: any, i: number) => ({ ...v, price: i === 0 ? '300' : '600' })); // "The amounts are the full selling prices"
  form.variantRequired = false;
  const r = await save(form);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = await getProduct(ids.legacy);
  assert.equal((await checkout([{ productId: p._id, quantity: 1 }])).body.order.total, R(400), 'base price (promo 400 of 500)');
  assert.equal((await checkout([{ productId: p._id, variantId: p.variants[0]._id, quantity: 1 }])).body.order.total, R(300));
  assert.equal((await checkout([{ productId: p._id, variantId: p.variants[1]._id, addons: [{ id: p.addons[0]._id, quantity: 1 }], quantity: 1 }])).body.order.total, R(650));
});

test('a new dish from the editor saves, accepts a photo and appears on the storefront', async () => {
  const form: any = blankProduct(ids.main);
  form.name = { en: 'Chicken Karahi' };
  form.price = '1200';
  form.variants = [{ name: 'Half', description: '', price: '700', salePrice: '', saleEndsAt: '', priceDelta: '0', isActive: true, recipeMultiplier: '' }];
  form.addons = [{ name: 'Extra Naan', description: '', price: '50', salePrice: '', isAvailable: true, maxQty: '3', ingredient: null }];
  const r = await save(form);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.karahi = r.body._id;
  assert.equal(r.body.variantRequired, false);

  const up = await request(app).post(`/api/staff/menu/products/${ids.karahi}/images`).set(auth(T.token)).attach('files', PNG, 'karahi.png');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const url = up.body.images[0];
  assert.equal((await request(app).get(url)).status, 200, 'uploaded photo is served');

  const menu = (await request(app).get(pub('/menu'))).body;
  const shown = menu.products.find((p: any) => p._id === ids.karahi);
  assert.ok(shown, 'new dish is on the storefront');
  assert.deepEqual(shown.images, [url]);
  assert.equal((await checkout([{ productId: ids.karahi, quantity: 1 }])).body.order.total, R(1200));
  assert.equal((await checkout([{ productId: ids.karahi, variantId: shown.variants[0]._id, addons: [{ id: shown.addons[0]._id, quantity: 2 }], quantity: 1 }])).body.order.total, R(800));

  // Editing it again (name + price) also saves.
  const edit = productToForm(await getProduct(ids.karahi), 2);
  edit.price = '1250';
  assert.equal((await save(edit)).status, 200);
  assert.equal((await checkout([{ productId: ids.karahi, quantity: 1 }])).body.order.total, R(1250));
});

test('an invalid dish is refused with a message the admin can act on (not a silent failure)', async () => {
  const form: any = blankProduct(ids.main);
  form.name = { en: 'Bad' };
  form.price = '500';
  form.variants = [{ name: 'Half', description: '', price: '300', salePrice: '400', saleEndsAt: '', priceDelta: '0', isActive: true, recipeMultiplier: '' }];
  const r = await save(form);
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /Option “Half”: the sale price must be lower than its price/);
});

test('dishes outside their serving hours: storefront gets the hours instead of an empty "coming soon" menu', async () => {
  // A schedule that is never "now": yesterday's weekday only.
  const notToday = (new Date().getUTCDay() + 5) % 7; // two days ago, in any time zone
  const cat = await request(app).post('/api/staff/menu/categories').set(auth(T.token)).send({ name: { en: 'Breakfast' }, schedule: { days: [notToday], from: '07:59', to: '11:00' } });
  const hp: any = blankProduct(cat.body._id);
  Object.assign(hp, { name: { en: 'Halwa Puri' }, price: '850' });
  assert.equal((await save(hp)).status, 201);

  const menu = (await request(app).get(pub('/menu'))).body;
  assert.ok(!menu.products.some((p: any) => p.name.en === 'Halwa Puri'), 'hidden right now');
  assert.deepEqual(menu.closedNow.map((c: any) => [c.name.en, c.schedule.from, c.schedule.to]), [['Breakfast', '07:59', '11:00']]);
  const staffCats = (await request(app).get('/api/staff/menu/categories').set(auth(T.token))).body.items;
  assert.equal(staffCats.find((c: any) => c.name.en === 'Breakfast').visibleNow, false, 'admin sees "Hidden now"');
  assert.equal(staffCats.find((c: any) => c.name.en === 'Main Course').visibleNow, true);
});

test('missing uploaded files are reported (read-only), present ones are not; records are not changed', async () => {
  const r = await request(app).get('/api/staff/tenant/asset-check').set(auth(T.token));
  assert.equal(r.status, 200);
  const missing = r.body.missing.map((m: any) => m.url);
  assert.ok(missing.some((u: string) => u.endsWith('lost-in-redeploy.png')), 'the lost file is reported');
  const karahiImg = (await getProduct(ids.karahi)).images[0];
  assert.ok(!missing.includes(karahiImg), 'an existing file is not reported');
  assert.ok(fs.existsSync(uploadPathOf(T.tenantId, karahiImg)!));
  assert.equal(uploadPathOf(T.tenantId, `/uploads/${T.tenantId}/../../etc/passwd`), null, 'never looks outside the restaurant folder');
  assert.ok((await getProduct(ids.legacy)).images[0].endsWith('lost-in-redeploy.png'), 'the reference is kept for re-upload/restore');
});
