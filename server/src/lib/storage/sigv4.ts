import crypto from 'node:crypto';

/**
 * AWS Signature Version 4 for S3-compatible APIs (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi…).
 * Pure: no network, no SDK. Verified against the examples in the AWS S3 documentation
 * (server/tests/unit/storageSigning.test.ts).
 */

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const sha256Hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as S3 expects (keeps A–Z a–z 0–9 - _ . ~). `/` is kept in paths. */
export function awsEncode(s: string, keepSlash = false) {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, keepSlash ? '/' : '%2F');
}

const amzDateOf = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

function canonical(method: string, path: string, query: Record<string, string>, headers: Record<string, string>, payloadHash: string) {
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const q = Object.keys(query).sort().map((k) => `${awsEncode(k)}=${awsEncode(query[k])}`).join('&');
  const req = [method, awsEncode(path, true), q, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  return { req, signedHeaders: names.join(';') };
}

function signature(secret: string, date: string, region: string, service: string, stringToSign: string) {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  return crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
}

export interface SignInput {
  method: string;
  host: string;
  path: string; // already including the bucket for path-style requests, e.g. /bucket/key
  query?: Record<string, string>;
  headers?: Record<string, string>; // extra headers to sign (content-type, x-amz-meta-*, range…)
  payloadHash: string; // hex sha256 of the body, EMPTY_SHA256, or 'UNSIGNED-PAYLOAD'
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  now?: Date;
}

/** Headers for an Authorization-header signed request (host, x-amz-date, x-amz-content-sha256, authorization). */
export function signRequest(i: SignInput): Record<string, string> {
  const amzDate = amzDateOf(i.now ?? new Date());
  const date = amzDate.slice(0, 8);
  const service = i.service ?? 's3';
  const headers: Record<string, string> = { ...(i.headers ?? {}), host: i.host, 'x-amz-content-sha256': i.payloadHash, 'x-amz-date': amzDate };
  const { req, signedHeaders } = canonical(i.method, i.path, i.query ?? {}, headers, i.payloadHash);
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(req)].join('\n');
  const sig = signature(i.secretAccessKey, date, i.region, service, sts);
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}` };
}

/** Query-string presigned URL (used to serve objects from a PRIVATE bucket for a short time). */
export function presignUrl(i: Omit<SignInput, 'payloadHash' | 'headers'> & { protocol?: string; expiresSeconds: number }): string {
  const amzDate = amzDateOf(i.now ?? new Date());
  const date = amzDate.slice(0, 8);
  const service = i.service ?? 's3';
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const query: Record<string, string> = {
    ...(i.query ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${i.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(i.expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const { req } = canonical(i.method, i.path, query, { host: i.host }, 'UNSIGNED-PAYLOAD');
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(req)].join('\n');
  const sig = signature(i.secretAccessKey, date, i.region, service, sts);
  const qs = Object.keys(query).sort().map((k) => `${awsEncode(k)}=${awsEncode(query[k])}`).join('&');
  return `${i.protocol ?? 'https:'}//${i.host}${awsEncode(i.path, true)}?${qs}&X-Amz-Signature=${sig}`;
}
