/** Reserved subdomains that can never be assigned to a tenant. */
export const RESERVED_SLUGS = new Set([
  'www', 'api', 'admin', 'app', 'static', 'cdn', 'assets', 'mail', 'smtp', 'ftp',
  'dashboard', 'superadmin', 'status', 'docs', 'help', 'support', 'billing', 'ws', 'socket',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug) && !slug.includes('--');
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * Validates a tenant slug taken from a URL PATH (`/r/<slug>`, `/api/public/tenants/<slug>`).
 * Accepts only lowercase slug syntax (never a hostname, dots, percent-escapes or reserved words), so the
 * value is safe to use as a DB lookup key and inside a cookie path. Selecting a tenant this way only ever
 * grants PUBLIC storefront context; staff authorization always comes from the verified JWT.
 */
export function isPathSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

/** `/r/pizza/dashboard` -> `pizza`; anything else (including `/r/Pizza.com`) -> null. */
export function tenantSlugFromPath(pathname: string | undefined): string | null {
  const m = /^\/r\/([^/?#]+)(?:[/?#]|$)/.exec(pathname ?? '');
  return m && isPathSlug(m[1]) ? m[1] : null;
}

/**
 * Extracts the tenant slug from a Host header.
 * `pizza.example.com` with root `example.com` -> `pizza`
 * `example.com`, `www.example.com`, foreign hosts, nested subdomains -> null
 * Works with `localhost` roots for development (`pizza.localhost:5173`).
 */
export function tenantSlugFromHost(hostHeader: string | undefined, rootDomain: string): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.toLowerCase().trim().replace(/:\d+$/, '').replace(/\.$/, '');
  const root = rootDomain.toLowerCase().replace(/:\d+$/, '');
  if (host === root) return null;
  if (!host.endsWith(`.${root}`)) return null;
  const sub = host.slice(0, -(root.length + 1));
  if (!sub || sub.includes('.')) return null;
  if (RESERVED_SLUGS.has(sub)) return null;
  return SLUG_RE.test(sub) ? sub : null;
}
