import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Tenant, User, AuditLog, Plan } from '../models/platform';
import { Notification, Table } from '../models/operations';
import { KitchenStation } from '../models/menu';
import { ah, badRequest, forbidden, notFound, paymentRequired } from '../lib/errors';
import { can } from '../middleware/auth';
import { checkIdParams, validateBody, validateQuery, zHex, zI18n, zPage } from '../middleware/validate';
import { uploadMemory, storeTenantImage, deleteTenantImage } from '../middleware/upload';
import { audit } from '../services/audit';
import { invalidateTenantCache } from '../services/tenantResolver';
import { encryptSecret } from '../lib/crypto';
import { env } from '../config/env';
import { tenantAppUrl } from '../lib/appUrl';
import { getOnlineProvider } from '../services/paymentService';
import { isValidTimeZone } from '../lib/timezone';
import { disconnectUserSockets } from '../sockets';
import { TENANT_ROLES, PERMISSIONS, roleHas, type Permission } from '../config/permissions';

export const tenantAdminRouter = Router();

/* ------------------------------ Profile & settings ------------------------------ */
tenantAdminRouter.get('/tenant', ah(async (req, res) => {
  const t = await Tenant.findById(req.tenantId).populate('subscription.planId', 'name code features limits priceMonthly currency').lean();
  if (!t) throw notFound();
  res.json({ ...t, url: tenantAppUrl(t.slug, req) });
}));

const settingsSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  contact: z.object({ email: z.string().email().or(z.literal('')).optional(), phone: z.string().max(30).optional(), address: z.string().max(300).optional(), city: z.string().max(80).optional(), country: z.string().max(80).optional() }).optional(),
  settings: z.object({
    currency: z.string().length(3),
    currencyDecimals: z.number().int().min(0).max(3),
    timezone: z.string().max(60).refine(isValidTimeZone, 'Unknown IANA time zone'),
    defaultLanguage: z.enum(['en', 'ur', 'ar']),
    languages: z.array(z.enum(['en', 'ur', 'ar'])).min(1),
    taxRatePercent: z.number().min(0).max(100),
    taxInclusive: z.boolean(),
    serviceChargePercent: z.number().min(0).max(100),
    autoAcceptOrders: z.boolean(),
    guestOrdering: z.boolean(),
    requireTableForDineIn: z.boolean(),
    orderTypes: z.array(z.enum(['dine_in', 'takeaway', 'pickup', 'delivery'])).min(1),
    openingHours: z.string().max(300),
    loyaltyEnabled: z.boolean(),
    loyaltyPointsPerUnit: z.number().min(0).max(1000),
    deliveryFee: z.number().int().min(0).max(100_000_000),
    maxManualDiscountPercent: z.number().min(0).max(100),
    requireOpenShiftForCash: z.boolean(),
    kitchenDelayGraceMinutes: z.number().int().min(0).max(240),
    taxLabel: z.string().max(20),
    taxRegistrationNumber: z.string().max(40),
    receiptFooter: z.string().max(300),
  }).partial().optional(),
});

tenantAdminRouter.patch('/tenant/settings', can('settings:manage'), validateBody(settingsSchema), ah(async (req, res) => {
  const set: Record<string, unknown> = {};
  if (req.body.name) set.name = req.body.name;
  for (const [k, v] of Object.entries(req.body.contact ?? {})) set[`contact.${k}`] = v;
  for (const [k, v] of Object.entries(req.body.settings ?? {})) set[`settings.${k}`] = v;
  const langs: string[] | undefined = req.body.settings?.languages;
  if (langs && langs.length > 1 && !req.tenant!.features.has('multi_language')) {
    // Re-saving the language set the restaurant already has is not an upgrade; adding languages is.
    const current = new Set<string>(req.tenant!.settings?.languages ?? ['en']);
    if (langs.some((l) => !current.has(l))) throw paymentRequired('Multi-language menus are not included in your plan');
  }
  const t = await Tenant.findByIdAndUpdate(req.tenantId, { $set: set }, { new: true, runValidators: true }).lean();
  invalidateTenantCache(t!.slug);
  await audit(req, 'tenant.settings_update', 'Tenant', req.tenantId, { fields: Object.keys(set) });
  res.json(t);
}));

const brandingSchema = z.object({
  heroTitle: zI18n.optional(),
  heroSubtitle: zI18n.optional(),
  about: zI18n.optional(),
  socials: z.object({ instagram: z.string().url().or(z.literal('')), facebook: z.string().url().or(z.literal('')), tiktok: z.string().url().or(z.literal('')), whatsapp: z.string().max(30) }).partial().optional(),
  theme: z.object({
    primary: zHex, secondary: zHex, accent: zHex, background: zHex, surface: zHex, text: zHex,
    fontHeading: z.enum(['Fraunces', 'Playfair Display', 'Poppins', 'Inter', 'DM Serif Display', 'Cormorant Garamond']),
    fontBody: z.enum(['Inter', 'Poppins', 'DM Sans', 'Nunito', 'Lato']),
    radius: z.number().int().min(0).max(32),
  }).partial().optional(),
});

tenantAdminRouter.patch('/tenant/branding', can('branding:manage'), validateBody(brandingSchema), ah(async (req, res) => {
  const set: Record<string, unknown> = {};
  for (const [group, val] of Object.entries(req.body)) {
    for (const [k, v] of Object.entries(val as object)) set[`branding.${group}.${k}`] = v;
  }
  const t = await Tenant.findByIdAndUpdate(req.tenantId, { $set: set }, { new: true, runValidators: true }).lean();
  invalidateTenantCache(t!.slug);
  await audit(req, 'tenant.branding_update', 'Tenant', req.tenantId, { fields: Object.keys(set) });
  res.json(t!.branding);
}));

const IMAGE_SLOTS = ['logo', 'favicon', 'cover', 'hero'] as const;
tenantAdminRouter.post('/tenant/branding/:slot', can('branding:manage'), uploadMemory.single('file'), ah(async (req, res) => {
  const slot = req.params.slot as (typeof IMAGE_SLOTS)[number];
  if (!IMAGE_SLOTS.includes(slot)) throw badRequest('Invalid image slot');
  if (!req.file) throw badRequest('No file uploaded');
  const url = await storeTenantImage(String(req.tenantId), 'branding', req.file);
  const prev = await Tenant.findById(req.tenantId).select('branding').lean();
  const prevUrl = (prev?.branding as any)?.[`${slot}Url`];
  await Tenant.updateOne({ _id: req.tenantId }, { $set: { [`branding.${slot}Url`]: url } });
  if (prevUrl) await deleteTenantImage(String(req.tenantId), prevUrl);
  invalidateTenantCache(req.tenant!.slug);
  await audit(req, 'tenant.branding_image', 'Tenant', req.tenantId, { slot });
  res.json({ url });
}));

/* ------------------------------ Payment provider config ------------------------------ */
tenantAdminRouter.get('/tenant/payments', can('payments:configure'), ah(async (req, res) => {
  const t = await Tenant.findById(req.tenantId).select('+payments.providerSecretEnc +payments.webhookSecretEnc').lean();
  const p: any = t?.payments ?? {};
  res.json({
    cashEnabled: p.cashEnabled,
    provider: p.provider,
    providerPublicKey: p.providerPublicKey,
    hasSecret: !!p.providerSecretEnc,
    hasWebhookSecret: !!p.webhookSecretEnc,
    providerVerifiedAt: p.providerVerifiedAt,
    webhookUrl: `${env.PUBLIC_API_URL}/api/webhooks/stripe/${req.tenantId}`,
    onlinePaymentsInPlan: req.tenant!.features.has('online_payments'),
  });
}));

tenantAdminRouter.patch('/tenant/payments', can('payments:configure'), validateBody(z.object({
  cashEnabled: z.boolean().optional(),
  provider: z.enum(['none', 'stripe']).optional(),
  providerPublicKey: z.string().regex(/^pk_(test|live)_[A-Za-z0-9]+$/).or(z.literal('')).optional(),
  providerSecret: z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/).optional(),
  webhookSecret: z.string().regex(/^whsec_[A-Za-z0-9]+$/).optional(),
})), ah(async (req, res) => {
  const b = req.body;
  if (b.provider === 'stripe' && !req.tenant!.features.has('online_payments')) throw paymentRequired('Online payments are not included in your plan');
  const set: any = {};
  if (b.cashEnabled != null) set['payments.cashEnabled'] = b.cashEnabled;
  if (b.provider) set['payments.provider'] = b.provider;
  if (b.providerPublicKey != null) set['payments.providerPublicKey'] = b.providerPublicKey;
  if (b.providerSecret) { set['payments.providerSecretEnc'] = encryptSecret(b.providerSecret, env.ENCRYPTION_KEY); set['payments.providerVerifiedAt'] = null; }
  if (b.webhookSecret) set['payments.webhookSecretEnc'] = encryptSecret(b.webhookSecret, env.ENCRYPTION_KEY);
  await Tenant.updateOne({ _id: req.tenantId }, { $set: set });
  await audit(req, 'payments.configure', 'Tenant', req.tenantId, { provider: b.provider, secretChanged: !!b.providerSecret, webhookChanged: !!b.webhookSecret });
  res.json({ ok: true });
}));

/** Performs a live API call to the provider to confirm the credentials are real. */
tenantAdminRouter.post('/tenant/payments/verify', can('payments:configure'), ah(async (req, res) => {
  const prov = await getOnlineProvider(req.tenantId!);
  if (!prov) throw badRequest('Configure the provider secret key first');
  await prov.provider.verifyCredentials();
  await Tenant.updateOne({ _id: req.tenantId }, { $set: { 'payments.providerVerifiedAt': new Date() } });
  await audit(req, 'payments.verified', 'Tenant', req.tenantId);
  res.json({ ok: true, verifiedAt: new Date() });
}));

/* ------------------------------ Staff ------------------------------ */
const staffSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  password: z.string().min(10).max(200),
  role: z.enum(TENANT_ROLES).refine((r) => r !== 'owner', 'Cannot create additional owners'),
  assignedTableIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).default([]),
  stationIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).default([]),
  permissionOverrides: z.object({ grant: z.array(z.enum(PERMISSIONS)).default([]), revoke: z.array(z.enum(PERMISSIONS)).default([]) }).optional(),
  isActive: z.boolean().default(true),
});

tenantAdminRouter.get('/staff', can('staff:view', 'staff:manage'), validateQuery(zPage.extend({ role: z.string().optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId };
  if (q.role) filter.role = q.role;
  if (q.q) filter.name = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const items = await User.find(filter).select('-refreshTokens').sort({ createdAt: 1 }).lean();
  res.json({ items, total: items.length });
}));

/**
 * Prevents privilege escalation through staff management:
 *  - only the owner may grant permissions they hold; everyone else may only grant permissions they themselves hold
 *    (so an admin can never hand out `payments:configure`, and a manager with a staff:manage grant cannot mint admins);
 *  - non-owners cannot change their own role or permission overrides;
 *  - table and station assignments must belong to the same tenant.
 */
async function assertSafeStaffChange(req: any, body: any, target?: any) {
  const actor = req.user!;
  const grants: string[] = body.permissionOverrides?.grant ?? [];
  if (actor.role !== 'owner' && grants.length) {
    const forbiddenGrant = grants.filter((p) => !roleHas(actor.role, p as Permission, actor.permissionOverrides));
    // Re-saving an override that already exists on the target is not an escalation.
    const existing: string[] = target?.permissionOverrides?.grant ?? [];
    const newlyGranted = forbiddenGrant.filter((p) => !existing.includes(p));
    if (newlyGranted.length) throw forbidden(`You cannot grant permissions you do not have: ${newlyGranted.join(', ')}`);
  }
  if (target && String(target._id) === actor.id && actor.role !== 'owner') {
    const sameOverrides = JSON.stringify(normalizeOverrides(body.permissionOverrides)) === JSON.stringify(normalizeOverrides(target.permissionOverrides));
    if ((body.role && body.role !== target.role) || (body.permissionOverrides && !sameOverrides)) {
      throw forbidden('You cannot change your own role or permissions');
    }
    if (body.isActive === false) throw badRequest('You cannot deactivate yourself');
  }
  if (body.assignedTableIds?.length) {
    const ids = [...new Set<string>(body.assignedTableIds)];
    if ((await Table.countDocuments({ tenantId: req.tenantId, _id: { $in: ids } })) !== ids.length) throw badRequest('Unknown table in assignment');
  }
  if (body.stationIds?.length) {
    const ids = [...new Set<string>(body.stationIds)];
    if ((await KitchenStation.countDocuments({ tenantId: req.tenantId, _id: { $in: ids } })) !== ids.length) throw badRequest('Unknown kitchen station in assignment');
  }
}

function normalizeOverrides(o: any) {
  return { grant: [...(o?.grant ?? [])].sort(), revoke: [...(o?.revoke ?? [])].sort() };
}

async function assertWithinStaffLimit(tenantId: any, planId: any) {
  const plan = planId ? await Plan.findById(planId).lean() : null;
  const max = plan?.limits?.maxStaff;
  if (max && (await User.countDocuments({ tenantId, isActive: true })) >= max) throw paymentRequired(`Your plan allows ${max} active staff accounts`);
}

tenantAdminRouter.post('/staff', can('staff:manage'), validateBody(staffSchema), ah(async (req, res) => {
  await assertWithinStaffLimit(req.tenantId, req.tenant!.subscription?.planId);
  const { password, ...rest } = req.body;
  if (req.user!.role !== 'owner' && rest.role === 'admin') throw forbidden('Only the owner can create admins');
  await assertSafeStaffChange(req, rest);
  const u = await User.create({ ...rest, email: rest.email.toLowerCase(), tenantId: req.tenantId, passwordHash: await bcrypt.hash(password, 12) });
  await audit(req, 'staff.create', 'User', u._id, { role: u.role });
  const { passwordHash: _p, refreshTokens: _r, ...safe } = u.toObject() as any;
  res.status(201).json(safe);
}));

tenantAdminRouter.patch('/staff/:id', can('staff:manage'), checkIdParams, validateBody(staffSchema.partial().extend({ password: z.string().min(10).max(200).optional() })), ah(async (req, res) => {
  const target = await User.findOne({ tenantId: req.tenantId, _id: req.params.id });
  if (!target) throw notFound('Staff member not found');
  if (target.role === 'owner' && req.user!.id !== String(target._id)) throw forbidden('The owner account can only be edited by the owner');
  if (target.role === 'owner' && req.body.role) throw forbidden('Owner role cannot be changed');
  if (req.user!.role !== 'owner' && (target.role === 'admin' || req.body.role === 'admin') && String(target._id) !== req.user!.id) throw forbidden('Only the owner can manage admins');
  const { password, ...rest } = req.body;
  await assertSafeStaffChange(req, rest, target);
  // Reactivating an account counts against the plan's active-staff limit, exactly like creating one.
  if (rest.isActive === true && !target.isActive) await assertWithinStaffLimit(req.tenantId, req.tenant!.subscription?.planId);
  // Sessions are revoked only when access really changes. The Staff form always sends role and overrides,
  // so testing for their presence signed people out on every profile edit (including owners editing themselves).
  const roleChanged = !!rest.role && rest.role !== target.role;
  const overridesChanged = !!rest.permissionOverrides && JSON.stringify(normalizeOverrides(rest.permissionOverrides)) !== JSON.stringify(normalizeOverrides(target.permissionOverrides));
  const deactivated = rest.isActive === false && target.isActive;
  Object.assign(target, rest);
  if (rest.email) target.email = rest.email.toLowerCase();
  let revoke = deactivated || roleChanged || overridesChanged;
  if (password) { target.passwordHash = await bcrypt.hash(password, 12); revoke = true; }
  if (revoke) {
    // Invalidate access tokens AND refresh tokens, otherwise /refresh would mint a new session.
    target.tokenVersion = (target.tokenVersion ?? 0) + 1;
    (target as any).refreshTokens = [];
  }
  await target.save();
  if (revoke) disconnectUserSockets(String(target._id));
  await audit(req, 'staff.update', 'User', target._id, { fields: Object.keys(req.body).filter((k) => k !== 'password') });
  const { passwordHash: _p, refreshTokens: _r, ...safe } = target.toObject() as any;
  res.json(safe);
}));

tenantAdminRouter.delete('/staff/:id', can('staff:manage'), checkIdParams, ah(async (req, res) => {
  const target = await User.findOne({ tenantId: req.tenantId, _id: req.params.id });
  if (!target) throw notFound('Staff member not found');
  if (target.role === 'owner') throw forbidden('The owner cannot be removed');
  if (String(target._id) === req.user!.id) throw badRequest('You cannot deactivate yourself');
  target.isActive = false;
  target.tokenVersion = (target.tokenVersion ?? 0) + 1;
  (target as any).refreshTokens = [];
  await target.save();
  disconnectUserSockets(String(target._id));
  await audit(req, 'staff.deactivate', 'User', target._id);
  res.json({ ok: true });
}));

/** Staff activity log (from audit trail). */
tenantAdminRouter.get('/staff/:id/activity', can('staff:manage', 'audit:view'), checkIdParams, ah(async (req, res) => {
  const items = await AuditLog.find({ tenantId: req.tenantId, actorId: req.params.id }).sort({ createdAt: -1 }).limit(200).lean();
  res.json({ items });
}));

/* ------------------------------ Notifications ------------------------------ */
tenantAdminRouter.get('/notifications', can('notifications:view'), ah(async (req, res) => {
  const items = await Notification.find({ tenantId: req.tenantId, $or: [{ roles: { $size: 0 } }, { roles: req.user!.role }] }).sort({ createdAt: -1 }).limit(50).lean();
  const uid = req.user!.id;
  res.json({ items: items.map((n) => ({ ...n, read: (n.readBy ?? []).some((x) => String(x) === uid), readBy: undefined })), unread: items.filter((n) => !(n.readBy ?? []).some((x) => String(x) === uid)).length });
}));

tenantAdminRouter.post('/notifications/read', can('notifications:view'), validateBody(z.object({ ids: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).max(200).optional() })), ah(async (req, res) => {
  const filter: any = { tenantId: req.tenantId };
  if (req.body.ids) filter._id = { $in: req.body.ids };
  await Notification.updateMany(filter, { $addToSet: { readBy: req.user!.id } });
  res.json({ ok: true });
}));

/* ------------------------------ Audit ------------------------------ */
tenantAdminRouter.get('/audit', can('audit:view'), validateQuery(zPage.extend({ action: z.string().max(60).optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId };
  if (q.action) filter.action = new RegExp(`^${q.action.replace(/[^a-z._]/gi, '')}`);
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
}));
