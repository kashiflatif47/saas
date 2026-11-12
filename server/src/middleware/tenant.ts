import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { isPathSlug, tenantSlugFromHost } from '../lib/subdomain';
import { AppError, forbidden, notFound, paymentRequired } from '../lib/errors';
import { resolveTenantById, resolveTenantByDomain, resolveTenantBySlug, subscriptionAllowsOperation } from '../services/tenantResolver';
import type { ResolvedTenant } from '../types/express';
import type { Feature } from '../config/permissions';

/**
 * Header the browser app sends on every request made from a path-based restaurant page (`/r/<slug>/…`).
 * It can only ever NARROW access: staff routes reject a request whose header names a tenant other than the
 * one in the verified JWT. It never selects or grants a tenant on its own.
 */
export const TENANT_CONTEXT_HEADER = 'x-tenant-context';

/** Common checks for every public tenant resolution (same rules for host- and path-based lookups). */
function attachPublicTenant(req: Request, tenant: ResolvedTenant | null) {
  if (!tenant) throw notFound('Restaurant not found');
  if (!subscriptionAllowsOperation(tenant)) throw new AppError(503, 'This restaurant is currently unavailable', 'TENANT_UNAVAILABLE');
  req.tenant = tenant;
  req.tenantId = tenant._id;
}

/**
 * Resolves the tenant for PUBLIC (customer-facing) requests from the Host header
 * (`slug.ROOT_DOMAIN` or a verified custom domain). In development only, the
 * X-Tenant-Slug header can be used instead when ALLOW_TENANT_HEADER=true.
 * The browser sends the storefront host in `X-Forwarded-Host` when the API lives on api.ROOT_DOMAIN,
 * so we accept X-Tenant-Host from our own client as well — it is still validated against the DB.
 */
export async function resolvePublicTenant(req: Request, _res: Response, next: NextFunction) {
  try {
    const hostHeader = (req.get('x-tenant-host') || req.get('host') || '').toLowerCase();
    let slug = tenantSlugFromHost(hostHeader, env.ROOT_DOMAIN);
    if (!slug && env.ALLOW_TENANT_HEADER) slug = (req.get('x-tenant-slug') || '').toLowerCase() || null;

    let tenant = slug ? await resolveTenantBySlug(slug) : null;
    if (!tenant && hostHeader && !slug) {
      tenant = await resolveTenantByDomain(hostHeader.replace(/:\d+$/, ''));
    }
    attachPublicTenant(req, tenant);
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Resolves the tenant for PUBLIC requests from the URL path: `/api/public/tenants/:slug/...`
 * (used by restaurant pages served at `ROOT_DOMAIN/r/<slug>`). The slug must be strict slug syntax and must
 * exist in the database; suspension and subscription rules are identical to host-based resolution.
 * This only provides customer-facing context (menu, ordering, tracking): it never authorizes staff actions.
 */
export async function resolvePublicTenantFromPath(req: Request, _res: Response, next: NextFunction) {
  try {
    const slug = req.params.slug;
    if (!isPathSlug(slug)) throw notFound('Restaurant not found');
    attachPublicTenant(req, await resolveTenantBySlug(slug));
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * For AUTHENTICATED staff routes: the tenant always comes from the verified JWT,
 * never from user input. If the request also carries a tenant host or a tenant page context, it must match.
 */
export async function requireStaffTenant(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user?.tenantId) throw forbidden('Tenant staff account required');
    const tenant = await resolveTenantById(req.user.tenantId);
    if (!tenant) throw forbidden('Tenant no longer exists');
    const hostSlug = tenantSlugFromHost(req.get('x-tenant-host') || req.get('host'), env.ROOT_DOMAIN);
    if (hostSlug && hostSlug !== tenant.slug) throw forbidden('Cross-tenant access denied');
    const pageSlug = req.get(TENANT_CONTEXT_HEADER);
    if (pageSlug !== undefined && pageSlug.toLowerCase() !== tenant.slug) throw forbidden('Cross-tenant access denied');
    if (tenant.status === 'suspended') throw new AppError(423, 'This account has been suspended by the platform', 'TENANT_SUSPENDED');
    req.tenant = tenant;
    req.tenantId = tenant._id;
    next();
  } catch (e) {
    next(e);
  }
}

/** Blocks operational write actions when the subscription has lapsed (read-only mode). */
export function requireActiveSubscription(req: Request, _res: Response, next: NextFunction) {
  if (!req.tenant) return next(forbidden());
  if (req.method === 'GET') return next();
  if (!subscriptionAllowsOperation(req.tenant)) return next(paymentRequired('Subscription inactive — renew to continue'));
  next();
}

export const requireFeature = (feature: Feature) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.tenant?.features.has(feature)) return next(paymentRequired(`Your plan does not include "${feature}"`));
  next();
};
