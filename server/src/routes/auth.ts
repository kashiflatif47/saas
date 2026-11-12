import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, isProd } from '../config/env';
import { User, Tenant } from '../models/platform';
import { ah, badRequest, notFound, unauthorized } from '../lib/errors';
import { randomToken, sha256 } from '../lib/crypto';
import { authenticate, signAccessToken } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { audit } from '../services/audit';
import { ROLE_PERMISSIONS, roleHas, PERMISSIONS, type Role } from '../config/permissions';
import { computeFeatures } from '../services/tenantResolver';
import { isPathSlug, tenantSlugFromHost } from '../lib/subdomain';

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

/**
 * Where a refresh session lives in the browser.
 *
 * All path-based restaurants (`ROOT_DOMAIN/r/<slug>`) share ONE hostname with each other and with the platform
 * console, so a single host-only cookie would let restaurant B's sign-in overwrite restaurant A's (and the super
 * admin's). Each session therefore gets its own cookie scope:
 *  - platform console, and restaurants served on their own subdomain: cookie `rt`, Path=/api/auth
 *    (unchanged; host-only, so subdomains never share it);
 *  - path-based restaurant: cookie `trt`, Path=/api/auth/tenants/<slug>. The browser only sends it to that
 *    restaurant's own refresh/logout endpoints (RFC 6265 path matching: `/…/pizza` never matches `/…/pizza-hut`),
 *    so restaurants never see, overwrite or log out each other's sessions.
 * The cookie scope is a delivery mechanism only. The server still verifies the token hash, user, tenant in
 * MongoDB and that the tenant matches the requested restaurant before issuing anything.
 */
interface CookieScope {
  name: string;
  path: string;
}
const PLATFORM_SCOPE: CookieScope = { name: 'rt', path: '/api/auth' };
const TENANT_COOKIE = 'trt';
const tenantScope = (slug: string): CookieScope => ({ name: TENANT_COOKIE, path: `/api/auth/tenants/${slug}` });

const cookieBase = () => ({ httpOnly: true, secure: isProd, sameSite: 'lax' as const });

function setRefreshCookie(res: Response, scope: CookieScope, token: string) {
  res.cookie(scope.name, token, { ...cookieBase(), path: scope.path, maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000 });
}

function clearRefreshCookie(res: Response, scope: CookieScope) {
  res.clearCookie(scope.name, { ...cookieBase(), path: scope.path });
}

const hostSlugOf = (req: Request) => tenantSlugFromHost(req.get('x-tenant-host') || req.get('host'), env.ROOT_DOMAIN);

/**
 * Cookie scope for a user that has just proven who they are (login, password change). Derived from the user's
 * REAL tenant in the database, never from client input: tenant staff on the shared platform host get their
 * restaurant's own scope; on a restaurant subdomain (host-only cookies are already isolated) and for the super
 * admin it is the classic `rt` cookie.
 */
function scopeForUser(req: Request, tenantSlug: string | null): CookieScope {
  if (tenantSlug && !hostSlugOf(req)) return tenantScope(tenantSlug);
  return PLATFORM_SCOPE;
}

async function issueSession(res: Response, user: any, scope: CookieScope) {
  const refresh = `${user._id}.${randomToken(32)}`;
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000);
  // Keep at most 5 concurrent sessions per user; prune expired.
  await User.updateOne({ _id: user._id }, { $pull: { refreshTokens: { expiresAt: { $lt: new Date() } } } });
  await User.updateOne({ _id: user._id }, { $push: { refreshTokens: { $each: [{ hash: sha256(refresh), expiresAt }], $slice: -5 } } });
  setRefreshCookie(res, scope, refresh);
  return signAccessToken({ sub: String(user._id), tid: user.tenantId ? String(user.tenantId) : null, role: user.role, name: user.name, tv: user.tokenVersion ?? 0 });
}

async function sessionPayload(user: any) {
  let tenant: any = null;
  if (user.tenantId) {
    const t = await Tenant.findById(user.tenantId).lean();
    if (t) {
      tenant = {
        id: String(t._id), name: t.name, slug: t.slug, status: t.status, branding: t.branding, settings: t.settings,
        subscription: { status: t.subscription?.status, trialEndsAt: t.subscription?.trialEndsAt, currentPeriodEnd: t.subscription?.currentPeriodEnd },
        features: [...(await computeFeatures(t.subscription))],
      };
    }
  }
  const role = user.role as Role;
  const permissions = role === 'superadmin' ? [] : PERMISSIONS.filter((p) => roleHas(role, p, user.permissionOverrides));
  return {
    user: { id: String(user._id), name: user.name, email: user.email, role, tenantId: user.tenantId ? String(user.tenantId) : null, assignedTableIds: user.assignedTableIds ?? [], stationIds: user.stationIds ?? [] },
    permissions,
    tenant,
  };
}

/* ----------------------------------------------------------------------------- login */

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  tenantSlug: z.string().max(60).optional(), // required for staff; omitted for super admin
});
const tenantLoginSchema = loginSchema.omit({ tenantSlug: true });

async function performLogin(req: Request, res: Response, email: string, password: string, tenantSlugInput: string | undefined) {
  const tenantSlug = tenantSlugInput?.toLowerCase();
  const hostSlug = hostSlugOf(req);
  if (hostSlug && tenantSlug && hostSlug !== tenantSlug) throw unauthorized('Invalid credentials');
  if (hostSlug && !tenantSlug) throw unauthorized('Invalid credentials'); // no super-admin login on tenant hosts
  let tenantId: unknown = null;
  if (tenantSlug) {
    const t = await Tenant.findOne({ slug: tenantSlug }).select('_id status').lean();
    if (!t) throw unauthorized('Invalid credentials');
    if (t.status === 'suspended') throw unauthorized('This restaurant account is suspended');
    tenantId = t._id;
  }
  const user = await User.findOne({ email: email.toLowerCase(), tenantId }).select('+passwordHash');
  const ok = user && user.isActive && (!user.lockedUntil || user.lockedUntil < new Date()) && (await bcrypt.compare(password, user.passwordHash));
  if (!user || !ok) {
    if (user) {
      user.failedLogins = (user.failedLogins ?? 0) + 1;
      if (user.failedLogins >= 8) {
        user.lockedUntil = new Date(Date.now() + 15 * 60_000);
        user.failedLogins = 0;
      }
      await user.save();
    }
    // Constant-ish response regardless of which part failed.
    throw unauthorized('Invalid credentials');
  }
  user.failedLogins = 0;
  user.lastLoginAt = new Date();
  await user.save();
  // tenantSlug is the DB-verified slug of the user's own tenant here (the user was found WITH that tenantId).
  const accessToken = await issueSession(res, user, scopeForUser(req, user.tenantId ? tenantSlug! : null));
  req.user = { id: String(user._id), tenantId: user.tenantId ? String(user.tenantId) : null, role: user.role as Role, name: user.name };
  await audit(req, 'auth.login', 'User', user._id);
  res.json({ accessToken, ...(await sessionPayload(user.toObject())) });
}

/** Platform console (no tenantSlug) and legacy/subdomain restaurant sign-in. */
authRouter.post(
  '/login',
  loginLimiter,
  validateBody(loginSchema),
  ah(async (req, res) => performLogin(req, res, req.body.email, req.body.password, req.body.tenantSlug)),
);

/* --------------------------------------------------------------------------- refresh */

/**
 * Rotates a refresh session. `expect` says which site is asking:
 *  - `{ slug }`   a path-based restaurant page (`/r/<slug>`): the session must belong to that restaurant;
 *  - `'host'`     the classic endpoint: the session must belong to the restaurant whose subdomain is asking,
 *                 or (on the root host) to the platform — tenant staff never get a session there.
 */
async function performRefresh(req: Request, res: Response, scope: CookieScope, expect: { slug: string } | 'host') {
  const token = req.cookies?.[scope.name];
  // No cookie at all = an anonymous visitor (e.g. the login page probing for a session): not an error.
  // A cookie that is present but invalid, expired, revoked or for another site still gets 401 below.
  if (!token || typeof token !== 'string') return void res.status(204).end();
  const userId = token.split('.')[0];
  const user = /^[a-f0-9]{24}$/i.test(userId) ? await User.findById(userId).select('+refreshTokens') : null;
  const hash = sha256(token);
  const match = user?.refreshTokens?.find((t: any) => t.hash === hash && t.expiresAt > new Date());
  if (!user || !user.isActive || !match) {
    // Possible token reuse: revoke all sessions for safety.
    if (user) await User.updateOne({ _id: user._id }, { $set: { refreshTokens: [] }, $inc: { tokenVersion: 1 } });
    clearRefreshCookie(res, scope);
    throw unauthorized('Session expired');
  }
  const userTenant = user.tenantId ? await Tenant.findById(user.tenantId).select('slug status').lean() : null;
  const hostSlug = hostSlugOf(req);
  if (expect === 'host') {
    // The session must belong to the tenant whose host is asking (or to the platform on the root host).
    if (hostSlug && hostSlug !== userTenant?.slug) throw unauthorized('No session for this site');
    if (!hostSlug && user.tenantId) throw unauthorized('No session for this site'); // tenant staff never get a session on the platform host
  } else {
    // Path-based restaurant: the session's REAL tenant (from MongoDB) must be the restaurant in the URL.
    // Super admin sessions (no tenant) are never valid here, and a restaurant subdomain cannot borrow it.
    if (!user.tenantId || userTenant?.slug !== expect.slug) throw unauthorized('No session for this site');
    if (hostSlug && hostSlug !== expect.slug) throw unauthorized('No session for this site');
  }
  if (user.tenantId && (!userTenant || userTenant.status === 'suspended')) {
    clearRefreshCookie(res, scope);
    throw unauthorized('This restaurant account is suspended');
  }
  await User.updateOne({ _id: user._id }, { $pull: { refreshTokens: { hash } } }); // rotation
  const accessToken = await issueSession(res, user, scope);
  res.json({ accessToken, ...(await sessionPayload(user.toObject())) });
}

authRouter.post('/refresh', ah(async (req, res) => performRefresh(req, res, PLATFORM_SCOPE, 'host')));

/* ---------------------------------------------------------------------------- logout */

/** Ends ONE session: only the refresh token in this scope's cookie is revoked; other restaurants are untouched. */
async function performLogout(req: Request, res: Response, scope: CookieScope) {
  const token = req.cookies?.[scope.name];
  const userId = typeof token === 'string' ? token.split('.')[0] : '';
  if (/^[a-f0-9]{24}$/i.test(userId)) {
    await User.updateOne({ _id: userId }, { $pull: { refreshTokens: { hash: sha256(token) } } });
  }
  clearRefreshCookie(res, scope);
  res.json({ ok: true });
}

authRouter.post('/logout', ah(async (req, res) => performLogout(req, res, PLATFORM_SCOPE)));

/* ------------------------------------------------- path-based restaurant session endpoints */

/**
 * `/api/auth/tenants/:slug/{login,refresh,logout}` — used by restaurant pages at `ROOT_DOMAIN/r/<slug>`.
 * The slug picks which cookie scope to use and which restaurant the credentials are checked against; it never
 * grants anything by itself (the user must exist in that tenant, and refresh re-checks the user's real tenant).
 */
const tenantAuth = Router({ mergeParams: true });
authRouter.use(
  '/tenants/:slug',
  (req, _res, next) => (isPathSlug(req.params.slug) ? next() : next(notFound('Restaurant not found'))),
  tenantAuth,
);

tenantAuth.post(
  '/login',
  loginLimiter,
  validateBody(tenantLoginSchema),
  ah(async (req, res) => performLogin(req, res, req.body.email, req.body.password, req.params.slug)),
);
tenantAuth.post('/refresh', ah(async (req, res) => performRefresh(req, res, tenantScope(req.params.slug), { slug: req.params.slug })));
tenantAuth.post('/logout', ah(async (req, res) => performLogout(req, res, tenantScope(req.params.slug))));

/* ---------------------------------------------------------------------------- account */

authRouter.get(
  '/me',
  authenticate,
  ah(async (req, res) => {
    const user = await User.findById(req.user!.id).lean();
    res.json(await sessionPayload(user));
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  validateBody(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(200) })),
  ah(async (req, res) => {
    const user = await User.findById(req.user!.id).select('+passwordHash');
    if (!user || !(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) throw badRequest('Current password is incorrect');
    user.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1; // invalidate other sessions
    (user as any).refreshTokens = [];
    await user.save();
    await audit(req, 'auth.password_changed', 'User', user._id);
    // The new session goes into the user's own restaurant scope (looked up from the DB, not from the request).
    const tenantSlug = user.tenantId ? (await Tenant.findById(user.tenantId).select('slug').lean())?.slug ?? null : null;
    const accessToken = await issueSession(res, user, scopeForUser(req, tenantSlug));
    res.json({ accessToken });
  }),
);

authRouter.get('/roles', (_req, res) => res.json(ROLE_PERMISSIONS));
