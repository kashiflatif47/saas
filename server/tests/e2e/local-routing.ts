/**
 * Local multi-tenant subdomain routing check — runs against YOUR running `npm run dev`
 * (Vite on :5173 proxying to the API on :4000), exactly the way a browser on brost.localhost:5173 talks to it.
 *
 *   cd server
 *   LOCAL_SA_EMAIL=you@example.com LOCAL_SA_PASSWORD='…' npm run test:local-routing
 *
 * Optional: LOCAL_APP_PORT (default 5173).
 *
 * It WRITES to the database your dev server uses: it creates two restaurants named
 * `routing-test-<id>-a` / `-b` (with a table and a dish each) and SUSPENDS them at the end.
 * Point your dev server at a development database, never at production data.
 *
 * Windows does not resolve *.localhost (browsers do, internally), so this script connects to `localhost`
 * and sends the restaurant hostname in the Host header — byte-for-byte what the browser sends.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const PORT = Number(process.env.LOCAL_APP_PORT ?? 5173);
const SA_EMAIL = process.env.LOCAL_SA_EMAIL;
const SA_PASSWORD = process.env.LOCAL_SA_PASSWORD;
const RUN = crypto.randomBytes(3).toString('hex');
const PW = `Owner-${crypto.randomBytes(9).toString('base64url')}`;

interface Res { status: number; headers: http.IncomingHttpHeaders; body: Buffer; json: any; text: string }

class Browser {
  cookies = new Map<string, string>();
  token = '';
  /** host = what the browser address bar shows, e.g. brost.localhost:5173 */
  constructor(public host: string) {}
  req(method: string, path: string, body?: unknown): Promise<Res> {
    const headers: Record<string, string> = { Host: this.host, 'X-Tenant-Host': this.host, Accept: 'application/json, text/html' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(payload.length); }
    return new Promise((resolve, reject) => {
      const r = http.request({ host: 'localhost', port: PORT, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          for (const c of (res.headers['set-cookie'] ?? []) as string[]) {
            const [kv] = c.split(';');
            const [k, ...v] = kv.split('=');
            if (/Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(c)) this.cookies.delete(k.trim());
            else this.cookies.set(k.trim(), v.join('='));
          }
          const buf = Buffer.concat(chunks);
          let json: any;
          try { json = JSON.parse(buf.toString('utf8')); } catch { /* html */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, json, text: buf.toString('utf8') });
        });
      });
      r.on('error', reject);
      r.setTimeout(30_000, () => r.destroy(new Error(`timeout ${method} ${path}`)));
      if (payload) r.write(payload);
      r.end();
    });
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.info(`  ✔ ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, detail: e?.message });
    console.error(`  ✖ ${name}\n      ${e?.message}`);
    throw e;
  }
}
const is = (r: Res, s: number, what: string) => assert.equal(r.status, s, `${what}: expected ${s}, got ${r.status} ${r.text.slice(0, 200)}`);

async function main() {
  if (!SA_EMAIL || !SA_PASSWORD) throw new Error('Set LOCAL_SA_EMAIL and LOCAL_SA_PASSWORD (your local super admin) — see TABLESAAS_LOCAL_DEVELOPMENT_GUIDE.md');
  const app = `localhost:${PORT}`;
  const slugA = `routing-test-${RUN}-a`;
  const slugB = `routing-test-${RUN}-b`;
  const platform = new Browser(app);
  const A = new Browser(`${slugA}.localhost:${PORT}`);
  const B = new Browser(`${slugB}.localhost:${PORT}`);
  const ids: Record<string, any> = {};
  console.info(`Local routing check against http://localhost:${PORT} (dev server) — run ${RUN}`);

  await check(`platform host http://localhost:${PORT} serves the app`, async () => {
    const r = await platform.get('/');
    is(r, 200, 'GET /');
    assert.match(r.text, /<div id="root">/);
  });

  await check('dev server accepts *.localhost hosts but rejects foreign hosts (DNS-rebinding protection on)', async () => {
    is(await A.get('/'), 200, `GET http://${A.host}/`);
    const foreign = await new Browser(`attacker.example:${PORT}`).get('/');
    assert.equal(foreign.status, 403, `foreign Host should be blocked by Vite, got ${foreign.status}`);
  });

  await check('super admin signs in on localhost', async () => {
    const r = await platform.post('/api/auth/login', { email: SA_EMAIL, password: SA_PASSWORD });
    is(r, 200, 'super admin login');
    platform.token = r.json.accessToken;
    const plans = await platform.get('/api/platform/plans');
    ids.plan = plans.json.find((p: any) => p.isActive)?._id;
    assert.ok(ids.plan, 'no active plan');
  });

  await check('creating restaurants returns their working local URLs (with the dev port)', async () => {
    for (const [slug, key] of [[slugA, 'A'], [slugB, 'B']] as const) {
      const r = await platform.post('/api/platform/tenants', { name: `Routing Test ${key}`, slug, planId: ids.plan, owner: { name: `Owner ${key}`, email: `owner@${slug}.example.test`, password: PW } });
      is(r, 201, `create ${slug}`);
      assert.equal(r.json.url, `http://${slug}.localhost:${PORT}`);
      ids[`tenant${key}`] = r.json.tenant._id;
      const detail = await platform.get(`/api/platform/tenants/${r.json.tenant._id}`);
      assert.equal(detail.json.url, `http://${slug}.localhost:${PORT}`, 'super admin "open restaurant" link');
    }
  });

  await check('each subdomain resolves its own restaurant; unknown slug → 404; platform host has no restaurant', async () => {
    const a = await A.get('/api/public/storefront');
    is(a, 200, 'storefront A');
    assert.equal(a.json.slug, slugA);
    const b = await B.get('/api/public/storefront');
    assert.equal(b.json.slug, slugB);
    const unknown = await new Browser(`no-such-${RUN}.localhost:${PORT}`).get('/api/public/storefront');
    is(unknown, 404, 'unknown restaurant');
    assert.equal(unknown.json.error.message, 'Restaurant not found');
    is(await platform.get('/api/public/storefront'), 404, 'platform host storefront');
  });

  await check('restaurant admins sign in on their own subdomain only; session cookie stays on that subdomain', async () => {
    const r = await A.post('/api/auth/login', { email: `owner@${slugA}.example.test`, password: PW, tenantSlug: slugA });
    is(r, 200, 'owner A login');
    A.token = r.json.accessToken;
    const setCookie = String((r.headers['set-cookie'] as unknown as string[])?.find((c) => c.startsWith('rt=')));
    assert.ok(!/;\s*domain=/i.test(setCookie), `refresh cookie must be host-only, got: ${setCookie.replace(/rt=[^;]+/, 'rt=…')}`);
    const rb = await B.post('/api/auth/login', { email: `owner@${slugB}.example.test`, password: PW, tenantSlug: slugB });
    is(rb, 200, 'owner B login');
    B.token = rb.json.accessToken;
    is(await B.post('/api/auth/login', { email: `owner@${slugA}.example.test`, password: PW, tenantSlug: slugA }), 401, 'owner A on B host');
    is(await A.post('/api/auth/refresh'), 200, 'refresh on own subdomain');
    const stolen = new Browser(B.host);
    stolen.cookies = new Map(A.cookies);
    is(await stolen.post('/api/auth/refresh'), 401, "A's session cookie replayed on B's subdomain");
  });

  await check('API calls from subdomains work and stay tenant-isolated', async () => {
    const cat = await A.post('/api/staff/menu/categories', { name: { en: 'Mains' } });
    is(cat, 201, 'category');
    const prod = await A.post('/api/staff/menu/products', { categoryId: cat.json._id, name: { en: `Dish ${RUN}` }, price: 500_00 });
    is(prod, 201, 'product');
    ids.product = prod.json._id;
    const own = await A.get('/api/staff/tenant');
    assert.equal(own.json.url, `http://${slugA}.localhost:${PORT}`, 'owner Settings storefront address');
    is(await B.get(`/api/staff/menu/products/${ids.product}`), 404, 'B reads A dish');
    const crossHost = new Browser(A.host);
    crossHost.token = B.token;
    is(await crossHost.get('/api/staff/menu/products'), 403, "B's token used on A's subdomain");
    const menuB = await B.get('/api/public/menu');
    assert.equal(menuB.json.products.length, 0, "A's dish visible on B's menu");
  });

  await check('QR codes encode the restaurant’s local URL and open its customer menu', async () => {
    const t = await A.post('/api/staff/tables', { label: 'T1' });
    is(t, 201, 'table');
    const list = await A.get('/api/staff/tables');
    const table = list.json.items[0];
    const expected = `http://${slugA}.localhost:${PORT}/t/${table.qrToken}`;
    assert.equal(table.qrUrl, expected, 'Tables page link');
    const png = await A.get(`/api/staff/tables/${table._id}/qr?download=1`);
    is(png, 200, 'QR png');
    const img = PNG.sync.read(png.body);
    const decoded = jsQR(new Uint8ClampedArray(img.data), img.width, img.height)?.data;
    assert.equal(decoded, expected, 'decoded QR');
    const svg = await A.get(`/api/staff/tables/${table._id}/qr?format=svg`);
    is(svg, 200, 'QR svg');
    // Open the decoded URL like a phone/browser would.
    const u = new URL(decoded!);
    const customer = new Browser(u.host);
    is(await customer.get(u.pathname), 200, 'QR landing page');
    const tr = await customer.get(`/api/public/tables/${encodeURIComponent(table.qrToken)}`);
    is(tr, 200, 'QR token resolves');
    assert.equal(tr.json.label, 'T1');
    const menu = await customer.get('/api/public/menu');
    assert.ok(menu.json.products.some((p: any) => p.name.en === `Dish ${RUN}`), 'menu shows the restaurant’s dish');
    is(await B.get(`/api/public/tables/${encodeURIComponent(table.qrToken)}`), 404, "A's QR on B's subdomain");
    const order = await customer.post('/api/public/orders', { type: 'dine_in', tableToken: table.qrToken, items: [{ productId: ids.product, quantity: 1 }] });
    is(order, 201, 'customer order from the QR menu');
    assert.equal(order.json.order.tableLabel, 'T1');
  });

  await check('test restaurants are suspended (cleanup)', async () => {
    for (const id of [ids.tenantA, ids.tenantB]) is(await platform.post(`/api/platform/tenants/${id}/status`, { status: 'suspended', reason: 'local routing test' }), 200, 'suspend');
  });

  console.info(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}

main().catch((e) => {
  console.error(`\nLOCAL ROUTING CHECK FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
