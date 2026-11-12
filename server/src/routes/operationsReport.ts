import { Router } from 'express';
import { z } from 'zod';
import { can } from '../middleware/auth';
import { validateQuery } from '../middleware/validate';
import { ah } from '../lib/errors';
import { financialSummary, parseRange } from '../services/analyticsService';
import { CashShift, Order, Payment } from '../models/operations';
import { KitchenStation } from '../models/menu';
import { User } from '../models/platform';

/** Mounted under /api/staff/analytics. */
export const operationsReportRouter = Router();

const rangeQuery = z.object({
  from: z.string().max(30).optional(),
  to: z.string().max(30).optional(),
  period: z.enum(['today', 'week', 'month', 'year']).optional(),
});

const SALES = ['accepted', 'preparing', 'partially_ready', 'ready', 'delivered', 'completed', 'refunded'];

/**
 * POS & kitchen operations report for a date range. Everything is derived from persisted orders,
 * payments, shifts and kitchen timestamps; nothing is estimated or sampled.
 */
operationsReportRouter.get('/operations', can('analytics:view'), validateQuery(rangeQuery), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const tz = req.tenant!.settings?.timezone ?? 'UTC';
  const range = parseRange(q, tz);
  const tenantId = req.tenantId!;
  const grace = req.tenant!.settings?.kitchenDelayGraceMinutes ?? 5;
  const inRange = { tenantId, createdAt: { $gte: range.from, $lt: range.to } };

  const [summary, byType, bySource, payRows, discounts, staffOrders, shifts, kitchenOrders] = await Promise.all([
    financialSummary(tenantId, range),
    Order.aggregate([{ $match: { ...inRange, status: { $in: SALES } } }, { $group: { _id: '$type', orders: { $sum: 1 }, sales: { $sum: '$total' } } }, { $sort: { sales: -1 } }]),
    Order.aggregate([{ $match: { ...inRange, status: { $in: SALES } } }, { $group: { _id: '$source', orders: { $sum: 1 }, sales: { $sum: '$total' } } }, { $sort: { sales: -1 } }]),
    Payment.aggregate([
      { $match: { ...inRange, status: 'verified' } },
      { $group: { _id: { by: '$verifiedBy', kind: '$kind', method: '$method' }, amount: { $sum: '$amount' }, n: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { ...inRange, status: { $in: SALES } } },
      {
        $group: {
          _id: null,
          lines: { $sum: { $ifNull: ['$lineDiscountTotal', 0] } },
          manual: { $sum: { $ifNull: ['$manualDiscount.amount', 0] } },
          // Orders placed before discount breakdowns existed: their whole discount came from the coupon.
          coupon: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$couponDiscount', 0] }, 0] }, '$couponDiscount', { $cond: [{ $ifNull: ['$couponCode', false] }, '$discount', 0] }] } },
          ordersWithDiscount: { $sum: { $cond: [{ $gt: ['$discount', 0] }, 1, 0] } },
        },
      },
    ]),
    Order.aggregate([
      { $match: { ...inRange, status: { $in: SALES }, 'createdBy.id': { $exists: true } } },
      { $group: { _id: '$createdBy.id', name: { $first: '$createdBy.name' }, orders: { $sum: 1 }, sales: { $sum: '$total' } } },
    ]),
    CashShift.find({ tenantId, openedAt: { $gte: range.from, $lt: range.to } }).sort({ openedAt: -1 }).limit(200).lean(),
    Order.find({ ...inRange, acceptedAt: { $exists: true } }).select('acceptedAt readyAt status items.name items.status items.stationId items.prepMinutes items.startedAt items.readyAt').limit(20_000).lean(),
  ]);

  /* Payments by method and by cashier */
  type Person = { userId: string; name?: string; role?: string; collected: number; refunded: number; payments: number; orders: number; sales: number };
  const methods: Record<string, { collected: number; refunded: number; count: number }> = {};
  const people = new Map<string, Person>();
  const person = (id: string) => people.get(id) ?? { userId: id, collected: 0, refunded: 0, payments: 0, orders: 0, sales: 0 };
  for (const r of payRows) {
    const m = (methods[r._id.method] ??= { collected: 0, refunded: 0, count: 0 });
    if (r._id.kind === 'charge') {
      m.collected += r.amount;
      m.count += r.n;
    } else m.refunded += r.amount;
    if (!r._id.by) continue; // online payments are verified by the provider's webhook, not a person
    const c = person(String(r._id.by));
    if (r._id.kind === 'charge') {
      c.collected += r.amount;
      c.payments += r.n;
    } else c.refunded += r.amount;
    people.set(c.userId, c);
  }
  for (const s of staffOrders) {
    const c = person(String(s._id));
    c.orders = s.orders;
    c.sales = s.sales;
    c.name = s.name;
    people.set(c.userId, c);
  }
  const ids = [...people.keys()].filter((x) => /^[a-f0-9]{24}$/i.test(x));
  const users = ids.length ? await User.find({ tenantId, _id: { $in: ids } }).select('name role').lean() : [];
  for (const u of users) {
    const c = people.get(String(u._id))!;
    c.name = u.name;
    c.role = u.role;
  }

  /* Kitchen performance from persisted timestamps */
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false });
  const hourOf = (d: Date) => Number(hourFmt.format(d)) % 24;
  let tickets = 0;
  let ticketSecs = 0;
  let delayed = 0;
  let evaluable = 0;
  const peak = new Map<number, number>();
  const stationAgg = new Map<string, { items: number; prepSecs: number; prepN: number; readySecs: number; readyN: number }>();
  const itemAgg = new Map<string, { name: string; count: number; prepSecs: number; prepN: number }>();
  for (const o of kitchenOrders as any[]) {
    const acc = new Date(o.acceptedAt).getTime();
    const h = hourOf(new Date(o.acceptedAt));
    peak.set(h, (peak.get(h) ?? 0) + 1);
    if (o.readyAt) {
      const secs = (new Date(o.readyAt).getTime() - acc) / 1000;
      tickets++;
      ticketSecs += secs;
      // "Delayed" only where the dishes have a configured preparation time.
      const prep = Math.max(0, ...o.items.filter((i: any) => i.status !== 'cancelled').map((i: any) => i.prepMinutes ?? 0));
      if (prep > 0) {
        evaluable++;
        if (secs > (prep + grace) * 60) delayed++;
      }
    }
    for (const i of o.items) {
      if (i.status === 'cancelled') continue;
      const key = String(i.stationId ?? 'none');
      const st = stationAgg.get(key) ?? { items: 0, prepSecs: 0, prepN: 0, readySecs: 0, readyN: 0 };
      const it = itemAgg.get(i.name) ?? { name: i.name, count: 0, prepSecs: 0, prepN: 0 };
      st.items++;
      it.count++;
      if (i.readyAt) {
        st.readySecs += (new Date(i.readyAt).getTime() - acc) / 1000;
        st.readyN++;
        if (i.startedAt) {
          const p = (new Date(i.readyAt).getTime() - new Date(i.startedAt).getTime()) / 1000;
          st.prepSecs += p;
          st.prepN++;
          it.prepSecs += p;
          it.prepN++;
        }
      }
      stationAgg.set(key, st);
      itemAgg.set(i.name, it);
    }
  }
  const stationDocs = await KitchenStation.find({ tenantId }).select('name').lean();
  const stationName = new Map(stationDocs.map((s) => [String(s._id), s.name]));
  const avg = (s: number, n: number) => (n ? Math.round(s / n) : null);

  res.json({
    range,
    sales: { orders: summary.orders, netSales: summary.netSales, averageOrderValue: summary.averageOrderValue, taxes: summary.taxes, serviceCharges: summary.serviceCharges },
    byType: byType.map((x) => ({ type: x._id, orders: x.orders, sales: x.sales })),
    bySource: bySource.map((x) => ({ source: x._id, orders: x.orders, sales: x.sales })),
    byMethod: Object.entries(methods).map(([method, v]) => ({ method, ...v })),
    cashiers: [...people.values()].sort((a, b) => b.collected + b.sales - (a.collected + a.sales)),
    discounts: { lines: discounts[0]?.lines ?? 0, coupon: discounts[0]?.coupon ?? 0, manual: discounts[0]?.manual ?? 0, total: summary.discounts, ordersWithDiscount: discounts[0]?.ordersWithDiscount ?? 0 },
    refunds: { amount: summary.refunds, byMethod: Object.entries(methods).map(([method, v]) => ({ method, amount: v.refunded })).filter((x) => x.amount > 0) },
    shifts: shifts.map((s) => ({ _id: s._id, cashierName: s.cashierName, status: s.status, openedAt: s.openedAt, closedAt: s.closedAt, openingFloat: s.openingFloat, expectedCash: s.expectedCash, countedCash: s.countedCash, discrepancy: s.discrepancy, totals: s.totals })),
    kitchen: {
      graceMinutes: grace,
      ticketsReady: tickets,
      averageTicketSeconds: avg(ticketSecs, tickets),
      delayedTickets: delayed,
      ticketsWithPrepTime: evaluable,
      stations: [...stationAgg.entries()].map(([id, v]) => ({
        stationId: id === 'none' ? null : id,
        name: id === 'none' ? 'No station' : stationName.get(id) ?? 'Deleted station',
        items: v.items,
        averagePrepSeconds: avg(v.prepSecs, v.prepN),
        averageReadySeconds: avg(v.readySecs, v.readyN),
      })),
      items: [...itemAgg.values()].sort((a, b) => b.count - a.count).slice(0, 30).map((v) => ({ name: v.name, count: v.count, averagePrepSeconds: avg(v.prepSecs, v.prepN) })),
      peakHours: [...peak.entries()].sort((a, b) => a[0] - b[0]).map(([hour, orders]) => ({ hour, orders })),
    },
  });
}));
