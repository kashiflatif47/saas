/**
 * Delivery automation: zones, automatic/manual assignment, accept timeouts via persistent jobs, rider
 * actions and permissions, proof of delivery, customer tracking view, analytics and tenant isolation.
 * In-memory MongoDB only. No locations or travel times are fabricated.
 */
import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb, PW } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../src/app';
import { Order } from '../../src/models/operations';
import { Job } from '../../src/models/growth';
import { Tenant } from '../../src/models/platform';
import { invalidateTenantCache } from '../../src/services/tenantResolver';
import { runDueJobs } from '../../src/jobs/queue';
import { registerAllJobs } from '../../src/jobs/handlers';
import { haversineKm, pointInPolygon } from '../../src/services/delivery';

let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let A: Awaited<ReturnType<typeof provisionTenant>>;
let B: Awaited<ReturnType<typeof provisionTenant>>;
const s: any = {};
// A square around central Lahore (lng, lat).
const SQUARE: [number, number][] = [[74.30, 31.50], [74.40, 31.50], [74.40, 31.60], [74.30, 31.60]];
const INSIDE = { lat: 31.55, lng: 74.35 };
const OUTSIDE = { lat: 31.70, lng: 74.35 };

async function staff(T: typeof A, role: string, email: string, name = `${role} user`) {
  const r = await request(app).post('/api/staff/staff').set(auth(T.token)).send({ name, email, password: PW, role });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const token = (await request(app).post('/api/auth/login').set('Host', T.host).send({ email, password: PW, tenantSlug: T.slug })).body.accessToken as string;
  return { id: r.body._id as string, token };
}
async function placeDelivery(T: typeof A, extra: any = {}) {
  const r = await request(app).post('/api/public/orders').set('Host', T.host).send({ type: 'delivery', customer: { name: 'Hina Khan', phone: '+923004440001' }, delivery: { address: 'House 1, Street 2', ...extra }, items: [{ productId: s.product, quantity: 1 }] });
  return r;
}
async function accept(T: typeof A, id: string) {
  const r = await request(app).post(`/api/staff/orders/${id}/status`).set(auth(T.token)).send({ status: 'accepted' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
async function makeReady(T: typeof A, id: string) {
  for (const st of ['preparing', 'ready']) {
    const r = await request(app).post(`/api/staff/orders/${id}/status`).set(auth(T.token)).send({ status: st });
    assert.equal(r.status, 200, `${st}: ${JSON.stringify(r.body)}`);
  }
}
const get = async (id: string) => (await Order.findOne({ tenantId: new Types.ObjectId(A.tenantId), _id: id } as any).select('+delivery.code').lean()) as any;

before(async () => {
  mongod = await startDb();
  registerAllJobs();
  const p = await bootstrapPlatform(app);
  A = await provisionTenant(app, p.saToken, p.planId, 'dlv-a');
  B = await provisionTenant(app, p.saToken, p.planId, 'dlv-b');
  for (const T of [A, B]) {
    await Tenant.updateOne({ _id: T.tenantId }, { $set: { 'settings.orderTypes': ['dine_in', 'takeaway', 'delivery'], 'settings.deliveryFee': 100_00 } });
    invalidateTenantCache(T.slug);
  }
  s.manager = await staff(A, 'manager', 'm@dlv-a.test');
  s.waiter = await staff(A, 'waiter', 'w@dlv-a.test');
  s.r1 = await staff(A, 'rider', 'r1@dlv-a.test', 'Ali Raza');
  s.r2 = await staff(A, 'rider', 'r2@dlv-a.test', 'Bilal Ahmed');
  s.rB = await staff(B, 'rider', 'r@dlv-b.test', 'Other Rider');
  const cat = await request(app).post('/api/staff/menu/categories').set(auth(A.token)).send({ name: { en: 'Food' } });
  s.product = (await request(app).post('/api/staff/menu/products').set(auth(A.token)).send({ categoryId: cat.body._id, name: { en: 'Karahi' }, price: 1500_00 })).body._id;
});
after(async () => stopDb(mongod));

test('geometry helpers are exact and deterministic', () => {
  assert.ok(pointInPolygon(INSIDE, SQUARE));
  assert.ok(!pointInPolygon(OUTSIDE, SQUARE));
  const km = haversineKm({ lat: 31.5, lng: 74.3 }, { lat: 31.6, lng: 74.3 });
  assert.ok(km > 11 && km < 11.2, String(km)); // 0.1° latitude ≈ 11.1 km
});

test('without zones, delivery keeps the flat fee (existing behaviour)', async () => {
  const r = await placeDelivery(A);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.order.deliveryFee, 100_00);
});

test('zones: validation, fee/minimum, location matching and public listing without boundaries', async () => {
  assert.equal((await request(app).post('/api/staff/delivery/zones').set(auth(s.waiter.token)).send({ name: 'X', polygon: SQUARE })).status, 403);
  const bad = await request(app).post('/api/staff/delivery/zones').set(auth(A.token)).send({ name: 'Bad', polygon: SQUARE, circle: { center: INSIDE, radiusKm: 2 } });
  assert.equal(bad.status, 400, 'polygon OR circle');
  const z = await request(app).post('/api/staff/delivery/zones').set(auth(s.manager.token)).send({ name: 'Gulberg', polygon: SQUARE, fee: 150_00, minOrder: 1000_00, etaMinutes: 25 });
  assert.equal(z.status, 201, JSON.stringify(z.body));
  s.zone = z.body._id;
  const sf = await request(app).get('/api/public/storefront').set('Host', A.host);
  assert.equal(sf.body.deliveryZones.length, 1);
  assert.equal(sf.body.deliveryZones[0].polygon, undefined, 'boundaries stay server-side');
  assert.equal((await placeDelivery(A, { location: OUTSIDE })).status, 400);
  assert.equal((await placeDelivery(A)).status, 400, 'with zones a zone or location is required');
  const ok = await placeDelivery(A, { location: INSIDE });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.order.deliveryFee, 150_00);
  assert.equal(ok.body.order.delivery.zoneName, 'Gulberg');
  s.order = ok.body.order._id;
  s.tracking = ok.body.trackingToken;
  // Other tenant does not see tenant A zones.
  assert.equal((await request(app).get('/api/staff/delivery/zones').set(auth(B.token))).body.items.length, 0);
});

test('no available rider → flagged for manual assignment (no fake assignment)', async () => {
  await accept(A, s.order);
  const o = await get(s.order);
  assert.equal(o.delivery.status, 'awaiting_assignment');
  assert.match(o.delivery.code, /^\d{4}$/);
  assert.ok(o.delivery.etaAt);
  assert.equal(o.delivery.riderId, undefined);
});

test('riders go available; automatic assignment is deterministic and explained', async () => {
  for (const r of [s.r1, s.r2]) {
    const u = await request(app).patch('/api/staff/delivery/me').set(auth(r.token)).send({ available: true });
    assert.equal(u.status, 200, JSON.stringify(u.body));
  }
  const cands = await request(app).get(`/api/staff/delivery/orders/${s.order}/candidates`).set(auth(s.manager.token));
  assert.equal(cands.body.candidates.length, 2);
  // Equal load, no locations, never assigned → stable tie-break on rider id.
  const expected = [s.r1.id, s.r2.id].sort()[0];
  const r = await request(app).post(`/api/staff/delivery/orders/${s.order}/dispatch/auto`).set(auth(s.manager.token)).send({});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = await get(s.order);
  assert.equal(o.delivery.status, 'assigned');
  assert.equal(String(o.delivery.riderId), expected);
  assert.match(o.delivery.attempts.at(-1).explanation, /distance unknown/);
  s.first = expected;
  s.second = expected === s.r1.id ? s.r2.id : s.r1.id;
  s.firstTok = expected === s.r1.id ? s.r1.token : s.r2.token;
  s.secondTok = expected === s.r1.id ? s.r2.token : s.r1.token;
});

test('accept timeout (persistent job) reassigns to the next rider and excludes the first', async () => {
  const job: any = await Job.findOne({ type: 'delivery.acceptTimeout', 'payload.orderId': s.order } as any).lean();
  assert.ok(job, 'timeout job persisted');
  await runDueJobs({ types: ['delivery.acceptTimeout'], max: 1, now: () => new Date(Date.now() + 10 * 60_000) });
  const o = await get(s.order);
  assert.equal(o.delivery.status, 'assigned');
  assert.equal(String(o.delivery.riderId), s.second);
  assert.ok(o.delivery.attempts.some((a: any) => a.outcome === 'timeout' && a.riderId === s.first));
  // Running the old timeout job again does nothing (idempotent).
  await Job.updateOne({ _id: job._id }, { $set: { status: 'queued', runAt: new Date(0) } });
  await runDueJobs({ types: ['delivery.acceptTimeout'] });
  assert.equal(String((await get(s.order)).delivery.riderId), s.second);
});

test('riders can only act on their own deliveries; riders cannot see the dispatch board', async () => {
  assert.equal((await request(app).post(`/api/staff/delivery/orders/${s.order}/rider/accept`).set(auth(s.firstTok)).send({})).status, 403);
  assert.equal((await request(app).get('/api/staff/delivery/board').set(auth(s.secondTok))).status, 403);
  assert.equal((await request(app).get('/api/staff/orders').set(auth(s.secondTok))).status, 403);
  assert.equal((await request(app).post(`/api/staff/delivery/orders/${s.order}/rider/accept`).set(auth(s.rB.token)).send({})).status, 404, 'other tenant rider');
  const me = await request(app).get('/api/staff/delivery/me').set(auth(s.secondTok));
  assert.equal(me.body.deliveries.length, 1);
  assert.equal(me.body.deliveries[0].customer.name, 'Hina Khan');
});

test('lifecycle: accept → pickup needs a ready order → on the way → deliver with code', async () => {
  const acc = await request(app).post(`/api/staff/delivery/orders/${s.order}/rider/accept`).set(auth(s.secondTok)).send({});
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  const early = await request(app).post(`/api/staff/delivery/orders/${s.order}/rider/pickup`).set(auth(s.secondTok)).send({});
  assert.equal(early.status, 400);
  assert.match(early.body.error.message, /not ready/);
  await makeReady(A, s.order);
  assert.equal((await request(app).post(`/api/staff/delivery/orders/${s.order}/rider/pickup`).set(auth(s.secondTok)).send({})).status, 200);
  assert.equal((await get(s.order)).status, 'delivered', 'order dispatched');
  assert.equal((await request(app).post(`/api/staff/delivery/orders/${s.order}/rider/on_the_way`).set(auth(s.secondTok)).send({})).status, 200);

  // Customer tracking: status and first name only; the code is shown to the customer; no location.
  const track = await request(app).get(`/api/public/orders/${s.order}?token=${s.tracking}`).set('Host', A.host);
  assert.equal(track.body.delivery.status, 'on_the_way');
  assert.ok(['Ali', 'Bilal'].includes(track.body.delivery.riderFirstName));
  assert.match(track.body.delivery.code, /^\d{4}$/);
  assert.equal(track.body.delivery.riderId, undefined);
  assert.equal(track.body.delivery.attempts, undefined);
  assert.equal(track.body.delivery.location, undefined);

  const wrong = await request(app).post(`/api/staff/delivery/orders/${s.order}/rider/deliver`).set(auth(s.secondTok)).send({ code: track.body.delivery.code === '0000' ? '1111' : '0000' });
  assert.equal(wrong.status, 400);
  const done = await request(app).post(`/api/staff/delivery/orders/${s.order}/rider/deliver`).set(auth(s.secondTok)).send({ code: track.body.delivery.code, note: 'Handed to customer' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const o = await get(s.order);
  assert.equal(o.delivery.status, 'delivered');
  assert.equal(o.delivery.proof.codeConfirmed, true);
  assert.equal(o.status, 'completed');
  // Invalid transition after delivery.
  assert.equal((await request(app).post(`/api/staff/delivery/orders/${s.order}/rider/fail`).set(auth(s.secondTok)).send({ reason: 'x' })).status, 409);
});

test('manual reassignment, failure, retry, return; cancelling the order cancels the delivery', async () => {
  const p = await placeDelivery(A, { zoneId: s.zone });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const id = p.body.order._id;
  await accept(A, id); // auto-assigned to one of the riders
  let o = await get(id);
  assert.equal(o.delivery.status, 'assigned');
  const other = String(o.delivery.riderId) === s.r1.id ? s.r2 : s.r1;
  assert.equal((await request(app).post(`/api/staff/delivery/orders/${id}/dispatch/assign`).set(auth(s.waiter.token)).send({ riderId: other.id })).status, 403);
  const re = await request(app).post(`/api/staff/delivery/orders/${id}/dispatch/assign`).set(auth(s.manager.token)).send({ riderId: other.id });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  o = await get(id);
  assert.equal(String(o.delivery.riderId), other.id);
  assert.equal((await request(app).post(`/api/staff/delivery/orders/${id}/dispatch/assign`).set(auth(s.manager.token)).send({ riderId: s.rB.id })).status, 400, 'rider from another tenant');

  await request(app).post(`/api/staff/delivery/orders/${id}/rider/accept`).set(auth(other.token)).send({}).expect(200);
  await makeReady(A, id);
  await request(app).post(`/api/staff/delivery/orders/${id}/rider/pickup`).set(auth(other.token)).send({}).expect(200);
  assert.equal((await request(app).post(`/api/staff/delivery/orders/${id}/rider/fail`).set(auth(other.token)).send({})).status, 400, 'reason required');
  await request(app).post(`/api/staff/delivery/orders/${id}/rider/fail`).set(auth(other.token)).send({ reason: 'Customer not reachable' }).expect(200);
  assert.equal((await get(id)).delivery.status, 'failed');
  await request(app).post(`/api/staff/delivery/orders/${id}/dispatch/return`).set(auth(s.manager.token)).send({}).expect(200);
  assert.equal((await get(id)).delivery.status, 'returned');

  const c = await placeDelivery(A, { zoneId: s.zone });
  await accept(A, c.body.order._id);
  await request(app).post(`/api/staff/orders/${c.body.order._id}/status`).set(auth(A.token)).send({ status: 'cancelled', reason: 'Customer cancelled' }).expect(200);
  assert.equal((await get(c.body.order._id)).delivery.status, 'cancelled');
});

test('rider location is only stored when sharing is on, and dropped when off', async () => {
  assert.equal((await request(app).post('/api/staff/delivery/me/location').set(auth(s.r1.token)).send(INSIDE)).status, 400);
  await request(app).patch('/api/staff/delivery/me').set(auth(s.r1.token)).send({ locationSharing: true }).expect(200);
  await request(app).post('/api/staff/delivery/me/location').set(auth(s.r1.token)).send(INSIDE).expect(200);
  const list = await request(app).get('/api/staff/delivery/riders').set(auth(s.manager.token));
  const r1 = list.body.items.find((x: any) => x._id === s.r1.id);
  assert.equal(r1.riderProfile.location.lat, undefined, 'dispatcher list does not expose coordinates');
  assert.ok(r1.riderProfile.location.at);
  const off = await request(app).patch('/api/staff/delivery/me').set(auth(s.r1.token)).send({ locationSharing: false });
  assert.equal(off.body.location, null);
});

test('delay check alerts once per late delivery (persistent job, idempotent)', async () => {
  const p = await placeDelivery(A, { zoneId: s.zone });
  await accept(A, p.body.order._id);
  await Order.updateOne({ tenantId: new Types.ObjectId(A.tenantId), _id: p.body.order._id } as any, { $set: { 'delivery.etaAt': new Date(Date.now() - 60 * 60_000) } });
  const { checkDelays } = await import('../../src/services/delivery');
  const t = { _id: new Types.ObjectId(A.tenantId), settings: (await Tenant.findById(A.tenantId).lean())!.settings } as any;
  assert.ok((await checkDelays(t)).late >= 1);
  assert.equal((await checkDelays(t)).late, 0, 'not alerted twice');
});

test('analytics come from recorded timestamps; tenant-isolated', async () => {
  const a = await request(app).get('/api/staff/delivery/analytics?period=today').set(auth(A.token));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.ok(a.body.delivered >= 1);
  assert.ok(a.body.failed >= 1);
  assert.equal(a.body.onTimeRatePercent != null, true);
  assert.match(a.body.basis, /Distances are not measured/);
  assert.ok(a.body.riders.some((r: any) => r.timeouts >= 1));
  const b = await request(app).get('/api/staff/delivery/analytics?period=today').set(auth(B.token));
  assert.equal(b.body.total, 0);
  assert.equal((await request(app).get('/api/staff/delivery/board').set(auth(B.token))).body.items.length, 0);
});
