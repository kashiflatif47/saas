/**
 * Browser-side tenant routing logic (client/src/lib/site.ts): which site a URL belongs to, router basename,
 * public API path rewriting, per-restaurant session endpoints and offline session-cache isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSiteContext, stripBasename, lowercaseTenantPath, buildTenantUrl, publicApiPath, authEndpointFor, sessionCacheSlot, sessionBelongsToSite, isTenantSlug,
} from '../../../client/src/lib/site';

const ROOT = 'nftloyal.shop';
const ctx = (path: string, host = ROOT) => parseSiteContext(host, path, ROOT);

test('root domain is the platform; /admin is never a restaurant', () => {
  for (const p of ['/', '/admin', '/admin/tenants', '/admin/plans', '/login', '/reserve', '/rx/hahha', '/dashboard']) {
    assert.deepEqual(ctx(p), { kind: 'platform', slug: null, basename: '' }, p);
  }
  assert.equal(ctx('/', 'www.nftloyal.shop').kind, 'platform', 'www is reserved, not a restaurant');
});

test('/r/<slug>/… is that restaurant, with the router basename /r/<slug>', () => {
  assert.deepEqual(ctx('/r/hahha'), { kind: 'path', slug: 'hahha', basename: '/r/hahha' });
  assert.deepEqual(ctx('/r/hahha/'), { kind: 'path', slug: 'hahha', basename: '/r/hahha' });
  assert.deepEqual(ctx('/r/hahha/dashboard/orders'), { kind: 'path', slug: 'hahha', basename: '/r/hahha' });
  assert.equal(ctx('/r/pizza/login').slug, 'pizza');
  assert.equal(ctx('/r/spice-garden/t/abcDEF_123-xyz').slug, 'spice-garden');
  // Works the same on localhost / LAN addresses in development.
  assert.deepEqual(parseSiteContext('localhost', '/r/pizza/dashboard', 'localhost'), { kind: 'path', slug: 'pizza', basename: '/r/pizza' });
  assert.equal(parseSiteContext('192.168.1.20', '/r/pizza', 'localhost').slug, 'pizza');
});

test('invalid /r/ addresses are "not found", never a platform page or a hostname-as-slug', () => {
  for (const p of ['/r', '/r/', '/r//dashboard', '/r/Hahha', '/r/hahha.nftloyal.shop', '/r/nftloyal.shop', '/r/admin', '/r/a', '/r/%68ahha', '/r/-x-']) {
    assert.equal(ctx(p).kind, 'invalid', p);
    assert.equal(ctx(p).slug, null, p);
  }
  assert.equal(isTenantSlug('nftloyal.shop'), false);
});

test('legacy subdomains and custom domains are still recognised', () => {
  assert.deepEqual(ctx('/dashboard', 'hahha.nftloyal.shop'), { kind: 'subdomain', slug: 'hahha', basename: '' });
  assert.equal(ctx('/r/pizza', 'hahha.nftloyal.shop').slug, 'hahha', 'a subdomain is never re-targeted by a /r/ path');
  assert.deepEqual(ctx('/', 'menu.myrestaurant.com'), { kind: 'custom', slug: null, basename: '' });
  assert.equal(ctx('/r/pizza', 'menu.myrestaurant.com').kind, 'custom', 'a custom domain cannot show another restaurant via /r/');
  assert.equal(ctx('/', 'a.b.nftloyal.shop').kind, 'platform', 'nested subdomain is never a restaurant');
});

test('deep links and back/forward: in-app paths are relative to the basename', () => {
  assert.equal(stripBasename('/r/hahha/dashboard/orders', '/r/hahha'), '/dashboard/orders');
  assert.equal(stripBasename('/r/hahha', '/r/hahha'), '/');
  assert.equal(stripBasename('/r/hahha/', '/r/hahha'), '/');
  assert.equal(stripBasename('/r/hahha-2/dashboard', '/r/hahha'), '/r/hahha-2/dashboard', 'prefix of another slug is not this basename');
  assert.equal(stripBasename('/admin', ''), '/admin');
});

test('uppercase slugs are normalised before routing', () => {
  assert.equal(lowercaseTenantPath('/r/Hahha/dashboard', '?a=1', '#x'), '/r/hahha/dashboard?a=1#x');
  assert.equal(lowercaseTenantPath('/r/hahha/Dashboard'), null, 'only the slug segment');
  assert.equal(lowercaseTenantPath('/r/ADMIN'), null, 'reserved stays invalid');
  assert.equal(lowercaseTenantPath('/admin'), null);
});

test('generated restaurant links', () => {
  assert.equal(buildTenantUrl('path', 'https:', ROOT, '', 'hahha'), 'https://nftloyal.shop/r/hahha/');
  assert.equal(buildTenantUrl('path', 'http:', 'localhost', '5173', 'pizza', '/login'), 'http://localhost:5173/r/pizza/login');
  assert.equal(buildTenantUrl('subdomain', 'https:', ROOT, '', 'hahha'), 'https://hahha.nftloyal.shop/');
});

test('public API calls on restaurant pages carry the restaurant in the path; others are untouched', () => {
  const a = ctx('/r/hahha/t/tok');
  assert.equal(publicApiPath(a, '/api/public/storefront'), '/api/public/tenants/hahha/storefront');
  assert.equal(publicApiPath(a, '/api/public/orders/abc?token=x'), '/api/public/tenants/hahha/orders/abc?token=x');
  assert.equal(publicApiPath(a, '/api/staff/menu/products'), '/api/staff/menu/products', 'staff API: tenant comes from the JWT');
  assert.equal(publicApiPath(a, '/api/auth/me'), '/api/auth/me');
  assert.equal(publicApiPath(ctx('/admin'), '/api/public/storefront'), '/api/public/storefront');
  assert.equal(publicApiPath(ctx('/', 'hahha.nftloyal.shop'), '/api/public/menu'), '/api/public/menu', 'subdomain: Host decides');
});

test('each restaurant has its own session endpoints; the platform keeps the classic ones', () => {
  assert.equal(authEndpointFor(ctx('/r/hahha/login'), 'login'), '/api/auth/tenants/hahha/login');
  assert.equal(authEndpointFor(ctx('/r/pizza/dashboard'), 'refresh'), '/api/auth/tenants/pizza/refresh');
  assert.equal(authEndpointFor(ctx('/r/pizza/dashboard'), 'logout'), '/api/auth/tenants/pizza/logout');
  assert.equal(authEndpointFor(ctx('/admin'), 'refresh'), '/api/auth/refresh');
  assert.equal(authEndpointFor(ctx('/login', 'hahha.nftloyal.shop'), 'login'), '/api/auth/login');
});

test('offline session cache: one slot per restaurant on the shared origin', () => {
  const a = sessionCacheSlot(ctx('/r/hahha/dashboard/pos'), ROOT);
  const b = sessionCacheSlot(ctx('/r/pizza/dashboard/pos'), ROOT);
  const p = sessionCacheSlot(ctx('/admin'), ROOT);
  assert.deepEqual(a, { key: 'tenant:hahha', slug: 'hahha' });
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.key, p.key);
  assert.equal(sessionCacheSlot(ctx('/', 'hahha.nftloyal.shop'), 'hahha.nftloyal.shop').key, 'host:hahha.nftloyal.shop');
});

test("a session payload is only accepted on its own restaurant's pages", () => {
  const hahhaStaff = { user: { tenantId: 't1' }, tenant: { slug: 'hahha' } };
  const superAdmin = { user: { tenantId: null }, tenant: null };
  assert.equal(sessionBelongsToSite(ctx('/r/hahha/dashboard'), hahhaStaff), true);
  assert.equal(sessionBelongsToSite(ctx('/r/pizza/dashboard'), hahhaStaff), false, "hahha's cached session on pizza");
  assert.equal(sessionBelongsToSite(ctx('/admin'), hahhaStaff), false, 'restaurant staff on the platform console');
  assert.equal(sessionBelongsToSite(ctx('/admin'), superAdmin), true);
  assert.equal(sessionBelongsToSite(ctx('/r/hahha/dashboard'), superAdmin), false, 'super admin on a restaurant');
  assert.equal(sessionBelongsToSite(ctx('/', 'menu.myrestaurant.com'), hahhaStaff), false);
  assert.equal(sessionBelongsToSite(ctx('/r/hahha'), null), false);
});
