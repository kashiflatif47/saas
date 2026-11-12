import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Plan, Tenant, User, AuditLog } from '../models/platform';
import { KitchenStation, Product } from '../models/menu';
import { Order, Table } from '../models/operations';
import { runCrossTenant } from '../models/tenantScope';
import { ah, badRequest, conflict, notFound } from '../lib/errors';
import { isValidSlug, slugify } from '../lib/subdomain';
import { checkIdParams, validateBody, validateQuery, zPage, zMoney } from '../middleware/validate';
import { audit } from '../services/audit';
import { invalidateTenantCache } from '../services/tenantResolver';
import { FEATURES } from '../config/permissions';
import { env } from '../config/env';
import { invalidateCustomDomainCache } from '../app.cors';
import { tenantAppUrl, tenantLoginUrl } from '../lib/appUrl';
import { disconnectTenantStaffSockets, disconnectUserSockets } from '../sockets';

import { isValidTimeZone } from '../lib/timezone';

export const superAdminRouter = Router();

/* ------------------------------- Plans -------------------------------- */
const planSchema = z.object({
  name: z.string().min(2).max(60),
  code: z.string().regex(/^[a-z0-9-]{2,30}$/),
  priceMonthly: zMoney,
  currency: z.string().length(3).default('PKR'),
  trialDays: z.number().int().min(0).max(90).default(14),
  features: z.array(z.enum(FEATURES)).default([]),
  limits: z.object({ maxStaff: z.number().int().min(1), maxProducts: z.number().int().min(1), maxTables: z.number().int().min(1) }).partial().default({}),
  isActive: z.boolean().default(true),
});

superAdminRouter.get('/plans', ah(async (_req, res) => res.json(await Plan.find().sort({ priceMonthly: 1 }).lean())));
superAdminRouter.post('/plans', validateBody(planSchema), ah(async (req, res) => {
  const p = await Plan.create(req.body);
  await audit(req, 'plan.create', 'Plan', p._id, undefined, null);
  res.status(201).json(p);
}));
superAdminRouter.patch('/plans/:id', checkIdParams, validateBody(planSchema.partial()), ah(async (req, res) => {
  const p = await Plan.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
  if (!p) throw notFound('Plan not found');
  invalidateTenantCache();
  await audit(req, 'plan.update', 'Plan', p._id, req.body, null);
  res.json(p);
}));

/* ------------------------------ Tenants ------------------------------- */
const createTenantSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().max(40).optional(),
  businessType: z.enum(['restaurant', 'cafe', 'hotel', 'bakery', 'food_truck', 'other']).default('restaurant'),
  planId: z.string().regex(/^[a-f0-9]{24}$/i),
  contact: z.object({ email: z.string().email().optional(), phone: z.string().max(30).optional(), address: z.string().max(300).optional(), city: z.string().max(80).optional(), country: z.string().max(80).optional() }).default({}),
  currency: z.string().length(3).default('PKR'),
  owner: z.object({ name: z.string().min(2).max(120), email: z.string().email(), password: z.string().min(10).max(200) }),
});

superAdminRouter.get('/tenants', validateQuery(zPage.extend({ status: z.string().optional(), subscription: z.string().optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = {};
  if (q.status) filter.status = q.status;
  if (q.subscription) filter['subscription.status'] = q.subscription;
  if (q.q) filter.$or = [{ name: new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { slug: new RegExp(q.q.replace(/[^a-z0-9-]/gi, ''), 'i') }];
  const [items, total] = await Promise.all([
    Tenant.find(filter).populate('subscription.planId', 'name code').sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Tenant.countDocuments(filter),
  ]);
  res.json({ items: items.map((t) => ({ ...t, url: tenantAppUrl(t.slug, req) })), total, page: q.page, limit: q.limit });
}));

superAdminRouter.get('/tenants/:id', checkIdParams, ah(async (req, res) => {
  const t = await Tenant.findById(req.params.id).populate('subscription.planId').lean();
  if (!t) throw notFound('Tenant not found');
  const tenantId = t._id;
  const since = new Date(Date.now() - 30 * 86400_000);
  const [staff, products, tables, orders30, owner] = await Promise.all([
    User.countDocuments({ tenantId }),
    Product.countDocuments({ tenantId, isArchived: false }),
    Table.countDocuments({ tenantId }),
    Order.aggregate([{ $match: { tenantId, createdAt: { $gte: since } } }, { $group: { _id: null, count: { $sum: 1 }, gmv: { $sum: '$total' } } }]),
    User.findOne({ tenantId, role: 'owner' }).select('name email lastLoginAt').lean(),
  ]);
  res.json({ tenant: t, usage: { staff, products, tables, orders30: orders30[0]?.count ?? 0, gmv30: orders30[0]?.gmv ?? 0 }, owner, url: tenantAppUrl(t.slug, req), loginUrl: tenantLoginUrl(t.slug, req) });
}));

/** Provisions a tenant: tenant record + owner account + default kitchen station + trial subscription. */
superAdminRouter.post('/tenants', validateBody(createTenantSchema), ah(async (req, res) => {
  const b = req.body;
  const slug = (b.slug ? b.slug.toLowerCase() : slugify(b.name));
  if (!isValidSlug(slug)) throw badRequest('Restaurant URL name (slug) must be 3–40 chars of a–z, 0–9 and hyphens, and not reserved');
  if (await Tenant.exists({ slug })) throw conflict('That restaurant URL name is already taken');
  const plan = await Plan.findById(b.planId).lean();
  if (!plan || !plan.isActive) throw badRequest('Plan not found or inactive');

  const trialEndsAt = new Date(Date.now() + (plan.trialDays ?? 14) * 86400_000);
  const tenant = await Tenant.create({
    name: b.name,
    slug,
    businessType: b.businessType,
    contact: b.contact,
    // Only plans with multi-language menus start with several languages; otherwise the owner's first
    // Settings save would be refused for a language set they never chose.
    settings: { currency: b.currency, languages: plan.features?.includes('multi_language') ? ['en', 'ur', 'ar'] : ['en'] },
    branding: { heroTitle: { en: b.name }, heroSubtitle: { en: 'Fresh food, made to order' } },
    subscription: { planId: plan._id, status: plan.trialDays > 0 ? 'trial' : 'active', trialEndsAt: plan.trialDays > 0 ? trialEndsAt : undefined, currentPeriodEnd: plan.trialDays > 0 ? undefined : new Date(Date.now() + 30 * 86400_000) },
  });
  try {
    await User.create({ tenantId: tenant._id, name: b.owner.name, email: b.owner.email.toLowerCase(), passwordHash: await bcrypt.hash(b.owner.password, 12), role: 'owner' });
    await KitchenStation.create({ tenantId: tenant._id, name: 'Main Kitchen', isDefault: true });
  } catch (e) {
    // Roll back partial provisioning.
    await User.deleteMany({ tenantId: tenant._id });
    await KitchenStation.deleteMany({ tenantId: tenant._id });
    await Tenant.deleteOne({ _id: tenant._id });
    throw e;
  }
  await audit(req, 'tenant.provision', 'Tenant', tenant._id, { slug, plan: plan.code }, null);
  res.status(201).json({ tenant, url: tenantAppUrl(slug, req), loginUrl: tenantLoginUrl(slug, req) });
}));

superAdminRouter.patch('/tenants/:id', checkIdParams, validateBody(z.object({
  name: z.string().min(2).max(120).optional(),
  businessType: z.enum(['restaurant', 'cafe', 'hotel', 'bakery', 'food_truck', 'other']).optional(),
  contact: createTenantSchema.shape.contact.optional(),
  customDomain: z.string().regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/i).nullable().optional(),
  settings: z.object({
    currency: z.string().length(3).transform((c) => c.toUpperCase()),
    currencyDecimals: z.number().int().min(0).max(3),
    timezone: z.string().max(60).refine(isValidTimeZone, 'Unknown IANA time zone'),
    defaultLanguage: z.enum(['en', 'ur', 'ar']),
  }).partial().optional(),
})), ah(async (req, res) => {
  const { settings, contact, customDomain, ...rest } = req.body;
  const set: Record<string, unknown> = { ...rest };
  const unset: Record<string, 1> = {};
  // Dotted paths so partial updates never wipe sibling fields.
  for (const [k, v] of Object.entries(contact ?? {})) set[`contact.${k}`] = v;
  for (const [k, v] of Object.entries(settings ?? {})) set[`settings.${k}`] = v;
  if (customDomain === null) unset.customDomain = 1;
  else if (customDomain) {
    const d = customDomain.toLowerCase();
    const root = env.ROOT_DOMAIN.toLowerCase();
    if (d === root || d.endsWith(`.${root}`)) throw badRequest('Use the built-in restaurant address instead of a custom domain under the platform domain');
    set.customDomain = d;
  }
  const t = await Tenant.findByIdAndUpdate(req.params.id, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true, runValidators: true });
  if (!t) throw notFound('Tenant not found');
  invalidateTenantCache(t.slug);
  invalidateCustomDomainCache();
  await audit(req, 'tenant.update', 'Tenant', t._id, req.body, null);
  res.json(t);
}));

superAdminRouter.post('/tenants/:id/status', checkIdParams, validateBody(z.object({ status: z.enum(['active', 'suspended']), reason: z.string().max(300).optional() })), ah(async (req, res) => {
  const t = await Tenant.findByIdAndUpdate(req.params.id, { $set: { status: req.body.status } }, { new: true });
  if (!t) throw notFound('Tenant not found');
  if (req.body.status === 'suspended') {
    await User.updateMany({ tenantId: t._id }, { $inc: { tokenVersion: 1 }, $set: { refreshTokens: [] } }); // kick active sessions
    disconnectTenantStaffSockets(String(t._id)); // and their live dashboards / kitchen screens
  }
  invalidateTenantCache(t.slug);
  await audit(req, `tenant.${req.body.status === 'active' ? 'activate' : 'suspend'}`, 'Tenant', t._id, { reason: req.body.reason }, null);
  res.json(t);
}));

/** Subscription management: change plan, renew, extend trial, mark past due/expired, feature overrides. */
superAdminRouter.post('/tenants/:id/subscription', checkIdParams, validateBody(z.object({
  planId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  action: z.enum(['renew', 'extend_trial', 'set_status', 'set_overrides']),
  months: z.number().int().min(1).max(36).optional(),
  days: z.number().int().min(1).max(365).optional(),
  status: z.enum(['trial', 'active', 'past_due', 'expired', 'suspended']).optional(),
  grant: z.array(z.enum(FEATURES)).optional(),
  revoke: z.array(z.enum(FEATURES)).optional(),
})), ah(async (req, res) => {
  const t = await Tenant.findById(req.params.id);
  if (!t) throw notFound('Tenant not found');
  const b = req.body;
  const sub: any = t.subscription ?? {};
  if (b.planId) {
    const plan = await Plan.findById(b.planId).lean();
    if (!plan) throw badRequest('Plan not found');
    sub.planId = plan._id;
  }
  const now = new Date();
  switch (b.action) {
    case 'renew': {
      const base = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
      const end = new Date(base);
      end.setMonth(end.getMonth() + (b.months ?? 1));
      sub.currentPeriodEnd = end;
      sub.status = 'active';
      break;
    }
    case 'extend_trial': {
      const base = sub.trialEndsAt && sub.trialEndsAt > now ? sub.trialEndsAt : now;
      sub.trialEndsAt = new Date(base.getTime() + (b.days ?? 7) * 86400_000);
      sub.status = 'trial';
      break;
    }
    case 'set_status':
      if (!b.status) throw badRequest('status required');
      sub.status = b.status;
      break;
    case 'set_overrides':
      sub.featureOverrides = { grant: b.grant ?? [], revoke: b.revoke ?? [] };
      break;
  }
  t.subscription = sub;
  t.markModified('subscription');
  await t.save();
  invalidateTenantCache(t.slug);
  await audit(req, `subscription.${b.action}`, 'Tenant', t._id, b, null);
  res.json(t);
}));

/* ----------------------- Tenant accounts (support) ----------------------- */
superAdminRouter.get('/tenants/:id/users', checkIdParams, ah(async (req, res) => {
  if (!(await Tenant.exists({ _id: req.params.id }))) throw notFound('Tenant not found');
  const items = await User.find({ tenantId: req.params.id }).select('name email phone role isActive lastLoginAt lockedUntil createdAt').sort({ role: 1, createdAt: 1 }).lean();
  res.json({ items, total: items.length });
}));

/** Activate/deactivate a tenant account, reset its password or unlock it. Every change revokes its sessions. */
superAdminRouter.patch('/tenants/:id/users/:userId', checkIdParams, validateBody(z.object({
  isActive: z.boolean().optional(),
  password: z.string().min(10).max(200).optional(),
  unlock: z.boolean().optional(),
}).refine((b) => b.isActive !== undefined || b.password || b.unlock, 'Nothing to change')), ah(async (req, res) => {
  const u = await User.findOne({ tenantId: req.params.id, _id: req.params.userId });
  if (!u) throw notFound('Account not found');
  if (u.role === 'owner' && req.body.isActive === false) throw badRequest('Suspend the restaurant instead of deactivating its owner');
  if (req.body.isActive !== undefined) u.isActive = req.body.isActive;
  if (req.body.password) u.passwordHash = await bcrypt.hash(req.body.password, 12);
  if (req.body.unlock || req.body.password) {
    u.failedLogins = 0;
    u.lockedUntil = undefined;
  }
  u.tokenVersion = (u.tokenVersion ?? 0) + 1;
  (u as any).refreshTokens = [];
  await u.save();
  disconnectUserSockets(String(u._id));
  await audit(req, 'tenant.user_update', 'User', u._id, { isActive: req.body.isActive, passwordReset: !!req.body.password, unlock: !!req.body.unlock }, req.params.id);
  res.json({ _id: u._id, name: u.name, email: u.email, role: u.role, isActive: u.isActive, lastLoginAt: u.lastLoginAt });
}));

/** Resets the owner password (support action). */
superAdminRouter.post('/tenants/:id/owner-password', checkIdParams, validateBody(z.object({ password: z.string().min(10).max(200) })), ah(async (req, res) => {
  const owner = await User.findOne({ tenantId: req.params.id, role: 'owner' });
  if (!owner) throw notFound('Owner not found');
  owner.passwordHash = await bcrypt.hash(req.body.password, 12);
  owner.tokenVersion = (owner.tokenVersion ?? 0) + 1;
  (owner as any).refreshTokens = [];
  owner.failedLogins = 0;
  owner.lockedUntil = undefined;
  await owner.save();
  disconnectUserSockets(String(owner._id));
  await audit(req, 'tenant.owner_password_reset', 'User', owner._id, undefined, req.params.id);
  res.json({ ok: true });
}));

/* ----------------------------- Analytics ------------------------------ */
superAdminRouter.get('/overview', ah(async (_req, res) => {
  const since = new Date(Date.now() - 30 * 86400_000);
  const [byStatus, bySub, totalTenants, ordersAgg, daily, top, plans] = await runCrossTenant(() => Promise.all([
    Tenant.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Tenant.aggregate([{ $group: { _id: '$subscription.status', n: { $sum: 1 } } }]),
    Tenant.countDocuments(),
    Order.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: null, orders: { $sum: 1 }, gmv: { $sum: '$total' } } }]),
    Order.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: 'day' } }, orders: { $sum: 1 }, gmv: { $sum: '$total' } } },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$tenantId', orders: { $sum: 1 }, gmv: { $sum: '$total' } } },
      { $sort: { orders: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'tenants', localField: '_id', foreignField: '_id', as: 't' } },
      { $project: { orders: 1, gmv: 1, name: { $first: '$t.name' }, slug: { $first: '$t.slug' } } },
    ]),
    Tenant.aggregate([
      { $group: { _id: '$subscription.planId', n: { $sum: 1 }, paying: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'active'] }, { $in: ['$subscription.status', ['active', 'past_due']] }] }, 1, 0] } } } },
      { $lookup: { from: 'plans', localField: '_id', foreignField: '_id', as: 'p' } },
      { $project: { n: 1, paying: 1, name: { $first: '$p.name' }, price: { $first: '$p.priceMonthly' }, currency: { $first: '$p.currency' } } },
    ]),
  ]));
  // MRR counts only paying subscriptions (active or in past-due grace) of non-suspended tenants — never trials or expired.
  const mrr = plans.reduce((s: number, p: any) => s + (p.price ?? 0) * (p.paying ?? 0), 0);
  res.json({
    totalTenants,
    byStatus: Object.fromEntries(byStatus.map((x) => [x._id, x.n])),
    bySubscription: Object.fromEntries(bySub.map((x) => [x._id ?? 'none', x.n])),
    orders30: ordersAgg[0]?.orders ?? 0,
    gmv30: ordersAgg[0]?.gmv ?? 0,
    estimatedMRR: mrr,
    daily,
    topTenants: top,
    plans,
  });
}));

superAdminRouter.get('/audit', validateQuery(zPage.extend({ tenantId: z.string().optional(), action: z.string().optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = {};
  if (q.tenantId && /^[a-f0-9]{24}$/i.test(q.tenantId)) filter.tenantId = q.tenantId;
  if (q.action) filter.action = new RegExp(`^${q.action.replace(/[^a-z._]/gi, '')}`);
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
}));
