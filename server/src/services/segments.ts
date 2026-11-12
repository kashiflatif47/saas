/**
 * Customer segmentation from actual order behaviour (tenant-scoped, explainable, configurable rules).
 * Only ordering behaviour is used: counts, spend, dates, order types and coupon use. Nothing sensitive is inferred.
 */
import type { Types } from 'mongoose';
import { Customer, Order } from '../models/operations';
import type { ResolvedTenant } from '../types/express';
import { SALE_STATUSES } from './intelligence';

export const SEGMENTS = {
  new: 'First order within the last N days (rule: newDays) and only one order',
  returning: 'Two or more orders',
  loyal: 'At least loyalOrders orders and ordered within the last inactiveDays days',
  high_value: 'Top highValueTopPercent % of customers by total spend',
  at_risk: 'Two or more orders, last order between atRiskDays and inactiveDays days ago',
  inactive: 'No order for more than inactiveDays days',
  frequent_delivery: 'At least 3 delivery orders and at least half of all orders are delivery',
  frequent_dine_in: 'At least 3 dine-in orders and at least half of all orders are dine-in',
  promotion_responsive: 'At least 2 orders with a coupon and at least half of all orders used one',
  declining: 'Orders in the last 60 days are less than half of the 60 days before (and at least 2 before)',
} as const;
export type Segment = keyof typeof SEGMENTS;

export function rulesFor(tenant: ResolvedTenant) {
  const r = tenant.settings?.segmentRules ?? {};
  return { newDays: r.newDays ?? 30, loyalOrders: r.loyalOrders ?? 5, highValueTopPercent: r.highValueTopPercent ?? 20, atRiskDays: r.atRiskDays ?? 30, inactiveDays: r.inactiveDays ?? 60 };
}

/** Pure classification (unit-testable). `spendThreshold` = minimum spend for high_value. */
export function classify(s: { orders: number; spend: number; firstOrderAt: Date; lastOrderAt: Date; deliveryOrders: number; dineInOrders: number; couponOrders: number; last60: number; prior60: number }, rules: ReturnType<typeof rulesFor>, spendThreshold: number, now = new Date()): Segment[] {
  const days = (d: Date) => (now.getTime() - new Date(d).getTime()) / 86400_000;
  const out: Segment[] = [];
  const sinceLast = days(s.lastOrderAt);
  if (s.orders === 1 && days(s.firstOrderAt) <= rules.newDays) out.push('new');
  if (s.orders >= 2) out.push('returning');
  if (s.orders >= rules.loyalOrders && sinceLast <= rules.inactiveDays) out.push('loyal');
  if (spendThreshold > 0 && s.spend >= spendThreshold) out.push('high_value');
  if (s.orders >= 2 && sinceLast > rules.atRiskDays && sinceLast <= rules.inactiveDays) out.push('at_risk');
  if (sinceLast > rules.inactiveDays) out.push('inactive');
  if (s.deliveryOrders >= 3 && s.deliveryOrders / s.orders >= 0.5) out.push('frequent_delivery');
  if (s.dineInOrders >= 3 && s.dineInOrders / s.orders >= 0.5) out.push('frequent_dine_in');
  if (s.couponOrders >= 2 && s.couponOrders / s.orders >= 0.5) out.push('promotion_responsive');
  if (s.prior60 >= 2 && s.last60 < s.prior60 / 2) out.push('declining');
  return out;
}

/** Recomputes stats and segments for every customer of a tenant. Idempotent. */
export async function recalculateSegments(tenant: ResolvedTenant, now = new Date()) {
  const tenantId = tenant._id as Types.ObjectId;
  const d60 = new Date(now.getTime() - 60 * 86400_000);
  const d120 = new Date(now.getTime() - 120 * 86400_000);
  const rows = await Order.aggregate([
    { $match: { tenantId, status: { $in: SALE_STATUSES }, customerId: { $ne: null } } },
    {
      $group: {
        _id: '$customerId',
        orders: { $sum: 1 },
        spend: { $sum: '$total' },
        firstOrderAt: { $min: '$createdAt' },
        lastOrderAt: { $max: '$createdAt' },
        deliveryOrders: { $sum: { $cond: [{ $eq: ['$type', 'delivery'] }, 1, 0] } },
        dineInOrders: { $sum: { $cond: [{ $eq: ['$type', 'dine_in'] }, 1, 0] } },
        takeawayOrders: { $sum: { $cond: [{ $in: ['$type', ['takeaway', 'pickup']] }, 1, 0] } },
        couponOrders: { $sum: { $cond: [{ $ifNull: ['$couponCode', false] }, 1, 0] } },
        last60: { $sum: { $cond: [{ $gte: ['$createdAt', d60] }, 1, 0] } },
        prior60: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', d120] }, { $lt: ['$createdAt', d60] }] }, 1, 0] } },
      },
    },
  ]);
  const rules = rulesFor(tenant);
  const spends = rows.map((r) => r.spend).sort((a, b) => b - a);
  const cut = spends.length ? spends[Math.max(0, Math.ceil((spends.length * rules.highValueTopPercent) / 100) - 1)] : 0;
  const counts: Record<string, number> = {};
  const ops = rows.map((r) => {
    const segments = classify(r, rules, spends.length >= 5 ? cut : 0, now);
    for (const s of segments) counts[s] = (counts[s] ?? 0) + 1;
    const channel = r.deliveryOrders >= r.dineInOrders && r.deliveryOrders >= r.takeawayOrders ? 'delivery' : r.dineInOrders >= r.takeawayOrders ? 'dine_in' : 'takeaway';
    return {
      updateOne: {
        filter: { tenantId, _id: r._id },
        update: { $set: { segments, segmentsAt: now, stats: { orders: r.orders, spend: r.spend, aov: Math.round(r.spend / r.orders), firstOrderAt: r.firstOrderAt, lastOrderAt: r.lastOrderAt, channel, deliveryOrders: r.deliveryOrders, dineInOrders: r.dineInOrders, couponOrders: r.couponOrders, last60: r.last60, prior60: r.prior60 } } },
      },
    };
  });
  if (ops.length) await Customer.bulkWrite(ops);
  // Customers without any sales order have no behaviour yet.
  await Customer.updateMany({ tenantId, _id: { $nin: rows.map((r) => r._id) } }, { $set: { segments: [], segmentsAt: now } });
  return { customers: rows.length, highValueThreshold: spends.length >= 5 ? cut : null, counts };
}

/** Customers in any of the given segments (empty list = every customer). */
export function segmentFilter(tenantId: Types.ObjectId, segments: string[]) {
  return segments.length ? { tenantId, segments: { $in: segments } } : { tenantId };
}
