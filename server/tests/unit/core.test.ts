import '../env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tenantSlugFromHost, isValidSlug, slugify, tenantSlugFromPath, isPathSlug } from '../../src/lib/subdomain';
import { canTransition, deriveOrderStatus, derivePaymentStatus, canTransitionItem } from '../../src/lib/orderState';
import { encryptSecret, decryptSecret, verifyStripeSignature, sniffImageType } from '../../src/lib/crypto';
import { toCsv } from '../../src/lib/csv';
import { roleHas } from '../../src/config/permissions';

/* ---------------- Subdomains ---------------- */
test('resolves tenant slug from host', () => {
  assert.equal(tenantSlugFromHost('pizza.example.com', 'example.com'), 'pizza');
  assert.equal(tenantSlugFromHost('PIZZA.Example.com:443', 'example.com'), 'pizza');
  assert.equal(tenantSlugFromHost('spice-garden.localhost:5173', 'localhost'), 'spice-garden');
});

test('rejects root, reserved, nested and foreign hosts', () => {
  assert.equal(tenantSlugFromHost('example.com', 'example.com'), null);
  assert.equal(tenantSlugFromHost('www.example.com', 'example.com'), null);
  assert.equal(tenantSlugFromHost('api.example.com', 'example.com'), null);
  assert.equal(tenantSlugFromHost('a.b.example.com', 'example.com'), null);
  assert.equal(tenantSlugFromHost('pizza.evil.com', 'example.com'), null);
  assert.equal(tenantSlugFromHost('pizzaexample.com', 'example.com'), null);
  assert.equal(tenantSlugFromHost(undefined, 'example.com'), null);
});

test('slug validation and slugify', () => {
  assert.ok(isValidSlug('spice-garden'));
  assert.ok(!isValidSlug('admin'));
  assert.ok(!isValidSlug('-bad'));
  assert.ok(!isValidSlug('a'));
  assert.ok(!isValidSlug('double--dash'));
  assert.equal(slugify('Café  Délice & Co.'), 'cafe-delice-co');
});

/* ---------------- Order state ---------------- */
test('order transitions follow the state machine', () => {
  assert.ok(canTransition('pending', 'accepted'));
  assert.ok(canTransition('pending', 'rejected'));
  assert.ok(!canTransition('pending', 'completed'));
  assert.ok(!canTransition('completed', 'pending'));
  assert.ok(canTransition('ready', 'delivered'));
  assert.ok(canTransition('delivered', 'completed'));
  assert.ok(!canTransitionItem('served', 'queued'));
});

test('parent status derives from item statuses', () => {
  assert.equal(deriveOrderStatus('accepted', [{ status: 'queued' }, { status: 'queued' }]), 'accepted');
  assert.equal(deriveOrderStatus('accepted', [{ status: 'preparing' }, { status: 'queued' }]), 'preparing');
  assert.equal(deriveOrderStatus('preparing', [{ status: 'ready' }, { status: 'preparing' }]), 'partially_ready');
  assert.equal(deriveOrderStatus('partially_ready', [{ status: 'ready' }, { status: 'ready' }, { status: 'cancelled' }]), 'ready');
  assert.equal(deriveOrderStatus('preparing', [{ status: 'cancelled' }]), 'cancelled');
  assert.equal(deriveOrderStatus('pending', [{ status: 'ready' }]), 'pending');
  assert.equal(deriveOrderStatus('delivered', [{ status: 'queued' }]), 'delivered');
});

test('payment status is independent and derived from verified amounts', () => {
  assert.equal(derivePaymentStatus(1000, 0, 0), 'unpaid');
  assert.equal(derivePaymentStatus(1000, 400, 0), 'partially_paid');
  assert.equal(derivePaymentStatus(1000, 1000, 0), 'paid');
  assert.equal(derivePaymentStatus(1000, 1000, 200), 'partially_refunded');
  assert.equal(derivePaymentStatus(1000, 1000, 1000), 'refunded');
});

/* ---------------- Crypto ---------------- */
const KEY = crypto.randomBytes(32).toString('hex');

test('secrets round-trip through AES-256-GCM and tampering is detected', () => {
  const enc = encryptSecret('sk_test_abc123', KEY);
  assert.notEqual(enc, 'sk_test_abc123');
  assert.equal(decryptSecret(enc, KEY), 'sk_test_abc123');
  const [iv, tag, data] = enc.split('.');
  const tampered = [iv, tag, Buffer.from('x' + Buffer.from(data, 'base64').toString('binary'), 'binary').toString('base64')].join('.');
  assert.throws(() => decryptSecret(tampered, KEY));
  assert.throws(() => decryptSecret(enc, crypto.randomBytes(32).toString('hex')));
});

test('stripe webhook signatures are verified, with replay window', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
  const t = 1_700_000_000;
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.ok(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, t + 10));
  assert.ok(!verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, t + 1000), 'stale timestamp rejected');
  assert.ok(!verifyStripeSignature(body + ' ', `t=${t},v1=${sig}`, secret, 300, t), 'modified body rejected');
  assert.ok(!verifyStripeSignature(body, `t=${t},v1=${sig}`, 'whsec_other', 300, t), 'wrong secret rejected');
  assert.ok(!verifyStripeSignature(body, undefined, secret));
});

test('image sniffing uses magic bytes, not names', () => {
  assert.equal(sniffImageType(Buffer.from('89504e470d0a1a0a0000000000', 'hex')), 'png');
  assert.equal(sniffImageType(Buffer.from('ffd8ffe000104a4649460001', 'hex')), 'jpg');
  assert.equal(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'webp');
  assert.equal(sniffImageType(Buffer.from('<svg onload=alert(1)></svg>')), null);
});

/* ---------------- CSV + RBAC ---------------- */
test('CSV escapes quotes and neutralises spreadsheet formulas', () => {
  const csv = toCsv(['a', 'b'], [['=HYPERLINK("x")', 'he said "hi", ok']]);
  assert.equal(csv, 'a,b\r\n"\'=HYPERLINK(""x"")","he said ""hi"", ok"\r\n');
});

test('role permissions and overrides', () => {
  assert.ok(roleHas('owner', 'payments:configure'));
  assert.ok(!roleHas('admin', 'payments:configure'));
  assert.ok(!roleHas('waiter', 'payments:refund'));
  assert.ok(roleHas('kitchen', 'kitchen:operate'));
  assert.ok(!roleHas('kitchen', 'menu:manage'));
  assert.ok(roleHas('waiter', 'payments:collect', { grant: ['payments:collect'] }));
  assert.ok(!roleHas('manager', 'menu:manage', { revoke: ['menu:manage'] }));
  assert.ok(!roleHas('superadmin', 'orders:view'), 'super admin has no tenant permissions');
});

/* ---------- production hardening ---------- */
import { productionProblems, env, type Env } from '../../src/config/env';
import { subscriptionAllowsOperation, GRACE_DAYS } from '../../src/services/tenantResolver';

test('production config guard rejects placeholders, header tenancy, http and localhost', () => {
  const base = {
    NODE_ENV: 'production', PORT: 4000, MONGODB_URI: 'mongodb+srv://x', ROOT_DOMAIN: 'example.com', APP_PROTOCOL: 'https',
    CLIENT_ORIGIN: 'https://example.com', JWT_ACCESS_SECRET: 'a'.repeat(96), JWT_REFRESH_SECRET: 'b'.repeat(96), ACCESS_TOKEN_TTL: '15m',
    REFRESH_TOKEN_TTL_DAYS: 14, ENCRYPTION_KEY: 'c'.repeat(64), UPLOAD_DIR: 'uploads', MAX_UPLOAD_MB: 5, ALLOW_TENANT_HEADER: false,
    PUBLIC_API_URL: 'https://example.com', LOG_REQUESTS: true,
  } as Env;
  assert.deepEqual(productionProblems(base), []);
  assert.deepEqual(productionProblems({ ...base, NODE_ENV: 'development', APP_PROTOCOL: 'http' }), [], 'dev is not restricted');
  const bad = productionProblems({ ...base, ENCRYPTION_KEY: '0'.repeat(64), JWT_ACCESS_SECRET: 'replace-with-64+-random-hex-characters-------------------------', ALLOW_TENANT_HEADER: true, APP_PROTOCOL: 'http', ROOT_DOMAIN: 'localhost' });
  for (const needle of ['ENCRYPTION_KEY', 'JWT_ACCESS_SECRET', 'ALLOW_TENANT_HEADER', 'APP_PROTOCOL', 'ROOT_DOMAIN']) {
    assert.ok(bad.some((p) => p.includes(needle)), `missing problem for ${needle}`);
  }
  assert.ok(productionProblems({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET }).some((p) => p.includes('differ')));
});

test('subscription access honours the past-due grace window consistently', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  const day = 86400_000;
  const t = (status: string, periodEndOffsetDays: number, tenantStatus = 'active') => ({ status: tenantStatus, subscription: { status, currentPeriodEnd: new Date(now.getTime() + periodEndOffsetDays * day) } });
  assert.equal(subscriptionAllowsOperation(t('active', 3), now), true);
  assert.equal(subscriptionAllowsOperation(t('active', -1), now), true, 'active but just lapsed: grace, same as past_due');
  assert.equal(subscriptionAllowsOperation(t('past_due', -1), now), true);
  assert.equal(subscriptionAllowsOperation(t('active', -(GRACE_DAYS + 1)), now), false);
  assert.equal(subscriptionAllowsOperation(t('past_due', -(GRACE_DAYS + 1)), now), false);
  assert.equal(subscriptionAllowsOperation(t('expired', 10), now), false);
  assert.equal(subscriptionAllowsOperation(t('active', 10, 'suspended'), now), false);
  assert.equal(subscriptionAllowsOperation({ status: 'active', subscription: { status: 'trial', trialEndsAt: new Date(now.getTime() - 1) } }, now), false);
});

/* ---------- local subdomain URLs ---------- */
import { publicPort, tenantAppUrl, platformAppUrl, tableUrl, tenantLoginUrl } from '../../src/lib/appUrl';

const fakeReq = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] }) as any;

test('restaurant URLs and QR links are path-based by default and carry the browser port (dev), never a foreign host', () => {
  const req = fakeReq;
  // tests/env.ts: ROOT_DOMAIN=test.local, APP_PROTOCOL defaults to http, NODE_ENV=test, TENANT_URL_MODE default (path)
  assert.equal(env.TENANT_URL_MODE, 'path');
  assert.equal(tenantAppUrl('brost', req({ host: 'test.local:5173' })), 'http://test.local:5173/r/brost');
  assert.equal(tenantAppUrl('brost', req({ host: 'brost.test.local:5173', 'x-tenant-host': 'brost.test.local:5173' })), 'http://test.local:5173/r/brost');
  assert.equal(platformAppUrl(req({ host: 'test.local:4000' })), 'http://test.local:4000', 'single-service mode');
  assert.equal(tableUrl('brost', 'tok123', req({ host: 'test.local:5173' })), 'http://test.local:5173/r/brost/t/tok123');
  assert.equal(tenantLoginUrl('brost'), 'http://test.local/r/brost/login');
  // Foreign or malformed hosts never contribute anything.
  assert.equal(publicPort(req({ host: 'attacker.example:9999' })), '');
  assert.equal(publicPort(req({ host: 'test.local:5173/evil' })), '');
  assert.equal(publicPort(req({ host: 'test.local' })), '');
  assert.equal(tenantAppUrl('brost', req({ host: 'test.local:80' })), 'http://test.local/r/brost', 'default port omitted');
  assert.equal(tenantAppUrl('brost'), 'http://test.local/r/brost', 'no request → no port');
  assert.equal(tenantAppUrl('brost', req({ host: 'attacker.example:9999' })), 'http://test.local/r/brost');
});

test('TENANT_URL_MODE=subdomain still generates <slug>.ROOT_DOMAIN links', () => {
  const prev = env.TENANT_URL_MODE;
  (env as any).TENANT_URL_MODE = 'subdomain';
  try {
    assert.equal(tenantAppUrl('brost', fakeReq({ host: 'test.local:5173' })), 'http://brost.test.local:5173');
    assert.equal(tableUrl('brost', 'tok123', fakeReq({ host: 'brost.test.local:5173' })), 'http://brost.test.local:5173/t/tok123');
    assert.equal(tenantAppUrl('brost'), 'http://brost.test.local');
  } finally {
    (env as any).TENANT_URL_MODE = prev;
  }
});

test('production path URLs: https://ROOT_DOMAIN/r/<slug>, no port', () => {
  const prev = { ...env };
  Object.assign(env as any, { ROOT_DOMAIN: 'nftloyal.shop', APP_PROTOCOL: 'https', APP_PUBLIC_PORT: '' });
  try {
    assert.equal(tenantAppUrl('hahha'), 'https://nftloyal.shop/r/hahha');
    assert.equal(tableUrl('hahha', 'Qr_Tok-123'), 'https://nftloyal.shop/r/hahha/t/Qr_Tok-123');
    assert.equal(tenantLoginUrl('pizza'), 'https://nftloyal.shop/r/pizza/login');
    assert.equal(platformAppUrl(), 'https://nftloyal.shop');
  } finally {
    Object.assign(env as any, prev);
  }
});

test('restaurant slug from a URL path: strict slug syntax only, never a hostname', () => {
  assert.equal(tenantSlugFromPath('/r/hahha'), 'hahha');
  assert.equal(tenantSlugFromPath('/r/hahha/'), 'hahha');
  assert.equal(tenantSlugFromPath('/r/spice-garden/dashboard/orders'), 'spice-garden');
  assert.equal(tenantSlugFromPath('/r/pizza?x=1'), 'pizza');
  for (const p of ['/', '/admin', '/reserve', '/r', '/r/', '/r//x', '/r/Hahha', '/r/hahha.nftloyal.shop', '/r/nftloyal.shop', '/r/admin', '/r/www', '/r/a', '/r/-ab', '/r/ab-', '/r/%68ahha', '/x/r/hahha', undefined]) {
    assert.equal(tenantSlugFromPath(p as any), null, String(p));
  }
  assert.equal(isPathSlug('pizza'), true);
  assert.equal(isPathSlug('PIZZA'), false);
  assert.equal(isPathSlug('pizza.com'), false);
  assert.equal(isPathSlug('dashboard'), false);
  assert.equal(isPathSlug(42 as any), false);
});
