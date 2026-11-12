import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { tenantSlugFromHost } from '../lib/subdomain';
import { AppError, forbidden, notFound, paymentRequired } from '../lib/errors';
import { resolveTenantById, resolveTenantByDomain, resolveTenantBySlug, subscriptionAllowsOperation } from '../services/tenantResolver';
import type { Feature } from '../config/permissions';

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
    if (!tenant) throw notFound('Restaurant not found');
    if (!subscriptionAllowsOperation(tenant)) throw new AppError(503, 'This restaurant is currently unavailable', 'TENANT_UNAVAILABLE');
    req.tenant = tenant;
    req.tenantId = tenant._id;
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * For AUTHENTICATED staff routes: the tenant always comes from the verified JWT,
 * never from user input. If the request also carries a tenant host, it must match.
 */
export async function requireStaffTenant(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user?.tenantId) throw forbidden('Tenant staff account required');
    const tenant = await resolveTenantById(req.user.tenantId);
    if (!tenant) throw forbidden('Tenant no longer exists');
    const hostSlug = tenantSlugFromHost(req.get('x-tenant-host') || req.get('host'), env.ROOT_DOMAIN);
    if (hostSlug && hostSlug !== tenant.slug) throw forbidden('Cross-tenant access denied');
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
