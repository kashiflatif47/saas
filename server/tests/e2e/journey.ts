/**
 * End-to-end business journey against the REAL built server (dist/) and the REAL built client (client/dist),
 * over real HTTP with real Host headers — exactly how browsers on <slug>.ROOT_DOMAIN talk to production.
 *
 * Two modes:
 *   npm run e2e                         boots an in-memory MongoDB + `node dist/server.js` itself (never touches
 *                                       your configured database) and runs the full journey.
 *   E2E_BASE_URL=https://example.com \
 *   E2E_ROOT_DOMAIN=example.com \
 *   E2E_SA_EMAIL=… E2E_SA_PASSWORD=… \
 *   npm run e2e                         runs the same journey against an already-running deployment
 *                                       (creates two clearly-labelled test tenants "e2e-…"; suspend them afterwards).
 *
 * Prerequisites for local mode: `npm run build` (server) and `npm --prefix ../client run build`.
 */
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

/* ------------------------------------------------------------------ setup */
const external = !!process.env.E2E_BASE_URL;
const PORT = Number(process.env.E2E_PORT ?? 4600 + Math.floor(Math.random() * 300));
const BASE = new URL(process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`);
const ROOT = process.env.E2E_ROOT_DOMAIN ?? 'localhost';
const SA_EMAIL = process.env.E2E_SA_EMAIL ?? 'e2e-superadmin@example.test';
const SA_PASSWORD = process.env.E2E_SA_PASSWORD ?? `E2e-${crypto.randomBytes(9).toString('base64url')}`;
const RUN = crypto.randomBytes(3).toString('hex');
const PW = `Owner-${crypto.randomBytes(9).toString('base64url')}`;

let passed = 0;
const results: { name: string; ok: boolean; ms: number; err?: string }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.info(`  ✔ ${name} (${Date.now() - t0}ms)`);
  } catch (e: any) {
    results.push({ name, ok: false, ms: Date.now() - t0, err: e?.message ?? String(e) });
    console.error(`  ✖ ${name}\n      ${e?.message ?? e}`);
    throw e;
  }
}

/* -------------------------------------------------------------- http client */
interface Res { status: number; headers: http.IncomingHttpHeaders; body: Buffer; json: any; text: string }

/** One browser-like client bound to a host: keeps its own cookie jar. */
class Client {
  cookies = new Map<string, string>();
  token = '';
  constructor(public host: string) {}

  async req(method: string, p: string, body?: unknown, opts: { form?: { field: string; filename: string; data: Buffer; type: string }; headers?: Record<string, string> } = {}): Promise<Res> {
    const headers: Record<string, string> = { Host: this.host, 'X-Tenant-Host': this.host, Accept: 'application/json', ...(opts.headers ?? {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload: Buffer | undefined;
    if (opts.form) {
      const boundary = `----e2e${crypto.randomBytes(8).toString('hex')}`;
      payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${opts.form.field}"; filename="${opts.form.filename}"\r\nContent-Type: ${opts.form.type}\r\n\r\n`),
        opts.form.data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
    }
    if (payload) headers['Content-Length'] = String(payload.length);
    const lib = BASE.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const r = lib.request(
        {
          protocol: BASE.protocol,
          hostname: BASE.hostname,
          port: BASE.port || (BASE.protocol === 'https:' ? 443 : 80),
          // Against a real deployment, connect to the tenant host itself (wildcard DNS + SNI).
          ...(external ? { hostname: this.host.split(':')[0], servername: this.host.split(':')[0] } : {}),
          method,
          path: p,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            for (const c of (res.headers['set-cookie'] ?? []) as string[]) {
              const [kv] = c.split(';');
              const [k, ...v] = kv.split('=');
              if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k.trim());
              else this.cookies.set(k.trim(), v.join('='));
            }
            const buf = Buffer.concat(chunks);
            const text = buf.toString('utf8');
            let json: any;
            try { json = JSON.parse(text); } catch { json = undefined; }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, json, text });
          });
        },
      );
      r.on('error', reject);
      r.setTimeout(30_000, () => r.destroy(new Error(`timeout ${method} ${p}`)));
      if (payload) r.write(payload);
      r.end();
    });
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  del = (p: string, b?: unknown) => this.req('DELETE', p, b);
}

const hostFor = (slug?: string) => `${slug ? `${slug}.` : ''}${ROOT}${external ? '' : `:${PORT}`}`;
const expectStatus = (r: Res, s: number, what: string) => assert.equal(r.status, s, `${what}: expected ${s}, got ${r.status} ${r.text.slice(0, 300)}`);

/** Small valid PNG (solid colour) generated in memory — a real image, not a stub. */
function makePng(w = 64, h = 64, rgb = [180, 83, 42]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return PNG.sync.write(png);
}

function decodeQr(buf: Buffer): string {
  const png = PNG.sync.read(buf);
  const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(code, 'QR code could not be decoded');
  return code!.data;
}

/* ------------------------------------------------------------ local server */
let server: ChildProcess | null = null;
let mongod: any = null;
const serverLog: string[] = [];

async function startLocal() {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  mongod = await MongoMemoryServer.create();
  const dist = path.resolve(__dirname, '../../dist/server.js');
  const clientDist = path.resolve(__dirname, '../../../client/dist');
  assert.ok(fs.existsSync(dist), 'server not built — run `npm run build`');
  assert.ok(fs.existsSync(path.join(clientDist, 'index.html')), 'client not built — run `npm --prefix ../client run build`');
  const uploads = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tablesaas-e2e-uploads-'));
  server = spawn(process.execPath, [dist], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      // Explicit values override anything in server/.env (dotenv never overrides existing variables).
      NODE_ENV: 'development',
      PORT: String(PORT),
      MONGODB_URI: mongod.getUri('tablesaas-e2e'),
      ROOT_DOMAIN: ROOT,
      // This journey exercises the subdomain mode (<slug>.ROOT_DOMAIN). Path mode (ROOT_DOMAIN/r/<slug>, the
      // default) is covered by tests/integration/pathTenancy.test.ts.
      TENANT_URL_MODE: 'subdomain',
      APP_PROTOCOL: 'http',
      CLIENT_ORIGIN: `http://${ROOT}:${PORT}`,
      PUBLIC_API_URL: `http://${ROOT}:${PORT}`,
      JWT_ACCESS_SECRET: crypto.randomBytes(48).toString('hex'),
      JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex'),
      ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      ALLOW_TENANT_HEADER: 'false',
      UPLOAD_DIR: uploads,
      SUPERADMIN_EMAIL: SA_EMAIL,
      SUPERADMIN_PASSWORD: SA_PASSWORD,
      CLIENT_DIST_DIR: clientDist,
      LOG_REQUESTS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d) => serverLog.push(String(d)));
  server.stderr!.on('data', (d) => serverLog.push(String(d)));
  const probe = new Client(hostFor());
  for (let i = 0; i < 120; i++) {
    try {
      if ((await probe.get('/api/health')).status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy:\n${serverLog.join('')}`);
}

async function stopLocal() {
  if (server) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (mongod) await mongod.stop();
}

/* ---------------------------------------------------------------- journey */
async function journey() {
  const platform = new Client(hostFor());
  const slugA = `e2e-bistro-${RUN}`;
  const slugB = `e2e-cafe-${RUN}`;
  const A = new Client(hostFor(slugA));
  const B = new Client(hostFor(slugB));
  const customer = new Client(hostFor(slugA));
  const ids: Record<string, any> = {};

  await step('health check reports database connected', async () => {
    const r = await platform.get('/api/health');
    expectStatus(r, 200, 'health');
    assert.equal(r.json.status, 'ok');
    assert.equal(r.json.db, 'connected');
  });

  await step('SPA is served on the platform host and on tenant hosts (deep links fall back to index.html)', async () => {
    for (const [c, p] of [[platform, '/login'], [A, '/'], [A, '/t/some-token'], [A, '/dashboard/menu']] as const) {
      const r = await c.req('GET', p, undefined, { headers: { Accept: 'text/html' } });
      expectStatus(r, 200, `GET ${c.host}${p}`);
      assert.match(r.text, /<div id="root"><\/div>/);
      assert.ok(String(r.headers['content-security-policy'] ?? '').includes("default-src 'self'"), 'CSP header missing');
    }
    const api404 = await platform.get('/api/does-not-exist');
    expectStatus(api404, 404, 'unknown API route');
    assert.equal(api404.json.error.code, 'NOT_FOUND');
  });

  await step('super admin signs in (bootstrapped from env) and sees default plans', async () => {
    const r = await platform.post('/api/auth/login', { email: SA_EMAIL, password: SA_PASSWORD });
    expectStatus(r, 200, 'super admin login');
    assert.equal(r.json.user.role, 'superadmin');
    platform.token = r.json.accessToken;
    assert.ok(platform.cookies.has('rt'), 'refresh cookie not set');
    const plans = await platform.get('/api/platform/plans');
    expectStatus(plans, 200, 'plans');
    assert.ok(plans.json.length >= 1, 'no plans');
    ids.plan = (plans.json.find((p: any) => p.code === 'pro') ?? plans.json[plans.json.length - 1])._id;
  });

  await step('super admin login is refused on a tenant host; wrong password is refused', async () => {
    expectStatus(await new Client(hostFor('nobody-here')).post('/api/auth/login', { email: SA_EMAIL, password: SA_PASSWORD }), 401, 'SA on tenant host');
    expectStatus(await new Client(hostFor()).post('/api/auth/login', { email: SA_EMAIL, password: 'wrong-password-123' }), 401, 'wrong password');
  });

  await step('super admin creates two independent restaurants with owner accounts', async () => {
    for (const [slug, name, key] of [[slugA, 'E2E Test Bistro', 'A'], [slugB, 'E2E Test Cafe', 'B']] as const) {
      const r = await platform.post('/api/platform/tenants', {
        name, slug, planId: ids.plan, businessType: 'restaurant', currency: 'PKR',
        contact: { email: `hello@${slug}.example.test`, city: 'Lahore' },
        owner: { name: `Owner ${key}`, email: `owner@${slug}.example.test`, password: PW },
      });
      expectStatus(r, 201, `provision ${slug}`);
      ids[`tenant${key}`] = r.json.tenant._id;
      assert.equal(r.json.url, `${BASE.protocol}//${hostFor(slug)}`, 'restaurant URL must include the port the browser uses');
    }
    const dup = await platform.post('/api/platform/tenants', { name: 'Dup', slug: slugA, planId: ids.plan, owner: { name: 'X Y', email: 'x@example.test', password: PW } });
    expectStatus(dup, 409, 'duplicate subdomain');
    const list = await platform.get(`/api/platform/tenants?q=${RUN}`);
    assert.equal(list.json.total, 2);
  });

  await step('super admin edits restaurant details and sees its accounts', async () => {
    expectStatus(await platform.patch(`/api/platform/tenants/${ids.tenantA}`, { contact: { phone: '+92 300 0000001' }, settings: { timezone: 'Asia/Karachi' } }), 200, 'edit tenant');
    const users = await platform.get(`/api/platform/tenants/${ids.tenantA}/users`);
    expectStatus(users, 200, 'tenant users');
    assert.deepEqual(users.json.items.map((u: any) => u.role), ['owner']);
    const detail = await platform.get(`/api/platform/tenants/${ids.tenantA}`);
    assert.equal(detail.json.tenant.contact.email, `hello@${slugA}.example.test`, 'partial edit wiped email');
    assert.equal(detail.json.tenant.contact.phone, '+92 300 0000001');
  });

  await step('restaurant owners sign in on their own subdomain only', async () => {
    for (const [c, slug] of [[A, slugA], [B, slugB]] as const) {
      const r = await c.post('/api/auth/login', { email: `owner@${slug}.example.test`, password: PW, tenantSlug: slug });
      expectStatus(r, 200, `owner login ${slug}`);
      assert.equal(r.json.tenant.slug, slug);
      assert.ok(r.json.permissions.includes('menu:manage'));
      c.token = r.json.accessToken;
    }
    const cross = await new Client(hostFor(slugB)).post('/api/auth/login', { email: `owner@${slugA}.example.test`, password: PW, tenantSlug: slugB });
    expectStatus(cross, 401, 'owner A on tenant B');
    const crossSlug = await new Client(hostFor(slugB)).post('/api/auth/login', { email: `owner@${slugA}.example.test`, password: PW, tenantSlug: slugA });
    expectStatus(crossSlug, 401, 'host/slug mismatch');
  });

  await step('owner configures profile, opening hours and branding — persisted after reload', async () => {
    expectStatus(await A.patch('/api/staff/tenant/settings', { contact: { address: '12 Mall Road', phone: '+92 42 1234567' }, settings: { openingHours: 'Daily 12:00 – 23:00', taxRatePercent: 16, serviceChargePercent: 5 } }), 200, 'settings');
    expectStatus(await A.patch('/api/staff/tenant/branding', { heroTitle: { en: 'Slow food, fast service' }, theme: { primary: '#0E7490', secondary: '#1F2937' } }), 200, 'branding');
    const logo = await A.req('POST', '/api/staff/tenant/branding/logo', undefined, { form: { field: 'file', filename: 'logo.png', data: makePng(128, 128), type: 'image/png' } });
    expectStatus(logo, 200, 'logo upload');
    ids.logoUrl = logo.json.url;
    assert.ok(ids.logoUrl.startsWith(`/uploads/${ids.tenantA}/branding/`));
    const reloaded = await A.get('/api/staff/tenant');
    assert.equal(reloaded.json.settings.openingHours, 'Daily 12:00 – 23:00');
    assert.equal(reloaded.json.contact.address, '12 Mall Road');
    assert.equal(reloaded.json.contact.email, `hello@${slugA}.example.test`, 'contact email lost');
    assert.equal(reloaded.json.branding.theme.primary, '#0E7490');
    assert.equal(reloaded.json.branding.logoUrl, ids.logoUrl);
    const img = await customer.get(ids.logoUrl);
    expectStatus(img, 200, 'logo served');
    assert.equal(img.headers['content-type'], 'image/png');
  });

  await step('upload validation rejects non-images and oversize payloads', async () => {
    const svg = await A.req('POST', '/api/staff/tenant/branding/logo', undefined, { form: { field: 'file', filename: 'x.png', data: Buffer.from('<svg onload="alert(1)"/>'), type: 'image/png' } });
    expectStatus(svg, 400, 'svg disguised as png');
    const big = await A.req('POST', '/api/staff/tenant/branding/hero', undefined, { form: { field: 'file', filename: 'big.png', data: Buffer.alloc(6 * 1024 * 1024, 1), type: 'image/png' } });
    expectStatus(big, 413, 'oversize upload');
  });

  await step('owner builds the menu: categories, dishes with options, photos, availability', async () => {
    const mains = await A.post('/api/staff/menu/categories', { name: { en: 'Mains', ur: 'مین کورس' } });
    expectStatus(mains, 201, 'category');
    const drinks = await A.post('/api/staff/menu/categories', { name: { en: 'Drinks' } });
    ids.mains = mains.json._id;
    ids.drinks = drinks.json._id;
    expectStatus(await A.post('/api/staff/menu/categories/reorder', { ids: [ids.drinks, ids.mains] }), 200, 'reorder');

    const karahi = await A.post('/api/staff/menu/products', { categoryId: ids.mains, name: { en: 'Chicken Karahi' }, description: { en: 'Tomato, chilli, ginger' }, price: 2400_00, variants: [{ name: 'Half', priceDelta: 0 }, { name: 'Full', priceDelta: 1800_00 }], addons: [{ name: 'Naan', price: 80_00 }], isFeatured: true });
    expectStatus(karahi, 201, 'product');
    ids.karahi = karahi.json;
    const chai = await A.post('/api/staff/menu/products', { categoryId: ids.drinks, name: { en: 'Kashmiri Chai' }, price: 350_00 });
    ids.chai = chai.json;
    const lassi = await A.post('/api/staff/menu/products', { categoryId: ids.drinks, name: { en: 'Mango Lassi' }, price: 450_00 });
    ids.lassi = lassi.json;

    const photo = await A.req('POST', `/api/staff/menu/products/${ids.karahi._id}/images`, undefined, { form: { field: 'files', filename: 'karahi.png', data: makePng(200, 150, [200, 60, 20]), type: 'image/png' } });
    expectStatus(photo, 200, 'product photo');
    assert.equal(photo.json.images.length, 1);
    ids.karahiImage = photo.json.images[0];
    expectStatus(await customer.get(ids.karahiImage), 200, 'product image served');

    expectStatus(await A.patch(`/api/staff/menu/products/${ids.lassi._id}`, { isAvailable: false }), 200, 'mark unavailable');
    const bad = await A.post('/api/staff/menu/products', { categoryId: ids.mains, name: { en: '' }, price: -5 });
    expectStatus(bad, 400, 'invalid product');
    const promo = await A.patch(`/api/staff/menu/products/${ids.chai._id}`, { promoPrice: 999_00 });
    expectStatus(promo, 400, 'promo above price');
  });

  await step('tables are created and their QR codes download, decode and point at this restaurant', async () => {
    const t = await A.post('/api/staff/tables', { count: 3, prefix: 'T', area: 'Main hall' });
    expectStatus(t, 201, 'tables');
    ids.table = t.json.items[0];
    const png = await A.get(`/api/staff/tables/${ids.table._id}/qr?download=1`);
    expectStatus(png, 200, 'QR png');
    assert.equal(png.headers['content-type'], 'image/png');
    assert.match(String(png.headers['content-disposition']), /attachment; filename=".*table-T1\.png"/);
    const url = decodeQr(png.body);
    assert.equal(url, `${BASE.protocol}//${hostFor(slugA)}/t/${ids.table.qrToken}`, 'QR encodes the wrong URL');
    ids.qrUrl = new URL(url);
    const svg = await A.get(`/api/staff/tables/${ids.table._id}/qr?format=svg&download=1`);
    expectStatus(svg, 200, 'QR svg');
    assert.match(svg.text, /^<svg/);
    const pdf = await A.get('/api/staff/tables/qr/print');
    expectStatus(pdf, 200, 'QR print PDF');
    assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  });

  await step('customer scans the QR: table resolves, branded storefront and menu load without login', async () => {
    const c = new Client(ids.qrUrl.host); // open the scanned URL exactly as encoded (host + port)
    const page = await c.req('GET', ids.qrUrl.pathname, undefined, { headers: { Accept: 'text/html' } });
    expectStatus(page, 200, 'QR landing page (SPA)');
    const table = await c.get(`/api/public/tables/${encodeURIComponent(ids.table.qrToken)}`);
    expectStatus(table, 200, 'table token');
    assert.equal(table.json.label, 'T1');
    const sf = await c.get('/api/public/storefront');
    expectStatus(sf, 200, 'storefront');
    assert.equal(sf.json.name, 'E2E Test Bistro');
    assert.equal(sf.json.branding.logoUrl, ids.logoUrl);
    assert.equal(sf.json.settings.openingHours, 'Daily 12:00 – 23:00');
    assert.equal(sf.json.payments.online, null, 'online payments shown without a verified provider');
    const menu = await c.get('/api/public/menu');
    expectStatus(menu, 200, 'menu');
    assert.deepEqual(menu.json.categories.map((x: any) => x.name.en), ['Drinks', 'Mains'], 'category order not persisted');
    const byName = Object.fromEntries(menu.json.products.map((p: any) => [p.name.en, p]));
    assert.equal(byName['Chicken Karahi'].images[0], ids.karahiImage);
    assert.equal(byName['Chicken Karahi'].effectivePrice, 2400_00);
    assert.equal(byName['Mango Lassi'].soldOut, true, 'unavailable item not flagged');
    assert.equal(byName['Kashmiri Chai'].soldOut, false);
    assert.equal(byName['Chicken Karahi'].recipe, undefined, 'recipe leaked to public');
    assert.equal(sf.json.payments.providerSecretEnc, undefined);
  });

  await step('customer places a QR order with server-side pricing and tracks it', async () => {
    const variant = ids.karahi.variants.find((v: any) => v.name === 'Full');
    const addon = ids.karahi.addons[0];
    const r = await customer.post('/api/public/orders', {
      type: 'dine_in', tableToken: ids.table.qrToken, customer: { name: 'Test Guest', phone: '03000000000' },
      items: [{ productId: ids.karahi._id, variantId: variant._id, addonIds: [addon._id], quantity: 1 }, { productId: ids.chai._id, quantity: 2 }],
    });
    expectStatus(r, 201, 'place order');
    const sub = 2400_00 + 1800_00 + 80_00 + 2 * 350_00;
    assert.equal(r.json.order.subtotal, sub);
    assert.equal(r.json.order.serviceCharge, Math.round(sub * 0.05));
    assert.equal(r.json.order.tableLabel, 'T1');
    ids.order = r.json.order;
    ids.tracking = r.json.trackingToken;
    const soldOut = await customer.post('/api/public/orders', { type: 'dine_in', tableToken: ids.table.qrToken, items: [{ productId: ids.lassi._id, quantity: 1 }] });
    expectStatus(soldOut, 400, 'ordering an unavailable item');
    const track = await customer.get(`/api/public/orders/${ids.order._id}?token=${ids.tracking}`);
    expectStatus(track, 200, 'tracking');
    assert.equal(track.json.status, 'pending');
    expectStatus(await customer.get(`/api/public/orders/${ids.order._id}?token=wrong-token-123`), 404, 'tracking with wrong token');
  });

  await step('staff accept the order and collect cash; payment is never marked paid without real collection', async () => {
    expectStatus(await A.post(`/api/staff/orders/${ids.order._id}/status`, { status: 'accepted' }), 200, 'accept');
    expectStatus(await A.post(`/api/staff/orders/${ids.order._id}/status`, { status: 'pending' }), 400, 'back to pending');
    const pay = await customer.post(`/api/public/orders/${ids.order._id}/pay`, { token: ids.tracking });
    expectStatus(pay, 400, 'online pay without a configured provider');
    const cash = await A.post(`/api/staff/orders/${ids.order._id}/payments/cash`, { amount: ids.order.total });
    expectStatus(cash, 201, 'cash');
    const track = await customer.get(`/api/public/orders/${ids.order._id}?token=${ids.tracking}`);
    assert.equal(track.json.paymentStatus, 'paid');
  });

  await step('menu changes persist across a fresh session', async () => {
    const fresh = new Client(hostFor(slugA));
    const login = await fresh.post('/api/auth/login', { email: `owner@${slugA}.example.test`, password: PW, tenantSlug: slugA });
    fresh.token = login.json.accessToken;
    const products = await fresh.get('/api/staff/menu/products?limit=50');
    assert.deepEqual(products.json.items.map((p: any) => p.name.en).sort(), ['Chicken Karahi', 'Kashmiri Chai', 'Mango Lassi']);
    const refreshed = await fresh.post('/api/auth/refresh');
    expectStatus(refreshed, 200, 'refresh rotates the session');
  });

  await step('tenant isolation holds between the two restaurants', async () => {
    expectStatus(await B.get(`/api/staff/menu/products/${ids.karahi._id}`), 404, 'B reads A product');
    expectStatus(await B.patch(`/api/staff/menu/products/${ids.karahi._id}`, { price: 1 }), 404, 'B edits A product');
    expectStatus(await B.get(`/api/staff/orders/${ids.order._id}`), 404, 'B reads A order');
    expectStatus(await B.get(`/api/staff/tables/${ids.table._id}/qr`), 404, 'B downloads A QR');
    const bProducts = await B.get('/api/staff/menu/products');
    assert.equal(bProducts.json.total, 0, 'B sees A products');
    // B's token presented on A's host
    const bOnA = new Client(hostFor(slugA));
    bOnA.token = B.token;
    expectStatus(await bOnA.get('/api/staff/menu/products'), 403, 'B token on A host');
    // A's QR token does not resolve on B's storefront
    expectStatus(await new Client(hostFor(slugB)).get(`/api/public/tables/${ids.table.qrToken}`), 404, 'A QR on B host');
    const bMenu = await new Client(hostFor(slugB)).get('/api/public/menu');
    assert.equal(bMenu.json.products.length, 0, 'A products on B storefront');
    // B tries to order A's product on its own storefront
    expectStatus(await new Client(hostFor(slugB)).post('/api/public/orders', { type: 'takeaway', items: [{ productId: ids.karahi._id, quantity: 1 }] }), 400, 'B storefront orders A product');
    // Restaurant admins cannot reach the platform API
    expectStatus(await A.get('/api/platform/tenants'), 403, 'tenant owner on platform API');
    expectStatus(await new Client(hostFor('no-such-restaurant')).get('/api/public/storefront'), 404, 'unknown tenant');
  });

  await step('unauthenticated, forged and malformed requests are rejected', async () => {
    const anon = new Client(hostFor(slugA));
    expectStatus(await anon.get('/api/staff/menu/products'), 401, 'no token');
    anon.token = `${A.token.slice(0, -4)}AAAA`;
    expectStatus(await anon.get('/api/staff/menu/products'), 401, 'tampered token');
    expectStatus(await A.get('/api/staff/menu/products/not-an-id'), 400, 'malformed id');
    expectStatus(await A.post('/api/staff/menu/categories', { name: { en: { $gt: '' } } }), 400, 'operator injection');
    const login = await new Client(hostFor()).post('/api/auth/login', { email: { $ne: null }, password: { $ne: null } });
    expectStatus(login, 400, 'NoSQL injection on login');
  });

  await step('suspending a restaurant takes its storefront offline and signs its staff out; reactivation restores it', async () => {
    expectStatus(await platform.post(`/api/platform/tenants/${ids.tenantB}/status`, { status: 'suspended', reason: 'e2e' }), 200, 'suspend');
    expectStatus(await new Client(hostFor(slugB)).get('/api/public/menu'), 503, 'suspended storefront');
    expectStatus(await B.get('/api/staff/menu/products'), 401, 'suspended staff session');
    expectStatus(await B.post('/api/auth/refresh'), 401, 'suspended refresh');
    expectStatus(await platform.post(`/api/platform/tenants/${ids.tenantB}/status`, { status: 'active' }), 200, 'reactivate');
    expectStatus(await new Client(hostFor(slugB)).get('/api/public/menu'), 200, 'storefront back');
  });

  await step('logout revokes the refresh session', async () => {
    expectStatus(await A.post('/api/auth/logout'), 200, 'logout');
    const afterLogout = await A.post('/api/auth/refresh');
    assert.ok(afterLogout.status === 204 || afterLogout.status === 401, `refresh after logout: got ${afterLogout.status}`);
    assert.equal(afterLogout.json?.accessToken, undefined, 'a session was issued after logout');
  });

  await step('platform overview reflects the new restaurants and order', async () => {
    const r = await platform.get('/api/platform/overview');
    expectStatus(r, 200, 'overview');
    assert.ok(r.json.totalTenants >= 2);
    assert.ok(r.json.orders30 >= 1);
  });

  if (external) {
    // Leave no live test restaurants online.
    await step('test restaurants are suspended after the run', async () => {
      for (const id of [ids.tenantA, ids.tenantB]) expectStatus(await platform.post(`/api/platform/tenants/${id}/status`, { status: 'suspended', reason: 'e2e test tenant' }), 200, 'suspend test tenant');
    });
  }

  return { slugA, table: ids.table, tracking: ids.tracking, order: ids.order };
}

async function main() {
  console.info(`TableSaaS E2E journey — ${external ? `against ${BASE.origin}` : `local built server on :${PORT} (in-memory MongoDB)`}`);
  if (!external) await startLocal();
  let info: Awaited<ReturnType<typeof journey>> | undefined;
  try {
    info = await journey();
  } finally {
    const out = process.env.E2E_REPORT;
    if (out) fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), base: BASE.origin, passed, total: results.length, results, info }, null, 2));
    if (process.env.E2E_KEEP_SERVER === '1' && !external) {
      console.info(`\nServer kept running on :${PORT} (E2E_KEEP_SERVER=1). Super admin: ${SA_EMAIL} / ${SA_PASSWORD}`);
      console.info(`Tenant: http://${info?.slugA}.${ROOT}:${PORT}/   QR: http://${info?.slugA}.${ROOT}:${PORT}/t/${info?.table?.qrToken}`);
      console.info(`OWNER_PASSWORD=${PW}`);
      await new Promise(() => undefined);
    }
    if (!external) await stopLocal();
  }
  console.info(`\n${passed}/${results.length} steps passed`);
}

main().catch(async (e) => {
  if (serverLog.length && !external) console.error('\n--- server log (tail) ---\n' + serverLog.join('').split('\n').slice(-40).join('\n'));
  await stopLocal().catch(() => undefined);
  console.error(`\nE2E FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
