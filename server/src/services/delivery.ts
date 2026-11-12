/**
 * Delivery zones, rider assignment and dispatch.
 *
 * Delivery sub-status (order.delivery.status) runs ALONGSIDE the order status, never against it:
 *   awaiting_assignment → assigned → rider_accepted → picked_up → on_the_way → delivered
 *                                                     └────────→ failed → returned | awaiting_assignment
 * "Preparing" / "Ready for pickup" are the order's kitchen states. Pick-up is only allowed once the order is
 * Ready and moves the order to Dispatched ("delivered" order status); Delivered completes the order.
 * Cancelling the order cancels the delivery. Payment status is untouched by any of this.
 *
 * Distances are STRAIGHT-LINE (haversine) estimates and are only used when both the customer location and
 * a recent rider location are known. No routing provider is integrated, so no travel times are invented:
 * ETAs come from the dishes' preparation time + the zone's configured delivery time.
 */
import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import { DeliveryZone } from '../models/growth';
import { Order } from '../models/operations';
import { User } from '../models/platform';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import type { AuthUser, ResolvedTenant } from '../types/express';
import { emit } from '../sockets';
import { notify } from './notify';
import { enqueueJob } from '../jobs/queue';
import { parseRange } from './analyticsService';

export const DELIVERY_STATES = ['awaiting_assignment', 'assigned', 'rider_accepted', 'picked_up', 'on_the_way', 'delivered', 'failed', 'returned', 'cancelled'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
const TRANSITIONS: Record<DeliveryState, DeliveryState[]> = {
  awaiting_assignment: ['assigned', 'cancelled'],
  assigned: ['rider_accepted', 'awaiting_assignment', 'cancelled'],
  rider_accepted: ['picked_up', 'awaiting_assignment', 'cancelled'],
  picked_up: ['on_the_way', 'delivered', 'failed'],
  on_the_way: ['delivered', 'failed'],
  failed: ['returned', 'awaiting_assignment'],
  delivered: [],
  returned: [],
  cancelled: [],
};
export const ACTIVE_DELIVERY: DeliveryState[] = ['assigned', 'rider_accepted', 'picked_up', 'on_the_way'];
export function canDeliveryTransition(from: DeliveryState, to: DeliveryState) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/* ---------------- geometry (pure) ---------------- */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/** Ray casting on [lng, lat] pairs. */
export function pointInPolygon(p: { lat: number; lng: number }, poly: number[][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function zoneContains(z: any, p: { lat: number; lng: number }) {
  if (z.polygon?.length >= 3) return pointInPolygon(p, z.polygon);
  if (z.circle?.center && z.circle.radiusKm) return haversineKm(z.circle.center, p) <= z.circle.radiusKm;
  return false;
}
export function zoneOpen(z: any, tz: string, now = new Date()) {
  const h = z.hours ?? {};
  if ((!h.days || !h.days.length) && !h.from && !h.to) return true;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((x) => x.type === 'weekday')!.value);
  const hm = `${parts.find((x) => x.type === 'hour')!.value.replace('24', '00')}:${parts.find((x) => x.type === 'minute')!.value}`;
  if (h.days?.length && !h.days.includes(wd)) return false;
  if (h.from && h.to) return h.from <= h.to ? hm >= h.from && hm < h.to : hm >= h.from || hm < h.to;
  return true;
}
export function validLatLng(p: any) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

/**
 * Picks the delivery zone for an order. With zones configured, the order must be inside an active, open zone:
 * by coordinates when the customer shared a location (or staff entered one), otherwise by the zone the
 * customer chose. Without zones, delivery works as before (flat fee from settings).
 */
export async function resolveDeliveryZone(tenant: ResolvedTenant, input: { zoneId?: string; location?: { lat: number; lng: number } }) {
  const zones = await DeliveryZone.find({ tenantId: tenant._id, isActive: true }).lean();
  if (!zones.length) return null;
  const tz = tenant.settings?.timezone ?? 'UTC';
  let zone: any;
  if (input.location) {
    if (!validLatLng(input.location)) throw badRequest('Invalid delivery location');
    zone = zones.find((z) => zoneContains(z, input.location!));
    if (!zone) throw badRequest('This address is outside our delivery area');
    if (input.zoneId && String(zone._id) !== input.zoneId) throw badRequest('The location is not inside the delivery area you chose');
  } else if (input.zoneId) {
    zone = zones.find((z) => String(z._id) === input.zoneId);
    if (!zone) throw badRequest('Choose a valid delivery area');
  } else throw badRequest('Choose your delivery area (or share your location)');
  if (!zoneOpen(zone, tz)) throw badRequest(`Delivery to ${zone.name} is closed at the moment`);
  return zone;
}

/* ---------------- lifecycle ---------------- */

const actorName = (a?: AuthUser) => a?.name ?? 'system';

/** Called after a delivery order is confirmed: due time, confirmation code, then automatic assignment. */
export async function onDeliveryOrderConfirmed(tenant: ResolvedTenant, orderId: string) {
  const order = await Order.findOne({ tenantId: tenant._id, _id: orderId }).lean();
  if (!order || order.type !== 'delivery' || order.delivery?.status) return;
  const prep = Math.max(0, ...order.items.filter((i: any) => i.status !== 'cancelled').map((i: any) => i.prepMinutes ?? 0));
  const zone = order.delivery?.zoneId ? await DeliveryZone.findOne({ tenantId: tenant._id, _id: order.delivery.zoneId }).lean() : null;
  const travel = zone?.etaMinutes ?? 30;
  const base = order.acceptedAt ? new Date(order.acceptedAt).getTime() : Date.now();
  await Order.updateOne(
    { tenantId: tenant._id, _id: orderId, 'delivery.status': { $exists: false } },
    { $set: { 'delivery.status': 'awaiting_assignment', 'delivery.etaAt': new Date(base + (prep + travel) * 60_000), 'delivery.code': String(crypto.randomInt(1000, 10000)) }, $inc: { __v: 1 } },
  );
  await broadcast(tenant, orderId);
  if (tenant.settings?.delivery?.autoAssign !== false) await autoAssign(tenant, orderId).catch((e) => console.error('[DELIVERY] auto-assign', e?.message));
}

async function broadcast(tenant: ResolvedTenant, orderId: string) {
  const { broadcastOrder } = await import('./orderService');
  const o = await Order.findOne({ tenantId: tenant._id, _id: orderId }).lean();
  if (o) {
    broadcastOrder(String(tenant._id), o);
    emit.staff(String(tenant._id), 'delivery:updated', { _id: o._id, orderNumber: o.orderNumber, delivery: o.delivery });
    if (o.delivery?.riderId) emit.rider(String(tenant._id), String(o.delivery.riderId), 'delivery:updated', riderView(o));
  }
  return o;
}

async function activeLoads(tenantId: Types.ObjectId) {
  const rows = await Order.aggregate([{ $match: { tenantId, 'delivery.status': { $in: ACTIVE_DELIVERY } } }, { $group: { _id: '$delivery.riderId', n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/**
 * Deterministic rider choice. Eligible: active rider accounts marked available, covering the order's zone,
 * under the per-rider limit, not already declined/timed out for this order. Ranked by:
 *   1. fewest active deliveries;
 *   2. straight-line distance (only when both locations are known and the rider's is under 10 minutes old);
 *   3. longest since their last assignment (fairness);
 *   4. rider id (stable tie-break).
 */
export async function rankRiders(tenant: ResolvedTenant, order: any) {
  const riders = await User.find({ tenantId: tenant._id, role: 'rider', isActive: true }).select('name riderProfile').lean();
  const loads = await activeLoads(tenant._id);
  const maxLoad = tenant.settings?.delivery?.maxConcurrentPerRider ?? 2;
  const excluded = new Set((order.delivery?.attempts ?? []).filter((a: any) => a.outcome === 'rejected' || a.outcome === 'timeout').map((a: any) => a.riderId));
  const zoneId = order.delivery?.zoneId ? String(order.delivery.zoneId) : null;
  const dest = validLatLng(order.delivery?.location) ? order.delivery.location : null;
  const candidates = [];
  const skipped = [];
  for (const r of riders) {
    const p: any = r.riderProfile ?? {};
    const load = loads.get(String(r._id)) ?? 0;
    const why = !p.available ? 'not available' : excluded.has(String(r._id)) ? 'declined or timed out for this order' : zoneId && p.zoneIds?.length && !p.zoneIds.includes(zoneId) ? 'does not cover this zone' : load >= maxLoad ? `already has ${load} active deliveries (limit ${maxLoad})` : null;
    if (why) {
      skipped.push({ riderId: String(r._id), name: r.name, reason: why });
      continue;
    }
    const fresh = p.location?.at && Date.now() - new Date(p.location.at).getTime() < 10 * 60_000 && validLatLng(p.location);
    const km = dest && fresh ? Math.round(haversineKm(p.location, dest) * 10) / 10 : null;
    candidates.push({ riderId: String(r._id), name: r.name, load, km, lastAssignedAt: p.lastAssignedAt ? new Date(p.lastAssignedAt).getTime() : 0 });
  }
  candidates.sort((a, b) => a.load - b.load || (a.km ?? Infinity) - (b.km ?? Infinity) || a.lastAssignedAt - b.lastAssignedAt || a.riderId.localeCompare(b.riderId));
  return { candidates, skipped };
}

const explain = (c: { name: string; load: number; km: number | null; lastAssignedAt: number }) =>
  `${c.name}: ${c.load} active deliver${c.load === 1 ? 'y' : 'ies'}; ${c.km != null ? `${c.km} km straight-line` : 'distance unknown (no recent location)'}; ${c.lastAssignedAt ? `last assigned ${Math.round((Date.now() - c.lastAssignedAt) / 60_000)} min ago` : 'not assigned yet today'}`;

/** Assigns the best rider, or flags the order for manual assignment when nobody is eligible. */
export async function autoAssign(tenant: ResolvedTenant, orderId: string, by?: AuthUser) {
  const order = await Order.findOne({ tenantId: tenant._id, _id: orderId }).lean();
  if (!order || order.delivery?.status !== 'awaiting_assignment') return { assigned: false, reason: 'not awaiting assignment' };
  const maxAttempts = tenant.settings?.delivery?.maxAttempts ?? 3;
  const tries = (order.delivery?.attempts ?? []).filter((a: any) => a.outcome === 'assigned').length;
  if (tries >= maxAttempts) return needsManual(tenant, order, `Automatic assignment stopped after ${tries} attempts`);
  const { candidates, skipped } = await rankRiders(tenant, order);
  if (!candidates.length) return needsManual(tenant, order, skipped.length ? `No eligible rider (${skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')})` : 'No riders set up');
  const pick = candidates[0];
  await assignTo(tenant, orderId, pick.riderId, by, 'automatic', explain(pick));
  return { assigned: true, riderId: pick.riderId, explanation: explain(pick), alternatives: candidates.slice(1, 4).map(explain) };
}

async function needsManual(tenant: ResolvedTenant, order: any, reason: string) {
  await notify(tenant._id, { type: 'delivery.unassigned', title: `Order #${order.orderNumber} needs a rider`, body: reason, link: '/dashboard/delivery', roles: ['owner', 'admin', 'manager'] });
  emit.staff(String(tenant._id), 'delivery:needs_rider', { _id: order._id, orderNumber: order.orderNumber, reason });
  return { assigned: false, reason };
}

/** Atomic: only an order still awaiting assignment (or being reassigned by a dispatcher) can be assigned. */
export async function assignTo(tenant: ResolvedTenant, orderId: string, riderId: string, by: AuthUser | undefined, mode: 'automatic' | 'manual', explanation?: string) {
  const rider = await User.findOne({ tenantId: tenant._id, _id: riderId, role: 'rider', isActive: true }).select('name').lean();
  if (!rider) throw badRequest('Rider not found');
  const now = new Date();
  const from = mode === 'manual' ? ['awaiting_assignment', 'assigned', 'rider_accepted', 'failed'] : ['awaiting_assignment'];
  const previous = (await Order.findOne({ tenantId: tenant._id, _id: orderId }).select('delivery.riderId').lean())?.delivery?.riderId;
  const r = await Order.updateOne(
    { tenantId: tenant._id, _id: orderId, type: 'delivery', 'delivery.status': { $in: from } },
    {
      $set: { 'delivery.status': 'assigned', 'delivery.riderId': rider._id, 'delivery.riderName': rider.name, 'delivery.assignedAt': now, 'delivery.acceptedAt': null },
      $push: { 'delivery.attempts': { riderId: String(rider._id), riderName: rider.name, at: now, by: actorName(by), outcome: 'assigned', reason: mode, explanation } },
      $inc: { __v: 1 },
    },
  );
  if (r.modifiedCount !== 1) throw conflict('The delivery was just updated by someone else; refresh and try again');
  await User.updateOne({ tenantId: tenant._id, _id: rider._id }, { $set: { 'riderProfile.lastAssignedAt': now } });
  const timeout = tenant.settings?.delivery?.acceptTimeoutSec ?? 120;
  const n = (await Order.findOne({ tenantId: tenant._id, _id: orderId }).select('delivery.attempts').lean())?.delivery?.attempts?.length ?? 0;
  await enqueueJob({ type: 'delivery.acceptTimeout', tenantId: tenant._id, runAt: new Date(now.getTime() + timeout * 1000), key: `delivery-timeout:${orderId}:${n}`, payload: { orderId, riderId: String(rider._id), attempt: n } });
  if (previous && String(previous) !== String(rider._id)) emit.rider(String(tenant._id), String(previous), 'delivery:withdrawn', { _id: orderId, reason: 'reassigned' });
  const o = await broadcast(tenant, orderId);
  emit.rider(String(tenant._id), String(rider._id), 'delivery:assigned', o ? riderView(o) : { _id: orderId });
  await notify(tenant._id, { type: 'delivery.assigned', title: `Delivery #${o?.orderNumber} assigned to ${rider.name}`, roles: ['rider', 'manager'] });
  await customerMessage(tenant, orderId, 'assigned');
  return o;
}

/** Persistent timeout job: the rider did not accept in time → record, exclude, reassign. */
export async function handleAcceptTimeout(tenant: ResolvedTenant, p: { orderId: string; riderId: string; attempt: number }) {
  const now = new Date();
  const r = await Order.updateOne(
    { tenantId: tenant._id, _id: p.orderId, 'delivery.status': 'assigned', 'delivery.riderId': p.riderId, 'delivery.attempts': { $size: p.attempt } },
    { $set: { 'delivery.status': 'awaiting_assignment', 'delivery.riderId': null, 'delivery.riderName': null }, $push: { 'delivery.attempts': { riderId: p.riderId, at: now, by: 'system', outcome: 'timeout', reason: 'not accepted in time' } }, $inc: { __v: 1 } },
  );
  if (r.modifiedCount !== 1) return { skipped: 'already accepted, reassigned or closed' };
  emit.rider(String(tenant._id), p.riderId, 'delivery:withdrawn', { _id: p.orderId, reason: 'timeout' });
  return autoAssign(tenant, p.orderId);
}

/* ---------------- rider & dispatcher actions ---------------- */

/** What the customer's tracking page may see: status and timeline only (no rider id, phone or location). */
export function customerDeliveryView(d: any, opts: { includeCode?: boolean } = {}) {
  if (!d || !d.status) return null;
  return {
    status: d.status,
    zoneName: d.zoneName,
    riderFirstName: d.riderName ? String(d.riderName).split(/\s+/)[0] : undefined,
    etaAt: d.etaAt,
    timeline: { assignedAt: d.assignedAt, acceptedAt: d.acceptedAt, pickedUpAt: d.pickedUpAt, onTheWayAt: d.onTheWayAt, deliveredAt: d.deliveredAt, failedAt: d.failedAt, returnedAt: d.returnedAt },
    ...(opts.includeCode && d.code && ['assigned', 'rider_accepted', 'picked_up', 'on_the_way'].includes(d.status) ? { code: d.code } : {}),
    trackingNote: 'Status updates come from the rider app. Live map location is not shown.',
  };
}

export function riderView(o: any) {
  return {
    _id: o._id, orderNumber: o.orderNumber, status: o.status, items: (o.items ?? []).filter((i: any) => i.status !== 'cancelled').map((i: any) => ({ name: i.name, variantName: i.variantName, quantity: i.quantity })),
    customer: { name: o.customer?.name, phone: o.customer?.phone }, delivery: { address: o.delivery?.address, notes: o.delivery?.notes, zoneName: o.delivery?.zoneName, location: o.delivery?.location, status: o.delivery?.status, etaAt: o.delivery?.etaAt, assignedAt: o.delivery?.assignedAt },
    total: o.total, amountDue: Math.max(0, o.total - o.amountPaid), paymentStatus: o.paymentStatus, notes: o.notes,
  };
}

async function setState(tenant: ResolvedTenant, orderId: string, from: DeliveryState[], to: DeliveryState, set: Record<string, unknown>, attempt?: Record<string, unknown>, extraFilter: Record<string, unknown> = {}) {
  const r = await Order.updateOne(
    { tenantId: tenant._id, _id: orderId, 'delivery.status': { $in: from }, ...extraFilter },
    { $set: { 'delivery.status': to, ...set }, ...(attempt ? { $push: { 'delivery.attempts': attempt } } : {}), $inc: { __v: 1 } },
  );
  return r.modifiedCount === 1;
}

export async function riderAction(tenant: ResolvedTenant, rider: AuthUser, orderId: string, action: 'accept' | 'reject' | 'pickup' | 'on_the_way' | 'deliver' | 'fail', body: { reason?: string; code?: string; note?: string } = {}) {
  const order = await Order.findOne({ tenantId: tenant._id, _id: orderId }).select('+delivery.code').lean();
  if (!order || order.type !== 'delivery') throw notFound('Delivery not found');
  // Riders only ever act on deliveries assigned to them.
  if (String(order.delivery?.riderId ?? '') !== rider.id) throw forbidden('This delivery is not assigned to you');
  const st = order.delivery!.status as DeliveryState;
  const now = new Date();
  const mine = { 'delivery.riderId': order.delivery!.riderId };
  let ok = false;
  const { transitionOrder } = await import('./orderService');
  switch (action) {
    case 'accept':
      ok = await setState(tenant, orderId, ['assigned'], 'rider_accepted', { 'delivery.acceptedAt': now }, { riderId: rider.id, riderName: rider.name, at: now, by: rider.name, outcome: 'accepted' }, mine);
      break;
    case 'reject':
      if (!body.reason) throw badRequest('Give a reason');
      ok = await setState(tenant, orderId, ['assigned', 'rider_accepted'], 'awaiting_assignment', { 'delivery.riderId': null, 'delivery.riderName': null }, { riderId: rider.id, riderName: rider.name, at: now, by: rider.name, outcome: 'rejected', reason: body.reason }, mine);
      if (ok) await autoAssign(tenant, orderId).catch(() => undefined);
      break;
    case 'pickup':
      if (st !== 'rider_accepted') throw badRequest('Accept the delivery first');
      if (order.status !== 'ready') throw badRequest(order.status === 'delivered' ? 'Already picked up' : 'The order is not ready yet');
      ok = await setState(tenant, orderId, ['rider_accepted'], 'picked_up', { 'delivery.pickedUpAt': now }, undefined, mine);
      if (ok) await transitionOrder(tenant, orderId, 'delivered', rider); // order: Dispatched
      break;
    case 'on_the_way':
      ok = await setState(tenant, orderId, ['picked_up'], 'on_the_way', { 'delivery.onTheWayAt': now }, undefined, mine);
      break;
    case 'deliver': {
      const codeOk = !!body.code && body.code === order.delivery!.code;
      if (tenant.settings?.delivery?.requireCode && !codeOk) throw badRequest('Ask the customer for their 4-digit delivery code');
      if (body.code && !codeOk) throw badRequest('That delivery code is not correct');
      ok = await setState(tenant, orderId, ['picked_up', 'on_the_way'], 'delivered', { 'delivery.deliveredAt': now, 'delivery.proof': { note: body.note, codeConfirmed: codeOk, by: rider.name, at: now } }, undefined, mine);
      if (ok) await transitionOrder(tenant, orderId, 'completed', rider);
      break;
    }
    case 'fail':
      if (!body.reason) throw badRequest('Give the reason the delivery failed');
      ok = await setState(tenant, orderId, ['picked_up', 'on_the_way'], 'failed', { 'delivery.failedAt': now, 'delivery.failureReason': body.reason, 'delivery.proof': { note: body.note, by: rider.name, at: now } }, undefined, mine);
      if (ok) await notify(tenant._id, { type: 'delivery.failed', title: `Delivery #${order.orderNumber} failed`, body: body.reason, link: '/dashboard/delivery', roles: ['owner', 'admin', 'manager'] });
      break;
  }
  if (!ok) throw new AppError(409, `Cannot ${action.replace('_', ' ')} a delivery that is ${st.replace('_', ' ')}`, 'INVALID_DELIVERY_TRANSITION');
  const map: Record<string, string> = { pickup: 'picked_up', deliver: 'delivered', fail: 'failed' };
  if (map[action]) await customerMessage(tenant, orderId, map[action]);
  return broadcast(tenant, orderId);
}

export async function dispatcherAction(tenant: ResolvedTenant, actor: AuthUser, orderId: string, action: 'assign' | 'auto' | 'unassign' | 'return' | 'retry', body: { riderId?: string; reason?: string } = {}) {
  const order = await Order.findOne({ tenantId: tenant._id, _id: orderId }).lean();
  if (!order || order.type !== 'delivery' || !order.delivery?.status) throw notFound('Delivery not found');
  const now = new Date();
  if (action === 'assign') {
    if (!body.riderId) throw badRequest('Choose a rider');
    return assignTo(tenant, orderId, body.riderId, actor, 'manual', `Assigned by ${actor.name}`);
  }
  if (action === 'auto') {
    const r = await autoAssign(tenant, orderId, actor);
    if (!r.assigned) throw badRequest(r.reason ?? 'No rider could be assigned');
    return broadcast(tenant, orderId);
  }
  let ok = false;
  if (action === 'unassign') ok = await setState(tenant, orderId, ['assigned', 'rider_accepted'], 'awaiting_assignment', { 'delivery.riderId': null, 'delivery.riderName': null }, { riderId: String(order.delivery.riderId ?? ''), at: now, by: actor.name, outcome: 'unassigned', reason: body.reason });
  if (action === 'return') ok = await setState(tenant, orderId, ['failed'], 'returned', { 'delivery.returnedAt': now });
  if (action === 'retry') ok = await setState(tenant, orderId, ['failed'], 'awaiting_assignment', { 'delivery.riderId': null, 'delivery.riderName': null, 'delivery.failedAt': null });
  if (!ok) throw new AppError(409, `Cannot ${action} a delivery that is ${order.delivery.status.replace('_', ' ')}`, 'INVALID_DELIVERY_TRANSITION');
  return broadcast(tenant, orderId);
}

/** Order cancelled/rejected: the delivery stops too (called from the order state machine). */
export function cancelDeliveryOn(order: any, now: Date) {
  if (order.type === 'delivery' && order.delivery?.status && !['delivered', 'returned', 'cancelled'].includes(order.delivery.status)) {
    order.delivery.status = 'cancelled';
    order.delivery.cancelledAt = now;
  }
}

/** Persistent job: alerts once for each delivery past its due time + grace. */
export async function checkDelays(tenant: ResolvedTenant, now = new Date()) {
  const grace = (tenant.settings?.delivery?.delayGraceMinutes ?? 10) * 60_000;
  const late = await Order.find({ tenantId: tenant._id, 'delivery.status': { $in: ['awaiting_assignment', ...ACTIVE_DELIVERY] }, 'delivery.etaAt': { $lt: new Date(now.getTime() - grace) }, 'delivery.delayedNotifiedAt': { $exists: false } }).select('orderNumber delivery').lean();
  for (const o of late) {
    const r = await Order.updateOne({ tenantId: tenant._id, _id: o._id, 'delivery.delayedNotifiedAt': { $exists: false } }, { $set: { 'delivery.delayedNotifiedAt': now } });
    if (r.modifiedCount !== 1) continue;
    await notify(tenant._id, { type: 'delivery.delayed', title: `Delivery #${o.orderNumber} is late`, body: `Due ${new Date(o.delivery!.etaAt!).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tenant.settings?.timezone ?? 'UTC' })}; status ${o.delivery!.status!.replace('_', ' ')}`, link: '/dashboard/delivery', roles: ['owner', 'admin', 'manager'] });
    await broadcast(tenant, String(o._id));
    await customerMessage(tenant, String(o._id), 'delayed');
  }
  return { late: late.length };
}

/** Transactional SMS to the customer, only when enabled AND an SMS provider is configured. */
async function customerMessage(tenant: ResolvedTenant, orderId: string, event: string) {
  if (!tenant.settings?.delivery?.notifyCustomerSms) return;
  const { queueTransactional } = await import('./marketing');
  await queueTransactional(tenant, orderId, event).catch((e) => console.error('[DELIVERY] customer message', e?.message));
}

/* ---------------- analytics ---------------- */
export async function deliveryAnalytics(tenant: ResolvedTenant, q: { from?: string; to?: string; period?: string }) {
  const tz = tenant.settings?.timezone ?? 'UTC';
  const r = parseRange(q, tz);
  const orders = await Order.find({ tenantId: tenant._id, type: 'delivery', createdAt: { $gte: r.from, $lt: r.to } }).select('createdAt acceptedAt readyAt deliveryFee total status delivery').lean();
  const mins = (a?: Date | null, b?: Date | null) => (a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 60_000 : null);
  const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null && x >= 0); return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null; };
  const delivered = orders.filter((o) => o.delivery?.status === 'delivered');
  const onTime = delivered.filter((o) => o.delivery?.etaAt && o.delivery.deliveredAt && new Date(o.delivery.deliveredAt) <= new Date(o.delivery.etaAt));
  const riders = new Map<string, any>();
  const zones = new Map<string, any>();
  const hours = new Map<number, number>();
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false });
  for (const o of orders) {
    const d: any = o.delivery ?? {};
    const h = Number(hourFmt.format(new Date(o.createdAt))) % 24;
    hours.set(h, (hours.get(h) ?? 0) + 1);
    if (d.riderId || d.attempts?.length) {
      for (const a of d.attempts ?? []) {
        const e = riders.get(a.riderId) ?? { riderId: a.riderId, name: a.riderName ?? d.riderName, assigned: 0, delivered: 0, failed: 0, rejected: 0, timeouts: 0, onTime: 0, times: [] as number[] };
        if (a.outcome === 'assigned') e.assigned++;
        if (a.outcome === 'rejected') e.rejected++;
        if (a.outcome === 'timeout') e.timeouts++;
        if (a.riderName) e.name = a.riderName;
        riders.set(a.riderId, e);
      }
      const e = riders.get(String(d.riderId));
      if (e && d.status === 'delivered') { e.delivered++; e.times.push(mins(d.pickedUpAt, d.deliveredAt)); if (d.etaAt && new Date(d.deliveredAt) <= new Date(d.etaAt)) e.onTime++; }
      if (e && d.status === 'failed') e.failed++;
    }
    const zk = d.zoneName ?? 'No zone';
    const z = zones.get(zk) ?? { zone: zk, orders: 0, delivered: 0, onTime: 0, fees: 0, times: [] as number[] };
    z.orders++;
    if (d.status === 'delivered') { z.delivered++; z.fees += o.deliveryFee ?? 0; z.times.push(mins(o.createdAt, d.deliveredAt)); if (d.etaAt && new Date(d.deliveredAt) <= new Date(d.etaAt)) z.onTime++; }
    zones.set(zk, z);
  }
  return {
    range: r,
    total: orders.length,
    delivered: delivered.length,
    failed: orders.filter((o) => o.delivery?.status === 'failed' || o.delivery?.status === 'returned').length,
    cancelled: orders.filter((o) => o.delivery?.status === 'cancelled' || ['cancelled', 'rejected'].includes(o.status)).length,
    active: orders.filter((o) => ACTIVE_DELIVERY.includes(o.delivery?.status as DeliveryState) || o.delivery?.status === 'awaiting_assignment').length,
    averagePrepMinutes: avg(orders.map((o) => mins(o.acceptedAt, o.readyAt))),
    averageAssignmentMinutes: avg(orders.map((o) => mins(o.acceptedAt, o.delivery?.acceptedAt))),
    averageDeliveryMinutes: avg(delivered.map((o) => mins(o.delivery?.pickedUpAt, o.delivery?.deliveredAt))),
    averageTotalMinutes: avg(delivered.map((o) => mins(o.createdAt, o.delivery?.deliveredAt))),
    onTimeRatePercent: delivered.length ? Math.round((onTime.length / delivered.length) * 1000) / 10 : null,
    late: delivered.length - onTime.length,
    feesCollected: delivered.reduce((s, o) => s + (o.deliveryFee ?? 0), 0),
    riders: [...riders.values()].map((e) => ({ ...e, averageDeliveryMinutes: avg(e.times), onTimeRatePercent: e.delivered ? Math.round((e.onTime / e.delivered) * 1000) / 10 : null, times: undefined })),
    zones: [...zones.values()].map((z) => ({ ...z, averageTotalMinutes: avg(z.times), onTimeRatePercent: z.delivered ? Math.round((z.onTime / z.delivered) * 1000) / 10 : null, times: undefined })),
    peakHours: [...hours.entries()].sort((a, b) => b[1] - a[1]).map(([hour, n]) => ({ hour, orders: n })),
    basis: 'Times come from recorded timestamps. "On time" = delivered before the estimate (prep time + zone delivery time). Distances are not measured.',
  };
}

export async function updateRiderLocation(tenant: ResolvedTenant, rider: AuthUser, loc: { lat: number; lng: number }) {
  if (!validLatLng(loc)) throw badRequest('Invalid location');
  const u = await User.findOne({ tenantId: tenant._id, _id: rider.id, role: 'rider' }).select('riderProfile').lean();
  if (!u?.riderProfile?.locationSharing) throw badRequest('Turn on location sharing first');
  await User.updateOne({ tenantId: tenant._id, _id: rider.id }, { $set: { 'riderProfile.location': { lat: loc.lat, lng: loc.lng, at: new Date() } } });
}
