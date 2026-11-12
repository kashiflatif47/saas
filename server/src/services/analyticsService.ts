import type { Types } from 'mongoose';
import { Order, Payment } from '../models/operations';
import { Category } from '../models/menu';

export type Granularity = 'day' | 'week' | 'month' | 'year';

/** Orders that count as sales (anything accepted that was not rejected/cancelled). */
const SALE_STATUSES = ['accepted', 'preparing', 'partially_ready', 'ready', 'delivered', 'completed', 'refunded'];

export interface Range { from: Date; to: Date; tz: string }

export async function financialSummary(tenantId: Types.ObjectId, r: Range) {
  const [sales] = await Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: r.from, $lt: r.to }, status: { $in: SALE_STATUSES } } },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        gross: { $sum: '$subtotal' },
        discounts: { $sum: '$discount' },
        serviceCharges: { $sum: '$serviceCharge' },
        taxes: { $sum: '$tax' },
        netSales: { $sum: '$total' },
        paid: { $sum: '$amountPaid' },
      },
    },
  ]);
  const [money] = await Payment.aggregate([
    { $match: { tenantId, createdAt: { $gte: r.from, $lt: r.to } } },
    {
      $group: {
        _id: null,
        verifiedCollections: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'charge'] }, { $eq: ['$status', 'verified'] }] }, '$amount', 0] } },
        pendingOnline: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'charge'] }, { $eq: ['$status', 'pending'] }] }, '$amount', 0] } },
        refunds: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'refund'] }, { $eq: ['$status', 'verified'] }] }, '$amount', 0] } },
        cash: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'charge'] }, { $eq: ['$status', 'verified'] }, { $eq: ['$method', 'cash'] }] }, '$amount', 0] } },
        online: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'charge'] }, { $eq: ['$status', 'verified'] }, { $eq: ['$method', 'online'] }] }, '$amount', 0] } },
        cardTerminal: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'charge'] }, { $eq: ['$status', 'verified'] }, { $eq: ['$method', 'card_terminal'] }] }, '$amount', 0] } },
      },
    },
  ]);
  const [cancelled] = await Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: r.from, $lt: r.to }, status: { $in: ['rejected', 'cancelled'] } } },
    { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$total' } } },
  ]);
  const s = sales ?? { orders: 0, gross: 0, discounts: 0, serviceCharges: 0, taxes: 0, netSales: 0, paid: 0 };
  const m = money ?? { verifiedCollections: 0, pendingOnline: 0, refunds: 0, cash: 0, online: 0, cardTerminal: 0 };
  return {
    orders: s.orders,
    grossSales: s.gross,
    discounts: s.discounts,
    serviceCharges: s.serviceCharges,
    taxes: s.taxes,
    netSales: s.netSales,
    averageOrderValue: s.orders ? Math.round(s.netSales / s.orders) : 0,
    verifiedCollections: m.verifiedCollections,
    refunds: m.refunds,
    netCollections: m.verifiedCollections - m.refunds,
    pendingPayments: Math.max(0, s.netSales - s.paid), // outstanding on sales orders in range
    pendingOnlineIntents: m.pendingOnline,
    byMethod: { cash: m.cash, online: m.online, cardTerminal: m.cardTerminal },
    cancelledOrders: cancelled?.count ?? 0,
    cancelledValue: cancelled?.value ?? 0,
  };
}

export async function revenueSeries(tenantId: Types.ObjectId, r: Range, unit: Granularity) {
  return Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: r.from, $lt: r.to }, status: { $in: SALE_STATUSES } } },
    {
      $group: {
        _id: { $dateTrunc: { date: '$createdAt', unit, timezone: r.tz, startOfWeek: 'monday' } },
        orders: { $sum: 1 },
        sales: { $sum: '$total' },
        tax: { $sum: '$tax' },
        discount: { $sum: '$discount' },
        collected: { $sum: '$amountPaid' },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, period: '$_id', orders: 1, sales: 1, tax: 1, discount: 1, collected: 1 } },
  ]);
}

export async function productReport(tenantId: Types.ObjectId, r: Range) {
  return Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: r.from, $lt: r.to }, status: { $in: SALE_STATUSES } } },
    { $unwind: '$items' },
    { $match: { 'items.status': { $ne: 'cancelled' } } },
    { $group: { _id: '$items.productId', name: { $first: '$items.name' }, categoryId: { $first: '$items.categoryId' }, quantity: { $sum: '$items.quantity' }, revenue: { $sum: '$items.lineTotal' } } },
    { $sort: { revenue: -1 } },
    { $limit: 500 },
  ]);
}

export async function categoryReport(tenantId: Types.ObjectId, r: Range) {
  const rows = await Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: r.from, $lt: r.to }, status: { $in: SALE_STATUSES } } },
    { $unwind: '$items' },
    { $match: { 'items.status': { $ne: 'cancelled' } } },
    { $group: { _id: '$items.categoryId', quantity: { $sum: '$items.quantity' }, revenue: { $sum: '$items.lineTotal' } } },
    { $sort: { revenue: -1 } },
  ]);
  const cats = await Category.find({ tenantId, _id: { $in: rows.map((x) => x._id).filter(Boolean) } }).select('name').lean();
  const names = new Map(cats.map((c) => [String(c._id), c.name?.en]));
  return rows.map((x) => ({ ...x, name: names.get(String(x._id)) ?? 'Uncategorised' }));
}

export async function topHours(tenantId: Types.ObjectId, r: Range) {
  return Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: r.from, $lt: r.to }, status: { $in: SALE_STATUSES } } },
    { $group: { _id: { $hour: { date: '$createdAt', timezone: r.tz } }, orders: { $sum: 1 }, sales: { $sum: '$total' } } },
    { $sort: { _id: 1 } },
  ]);
}

/** Parses ?from&to&period into a safe date range (max 3 years). */
export function parseRange(q: { from?: string; to?: string; period?: string }, tz: string): Range {
  const now = new Date();
  let to = q.to ? new Date(q.to) : now;
  let from: Date;
  if (q.from) from = new Date(q.from);
  else {
    const days = { today: 1, week: 7, month: 30, year: 365 }[q.period ?? 'month'] ?? 30;
    from = new Date(to.getTime() - days * 86400_000);
  }
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    from = new Date(now.getTime() - 30 * 86400_000);
    to = now;
  }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) to = new Date(to.getTime() + 86400_000); // inclusive end date
  const max = 3 * 366 * 86400_000;
  if (to.getTime() - from.getTime() > max) from = new Date(to.getTime() - max);
  return { from, to, tz };
}
