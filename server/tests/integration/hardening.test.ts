/**
 * Regression tests for the production-hardening pass:
 * privilege escalation via permission overrides, session revocation (refresh tokens), super admin
 * account management, restaurant detail editing, custom-domain CORS and the non-destructive bootstrap.
 */
import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb, PW } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../src/app';
import { Plan, Tenant, User } from '../../src/models/platform';
import { createSuperAdmin, ensureDefaultPlans, ensureSuperAdmin, resetSuperAdminPassword } from '../../src/services/bootstrap';

let mongod: Awaited<ReturnType<typeof startDb>>;
const app = createApp();
let saToken: string;
let planId: string;
let A: Awaited<ReturnType<typeof provisionTenant>>;
let B: Awaited<ReturnType<typeof provisionTenant>>;

/** Logs in on a tenant host and returns the access token plus the refresh cookie. */
async function loginOn(host: string, slug: string, email: string, password = PW) {
  const r = await request(app).post('/api/auth/login').set('Host', host).send({ email, password, tenantSlug: slug });
  const cookie = (r.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('rt='))?.split(';')[0];
  return { status: r.status, token: r.body.accessToken as string, cookie: cookie ?? '' };
}

before(async () => {
  mongod = await startDb();
  const p = await bootstrapPlatform(app);
  saToken = p.saToken;
  planId = p.planId;
  A = await provisionTenant(app, saToken, planId, 'hard-a');
  B = await provisionTenant(app, saToken, planId, 'hard-b');
});

after(async () => stopDb(mongod));

/* ---------------------------- Privilege escalation ---------------------------- */
test('an admin cannot grant permissions they do not hold (payments:configure), the owner can', async () => {
  const admin = await request(app).post('/api/staff/staff').set(auth(A.token)).send({ name: 'Admin A', email: 'admin@hard-a.test', password: PW, role: 'admin' });
  assert.equal(admin.status, 201, JSON.stringify(admin.body));
  const adminLogin = await loginOn(A.host, A.slug, 'admin@hard-a.test');
  assert.equal(adminLogin.status, 200);

  const escalate = await request(app).post('/api/staff/staff').set(auth(adminLogin.token)).send({
    name: 'Mallory', email: 'mallory@hard-a.test', password: PW, role: 'waiter', permissionOverrides: { grant: ['payments:configure'], revoke: [] },
  });
  assert.equal(escalate.status, 403, 'admin granted a permission they lack');

  // Granting something the admin holds is fine.
  const ok = await request(app).post('/api/staff/staff').set(auth(adminLogin.token)).send({
    name: 'Wendy', email: 'wendy@hard-a.test', password: PW, role: 'waiter', permissionOverrides: { grant: ['analytics:view'], revoke: [] },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  const self = await request(app).patch(`/api/staff/staff/${admin.body._id}`).set(auth(adminLogin.token)).send({ permissionOverrides: { grant: ['payments:configure'], revoke: [] } });
  assert.equal(self.status, 403, 'admin escalated their own permissions');
  const selfRole = await request(app).patch(`/api/staff/staff/${admin.body._id}`).set(auth(adminLogin.token)).send({ role: 'owner' });
  assert.notEqual(selfRole.status, 200, 'admin changed their own role');
  // Editing their own name is still allowed.
  const selfName = await request(app).patch(`/api/staff/staff/${admin.body._id}`).set(auth(adminLogin.token)).send({ name: 'Admin Renamed' });
  assert.equal(selfName.status, 200, JSON.stringify(selfName.body));

  const byOwner = await request(app).patch(`/api/staff/staff/${ok.body._id}`).set(auth(A.token)).send({ permissionOverrides: { grant: ['payments:configure'], revoke: [] } });
  assert.equal(byOwner.status, 200, 'owner may grant any permission');
});

test('staff assignments must reference the same tenant', async () => {
  const tB = await request(app).post('/api/staff/tables').set(auth(B.token)).send({ label: 'B-X' });
  const r = await request(app).post('/api/staff/staff').set(auth(A.token)).send({ name: 'Cross', email: 'cross@hard-a.test', password: PW, role: 'waiter', assignedTableIds: [tB.body.items[0]._id] });
  assert.equal(r.status, 400);
});

/* ---------------------------- Session revocation ---------------------------- */
test('password reset and deactivation revoke refresh tokens, not only access tokens', async () => {
  const w = await request(app).post('/api/staff/staff').set(auth(A.token)).send({ name: 'Rev', email: 'rev@hard-a.test', password: PW, role: 'waiter' });
  assert.equal(w.status, 201);
  const s = await loginOn(A.host, A.slug, 'rev@hard-a.test');
  assert.ok(s.cookie, 'refresh cookie issued');
  const refreshOk = await request(app).post('/api/auth/refresh').set('Host', A.host).set('Cookie', s.cookie);
  assert.equal(refreshOk.status, 200, 'refresh works before reset');
  const rotated = (refreshOk.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('rt='))!.split(';')[0];

  const reset = await request(app).patch(`/api/staff/staff/${w.body._id}`).set(auth(A.token)).send({ password: 'An0ther-Long-Pass!' });
  assert.equal(reset.status, 200);
  const after = await request(app).post('/api/auth/refresh').set('Host', A.host).set('Cookie', rotated);
  assert.equal(after.status, 401, 'stolen refresh cookie survived a password reset');
  assert.equal((await request(app).get('/api/staff/orders').set(auth(s.token))).status, 401, 'access token survived a password reset');
});

test('tenant staff cannot refresh a session on the platform root host', async () => {
  const s = await loginOn(A.host, A.slug, `owner@${A.slug}.test`);
  const r = await request(app).post('/api/auth/refresh').set('Host', 'test.local').set('Cookie', s.cookie);
  assert.equal(r.status, 401);
});

/* ---------------------------- Super admin ---------------------------- */
test('super admin lists and manages a tenant’s accounts; tenant staff cannot', async () => {
  const list = await request(app).get(`/api/platform/tenants/${A.tenantId}/users`).set(auth(saToken));
  assert.equal(list.status, 200);
  assert.ok(list.body.items.every((u: any) => u.passwordHash === undefined && u.refreshTokens === undefined), 'secrets leaked');
  const waiter = list.body.items.find((u: any) => u.email === 'wendy@hard-a.test');
  const owner = list.body.items.find((u: any) => u.role === 'owner');
  assert.ok(waiter && owner);

  assert.equal((await request(app).get(`/api/platform/tenants/${A.tenantId}/users`).set(auth(A.token))).status, 403);

  const off = await request(app).patch(`/api/platform/tenants/${A.tenantId}/users/${waiter._id}`).set(auth(saToken)).send({ isActive: false });
  assert.equal(off.status, 200);
  assert.equal((await loginOn(A.host, A.slug, 'wendy@hard-a.test')).status, 401, 'deactivated account could sign in');

  const on = await request(app).patch(`/api/platform/tenants/${A.tenantId}/users/${waiter._id}`).set(auth(saToken)).send({ isActive: true, password: 'Brand-New-Pass-1' });
  assert.equal(on.status, 200);
  assert.equal((await loginOn(A.host, A.slug, 'wendy@hard-a.test', 'Brand-New-Pass-1')).status, 200);

  const ownerOff = await request(app).patch(`/api/platform/tenants/${A.tenantId}/users/${owner._id}`).set(auth(saToken)).send({ isActive: false });
  assert.equal(ownerOff.status, 400, 'owner must be handled via suspension');

  // A user id from tenant A addressed under tenant B is not found (no cross-tenant targeting).
  const cross = await request(app).patch(`/api/platform/tenants/${B.tenantId}/users/${waiter._id}`).set(auth(saToken)).send({ isActive: false });
  assert.equal(cross.status, 404);
});

test('super admin edits restaurant details without wiping sibling fields', async () => {
  await request(app).patch(`/api/platform/tenants/${A.tenantId}`).set(auth(saToken)).send({ contact: { email: 'hello@hard-a.test', phone: '+92 300 1234567' } }).expect(200);
  const r = await request(app).patch(`/api/platform/tenants/${A.tenantId}`).set(auth(saToken)).send({ name: 'Hard A Renamed', contact: { city: 'Lahore' }, settings: { timezone: 'Asia/Dubai', currency: 'aed' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = await Tenant.findById(A.tenantId).lean();
  assert.equal(t!.name, 'Hard A Renamed');
  assert.equal(t!.contact!.email, 'hello@hard-a.test', 'partial contact update wiped email');
  assert.equal(t!.contact!.city, 'Lahore');
  assert.equal(t!.settings!.timezone, 'Asia/Dubai');
  assert.equal(t!.settings!.currency, 'AED');
  assert.equal(t!.settings!.taxRatePercent, 0, 'sibling settings preserved');
  const badTz = await request(app).patch(`/api/platform/tenants/${A.tenantId}`).set(auth(saToken)).send({ settings: { timezone: 'Mars/Olympus' } });
  assert.equal(badTz.status, 400);
});

test('custom domains: rejected under the platform domain; allowed for CORS once assigned', async () => {
  const under = await request(app).patch(`/api/platform/tenants/${A.tenantId}`).set(auth(saToken)).send({ customDomain: 'evil.test.local' });
  assert.equal(under.status, 400);
  const before = await request(app).get('/api/health').set('Origin', 'https://menu.hard-a.example');
  assert.equal(before.headers['access-control-allow-origin'], undefined);
  await request(app).patch(`/api/platform/tenants/${A.tenantId}`).set(auth(saToken)).send({ customDomain: 'menu.hard-a.example' }).expect(200);
  const afterSet = await request(app).get('/api/health').set('Origin', 'https://menu.hard-a.example');
  assert.equal(afterSet.headers['access-control-allow-origin'], 'https://menu.hard-a.example');
  const storefront = await request(app).get('/api/public/storefront').set('Host', 'menu.hard-a.example');
  assert.equal(storefront.status, 200);
  assert.equal(storefront.body.slug, A.slug);
});

test('overview MRR counts only paying, non-suspended subscriptions', async () => {
  // Both tenants are in trial → no recurring revenue yet.
  const r = await request(app).get('/api/platform/overview').set(auth(saToken));
  assert.equal(r.status, 200);
  assert.equal(r.body.estimatedMRR, 0, 'trials counted as revenue');
  await request(app).post(`/api/platform/tenants/${B.tenantId}/subscription`).set(auth(saToken)).send({ action: 'renew', months: 1 }).expect(200);
  const r2 = await request(app).get('/api/platform/overview').set(auth(saToken));
  assert.equal(r2.body.estimatedMRR, 100, 'one paying tenant on a 100-unit plan');
});

/* ---------------------------- Order state API ---------------------------- */
test('moving an order back to pending is a 400, not a 403', async () => {
  const cat = await request(app).post('/api/staff/menu/categories').set(auth(B.token)).send({ name: { en: 'Mains' } });
  const prod = await request(app).post('/api/staff/menu/products').set(auth(B.token)).send({ categoryId: cat.body._id, name: { en: 'Dal' }, price: 500 });
  const order = await request(app).post('/api/staff/orders').set(auth(B.token)).send({ type: 'takeaway', items: [{ productId: prod.body._id, quantity: 1 }] });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const r = await request(app).post(`/api/staff/orders/${order.body._id}/status`).set(auth(B.token)).send({ status: 'pending' });
  assert.equal(r.status, 400);
});

/* ---------------------------- Bootstrap ---------------------------- */
test('bootstrap never overwrites existing plans or super admin credentials', async () => {
  const before = await Plan.countDocuments();
  assert.equal(await ensureDefaultPlans(), 0, 'plans created although some existed');
  assert.equal(await Plan.countDocuments(), before);

  const sa = await User.findOne({ role: 'superadmin' }).select('+passwordHash').lean();
  assert.equal(await ensureSuperAdmin('someone-else@test.local', 'Different-Pass-123'), 'exists');
  const saAfter = await User.findOne({ _id: sa!._id }).select('+passwordHash').lean();
  assert.equal(saAfter!.passwordHash, sa!.passwordHash, 'existing super admin password changed');
  assert.equal(await User.countDocuments({ role: 'superadmin' }), 1);

  assert.equal(await createSuperAdmin('sa@test.local', 'Whatever-Pass-1'), 'exists', 'duplicate super admin created');
  assert.equal(await resetSuperAdminPassword('nobody@test.local', 'Whatever-Pass-1'), 'not_found');
  assert.equal(await resetSuperAdminPassword('sa@test.local', 'Rotated-Pass-123'), 'password_reset');
  const rotated = await User.findOne({ _id: sa!._id }).select('+passwordHash').lean();
  assert.ok(await bcrypt.compare('Rotated-Pass-123', rotated!.passwordHash));
  assert.equal((await request(app).get('/api/platform/overview').set(auth(saToken))).status, 401, 'old super admin session survived reset');
});

test('default plans are created on an empty platform', async () => {
  await Plan.deleteMany({});
  assert.equal(await ensureDefaultPlans(), 3);
  assert.equal(await ensureDefaultPlans(), 0, 'not idempotent');
  assert.deepEqual((await Plan.find().sort({ priceMonthly: 1 }).lean()).map((p) => p.code), ['starter', 'growth', 'pro']);
});

test('bulk table creation needs no label and skips labels that already exist (no partial batches)', async () => {
  const first = await request(app).post('/api/staff/tables').set(auth(B.token)).send({ count: 3, prefix: 'G' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(first.body.items.map((t: any) => t.label), ['G1', 'G2', 'G3']);
  await request(app).delete(`/api/staff/tables/${first.body.items[0]._id}`).set(auth(B.token)).expect(200);
  const more = await request(app).post('/api/staff/tables').set(auth(B.token)).send({ count: 2, prefix: 'G' });
  assert.equal(more.status, 201, JSON.stringify(more.body));
  assert.deepEqual(more.body.items.map((t: any) => t.label), ['G1', 'G4'], 'reused a gap and skipped existing labels');
  const dup = await request(app).post('/api/staff/tables').set(auth(B.token)).send({ label: 'G2' });
  assert.equal(dup.status, 409);
  const noLabel = await request(app).post('/api/staff/tables').set(auth(B.token)).send({ area: 'Patio' });
  assert.equal(noLabel.status, 400);
});

test('refresh without any session cookie is a quiet 204 (no session); a bad cookie is still 401', async () => {
  const none = await request(app).post('/api/auth/refresh').set('Host', A.host);
  assert.equal(none.status, 204);
  assert.equal(none.body?.accessToken, undefined);
  const bad = await request(app).post('/api/auth/refresh').set('Host', A.host).set('Cookie', 'rt=000000000000000000000000.forged');
  assert.equal(bad.status, 401);
});
