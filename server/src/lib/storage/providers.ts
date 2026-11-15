import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { presignUrl, sha256Hex, signRequest, EMPTY_SHA256, awsEncode } from './sigv4';
import { AppError } from '../errors';

/**
 * Storage providers behind one interface. They only move bytes; the asset service (index.ts) decides keys,
 * validates files, verifies uploads and records metadata. Error messages never contain credentials.
 */

export type ProviderName = 'local' | 'cloudinary' | 's3';

export interface ObjectRef {
  key: string;
  bucket?: string;
  url?: string;
  privateObject?: boolean;
}
export interface StoredObject extends ObjectRef {
  url: string; // '' for objects in a private bucket (served through short-lived signed links)
  size: number;
}

export interface StorageProvider {
  readonly name: ProviderName;
  put(o: { key: string; body: Buffer; mime: string; sha256: string }): Promise<StoredObject>;
  head(o: ObjectRef): Promise<{ exists: boolean; size?: number; sha256?: string }>;
  get(o: ObjectRef): Promise<Buffer>;
  remove(o: ObjectRef): Promise<void>;
  /** Where a browser should be sent to load the object (signed for private buckets). */
  deliveryUrl(o: ObjectRef): string;
  /** Connection check with the configured credentials; throws StorageError with a readable reason. */
  test(): Promise<void>;
}

/** A provider failure with a readable, credential-free message (HTTP 502/503 by default, 400/404 when the input is wrong). */
export class StorageError extends AppError {
  constructor(public provider: ProviderName | 'external', message: string, status = 502) {
    super(status, message, 'STORAGE_ERROR');
  }
}

const TIMEOUT = 30_000;
async function call(provider: ProviderName, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch {
    throw new StorageError(provider, `${label(provider)} could not be reached`);
  }
}
const label = (p: ProviderName) => ({ local: 'Server storage', cloudinary: 'Cloudinary', s3: 'Cloud storage' })[p];

/* ------------------------------------------------------------------ local (development / verified persistent disk) */

export class LocalProvider implements StorageProvider {
  readonly name = 'local' as const;
  constructor(private dir: string) {}
  private abs(key: string) {
    const root = path.resolve(this.dir) + path.sep;
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(root)) throw new StorageError('local', 'Invalid file location', 400);
    return p;
  }
  async put(o: { key: string; body: Buffer }) {
    const p = this.abs(o.key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, o.body, { flag: 'wx' });
    return { key: o.key, url: `/uploads/${o.key}`, size: o.body.length };
  }
  async head(o: ObjectRef) {
    try {
      const buf = await fs.readFile(this.abs(o.key));
      return { exists: true, size: buf.length, sha256: sha256Hex(buf) };
    } catch {
      return { exists: false };
    }
  }
  async get(o: ObjectRef) {
    try {
      return await fs.readFile(this.abs(o.key));
    } catch {
      throw new StorageError('local', 'The file is missing from server storage', 404);
    }
  }
  async remove(o: ObjectRef) {
    await fs.unlink(this.abs(o.key)).catch(() => undefined);
  }
  deliveryUrl(o: ObjectRef) {
    return `/uploads/${o.key}`;
  }
  async test() {
    const p = this.abs(`_connection-test/${crypto.randomBytes(6).toString('hex')}.txt`);
    try {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, 'ok');
      await fs.unlink(p);
    } catch {
      throw new StorageError('local', 'The upload folder is not writable');
    }
  }
}

/* ------------------------------------------------------------------ Cloudinary (signed upload API) */

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  apiBase: string;
}

/** Cloudinary request signature: sha1 of the sorted parameters (excluding file, api_key, resource_type) + secret. */
export function cloudinarySignature(params: Record<string, string | number>, apiSecret: string) {
  const toSign = Object.keys(params).filter((k) => params[k] !== '' && params[k] != null).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

export class CloudinaryProvider implements StorageProvider {
  readonly name = 'cloudinary' as const;
  constructor(private c: CloudinaryConfig, private now = () => new Date()) {}
  private api(p: string) {
    return `${this.c.apiBase.replace(/\/$/, '')}/v1_1/${encodeURIComponent(this.c.cloudName)}/${p}`;
  }
  private basic() {
    return `Basic ${Buffer.from(`${this.c.apiKey}:${this.c.apiSecret}`).toString('base64')}`;
  }
  private async fail(r: Response, what: string): Promise<never> {
    const j: any = await r.json().catch(() => null);
    const reason = typeof j?.error?.message === 'string' ? j.error.message.slice(0, 200) : `HTTP ${r.status}`;
    throw new StorageError('cloudinary', `Cloudinary ${what} failed: ${reason}`, r.status === 401 || r.status === 403 ? 502 : 502);
  }
  async put(o: { key: string; body: Buffer; mime: string }) {
    const params = { public_id: o.key, timestamp: Math.floor(this.now().getTime() / 1000), overwrite: 'false' };
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(o.body)], { type: o.mime }), 'upload');
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    form.append('api_key', this.c.apiKey);
    form.append('signature', cloudinarySignature(params, this.c.apiSecret));
    const r = await call('cloudinary', this.api('image/upload'), { method: 'POST', body: form });
    if (!r.ok) await this.fail(r, 'upload');
    const j: any = await r.json();
    // https only, except against a local test/proxy API base that itself is http.
    const plainOk = this.c.apiBase.startsWith('http://');
    if (typeof j.secure_url !== 'string' || !(j.secure_url.startsWith('https://') || (plainOk && j.secure_url.startsWith('http://')))) throw new StorageError('cloudinary', 'Cloudinary did not return a secure address');
    return { key: j.public_id, url: j.secure_url, size: Number(j.bytes) || o.body.length };
  }
  async head(o: ObjectRef) {
    const r = await call('cloudinary', this.api(`resources/image/upload/${o.key.split('/').map(encodeURIComponent).join('/')}`), { headers: { authorization: this.basic() } });
    if (r.status === 404) return { exists: false };
    if (!r.ok) await this.fail(r, 'check');
    const j: any = await r.json();
    return { exists: true, size: Number(j.bytes) || undefined };
  }
  async get(o: ObjectRef) {
    if (!o.url) throw new StorageError('cloudinary', 'No Cloudinary address recorded');
    const r = await call('cloudinary', o.url, {});
    if (!r.ok) throw new StorageError('cloudinary', `Cloudinary image could not be downloaded (HTTP ${r.status})`, r.status === 404 ? 404 : 502);
    return Buffer.from(await r.arrayBuffer());
  }
  async remove(o: ObjectRef) {
    const params = { public_id: o.key, timestamp: Math.floor(this.now().getTime() / 1000), invalidate: 'true' };
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    form.append('api_key', this.c.apiKey);
    form.append('signature', cloudinarySignature(params, this.c.apiSecret));
    const r = await call('cloudinary', this.api('image/destroy'), { method: 'POST', body: form });
    if (!r.ok) await this.fail(r, 'delete');
  }
  deliveryUrl(o: ObjectRef) {
    return o.url ?? '';
  }
  async test() {
    if (!this.c.cloudName || !this.c.apiKey || !this.c.apiSecret) throw new StorageError('cloudinary', 'Cloud name, API key and API secret are required', 400);
    const r = await call('cloudinary', this.api('ping'), { headers: { authorization: this.basic() } });
    if (r.status === 401 || r.status === 403) throw new StorageError('cloudinary', 'Cloudinary rejected the API key or secret');
    if (!r.ok) await this.fail(r, 'connection test');
  }
}

/* ------------------------------------------------------------------ S3-compatible (AWS S3, R2, B2, MinIO…) */

export interface S3Config {
  endpoint: string; // https://s3.eu-central-1.amazonaws.com · https://<account>.r2.cloudflarestorage.com · https://s3.us-west-004.backblazeb2.com
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string; // CDN or public bucket URL; '' = private (signed links)
  forcePathStyle: boolean;
  privateBucket: boolean;
}

export class S3Provider implements StorageProvider {
  readonly name = 's3' as const;
  constructor(private c: S3Config, private now = () => new Date()) {}
  private target(key: string, bucket = this.c.bucket) {
    const ep = new URL(this.c.endpoint);
    if (this.c.forcePathStyle) return { protocol: ep.protocol, host: ep.host, path: `/${bucket}/${key}` };
    return { protocol: ep.protocol, host: `${bucket}.${ep.host}`, path: `/${key}` };
  }
  private async send(method: string, key: string, opts: { body?: Buffer; headers?: Record<string, string>; bucket?: string } = {}) {
    const t = this.target(key, opts.bucket);
    const payloadHash = opts.body ? sha256Hex(opts.body) : EMPTY_SHA256;
    const headers = signRequest({ method, host: t.host, path: t.path, headers: opts.headers, payloadHash, accessKeyId: this.c.accessKeyId, secretAccessKey: this.c.secretAccessKey, region: this.c.region || 'us-east-1', now: this.now() });
    const { host: _h, ...sendHeaders } = headers; // fetch sets Host itself
    return call('s3', `${t.protocol}//${t.host}${awsEncode(t.path, true)}`, { method, headers: sendHeaders, body: opts.body ? new Uint8Array(opts.body) : undefined });
  }
  private publicUrl(key: string) {
    if (this.c.publicBaseUrl) return `${this.c.publicBaseUrl.replace(/\/$/, '')}/${awsEncode(key, true)}`;
    if (this.c.privateBucket) return '';
    const t = this.target(key);
    return `${t.protocol}//${t.host}${awsEncode(t.path, true)}`;
  }
  async put(o: { key: string; body: Buffer; mime: string; sha256: string }) {
    const r = await this.send('PUT', o.key, { body: o.body, headers: { 'content-type': o.mime, 'x-amz-meta-sha256': o.sha256, 'cache-control': 'public, max-age=31536000, immutable' } });
    if (!r.ok) throw new StorageError('s3', `Cloud storage upload failed (HTTP ${r.status})`);
    return { key: o.key, bucket: this.c.bucket, url: this.publicUrl(o.key), size: o.body.length, privateObject: !this.publicUrl(o.key) };
  }
  async head(o: ObjectRef) {
    const r = await this.send('HEAD', o.key, { bucket: o.bucket });
    if (r.status === 404) return { exists: false };
    if (!r.ok) throw new StorageError('s3', `Cloud storage check failed (HTTP ${r.status})`);
    return { exists: true, size: Number(r.headers.get('content-length') ?? 0) || undefined, sha256: r.headers.get('x-amz-meta-sha256') ?? undefined };
  }
  async get(o: ObjectRef) {
    const r = await this.send('GET', o.key, { bucket: o.bucket });
    if (!r.ok) throw new StorageError('s3', `Cloud storage download failed (HTTP ${r.status})`, r.status === 404 ? 404 : 502);
    return Buffer.from(await r.arrayBuffer());
  }
  async remove(o: ObjectRef) {
    const r = await this.send('DELETE', o.key, { bucket: o.bucket });
    if (!r.ok && r.status !== 404) throw new StorageError('s3', `Cloud storage delete failed (HTTP ${r.status})`);
  }
  deliveryUrl(o: ObjectRef) {
    if (o.url) return o.url;
    const t = this.target(o.key, o.bucket);
    return presignUrl({ method: 'GET', protocol: t.protocol, host: t.host, path: t.path, expiresSeconds: 600, accessKeyId: this.c.accessKeyId, secretAccessKey: this.c.secretAccessKey, region: this.c.region || 'us-east-1', now: this.now() });
  }
  async test() {
    if (!this.c.endpoint || !this.c.bucket || !this.c.accessKeyId || !this.c.secretAccessKey) throw new StorageError('s3', 'Endpoint, bucket, access key and secret key are required', 400);
    try {
      new URL(this.c.endpoint);
    } catch {
      throw new StorageError('s3', 'The endpoint is not a valid URL', 400);
    }
    // HEAD on the bucket checks reachability and credentials without writing or deleting anything.
    const t = this.c.forcePathStyle ? { ...this.target('', this.c.bucket), path: `/${this.c.bucket}` } : { ...this.target(''), path: '/' };
    const headers = signRequest({ method: 'HEAD', host: t.host, path: t.path, payloadHash: EMPTY_SHA256, accessKeyId: this.c.accessKeyId, secretAccessKey: this.c.secretAccessKey, region: this.c.region || 'us-east-1', now: this.now() });
    const { host: _h, ...sendHeaders } = headers;
    const r = await call('s3', `${t.protocol}//${t.host}${awsEncode(t.path, true)}`, { method: 'HEAD', headers: sendHeaders });
    if (r.status === 403) throw new StorageError('s3', 'Cloud storage rejected the access key, secret key or region');
    if (r.status === 404) throw new StorageError('s3', 'The bucket was not found');
    if (!r.ok) throw new StorageError('s3', `Cloud storage connection test failed (HTTP ${r.status})`);
  }
}
