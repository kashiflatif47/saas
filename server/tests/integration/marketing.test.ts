/**
 * Marketing automation: segments, consent, campaigns (approval, scheduling, dispatch), safety rules,
 * provider failures (stubbed fetch — no real messages), Twilio status callbacks, coupons and reporting.
 * In-memory MongoDB only.
 */
import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb, PW } from '../helpers';
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../src/app';
import { Customer, Order } from '../../src/models/operations';
import { Campaign, MessageLog } from '../../src/models/growth';
import { Tenant } from '../../src/models/platform';
import { runDueJobs } from '../../src/jobs/queue';
import { registerAllJobs } from '../../src/jobs/handlers';
import { classify, rulesFor } from '../../src/services/segments';
import { quietUntil, unsubscribeToken } from '../../src/services/marketing';
import { twilioSignature, twilioStatusCallbackUrl } from '../../src/services/messaging';
import { invalidateTenantCache } from '../../src/services/tenantResolver';

let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let A: Awaited<ReturnType<typeof provisionTenant>>;
let B: Awaited<ReturnType<typeof provisionTenant>>;
const s: any = {};
const DAY = 86400_000;
const SID = 'AC' + 'a'.repeat(32);
const TOKEN = 'b'.repeat(32);

/* -------- fetch stub: records every outbound provider request; nothing leaves the machine -------- */
const realFetch = globalThis.fetch;
let outbound: { url: string; body: string }[] = [];
let failMode: 'none' | 'transient' | 'permanent' = 'none';
let sidN = 0;
function installFetch() {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.twilio.com') && !u.startsWith('https://api.sendgrid.com')) return realFetch(url, init);
    outbound.push({ url: u, body: String(init.body ?? '') });
    if (failMode === 'transient') return new Response(JSON.stringify({ message: 'busy' }), { status: 503 });
    if (failMode === 'permanent') return new Response(JSON.stringify({ message: 'invalid number' }), { status: 400 });
    if (u.endsWith('/Messages.json')) return new Response(JSON.stringify({ sid: `SM${++sidN}`, status: 'queued' }), { status: 201 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
}

async function staffToken(T: typeof A, role: string, email: string) {
  const r = await request(app).post('/api/staff/staff').set(auth(T.token)).send({ name: `${role} user`, email, password: PW, role });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return (await request(app).post('/api/auth/login').set('Host', T.host).send({ email, password: PW, tenantSlug: T.slug })).body.accessToken as string;
}
async function order(T: typeof A, phone: string, name: string, consent: boolean, extra: any = {}) {
  const r = await request(app).post('/api/public/orders').set('Host', T.host).send({ type: 'takeaway', customer: { name, phone }, marketingConsent: consent, items: [{ productId: s.burger, quantity: 1 }], ...extra });
  return r;
}
const now = () => new Date();
const tA = () => new Types.ObjectId(A.tenantId);

before(async () => {
  mongod = await startDb();
  registerAllJobs();
  installFetch();
  const p = await bootstrapPlatform(app);
  A = await provisionTenant(app, p.saToken, p.planId, 'mkt-a');
  B = await provisionTenant(app, p.saToken, p.planId, 'mkt-b');
  s.manager = await staffToken(A, 'manager', 'm@mkt-a.test');
  s.waiter = await staffToken(A, 'waiter', 'w@mkt-a.test');
  const cat = await request(app).post('/api/staff/menu/categories').set(auth(A.token)).send({ name: { en: 'Food' } });
  const drinks = await request(app).post('/api/staff/menu/categories').set(auth(A.token)).send({ name: { en: 'Drinks' } });
  s.burger = (await request(app).post('/api/staff/menu/products').set(auth(A.token)).send({ categoryId: cat.body._id, name: { en: 'Burger' }, price: 1000_00 })).body._id;
  s.cola = (await request(app).post('/api/staff/menu/products').set(auth(A.token)).send({ categoryId: drinks.body._id, name: { en: 'Cola' }, price: 200_00 })).body._id;
  s.drinksCat = drinks.body._id;
  // Quiet hours off for deterministic tests (start === end disables them); generous frequency.
  await request(app).patch('/api/staff/marketing/settings').set(auth(A.token)).send({ quietStart: '00:00', quietEnd: '00:00', maxPerWeek: 2, minHoursBetween: 1 }).expect(200);
});
after(async () => {
  globalThis.fetch = realFetch;
  await stopDb(mongod);
});
beforeEach(() => {
  outbound = [];
  failMode = 'none';
});

test('segment rules are explainable and deterministic', () => {
  const rules = rulesFor({ settings: {} } as any);
  const t = new Date('2026-11-01T00:00:00Z');
  const fresh = classify({ orders: 1, spend: 100, firstOrderAt: new Date(t.getTime() - 2 * DAY), lastOrderAt: new Date(t.getTime() - 2 * DAY) } as any, rules, 0, t);
  assert.ok(fresh.includes('new'));
  const lapsed = classify({ orders: 6, spend: 100, firstOrderAt: new Date(t.getTime() - 200 * DAY), lastOrderAt: new Date(t.getTime() - 90 * DAY) } as any, rules, 0, t);
  assert.ok(lapsed.includes('inactive') && lapsed.includes('returning'), JSON.stringify(lapsed));
  assert.ok(!lapsed.includes('loyal'), 'loyal requires recent activity');
  assert.ok(!lapsed.includes('new'));
});

test('checkout consent is recorded only when ticked; segments are recalculated from orders', async () => {
  assert.equal((await order(A, '+923001110001', 'Ayesha', true)).status, 201);
  assert.equal((await order(A, '+923001110002', 'Bilal', false)).status, 201);
  assert.equal((await order(A, '+923001110003', 'Sana', true)).status, 201);
  const ayesha: any = await Customer.findOne({ tenantId: A.tenantId, phone: '+923001110001' } as any).lean();
  const bilal: any = await Customer.findOne({ tenantId: A.tenantId, phone: '+923001110002' } as any).lean();
  assert.equal(ayesha.consent.sms.granted, true);
  assert.notEqual(bilal.consent?.sms?.granted, true, 'no implicit consent');
  s.ayesha = String(ayesha._id);
  s.sana = String((await Customer.findOne({ tenantId: A.tenantId, phone: '+923001110003' } as any).lean())!._id);
  // Orders count once accepted.
  for (const o of await Order.find({ tenantId: A.tenantId } as any).lean()) await Order.collection.updateOne({ _id: o._id }, { $set: { status: 'completed' } });
  const r = await request(app).post('/api/staff/marketing/segments/recalculate').set(auth(A.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const seg = await request(app).get('/api/staff/marketing/segments').set(auth(A.token));
  assert.equal(seg.body.counts.new, 3);
  assert.ok(seg.body.definitions.new);
  // Waiters have no marketing access; managers see masked phones unless they can manage customers.
  assert.equal((await request(app).get('/api/staff/marketing/segments').set(auth(s.waiter))).status, 403);
});

test('campaign lifecycle: draft → approval (owner) → schedule needs a provider → send', async () => {
  const c = await request(app).post('/api/staff/marketing/campaigns').set(auth(s.manager)).send({ name: 'Welcome', channel: 'sms', segments: ['new'], body: 'Hi {{name}}, 10% off with {{coupon}}', coupon: { type: 'percent', value: 10, validDays: 7, categoryIds: [s.drinksCat] } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  s.campaign = c.body._id;
  const id = s.campaign;
  // A manager cannot approve; nothing goes out without approval.
  assert.equal((await request(app).post(`/api/staff/marketing/campaigns/${id}/approve`).set(auth(A.token)).send({})).status, 409, 'cannot approve a draft');
  await request(app).post(`/api/staff/marketing/campaigns/${id}/submit`).set(auth(s.manager)).send({}).expect(200);
  assert.equal((await request(app).post(`/api/staff/marketing/campaigns/${id}/approve`).set(auth(s.manager)).send({})).status, 403);
  await request(app).post(`/api/staff/marketing/campaigns/${id}/approve`).set(auth(A.token)).send({}).expect(200);
  // No SMS provider configured yet: scheduling is refused (no simulated sending).
  const noProv = await request(app).post(`/api/staff/marketing/campaigns/${id}/schedule`).set(auth(A.token)).send({});
  assert.equal(noProv.status, 400);
  assert.match(noProv.body.error.message, /provider/);

  // Configure Twilio (encrypted at rest, never returned).
  const cfg = await request(app).patch('/api/staff/marketing/channels').set(auth(A.token)).send({ sms: { provider: 'twilio', accountSid: SID, authToken: TOKEN, from: '+15005550006' } });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
  const ch = await request(app).get('/api/staff/marketing/channels').set(auth(A.token));
  assert.equal(ch.body.sms.hasAuthToken, true);
  assert.ok(!JSON.stringify(ch.body).includes(TOKEN), 'secret is not returned');
  const raw: any = await Tenant.collection.findOne({ _id: new Types.ObjectId(A.tenantId) });
  assert.ok(!JSON.stringify(raw.messaging).includes(TOKEN), 'secret is encrypted at rest');
  assert.equal((await request(app).post('/api/staff/marketing/channels/sms/verify').set(auth(A.token))).status, 200);
  assert.equal(outbound.length, 1, 'verification calls the provider once');

  const prev = await request(app).get(`/api/staff/marketing/campaigns/${id}/preview`).set(auth(A.token));
  assert.equal(prev.body.recipients, 2, 'only the two consenting customers');
  assert.match(prev.body.renderedSample, /Opt out:/);

  const test = await request(app).post(`/api/staff/marketing/campaigns/${id}/test`).set(auth(A.token)).send({ to: '+923009999999' });
  assert.equal(test.status, 200, JSON.stringify(test.body));
  assert.match(test.body.note, /callback/);

  outbound = [];
  await request(app).post(`/api/staff/marketing/campaigns/${id}/schedule`).set(auth(A.token)).send({}).expect(200);
  await runDueJobs({ types: ['campaign.start'] });
  await runDueJobs({ types: ['messages.dispatch'], now: () => new Date(Date.now() + 15 * 60_000) });
  const sends = outbound.filter((o) => o.url.endsWith('/Messages.json'));
  assert.equal(sends.length, 2, 'one SMS per consenting customer');
  assert.ok(sends.every((x) => !x.body.includes('923001110002')), 'non-consenting customer not messaged');
  const logs = await MessageLog.find({ tenantId: A.tenantId, 'source.id': id } as any).lean();
  assert.ok(logs.every((l: any) => l.status === 'sent'), JSON.stringify(logs.map((l: any) => [l.status, l.skipReason, l.error])));
  const camp: any = await Campaign.findOne({ tenantId: tA(), _id: id } as any).lean();
  assert.equal(camp.status, 'completed');
  assert.ok(camp.couponCode);
  s.code = camp.couponCode;

  // Running the start job again (restart / duplicate trigger) never re-sends.
  await Campaign.updateOne({ tenantId: tA(), _id: id }, { $set: { status: 'scheduled', scheduleAt: new Date() } });
  const { startCampaign } = await import('../../src/services/marketing');
  await startCampaign({ _id: new Types.ObjectId(A.tenantId), settings: (await Tenant.findById(A.tenantId).lean())!.settings } as any, id);
  outbound = [];
  await runDueJobs({ types: ['messages.dispatch'], now: () => new Date(Date.now() + 5 * 60_000) });
  assert.equal(outbound.length, 0, 'no duplicate messages');
  assert.equal(await MessageLog.countDocuments({ tenantId: A.tenantId, 'source.id': id, kind: 'marketing' } as any), 2);
});

test('"delivered" only comes from a signature-verified Twilio callback', async () => {
  const log: any = await MessageLog.findOne({ tenantId: A.tenantId, kind: 'marketing', status: 'sent' } as any).lean();
  const url = twilioStatusCallbackUrl(A.tenantId);
  const params = { MessageSid: log.providerMessageId, MessageStatus: 'delivered' };
  const bad = await request(app).post(`/api/webhooks/twilio/${A.tenantId}`).type('form').set('X-Twilio-Signature', 'forged').send(params);
  assert.equal(bad.status, 403);
  assert.equal(((await MessageLog.findOne({ tenantId: tA(), _id: log._id } as any).lean()) as any).status, 'sent');
  const ok = await request(app).post(`/api/webhooks/twilio/${A.tenantId}`).type('form').set('X-Twilio-Signature', twilioSignature(TOKEN, url, params)).send(params);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(((await MessageLog.findOne({ tenantId: tA(), _id: log._id } as any).lean()) as any).status, 'delivered');
  // Another tenant's URL cannot touch tenant A messages.
  const cross = await request(app).post(`/api/webhooks/twilio/${B.tenantId}`).type('form').set('X-Twilio-Signature', twilioSignature(TOKEN, twilioStatusCallbackUrl(B.tenantId), params)).send(params);
  assert.equal(cross.status, 400, 'tenant B has no Twilio configured');
});

test('campaign coupon is personal and restricted to its category; validated on the server', async () => {
  // Bilal did not receive it.
  const stranger = await order(A, '+923001110002', 'Bilal', false, { couponCode: s.code });
  assert.equal(stranger.status, 400);
  assert.match(stranger.body.error.message, /personal/);
  // Ayesha: the discount applies to drinks only (10% of 200.00 = 20.00), not to the burger.
  const r = await request(app).post('/api/public/orders').set('Host', A.host).send({ type: 'takeaway', customer: { name: 'Ayesha', phone: '+923001110001' }, couponCode: s.code, items: [{ productId: s.burger, quantity: 1 }, { productId: s.cola, quantity: 1 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.order.couponDiscount ?? r.body.order.discount, 20_00);
  await Order.collection.updateOne({ _id: new Types.ObjectId(r.body.order._id) }, { $set: { status: 'completed' } });
  const rep = await request(app).get(`/api/staff/marketing/campaigns/${s.campaign}/report`).set(auth(A.token));
  assert.equal(rep.body.verified.couponRedemptions, 1);
  assert.equal(rep.body.messages.deliveredConfirmed, 1);
  assert.equal(rep.body.clicks.tracked, false);
  assert.match(rep.body.estimated.basis, /not proof/);
});

test('frequency cap, unsubscribe link and suppression stop messages at send time', async () => {
  // Second campaign within the min-hours window: frequency limit applies (minHoursBetween 1).
  const c2 = await request(app).post('/api/staff/marketing/campaigns').set(auth(A.token)).send({ name: 'Again', channel: 'sms', segments: [], body: 'Hello {{name}} again' });
  const id = c2.body._id;
  for (const a of ['submit', 'approve', 'schedule']) await request(app).post(`/api/staff/marketing/campaigns/${id}/${a}`).set(auth(A.token)).send({}).expect(200);
  // Sana unsubscribes through the link in her message before it is sent.
  const bad = await request(app).post('/api/public/unsubscribe').set('Host', A.host).send({ c: s.sana, t: 'x'.repeat(20) });
  assert.equal(bad.status, 400);
  await runDueJobs({ types: ['campaign.start'] });
  const un = await request(app).post('/api/public/unsubscribe').set('Host', A.host).send({ c: s.sana, t: unsubscribeToken(A.tenantId, s.sana) });
  assert.equal(un.status, 200);
  outbound = [];
  await runDueJobs({ types: ['messages.dispatch'], now: () => new Date(Date.now() + 15 * 60_000) });
  assert.equal(outbound.length, 0, JSON.stringify(outbound));
  const logs = await MessageLog.find({ tenantId: A.tenantId, 'source.id': id } as any).lean();
  const reasons = logs.map((l: any) => l.skipReason).join(' | ');
  assert.match(reasons, /unsubscribed/);
  assert.match(reasons, /frequency limit/);
  const sana: any = await Customer.findOne({ tenantId: tA(), _id: s.sana } as any).lean();
  assert.equal(sana.consent.sms.granted, false);
  const sup = await request(app).get('/api/staff/marketing/suppressions').set(auth(A.token));
  assert.ok(sup.body.items.some((x: any) => x.address === '+923001110003'));
});

test('transient provider errors retry with backoff; permanent errors fail; nothing is marked sent', async () => {
  await Customer.updateOne({ tenantId: tA(), _id: s.ayesha }, { $set: { 'consent.sms.granted': true } });
  await MessageLog.updateMany({ tenantId: A.tenantId } as any, { $set: { sentAt: new Date(Date.now() - 30 * DAY) } }); // clear the frequency window
  const c = await request(app).post('/api/staff/marketing/campaigns').set(auth(A.token)).send({ name: 'Retry', channel: 'sms', segments: [], body: 'Retry test {{name}}' });
  const id = c.body._id;
  for (const a of ['submit', 'approve', 'schedule']) await request(app).post(`/api/staff/marketing/campaigns/${id}/${a}`).set(auth(A.token)).send({}).expect(200);
  await runDueJobs({ types: ['campaign.start'] });
  failMode = 'transient';
  await runDueJobs({ types: ['messages.dispatch'], now: () => new Date(Date.now() + 15 * 60_000) });
  let log: any = await MessageLog.findOne({ tenantId: A.tenantId, 'source.id': id } as any).lean();
  assert.equal(log.status, 'queued');
  assert.ok(log.nextAttemptAt > new Date());
  assert.equal(log.attempts, 1);
  failMode = 'permanent';
  await MessageLog.updateOne({ tenantId: tA(), _id: log._id }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
  const { dispatchMessages } = await import('../../src/services/marketing');
  await dispatchMessages({ _id: new Types.ObjectId(A.tenantId), settings: (await Tenant.findById(A.tenantId).lean())!.settings } as any);
  log = await MessageLog.findOne({ tenantId: tA(), _id: log._id } as any).lean();
  assert.equal(log.status, 'failed');
  assert.match(log.error, /invalid number/);
});

test('an interrupted send is marked unknown, never re-sent', async () => {
  const doc = await MessageLog.create({ tenantId: A.tenantId, dedupeKey: 'crash-1', source: { type: 'test', id: 'x' }, kind: 'test', channel: 'sms', to: '+923000000000', body: 'x', status: 'sending', sendingSince: new Date(Date.now() - 20 * 60_000) });
  const { dispatchMessages } = await import('../../src/services/marketing');
  outbound = [];
  await dispatchMessages({ _id: new Types.ObjectId(A.tenantId), settings: (await Tenant.findById(A.tenantId).lean())!.settings } as any);
  assert.equal(((await MessageLog.findOne({ tenantId: tA(), _id: doc._id } as any).lean()) as any).status, 'unknown');
  assert.equal(outbound.length, 0);
});

test('budget limit pauses a campaign instead of overspending', async () => {
  await request(app).patch('/api/staff/marketing/channels').set(auth(A.token)).send({ costs: { sms: 5_00 } }).expect(200);
  await MessageLog.updateMany({ tenantId: A.tenantId } as any, { $set: { sentAt: new Date(Date.now() - 30 * DAY) } });
  await Customer.updateOne({ tenantId: tA(), _id: s.sana }, { $set: { 'consent.sms.granted': true, 'consent.sms.revokedAt': null } });
  await request(app).delete(`/api/staff/marketing/suppressions/${(await request(app).get('/api/staff/marketing/suppressions').set(auth(A.token))).body.items[0]._id}`).set(auth(A.token)).expect(200);
  const c = await request(app).post('/api/staff/marketing/campaigns').set(auth(A.token)).send({ name: 'Budget', channel: 'sms', segments: [], body: 'Budget {{name}}', budget: { limit: 5_00 } });
  const id = c.body._id;
  for (const a of ['submit', 'approve', 'schedule']) await request(app).post(`/api/staff/marketing/campaigns/${id}/${a}`).set(auth(A.token)).send({}).expect(200);
  await runDueJobs({ types: ['campaign.start'] });
  outbound = [];
  await runDueJobs({ types: ['messages.dispatch'], now: () => new Date(Date.now() + 15 * 60_000) });
  const camp: any = await Campaign.findOne({ tenantId: tA(), _id: id } as any).lean();
  assert.equal(camp.status, 'paused');
  assert.match(camp.pauseReason, /Budget/);
  assert.equal(camp.budget.spent, 5_00);
  assert.equal(outbound.length, 1);
});

test('quiet hours defer sending to the end of the window', () => {
  const at = new Date('2026-11-10T22:30:00Z');
  const until = quietUntil('UTC', '21:00', '09:00', at);
  assert.ok(until && until.getUTCHours() === 9, String(until));
  assert.equal(quietUntil('UTC', '21:00', '09:00', new Date('2026-11-10T12:00:00Z')), null);
});

test('journeys need approval and a provider; editing returns them to draft', async () => {
  const j = await request(app).post('/api/staff/marketing/journeys').set(auth(s.manager)).send({ name: 'Win back', trigger: 'inactive', config: { days: 30 }, channel: 'email', body: 'We miss you {{name}}' });
  assert.equal(j.status, 201);
  assert.equal((await request(app).post(`/api/staff/marketing/journeys/${j.body._id}/activate`).set(auth(s.manager))).status, 403);
  const noEmail = await request(app).post(`/api/staff/marketing/journeys/${j.body._id}/activate`).set(auth(A.token));
  assert.equal(noEmail.status, 400, 'no email provider configured');
  const sms = await request(app).patch(`/api/staff/marketing/journeys/${j.body._id}`).set(auth(A.token)).send({ channel: 'sms' });
  assert.equal(sms.body.status, 'draft');
  const act = await request(app).post(`/api/staff/marketing/journeys/${j.body._id}/activate`).set(auth(A.token));
  assert.equal(act.status, 200);
  assert.equal(act.body.status, 'active');
  // Make Ayesha inactive for 40 days, then evaluate twice: queued once only.
  await Order.collection.updateMany({ tenantId: new Types.ObjectId(A.tenantId) }, { $set: { createdAt: new Date(Date.now() - 40 * DAY) } });
  const { evaluateJourneys } = await import('../../src/services/marketing');
  const t = { _id: new Types.ObjectId(A.tenantId), settings: (await Tenant.findById(A.tenantId).lean())!.settings } as any;
  const r1 = await evaluateJourneys(t);
  const r2 = await evaluateJourneys(t);
  assert.ok(r1.queued >= 1, JSON.stringify(r1));
  assert.equal(r2.queued, 0, 'same inactive spell is not messaged twice');
});

test('tenant isolation for campaigns and customers', async () => {
  assert.equal((await request(app).get(`/api/staff/marketing/campaigns/${s.campaign}`).set(auth(B.token))).status, 404);
  assert.equal((await request(app).get(`/api/staff/marketing/customers/${s.ayesha}`).set(auth(B.token))).status, 404);
  assert.equal((await request(app).post(`/api/staff/marketing/campaigns/${s.campaign}/cancel`).set(auth(B.token)).send({})).status, 404);
  const list = await request(app).get('/api/staff/marketing/customers').set(auth(B.token));
  assert.equal(list.body.total, 0);
  // Unsubscribe token from tenant A does not work on tenant B's host.
  assert.equal((await request(app).post('/api/public/unsubscribe').set('Host', B.host).send({ c: s.ayesha, t: unsubscribeToken(A.tenantId, s.ayesha) })).status, 400);
  invalidateTenantCache(A.slug);
});
