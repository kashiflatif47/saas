/**
 * Path-based multi-tenancy: every restaurant at ROOT_DOMAIN/r/<slug> on ONE shared hostname.
 * Covers URL generation, public API resolution from the path, per-restaurant refresh sessions on a shared host,
 * logout isolation, forged tenant context, subscription/suspension rules and the SPA deep-link fallback.
 */
import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb, PW } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { Tenant, User } from '../../src/models/platform';
import { invalidateTenantCache } from '../../src/services/tenantResolver';
import { unsubscribeUrl } from '../../src/services/marketing';

let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
const ROOT = 'test.local'; // tests/env.ts
let saToken: string;
let planId: string;
let A: Awaited<ReturnType<typeof provisionTenant>>; // hahha
let B: Awaited<ReturnType<typeof provisionTenant>>; // pizza
let C: Awaited<ReturnType<typeof provisionTenant>>; // burger (suspension)
const ids: Record<string, string> = {};

/** Extracts one cookie from Set-Cookie: `{ pair: 'name=value', attrs: 'name=value; Path=…' }`. */
function cookie(res: request.Response, name: string) {
  const all = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const raw = all.find((c) => c.startsWith(`${name}=`));
  return raw ? { pair: raw.split(';')[0], attrs: raw, value: raw.split(';')[0].slice(name.length + 1) } : null;
}

const tenantLogin = (slug: string, email: string, password = PW) => request(app).post(`/api/auth/tenants/${slug}/login`).set('Host', ROOT).send({ email, password });
const tenantRefresh = (slug: string, c?: string) => {
  const r = request(app).post(`/api/auth/tenants/${slug}/refresh`).set('Host', ROOT);
  return c ? r.set('Cookie', c) : r;
};

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  saToken = p.saToken;
  planId = p.planId;
  A = await provisionTenant(app, saToken, planId, 'hahha');
  B = await provisionTenant(app, saToken, planId, 'pizza');
  C = await provisionTenant(app, saToken, planId, 'burger');
  for (const [key, t] of [['A', A], ['B', B]] as const) {
    const cat = await request(app).post('/api/staff/menu/categories').set(auth(t.token)).send({ name: { en: `Cat ${key}` } });
    const prod = await request(app).post('/api/staff/menu/products').set(auth(t.token)).send({ categoryId: cat.body._id, name: { en: `Prod ${key}` }, price: 1000 });
    const tables = await request(app).post('/api/staff/tables').set(auth(t.token)).send({ label: `${key}1` });
    assert.equal(tables.status, 201);
    ids[`prod${key}`] = prod.body._id;
    ids[`token${key}`] = tables.body.items[0].qrToken;
  }
});

after(async () => stopDb(mongod));

/* ------------------------------------------------------------------ URL generation */

test('provisioning a restaurant returns its path-based URL and login URL automatically', async () => {
  const r = await request(app).post('/api/platform/tenants').set(auth(saToken)).send({ name: 'Taco Town', planId, owner: { name: 'Taco Owner', email: 'owner@taco.test', password: PW } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.tenant.slug, 'taco-town');
  assert.equal(r.body.url, `http://${ROOT}/r/taco-town`);
  assert.equal(r.body.loginUrl, `http://${ROOT}/r/taco-town/login`);

  const detail = await request(app).get(`/api/platform/tenants/${A.tenantId}`).set(auth(saToken));
  assert.equal(detail.body.url, `http://${ROOT}/r/hahha`);
  assert.equal(detail.body.loginUrl, `http://${ROOT}/r/hahha/login`);

  const list = await request(app).get('/api/platform/tenants').set(auth(saToken));
  const hahha = list.body.items.find((t: any) => t.slug === 'hahha');
  assert.equal(hahha.url, `http://${ROOT}/r/hahha`, 'restaurant list shows each restaurant URL');
  assert.ok(list.body.items.every((t: any) => !String(t.url).includes(`${t.slug}.${ROOT}`)), 'no subdomain URLs in the list');

  const own = await request(app).get('/api/staff/tenant').set(auth(A.token));
  assert.equal(own.body.url, `http://${ROOT}/r/hahha`, 'owner settings show the storefront address');
});

test('table QR codes and unsubscribe links point at the restaurant path', async () => {
  const tables = await request(app).get('/api/staff/tables').set(auth(A.token));
  assert.equal(tables.status, 200);
  assert.equal(tables.body.items[0].qrUrl, `http://${ROOT}/r/hahha/t/${ids.tokenA}`);
  const u = unsubscribeUrl({ _id: A.tenantId, slug: 'hahha' }, '64b000000000000000000001');
  assert.ok(u.startsWith(`http://${ROOT}/r/hahha/unsubscribe?c=64b000000000000000000001&t=`), u);
});

/* ------------------------------------------------------------ public API from the path */

test('public storefront resolves the restaurant from /api/public/tenants/:slug on the shared host', async () => {
  const a = await request(app).get('/api/public/tenants/hahha/storefront').set('Host', ROOT);
  assert.equal(a.status, 200);
  assert.equal(a.body.slug, 'hahha');
  const b = await request(app).get('/api/public/tenants/pizza/storefront').set('Host', ROOT);
  assert.equal(b.body.slug, 'pizza');
  // The root host on its own is the platform: it has no restaurant.
  const root = await request(app).get('/api/public/storefront').set('Host', ROOT);
  assert.equal(root.status, 404);
});

test('unknown or malformed restaurant slugs are 404 (never a hostname, reserved word or another route)', async () => {
  for (const slug of ['nope-nope', 'Hahha', 'hahha.test.local', 'admin', 'www', 'a', '%2e%2e', 'hahha%2Fx']) {
    const r = await request(app).get(`/api/public/tenants/${slug}/storefront`).set('Host', ROOT);
    assert.equal(r.status, 404, `slug ${slug} -> ${r.status}`);
  }
  assert.equal((await request(app).get('/api/public/tenants/hahha/not-a-route').set('Host', ROOT)).status, 404);
  assert.equal((await request(app).get('/api/public/tenants').set('Host', ROOT)).status, 404);
});

test('menus and QR tokens are scoped to the restaurant in the path', async () => {
  const menuA = await request(app).get('/api/public/tenants/hahha/menu').set('Host', ROOT);
  assert.deepEqual(menuA.body.products.map((p: any) => p.name.en), ['Prod A']);
  const menuB = await request(app).get('/api/public/tenants/pizza/menu').set('Host', ROOT);
  assert.deepEqual(menuB.body.products.map((p: any) => p.name.en), ['Prod B']);
  assert.equal((await request(app).get(`/api/public/tenants/hahha/tables/${ids.tokenA}`).set('Host', ROOT)).status, 200);
  assert.equal((await request(app).get(`/api/public/tenants/pizza/tables/${ids.tokenA}`).set('Host', ROOT)).status, 404, "hahha's QR must not resolve on pizza");
});

test('ordering and order tracking work through the path and never across restaurants', async () => {
  const cross = await request(app).post('/api/public/tenants/pizza/orders').set('Host', ROOT).send({ type: 'dine_in', tableToken: ids.tokenB, items: [{ productId: ids.prodA, quantity: 1 }] });
  assert.equal(cross.status, 400, "ordering hahha's product from pizza must fail");
  const placed = await request(app).post('/api/public/tenants/hahha/orders').set('Host', ROOT).send({ type: 'dine_in', tableToken: ids.tokenA, items: [{ productId: ids.prodA, quantity: 1 }] });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const { _id } = placed.body.order;
  const token = placed.body.trackingToken;
  const track = await request(app).get(`/api/public/tenants/hahha/orders/${_id}?token=${encodeURIComponent(token)}`).set('Host', ROOT);
  assert.equal(track.status, 200);
  const elsewhere = await request(app).get(`/api/public/tenants/pizza/orders/${_id}?token=${encodeURIComponent(token)}`).set('Host', ROOT);
  assert.equal(elsewhere.status, 404, 'tracking an order through another restaurant path');
  // The order really belongs to hahha.
  const staff = await request(app).get(`/api/staff/orders/${_id}`).set(auth(A.token));
  assert.equal(staff.status, 200);
  assert.equal((await request(app).get(`/api/staff/orders/${_id}`).set(auth(B.token))).status, 404);
});

test('forged tenant headers cannot redirect a path-based public request to another restaurant', async () => {
  // ALLOW_TENANT_HEADER=false: X-Tenant-Slug is ignored; the path always decides, X-Tenant-Host cannot override it.
  const r = await request(app).get('/api/public/tenants/hahha/menu').set('Host', ROOT).set('X-Tenant-Host', B.host).set('X-Tenant-Slug', 'pizza');
  assert.deepEqual(r.body.products.map((p: any) => p.name.en), ['Prod A']);
  const root = await request(app).get('/api/public/menu').set('Host', ROOT).set('X-Tenant-Slug', 'pizza');
  assert.equal(root.status, 404, 'X-Tenant-Slug must stay disabled');
});

/* ----------------------------------------------------- sessions on one shared hostname */

test('two restaurants and the super admin keep separate refresh sessions on the same host', async () => {
  const la = await tenantLogin('hahha', 'owner@hahha.test');
  assert.equal(la.status, 200, JSON.stringify(la.body));
  assert.equal(la.body.tenant.slug, 'hahha');
  const ca = cookie(la, 'trt')!;
  assert.ok(ca, 'tenant refresh cookie issued');
  assert.match(ca.attrs, /Path=\/api\/auth\/tenants\/hahha(;|$)/);
  assert.match(ca.attrs, /HttpOnly/);
  assert.match(ca.attrs, /SameSite=Lax/);
  assert.equal(cookie(la, 'rt'), null, 'a path-based restaurant must not touch the platform cookie');

  const lb = await tenantLogin('pizza', 'owner@pizza.test');
  const cb = cookie(lb, 'trt')!;
  assert.match(cb.attrs, /Path=\/api\/auth\/tenants\/pizza(;|$)/);

  const ls = await request(app).post('/api/auth/login').set('Host', ROOT).send({ email: 'sa@test.local', password: PW });
  const cs = cookie(ls, 'rt')!;
  assert.match(cs.attrs, /Path=\/api\/auth(;|$)/);

  // Each refreshes into its own restaurant (or the platform), with rotation.
  const ra = await tenantRefresh('hahha', ca.pair);
  assert.equal(ra.status, 200);
  assert.equal(ra.body.tenant.slug, 'hahha');
  const ra2 = cookie(ra, 'trt')!;
  assert.notEqual(ra2.value, ca.value, 'refresh token rotated');
  const rb = await tenantRefresh('pizza', cb.pair);
  assert.equal(rb.status, 200);
  assert.equal(rb.body.tenant.slug, 'pizza');
  const rs = await request(app).post('/api/auth/refresh').set('Host', ROOT).set('Cookie', cs.pair);
  assert.equal(rs.status, 200);
  assert.equal(rs.body.user.role, 'superadmin');
  assert.equal(rs.body.tenant, null);

  // Cross-site replays are refused WITHOUT revoking the victim's session.
  assert.equal((await tenantRefresh('pizza', ra2.pair)).status, 401, "hahha's cookie on pizza's endpoint");
  assert.equal((await tenantRefresh('burger', ra2.pair)).status, 401);
  assert.equal((await request(app).post('/api/auth/refresh').set('Host', ROOT).set('Cookie', `rt=${ra2.value}`)).status, 401, 'tenant token replayed as the platform cookie');
  assert.equal((await tenantRefresh('hahha', `trt=${cookie(rs, 'rt')!.value}`)).status, 401, 'super admin token replayed on a restaurant');
  // The platform cookie is simply not a restaurant session (and vice versa): no cookie in scope = no session.
  assert.equal((await tenantRefresh('hahha', cookie(rs, 'rt')!.pair)).status, 204);
  assert.equal((await request(app).post('/api/auth/refresh').set('Host', ROOT).set('Cookie', ra2.pair)).status, 204);

  const again = await tenantRefresh('hahha', ra2.pair);
  assert.equal(again.status, 200, 'hahha session survives the replay attempts');
  ids.cookieA = cookie(again, 'trt')!.pair;
  ids.cookieB = cookie(rb, 'trt')!.pair;
  ids.cookieSA = cookie(rs, 'rt')!.pair;
});

test('credentials only work for their own restaurant path; super admin cannot sign in on a restaurant', async () => {
  assert.equal((await tenantLogin('pizza', 'owner@hahha.test')).status, 401);
  assert.equal((await tenantLogin('hahha', 'sa@test.local')).status, 401);
  assert.equal((await tenantLogin('no-such-place', 'owner@hahha.test')).status, 401);
  assert.equal((await request(app).post('/api/auth/tenants/Bad.Slug/login').set('Host', ROOT).send({ email: 'owner@hahha.test', password: PW })).status, 404);
  // A tenantSlug smuggled in the body is ignored: the path decides.
  const smuggled = await request(app).post('/api/auth/tenants/pizza/login').set('Host', ROOT).send({ email: 'owner@hahha.test', password: PW, tenantSlug: 'hahha' });
  assert.equal(smuggled.status, 401);
});

test('logging out of one restaurant leaves the other restaurant and the super admin signed in', async () => {
  const out = await request(app).post('/api/auth/tenants/hahha/logout').set('Host', ROOT).set('Cookie', ids.cookieA);
  assert.equal(out.status, 200);
  const cleared = cookie(out, 'trt')!;
  assert.match(cleared.attrs, /Path=\/api\/auth\/tenants\/hahha(;|$)/, 'only hahha cookie is cleared');
  assert.equal(cookie(out, 'rt'), null);
  assert.equal((await tenantRefresh('hahha', ids.cookieA)).status, 401, 'logged-out token cannot be reused');

  const b = await tenantRefresh('pizza', ids.cookieB);
  assert.equal(b.status, 200, 'pizza still signed in');
  ids.cookieB = cookie(b, 'trt')!.pair;
  const s = await request(app).post('/api/auth/refresh').set('Host', ROOT).set('Cookie', ids.cookieSA);
  assert.equal(s.status, 200, 'super admin still signed in');
});

test('expired and revoked restaurant refresh tokens are rejected', async () => {
  await User.updateOne({ email: 'owner@pizza.test' }, { $set: { 'refreshTokens.$[].expiresAt': new Date(Date.now() - 1000) } });
  assert.equal((await tenantRefresh('pizza', ids.cookieB)).status, 401);
  // Revocation: a password change elsewhere revokes every refresh token.
  const l = await tenantLogin('pizza', 'owner@pizza.test');
  const c = cookie(l, 'trt')!.pair;
  await User.updateOne({ email: 'owner@pizza.test' }, { $set: { refreshTokens: [] }, $inc: { tokenVersion: 1 } });
  assert.equal((await tenantRefresh('pizza', c)).status, 401);
  B.token = (await tenantLogin('pizza', 'owner@pizza.test')).body.accessToken;
});

test('changing password on the shared host re-issues the session in the restaurant scope', async () => {
  const l = await tenantLogin('hahha', 'owner@hahha.test');
  const r = await request(app).post('/api/auth/change-password').set('Host', ROOT).set(auth(l.body.accessToken)).send({ currentPassword: PW, newPassword: `${PW}-2` });
  assert.equal(r.status, 200);
  const c = cookie(r, 'trt')!;
  assert.match(c.attrs, /Path=\/api\/auth\/tenants\/hahha(;|$)/);
  assert.equal(cookie(r, 'rt'), null);
  assert.equal((await tenantRefresh('hahha', c.pair)).status, 200);
  // restore
  const back = await request(app).post('/api/auth/change-password').set(auth(r.body.accessToken)).send({ currentPassword: `${PW}-2`, newPassword: PW });
  assert.equal(back.status, 200);
  A.token = back.body.accessToken;
});

/* ---------------------------------------------------------- staff authorization stays JWT-based */

test('staff APIs: the JWT decides the restaurant; a mismatching page context is refused', async () => {
  assert.equal((await request(app).get('/api/staff/menu/products').set('Host', ROOT).set(auth(A.token))).status, 200);
  assert.equal((await request(app).get('/api/staff/menu/products').set('Host', ROOT).set(auth(A.token)).set('X-Tenant-Context', 'hahha')).status, 200);
  const forged = await request(app).get('/api/staff/menu/products').set('Host', ROOT).set(auth(A.token)).set('X-Tenant-Context', 'pizza');
  assert.equal(forged.status, 403, 'hahha token on a pizza page');
  // The header can never grant access: pizza data stays invisible to a hahha token whatever the context says.
  const peek = await request(app).get(`/api/staff/menu/products/${ids.prodB}`).set('Host', ROOT).set(auth(A.token)).set('X-Tenant-Context', 'hahha');
  assert.equal(peek.status, 404);
  // A public path never authorizes staff actions.
  assert.equal((await request(app).get('/api/public/tenants/pizza/staff/menu/products').set(auth(A.token))).status, 404);
  assert.equal((await request(app).get('/api/platform/tenants').set(auth(A.token))).status, 403, 'restaurant owner is not a super admin');
});

test('permissions and subscription rules still apply on path-based restaurants', async () => {
  const waiter = await request(app).post('/api/staff/staff').set(auth(A.token)).send({ name: 'Wasim Waiter', email: 'waiter@hahha.test', password: PW, role: 'waiter' });
  assert.equal(waiter.status, 201, JSON.stringify(waiter.body));
  const wl = await tenantLogin('hahha', 'waiter@hahha.test');
  assert.equal(wl.status, 200);
  assert.equal((await request(app).post('/api/staff/menu/categories').set(auth(wl.body.accessToken)).send({ name: { en: 'nope' } })).status, 403, 'waiter cannot manage the menu');

  // Lapsed subscription: storefront unavailable, staff read-only.
  await Tenant.updateOne({ _id: B.tenantId }, { $set: { 'subscription.status': 'expired' } });
  invalidateTenantCache('pizza');
  assert.equal((await request(app).get('/api/public/tenants/pizza/storefront').set('Host', ROOT)).status, 503);
  assert.equal((await request(app).get('/api/staff/menu/products').set(auth(B.token))).status, 200);
  assert.equal((await request(app).post('/api/staff/menu/categories').set(auth(B.token)).send({ name: { en: 'x' } })).status, 402);
  await Tenant.updateOne({ _id: B.tenantId }, { $set: { 'subscription.status': 'trial' } });
  invalidateTenantCache('pizza');
  assert.equal((await request(app).get('/api/public/tenants/pizza/storefront').set('Host', ROOT)).status, 200);
});

test('a suspended restaurant is unavailable publicly and its sessions end', async () => {
  const l = await tenantLogin('burger', 'owner@burger.test');
  const c = cookie(l, 'trt')!.pair;
  const s = await request(app).post(`/api/platform/tenants/${C.tenantId}/status`).set(auth(saToken)).send({ status: 'suspended' });
  assert.equal(s.status, 200);
  assert.equal((await request(app).get('/api/public/tenants/burger/storefront').set('Host', ROOT)).status, 503);
  assert.equal((await tenantRefresh('burger', c)).status, 401);
  assert.equal((await tenantLogin('burger', 'owner@burger.test')).status, 401);
  assert.equal((await request(app).get('/api/staff/menu/products').set(auth(C.token))).status, 401, 'access token revoked');
  // Other restaurants are unaffected.
  assert.equal((await request(app).get('/api/public/tenants/hahha/storefront').set('Host', ROOT)).status, 200);
});

/* ------------------------------------------------------------- SPA served by the API */

test('single-service SPA: deep links under /r/<slug> load the app; unknown restaurants are 404; slugs are lowercased', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'tablesaas-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), JSON.stringify({ name: 'TableSaaS', start_url: '/', scope: '/', icons: [] }));
  const prev = env.CLIENT_DIST_DIR;
  (env as any).CLIENT_DIST_DIR = dist;
  try {
    const spa = createApp();
    for (const p of ['/', '/admin', '/admin/tenants', '/admin/plans', '/login', '/r/hahha', '/r/hahha/', '/r/hahha/login', '/r/hahha/dashboard', '/r/hahha/dashboard/orders', '/r/hahha/dashboard/menu', `/r/hahha/t/${ids.tokenA}`, '/r/pizza/dashboard/kitchen', '/r/burger']) {
      const r = await request(spa).get(p).set('Host', ROOT);
      assert.equal(r.status, 200, `${p} -> ${r.status}`);
      assert.match(r.text, /<div id="root">/);
    }
    for (const p of ['/r/nope-nope', '/r/nope-nope/dashboard', '/r/admin', '/r/', '/r', '/r/a.b']) {
      const r = await request(spa).get(p).set('Host', ROOT);
      assert.equal(r.status, 404, `${p} -> ${r.status}`);
      assert.match(r.text, /<div id="root">/, 'the app still renders its own not-found page');
    }
    const up = await request(spa).get('/r/HAHHA/dashboard/orders?x=1').set('Host', ROOT);
    assert.equal(up.status, 301);
    assert.equal(up.headers.location, '/r/hahha/dashboard/orders?x=1');

    const man = await request(spa).get('/r/hahha/manifest.webmanifest').set('Host', ROOT);
    assert.equal(man.status, 200);
    const m = JSON.parse(man.text);
    assert.equal(m.start_url, '/r/hahha/');
    assert.equal(m.id, '/r/hahha/');
    assert.equal(m.name, 'Tenant hahha — TableSaaS');
    assert.equal((await request(spa).get('/r/nope-nope/manifest.webmanifest').set('Host', ROOT)).status, 404);
    // API routes are never swallowed by the SPA fallback.
    assert.equal((await request(spa).get('/api/public/tenants/hahha/storefront').set('Host', ROOT)).status, 200);
    assert.equal((await request(spa).get('/api/nothing').set('Host', ROOT)).status, 404);
  } finally {
    (env as any).CLIENT_DIST_DIR = prev;
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('restaurant subdomains keep working (backward compatible host resolution)', async () => {
  const r = await request(app).get('/api/public/menu').set('Host', A.host);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.products.map((p: any) => p.name.en), ['Prod A']);
});
