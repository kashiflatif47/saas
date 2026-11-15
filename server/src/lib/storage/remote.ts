import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { sniffImageType } from '../crypto';

/**
 * External image URLs.
 *  - validateExternalImageUrl(): checks a pasted link before it is SAVED. The server never fetches it; the
 *    browser loads it like any other image.
 *  - fetchImageSafely(): used ONLY when an admin explicitly asks to import a linked image into cloud storage.
 *    Protected against SSRF: https on port 443 only, no credentials, no IP literals or internal names, every
 *    resolved address must be public, the connection is pinned to that vetted address (no DNS rebinding),
 *    redirects are not followed, size and time are capped and the bytes must be a real image.
 */

export class RemoteImageError extends Error {}

const INTERNAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

export function validateExternalImageUrl(raw: unknown, opts: { allowHttp?: boolean } = {}): URL {
  if (typeof raw !== 'string' || !raw.trim()) throw new RemoteImageError('Enter an image address');
  const s = raw.trim();
  if (s.length > 2000) throw new RemoteImageError('That address is too long');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new RemoteImageError('That is not a valid web address');
  }
  const allowed = opts.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(u.protocol)) throw new RemoteImageError('Only https:// image addresses are allowed');
  if (u.username || u.password) throw new RemoteImageError('Addresses with a user name or password are not allowed');
  if (u.port && u.port !== '443') throw new RemoteImageError('Only the standard https port is allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) throw new RemoteImageError('Use the image’s web address, not an IP address');
  if (!host.includes('.') || INTERNAL_NAMES.test(host)) throw new RemoteImageError('Internal network addresses are not allowed');
  return u;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('2001:db8');
  }
  return true;
}

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultLookup: Lookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

export async function fetchImageSafely(raw: string, opts: { maxBytes: number; timeoutMs?: number; lookup?: Lookup } = { maxBytes: 5 * 1024 * 1024 }): Promise<{ buffer: Buffer; mime: string; ext: string }> {
  const u = validateExternalImageUrl(raw);
  const addrs = await (opts.lookup ?? defaultLookup)(u.hostname).catch(() => []);
  if (!addrs.length) throw new RemoteImageError('That address could not be found');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new RemoteImageError('That address points to a private network');
  const target = addrs[0];
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const req = https.request(
      {
        host: target.address, // pinned to the vetted address
        family: target.family,
        servername: u.hostname, // TLS certificate is still checked for the real host name
        port: 443,
        method: 'GET',
        path: `${u.pathname}${u.search}`,
        headers: { Host: u.hostname, 'User-Agent': 'TableSaaS-image-import/1.0', Accept: 'image/*' },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new RemoteImageError(res.statusCode && res.statusCode >= 300 && res.statusCode < 400 ? 'The image address redirects elsewhere; use the final image address' : `The image could not be downloaded (HTTP ${res.statusCode})`));
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          return reject(new RemoteImageError('The image is too large'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            res.destroy();
            reject(new RemoteImageError('The image is too large'));
          } else chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => reject(new RemoteImageError('The download was interrupted')));
      },
    );
    req.on('timeout', () => req.destroy(new RemoteImageError('The image took too long to download')));
    req.on('error', (e) => reject(e instanceof RemoteImageError ? e : new RemoteImageError('The image could not be downloaded')));
    req.end();
  });
  const ext = sniffImageType(buffer);
  if (!ext) throw new RemoteImageError('That address is not a PNG, JPEG, WEBP or ICO image');
  return { buffer, ext, mime: MIME[ext] };
}

export const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon' };
