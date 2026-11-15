import { Tenant } from '../models/platform';
import { Job, AiUsage, MessageLog } from '../models/growth';
import { runCrossTenant } from '../models/tenantScope';
import { resolveTenantById } from '../services/tenantResolver';
import { registerJob, enqueueJob } from './queue';
import { getForecast } from '../services/forecast';
import { recalculateSegments } from '../services/segments';
import { evaluateOutcomes, refreshRecommendations } from '../services/recommendations';
import { dispatchMessages, evaluateJourneys, scheduleDispatch, startCampaign } from '../services/marketing';
import { checkDelays, handleAcceptTimeout } from '../services/delivery';

/** Loads the job's tenant; jobs of deleted or suspended restaurants do nothing. */
async function tenantOf(job: { tenantId?: any }) {
  if (!job.tenantId) throw new Error('Job has no tenant');
  const t = await resolveTenantById(String(job.tenantId));
  return t && t.status === 'active' ? t : null;
}

export function registerAllJobs() {
  registerJob('campaign.start', async (j) => { const t = await tenantOf(j); return t ? startCampaign(t, j.payload.campaignId) : { skipped: 'tenant inactive' }; });
  registerJob('messages.dispatch', async (j) => { const t = await tenantOf(j); return t ? dispatchMessages(t) : { skipped: 'tenant inactive' }; });
  registerJob('journeys.evaluate', async (j) => { const t = await tenantOf(j); return t ? evaluateJourneys(t) : { skipped: 'tenant inactive' }; });
  registerJob('segments.recalculate', async (j) => { const t = await tenantOf(j); return t ? recalculateSegments(t) : { skipped: 'tenant inactive' }; });
  registerJob('forecast.refresh', async (j) => {
    const t = await tenantOf(j);
    if (!t) return { skipped: 'tenant inactive' };
    const out: Record<string, unknown> = {};
    for (const h of [1, 7, 30, 90] as const) out[h] = ((await getForecast(t, h, { refresh: true })) as any).sufficient;
    return out;
  });
  registerJob('recommendations.refresh', async (j) => {
    const t = await tenantOf(j);
    if (!t) return { skipped: 'tenant inactive' };
    return { ...(await refreshRecommendations(t)), ...(await evaluateOutcomes(t)) };
  });
  registerJob('delivery.acceptTimeout', async (j) => { const t = await tenantOf(j); return t ? handleAcceptTimeout(t, j.payload) : { skipped: 'tenant inactive' }; });
  registerJob('delivery.delays', async (j) => { const t = await tenantOf(j); return t ? checkDelays(t) : { skipped: 'tenant inactive' }; });
  // Retention: finished jobs after 30 days, message logs after 180 days, AI usage after 365 days.
  registerJob('cleanup', async () =>
    runCrossTenant(async () => ({
      jobs: (await Job.deleteMany({ status: { $in: ['done', 'cancelled'] }, finishedAt: { $lt: new Date(Date.now() - 30 * 86400_000) } })).deletedCount,
      messages: (await MessageLog.deleteMany({ createdAt: { $lt: new Date(Date.now() - 180 * 86400_000) } })).deletedCount,
      aiUsage: (await AiUsage.deleteMany({ createdAt: { $lt: new Date(Date.now() - 365 * 86400_000) } })).deletedCount,
    })),
  );
}

function local(tz: string, d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

/**
 * Recurring work, enqueued with idempotent keys (several server instances or restarts cannot duplicate it):
 * daily segments → forecasts → recommendations (from 02:00 local), hourly journeys, delivery delay checks
 * every 2 minutes, and a daily cleanup.
 */
export async function scheduleRecurring(now = new Date()) {
  const tenants = await Tenant.find({ status: 'active' }).select('_id settings.timezone').lean();
  for (const t of tenants) {
    const tz = (t.settings as any)?.timezone ?? 'UTC';
    let l;
    try {
      l = local(tz, now);
    } catch {
      l = local('UTC', now);
    }
    const id = String(t._id);
    if (l.hour >= 2) {
      await enqueueJob({ type: 'segments.recalculate', tenantId: t._id, key: `segments:${id}:${l.date}` });
      await enqueueJob({ type: 'forecast.refresh', tenantId: t._id, key: `forecast:${id}:${l.date}` });
      await enqueueJob({ type: 'recommendations.refresh', tenantId: t._id, key: `recs:${id}:${l.date}`, runAt: new Date(now.getTime() + 5 * 60_000) });
    }
    await enqueueJob({ type: 'journeys.evaluate', tenantId: t._id, key: `journeys:${id}:${l.date}T${l.hour}` });
    await enqueueJob({ type: 'delivery.delays', tenantId: t._id, key: `delays:${id}:${Math.floor(now.getTime() / 120_000)}`, maxAttempts: 1 });
  }
  // Safety net: any tenant with due queued messages gets a dispatch (covers lost or failed dispatch jobs).
  const due = await runCrossTenant(() => MessageLog.distinct('tenantId', { status: 'queued', $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] }).exec());
  for (const tid of due) await scheduleDispatch(tid as any, now);
  await enqueueJob({ type: 'cleanup', key: `cleanup:${now.toISOString().slice(0, 10)}` });
}
