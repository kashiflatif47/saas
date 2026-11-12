/**
 * Marketing automation: campaigns, automated journeys and transactional delivery messages.
 *
 * Safety rules enforced here (server-side, at SEND time, not only at scheduling time):
 *  - explicit consent per channel; opt-outs and the suppression list always win;
 *  - frequency limit (max N marketing messages per 7 days, min hours between two) and quiet hours in the
 *    restaurant's time zone (messages wait until the quiet window ends);
 *  - campaigns and journeys cannot run without approval by someone with marketing:approve; any edit resets
 *    approval; AI-written copy is flagged and needs the same approval;
 *  - budget: estimated cost (owner-entered per-message costs) is tracked and the campaign PAUSES at its limit;
 *  - each message has a unique dedupe key and is claimed atomically before sending, so workers, retries and
 *    restarts never send it twice. A send interrupted mid-request is marked "unknown", never re-sent.
 */
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { Campaign, Job, Journey, MessageLog, Suppression } from '../models/growth';
import { Coupon, Customer, Order } from '../models/operations';
import { Tenant } from '../models/platform';
import { AppError, badRequest, notFound } from '../lib/errors';
import { env } from '../config/env';
import { tenantAppUrl } from '../lib/appUrl';
import type { AuthUser, ResolvedTenant } from '../types/express';
import { enqueueJob } from '../jobs/queue';
import { ProviderError, providerFor, toE164, type Channel } from './messaging';
import { recalculateSegments, segmentFilter } from './segments';
import { SALE_STATUSES } from './intelligence';

const DAY = 86400_000;

/* ---------------- consent & suppression ---------------- */

export function hasConsent(c: any, channel: Channel) {
  const k = c?.consent?.[channel];
  return !!k?.granted && !k.revokedAt;
}

export function addressFor(c: any, channel: Channel, countryCode?: string) {
  if (channel === 'email') return c?.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email) ? String(c.email).toLowerCase() : null;
  return toE164(c?.phone, countryCode);
}

async function suppressed(tenantId: Types.ObjectId, channel: Channel, address: string) {
  return !!(await Suppression.exists({ tenantId, channel: { $in: [channel, 'all'] }, address }));
}

export function unsubscribeToken(tenantId: string, customerId: string) {
  return crypto.createHmac('sha256', env.ENCRYPTION_KEY).update(`unsub:${tenantId}:${customerId}`).digest('base64url').slice(0, 32);
}
export function unsubscribeUrl(tenant: { _id: any; slug: string }, customerId: string) {
  return `${tenantAppUrl(tenant.slug)}/unsubscribe?c=${customerId}&t=${unsubscribeToken(String(tenant._id), customerId)}`;
}

/** Opt-out from every marketing channel; also suppresses the phone number and email address. */
export async function unsubscribe(tenantId: Types.ObjectId, customerId: string, source: string) {
  const c = await Customer.findOne({ tenantId, _id: customerId }).lean();
  if (!c) throw notFound('Customer not found');
  const now = new Date();
  await Customer.updateOne({ tenantId, _id: customerId }, { $set: { 'consent.sms.revokedAt': now, 'consent.whatsapp.revokedAt': now, 'consent.email.revokedAt': now, 'consent.sms.granted': false, 'consent.whatsapp.granted': false, 'consent.email.granted': false } });
  for (const address of [c.phone?.replace(/[^\d+]/g, ''), c.email?.toLowerCase()].filter(Boolean) as string[]) {
    await Suppression.updateOne({ tenantId, channel: 'all', address }, { $setOnInsert: { tenantId, channel: 'all', address, customerId: c._id, reason: 'unsubscribed', source } }, { upsert: true });
  }
  // Anything still waiting for this customer is not sent.
  await MessageLog.updateMany({ tenantId, customerId: c._id, status: 'queued', kind: 'marketing' }, { $set: { status: 'skipped', skipReason: 'unsubscribed' } });
}

/** Records consent given or withdrawn (checkout checkbox, staff entry). Never granted implicitly. */
export async function setConsent(tenantId: Types.ObjectId, customerId: Types.ObjectId | string, channels: Channel[], granted: boolean, source: string) {
  const now = new Date();
  const set: Record<string, unknown> = {};
  for (const ch of channels) {
    set[`consent.${ch}.granted`] = granted;
    set[`consent.${ch}.source`] = source;
    if (granted) {
      set[`consent.${ch}.at`] = now;
      set[`consent.${ch}.revokedAt`] = null;
    } else set[`consent.${ch}.revokedAt`] = now;
  }
  await Customer.updateOne({ tenantId, _id: customerId }, { $set: set });
}

/* ---------------- templates ---------------- */

export function render(body: string, vars: Record<string, string | undefined>) {
  return body.replace(/\{\{\s*(name|restaurant|coupon)\s*\}\}/g, (_, k) => vars[k] ?? '');
}

function withFooter(channel: Channel, text: string, unsubscribe: string) {
  return channel === 'email' ? `${text}\n\n—\nYou receive this because you agreed to hear from us. Unsubscribe: ${unsubscribe}` : `${text}\nOpt out: ${unsubscribe}`;
}

/* ---------------- quiet hours & frequency ---------------- */

function localHm(tz: string, d: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  return `${parts.find((p) => p.type === 'hour')!.value.replace('24', '00')}:${parts.find((p) => p.type === 'minute')!.value}`;
}
/** If `now` is inside quiet hours, the time they end (searching in 15-minute steps); otherwise null. */
export function quietUntil(tz: string, start: string, end: string, now: Date) {
  const inQuiet = (d: Date) => {
    const hm = localHm(tz, d);
    return start <= end ? hm >= start && hm < end : hm >= start || hm < end;
  };
  if (!start || !end || start === end || !inQuiet(now)) return null;
  let t = new Date(now);
  for (let i = 0; i < 96 && inQuiet(t); i++) t = new Date(t.getTime() + 15 * 60_000);
  return t;
}

async function frequencyBlocked(tenantId: Types.ObjectId, customerId: Types.ObjectId, maxPerWeek: number, minHours: number, now: Date) {
  const recent = await MessageLog.find({ tenantId, customerId, kind: 'marketing', status: { $in: ['sent', 'delivered', 'sending', 'unknown'] }, sentAt: { $gte: new Date(now.getTime() - 7 * DAY) } }).select('sentAt').sort({ sentAt: -1 }).lean();
  if (recent.length >= maxPerWeek) return `already received ${recent.length} messages this week (limit ${maxPerWeek})`;
  if (recent[0]?.sentAt && now.getTime() - new Date(recent[0].sentAt).getTime() < minHours * 3600_000) return `received a message less than ${minHours} hours ago`;
  return null;
}

/* ---------------- campaigns ---------------- */

export async function audience(tenant: ResolvedTenant, channel: Channel, segments: string[]) {
  const cc = tenant.settings?.marketing?.countryCode;
  const customers = await Customer.find({ ...segmentFilter(tenant._id, segments), [`consent.${channel}.granted`]: true }).select('name phone email consent segments').lean();
  const out: { customer: any; address: string }[] = [];
  let noAddress = 0;
  let blocked = 0;
  for (const c of customers) {
    if (!hasConsent(c, channel)) continue;
    const a = addressFor(c, channel, cc);
    if (!a) { noAddress++; continue; }
    if (await suppressed(tenant._id, channel, a)) { blocked++; continue; }
    out.push({ customer: c, address: a });
  }
  return { recipients: out, excluded: { noValidAddress: noAddress, suppressed: blocked } };
}

const mask = (a: string) => (a.includes('@') ? a.replace(/^(.).*(@.*)$/, '$1***$2') : a.replace(/^(\+\d{2}).*(\d{3})$/, '$1•••••$2'));

export async function previewCampaign(tenant: ResolvedTenant, id: string) {
  const c = await Campaign.findOne({ tenantId: tenant._id, _id: id }).lean();
  if (!c) throw notFound('Campaign not found');
  const a = await audience(tenant, c.channel as Channel, c.segments);
  const sample = a.recipients[0];
  const tenantDoc = await Tenant.findById(tenant._id).select('name slug').lean();
  const text = sample ? withFooter(c.channel as Channel, render(c.body, { name: sample.customer.name ?? '', restaurant: tenantDoc!.name, coupon: c.couponCode ?? (c.coupon?.type ? 'CODE-ON-LAUNCH' : '') }), unsubscribeUrl(tenantDoc as any, String(sample.customer._id))) : null;
  const costEach = (await Tenant.findById(tenant._id).select('messaging.costs').lean() as any)?.messaging?.costs?.[c.channel] ?? 0;
  return {
    recipients: a.recipients.length, excluded: a.excluded, sampleRecipients: a.recipients.slice(0, 5).map((r) => mask(r.address)),
    renderedSample: text, subject: c.subject, estimatedCost: a.recipients.length * costEach, costPerMessage: costEach,
    providerConfigured: !!(await providerFor(tenant._id, c.channel as Channel)),
  };
}

const EDITABLE = ['draft', 'pending_approval', 'approved', 'paused'];

export async function updateCampaign(tenant: ResolvedTenant, id: string, patch: any, by: AuthUser) {
  const c = await Campaign.findOne({ tenantId: tenant._id, _id: id });
  if (!c) throw notFound('Campaign not found');
  if (!EDITABLE.includes(c.status)) throw badRequest(`A ${c.status} campaign cannot be edited`);
  if (c.status === 'paused' && c.startedAt && (patch.body || patch.channel || patch.segments || patch.coupon)) throw badRequest('Message, channel, audience and offer cannot change after a campaign started');
  Object.assign(c, patch);
  // Any change needs a fresh approval (the approved text is the one that is sent).
  if (c.status !== 'paused') {
    c.status = 'draft';
    c.approvedBy = undefined;
    c.approvedAt = undefined;
  }
  c.createdBy = c.createdBy ?? by.name;
  await c.save();
  return c.toObject();
}

export async function transitionCampaign(tenant: ResolvedTenant, id: string, action: 'submit' | 'approve' | 'schedule' | 'pause' | 'resume' | 'cancel', by: AuthUser, body: { scheduleAt?: Date } = {}) {
  const c = await Campaign.findOne({ tenantId: tenant._id, _id: id });
  if (!c) throw notFound('Campaign not found');
  const need = (from: string[]) => {
    if (!from.includes(c.status)) throw new AppError(409, `Cannot ${action} a ${c.status.replace('_', ' ')} campaign`, 'INVALID_CAMPAIGN_TRANSITION');
  };
  const now = new Date();
  switch (action) {
    case 'submit':
      need(['draft']);
      c.status = 'pending_approval';
      break;
    case 'approve':
      need(['pending_approval']);
      c.status = 'approved';
      c.approvedBy = by.name;
      c.approvedAt = now;
      break;
    case 'schedule': {
      need(['approved']);
      if (!(await providerFor(tenant._id, c.channel as Channel))) throw badRequest(`No ${c.channel} provider is configured (Marketing → Channels)`);
      const at = body.scheduleAt ? new Date(body.scheduleAt) : now;
      if (at.getTime() < now.getTime() - 60_000) throw badRequest('The send time is in the past');
      if (c.endAt && at > c.endAt) throw badRequest('The send time is after the campaign end date');
      c.scheduleAt = at;
      c.status = 'scheduled';
      await c.save();
      await enqueueJob({ type: 'campaign.start', tenantId: tenant._id, runAt: at, key: `campaign-start:${c._id}:${at.getTime()}`, payload: { campaignId: String(c._id) } });
      return c.toObject();
    }
    case 'pause':
      need(['scheduled', 'running']);
      c.pauseReason = `Paused by ${by.name}`;
      c.status = 'paused';
      break;
    case 'resume':
      need(['paused']);
      c.pauseReason = undefined;
      if (c.startedAt) {
        c.status = 'running';
        await c.save();
        await scheduleDispatch(tenant._id, now);
        return c.toObject();
      }
      c.status = 'scheduled';
      await c.save();
      await enqueueJob({ type: 'campaign.start', tenantId: tenant._id, runAt: c.scheduleAt && c.scheduleAt > now ? c.scheduleAt : now, key: `campaign-start:${c._id}:resume:${now.getTime()}`, payload: { campaignId: String(c._id) } });
      return c.toObject();
    case 'cancel':
      need(['draft', 'pending_approval', 'approved', 'scheduled', 'running', 'paused']);
      c.status = 'cancelled';
      await MessageLog.updateMany({ tenantId: tenant._id, 'source.id': String(c._id), status: 'queued' }, { $set: { status: 'skipped', skipReason: 'campaign cancelled' } });
      break;
  }
  await c.save();
  return c.toObject();
}

async function createCampaignCoupon(tenant: ResolvedTenant, source: { _id: any; coupon?: any; endAt?: Date | null }, customerIds: string[], prefix: string) {
  const spec = source.coupon;
  if (!spec?.type || !spec.value) return undefined;
  const code = `${prefix}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const endsAt = spec.validDays ? new Date(Date.now() + spec.validDays * DAY) : source.endAt ?? undefined;
  await Coupon.create({
    tenantId: tenant._id, code, description: `Campaign offer`, type: spec.type, value: spec.value, maxDiscount: spec.maxDiscount ?? undefined, minOrder: spec.minOrder ?? undefined,
    startsAt: new Date(), endsAt, productIds: spec.productIds ?? [], categoryIds: spec.categoryIds ?? [], customerIds, campaignId: String(source._id), isActive: true,
  });
  return code;
}

/** Job: a scheduled campaign starts — snapshot the audience, create its coupon, queue one message each. */
export async function startCampaign(tenant: ResolvedTenant, campaignId: string) {
  const now = new Date();
  const c = await Campaign.findOneAndUpdate({ tenantId: tenant._id, _id: campaignId, status: 'scheduled', scheduleAt: { $lte: new Date(now.getTime() + 60_000) } }, { $set: { status: 'running', startedAt: now } }, { new: true }).lean();
  if (!c) return { skipped: 'not scheduled (paused, cancelled, already started or rescheduled)' };
  const tenantDoc = await Tenant.findById(tenant._id).select('name slug').lean();
  const a = await audience(tenant, c.channel as Channel, c.segments);
  const code = c.couponCode ?? (await createCampaignCoupon(tenant, c as any, a.recipients.map((r) => String(r.customer._id)), 'C'));
  if (code && !c.couponCode) await Campaign.updateOne({ tenantId: tenant._id, _id: c._id }, { $set: { couponCode: code } });
  const docs = a.recipients.map((r) => ({
    tenantId: tenant._id, dedupeKey: `campaign:${c._id}:${r.customer._id}`, source: { type: 'campaign', id: String(c._id) }, kind: 'marketing', customerId: r.customer._id, channel: c.channel, to: r.address,
    subject: c.subject, couponCode: code, status: 'queued',
    body: withFooter(c.channel as Channel, render(c.body, { name: r.customer.name ?? '', restaurant: tenantDoc!.name, coupon: code ?? '' }), unsubscribeUrl(tenantDoc as any, String(r.customer._id))),
  }));
  if (docs.length) await MessageLog.insertMany(docs, { ordered: false }).catch((e) => { if (e?.code !== 11000 && !e?.writeErrors) throw e; });
  if (!docs.length) await Campaign.updateOne({ tenantId: tenant._id, _id: c._id }, { $set: { status: 'completed', completedAt: now } });
  await scheduleDispatch(tenant._id, now);
  return { queued: docs.length, excluded: a.excluded, couponCode: code };
}

/**
 * Ensures a dispatch job will run at (or before) `at`. Re-uses a queued one when there is one, so a burst
 * of triggers creates one job per minute; if this minute's job already ran, a fresh one is created so
 * messages queued after a run are never stranded. Two dispatches at once are harmless: every message is
 * claimed atomically (queued → sending) before it is sent.
 */
export async function scheduleDispatch(tenantId: Types.ObjectId, at: Date) {
  const bucket = Math.ceil(at.getTime() / 60_000) * 60_000;
  if (await Job.exists({ type: 'messages.dispatch', tenantId, status: 'queued', runAt: { $lte: new Date(bucket) } })) return;
  const key = `dispatch:${tenantId}:${bucket}`;
  if (await Job.exists({ key })) await enqueueJob({ type: 'messages.dispatch', tenantId, runAt: new Date(bucket), key: `${key}:${crypto.randomUUID()}` });
  else await enqueueJob({ type: 'messages.dispatch', tenantId, runAt: new Date(bucket), key });
}

/**
 * Job: sends queued messages for one tenant. Every rule is re-checked at send time.
 * Returns counts; reschedules itself for messages deferred by quiet hours or retries.
 */
export async function dispatchMessages(tenant: ResolvedTenant, now = new Date()) {
  const tenantId = tenant._id;
  const m = tenant.settings?.marketing ?? {};
  const tz = tenant.settings?.timezone ?? 'UTC';
  const costs: any = ((await Tenant.findById(tenantId).select('messaging.costs').lean()) as any)?.messaging?.costs ?? {};
  // A send that was interrupted (crash between "sending" and the provider's answer) is never retried blindly.
  await MessageLog.updateMany({ tenantId, status: 'sending', sendingSince: { $lt: new Date(now.getTime() - 10 * 60_000) } }, { $set: { status: 'unknown', error: 'Interrupted while sending; not retried to avoid a duplicate. Check the provider log.' } });
  const stats = { sent: 0, failed: 0, skipped: 0, deferred: 0 };
  const campaigns = new Map<string, any>();
  const providers = new Map<string, any>();
  const pausedCampaigns = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const msg = await MessageLog.findOneAndUpdate(
      { tenantId, status: 'queued', $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }], ...(pausedCampaigns.size ? { 'source.id': { $nin: [...pausedCampaigns] } } : {}) },
      { $set: { status: 'sending', sendingSince: now }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true },
    ).lean();
    if (!msg) break;
    const back = (set: Record<string, unknown>) => MessageLog.updateOne({ tenantId, _id: msg._id }, { $set: set, $unset: { sendingSince: 1 } });
    let campaign: any = null;
    if (msg.source?.type === 'campaign') {
      campaign = campaigns.get(msg.source.id!) ?? (await Campaign.findOne({ tenantId, _id: msg.source.id }).lean());
      campaigns.set(msg.source.id!, campaign);
      if (!campaign || campaign.status === 'cancelled') { await back({ status: 'skipped', skipReason: 'campaign cancelled' }); stats.skipped++; continue; }
      if (campaign.status !== 'running') { await back({ status: 'queued', attempts: msg.attempts - 1 }); pausedCampaigns.add(msg.source.id!); continue; }
      if (campaign.endAt && now > campaign.endAt) { await back({ status: 'skipped', skipReason: 'campaign ended' }); stats.skipped++; continue; }
    }
    if (msg.kind === 'marketing') {
      const customer = await Customer.findOne({ tenantId, _id: msg.customerId }).lean();
      if (!customer || !hasConsent(customer, msg.channel as Channel)) { await back({ status: 'skipped', skipReason: 'no consent' }); stats.skipped++; continue; }
      if (await suppressed(tenantId, msg.channel as Channel, msg.to!)) { await back({ status: 'skipped', skipReason: 'suppressed' }); stats.skipped++; continue; }
      const quiet = quietUntil(tz, m.quietStart ?? '21:00', m.quietEnd ?? '09:00', now);
      if (quiet) { await back({ status: 'queued', nextAttemptAt: quiet, attempts: msg.attempts - 1 }); stats.deferred++; continue; }
      const freq = await frequencyBlocked(tenantId, msg.customerId as any, m.maxPerWeek ?? 2, m.minHoursBetween ?? 24, now);
      if (freq) { await back({ status: 'skipped', skipReason: `frequency limit: ${freq}` }); stats.skipped++; continue; }
    } else if (await suppressed(tenantId, msg.channel as Channel, msg.to!)) { await back({ status: 'skipped', skipReason: 'suppressed' }); stats.skipped++; continue; }
    const cost = msg.kind === 'test' ? 0 : costs[msg.channel!] ?? 0;
    if (campaign?.budget?.limit != null && campaign.budget.limit > 0) {
      const r = await Campaign.updateOne({ tenantId, _id: campaign._id, status: 'running', $expr: { $lte: [{ $add: [{ $ifNull: ['$budget.spent', 0] }, cost] }, '$budget.limit'] } }, { $inc: { 'budget.spent': cost } });
      if (r.modifiedCount !== 1) {
        await Campaign.updateOne({ tenantId, _id: campaign._id, status: 'running' }, { $set: { status: 'paused', pauseReason: 'Budget limit reached' } });
        await back({ status: 'queued', attempts: msg.attempts - 1 });
        pausedCampaigns.add(String(campaign._id));
        campaigns.set(String(campaign._id), { ...campaign, status: 'paused' });
        continue;
      }
    } else if (campaign && cost) await Campaign.updateOne({ tenantId, _id: campaign._id }, { $inc: { 'budget.spent': cost } });
    const prov = providers.get(msg.channel!) ?? (await providerFor(tenantId, msg.channel as Channel));
    providers.set(msg.channel!, prov);
    if (!prov) { await back({ status: 'failed', error: `No ${msg.channel} provider configured` }); stats.failed++; continue; }
    try {
      const r = await prov.send({ to: msg.to!, subject: msg.subject ?? undefined, body: msg.body! });
      await back({ status: 'sent', provider: prov.name, providerMessageId: r.providerMessageId, providerStatus: r.providerStatus, sentAt: new Date(), cost, error: null });
      stats.sent++;
    } catch (e: any) {
      const retry = e instanceof ProviderError && e.retryable && msg.attempts < 3;
      await back(retry ? { status: 'queued', nextAttemptAt: new Date(now.getTime() + 2 ** msg.attempts * 60_000), error: e.message } : { status: 'failed', error: e?.message ?? 'Send failed' });
      if (!retry) stats.failed++;
      else stats.deferred++;
    }
  }
  // Wake up again for deferred messages; finish campaigns with nothing left to send.
  const next = await MessageLog.findOne({ tenantId, status: 'queued', nextAttemptAt: { $gt: now } }).sort({ nextAttemptAt: 1 }).select('nextAttemptAt').lean();
  if (next?.nextAttemptAt) await scheduleDispatch(tenantId, next.nextAttemptAt);
  for (const c of await Campaign.find({ tenantId, status: 'running' }).select('_id').lean()) {
    if (!(await MessageLog.exists({ tenantId, 'source.id': String(c._id), status: { $in: ['queued', 'sending'] } }))) await Campaign.updateOne({ tenantId, _id: c._id, status: 'running' }, { $set: { status: 'completed', completedAt: new Date() } });
  }
  return stats;
}

/** Sends one rendered campaign message to a staff-provided address (logged as a test; no consent needed). */
export async function testSend(tenant: ResolvedTenant, id: string, to: string, by: AuthUser) {
  const c = await Campaign.findOne({ tenantId: tenant._id, _id: id }).lean();
  if (!c) throw notFound('Campaign not found');
  const address = c.channel === 'email' ? (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) ? to.toLowerCase() : null) : toE164(to, tenant.settings?.marketing?.countryCode);
  if (!address) throw badRequest(c.channel === 'email' ? 'Enter a valid email address' : 'Enter the phone number in international format (+…)');
  const prov = await providerFor(tenant._id, c.channel as Channel);
  if (!prov) throw badRequest(`No ${c.channel} provider is configured`);
  const tenantDoc = await Tenant.findById(tenant._id).select('name').lean();
  const body = `[TEST] ${render(c.body, { name: by.name, restaurant: tenantDoc!.name, coupon: c.couponCode ?? 'TESTCODE' })}`;
  const log = await MessageLog.create({ tenantId: tenant._id, dedupeKey: `test:${c._id}:${crypto.randomUUID()}`, source: { type: 'test', id: String(c._id) }, kind: 'test', channel: c.channel, to: address, subject: c.subject, body, status: 'sending', sendingSince: new Date(), attempts: 1 });
  try {
    const r = await prov.send({ to: address, subject: c.subject ?? undefined, body });
    await MessageLog.updateOne({ tenantId: tenant._id, _id: log._id }, { $set: { status: 'sent', provider: prov.name, providerMessageId: r.providerMessageId, providerStatus: r.providerStatus, sentAt: new Date() } });
    return { status: 'sent', note: 'Accepted by the provider. Delivery is confirmed only by the provider status callback.' };
  } catch (e: any) {
    await MessageLog.updateOne({ tenantId: tenant._id, _id: log._id }, { $set: { status: 'failed', error: e.message } });
    throw badRequest(e.message);
  }
}

/** Campaign results: verified (coupon redemptions) kept separate from estimated (influenced) figures. */
export async function campaignReport(tenant: ResolvedTenant, id: string) {
  const c = await Campaign.findOne({ tenantId: tenant._id, _id: id }).lean();
  if (!c) throw notFound('Campaign not found');
  const rows = await MessageLog.aggregate([{ $match: { tenantId: tenant._id, 'source.id': String(c._id), kind: 'marketing' } }, { $group: { _id: '$status', n: { $sum: 1 }, cost: { $sum: { $ifNull: ['$cost', 0] } } } }]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const sentCount = (by.sent ?? 0) + (by.delivered ?? 0);
  const redeemed = c.couponCode ? await Order.find({ tenantId: tenant._id, couponCode: c.couponCode, status: { $in: SALE_STATUSES } }).select('total customerId').lean() : [];
  const days = tenant.settings?.marketing?.attributionDays ?? 7;
  const messaged = await MessageLog.find({ tenantId: tenant._id, 'source.id': String(c._id), status: { $in: ['sent', 'delivered'] } }).select('customerId sentAt').lean();
  let influencedOrders = 0;
  let influencedRevenue = 0;
  for (const msg of messaged) {
    const orders = await Order.find({ tenantId: tenant._id, customerId: msg.customerId, status: { $in: SALE_STATUSES }, createdAt: { $gte: msg.sentAt, $lt: new Date(new Date(msg.sentAt!).getTime() + days * DAY) }, ...(c.couponCode ? { couponCode: { $ne: c.couponCode } } : {}) }).select('total').lean();
    influencedOrders += orders.length;
    influencedRevenue += orders.reduce((s, o) => s + o.total, 0);
  }
  const redeemers = new Set(redeemed.map((o) => String(o.customerId ?? '')).filter(Boolean)).size;
  return {
    campaign: { _id: c._id, name: c.name, status: c.status, channel: c.channel, couponCode: c.couponCode, startedAt: c.startedAt, completedAt: c.completedAt, budget: c.budget },
    messages: { queued: by.queued ?? 0, attempted: sentCount + (by.failed ?? 0) + (by.unknown ?? 0), sentAcceptedByProvider: sentCount, deliveredConfirmed: by.delivered ?? 0, failed: by.failed ?? 0, skipped: by.skipped ?? 0, unknown: by.unknown ?? 0 },
    clicks: { tracked: false, note: 'Link clicks are not tracked (no link-tracking provider is integrated).' },
    verified: { couponRedemptions: redeemed.length, revenue: redeemed.reduce((s, o) => s + o.total, 0), customersRedeemed: redeemers, conversionRatePercent: sentCount ? Math.round((redeemers / sentCount) * 1000) / 10 : null, basis: 'Orders that used this campaign’s coupon code.' },
    estimated: { influencedOrders, influencedRevenue, attributionDays: days, basis: `Other orders by messaged customers within ${days} days after the message. Correlation, not proof.` },
    estimatedCost: rows.reduce((s, r) => s + r.cost, 0),
  };
}

/* ---------------- journeys (automations) ---------------- */

export async function evaluateJourneys(tenant: ResolvedTenant, now = new Date()) {
  const tenantId = tenant._id;
  const journeys = await Journey.find({ tenantId, status: 'active', approvedAt: { $exists: true } }).lean();
  if (!journeys.length) return { journeys: 0, queued: 0 };
  await recalculateSegments(tenant, now); // fresh stats for the triggers
  const tz = tenant.settings?.timezone ?? 'UTC';
  const todayMd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: '2-digit', day: '2-digit' }).format(now).replace('/', '-');
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(now);
  const tenantDoc = await Tenant.findById(tenantId).select('name slug').lean();
  let queued = 0;
  for (const j of journeys) {
    const cfg: any = j.config ?? {};
    const q: any = { tenantId, [`consent.${j.channel}.granted`]: true };
    let keyOf: (c: any) => string = (c) => `journey:${j._id}:${c._id}`;
    switch (j.trigger) {
      case 'joined': q.createdAt = { $gte: new Date(now.getTime() - DAY) }; break;
      case 'first_order': q['stats.orders'] = 1; q['stats.firstOrderAt'] = { $gte: new Date(now.getTime() - 7 * DAY) }; break;
      case 'second_order': q['stats.orders'] = 2; q['stats.lastOrderAt'] = { $gte: new Date(now.getTime() - 7 * DAY) }; break;
      case 'order_count': q['stats.orders'] = { $gte: cfg.count ?? 10 }; break;
      case 'spend_threshold': q['stats.spend'] = { $gte: cfg.amount ?? 0 }; break;
      case 'inactive': q['stats.lastOrderAt'] = { $lt: new Date(now.getTime() - (cfg.days ?? 30) * DAY) }; keyOf = (c) => `journey:${j._id}:${c._id}:${new Date(c.stats.lastOrderAt).getTime()}`; break; // once per inactive spell
      case 'birthday': q.birthday = todayMd; keyOf = (c) => `journey:${j._id}:${c._id}:${year}`; break;
    }
    const customers = await Customer.find(q).select('name phone email consent stats createdAt').limit(2000).lean();
    for (const c of customers) {
      if (!hasConsent(c, j.channel as Channel)) continue;
      const address = addressFor(c, j.channel as Channel, tenant.settings?.marketing?.countryCode);
      if (!address) continue;
      const dedupeKey = keyOf(c);
      if (await MessageLog.exists({ tenantId, dedupeKey })) continue;
      let code: string | undefined;
      if (j.coupon?.type) code = await createCampaignCoupon(tenant, j as any, [String(c._id)], 'J');
      try {
        await MessageLog.create({
          tenantId, dedupeKey, source: { type: 'journey', id: String(j._id) }, kind: 'marketing', customerId: c._id, channel: j.channel, to: address, subject: j.subject, couponCode: code, status: 'queued',
          body: withFooter(j.channel as Channel, render(j.body, { name: c.name ?? '', restaurant: tenantDoc!.name, coupon: code ?? '' }), unsubscribeUrl(tenantDoc as any, String(c._id))),
        });
        queued++;
      } catch (e: any) {
        if (e?.code !== 11000) throw e; // created by a concurrent run: fine
        if (code) await Coupon.deleteOne({ tenantId, code });
      }
    }
  }
  if (queued) await scheduleDispatch(tenantId, now);
  return { journeys: journeys.length, queued };
}

/* ---------------- transactional (delivery status) ---------------- */
const TX_TEXT: Record<string, string> = {
  assigned: 'A rider has been assigned to your order #{n}.',
  picked_up: 'Your order #{n} is on its way.',
  delivered: 'Your order #{n} has been delivered. Enjoy!',
  failed: 'We could not deliver your order #{n}. The restaurant will contact you.',
  delayed: 'Your order #{n} is running late. Sorry for the wait.',
};
export async function queueTransactional(tenant: ResolvedTenant, orderId: string, event: string) {
  if (!TX_TEXT[event]) return;
  const o = await Order.findOne({ tenantId: tenant._id, _id: orderId }).select('orderNumber customer').lean();
  const to = toE164(o?.customer?.phone ?? undefined, tenant.settings?.marketing?.countryCode);
  if (!o || !to || !(await providerFor(tenant._id, 'sms'))) return;
  const tenantDoc = await Tenant.findById(tenant._id).select('name').lean();
  try {
    await MessageLog.create({ tenantId: tenant._id, dedupeKey: `tx:${orderId}:${event}`, source: { type: 'transactional', id: orderId }, kind: 'transactional', channel: 'sms', to, body: `${tenantDoc!.name}: ${TX_TEXT[event].replace('{n}', String(o.orderNumber))}`, status: 'queued' });
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    return;
  }
  await scheduleDispatch(tenant._id, new Date());
}

/* ---------------- provider status callbacks ---------------- */
export async function applyTwilioStatus(tenantId: Types.ObjectId, sid: string, status: string, errorCode?: string) {
  const set: Record<string, unknown> = { providerStatus: status };
  if (status === 'delivered' || status === 'read') { set.status = 'delivered'; set.deliveredAt = new Date(); }
  if (status === 'failed' || status === 'undelivered') { set.status = 'failed'; set.error = `Provider reported ${status}${errorCode ? ` (code ${errorCode})` : ''}`; }
  const r = await MessageLog.updateOne({ tenantId, providerMessageId: sid }, { $set: set });
  return { matched: r.matchedCount };
}

export async function campaignCreate(tenant: ResolvedTenant, body: any, by: AuthUser) {
  if (body.scheduleAt) throw badRequest('Schedule after approval');
  return (await Campaign.create({ ...body, tenantId: tenant._id, status: 'draft', createdBy: by.name })).toObject();
}

