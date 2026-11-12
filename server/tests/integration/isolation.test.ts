import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb, PW } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { createApp } from '../../src/app';
import { initSockets } from '../../src/sockets';
import { Product } from '../../src/models/menu';
import { TenantScopeError } from '../../src/models/tenantScope';

let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let A: Awaited<ReturnType<typeof provisionTenant>>;
let B: Awaited<ReturnType<typeof provisionTenant>>;
let saToken: string;
const ids: Record<string, string> = {};

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  saToken = p.saToken;
  A = await provisionTenant(app, p.saToken, p.planId, 'alpha');
  B = await provisionTenant(app, p.saToken, p.planId, 'bravo');

  for (const [key, t] of [['A', A], ['B', B]] as const) {
    const cat = await request(app).post('/api/staff/menu/categories').set(auth(t.token)).send({ name: { en: `Cat ${key}` } });
    assert.equal(cat.status, 201, JSON.stringify(cat.body));
    const prod = await request(app).post('/api/staff/menu/products').set(auth(t.token)).send({ categoryId: cat.body._id, name: { en: `Prod ${key}` }, price: 1000 });
    assert.equal(prod.status, 201, JSON.stringify(prod.body));
    const tables = await request(app).post('/api/staff/tables').set(auth(t.token)).send({ label: `${key}1` });
    assert.equal(tables.status, 201);
    ids[`cat${key}`] = cat.body._id;
    ids[`prod${key}`] = prod.body._id;
    ids[`table${key}`] = tables.body.items[0]._id;
    ids[`token${key}`] = tables.body.items[0].qrToken;
  }
});

after(async () => stopDb(mongod));

test('list endpoints return only own tenant data', async () => {
  const res = await request(app).get('/api/staff/menu/products').set(auth(A.token));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((p: any) => p.name.en), ['Prod A']);
});

test('reading, updating or deleting another tenant record by id returns 404', async () => {
  const get = await request(app).get(`/api/staff/menu/products/${ids.prodB}`).set(auth(A.token));
  assert.equal(get.status, 404);
  const patch = await request(app).patch(`/api/staff/menu/products/${ids.prodB}`).set(auth(A.token)).send({ price: 1 });
  assert.equal(patch.status, 404);
  const del = await request(app).delete(`/api/staff/menu/products/${ids.prodB}`).set(auth(A.token));
  assert.equal(del.status, 404);
  const still = await Product.findOne({ tenantId: B.tenantId, _id: ids.prodB }).lean();
  assert.equal(still?.price, 1000);
  assert.equal(still?.isArchived, false);
});

test('cannot create records referencing another tenant (category, table)', async () => {
  const res = await request(app).post('/api/staff/menu/products').set(auth(A.token)).send({ categoryId: ids.catB, name: { en: 'x' }, price: 1 });
  assert.equal(res.status, 400);
  const order = await request(app).post('/api/staff/orders').set(auth(A.token)).send({ type: 'dine_in', tableId: ids.tableB, items: [{ productId: ids.prodA, quantity: 1 }] });
  assert.equal(order.status, 400);
});

test('tenantId in request body is ignored / cannot be overridden', async () => {
  const res = await request(app).post('/api/staff/menu/categories').set(auth(A.token)).send({ name: { en: 'Sneaky' }, tenantId: B.tenantId });
  assert.equal(res.status, 201);
  assert.equal(res.body.tenantId, A.tenantId);
});

test('staff token used on another tenant host is rejected', async () => {
  const res = await request(app).get('/api/staff/menu/products').set(auth(A.token)).set('Host', B.host);
  assert.equal(res.status, 403);
});

test('staff cannot log in to another tenant with their credentials', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: 'owner@alpha.test', password: PW, tenantSlug: 'bravo' });
  assert.equal(res.status, 401);
});

test('login is bound to the requesting tenant host', async () => {
  const wrongHost = await request(app).post('/api/auth/login').set('Host', B.host).send({ email: 'owner@alpha.test', password: PW, tenantSlug: 'alpha' });
  assert.equal(wrongHost.status, 401);
  const saOnTenantHost = await request(app).post('/api/auth/login').set('Host', A.host).send({ email: 'sa@test.local', password: PW });
  assert.equal(saOnTenantHost.status, 401);
  const ok = await request(app).post('/api/auth/login').set('Host', A.host).send({ email: 'owner@alpha.test', password: PW, tenantSlug: 'alpha' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers['set-cookie'];
  const crossRefresh = await request(app).post('/api/auth/refresh').set('Host', B.host).set('Cookie', cookie);
  assert.equal(crossRefresh.status, 401, 'refresh cookie from alpha must not work on bravo');
});

test('public menu is scoped by host and other tenants QR tokens do not resolve', async () => {
  const menu = await request(app).get('/api/public/menu').set('Host', A.host);
  assert.equal(menu.status, 200);
  assert.deepEqual(menu.body.products.map((p: any) => p.name.en), ['Prod A']);
  const foreign = await request(app).get(`/api/public/tables/${ids.tokenB}`).set('Host', A.host);
  assert.equal(foreign.status, 404);
  const order = await request(app).post('/api/public/orders').set('Host', A.host).send({ type: 'dine_in', tableToken: ids.tokenA, items: [{ productId: ids.prodB, quantity: 1 }] });
  assert.equal(order.status, 400, 'ordering another tenant product must fail');
});

test('unknown hosts and root domain do not resolve a tenant', async () => {
  assert.equal((await request(app).get('/api/public/menu').set('Host', 'nope.test.local')).status, 404);
  assert.equal((await request(app).get('/api/public/menu').set('Host', 'test.local')).status, 404);
  assert.equal((await request(app).get('/api/public/menu').set('Host', 'alpha.evil.com')).status, 404);
});

test('order tracking requires the secret token and the right tenant host', async () => {
  const placed = await request(app).post('/api/public/orders').set('Host', A.host).send({ type: 'dine_in', tableToken: ids.tokenA, items: [{ productId: ids.prodA, quantity: 1 }] });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const id = placed.body.order._id;
  assert.equal((await request(app).get(`/api/public/orders/${id}`).set('Host', A.host)).status, 404);
  assert.equal((await request(app).get(`/api/public/orders/${id}?token=wrongwrongwrong`).set('Host', A.host)).status, 404);
  assert.equal((await request(app).get(`/api/public/orders/${id}?token=${placed.body.trackingToken}`).set('Host', B.host)).status, 404);
  const ok = await request(app).get(`/api/public/orders/${id}?token=${placed.body.trackingToken}`).set('Host', A.host);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.trackingToken, undefined);
  ids.orderA = id;
});

test('analytics, audit and staff lists are tenant scoped', async () => {
  const sum = await request(app).get('/api/staff/analytics/summary?period=month').set(auth(B.token));
  assert.equal(sum.status, 200);
  assert.equal(sum.body.summary.orders, 0, 'B must not see A orders');
  const staff = await request(app).get('/api/staff/staff').set(auth(B.token));
  assert.ok(staff.body.items.every((u: any) => u.tenantId === B.tenantId));
  const audit = await request(app).get('/api/staff/audit').set(auth(B.token));
  assert.ok(audit.body.items.every((a: any) => a.tenantId === B.tenantId));
});

test('tenant staff cannot reach platform APIs; super admin cannot use tenant staff APIs', async () => {
  assert.equal((await request(app).get('/api/platform/tenants').set(auth(A.token))).status, 403);
  assert.equal((await request(app).get('/api/staff/menu/products').set(auth(saToken))).status, 403);
});

test('model guard throws when a query omits tenantId', async () => {
  await assert.rejects(() => Product.find({}).exec(), (e: any) => e instanceof TenantScopeError);
  await assert.rejects(() => Product.updateMany({}, { $set: { price: 0 } }).exec(), (e: any) => e instanceof TenantScopeError);
  await assert.rejects(() => Product.aggregate([{ $match: {} }]).exec(), (e: any) => e instanceof TenantScopeError);
});

test('upload paths are namespaced per tenant', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d70000000049454e44ae426082', 'hex');
  const up = await request(app).post('/api/staff/tenant/branding/logo').set(auth(A.token)).attach('file', png, 'logo.png');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.ok(up.body.url.startsWith(`/uploads/${A.tenantId}/`));
  const bad = await request(app).post('/api/staff/tenant/branding/logo').set(auth(A.token)).attach('file', Buffer.from('<svg/>'), 'x.png');
  assert.equal(bad.status, 400);
});

test('Socket.IO events never cross tenants', async () => {
  const server = http.createServer(app);
  const io = initSockets(server);
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** Rejects after `ms` so a missing event fails the test instead of hanging the runner. */
  const within = <T>(p: Promise<T>, what: string, ms = 5000) =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms))]);
  // Listeners are attached at creation time so fast handshakes/rejections are never missed.
  const a = ioClient(url, { auth: { token: A.token }, transports: ['websocket'], reconnection: false });
  const aConnected = new Promise<void>((r) => a.once('connect', () => r()));
  const b = ioClient(url, { auth: { token: B.token }, transports: ['websocket'], reconnection: false });
  const bConnected = new Promise<void>((r) => b.once('connect', () => r()));
  const anon = ioClient(url, { transports: ['websocket'], reconnection: false });
  const anonRejected = new Promise((r) => anon.once('connect_error', r));
  try {
    await within(Promise.all([aConnected, bConnected]), 'staff sockets to connect');
    const anonErr = await within(anonRejected, 'anonymous socket rejection');
    assert.ok(anonErr, 'anonymous socket rejected');
    const bEvents: unknown[] = [];
    b.on('order:new', (e) => bEvents.push(e));
    const aGot = new Promise((r) => a.once('order:new', r));
    // Malicious subscribe attempt by B to A's station id is namespaced to B's tenant and therefore useless.
    b.emit('kitchen:watchStation', ids.catA);
    const placed = await request(app).post('/api/public/orders').set('Host', A.host).send({ type: 'dine_in', tableToken: ids.tokenA, items: [{ productId: ids.prodA, quantity: 2 }] });
    assert.equal(placed.status, 201);
    await within(aGot, 'tenant A order:new event');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(bEvents.length, 0, 'tenant B received tenant A event');
  } finally {
    a.close();
    b.close();
    anon.close();
    // io.close() disconnects every socket and closes the underlying HTTP server.
    await new Promise<void>((r) => io.close(() => r()));
  }
});
