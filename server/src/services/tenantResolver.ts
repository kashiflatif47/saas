import { Tenant, Plan } from '../models/platform';
import type { ResolvedTenant } from '../types/express';
import { safeTimeZone } from '../lib/timezone';

/**
 * Small in-process cache for host -> tenant lookups. Entries expire after 30s and are
 * invalidated on any tenant update, so suspensions take effect quickly.
 * For multiple API instances, swap this for Redis (documented in docs/DEPLOYMENT.md).
 */
const cache = new Map<string, { at: number; value: ResolvedTenant | null }>();
const TTL = 30_000;

export function invalidateTenantCache(slug?: string) {
  if (slug) {
    cache.delete(`slug:${slug}`);
    // Custom-domain entries are keyed by domain; drop any that point at this tenant.
    for (const [k, v] of cache) if (k.startsWith('domain:') && v.value?.slug === slug) cache.delete(k);
  } else cache.clear();
}

export async function computeFeatures(sub: any): Promise<Set<string>> {
  const set = new Set<string>();
  if (sub?.planId) {
    const plan = await Plan.findById(sub.planId).lean();
    plan?.features?.forEach((f) => set.add(f));
  }
  sub?.featureOverrides?.grant?.forEach((f: string) => set.add(f));
  sub?.featureOverrides?.revoke?.forEach((f: string) => set.delete(f));
  return set;
}

async function load(filter: Record<string, unknown>): Promise<ResolvedTenant | null> {
  const t = await Tenant.findOne(filter).lean();
  if (!t) return null;
  return {
    _id: t._id,
    id: String(t._id),
    slug: t.slug,
    name: t.name,
    status: t.status,
    // A timezone saved before validation existed must not crash menus, dashboards or reports.
    settings: t.settings ? { ...t.settings, timezone: safeTimeZone(t.settings.timezone) } : t.settings,
    subscription: t.subscription,
    features: await computeFeatures(t.subscription),
  };
}

export async function resolveTenantBySlug(slug: string): Promise<ResolvedTenant | null> {
  const key = `slug:${slug}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await load({ slug });
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function resolveTenantById(id: string): Promise<ResolvedTenant | null> {
  return load({ _id: id });
}

export async function resolveTenantByDomain(domain: string): Promise<ResolvedTenant | null> {
  const key = `domain:${domain}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await load({ customDomain: domain });
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Days a lapsed paid subscription keeps operating (as past_due) before it expires. Shared with the sweep job. */
export const GRACE_DAYS = 7;

/**
 * A tenant may operate when not suspended and its subscription is active, in trial, or in the
 * past-due grace window. An `active` subscription whose period ended within the grace window is
 * treated exactly like `past_due`, so access does not flap between the period end and the next sweep.
 */
export function subscriptionAllowsOperation(t: Pick<ResolvedTenant, 'status' | 'subscription'>, now = new Date()): boolean {
  if (t.status !== 'active') return false;
  const s = t.subscription ?? {};
  if (s.status === 'active') return !s.currentPeriodEnd || new Date(s.currentPeriodEnd).getTime() + GRACE_DAYS * 86400_000 > now.getTime();
  if (s.status === 'trial') return !s.trialEndsAt || new Date(s.trialEndsAt) > now;
  if (s.status === 'past_due') return !s.currentPeriodEnd || new Date(s.currentPeriodEnd).getTime() + GRACE_DAYS * 86400_000 > now.getTime();
  return false;
}
