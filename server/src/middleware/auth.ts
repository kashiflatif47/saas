import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { forbidden, unauthorized } from '../lib/errors';
import { roleHas, type Permission, type Role } from '../config/permissions';
import { User } from '../models/platform';

export interface AccessClaims {
  sub: string;
  tid: string | null;
  role: Role;
  name: string;
  tv: number;
}

export function signAccessToken(c: AccessClaims): string {
  return jwt.sign(c, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL as any, algorithm: 'HS256' });
}

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as AccessClaims;
}

/** Verifies the bearer token and confirms the user is still active and token not revoked. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();
    let claims: AccessClaims;
    try {
      claims = verifyAccessToken(token);
    } catch {
      throw unauthorized('Session expired');
    }
    const user = await User.findById(claims.sub).select('isActive tokenVersion role tenantId name permissionOverrides').lean();
    if (!user || !user.isActive || user.tokenVersion !== claims.tv) throw unauthorized('Session revoked');
    req.user = {
      id: String(user._id),
      tenantId: user.tenantId ? String(user.tenantId) : null,
      role: user.role as Role,
      name: user.name,
      permissionOverrides: user.permissionOverrides as any,
    };
    next();
  } catch (e) {
    next(e);
  }
}

export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'superadmin') return next(forbidden('Platform administrators only'));
  next();
}

export const can = (...perms: Permission[]) => (req: Request, _res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u) return next(unauthorized());
  const ok = perms.some((p) => roleHas(u.role, p, u.permissionOverrides));
  if (!ok) return next(forbidden());
  next();
};
