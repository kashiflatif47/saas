/**
 * Permanent media storage end to end — AGAINST LOCAL MOCK PROVIDERS (no real Cloudinary or S3 account is used):
 *  - a fake Cloudinary API that checks request signatures like the real one;
 *  - a fake S3-compatible endpoint that re-computes every AWS SigV4 signature from the request it receives.
 * Covers the three ways to add an image, attaching, replacement, provider errors, a simulated redeploy, legacy
 * migration, provider switching, deletion safeguards, tenant isolation and that secrets never leave the server.
 */
import '../env';
import { auth, bootstrapPlatform, provisionTenant, startDb, stopDb } from '../helpers';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import multer from 'multer';
import request from 'supertest';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { Asset } from '../../src/models/storage';
import { Product, Category } from '../../src/models/menu';
import { Tenant } from '../../src/models/platform';
import { cloudinarySignature } from '../../src/lib/storage/providers';
import { signRequest } from '../../src/lib/storage/sigv4';
import { importFetcher, invalidateStorageConfig } from '../../src/services/media';
import { migrateTenantMedia } from '../../src/services/mediaMigration';
import { RemoteImageError } from '../../src/lib/storage/remote';

let mongod: Awaited<ReturnType<typeof startDb>>;
let app = createApp();
let saToken: string;
let A: Awaited<ReturnType<typeof provisionTenant>>;
let B: Awaited<ReturnType<typeof provisionTenant>>;
const ids: Record<string, any> = {};
const png = (seed: number) => {
  // A valid PNG header + unique bytes (content sniffing only needs the signature).
  const head = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000000', 'hex');
  return Buffer.concat([head, crypto.randomBytes(64), Buffer.from([seed])]);
};
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const SECRETS = { cloudinary: 'cld-secret-DO-NOT-LEAK-123', s3: 's3-secret-DO-NOT-LEAK-456' };

/* ---------------- mock Cloudinary ---------------- */
const cld = { objects: new Map<string, Buffer>(), fail: false, base: '' };
const cldApp = express();
const upload = multer({ storage: multer.memoryStorage() });
const basicOk = (req: express.Request) => req.headers.authorization === `Basic ${Buffer.from(`cld-key:${SECRETS.cloudinary}`).toString('base64')}`;
cldApp.post('/v1_1/:cloud/image/upload', upload.single('file'), (req, res) => {
  if (cld.fail) return void res.status(500).json({ error: { message: 'Internal error' } });
  const { signature, api_key, ...params } = req.body;
  if (api_key !== 'cld-key' || signature !== cloudinarySignature(params, SECRETS.cloudinary)) return void res.status(401).json({ error: { message: 'Invalid Signature' } });
  if (cld.objects.has(params.public_id) && params.overwrite === 'false') return void res.status(409).json({ error: { message: 'exists' } });
  cld.objects.set(params.public_id, req.file!.buffer);
  res.json({ public_id: params.public_id, secure_url: `${cld.base}/res/${params.public_id}`, bytes: req.file!.buffer.length, format: 'png' });
});
cldApp.get(/^\/res\/(.+)$/, (req, res) => {
  const b = cld.objects.get((req.params as any)[0]);
  if (!b) return void res.status(404).end();
  res.type('image/png').send(b);
});
cldApp.get(/^\/v1_1\/[^/]+\/resources\/image\/upload\/(.+)$/, (req, res) => {
  if (!basicOk(req)) return void res.status(401).json({ error: { message: 'bad credentials' } });
  const b = cld.objects.get(decodeURIComponent((req.params as any)[0]));
  if (!b) return void res.status(404).json({ error: { message: 'not found' } });
  res.json({ bytes: b.length });
});
cldApp.post('/v1_1/:cloud/image/destroy', upload.none(), (req, res) => {
  const { signature, api_key, ...params } = req.body;
  if (signature !== cloudinarySignature(params, SECRETS.cloudinary)) return void res.status(401).json({ error: { message: 'Invalid Signature' } });
  cld.objects.delete(params.public_id);
  res.json({ result: 'ok' });
});
cldApp.get('/v1_1/:cloud/ping', (req, res) => (basicOk(req) ? res.json({ status: 'ok' }) : res.status(401).json({ error: { message: 'bad' } })));

/* ---------------- mock S3-compatible endpoint (path style) ---------------- */
const s3 = { objects: new Map<string, { body: Buffer; type: string; sha: string }>(), fail: false, base: '' };
const s3Server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname.startsWith('/public/')) {
      // CDN / public bucket delivery (unsigned)
      const o = s3.objects.get(decodeURIComponent(url.pathname.slice('/public/'.length)));
      res.writeHead(o ? 200 : 404, { 'content-type': o?.type ?? 'text/plain' }).end(o?.body);
      return;
    }
    // Public bucket: anonymous GET is allowed (as with a real public S3/R2 bucket); everything else must be signed.
    if (!req.headers.authorization && req.method === 'GET') {
      const [, bkt, ...k] = decodeURIComponent(url.pathname).split('/');
      const o = bkt === 'menu-images' ? s3.objects.get(k.join('/')) : undefined;
      res.writeHead(o ? 200 : 404, { 'content-type': o?.type ?? 'text/plain' }).end(o?.body);
      return;
    }
    // Verify the SigV4 signature exactly as an S3 server would (same host header the client really sent).
    const authz = String(req.headers.authorization ?? '');
    const signed = /SignedHeaders=([^,]+)/.exec(authz)?.[1].split(';') ?? [];
    const extra = Object.fromEntries(signed.filter((h) => !['host', 'x-amz-date', 'x-amz-content-sha256'].includes(h)).map((h) => [h, String(req.headers[h])]));
    const amz = String(req.headers['x-amz-date']);
    const now = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
    const expect = signRequest({ method: req.method!, host: String(req.headers.host), path: decodeURIComponent(url.pathname), headers: extra, payloadHash: String(req.headers['x-amz-content-sha256']), accessKeyId: 's3-key', secretAccessKey: SECRETS.s3, region: 'auto', now }).authorization;
    if (authz !== expect) return void res.writeHead(403).end('SignatureDoesNotMatch');
    if (s3.fail) return void res.writeHead(500).end();
    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
    if (bucket !== 'menu-images') return void res.writeHead(404).end();
    const key = rest.join('/');
    if (req.method === 'HEAD' && !key) return void res.writeHead(200).end();
    const o = s3.objects.get(key);
    if (req.method === 'PUT') {
      const body = Buffer.concat(chunks);
      s3.objects.set(key, { body, type: String(req.headers['content-type']), sha: String(req.headers['x-amz-meta-sha256']) });
      return void res.writeHead(200, { etag: '"x"' }).end();
    }
    if (!o) return void res.writeHead(404).end();
    if (req.method === 'HEAD') return void res.writeHead(200, { 'content-length': o.body.length, 'x-amz-meta-sha256': o.sha }).end();
    if (req.method === 'GET') return void res.writeHead(200, { 'content-type': o.type }).end(o.body);
    if (req.method === 'DELETE') {
      s3.objects.delete(key);
      return void res.writeHead(204).end();
    }
    res.writeHead(405).end();
  });
});

let cldServer: http.Server;
before(async () => {
  mongod = await startDb();
  cldServer = cldApp.listen(0);
  await new Promise<void>((r) => s3Server.listen(0, r));
  cld.base = `http://127.0.0.1:${(cldServer.address() as AddressInfo).port}`;
  s3.base = `http://127.0.0.1:${(s3Server.address() as AddressInfo).port}`;
  (env as any).CLOUDINARY_API_BASE_URL = cld.base;
  const p = await bootstrapPlatform(app);
  saToken = p.saToken;
  A = await provisionTenant(app, saToken, p.planId, 'media-a');
  B = await provisionTenant(app, saToken, p.planId, 'media-b');
  ids.cat = (await request(app).post('/api/staff/menu/categories').set(auth(A.token)).send({ name: { en: 'Rice' } })).body._id;
  ids.dish = (await request(app).post('/api/staff/menu/products').set(auth(A.token)).send({ categoryId: ids.cat, name: { en: 'Chicken Biryani' }, price: 70000 })).body._id;
});

after(async () => {
  // fetch() keeps connections alive; close them so the test process can exit.
  cldServer.closeAllConnections();
  s3Server.closeAllConnections();
  cldServer.close();
  s3Server.close();
  await stopDb(mongod);
});

const uploadTo = (token: string, provider: string | undefined, file: Buffer, purpose = 'product') => {
  const r = request(app).post('/api/staff/assets').set(auth(token)).field('purpose', purpose);
  if (provider) r.field('provider', provider);
  return r.attach('file', file, 'photo.png');
};

test('without any cloud provider the admin is told clearly which options are missing', async () => {
  const s = (await request(app).get('/api/staff/assets/storage').set(auth(A.token))).body;
  assert.equal(s.cloudinary.configured, false);
  assert.equal(s.s3.configured, false);
  const r = await uploadTo(A.token, 'cloudinary', png(1));
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'STORAGE_NOT_CONFIGURED');
  assert.equal(await Asset.countDocuments({ tenantId: A.tenantId }), 0, 'nothing recorded');
});

test('platform admin configures both providers; secrets are encrypted, never returned, and connections are tested', async () => {
  const bad = await request(app).put('/api/platform/storage').set(auth(saToken)).send({ cloudinary: { cloudName: 'demo', apiKey: 'cld-key', apiSecret: 'wrong-secret' } });
  assert.equal(bad.status, 200);
  const badTest = await request(app).post('/api/platform/storage/test').set(auth(saToken)).send({ provider: 'cloudinary' });
  assert.equal(badTest.status, 502);
  assert.match(badTest.body.error.message, /Cloudinary rejected the API key or secret/);

  const put = await request(app).put('/api/platform/storage').set(auth(saToken)).send({
    s3: { endpoint: 'http://minio.example.com', region: 'auto', bucket: 'menu-images', accessKeyId: 's3-key', secretAccessKey: SECRETS.s3 },
  });
  assert.equal(put.status, 400, 'plain-http endpoints are refused (only a local development endpoint may use http)');
  const put2 = await request(app).put('/api/platform/storage').set(auth(saToken)).send({
    defaultProvider: 'cloudinary',
    cloudinary: { cloudName: 'demo', apiKey: 'cld-key', apiSecret: SECRETS.cloudinary, folder: 'tablesaas' },
    s3: { endpoint: s3.base.replace('127.0.0.1', 'localhost'), region: 'auto', bucket: 'menu-images', accessKeyId: 's3-key', secretAccessKey: SECRETS.s3, forcePathStyle: true },
  });
  assert.equal(put2.status, 200, JSON.stringify(put2.body));
  const everything = JSON.stringify(put2.body) + JSON.stringify((await request(app).get('/api/platform/storage').set(auth(saToken))).body) + JSON.stringify((await request(app).get('/api/staff/assets/storage').set(auth(A.token))).body);
  for (const s of Object.values(SECRETS)) assert.ok(!everything.includes(s), 'secret leaked in an API response');
  assert.equal(put2.body.config.cloudinary.hasSecret, true);
  const raw: any = await (await import('../../src/models/storage')).StorageConfig.findById('storage').select('+cloudinary.apiSecretEnc').lean();
  assert.ok(raw.cloudinary.apiSecretEnc && !raw.cloudinary.apiSecretEnc.includes(SECRETS.cloudinary), 'stored encrypted');
  assert.deepEqual((await request(app).post('/api/platform/storage/test').set(auth(saToken)).send({ provider: 'cloudinary' })).body, { ok: true });
  assert.deepEqual((await request(app).post('/api/platform/storage/test').set(auth(saToken)).send({ provider: 's3' })).body, { ok: true });
  assert.equal((await request(app).put('/api/platform/storage').set(auth(A.token)).send({ defaultProvider: 's3' })).status, 403, 'restaurant staff cannot change storage');
});

test('Option A — Cloudinary: upload, metadata, stable /media address, attached as logo', async () => {
  const file = png(2);
  const r = await uploadTo(A.token, 'cloudinary', file, 'branding');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = r.body;
  assert.equal(a.provider, 'cloudinary');
  assert.match(a.url, /^\/media\/[a-f0-9]{24}$/);
  assert.equal(a.size, file.length);
  assert.equal(a.sha256, sha(file));
  assert.equal(a.mime, 'image/png');
  const stored = await Asset.findOne({ tenantId: A.tenantId, _id: a._id }).lean();
  assert.match(stored!.key, new RegExp(`^tablesaas/tenants/${A.tenantId}/branding/[a-f0-9]{32}$`));
  assert.ok(cld.objects.has(stored!.key), 'bytes are at the provider');
  const media = await request(app).get(a.url);
  assert.equal(media.status, 302);
  assert.equal(media.headers.location, `${cld.base}/res/${stored!.key}`);
  const set = await request(app).put('/api/staff/tenant/branding/logo').set(auth(A.token)).send({ assetId: a._id });
  assert.equal(set.status, 200);
  ids.logoAsset = a._id;
  const sf = (await request(app).get(`/api/public/tenants/${A.slug}/storefront`)).body;
  assert.equal(sf.branding.logoUrl, a.url);
});

test('Option B — S3-compatible: upload with verified key/checksum, public delivery, attached to a dish', async () => {
  const file = png(3);
  const r = await uploadTo(A.token, 's3', file);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const stored = await Asset.findOne({ tenantId: A.tenantId, _id: r.body._id }).lean();
  assert.equal(stored!.provider, 's3');
  assert.equal(stored!.bucket, 'menu-images');
  assert.match(stored!.key, new RegExp(`^tenants/${A.tenantId}/product/[a-f0-9]{32}\\.png$`));
  const obj = s3.objects.get(stored!.key)!;
  assert.equal(obj.sha, sha(file), 'checksum stored with the object');
  assert.equal(obj.type, 'image/png');
  const att = await request(app).post(`/api/staff/menu/products/${ids.dish}/images/attach`).set(auth(A.token)).send({ assetId: r.body._id });
  assert.deepEqual(att.body.images, [r.body.url]);
  const media = await request(app).get(r.body.url);
  assert.equal(media.status, 302);
  const back = await fetch(media.headers.location);
  assert.equal(back.status, 200);
  assert.equal(sha(Buffer.from(await back.arrayBuffer())), sha(file), 'the browser gets the same bytes');
  ids.dishAsset = r.body._id;
});

test('replacing an image keeps the previous one (retired, still stored, restorable)', async () => {
  const before = await Asset.findOne({ tenantId: A.tenantId, _id: ids.logoAsset }).lean();
  const r = await uploadTo(A.token, 'cloudinary', png(4), 'branding');
  await request(app).put('/api/staff/tenant/branding/logo').set(auth(A.token)).send({ assetId: r.body._id }).expect(200);
  const old = await Asset.findOne({ tenantId: A.tenantId, _id: ids.logoAsset }).lean();
  assert.equal(old!.status, 'replaced');
  assert.ok(cld.objects.has(before!.key), 'old bytes not deleted');
  assert.equal((await request(app).get(`/media/${ids.logoAsset}`)).status, 302, 'old address still works (e.g. cached pages)');
  // Restoring: attach the old one again.
  await request(app).put('/api/staff/tenant/branding/logo').set(auth(A.token)).send({ assetId: ids.logoAsset }).expect(200);
  assert.equal((await Asset.findOne({ tenantId: A.tenantId, _id: ids.logoAsset }).lean())!.status, 'active');
});

test('a provider failure is reported, saves nothing and leaves the record untouched', async () => {
  const dishBefore = (await Product.findOne({ tenantId: A.tenantId, _id: ids.dish }).lean())!.images;
  const count = await Asset.countDocuments({ tenantId: A.tenantId });
  s3.fail = true;
  const r = await request(app).post(`/api/staff/menu/products/${ids.dish}/images`).set(auth(A.token)).attach('files', png(5), 'x.png');
  s3.fail = false;
  // Default provider is Cloudinary; make it fail too to test both paths.
  cld.fail = true;
  const r2 = await uploadTo(A.token, 'cloudinary', png(6));
  cld.fail = false;
  assert.equal(r2.status, 502);
  assert.equal(r2.body.error.code, 'STORAGE_ERROR');
  assert.match(r2.body.error.message, /Cloudinary upload failed/);
  assert.ok(!JSON.stringify(r2.body).includes(SECRETS.cloudinary));
  assert.equal(r.status, 200, 'dish upload used the default provider (Cloudinary), unaffected by S3 being down');
  const s3Down = await (async () => { s3.fail = true; const x = await uploadTo(A.token, 's3', png(7)); s3.fail = false; return x; })();
  assert.equal(s3Down.status, 502);
  assert.equal(await Asset.countDocuments({ tenantId: A.tenantId }), count + 1, 'only the successful upload was recorded');
  assert.equal((await Product.findOne({ tenantId: A.tenantId, _id: ids.dish }).lean())!.images.length, dishBefore.length + 1);
});

test('Option C — linked https image: validated without fetching, previewable, attachable; unsafe links refused', async () => {
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://cdn.example.com/a.png', 'https://127.0.0.1/a.png', 'https://localhost/x.png']) {
    const r = await request(app).post('/api/staff/assets/external').set(auth(A.token)).send({ url, purpose: 'category' });
    assert.equal(r.status, 400, url);
  }
  const r = await request(app).post('/api/staff/assets/external').set(auth(A.token)).send({ url: 'https://images.example.com/rice.jpg', purpose: 'category' });
  assert.equal(r.status, 201);
  assert.equal(r.body.provider, 'external');
  assert.equal(r.body.verifyStatus, 'unverifiable', 'availability depends on the original host');
  await request(app).put(`/api/staff/menu/categories/${ids.cat}/image`).set(auth(A.token)).send({ assetId: r.body._id }).expect(200);
  assert.equal((await Category.findOne({ tenantId: A.tenantId, _id: ids.cat }).lean())!.imageUrl, r.body.url);
  assert.equal((await request(app).get(r.body.url)).headers.location, 'https://images.example.com/rice.jpg');
  ids.external = r.body._id;
});

test('import a linked image into cloud storage: same address, bytes now permanent; failures change nothing', async () => {
  const original = importFetcher.fetch;
  importFetcher.fetch = async () => { throw new RemoteImageError('The image could not be downloaded (HTTP 404)'); };
  const fail = await request(app).post(`/api/staff/assets/${ids.external}/import`).set(auth(A.token)).send({ provider: 's3' });
  assert.equal(fail.status, 400);
  assert.equal((await Asset.findOne({ tenantId: A.tenantId, _id: ids.external }).lean())!.provider, 'external', 'unchanged');
  const file = png(8);
  importFetcher.fetch = async () => ({ buffer: file, mime: 'image/png', ext: 'png' });
  const ok = await request(app).post(`/api/staff/assets/${ids.external}/import`).set(auth(A.token)).send({ provider: 's3' });
  importFetcher.fetch = original;
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const a = await Asset.findOne({ tenantId: A.tenantId, _id: ids.external }).lean();
  assert.equal(a!.provider, 's3');
  assert.equal(a!.sourceUrl, 'https://images.example.com/rice.jpg');
  assert.equal(a!.history[0].provider, 'external');
  assert.equal(s3.objects.get(a!.key)!.sha, sha(file));
  assert.equal((await Category.findOne({ tenantId: A.tenantId, _id: ids.cat }).lean())!.imageUrl, `/media/${ids.external}`, 'the category did not need to change');
});

test('switching provider: copy Cloudinary → S3 keeps the address and the Cloudinary original', async () => {
  const before = await Asset.findOne({ tenantId: A.tenantId, _id: ids.logoAsset }).lean();
  const r = await request(app).post(`/api/staff/assets/${ids.logoAsset}/migrate`).set(auth(A.token)).send({ provider: 's3' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await Asset.findOne({ tenantId: A.tenantId, _id: ids.logoAsset }).lean();
  assert.equal(after!.provider, 's3');
  assert.equal(after!.sha256, before!.sha256);
  assert.ok(cld.objects.has(before!.key), 'source kept');
  assert.equal(after!.history.at(-1)!.provider, 'cloudinary');
  assert.equal((await Tenant.findById(A.tenantId).lean())!.branding!.logoUrl, `/media/${ids.logoAsset}`);
  // Changing the default provider alone does not move anything.
  await request(app).put('/api/platform/storage').set(auth(saToken)).send({ defaultProvider: 's3' }).expect(200);
  invalidateStorageConfig();
  assert.equal((await Asset.findOne({ tenantId: A.tenantId, provider: 'cloudinary', status: 'active' }).lean())?.provider, 'cloudinary');
});

test('simulated redeploy: app folder wiped and app restarted — branding and dish photos still load', async () => {
  const appUploads = path.resolve(env.UPLOAD_DIR);
  fs.rmSync(appUploads, { recursive: true, force: true }); // what a fresh deployment does to the app folder
  invalidateStorageConfig();
  app = createApp(); // restart
  const sf = (await request(app).get(`/api/public/tenants/${A.slug}/storefront`)).body;
  const logo = await request(app).get(sf.branding.logoUrl);
  assert.equal(logo.status, 302);
  assert.equal((await fetch(logo.headers.location)).status, 200, 'logo bytes live outside the app');
  const menu = (await request(app).get(`/api/public/tenants/${A.slug}/menu`)).body;
  const dish = menu.products.find((p: any) => p._id === ids.dish);
  for (const u of dish.images) {
    const m = await request(app).get(u);
    assert.equal(m.status, 302, u);
    assert.equal((await fetch(m.headers.location)).status, 200, `${u} still loads`);
  }
  assert.equal(dish.name.en, 'Chicken Biryani', 'records unchanged');
});

test('legacy /uploads migration: verified copy, reference swapped, original kept; missing and failed reported honestly', async () => {
  const dir = path.resolve(env.UPLOAD_DIR, A.tenantId, 'products');
  fs.mkdirSync(dir, { recursive: true });
  const good = png(9);
  fs.writeFileSync(path.join(dir, 'old-photo.png'), good);
  const legacy = `/uploads/${A.tenantId}/products/old-photo.png`;
  const gone = `/uploads/${A.tenantId}/products/lost-in-redeploy.png`;
  const p2 = await Product.create({ tenantId: A.tenantId, categoryId: ids.cat, name: { en: 'Halwa Puri' }, price: 85000, images: [legacy, gone] });
  const dry = await migrateTenantMedia({ tenantId: A.tenantId, to: 's3', dryRun: true });
  assert.deepEqual(dry.map((e) => e.status).sort(), ['missing', 'would-migrate']);
  assert.deepEqual((await Product.findOne({ tenantId: A.tenantId, _id: p2._id }).lean())!.images, [legacy, gone], 'dry run changes nothing');

  s3.fail = true;
  const failed = await migrateTenantMedia({ tenantId: A.tenantId, to: 's3' });
  s3.fail = false;
  assert.equal(failed.find((e) => e.from === legacy)!.status, 'failed');
  assert.deepEqual((await Product.findOne({ tenantId: A.tenantId, _id: p2._id }).lean())!.images, [legacy, gone], 'failed upload left the reference');

  const done = await migrateTenantMedia({ tenantId: A.tenantId, to: 's3' });
  const m = done.find((e) => e.from === legacy)!;
  assert.equal(m.status, 'migrated');
  assert.equal(done.find((e) => e.from === gone)!.status, 'missing');
  const images = (await Product.findOne({ tenantId: A.tenantId, _id: p2._id }).lean())!.images;
  assert.deepEqual(images, [m.to, gone], 'only the verified one was swapped; the missing one is left for manual recovery');
  assert.ok(fs.existsSync(path.join(dir, 'old-photo.png')), 'original file not deleted');
  const a = await Asset.findOne({ tenantId: A.tenantId, _id: m.to!.split('/').pop() }).lean();
  assert.equal(a!.sha256, sha(good));
  assert.equal(a!.sourceUrl, legacy);
});

test('deletion safeguards: in use → refused; soft remove by default; permanent only by owner with confirmation', async () => {
  const inUse = await request(app).delete(`/api/staff/assets/${ids.logoAsset}`).set(auth(A.token)).send({});
  assert.equal(inUse.status, 409);
  const spare = (await uploadTo(A.token, 's3', png(10))).body;
  const key = (await Asset.findOne({ tenantId: A.tenantId, _id: spare._id }).lean())!.key;
  assert.equal((await request(app).delete(`/api/staff/assets/${spare._id}`).set(auth(A.token)).send({ permanent: true, confirm: 'DELETE' })).status, 400, 'active image cannot be destroyed directly');
  const soft = await request(app).delete(`/api/staff/assets/${spare._id}`).set(auth(A.token)).send({});
  assert.deepEqual(soft.body, { removed: true, permanent: false });
  assert.ok(s3.objects.has(key), 'soft remove keeps the bytes');
  assert.equal((await request(app).get(`/media/${spare._id}`)).status, 404);
  assert.equal((await request(app).delete(`/api/staff/assets/${spare._id}`).set(auth(A.token)).send({ permanent: true })).status, 400, 'needs typed confirmation');
  const perm = await request(app).delete(`/api/staff/assets/${spare._id}`).set(auth(A.token)).send({ permanent: true, confirm: 'DELETE' });
  assert.deepEqual(perm.body, { removed: true, permanent: true });
  assert.ok(!s3.objects.has(key));
});

test('tenant isolation: another restaurant cannot see, attach, import or delete these images', async () => {
  for (const r of [
    request(app).get(`/api/staff/assets/${ids.dishAsset}`).set(auth(B.token)),
    request(app).put('/api/staff/tenant/branding/logo').set(auth(B.token)).send({ assetId: ids.dishAsset }),
    request(app).post(`/api/staff/assets/${ids.dishAsset}/migrate`).set(auth(B.token)).send({ provider: 'cloudinary' }),
    request(app).delete(`/api/staff/assets/${ids.dishAsset}`).set(auth(B.token)).send({}),
  ]) assert.equal((await r).status, 404);
  assert.equal((await request(app).get('/api/staff/assets').set(auth(B.token))).body.items.length, 0);
});

test('integrity check reports a cloud object that disappeared', async () => {
  const a = await Asset.findOne({ tenantId: A.tenantId, _id: ids.dishAsset }).lean();
  s3.objects.delete(a!.key);
  const v = await request(app).post(`/api/staff/assets/${ids.dishAsset}/verify`).set(auth(A.token));
  assert.deepEqual(v.body, { status: 'missing' });
  const check = (await request(app).get('/api/staff/tenant/asset-check').set(auth(A.token))).body;
  assert.ok(check.missing.some((m: any) => m.url === `/media/${ids.dishAsset}`), 'shown to the owner as missing');
});
