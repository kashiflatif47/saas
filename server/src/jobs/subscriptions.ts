import { Tenant } from '../models/platform';
import { GRACE_DAYS, invalidateTenantCache } from '../services/tenantResolver';
import { emit } from '../sockets';

/**
 * Moves expired trials to `expired` and lapsed paid periods to `past_due`, then to `expired`
 * after a GRACE_DAYS grace period. Idempotent; safe to run on every instance (updates are conditional).
 */
export async function runSubscriptionSweep(now = new Date()) {
  const grace = new Date(now.getTime() - GRACE_DAYS * 86400_000);
  const trials = await Tenant.updateMany({ 'subscription.status': 'trial', 'subscription.trialEndsAt': { $lt: now } }, { $set: { 'subscription.status': 'expired' } });
  const pastDue = await Tenant.updateMany({ 'subscription.status': 'active', 'subscription.currentPeriodEnd': { $lt: now, $gte: grace } }, { $set: { 'subscription.status': 'past_due' } });
  const expired = await Tenant.updateMany({ 'subscription.status': { $in: ['active', 'past_due'] }, 'subscription.currentPeriodEnd': { $lt: grace } }, { $set: { 'subscription.status': 'expired' } });
  const changed = trials.modifiedCount + pastDue.modifiedCount + expired.modifiedCount;
  if (changed) {
    invalidateTenantCache();
    emit.platform('subscriptions:swept', { trials: trials.modifiedCount, pastDue: pastDue.modifiedCount, expired: expired.modifiedCount });
  }
  return { trials: trials.modifiedCount, pastDue: pastDue.modifiedCount, expired: expired.modifiedCount };
}

export function startSubscriptionJob() {
  const tick = () => runSubscriptionSweep().catch((e) => console.error('[JOB] subscription sweep failed', e));
  setTimeout(tick, 10_000);
  return setInterval(tick, 60 * 60_000);
}
