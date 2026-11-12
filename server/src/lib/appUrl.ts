import type { Request } from 'express';
import { env, isProd } from '../config/env';
import { tenantSlugFromHost } from './subdomain';

/**
 * Builds browser-facing URLs for the platform (`slug` omitted) or a restaurant.
 * With TENANT_URL_MODE=path (default) a restaurant lives at `ROOT_DOMAIN/r/<slug>`; with
 * TENANT_URL_MODE=subdomain at `<slug>.ROOT_DOMAIN`.
 * Nothing here is ever stored in the database: URLs are computed per request, so the same records
 * work on localhost, a staging host and production, and switching modes needs no data migration.
 *
 * Port selection, in order:
 *  1. APP_PUBLIC_PORT, when set (explicit, any environment);
 *  2. outside production: the port the browser is actually using, taken from the request's
 *     X-Tenant-Host / Host header, but only when that host is ROOT_DOMAIN or one of its subdomains.
 *     Through the Vite proxy that is 5173 (`http://localhost:5173/r/brost`); in single-service mode it is 4000;
 *  3. otherwise no port (production behind 80/443).
 * Only the numeric port is ever taken from the request, so a forged header cannot inject a foreign host.
 */
export function publicPort(req?: Pick<Request, 'get'>): string {
  if (env.APP_PUBLIC_PORT) return env.APP_PUBLIC_PORT;
  if (isProd || !req) return '';
  for (const raw of [req.get('x-tenant-host'), req.get('host')]) {
    if (!raw) continue;
    const m = /^([^:/\s]+):(\d{1,5})$/.exec(raw.trim().toLowerCase());
    if (!m) continue;
    const [, host, port] = m;
    const root = env.ROOT_DOMAIN.toLowerCase();
    const ours = host === root || tenantSlugFromHost(host, root) !== null;
    if (ours) return port;
  }
  return '';
}

function withPort(port: string) {
  const standard = (env.APP_PROTOCOL === 'https' && port === '443') || (env.APP_PROTOCOL === 'http' && port === '80');
  return port && !standard ? `:${port}` : '';
}

/** Path prefix of a restaurant inside the platform domain (path mode). */
export const tenantBasePath = (slug: string) => `/r/${encodeURIComponent(slug)}`;

/**
 * Restaurant home URL, without a trailing slash:
 * `https://example.com/r/brost` (path mode) or `https://brost.example.com` (subdomain mode).
 */
export function tenantAppUrl(slug: string, req?: Pick<Request, 'get'>): string {
  const port = withPort(publicPort(req));
  if (env.TENANT_URL_MODE === 'subdomain') return `${env.APP_PROTOCOL}://${slug}.${env.ROOT_DOMAIN}${port}`;
  return `${env.APP_PROTOCOL}://${env.ROOT_DOMAIN}${port}${tenantBasePath(slug)}`;
}

/** `http://localhost:5173` (dev) or `https://example.com` (prod). */
export function platformAppUrl(req?: Pick<Request, 'get'>): string {
  return `${env.APP_PROTOCOL}://${env.ROOT_DOMAIN}${withPort(publicPort(req))}`;
}

/** URL encoded in a table's QR code. */
export function tableUrl(slug: string, token: string, req?: Pick<Request, 'get'>): string {
  return `${tenantAppUrl(slug, req)}/t/${token}`;
}

/** Restaurant staff sign-in page. */
export function tenantLoginUrl(slug: string, req?: Pick<Request, 'get'>): string {
  return `${tenantAppUrl(slug, req)}/login`;
}
