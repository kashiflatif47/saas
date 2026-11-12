import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AiUsage, Campaign, DeliveryZone, Job, Journey, MessageLog, Recommendation, Suppression } from '../models/growth';
import { Customer, Order } from '../models/operations';
import { Tenant, User } from '../models/platform';
import { ah, badRequest, forbidden, notFound } from '../lib/errors';
import { can } from '../middleware/auth';
import { checkIdParams, validateBody, validateQuery, zHex, zId, zMoney, zPage } from '../middleware/validate';
import { roleHas } from '../config/permissions';
import { audit } from '../services/audit';
import { encryptSecret } from '../lib/crypto';
import { env } from '../config/env';
import { invalidateTenantCache } from '../services/tenantResolver';
import { businessOverview, customerCounts } from '../services/intelligence';
import { getForecast } from '../services/forecast';
import { refreshRecommendations } from '../services/recommendations';
import { aiStatus, askAssistant, draftMarketingCopy } from '../services/ai';
import { recalculateSegments, rulesFor, SEGMENTS } from '../services/segments';
import { campaignCreate, campaignReport, previewCampaign, setConsent, testSend, transitionCampaign, updateCampaign } from '../services/marketing';
import { providerFor, twilioStatusCallbackUrl } from '../services/messaging';
import { ACTIVE_DELIVERY, deliveryAnalytics, dispatcherAction, rankRiders, riderAction, riderView, updateRiderLocation, validLatLng } from '../services/delivery';
import { SALE_STATUSES } from '../services/intelligence';
void zHex;

const periodQ = z.object({ period: z.enum(['today', 'week', 'month', 'year']).optional(), from: z.string().max(30).optional(), to: z.string().max(30).optional() });
const has = (req: any, p: Parameters<typeof roleHas>[1]) => roleHas(req.user.role, p, req.user.permissionOverrides);
async function setSettings(tenantId: any, group: string, values: Record<string, unknown>) {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) set[`settings.${group}.${k}`] = v;
  const t = await Tenant.findByIdAndUpdate(tenantId, { $set: set }, { new: true, runValidators: true }).lean();
  invalidateTenantCache(t!.slug);
  return (t!.settings as any)[group];
}

/* ====================================================================== intelligence */
export const intelligenceRouter = Router();
const assistantLimiter = rateLimit({ windowMs: 60_000, limit: 20, keyGenerator: (req: any) => `${req.tenantId}:${req.user?.id}`, standardHeaders: true, legacyHeaders: false });

intelligenceRouter.get('/overview', can('intelligence:view'), validateQuery(periodQ), ah(async (req, res) => {
  res.json(await businessOverview(req.tenant!, (req as any).validQuery));
}));

intelligenceRouter.get('/forecast', can('intelligence:view'), validateQuery(z.object({ horizon: z.coerce.number().refine((n) => [1, 7, 30, 90].includes(n)).default(7), refresh: z.enum(['true', 'false']).optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  res.json(await getForecast(req.tenant!, q.horizon, { refresh: q.refresh === 'true' }));
}));

intelligenceRouter.get('/recommendations', can('intelligence:view'), validateQuery(zPage.extend({ status: z.enum(['open', 'accepted', 'rejected', 'dismissed']).optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId };
  if (q.status) filter.status = q.status;
  const [items, total] = await Promise.all([Recommendation.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Recommendation.countDocuments(filter)]);
  res.json({ items, total });
}));
intelligenceRouter.post('/recommendations/refresh', can('intelligence:view'), ah(async (req, res) => {
  res.json(await refreshRecommendations(req.tenant!));
}));
intelligenceRouter.post('/recommendations/:id/decision', can('intelligence:view'), checkIdParams, validateBody(z.object({ decision: z.enum(['accepted', 'rejected', 'dismissed']), note: z.string().max(300).optional() })), ah(async (req, res) => {
  const r = await Recommendation.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id, status: 'open' }, { $set: { status: req.body.decision, decidedBy: req.user!.name, decidedAt: new Date(), decisionNote: req.body.note } }, { new: true }).lean();
  if (!r) throw badRequest('Recommendation not found or already decided');
  await audit(req, `recommendation.${req.body.decision}`, 'Recommendation', r._id, { rule: r.rule });
  res.json(r);
}));

intelligenceRouter.get('/ai-status', can('intelligence:view', 'analytics:view'), (_req, res) => res.json(aiStatus()));
intelligenceRouter.post('/assistant', can('intelligence:view', 'analytics:view'), assistantLimiter, validateBody(z.object({ question: z.string().min(2).max(500), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).max(10).optional() })), ah(async (req, res) => {
  const reply = await askAssistant({ tenant: req.tenant!, user: req.user! }, req.body.question, req.body.history ?? []);
  await audit(req, 'assistant.ask', 'Assistant', undefined, { mode: reply.mode, tools: reply.toolsUsed.map((t) => t.name) });
  res.json(reply);
}));
intelligenceRouter.get('/ai-usage', can('settings:manage'), ah(async (req, res) => {
  const since = new Date(Date.now() - 30 * 86400_000);
  const [agg] = await AiUsage.aggregate([{ $match: { tenantId: req.tenantId, createdAt: { $gte: since } } }, { $group: { _id: null, calls: { $sum: 1 }, failed: { $sum: { $cond: ['$ok', 0, 1] } }, inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } }, outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } }, estimatedCostUsd: { $sum: { $ifNull: ['$estimatedCostUsd', 0] } } } }]);
  res.json({ last30Days: agg ?? { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, note: 'Cost is an estimate from published per-token prices; your Anthropic invoice is authoritative.' });
}));
intelligenceRouter.get('/jobs', can('intelligence:view'), ah(async (req, res) => {
  const items = await Job.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(100).select('type status runAt attempts maxAttempts lastError finishedAt createdAt').lean();
  res.json({ items });
}));
intelligenceRouter.patch('/settings', can('settings:manage'), validateBody(z.object({ foodCostTargetPercent: z.number().min(1).max(100).optional(), reorderLeadDays: z.number().int().min(1).max(60).optional() })), ah(async (req, res) => {
  res.json(await setSettings(req.tenantId, 'intelligence', req.body));
}));

/** Owner dashboard snapshot across intelligence, marketing and delivery (each section only if permitted). */
intelligenceRouter.get('/summary', can('intelligence:view'), ah(async (req, res) => {
  const tenantId = req.tenantId!;
  const out: any = {};
  const f: any = await getForecast(req.tenant!, 1);
  out.forecastTomorrowish = f.sufficient ? { sales: f.sales.total, orders: f.orders.total, peakHours: f.hourly.peakHours, confidence: f.accuracy.confidence, generatedAt: f.generatedAt, reorder: f.ingredients.items.filter((i: any) => i.reorderSuggested).slice(0, 5) } : { sufficient: false, reason: f.reason };
  out.recommendations = await Recommendation.find({ tenantId, status: 'open' }).sort({ priority: 1, createdAt: -1 }).limit(5).lean();
  if (has(req, 'marketing:manage')) {
    out.marketing = {
      running: await Campaign.countDocuments({ tenantId, status: 'running' }),
      scheduled: await Campaign.countDocuments({ tenantId, status: 'scheduled' }),
      awaitingApproval: await Campaign.countDocuments({ tenantId, status: 'pending_approval' }),
      segments: await customerCounts(tenantId),
      consenting: await Customer.countDocuments({ tenantId, $or: [{ 'consent.sms.granted': true }, { 'consent.whatsapp.granted': true }, { 'consent.email.granted': true }] }),
    };
  }
  if (has(req, 'delivery:dispatch')) {
    out.delivery = {
      active: await Order.countDocuments({ tenantId, 'delivery.status': { $in: ACTIVE_DELIVERY } }),
      awaitingRider: await Order.countDocuments({ tenantId, 'delivery.status': 'awaiting_assignment' }),
      delayed: await Order.countDocuments({ tenantId, 'delivery.status': { $in: ['awaiting_assignment', ...ACTIVE_DELIVERY] }, 'delivery.etaAt': { $lt: new Date() } }),
      ridersAvailable: await User.countDocuments({ tenantId, role: 'rider', isActive: true, 'riderProfile.available': true }),
    };
  }
  res.json(out);
}));

/* ====================================================================== marketing */
export const marketingRouter = Router();
const zChannel = z.enum(['sms', 'whatsapp', 'email']);
const zCoupon = z.object({ type: z.enum(['percent', 'fixed']), value: z.number().int().min(1), maxDiscount: zMoney.optional(), minOrder: zMoney.optional(), validDays: z.number().int().min(1).max(365).optional(), productIds: z.array(zId).max(50).optional(), categoryIds: z.array(zId).max(50).optional() }).refine((c) => c.type !== 'percent' || c.value <= 100, 'Percent offers must be 1–100');
const segList = z.array(z.enum(Object.keys(SEGMENTS) as [keyof typeof SEGMENTS, ...(keyof typeof SEGMENTS)[]])).max(10);
const campaignBody = z.object({ name: z.string().min(2).max(120), channel: zChannel, segments: segList.default([]), subject: z.string().max(150).optional(), body: z.string().min(5).max(1600), aiGenerated: z.boolean().optional(), endAt: z.coerce.date().nullable().optional(), budget: z.object({ limit: zMoney.nullable().optional() }).optional(), coupon: zCoupon.nullable().optional() });

marketingRouter.get('/segments', can('marketing:manage'), ah(async (req, res) => {
  res.json({ definitions: SEGMENTS, rules: rulesFor(req.tenant!), counts: await customerCounts(req.tenantId!), totalCustomers: await Customer.countDocuments({ tenantId: req.tenantId }) });
}));
marketingRouter.post('/segments/recalculate', can('marketing:manage'), ah(async (req, res) => {
  res.json(await recalculateSegments(req.tenant!));
}));
marketingRouter.patch('/segments/rules', can('marketing:approve'), validateBody(z.object({ newDays: z.number().int().min(1).max(365), loyalOrders: z.number().int().min(2).max(100), highValueTopPercent: z.number().min(1).max(50), atRiskDays: z.number().int().min(7).max(365), inactiveDays: z.number().int().min(14).max(730) }).partial().refine((r) => !r.atRiskDays || !r.inactiveDays || r.atRiskDays < r.inactiveDays, 'At-risk days must be fewer than inactive days')), ah(async (req, res) => {
  const rules = await setSettings(req.tenantId, 'segmentRules', req.body);
  await audit(req, 'marketing.segment_rules', 'Tenant', req.tenantId, req.body);
  res.json(rules);
}));

const maskPhone = (p?: string | null) => (p ? p.replace(/^(.{3}).*(.{3})$/, '$1•••••$2') : p);
marketingRouter.get('/customers', can('marketing:manage'), validateQuery(zPage.extend({ segment: z.string().max(40).optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId };
  if (q.segment) filter.segments = q.segment;
  if (q.q) filter.$or = [{ name: new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { phone: new RegExp(q.q.replace(/[^\d+]/g, '')) }];
  const full = has(req, 'customers:manage');
  const [items, total] = await Promise.all([Customer.find(filter).select('name phone email segments stats consent birthday').sort({ 'stats.lastOrderAt': -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Customer.countDocuments(filter)]);
  res.json({ items: items.map((c) => (full ? c : { ...c, phone: maskPhone(c.phone), email: c.email ? '•••' : undefined })), total, page: q.page, limit: q.limit });
}));
marketingRouter.get('/customers/:id', can('marketing:manage'), checkIdParams, ah(async (req, res) => {
  const c = await Customer.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
  if (!c) throw notFound('Customer not found');
  const orders = await Order.find({ tenantId: req.tenantId, customerId: c._id }).sort({ createdAt: -1 }).limit(50).select('orderNumber createdAt type status total couponCode').lean();
  const messages = await MessageLog.find({ tenantId: req.tenantId, customerId: c._id }).sort({ createdAt: -1 }).limit(20).select('channel status skipReason sentAt createdAt source').lean();
  const full = has(req, 'customers:manage');
  res.json({ customer: full ? c : { ...c, phone: maskPhone(c.phone), email: c.email ? '•••' : undefined }, orders, messages, sales: orders.filter((o) => SALE_STATUSES.includes(o.status)).length });
}));
marketingRouter.patch('/customers/:id/consent', can('marketing:manage'), checkIdParams, validateBody(z.object({ channels: z.array(zChannel).min(1), granted: z.boolean(), birthday: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).nullable().optional() })), ah(async (req, res) => {
  const c = await Customer.findOne({ tenantId: req.tenantId, _id: req.params.id }).select('_id').lean();
  if (!c) throw notFound('Customer not found');
  await setConsent(req.tenantId!, c._id, req.body.channels, req.body.granted, `staff:${req.user!.name}`);
  if (req.body.birthday !== undefined) await Customer.updateOne({ tenantId: req.tenantId, _id: c._id }, { $set: { birthday: req.body.birthday ?? undefined } });
  await audit(req, 'marketing.consent', 'Customer', c._id, { channels: req.body.channels, granted: req.body.granted });
  res.json(await Customer.findOne({ tenantId: req.tenantId, _id: c._id }).select('consent birthday').lean());
}));

marketingRouter.get('/campaigns', can('marketing:manage'), ah(async (req, res) => {
  res.json({ items: await Campaign.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(200).lean() });
}));
marketingRouter.post('/campaigns', can('marketing:manage'), validateBody(campaignBody), ah(async (req, res) => {
  const c = await campaignCreate(req.tenant!, req.body, req.user!);
  await audit(req, 'campaign.create', 'Campaign', c._id, { channel: c.channel, aiGenerated: c.aiGenerated });
  res.status(201).json(c);
}));
marketingRouter.get('/campaigns/:id', can('marketing:manage'), checkIdParams, ah(async (req, res) => {
  const c = await Campaign.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
  if (!c) throw notFound('Campaign not found');
  res.json(c);
}));
marketingRouter.patch('/campaigns/:id', can('marketing:manage'), checkIdParams, validateBody(campaignBody.partial()), ah(async (req, res) => {
  const c = await updateCampaign(req.tenant!, req.params.id, req.body, req.user!);
  await audit(req, 'campaign.update', 'Campaign', req.params.id, { fields: Object.keys(req.body) });
  res.json(c);
}));
marketingRouter.post('/campaigns/:id/test', can('marketing:manage'), checkIdParams, validateBody(z.object({ to: z.string().min(5).max(200) })), ah(async (req, res) => {
  const r = await testSend(req.tenant!, req.params.id, req.body.to, req.user!);
  await audit(req, 'campaign.test_send', 'Campaign', req.params.id);
  res.json(r);
}));
marketingRouter.post('/campaigns/:id/:action', can('marketing:manage'), checkIdParams, validateBody(z.object({ scheduleAt: z.coerce.date().optional() })), ah(async (req, res) => {
  const action = req.params.action as any;
  if (!['submit', 'approve', 'schedule', 'pause', 'resume', 'cancel'].includes(action)) throw notFound('Unknown action');
  // Launch decisions need marketing:approve (owner/admin by default); managers can draft, submit and pause.
  if (['approve', 'schedule', 'resume'].includes(action) && !has(req, 'marketing:approve')) throw forbidden('Only someone with approval rights can approve or launch campaigns');
  const c = await transitionCampaign(req.tenant!, req.params.id, action, req.user!, req.body);
  await audit(req, `campaign.${action}`, 'Campaign', req.params.id, { scheduleAt: req.body.scheduleAt });
  res.json(c);
}));
marketingRouter.get('/campaigns/:id/preview', can('marketing:manage'), checkIdParams, ah(async (req, res) => res.json(await previewCampaign(req.tenant!, req.params.id))));
marketingRouter.get('/campaigns/:id/report', can('marketing:manage'), checkIdParams, ah(async (req, res) => res.json(await campaignReport(req.tenant!, req.params.id))));

const journeyBody = z.object({ name: z.string().min(2).max(120), trigger: z.enum(['joined', 'first_order', 'second_order', 'inactive', 'birthday', 'order_count', 'spend_threshold']), config: z.object({ days: z.number().int().min(7).max(365).optional(), count: z.number().int().min(2).max(500).optional(), amount: zMoney.optional() }).default({}), channel: zChannel, subject: z.string().max(150).optional(), body: z.string().min(5).max(1600), coupon: zCoupon.nullable().optional(), aiGenerated: z.boolean().optional() });
marketingRouter.get('/journeys', can('marketing:manage'), ah(async (req, res) => res.json({ items: await Journey.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).lean() })));
marketingRouter.post('/journeys', can('marketing:manage'), validateBody(journeyBody), ah(async (req, res) => {
  const j = await Journey.create({ ...req.body, tenantId: req.tenantId, status: 'draft', createdBy: req.user!.name });
  await audit(req, 'journey.create', 'Journey', j._id, { trigger: j.trigger });
  res.status(201).json(j);
}));
marketingRouter.patch('/journeys/:id', can('marketing:manage'), checkIdParams, validateBody(journeyBody.partial()), ah(async (req, res) => {
  // Any edit stops the automation until it is approved again.
  const j = await Journey.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: { ...req.body, status: 'draft', approvedBy: null, approvedAt: null } }, { new: true, runValidators: true }).lean();
  if (!j) throw notFound('Automation not found');
  await audit(req, 'journey.update', 'Journey', j._id);
  res.json(j);
}));
marketingRouter.post('/journeys/:id/:action', can('marketing:manage'), checkIdParams, ah(async (req, res) => {
  const action = req.params.action;
  if (action === 'activate') {
    if (!has(req, 'marketing:approve')) throw forbidden('Only someone with approval rights can activate automations');
    const j = await Journey.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!j) throw notFound('Automation not found');
    if (!(await providerFor(req.tenantId!, j.channel as any))) throw badRequest(`No ${j.channel} provider is configured`);
    const r = await Journey.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: { status: 'active', approvedBy: req.user!.name, approvedAt: new Date() } }, { new: true }).lean();
    await audit(req, 'journey.activate', 'Journey', req.params.id);
    return void res.json(r);
  }
  if (action === 'pause') {
    const r = await Journey.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: { status: 'paused' } }, { new: true }).lean();
    if (!r) throw notFound('Automation not found');
    await audit(req, 'journey.pause', 'Journey', req.params.id);
    return void res.json(r);
  }
  throw notFound('Unknown action');
}));

marketingRouter.post('/copy', can('marketing:manage'), assistantLimiter, validateBody(z.object({ goal: z.string().min(3).max(300), channel: zChannel, offer: z.string().max(200).optional(), tone: z.string().max(60).optional(), language: z.string().max(30).optional() })), ah(async (req, res) => {
  res.json(await draftMarketingCopy({ tenant: req.tenant!, user: req.user! }, req.body));
}));

marketingRouter.get('/channels', can('marketing:manage'), ah(async (req, res) => {
  const t = await Tenant.findById(req.tenantId).select('+messaging.sms.authTokenEnc +messaging.email.apiKeyEnc').lean();
  const m: any = t?.messaging ?? {};
  res.json({
    sms: { provider: m.sms?.provider ?? 'none', accountSid: m.sms?.accountSid, from: m.sms?.from, hasAuthToken: !!m.sms?.authTokenEnc, verifiedAt: m.sms?.verifiedAt, statusCallbackUrl: twilioStatusCallbackUrl(String(req.tenantId)) },
    whatsapp: { provider: m.whatsapp?.provider ?? 'none', from: m.whatsapp?.from, note: 'Uses the Twilio account above. WhatsApp only accepts approved templates outside a 24-hour customer session.' },
    email: { provider: m.email?.provider ?? 'none', from: m.email?.from, hasApiKey: !!m.email?.apiKeyEnc, verifiedAt: m.email?.verifiedAt, note: 'Delivery events are not imported; "sent" means SendGrid accepted the email.' },
    push: { available: false, note: 'Push notifications are not implemented (needs Web Push subscriptions).' },
    costs: m.costs ?? {},
  });
}));
marketingRouter.patch('/channels', can('settings:manage'), validateBody(z.object({
  sms: z.object({ provider: z.enum(['none', 'twilio']), accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/).optional(), authToken: z.string().regex(/^[0-9a-fA-F]{32}$/).optional(), from: z.string().regex(/^\+[1-9]\d{6,14}$/).optional() }).partial().optional(),
  whatsapp: z.object({ provider: z.enum(['none', 'twilio']), from: z.string().regex(/^\+[1-9]\d{6,14}$/).optional() }).partial().optional(),
  email: z.object({ provider: z.enum(['none', 'sendgrid']), apiKey: z.string().regex(/^SG\.[\w-]{10,}\.[\w-]{10,}$/).optional(), from: z.string().email().optional() }).partial().optional(),
  costs: z.object({ sms: zMoney, whatsapp: zMoney, email: zMoney }).partial().optional(),
})), ah(async (req, res) => {
  const b = req.body;
  const set: Record<string, unknown> = {};
  for (const [ch, v] of Object.entries(b) as [string, any][]) {
    if (ch === 'costs') { for (const [k, c] of Object.entries(v)) set[`messaging.costs.${k}`] = c; continue; }
    for (const [k, val] of Object.entries(v)) {
      if (k === 'authToken') set['messaging.sms.authTokenEnc'] = encryptSecret(val as string, env.ENCRYPTION_KEY);
      else if (k === 'apiKey') set['messaging.email.apiKeyEnc'] = encryptSecret(val as string, env.ENCRYPTION_KEY);
      else set[`messaging.${ch}.${k}`] = val;
    }
    set[`messaging.${ch}.verifiedAt`] = null; // changed credentials must be verified again
  }
  await Tenant.updateOne({ _id: req.tenantId }, { $set: set });
  await audit(req, 'marketing.channels', 'Tenant', req.tenantId, { channels: Object.keys(b), secretsChanged: !!(b.sms?.authToken || b.email?.apiKey) });
  res.json({ ok: true });
}));
marketingRouter.post('/channels/:channel/verify', can('settings:manage'), ah(async (req, res) => {
  const ch = req.params.channel as any;
  if (!['sms', 'whatsapp', 'email'].includes(ch)) throw notFound();
  const p = await providerFor(req.tenantId!, ch);
  if (!p) throw badRequest(`Configure the ${ch} provider first`);
  try {
    await p.verify();
  } catch (e: any) {
    throw badRequest(e.message);
  }
  await Tenant.updateOne({ _id: req.tenantId }, { $set: { [`messaging.${ch}.verifiedAt`]: new Date() } });
  res.json({ ok: true, verifiedAt: new Date() });
}));

marketingRouter.get('/suppressions', can('marketing:manage'), ah(async (req, res) => res.json({ items: await Suppression.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(500).lean() })));
marketingRouter.post('/suppressions', can('marketing:manage'), validateBody(z.object({ channel: z.enum(['sms', 'whatsapp', 'email', 'all']), address: z.string().min(5).max(200), reason: z.string().max(200).optional() })), ah(async (req, res) => {
  const address = req.body.address.includes('@') ? req.body.address.toLowerCase() : req.body.address.replace(/[^\d+]/g, '');
  await Suppression.updateOne({ tenantId: req.tenantId, channel: req.body.channel, address }, { $setOnInsert: { tenantId: req.tenantId, channel: req.body.channel, address, reason: req.body.reason ?? 'added by staff', source: req.user!.name } }, { upsert: true });
  await audit(req, 'marketing.suppress', 'Suppression', undefined, { channel: req.body.channel });
  res.status(201).json({ ok: true });
}));
marketingRouter.delete('/suppressions/:id', can('marketing:approve'), checkIdParams, ah(async (req, res) => {
  const s = await Suppression.findOneAndDelete({ tenantId: req.tenantId, _id: req.params.id }).lean();
  if (!s) throw notFound('Not found');
  await audit(req, 'marketing.unsuppress', 'Suppression', req.params.id, { reason: s.reason });
  res.json({ ok: true, note: 'Removing a suppression does not restore consent; the customer must opt in again.' });
}));
marketingRouter.get('/messages', can('marketing:manage'), validateQuery(zPage.extend({ status: z.string().max(20).optional(), sourceId: z.string().max(40).optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId };
  if (q.status) filter.status = q.status;
  if (q.sourceId) filter['source.id'] = q.sourceId;
  const [items, total] = await Promise.all([MessageLog.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).select('-body').lean(), MessageLog.countDocuments(filter)]);
  res.json({ items: items.map((m) => ({ ...m, to: m.to ? (m.to.includes('@') ? m.to.replace(/^(.).*(@.*)$/, '$1***$2') : maskPhone(m.to)) : m.to })), total });
}));
marketingRouter.patch('/settings', can('marketing:approve'), validateBody(z.object({ quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), maxPerWeek: z.number().int().min(1).max(14), minHoursBetween: z.number().int().min(1).max(168), attributionDays: z.number().int().min(1).max(30), countryCode: z.string().regex(/^(\+\d{1,4})?$/) }).partial()), ah(async (req, res) => {
  const r = await setSettings(req.tenantId, 'marketing', req.body);
  await audit(req, 'marketing.settings', 'Tenant', req.tenantId, req.body);
  res.json(r);
}));

/* ====================================================================== delivery */
export const deliveryRouter = Router();
const zLatLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const zoneBody = z.object({
  name: z.string().min(2).max(60),
  polygon: z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(3).max(500).optional(),
  circle: z.object({ center: zLatLng, radiusKm: z.number().gt(0).max(100) }).optional(),
  fee: zMoney.default(0),
  minOrder: zMoney.default(0),
  etaMinutes: z.number().int().min(5).max(240).default(30),
  isActive: z.boolean().default(true),
  hours: z.object({ days: z.array(z.number().int().min(0).max(6)).max(7).default([]), from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).or(z.literal('')).optional(), to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).or(z.literal('')).optional() }).optional(),
}).refine((z2) => !!z2.polygon !== !!z2.circle, 'Define either a polygon or a circle');

deliveryRouter.get('/zones', can('delivery:dispatch', 'delivery:manage'), ah(async (req, res) => res.json({ items: await DeliveryZone.find({ tenantId: req.tenantId }).sort({ name: 1 }).lean() })));
deliveryRouter.post('/zones', can('delivery:manage'), validateBody(zoneBody), ah(async (req, res) => {
  const z1 = await DeliveryZone.create({ ...req.body, tenantId: req.tenantId });
  await audit(req, 'delivery.zone_create', 'DeliveryZone', z1._id);
  res.status(201).json(z1);
}));
deliveryRouter.put('/zones/:id', can('delivery:manage'), checkIdParams, validateBody(zoneBody), ah(async (req, res) => {
  const z1 = await DeliveryZone.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: { ...req.body, polygon: req.body.polygon ?? undefined, circle: req.body.circle ?? undefined }, ...(req.body.polygon ? { $unset: { circle: 1 } } : { $unset: { polygon: 1 } }) }, { new: true }).lean();
  if (!z1) throw notFound('Zone not found');
  await audit(req, 'delivery.zone_update', 'DeliveryZone', z1._id);
  res.json(z1);
}));
deliveryRouter.delete('/zones/:id', can('delivery:manage'), checkIdParams, ah(async (req, res) => {
  const z1 = await DeliveryZone.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: { isActive: false } }).lean();
  if (!z1) throw notFound('Zone not found');
  await audit(req, 'delivery.zone_deactivate', 'DeliveryZone', z1._id);
  res.json({ ok: true });
}));

deliveryRouter.get('/riders', can('delivery:dispatch', 'delivery:manage'), ah(async (req, res) => {
  const riders = await User.find({ tenantId: req.tenantId, role: 'rider' }).select('name phone isActive riderProfile lastLoginAt').lean();
  const loads = await Order.aggregate([{ $match: { tenantId: req.tenantId, 'delivery.status': { $in: ACTIVE_DELIVERY } } }, { $group: { _id: '$delivery.riderId', n: { $sum: 1 } } }]);
  const by = new Map(loads.map((l) => [String(l._id), l.n]));
  res.json({ items: riders.map((r: any) => ({ ...r, activeDeliveries: by.get(String(r._id)) ?? 0, riderProfile: { ...r.riderProfile, location: r.riderProfile?.location ? { at: r.riderProfile.location.at, shared: true } : null } })) });
}));
deliveryRouter.patch('/riders/:id', can('delivery:manage'), checkIdParams, validateBody(z.object({ phone: z.string().max(30).optional(), vehicle: z.string().max(60).optional(), available: z.boolean().optional(), zoneIds: z.array(zId).max(50).optional() })), ah(async (req, res) => {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.body)) set[`riderProfile.${k}`] = v;
  if (req.body.available === false) set['riderProfile.location'] = null;
  const u = await User.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id, role: 'rider' }, { $set: set }, { new: true }).select('name riderProfile').lean();
  if (!u) throw notFound('Rider not found');
  await audit(req, 'delivery.rider_update', 'User', u._id, { fields: Object.keys(req.body) });
  res.json(u);
}));

deliveryRouter.get('/board', can('delivery:dispatch'), ah(async (req, res) => {
  const since = new Date(Date.now() - 24 * 3600_000);
  const orders = await Order.find({ tenantId: req.tenantId, type: 'delivery', $or: [{ 'delivery.status': { $in: ['awaiting_assignment', ...ACTIVE_DELIVERY, 'failed'] } }, { 'delivery.status': { $in: ['delivered', 'returned'] }, updatedAt: { $gte: since } }] }).sort({ createdAt: 1 }).limit(300).select('orderNumber status type customer delivery total amountPaid paymentStatus createdAt acceptedAt readyAt items.name items.quantity items.status').lean();
  res.json({ items: orders, serverTime: new Date() });
}));
deliveryRouter.get('/orders/:id/candidates', can('delivery:dispatch'), checkIdParams, ah(async (req, res) => {
  const o = await Order.findOne({ tenantId: req.tenantId, _id: req.params.id, type: 'delivery' }).lean();
  if (!o) throw notFound('Delivery not found');
  res.json(await rankRiders(req.tenant!, o));
}));
deliveryRouter.post('/orders/:id/dispatch/:action', can('delivery:dispatch'), checkIdParams, validateBody(z.object({ riderId: zId.optional(), reason: z.string().max(200).optional() })), ah(async (req, res) => {
  const action = req.params.action as any;
  if (!['assign', 'auto', 'unassign', 'return', 'retry'].includes(action)) throw notFound('Unknown action');
  const o = await dispatcherAction(req.tenant!, req.user!, req.params.id, action, req.body);
  await audit(req, `delivery.${action}`, 'Order', req.params.id, { riderId: req.body.riderId });
  res.json(o);
}));

/* rider app */
deliveryRouter.get('/me', can('delivery:ride'), ah(async (req, res) => {
  const me = await User.findOne({ tenantId: req.tenantId, _id: req.user!.id }).select('name riderProfile').lean();
  const mine = await Order.find({ tenantId: req.tenantId, 'delivery.riderId': req.user!.id, 'delivery.status': { $in: ACTIVE_DELIVERY } }).sort({ 'delivery.assignedAt': 1 }).lean();
  const done = await Order.countDocuments({ tenantId: req.tenantId, 'delivery.riderId': req.user!.id, 'delivery.status': 'delivered', 'delivery.deliveredAt': { $gte: new Date(Date.now() - 24 * 3600_000) } });
  res.json({ profile: me?.riderProfile ?? {}, name: me?.name, deliveries: mine.map(riderView), deliveredLast24h: done });
}));
deliveryRouter.patch('/me', can('delivery:ride'), validateBody(z.object({ available: z.boolean().optional(), locationSharing: z.boolean().optional() })), ah(async (req, res) => {
  const set: Record<string, unknown> = {};
  if (req.body.available !== undefined) set['riderProfile.available'] = req.body.available;
  if (req.body.locationSharing !== undefined) set['riderProfile.locationSharing'] = req.body.locationSharing;
  // Location is only kept while the rider shares it and is working.
  if (req.body.available === false || req.body.locationSharing === false) set['riderProfile.location'] = null;
  const u = await User.findOneAndUpdate({ tenantId: req.tenantId, _id: req.user!.id }, { $set: set }, { new: true }).select('riderProfile').lean();
  await audit(req, 'delivery.rider_status', 'User', req.user!.id, req.body);
  res.json(u?.riderProfile);
}));
deliveryRouter.post('/me/location', can('delivery:ride'), validateBody(zLatLng), ah(async (req, res) => {
  if (!validLatLng(req.body)) throw badRequest('Invalid location');
  await updateRiderLocation(req.tenant!, req.user!, req.body);
  res.json({ ok: true });
}));
deliveryRouter.post('/orders/:id/rider/:action', can('delivery:ride'), checkIdParams, validateBody(z.object({ reason: z.string().max(200).optional(), code: z.string().regex(/^\d{4}$/).optional(), note: z.string().max(300).optional() })), ah(async (req, res) => {
  const action = req.params.action as any;
  if (!['accept', 'reject', 'pickup', 'on_the_way', 'deliver', 'fail'].includes(action)) throw notFound('Unknown action');
  const o = await riderAction(req.tenant!, req.user!, req.params.id, action, req.body);
  await audit(req, `delivery.rider_${action}`, 'Order', req.params.id, { reason: req.body.reason });
  res.json(o ? riderView(o) : null);
}));

deliveryRouter.get('/analytics', can('delivery:dispatch', 'analytics:view'), validateQuery(periodQ), ah(async (req, res) => res.json(await deliveryAnalytics(req.tenant!, (req as any).validQuery))));
deliveryRouter.patch('/settings', can('delivery:manage'), validateBody(z.object({ autoAssign: z.boolean(), acceptTimeoutSec: z.number().int().min(30).max(1800), maxAttempts: z.number().int().min(1).max(10), maxConcurrentPerRider: z.number().int().min(1).max(10), delayGraceMinutes: z.number().int().min(0).max(120), requireCode: z.boolean(), notifyCustomerSms: z.boolean() }).partial()), ah(async (req, res) => {
  const r = await setSettings(req.tenantId, 'delivery', req.body);
  await audit(req, 'delivery.settings', 'Tenant', req.tenantId, req.body);
  res.json(r);
}));
