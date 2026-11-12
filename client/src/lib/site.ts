/**
 * Pure site/tenant URL logic (no DOM, no import.meta), shared by the app and unit-tested from
 * server/tests/unit/clientSite.test.ts. The browser-bound wrappers live in lib/util.ts and api/client.ts.
 */

// Must match server/src/lib/subdomain.ts RESERVED_SLUGS and SLUG_RE.
export const RESERVED_SLUGS = new Set([
  'www', 'api', 'admin', 'app', 'static', 'cdn', 'assets', 'mail', 'smtp', 'ftp',
  'dashboard', 'superadmin', 'status', 'docs', 'help', 'support', 'billing', 'ws', 'socket',
]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export const isTenantSlug = (s: string) => SLUG_RE.test(s) && !RESERVED_SLUGS.has(s);

/** Restaurant slug from a restaurant SUBDOMAIN host (`pizza.example.com`), else null. */
export function slugFromHost(hostname: string, rootDomain: string): string | null {
  const host = hostname.toLowerCase();
  const root = rootDomain.toLowerCase();
  if (host === root || !host.endsWith(`.${root}`)) return null;
  const sub = host.slice(0, -(root.length + 1));
  if (!sub || sub.includes('.') || RESERVED_SLUGS.has(sub)) return null;
  return sub;
}

/**
 * True when the page is served from a tenant's own custom domain (e.g. menu.restaurant.com):
 * any host that is neither the platform root nor one of its subdomains, nor a local address.
 * Custom domains serve the customer storefront only; staff sign in on ROOT_DOMAIN/r/<slug>/login.
 */
export function isCustomDomain(hostname: string, rootDomain: string): boolean {
  const host = hostname.toLowerCase();
  const root = rootDomain.toLowerCase();
  if (host === root || host.endsWith(`.${root}`)) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return true;
}

/**
 * Which site a page belongs to. Decided once per page load from the URL:
 *  - `path`      ROOT_DOMAIN/r/<slug>/…   restaurant, React Router basename `/r/<slug>`
 *  - `subdomain` <slug>.ROOT_DOMAIN/…     restaurant (legacy/optional mode), no basename
 *  - `custom`    a restaurant's own domain: storefront only (tenant resolved by the API from the Host)
 *  - `invalid`   ROOT_DOMAIN/r/<not a valid slug>: "restaurant not found"
 *  - `platform`  everything else on the root domain (super admin console)
 * The slug is only ever taken from a validated `/r/<slug>` path segment or subdomain label, never from a
 * complete hostname. It selects PUBLIC restaurant context only: staff access is decided by the server from the
 * signed-in user's own restaurant.
 */
export type SiteContext =
  | { kind: 'platform'; slug: null; basename: '' }
  | { kind: 'path'; slug: string; basename: string }
  | { kind: 'subdomain'; slug: string; basename: '' }
  | { kind: 'custom'; slug: null; basename: '' }
  | { kind: 'invalid'; slug: null; basename: '' };

export function parseSiteContext(hostname: string, pathname: string, rootDomain: string): SiteContext {
  const sub = slugFromHost(hostname, rootDomain);
  if (sub) return { kind: 'subdomain', slug: sub, basename: '' };
  if (isCustomDomain(hostname, rootDomain)) return { kind: 'custom', slug: null, basename: '' };
  const m = /^\/r(?:\/([^/?#]*))?(?:[/?#]|$)/.exec(pathname);
  if (!m) return { kind: 'platform', slug: null, basename: '' };
  const seg = m[1] ?? '';
  if (!isTenantSlug(seg)) return { kind: 'invalid', slug: null, basename: '' };
  return { kind: 'path', slug: seg, basename: `/r/${seg}` };
}

/** `/r/Pizza/menu?x#y` -> `/r/pizza/menu?x#y`; null when nothing needs to change. */
export function lowercaseTenantPath(pathname: string, search = '', hash = ''): string | null {
  const m = /^\/r\/([^/?#]+)/.exec(pathname);
  if (!m || m[1] === m[1].toLowerCase() || !isTenantSlug(m[1].toLowerCase())) return null;
  return `/r/${m[1].toLowerCase()}${pathname.slice(m[0].length)}${search}${hash}`;
}

/** The pathname relative to the router basename (`/r/pizza/dashboard` -> `/dashboard`). */
export function stripBasename(pathname: string, basename: string): string {
  if (!basename) return pathname;
  if (pathname === basename) return '/';
  return pathname.startsWith(`${basename}/`) ? pathname.slice(basename.length) : pathname;
}

/** Absolute restaurant URL for links: `https://example.com/r/pizza/` or `https://pizza.example.com/`. */
export function buildTenantUrl(mode: 'path' | 'subdomain', protocol: string, rootDomain: string, port: string, slug: string, path = '/') {
  const p = port ? `:${port}` : '';
  return mode === 'subdomain' ? `${protocol}//${slug}.${rootDomain}${p}${path}` : `${protocol}//${rootDomain}${p}/r/${slug}${path}`;
}

/**
 * Public (customer) endpoints are written as `/api/public/<x>` everywhere in the app. On a path-based restaurant
 * page they go to `/api/public/tenants/<slug>/<x>`, where the API resolves the restaurant from the path
 * (all path-based restaurants share one host, so the Host header cannot identify them).
 */
export function publicApiPath(site: SiteContext, path: string): string {
  if (site.kind === 'path' && path.startsWith('/api/public/')) return `/api/public/tenants/${encodeURIComponent(site.slug)}/${path.slice('/api/public/'.length)}`;
  return path;
}

/**
 * Session endpoints for a site. A path-based restaurant has its own login/refresh/logout under
 * /api/auth/tenants/<slug>/, so its refresh cookie is scoped to that path and never collides with another
 * restaurant's (or the platform's) session on the same domain.
 */
export function authEndpointFor(site: SiteContext, action: 'login' | 'refresh' | 'logout'): string {
  return site.kind === 'path' ? `/api/auth/tenants/${encodeURIComponent(site.slug)}/${action}` : `/api/auth/${action}`;
}

/**
 * Offline session-cache slot for a site. Path-based restaurants share one origin, so each gets its own slot:
 * restaurant A's cached session is never restored on restaurant B's pages (or on the platform console).
 */
export function sessionCacheSlot(site: SiteContext, host: string): { key: string; slug: string | null } {
  if (site.kind === 'path') return { key: `tenant:${site.slug}`, slug: site.slug };
  return { key: `host:${host}`, slug: site.slug };
}

/**
 * May a session payload (from refresh, login or the offline cache) be used on this site?
 * Restaurant pages accept only their own restaurant's staff; the platform console only platform users.
 * The server enforces this too; this keeps a stale or misdirected payload from ever reaching the UI.
 */
export function sessionBelongsToSite(site: SiteContext, payload: { user?: { tenantId?: string | null } | null; tenant?: { slug?: string } | null } | null | undefined): boolean {
  if (!payload?.user) return false;
  if (site.kind === 'path' || site.kind === 'subdomain') return !!payload.user.tenantId && payload.tenant?.slug === site.slug;
  if (site.kind === 'platform') return !payload.user.tenantId;
  return false; // custom domains and invalid pages have no staff sessions
}
