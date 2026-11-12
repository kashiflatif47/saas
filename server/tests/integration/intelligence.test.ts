/**
 * AI intelligence, forecasting, recommendations, assistant (stubbed provider) and the persistent job queue.
 * In-memory MongoDB only.
 */
import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb, PW } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../src/app';
import { Order } from '../../src/models/operations';
import { Job, Recommendation } from '../../src/models/growth';
import { setAiProvider, type AiProvider } from '../../src/services/ai';
import { enqueueJob, registerJob, runDueJobs } from '../../src/jobs/queue';
import { registerAllJobs, scheduleRecurring } from '../../src/jobs/handlers';
import { backtest, confidenceFrom, predictDay, trendFactor } from '../../src/services/forecast';

let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let A: Awaited<ReturnType<typeof provisionTenant>>;
let B: Awaited<ReturnType<typeof provisionTenant>>;
const s: any = {};
const DAY = 86400_000;

async function staffToken(T: typeof A, role: string, email: string) {
  const r = await request(app).post('/api/staff/staff').set(auth(T.token)).send({ name: `${role} user`, email, password: PW, role });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const l = await request(app).post('/api/auth/login').set('Host', T.host).send({ email, password: PW, tenantSlug: T.slug });
  return l.body.accessToken as string;
}

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  A = await provisionTenant(app, p.saToken, p.planId, 'intel-a');
  B = await provisionTenant(app, p.saToken, p.planId, 'intel-b');
  s.waiter = await staffToken(A, 'waiter', 'w@intel-a.test');
  s.manager = await staffToken(A, 'manager', 'm@intel-a.test');
  s.rider = await staffToken(A, 'rider', 'r@intel-a.test');

  const inv = await request(app).post('/api/staff/inventory/items').set(auth(A.token)).send({ name: 'Rice', unit: 'kg', lowStockThreshold: 1, openingQuantity: 3, costPerUnit: 200_00 });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  s.rice = inv.body._id;
  const cat = await request(app).post('/api/staff/menu/categories').set(auth(A.token)).send({ name: { en: 'Mains' } });
  const biryani = await request(app).post('/api/staff/menu/products').set(auth(A.token)).send({ categoryId: cat.body._id, name: { en: 'Biryani' }, price: 500_00, recipe: [{ inventoryItemId: s.rice, quantity: 0.5 }] });
  const tea = await request(app).post('/api/staff/menu/products').set(auth(A.token)).send({ categoryId: cat.body._id, name: { en: 'Tea' }, price: 100_00 });
  assert.equal(biryani.status, 201, JSON.stringify(biryani.body));
  s.biryani = biryani.body._id;
  s.tea = tea.body._id;
});

after(async () => {
  setAiProvider(undefined);
  await stopDb(mongod);
});

/** Places real orders through the POS API, then moves them into the past (completed). */
async function history(T: typeof A, days: number, perDay: (d: number) => number) {
  const now = Date.now();
  for (let d = days; d >= 1; d--) {
    for (let i = 0; i < perDay(d); i++) {
      const r = await request(app).post('/api/staff/orders').set(auth(T.token)).send({ type: 'takeaway', items: [{ productId: s.biryani, quantity: 1 }, { productId: s.tea, quantity: 1 }] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const at = new Date(now - d * DAY + i * 60_000);
      await Order.collection.updateOne({ _id: new Types.ObjectId(r.body.order?._id ?? r.body._id) }, { $set: { createdAt: at, acceptedAt: at, status: 'completed' } });
    }
  }
}

test('without enough history the forecast says so instead of inventing numbers', async () => {
  const r = await request(app).get('/api/staff/intelligence/forecast?horizon=7').set(auth(A.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sufficient, false);
  assert.match(r.body.reason, /No sales history|needs at least/);
  assert.equal(r.body.sales, undefined, 'no fabricated sales figure');
});

test('overview separates revenue, food cost and gross profit and reports data quality', async () => {
  await history(A, 21, (d) => (d % 7 === 0 ? 3 : 2));
  const r = await request(app).get('/api/staff/intelligence/overview?period=month').set(auth(A.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = r.body.money;
  assert.ok(m.netItemRevenue > 0);
  assert.equal(typeof m.foodCost, 'number');
  // Tea has no recipe, so profit covers only part of revenue and must say so.
  assert.ok(r.body.dataQuality);
  assert.notEqual(m.grossProfit, m.netItemRevenue, 'revenue is not presented as profit');
  assert.ok(m.profitBasis && /food cost|recipe/i.test(m.profitBasis));
});

test('a 7-day forecast has values, an 80% range, confidence, coverage, factors and a timestamp', async () => {
  const r = await request(app).get('/api/staff/intelligence/forecast?horizon=7&refresh=true').set(auth(A.token));
  assert.equal(r.status, 200);
  assert.equal(r.body.sufficient, true, JSON.stringify(r.body.reason));
  assert.equal(r.body.sales.days.length, 7);
  const t = r.body.sales.total;
  assert.ok(t.low <= t.predicted && t.predicted <= t.high);
  assert.ok(['low', 'medium', 'high'].includes(r.body.accuracy.confidence));
  assert.ok(r.body.coverage.historyDays >= 14);
  assert.ok(Array.isArray(r.body.factors));
  assert.ok(r.body.generatedAt);
  assert.match(r.body.externalFactors, /not included/);
  // 90-day horizon needs 56 days of history: refused honestly.
  const long = await request(app).get('/api/staff/intelligence/forecast?horizon=90').set(auth(A.token));
  assert.equal(long.body.sufficient, false);
  // Unsupported horizons are rejected.
  assert.equal((await request(app).get('/api/staff/intelligence/forecast?horizon=5').set(auth(A.token))).status, 400);
});

test('forecast maths is deterministic', () => {
  const series = Array.from({ length: 28 }, (_, i) => ({ key: `2026-10-${String(i + 1).padStart(2, '0')}`, value: 10 + (i % 7) }));
  assert.equal(trendFactor(series), trendFactor(series));
  const p1 = predictDay(series, '2026-10-29', 1);
  const p2 = predictDay(series, '2026-10-29', 1);
  assert.deepEqual(p1, p2);
  assert.ok(p1!.low <= p1!.predicted && p1!.predicted <= p1!.high);
  assert.deepEqual(backtest(series), backtest(series));
  assert.equal(confidenceFrom(null, 10), 'low');
});

test('intelligence is permission-gated and tenant-isolated', async () => {
  assert.equal((await request(app).get('/api/staff/intelligence/overview').set(auth(s.waiter))).status, 403);
  assert.equal((await request(app).get('/api/staff/intelligence/forecast').set(auth(s.rider))).status, 403);
  assert.equal((await request(app).get('/api/staff/intelligence/overview').set(auth(s.manager))).status, 200);
  const other = await request(app).get('/api/staff/intelligence/overview?period=month').set(auth(B.token));
  assert.equal(other.status, 200);
  assert.equal(other.body.orders.count, 0, 'tenant B sees none of tenant A orders');
});

test('recommendations are generated from data, decided once, and never duplicated', async () => {
  const r1 = await request(app).post('/api/staff/intelligence/recommendations/refresh').set(auth(A.token));
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await request(app).post('/api/staff/intelligence/recommendations/refresh').set(auth(A.token));
  assert.equal(r2.status, 200);
  const list = await request(app).get('/api/staff/intelligence/recommendations').set(auth(A.token));
  const keys = list.body.items.map((x: any) => x.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate recommendations');
  for (const rec of list.body.items) {
    for (const f of ['title', 'explanation', 'priority', 'confidence', 'action']) assert.ok(rec[f] != null, `recommendation has ${f}`);
  }
  // Rice: 3 kg on hand, 0.5 kg per biryani, ~2 a day -> runs out within the reorder lead time.
  assert.ok(list.body.items.some((x: any) => x.rule === 'ingredient_runout'), JSON.stringify(list.body.items.map((x: any) => x.rule)));
  const id = list.body.items[0]._id;
  assert.equal((await request(app).post(`/api/staff/intelligence/recommendations/${id}/decision`).set(auth(s.waiter)).send({ decision: 'accepted' })).status, 403);
  const d = await request(app).post(`/api/staff/intelligence/recommendations/${id}/decision`).set(auth(A.token)).send({ decision: 'accepted', note: 'ordered rice' });
  assert.equal(d.status, 200);
  assert.equal(d.body.status, 'accepted');
  assert.equal((await request(app).post(`/api/staff/intelligence/recommendations/${id}/decision`).set(auth(A.token)).send({ decision: 'rejected' })).status, 400);
  // Other tenant cannot decide it.
  assert.equal((await request(app).post(`/api/staff/intelligence/recommendations/${id}/decision`).set(auth(B.token)).send({ decision: 'dismissed' })).status, 400);
  assert.equal(await Recommendation.countDocuments({ tenantId: B.tenantId } as any), 0);
});

test('assistant without an AI provider answers from built-in reports', async () => {
  setAiProvider(null);
  const st = await request(app).get('/api/staff/intelligence/ai-status').set(auth(A.token));
  assert.equal(st.body.configured, false);
  const r = await request(app).post('/api/staff/intelligence/assistant').set(auth(A.token)).send({ question: 'What are my best selling dishes this week?' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'built-in');
  assert.match(r.body.answer, /Biryani/);
  assert.match(r.body.notice, /not configured/);
});

test('assistant with a (stub) AI provider runs read-only tools scoped to the user and tenant', async () => {
  const calls: any[] = [];
  const stub: AiProvider = {
    name: 'stub',
    async createMessage(params: any) {
      calls.push(params);
      if (calls.length === 1) {
        return { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'sales_summary', input: { period: 'month' } }], usage: { input_tokens: 100, output_tokens: 20 } } as any;
      }
      const last = params.messages[params.messages.length - 1];
      const result = JSON.parse(last.content[0].content);
      return { id: 'm2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: `You had ${result.orders} orders.` }], usage: { input_tokens: 200, output_tokens: 30 } } as any;
    },
  };
  setAiProvider(stub);
  const r = await request(app).post('/api/staff/intelligence/assistant').set(auth(A.token)).send({ question: 'How many orders this month?' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'ai');
  assert.match(r.body.answer, /You had \d+ orders/);
  assert.ok(Number(r.body.answer.match(/\d+/)[0]) >= 42, 'the number came from the tenant data');
  assert.deepEqual(r.body.toolsUsed.map((t: any) => t.name), ['sales_summary']);
  // Tools offered to a manager do not include anything outside their permissions; no write tools exist at all.
  const names = calls[0].tools.map((t: any) => t.name);
  assert.ok(!names.some((n: string) => /^(update|create|delete|set|place|send)_/.test(n)));
  assert.equal(calls[0].model, 'claude-opus-5-5');
  const usage = await request(app).get('/api/staff/intelligence/ai-usage').set(auth(A.token));
  assert.ok(usage.body.last30Days.calls >= 2);
  assert.ok(usage.body.last30Days.estimatedCostUsd > 0);

  // Tenant B's assistant never sees tenant A data.
  calls.length = 0;
  const rb = await request(app).post('/api/staff/intelligence/assistant').set(auth(B.token)).send({ question: 'How many orders this month?' });
  assert.match(rb.body.answer, /You had 0 orders/);
});

test('a failing AI provider falls back to the built-in answer and records the failure', async () => {
  setAiProvider({ name: 'stub', async createMessage() { throw new Error('boom'); } });
  const r = await request(app).post('/api/staff/intelligence/assistant').set(auth(A.token)).send({ question: 'best selling dishes this week' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'built-in');
  assert.match(r.body.notice, /failed/);
  setAiProvider(null);
});

test('AI marketing copy is a draft and is unavailable without a provider', async () => {
  setAiProvider(null);
  const r = await request(app).post('/api/staff/marketing/copy').set(auth(A.token)).send({ goal: 'bring back lapsed customers', channel: 'sms' });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, false);
  setAiProvider({ name: 'stub', async createMessage() { return { id: 'x', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi {{name}}, we miss you!' }], usage: { input_tokens: 10, output_tokens: 5 } } as any; } });
  const d = await request(app).post('/api/staff/marketing/copy').set(auth(A.token)).send({ goal: 'bring back lapsed customers', channel: 'sms' });
  assert.equal(d.body.aiGenerated, true);
  assert.match(d.body.note, /approves/);
  setAiProvider(null);
});

/* ---------------------------- persistent jobs ---------------------------- */
test('jobs: unique keys prevent duplicates, retries back off, and failures stop at maxAttempts', async () => {
  let runs = 0;
  registerJob('test.flaky', async () => {
    runs++;
    if (runs < 2) throw new Error('transient');
    return { ok: true };
  });
  await enqueueJob({ type: 'test.flaky', key: 'flaky-1', maxAttempts: 3 });
  await enqueueJob({ type: 'test.flaky', key: 'flaky-1', maxAttempts: 3 });
  assert.equal(await Job.countDocuments({ key: 'flaky-1' } as any), 1);
  await runDueJobs({ types: ['test.flaky'] });
  let j: any = await Job.findOne({ key: 'flaky-1' } as any).lean();
  assert.equal(j.status, 'queued');
  assert.equal(j.attempts, 1);
  assert.ok(j.runAt.getTime() > Date.now(), 'backed off into the future');
  await runDueJobs({ types: ['test.flaky'], now: () => new Date(Date.now() + 3600_000) });
  j = await Job.findOne({ key: 'flaky-1' } as any).lean();
  assert.equal(j.status, 'done');

  registerJob('test.broken', async () => { throw new Error('always'); });
  await enqueueJob({ type: 'test.broken', key: 'broken-1', maxAttempts: 2 });
  await runDueJobs({ types: ['test.broken'] });
  await runDueJobs({ types: ['test.broken'], now: () => new Date(Date.now() + 3600_000) });
  j = await Job.findOne({ key: 'broken-1' } as any).lean();
  assert.equal(j.status, 'failed');
  assert.match(j.lastError, /always/);
});

test('jobs: a crashed worker lease is recovered, and concurrent workers run a job once', async () => {
  let n = 0;
  registerJob('test.once', async () => { n++; return { n }; });
  await enqueueJob({ type: 'test.once', key: 'once-1' });
  // Simulate a worker that died while holding the job.
  await Job.updateOne({ key: 'once-1' } as any, { $set: { status: 'running', lockedBy: 'dead-worker', lockedUntil: new Date(Date.now() - 1000) } });
  await Promise.all([runDueJobs({ types: ['test.once'] }), runDueJobs({ types: ['test.once'] }), runDueJobs({ types: ['test.once'] })]);
  assert.equal(n, 1, 'ran exactly once after lease expiry');
  assert.equal(((await Job.findOne({ key: 'once-1' } as any).lean()) as any).status, 'done');
});

test('recurring scheduler is idempotent per tenant and day (restart-safe)', async () => {
  registerAllJobs();
  const at = new Date('2026-11-10T10:00:00Z');
  await scheduleRecurring(at);
  const before = await Job.countDocuments({});
  await scheduleRecurring(at); // a restart / second instance in the same window
  assert.equal(await Job.countDocuments({}), before);
  const forecastJobs = await Job.find({ type: 'forecast.refresh' } as any).lean();
  assert.equal(new Set(forecastJobs.map((x: any) => String(x.tenantId))).size, forecastJobs.length, 'one forecast job per tenant');
  const r = await runDueJobs({ types: ['forecast.refresh', 'segments.recalculate'], max: 20 });
  assert.ok(r);
  const done = await Job.find({ type: { $in: ['forecast.refresh', 'segments.recalculate'] } } as any).lean();
  assert.ok(done.every((x: any) => x.status === 'done'), JSON.stringify(done.map((x: any) => [x.type, x.status, x.lastError])));
});

test('tenant job monitor shows only that tenant’s jobs', async () => {
  const a = await request(app).get('/api/staff/intelligence/jobs').set(auth(A.token));
  assert.equal(a.status, 200);
  assert.ok(a.body.items.every((x: any) => !x.payload));
  const b = await request(app).get('/api/staff/intelligence/jobs').set(auth(B.token));
  const aIds = new Set(a.body.items.map((x: any) => x._id));
  assert.ok(b.body.items.every((x: any) => !aIds.has(x._id)));
});
