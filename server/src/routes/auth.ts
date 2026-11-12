import { Router, type Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, isProd } from '../config/env';
import { User, Tenant } from '../models/platform';
import { ah, badRequest, unauthorized } from '../lib/errors';
import { randomToken, sha256 } from '../lib/crypto';
import { authenticate, signAccessToken } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { audit } from '../services/audit';
import { ROLE_PERMISSIONS, roleHas, PERMISSIONS, type Role } from '../config/permissions';
import { computeFeatures } from '../services/tenantResolver';
import { tenantSlugFromHost } from '../lib/subdomain';

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
const REFRESH_COOKIE = 'rt';

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000,
    // Host-only cookie: a session started on alpha.example.com is never sent to bravo.example.com.
  });
}

async function issueSession(res: Response, user: any) {
  const refresh = `${user._id}.${randomToken(32)}`;
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000);
  // Keep at most 5 concurrent sessions per user; prune expired.
  await User.updateOne({ _id: user._id }, { $pull: { refreshTokens: { expiresAt: { $lt: new Date() } } } });
  await User.updateOne({ _id: user._id }, { $push: { refreshTokens: { $each: [{ hash: sha256(refresh), expiresAt }], $slice: -5 } } });
  setRefreshCookie(res, refresh);
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

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  tenantSlug: z.string().max(60).optional(), // required for staff; omitted for super admin
});

authRouter.post(
  '/login',
  loginLimiter,
  validateBody(loginSchema),
  ah(async (req, res) => {
    const { email, password, tenantSlug } = req.body;
    const hostSlug = tenantSlugFromHost(req.get('x-tenant-host') || req.get('host'), env.ROOT_DOMAIN);
    if (hostSlug && tenantSlug && hostSlug !== tenantSlug.toLowerCase()) throw unauthorized('Invalid credentials');
    if (hostSlug && !tenantSlug) throw unauthorized('Invalid credentials'); // no super-admin login on tenant hosts
    let tenantId: unknown = null;
    if (tenantSlug) {
      const t = await Tenant.findOne({ slug: tenantSlug.toLowerCase() }).select('_id status').lean();
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
    const accessToken = await issueSession(res, user);
    req.user = { id: String(user._id), tenantId: user.tenantId ? String(user.tenantId) : null, role: user.role as Role, name: user.name };
    await audit(req, 'auth.login', 'User', user._id);
    res.json({ accessToken, ...(await sessionPayload(user.toObject())) });
  }),
);

authRouter.post(
  '/refresh',
  ah(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    // No cookie at all = an anonymous visitor (e.g. the login page probing for a session): not an error.
    // A cookie that is present but invalid, expired, revoked or for another site still gets 401 below.
    if (!token || typeof token !== 'string') return void res.status(204).end();
    const userId = token.split('.')[0];
    const user = await User.findById(userId).select('+refreshTokens');
    const hash = sha256(token);
    const match = user?.refreshTokens?.find((t: any) => t.hash === hash && t.expiresAt > new Date());
    if (!user || !user.isActive || !match) {
      // Possible token reuse: revoke all sessions for safety.
      if (user) await User.updateOne({ _id: user._id }, { $set: { refreshTokens: [] }, $inc: { tokenVersion: 1 } });
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw unauthorized('Session expired');
    }
    // The session must belong to the tenant whose host is asking (or to the platform on the root host).
    const hostSlug = tenantSlugFromHost(req.get('x-tenant-host') || req.get('host'), env.ROOT_DOMAIN);
    const userTenant = user.tenantId ? await Tenant.findById(user.tenantId).select('slug status').lean() : null;
    if (hostSlug && hostSlug !== userTenant?.slug) throw unauthorized('No session for this site');
    if (!hostSlug && user.tenantId) throw unauthorized('No session for this site'); // tenant staff never get a session on the platform host
    if (user.tenantId && (!userTenant || userTenant.status === 'suspended')) {
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw unauthorized('This restaurant account is suspended');
    }
    await User.updateOne({ _id: user._id }, { $pull: { refreshTokens: { hash } } }); // rotation
    const accessToken = await issueSession(res, user);
    res.json({ accessToken, ...(await sessionPayload(user.toObject())) });
  }),
);

authRouter.post(
  '/logout',
  ah(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    const userId = typeof token === 'string' ? token.split('.')[0] : '';
    if (/^[a-f0-9]{24}$/i.test(userId)) {
      await User.updateOne({ _id: userId }, { $pull: { refreshTokens: { hash: sha256(token) } } });
    }
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.json({ ok: true });
  }),
);

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
    const accessToken = await issueSession(res, user);
    res.json({ accessToken });
  }),
);

authRouter.get('/roles', (_req, res) => res.json(ROLE_PERMISSIONS));
