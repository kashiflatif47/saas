import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Types } from 'mongoose';
import { env, isProd } from '../config/env';
import { decryptSecret, sniffImageType } from '../lib/crypto';
import { AppError, badRequest, notFound } from '../lib/errors';
import { Asset, StorageConfig } from '../models/storage';
import { Category, Product } from '../models/menu';
import { Tenant } from '../models/platform';
import { runCrossTenant } from '../models/tenantScope';
import { CloudinaryProvider, LocalProvider, S3Provider, StorageError, type ProviderName, type StorageProvider } from '../lib/storage/providers';
import { MIME, RemoteImageError, fetchImageSafely, validateExternalImageUrl } from '../lib/storage/remote';
import { sha256Hex } from '../lib/storage/sigv4';

/**
 * Permanent media storage. ONE service for every image in the app (branding, dishes, categories):
 *   uploadAsset · createExternalAsset · importExternalAsset · getAssetUrl · deleteAsset (soft / restricted permanent)
 *   copyAsset / migrateAsset · migrateLegacyUpload · inspectAsset · verifyAsset
 *
 * Records store `/media/<assetId>`; the Asset document says where the bytes are. Nothing here ever deletes a
 * source copy automatically: replacing, migrating or importing keeps the previous object.
 * In production, files are never written into the deployment folder: without a configured cloud provider (or a
 * confirmed persistent folder) uploads fail with a clear message instead of "succeeding" into a folder that the
 * next deployment wipes.
 */

export type Purpose = 'branding' | 'product' | 'category' | 'other';
type Actor = { id?: string; name?: string } | undefined;

/* ------------------------------------------------------------------ configuration */

/** Is local disk storage acceptable here? Production requires an absolute folder outside the app, confirmed persistent. */
export function localStorageStatus(o: { isProd: boolean; uploadDir: string; appRoot: string; cwd: string; confirmedPersistent: boolean }) {
  const abs = path.resolve(o.cwd, o.uploadDir);
  const inside = (root: string) => !path.relative(path.resolve(root), abs).startsWith('..') && !path.isAbsolute(path.relative(path.resolve(root), abs));
  const outsideApp = path.isAbsolute(o.uploadDir) && !inside(o.appRoot) && !inside(o.cwd);
  if (!o.isProd) return { usable: true, persistent: outsideApp, reason: outsideApp ? '' : 'Development: files are kept in the app folder' };
  if (!outsideApp) return { usable: false, persistent: false, reason: `UPLOAD_DIR (${abs}) is inside the application folder, which deployments replace` };
  if (!o.confirmedPersistent) return { usable: false, persistent: false, reason: 'Set LOCAL_UPLOADS_PERSISTENT=true only after confirming the host keeps UPLOAD_DIR across deployments' };
  return { usable: true, persistent: true, reason: '' };
}

const APP_ROOT = path.resolve(__dirname, '../../..'); // repository root (server/src/services → root)

interface Resolved {
  defaultProvider: ProviderName | '';
  cloudinary: { cloudName: string; apiKey: string; apiSecret: string; folder: string; source: 'env' | 'console' } | null;
  s3: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; publicBaseUrl: string; forcePathStyle: boolean; privateBucket: boolean; source: 'env' | 'console' } | null;
  local: ReturnType<typeof localStorageStatus> & { dir: string };
}

let cache: { at: number; value: Resolved } | null = null;
export const invalidateStorageConfig = () => (cache = null);

async function resolveConfig(): Promise<Resolved> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const doc: any = await StorageConfig.findById('storage').select('+cloudinary.apiSecretEnc +s3.secretAccessKeyEnc').lean().catch(() => null);
  const dec = (v?: string) => {
    try {
      return v ? decryptSecret(v, env.ENCRYPTION_KEY) : '';
    } catch {
      return '';
    }
  };
  let cloudinary: Resolved['cloudinary'] = null;
  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    cloudinary = { cloudName: env.CLOUDINARY_CLOUD_NAME, apiKey: env.CLOUDINARY_API_KEY, apiSecret: env.CLOUDINARY_API_SECRET, folder: env.CLOUDINARY_FOLDER, source: 'env' };
  } else if (doc?.cloudinary?.cloudName && doc.cloudinary.apiKey && doc.cloudinary.apiSecretEnc) {
    cloudinary = { cloudName: doc.cloudinary.cloudName, apiKey: doc.cloudinary.apiKey, apiSecret: dec(doc.cloudinary.apiSecretEnc), folder: doc.cloudinary.folder || 'tablesaas', source: 'console' };
  }
  let s3: Resolved['s3'] = null;
  if (env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
    s3 = { endpoint: env.S3_ENDPOINT, region: env.S3_REGION, bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, publicBaseUrl: env.S3_PUBLIC_BASE_URL, forcePathStyle: env.S3_FORCE_PATH_STYLE, privateBucket: env.S3_PRIVATE, source: 'env' };
  } else if (doc?.s3?.endpoint && doc.s3.bucket && doc.s3.accessKeyId && doc.s3.secretAccessKeyEnc) {
    const c = doc.s3;
    s3 = { endpoint: c.endpoint, region: c.region ?? '', bucket: c.bucket, accessKeyId: c.accessKeyId, secretAccessKey: dec(c.secretAccessKeyEnc), publicBaseUrl: c.publicBaseUrl ?? '', forcePathStyle: c.forcePathStyle !== false, privateBucket: !!c.privateBucket, source: 'console' };
  }
  const local = { dir: path.resolve(env.UPLOAD_DIR), ...localStorageStatus({ isProd, uploadDir: env.UPLOAD_DIR, appRoot: APP_ROOT, cwd: process.cwd(), confirmedPersistent: env.LOCAL_UPLOADS_PERSISTENT }) };
  const value: Resolved = { defaultProvider: (env.STORAGE_DEFAULT_PROVIDER || doc?.defaultProvider || '') as any, cloudinary, s3, local };
  cache = { at: Date.now(), value };
  return value;
}

function build(name: ProviderName, c: Resolved): StorageProvider | null {
  if (name === 'cloudinary') return c.cloudinary ? new CloudinaryProvider({ ...c.cloudinary, apiBase: env.CLOUDINARY_API_BASE_URL }) : null;
  if (name === 's3') return c.s3 ? new S3Provider(c.s3) : null;
  return c.local.usable ? new LocalProvider(c.local.dir) : null;
}

const notConfigured = (name: ProviderName, c: Resolved) =>
  new AppError(503, name === 'local' ? `Server storage is not available for uploads: ${c.local.reason}. Configure Cloudinary or cloud storage in the platform console.` : `${name === 'cloudinary' ? 'Cloudinary' : 'Cloud storage'} is not configured. A platform administrator can set it up under Storage.`, 'STORAGE_NOT_CONFIGURED');

/** The provider uploads go to when none is chosen: the configured default, else the first available cloud provider. */
async function effectiveDefault(c: Resolved): Promise<ProviderName | null> {
  if (c.defaultProvider && build(c.defaultProvider, c)) return c.defaultProvider;
  if (c.cloudinary) return 'cloudinary';
  if (c.s3) return 's3';
  return c.local.usable ? 'local' : null;
}

export async function getProvider(name?: ProviderName | ''): Promise<StorageProvider> {
  const c = await resolveConfig();
  const n = name || (await effectiveDefault(c));
  if (!n) throw new AppError(503, `No permanent image storage is configured. ${c.local.reason ? `${c.local.reason}. ` : ''}A platform administrator can configure Cloudinary or cloud storage under Storage.`, 'STORAGE_NOT_CONFIGURED');
  const p = build(n, c);
  if (!p) throw notConfigured(n, c);
  return p;
}

/** What upload choices the admin UI offers (never includes secrets). */
export async function storageStatus() {
  const c = await resolveConfig();
  return {
    defaultProvider: await effectiveDefault(c),
    cloudinary: { configured: !!c.cloudinary, source: c.cloudinary?.source ?? null, cloudName: c.cloudinary?.cloudName ?? null },
    s3: { configured: !!c.s3, source: c.s3?.source ?? null, bucket: c.s3?.bucket ?? null, endpointHost: c.s3 ? safeHost(c.s3.endpoint) : null, publicDelivery: !!c.s3 && (!!c.s3.publicBaseUrl || !c.s3.privateBucket) },
    local: { usable: c.local.usable, persistent: c.local.persistent, reason: c.local.reason || null },
    external: { enabled: true },
  };
}
const safeHost = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ helpers */

export const mediaUrl = (id: unknown) => `/media/${String(id)}`;
const MEDIA_RE = /^\/media\/([a-f0-9]{24})$/;
export const assetIdFromUrl = (u: unknown) => (typeof u === 'string' ? MEDIA_RE.exec(u)?.[1] ?? null : null);

function objectKey(provider: ProviderName, tenantId: string, purpose: Purpose, ext: string, c: Resolved) {
  const name = crypto.randomBytes(16).toString('hex');
  if (provider === 'local') return `${tenantId}/${purpose}/${name}.${ext}`;
  if (provider === 'cloudinary') return `${c.cloudinary?.folder || 'tablesaas'}/tenants/${tenantId}/${purpose}/${name}`;
  return `tenants/${tenantId}/${purpose}/${name}.${ext}`;
}

/** Puts bytes and proves they arrived intact (size, and checksum where the provider can report it). */
async function putVerified(p: StorageProvider, key: string, body: Buffer, mime: string) {
  const sha256 = sha256Hex(body);
  const stored = await p.put({ key, body, mime, sha256 });
  const head = await p.head(stored);
  if (!head.exists || (head.size && head.size !== body.length && p.name !== 'cloudinary') || (head.sha256 && head.sha256 !== sha256)) {
    throw new StorageError(p.name, 'The upload could not be verified; nothing was saved');
  }
  return { stored, sha256 };
}

/* ------------------------------------------------------------------ operations */

export async function uploadAsset(i: { tenantId: Types.ObjectId | string; buffer: Buffer; provider?: ProviderName | ''; purpose: Purpose; label?: string; actor?: Actor }) {
  const ext = sniffImageType(i.buffer);
  if (!ext) throw badRequest('Only PNG, JPEG, WEBP or ICO images are allowed');
  if (i.buffer.length > env.MAX_UPLOAD_MB * 1024 * 1024) throw badRequest(`Images can be at most ${env.MAX_UPLOAD_MB} MB`);
  const c = await resolveConfig();
  const p = await getProvider(i.provider);
  const tid = String(i.tenantId);
  const { stored, sha256 } = await putVerified(p, objectKey(p.name, tid, i.purpose, ext, c), i.buffer, MIME[ext]);
  // Only now, with the bytes verified, is a reference recorded.
  return Asset.create({
    tenantId: i.tenantId, provider: p.name, key: stored.key, bucket: stored.bucket, deliveryUrl: stored.url || `s3://${stored.bucket}/${stored.key}`, privateObject: !stored.url,
    mime: MIME[ext], size: i.buffer.length, sha256, purpose: i.purpose, label: i.label, createdBy: i.actor, lastVerifiedAt: new Date(), verifyStatus: 'ok',
  });
}

export async function createExternalAsset(i: { tenantId: Types.ObjectId | string; url: string; purpose: Purpose; label?: string; actor?: Actor }) {
  let u: URL;
  try {
    u = validateExternalImageUrl(i.url);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  // Not fetched by the server: the browser previews it, and it is served by its original host.
  return Asset.create({ tenantId: i.tenantId, provider: 'external', key: u.toString(), deliveryUrl: u.toString(), purpose: i.purpose, label: i.label, createdBy: i.actor, verifyStatus: 'unverifiable' });
}

/** For tests only: replace the safe fetcher. */
export const importFetcher = { fetch: fetchImageSafely };

/** Moves an asset's bytes to another provider IN PLACE (same id, same /media URL). The source is kept in history. */
async function relocate(asset: any, to: ProviderName, body: Buffer, mime: string, ext: string) {
  const c = await resolveConfig();
  const p = await getProvider(to);
  const { stored, sha256 } = await putVerified(p, objectKey(p.name, String(asset.tenantId), asset.purpose ?? 'other', ext, c), body, mime);
  if (asset.sha256 && asset.sha256 !== sha256) throw new StorageError(p.name, 'The copy does not match the original (checksum differs); nothing was changed');
  const prev = { provider: asset.provider, key: asset.key, bucket: asset.bucket, url: asset.deliveryUrl, at: new Date() };
  const r = await Asset.updateOne(
    { tenantId: asset.tenantId, _id: asset._id, provider: asset.provider, key: asset.key }, // unchanged since we read it
    { $set: { provider: p.name, key: stored.key, bucket: stored.bucket, deliveryUrl: stored.url || `s3://${stored.bucket}/${stored.key}`, privateObject: !stored.url, mime, size: body.length, sha256, lastVerifiedAt: new Date(), verifyStatus: 'ok' }, $push: { history: prev } },
  );
  if (r.modifiedCount !== 1) throw new AppError(409, 'This image changed while it was being copied; try again', 'ASSET_CHANGED');
  return Asset.findOne({ tenantId: asset.tenantId, _id: asset._id }).lean();
}

export async function importExternalAsset(tenantId: Types.ObjectId | string, assetId: string, to: ProviderName) {
  const a = await Asset.findOne({ tenantId, _id: assetId }).lean();
  if (!a) throw notFound('Image not found');
  if (a.provider !== 'external') throw badRequest('Only linked images can be imported');
  let file;
  try {
    file = await importFetcher.fetch(a.key, { maxBytes: env.MAX_UPLOAD_MB * 1024 * 1024 });
  } catch (e) {
    if (e instanceof RemoteImageError) throw badRequest(e.message);
    throw e;
  }
  const moved = await relocate(a, to, file.buffer, file.mime, file.ext);
  await Asset.updateOne({ tenantId, _id: assetId }, { $set: { sourceUrl: a.key } });
  return moved;
}

async function readCurrent(a: any): Promise<Buffer> {
  if (a.provider === 'external') return (await importFetcher.fetch(a.key, { maxBytes: env.MAX_UPLOAD_MB * 1024 * 1024 })).buffer;
  const c = await resolveConfig();
  const p = a.provider === 'local' ? new LocalProvider(c.local.dir) : build(a.provider, c);
  if (!p) throw notConfigured(a.provider, c);
  return p.get({ key: a.key, bucket: a.bucket, url: a.privateObject ? undefined : a.deliveryUrl });
}

/** copyAsset / migrateAsset: same thing — the bytes are copied and verified; the original stays where it was. */
export async function migrateAsset(tenantId: Types.ObjectId | string, assetId: string, to: ProviderName) {
  const a = await Asset.findOne({ tenantId, _id: assetId }).lean();
  if (!a) throw notFound('Image not found');
  if (a.provider === to) return { asset: a, skipped: 'already there' as const };
  const body = await readCurrent(a);
  if (a.sha256 && sha256Hex(body) !== a.sha256) throw new StorageError(a.provider as any, 'The original no longer matches its recorded checksum; nothing was changed');
  const ext = sniffImageType(body);
  if (!ext) throw badRequest('The stored file is not a supported image');
  return { asset: await relocate(a, to, body, MIME[ext], ext) };
}
export const copyAsset = migrateAsset;

/**
 * An old `/uploads/...` file → a permanent provider. Returns the new asset; the caller swaps the record's
 * reference only if it still points at `legacyUrl`. The original file is never deleted.
 */
export async function migrateLegacyUpload(i: { tenantId: Types.ObjectId | string; legacyUrl: string; to: ProviderName; purpose: Purpose; label?: string }) {
  const tid = String(i.tenantId);
  const prefix = `/uploads/${tid}/`;
  if (!i.legacyUrl.startsWith(prefix)) throw badRequest('Not an upload of this restaurant');
  const c = await resolveConfig();
  const abs = path.resolve(c.local.dir, i.legacyUrl.slice('/uploads/'.length));
  if (!abs.startsWith(path.resolve(c.local.dir, tid) + path.sep)) throw badRequest('Invalid path');
  let body: Buffer;
  try {
    body = await fs.readFile(abs);
  } catch {
    throw new AppError(404, 'The original file is missing from server storage', 'ORIGINAL_MISSING');
  }
  const ext = sniffImageType(body);
  if (!ext) throw badRequest('The original file is not a supported image');
  const p = await getProvider(i.to);
  const { stored, sha256 } = await putVerified(p, objectKey(p.name, tid, i.purpose, ext, c), body, MIME[ext]);
  // Download the copy back and compare checksums before anything points at it.
  const back = await p.get(stored);
  if (sha256Hex(back) !== sha256) throw new StorageError(p.name, 'The uploaded copy does not match the original; nothing was changed');
  return Asset.create({
    tenantId: i.tenantId, provider: p.name, key: stored.key, bucket: stored.bucket, deliveryUrl: stored.url || `s3://${stored.bucket}/${stored.key}`, privateObject: !stored.url,
    mime: MIME[ext], size: body.length, sha256, purpose: i.purpose, label: i.label, sourceUrl: i.legacyUrl, history: [{ provider: 'local', key: i.legacyUrl.slice('/uploads/'.length), url: i.legacyUrl }],
    lastVerifiedAt: new Date(), verifyStatus: 'ok',
  });
}

/** Where to send a browser for `/media/<id>` (cross-tenant lookup: the id is the capability, as with any public image). */
export async function getAssetUrl(assetId: string): Promise<string | null> {
  if (!/^[a-f0-9]{24}$/.test(assetId)) return null;
  const a: any = await runCrossTenant(() => Asset.findOne({ _id: assetId, status: { $ne: 'removed' } }).lean().exec());
  if (!a) return null;
  if (a.provider === 'external') return a.deliveryUrl;
  if (a.provider === 'local') return `/uploads/${a.key}`;
  if (!a.privateObject) return a.deliveryUrl;
  const c = await resolveConfig();
  const p = build(a.provider, c);
  return p ? p.deliveryUrl({ key: a.key, bucket: a.bucket }) : null;
}

export async function inspectAsset(tenantId: Types.ObjectId | string, assetId: string) {
  const a = await Asset.findOne({ tenantId, _id: assetId }).lean();
  if (!a) throw notFound('Image not found');
  return { ...a, url: mediaUrl(a._id), referencedBy: await referencesOf(tenantId, mediaUrl(a._id)) };
}

/** Checks the bytes are still where the asset says (external links cannot be checked without fetching them). */
export async function verifyAsset(tenantId: Types.ObjectId | string, assetId: string) {
  const a: any = await Asset.findOne({ tenantId, _id: assetId }).lean();
  if (!a) throw notFound('Image not found');
  let status: 'ok' | 'missing' | 'mismatch' | 'unverifiable' | 'error' = 'unverifiable';
  if (a.provider !== 'external') {
    try {
      const c = await resolveConfig();
      const p = a.provider === 'local' ? new LocalProvider(c.local.dir) : build(a.provider, c);
      if (!p) status = 'error';
      else {
        const h = await p.head({ key: a.key, bucket: a.bucket, url: a.deliveryUrl });
        status = !h.exists ? 'missing' : (h.sha256 && a.sha256 && h.sha256 !== a.sha256) || (h.size && a.size && a.provider !== 'cloudinary' && h.size !== a.size) ? 'mismatch' : 'ok';
      }
    } catch {
      status = 'error';
    }
  }
  await Asset.updateOne({ tenantId, _id: assetId }, { $set: { lastVerifiedAt: new Date(), verifyStatus: status } });
  return status;
}

/** Records (branding, categories, dishes) that currently show this image. */
export async function referencesOf(tenantId: Types.ObjectId | string, url: string) {
  const refs: string[] = [];
  const t: any = await Tenant.findById(tenantId).select('branding').lean();
  for (const [k, v] of Object.entries(t?.branding ?? {})) if (v === url) refs.push(`branding.${k}`);
  for (const c of await Category.find({ tenantId, imageUrl: url }).select('name').lean()) refs.push(`category:${c.name?.en}`);
  for (const p of await Product.find({ tenantId, images: url }).select('name').lean()) refs.push(`product:${p.name?.en}`);
  return refs;
}

/** An image was replaced or detached: its asset is retired, never destroyed (restorable from the asset list). */
export async function retireUrl(tenantId: Types.ObjectId | string, url: string | null | undefined, replacedBy?: unknown) {
  const id = assetIdFromUrl(url);
  if (!id) return; // legacy /uploads files are simply left in place
  if ((await referencesOf(tenantId, url!)).length) return; // still used elsewhere
  await Asset.updateOne({ tenantId, _id: id, status: 'active' }, { $set: { status: 'replaced', ...(replacedBy ? { replacedBy } : {}) } });
}

/** An asset this restaurant may attach to a record (exists, belongs to it, not removed). Returns its /media URL. */
export async function attachableUrl(tenantId: Types.ObjectId | string, assetId: string) {
  const a = await Asset.findOne({ tenantId, _id: assetId }).select('status').lean();
  if (!a) throw notFound('Image not found');
  if (a.status === 'removed') throw badRequest('This image was removed');
  if (a.status !== 'active') await Asset.updateOne({ tenantId, _id: assetId }, { $set: { status: 'active' }, $unset: { replacedBy: 1 } });
  return mediaUrl(a._id);
}

/**
 * Removes an image. Default: SOFT (hidden from the library, bytes kept, restorable). Permanent deletion is
 * restricted: owner only, explicit confirmation, never while a record still shows it, and only for an asset
 * that is already removed or replaced. Earlier copies in `history` are never touched.
 */
export async function deleteAsset(tenantId: Types.ObjectId | string, assetId: string, opts: { permanent?: boolean; confirm?: string; role?: string }) {
  const a: any = await Asset.findOne({ tenantId, _id: assetId }).lean();
  if (!a) throw notFound('Image not found');
  const refs = await referencesOf(tenantId, mediaUrl(a._id));
  if (refs.length) throw new AppError(409, `This image is still used (${refs.join(', ')}). Replace or remove it there first.`, 'ASSET_IN_USE');
  if (!opts.permanent) {
    await Asset.updateOne({ tenantId, _id: assetId }, { $set: { status: 'removed' } });
    return { removed: true, permanent: false };
  }
  if (opts.role !== 'owner') throw new AppError(403, 'Only the owner can permanently delete images', 'FORBIDDEN');
  if (opts.confirm !== 'DELETE') throw badRequest('Type DELETE to confirm permanent deletion');
  if (a.status === 'active') throw badRequest('Remove the image first; permanent deletion is for removed or replaced images');
  if (a.provider !== 'external') {
    const c = await resolveConfig();
    const p = a.provider === 'local' ? new LocalProvider(c.local.dir) : build(a.provider, c);
    if (!p) throw notConfigured(a.provider, c);
    await p.remove({ key: a.key, bucket: a.bucket });
  }
  await Asset.deleteOne({ tenantId, _id: assetId });
  return { removed: true, permanent: true };
}

/** Provider connection test with the CURRENT configuration (platform console "Test connection"). */
export async function testProvider(name: ProviderName) {
  const p = await getProvider(name);
  await p.test();
  return { ok: true };
}
