import { env } from './config/env';
import { Tenant } from './models/platform';

/**
 * Allows the configured client origin(s), the root domain and any tenant subdomain of it, and any
 * custom domain a super admin has assigned to an ACTIVE tenant (looked up in the DB, cached briefly).
 */
const extraOrigins = new Set<string>(env.CLIENT_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean));
const domainCache = new Map<string, { at: number; ok: boolean }>();
const DOMAIN_TTL = 60_000;

/** Synchronous rules only: configured origins, root domain and its direct subdomains. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin / curl / server-to-server
  if (extraOrigins.has(origin)) return true;
  try {
    const u = new URL(origin);
    const root = env.ROOT_DOMAIN.toLowerCase();
    const host = u.hostname.toLowerCase();
    return host === root || host.endsWith(`.${root}`);
  } catch {
    return false;
  }
}

/** Is this origin the custom domain of an active tenant? */
export async function isTenantCustomDomain(origin: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const hit = domainCache.get(host);
  if (hit && Date.now() - hit.at < DOMAIN_TTL) return hit.ok;
  const ok = !!(await Tenant.exists({ customDomain: host, status: 'active' }).catch(() => null));
  domainCache.set(host, { at: Date.now(), ok });
  return ok;
}

export function invalidateCustomDomainCache() {
  domainCache.clear();
}

export function corsOriginCheck(origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) {
  if (isAllowedOrigin(origin)) return cb(null, true);
  isTenantCustomDomain(origin!)
    .then((ok) => cb(null, ok))
    .catch(() => cb(null, false));
}
