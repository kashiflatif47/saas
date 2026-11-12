import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Tenant } from '../models/platform';
import { Category, Product, effectivePrice } from '../models/menu';
import { Coupon, Feedback, Order, Reservation, Table } from '../models/operations';
import { ah, badRequest, notFound } from '../lib/errors';
import { checkIdParams, validateBody } from '../middleware/validate';
import { placeOrder, publicOrder } from '../services/orderService';
import { customerDeliveryView } from '../services/delivery';
import { DeliveryZone } from '../models/growth';
import { unsubscribe, unsubscribeToken } from '../services/marketing';
import { startOnlinePayment } from '../services/paymentService';
import { notify } from '../services/notify';
import { timingSafeEqualStr } from '../lib/crypto';
import { placeOrderSchema } from './orders';

/** Customer-facing API. Tenant is resolved from the Host header by resolvePublicTenant. */
export const publicRouter = Router();

const orderLimiter = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: true, legacyHeaders: false });
const formLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

/** Is a category visible right now given its schedule (in the tenant's timezone)? */
export function categoryVisibleNow(schedule: { days?: number[]; from?: string; to?: string } | undefined, tz: string, now = new Date()): boolean {
  if (!schedule || ((!schedule.days || schedule.days.length === 0) && !schedule.from && !schedule.to)) return true;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')!.value);
  const hm = `${parts.find((p) => p.type === 'hour')!.value.replace('24', '00')}:${parts.find((p) => p.type === 'minute')!.value}`;
  if (schedule.days?.length && !schedule.days.includes(wd)) return false;
  if (schedule.from && schedule.to) {
    return schedule.from <= schedule.to ? hm >= schedule.from && hm < schedule.to : hm >= schedule.from || hm < schedule.to;
  }
  return true;
}

publicRouter.get('/storefront', ah(async (req, res) => {
  const t = await Tenant.findById(req.tenantId).select('name slug businessType contact branding settings payments.cashEnabled payments.provider payments.providerPublicKey payments.providerVerifiedAt').lean();
  if (!t) throw notFound();
  const s: any = t.settings;
  res.json({
    name: t.name,
    slug: t.slug,
    businessType: t.businessType,
    contact: t.contact,
    branding: t.branding,
    settings: {
      currency: s.currency, currencyDecimals: s.currencyDecimals, defaultLanguage: s.defaultLanguage, languages: s.languages,
      taxRatePercent: s.taxRatePercent, taxInclusive: s.taxInclusive, serviceChargePercent: s.serviceChargePercent,
      guestOrdering: s.guestOrdering, orderTypes: s.orderTypes, openingHours: s.openingHours, requireTableForDineIn: s.requireTableForDineIn,
      deliveryFee: s.deliveryFee ?? 0, taxLabel: s.taxLabel || undefined,
    },
    // Active delivery zones (name, fee, minimum, ETA). Boundaries stay server-side; the server matches the address.
    deliveryZones: (await DeliveryZone.find({ tenantId: req.tenantId, isActive: true }).select('name fee minOrder etaMinutes hours').sort({ name: 1 }).lean()).map((z) => ({ _id: z._id, name: z.name, fee: z.fee, minOrder: z.minOrder, etaMinutes: z.etaMinutes, hours: z.hours })),
    payments: {
      cash: t.payments?.cashEnabled !== false,
      online: t.payments?.provider === 'stripe' && !!t.payments?.providerVerifiedAt && req.tenant!.features.has('online_payments') ? { provider: 'stripe', publicKey: t.payments.providerPublicKey } : null,
    },
    features: { reservations: req.tenant!.features.has('reservations'), qrOrdering: req.tenant!.features.has('qr_ordering') },
  });
}));

publicRouter.get('/menu', ah(async (req, res) => {
  const tz = req.tenant!.settings?.timezone ?? 'UTC';
  const cats = (await Category.find({ tenantId: req.tenantId, isActive: true }).sort({ sortOrder: 1 }).lean()).filter((c) => categoryVisibleNow(c.schedule as any, tz));
  const visibleIds = new Set(cats.map((c) => String(c._id)));
  // Subcategory hidden if its parent is hidden.
  const categories = cats.filter((c) => !c.parentId || visibleIds.has(String(c.parentId)));
  const catIds = categories.map((c) => c._id);
  const products = await Product.find({ tenantId: req.tenantId, isArchived: false, categoryId: { $in: catIds } })
    .select('-recipe -tenantId')
    .sort({ sortOrder: 1, createdAt: -1 })
    .lean();
  res.json({
    categories,
    products: products.map((p) => ({
      ...p,
      effectivePrice: effectivePrice(p as any),
      soldOut: !p.isAvailable || (p.trackStock && p.stockQty <= 0),
      stockQty: undefined,
      addons: p.addons.filter((a: any) => a.isAvailable),
    })),
  });
}));

/** Resolves a QR table token for the current tenant host. A token from another tenant never resolves. */
publicRouter.get('/tables/:token', ah(async (req, res) => {
  const token = String(req.params.token);
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) throw notFound('Table not found');
  const t = await Table.findOne({ tenantId: req.tenantId, qrToken: token, isActive: true }).select('label area').lean();
  if (!t) throw notFound('This QR code is no longer valid. Please ask staff for help.');
  res.json({ label: t.label, area: t.area, token });
}));

publicRouter.post('/coupons/validate', formLimiter, validateBody(z.object({ code: z.string().min(1).max(40) })), ah(async (req, res) => {
  const now = new Date();
  const c = await Coupon.findOne({ tenantId: req.tenantId, code: req.body.code.toUpperCase().trim(), isActive: true }).lean();
  const valid = !!c && (!c.startsAt || c.startsAt <= now) && (!c.endsAt || c.endsAt >= now) && (c.usageLimit == null || c.usedCount < c.usageLimit);
  if (!valid) throw badRequest('Coupon is invalid or expired');
  res.json({ code: c!.code, type: c!.type, value: c!.value, maxDiscount: c!.maxDiscount, minOrder: c!.minOrder, description: c!.description, restrictions: { productIds: c!.productIds ?? [], categoryIds: c!.categoryIds ?? [], personal: !!c!.customerIds?.length } });
}));

publicRouter.post('/orders', orderLimiter, validateBody(placeOrderSchema.omit({ tableId: true, orderDiscount: true, discountReason: true, confirm: true })), ah(async (req, res) => {
  if (req.body.tableToken && !req.tenant!.features.has('qr_ordering')) throw badRequest('QR ordering is not enabled for this restaurant');
  const { order, trackingToken } = await placeOrder(req.tenant!, req.body, req.body.tableToken ? 'qr' : 'website');
  res.status(201).json({ order: publicOrder(order), trackingToken });
}));

async function loadTrackedOrder(tenantId: any, id: string, token: unknown) {
  if (typeof token !== 'string' || token.length < 10) throw notFound('Order not found');
  const order = await Order.findOne({ tenantId, _id: id }).select('+trackingToken +delivery.code').lean();
  if (!order || !timingSafeEqualStr(order.trackingToken, token)) throw notFound('Order not found');
  return order;
}

publicRouter.get('/orders/:id', checkIdParams, ah(async (req, res) => {
  const order = await loadTrackedOrder(req.tenantId, req.params.id, req.query.token);
  const { customer: _c, customerId: _ci, assignedWaiterId: _w, ...rest } = publicOrder(order);
  if (rest.type === 'delivery') (rest as any).delivery = { address: order.delivery?.address, ...customerDeliveryView(order.delivery, { includeCode: true }) };
  // Lets the tracking page show "thank you" instead of a second rating form after a reload.
  const feedbackGiven = !!(await Feedback.exists({ tenantId: req.tenantId, orderId: order._id }));
  res.json({ ...rest, feedbackGiven });
}));

publicRouter.post('/orders/:id/pay', orderLimiter, checkIdParams, validateBody(z.object({ token: z.string().min(10).max(64) })), ah(async (req, res) => {
  await loadTrackedOrder(req.tenantId, req.params.id, req.body.token);
  if (!req.tenant!.features.has('online_payments')) throw badRequest('Online payments are not available');
  res.json(await startOnlinePayment(req.tenantId!, req.params.id));
}));

publicRouter.post('/orders/:id/feedback', formLimiter, checkIdParams, validateBody(z.object({ token: z.string().min(10).max(64), rating: z.number().int().min(1).max(5), comment: z.string().max(1000).optional(), name: z.string().max(80).optional() })), ah(async (req, res) => {
  const order = await loadTrackedOrder(req.tenantId, req.params.id, req.body.token);
  if (!['delivered', 'completed'].includes(order.status)) throw badRequest('Feedback is available once your order is served');
  const fb = await Feedback.create({ tenantId: req.tenantId, orderId: order._id, rating: req.body.rating, comment: req.body.comment, name: req.body.name });
  await notify(req.tenantId!, { type: 'feedback.new', title: `New ${req.body.rating}★ feedback`, body: req.body.comment?.slice(0, 120), link: '/dashboard/feedback', roles: ['owner', 'admin', 'manager'] });
  res.status(201).json({ ok: true, id: fb._id });
}));

publicRouter.get('/feedback', ah(async (req, res) => {
  const items = await Feedback.find({ tenantId: req.tenantId, isPublished: true }).select('rating comment name createdAt response').sort({ createdAt: -1 }).limit(12).lean();
  res.json({ items });
}));

publicRouter.post('/reservations', formLimiter, validateBody(z.object({
  name: z.string().min(2).max(80),
  phone: z.string().min(5).max(25),
  email: z.string().email().optional(),
  partySize: z.number().int().min(1).max(50),
  reservedFor: z.coerce.date().refine((d) => d.getTime() > Date.now() - 5 * 60_000, 'Reservation must be in the future'),
  notes: z.string().max(500).optional(),
})), ah(async (req, res) => {
  if (!req.tenant!.features.has('reservations')) throw badRequest('Online reservations are not available');
  const r = await Reservation.create({ ...req.body, tenantId: req.tenantId, status: 'pending' });
  await notify(req.tenantId!, { type: 'reservation.new', title: `Reservation request · ${req.body.partySize} guests`, body: `${req.body.name} — ${new Date(req.body.reservedFor).toLocaleString()}`, link: '/dashboard/reservations', roles: ['owner', 'admin', 'manager', 'waiter'] });
  res.status(201).json({ ok: true, id: r._id, status: r.status });
}));


/** One-click opt-out from marketing (link in every marketing message). The token is an HMAC of tenant + customer. */
publicRouter.post('/unsubscribe', formLimiter, validateBody(z.object({ c: z.string().regex(/^[a-f\d]{24}$/i), t: z.string().min(10).max(64) })), ah(async (req, res) => {
  if (!timingSafeEqualStr(unsubscribeToken(String(req.tenantId), req.body.c), req.body.t)) throw badRequest('This unsubscribe link is invalid');
  await unsubscribe(req.tenantId!, req.body.c, 'unsubscribe_link');
  res.json({ ok: true });
}));
