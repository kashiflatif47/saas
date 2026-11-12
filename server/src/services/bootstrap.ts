import bcrypt from 'bcryptjs';
import { Plan, User } from '../models/platform';

/**
 * Platform bootstrap. Everything here is idempotent and NON-destructive:
 *  - default plans are created only when the plans collection is empty (existing plans are never touched);
 *  - the first super admin is created only when no super admin exists; an existing account's
 *    credentials are never overwritten implicitly (use `npm run superadmin -- --reset-password`).
 */

export const DEFAULT_PLANS = [
  { code: 'starter', name: 'Starter', priceMonthly: 4_999_00, currency: 'PKR', trialDays: 14, features: ['qr_ordering', 'kds'], limits: { maxStaff: 5, maxProducts: 80, maxTables: 15 } },
  { code: 'growth', name: 'Growth', priceMonthly: 9_999_00, currency: 'PKR', trialDays: 14, features: ['qr_ordering', 'kds', 'inventory', 'reservations', 'analytics_export', 'multi_language'], limits: { maxStaff: 20, maxProducts: 400, maxTables: 50 } },
  { code: 'pro', name: 'Pro', priceMonthly: 19_999_00, currency: 'PKR', trialDays: 14, features: ['qr_ordering', 'kds', 'inventory', 'reservations', 'online_payments', 'loyalty', 'analytics_export', 'multi_language'], limits: { maxStaff: 100, maxProducts: 2000, maxTables: 200 } },
];

/** Creates the default plans when there are none. Returns the number created. */
export async function ensureDefaultPlans(): Promise<number> {
  if ((await Plan.estimatedDocumentCount()) > 0) return 0;
  // Re-check per code so concurrent boots cannot create duplicates (code is unique anyway).
  let created = 0;
  for (const p of DEFAULT_PLANS) {
    const r = await Plan.updateOne({ code: p.code }, { $setOnInsert: p }, { upsert: true });
    created += r.upsertedCount;
  }
  return created;
}

export type SuperAdminResult = 'created' | 'exists' | 'skipped' | 'password_reset' | 'not_found';

/**
 * Creates the first super admin from the given credentials when no super admin exists yet.
 * Never modifies an existing account.
 */
export async function ensureSuperAdmin(email?: string, password?: string, name = 'Platform Admin'): Promise<SuperAdminResult> {
  if (await User.exists({ role: 'superadmin' })) return 'exists';
  if (!email || !password) return 'skipped';
  if (password.length < 10) throw new Error('Super admin password must be at least 10 characters');
  await User.create({ tenantId: null, role: 'superadmin', name, email: email.toLowerCase().trim(), passwordHash: await bcrypt.hash(password, 12) });
  return 'created';
}

/**
 * Explicit, operator-invoked actions (CLI only):
 *  - create an ADDITIONAL super admin with a given email (fails if that email already exists);
 *  - reset the password of an existing super admin (revokes all of its sessions).
 */
export async function createSuperAdmin(email: string, password: string, name = 'Platform Admin'): Promise<SuperAdminResult> {
  const e = email.toLowerCase().trim();
  if (password.length < 10) throw new Error('Password must be at least 10 characters');
  if (await User.exists({ tenantId: null, email: e })) return 'exists';
  await User.create({ tenantId: null, role: 'superadmin', name, email: e, passwordHash: await bcrypt.hash(password, 12) });
  return 'created';
}

export async function resetSuperAdminPassword(email: string, password: string): Promise<SuperAdminResult> {
  if (password.length < 10) throw new Error('Password must be at least 10 characters');
  const u = await User.findOne({ tenantId: null, role: 'superadmin', email: email.toLowerCase().trim() });
  if (!u) return 'not_found';
  u.passwordHash = await bcrypt.hash(password, 12);
  u.tokenVersion = (u.tokenVersion ?? 0) + 1;
  (u as any).refreshTokens = [];
  u.failedLogins = 0;
  u.lockedUntil = undefined;
  await u.save();
  return 'password_reset';
}
