/**
 * Business intelligence from the restaurant's own persisted data (deterministic; no AI involved).
 *
 * Money terms used everywhere (integer minor units):
 *  - grossItemSales  = Σ item line totals before any discount (what dishes were sold for)
 *  - discounts       = item discounts + coupon + manual order discounts
 *  - netItemRevenue  = grossItemSales − discounts (food & drink revenue; excludes tax, service, delivery fees)
 *  - orderTotals     = what guests were billed (includes tax, service charge and delivery fees)
 *  - foodCost        = Σ quantity × recipe cost, where the recipe uses ingredients with a cost per unit
 *  - grossProfit     = item revenue − food cost, ONLY over dishes whose cost is known (coverage reported)
 * Revenue is never presented as profit. Recipe costs use TODAY's ingredient costs (history is not snapshotted).
 */
import type { Types } from 'mongoose';
import { Customer, Order, Payment } from '../models/operations';
import { Category, Product } from '../models/menu';
import { InventoryItem, StockMovement } from '../models/inventory';
import { financialSummary, parseRange, topHours, type Range } from './analyticsService';
import type { ResolvedTenant } from '../types/express';

export const SALE_STATUSES = ['accepted', 'preparing', 'partially_ready', 'ready', 'delivered', 'completed', 'refunded'];
export const MIN_ORDERS_FOR_TRENDS = 20;

export function rangeFor(tenant: ResolvedTenant, q: { from?: string; to?: string; period?: string }) {
  return parseRange(q, tenant.settings?.timezone ?? 'UTC');
}
export function priorRange(r: Range): Range {
  const len = r.to.getTime() - r.from.getTime();
  return { from: new Date(r.from.getTime() - len), to: r.from, tz: r.tz };
}

/** Cost of one portion of each dish from its recipe (null = unknown: no recipe or an ingredient without cost). */
export async function unitCosts(tenantId: Types.ObjectId) {
  const [products, items] = await Promise.all([
    Product.find({ tenantId }).select('name recipe price categoryId isAvailable isArchived').lean(),
    InventoryItem.find({ tenantId }).select('name unit costPerUnit quantity lowStockThreshold isActive').lean(),
  ]);
  const cost = new Map(items.map((i) => [String(i._id), i]));
  const out = new Map<string, { cost: number | null; name: string; price: number; categoryId: string; reason?: string }>();
  for (const p of products) {
    let c: number | null = 0;
    let reason: string | undefined;
    if (!p.recipe?.length) {
      c = null;
      reason = 'no recipe';
    } else {
      for (const r of p.recipe) {
        const inv = cost.get(String(r.inventoryItemId));
        if (!inv || !inv.costPerUnit) {
          c = null;
          reason = `no cost for ${inv?.name ?? 'an ingredient'}`;
          break;
        }
        c += r.quantity * inv.costPerUnit;
      }
    }
    out.set(String(p._id), { cost: c == null ? null : Math.round(c), name: p.name?.en ?? '', price: p.price, categoryId: String(p.categoryId), reason });
  }
  return { costs: out, inventory: items };
}

/** Per-dish quantity, revenue (after item discounts), food cost and gross profit for a range. */
export async function productEconomics(tenantId: Types.ObjectId, r: Range) {
  const rows = await Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: r.from, $lt: r.to }, status: { $in: SALE_STATUSES } } },
    { $unwind: '$items' },
    { $match: { 'items.status': { $ne: 'cancelled' } } },
    { $group: { _id: '$items.productId', name: { $first: '$items.name' }, categoryId: { $first: '$items.categoryId' }, quantity: { $sum: '$items.quantity' }, gross: { $sum: '$items.lineTotal' }, itemDiscounts: { $sum: { $ifNull: ['$items.discount', 0] } } } },
  ]);
  const { costs } = await unitCosts(tenantId);
  let revenueWithCost = 0;
  let revenueTotal = 0;
  const products = rows.map((x) => {
    const revenue = x.gross - x.itemDiscounts;
    const unit = costs.get(String(x._id));
    const foodCost = unit?.cost != null ? unit.cost * x.quantity : null;
    revenueTotal += revenue;
    if (foodCost != null) revenueWithCost += revenue;
    return {
      productId: String(x._id), name: x.name, categoryId: x.categoryId ? String(x.categoryId) : null, quantity: x.quantity, grossSales: x.gross, itemDiscounts: x.itemDiscounts, revenue,
      foodCost, grossProfit: foodCost != null ? revenue - foodCost : null, marginPercent: foodCost != null && revenue > 0 ? round1(((revenue - foodCost) / revenue) * 100) : null,
      foodCostPercent: foodCost != null && revenue > 0 ? round1((foodCost / revenue) * 100) : null, costUnknownReason: foodCost == null ? unit?.reason ?? 'dish not found' : undefined,
    };
  });
  products.sort((a, b) => b.revenue - a.revenue);
  return { products, costCoveragePercent: revenueTotal ? round1((revenueWithCost / revenueTotal) * 100) : 0 };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pctChange = (now: number, before: number) => (before > 0 ? round1(((now - before) / before) * 100) : null);

async function dailySeries(tenantId: Types.ObjectId, r: Range) {
  return Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: r.from, $lt: r.to }, status: { $in: SALE_STATUSES } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: r.tz } }, orders: { $sum: 1 }, sales: { $sum: '$total' }, dow: { $first: { $dayOfWeek: { date: '$createdAt', timezone: r.tz } } } } },
    { $sort: { _id: 1 } },
  ]);
}

async function customerMetrics(tenantId: Types.ObjectId, r: Range, prior: Range) {
  const [current, before] = await Promise.all([
    Order.distinct('customerId', { tenantId, createdAt: { $gte: r.from, $lt: r.to }, status: { $in: SALE_STATUSES }, customerId: { $ne: null } }),
    Order.distinct('customerId', { tenantId, createdAt: { $gte: prior.from, $lt: prior.to }, status: { $in: SALE_STATUSES }, customerId: { $ne: null } }),
  ]);
  const cur = new Set(current.map(String));
  const earlier = await Order.distinct('customerId', { tenantId, createdAt: { $lt: r.from }, status: { $in: SALE_STATUSES }, customerId: { $in: current } });
  const returning = earlier.length;
  const retained = before.filter((id) => cur.has(String(id))).length;
  return {
    identifiedCustomers: current.length,
    newCustomers: current.length - returning,
    returningCustomers: returning,
    retentionPercent: before.length ? round1((retained / before.length) * 100) : null,
    retentionBase: before.length,
    note: 'Only orders with a phone number are linked to a customer; anonymous orders are not counted here.',
  };
}

async function couponMetrics(tenantId: Types.ObjectId, r: Range) {
  const rows = await Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: r.from, $lt: r.to }, status: { $in: SALE_STATUSES } } },
    { $group: { _id: { $ifNull: ['$couponCode', null] }, orders: { $sum: 1 }, total: { $sum: '$total' }, subtotal: { $sum: '$subtotal' }, discount: { $sum: { $ifNull: ['$couponDiscount', 0] } } } },
  ]);
  const base = rows.find((x) => x._id == null);
  const aovWithout = base?.orders ? Math.round(base.total / base.orders) : null;
  return {
    averageOrderValueWithoutCoupon: aovWithout,
    coupons: rows.filter((x) => x._id).map((x) => ({ code: x._id, orders: x.orders, discount: x.discount, revenue: x.total, averageOrderValue: Math.round(x.total / x.orders), averageDiscountPercent: x.subtotal ? round1((x.discount / x.subtotal) * 100) : 0 })),
  };
}

async function wasteAndConsumption(tenantId: Types.ObjectId, r: Range) {
  const rows = await StockMovement.aggregate([
    { $match: { tenantId, createdAt: { $gte: r.from, $lt: r.to }, type: { $in: ['wastage', 'consumption'] } } },
    { $group: { _id: { item: '$inventoryItemId', type: '$type' }, quantity: { $sum: '$quantity' } } },
  ]);
  const items = await InventoryItem.find({ tenantId }).select('name unit costPerUnit').lean();
  const by = new Map(items.map((i) => [String(i._id), i]));
  const out = { wasteCost: 0, wasteCostKnown: true, waste: [] as any[], consumption: [] as any[] };
  for (const x of rows) {
    const it = by.get(String(x._id.item));
    const qty = Math.abs(x.quantity);
    const cost = it?.costPerUnit ? Math.round(qty * it.costPerUnit) : null;
    const row = { name: it?.name ?? 'Unknown item', unit: it?.unit, quantity: round1(qty), cost };
    if (x._id.type === 'wastage') {
      out.waste.push(row);
      if (cost == null) out.wasteCostKnown = false;
      else out.wasteCost += cost;
    } else out.consumption.push(row);
  }
  out.waste.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  out.consumption.sort((a, b) => b.quantity - a.quantity);
  return out;
}

/** Products whose quantity in the last 14 days fell ≥30 % vs the 14 days before (min 5 sold before). */
export async function decliningProducts(tenantId: Types.ObjectId, now = new Date()) {
  const d14 = new Date(now.getTime() - 14 * 86400_000);
  const d28 = new Date(now.getTime() - 28 * 86400_000);
  const rows = await Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: d28, $lt: now }, status: { $in: SALE_STATUSES } } },
    { $unwind: '$items' },
    { $match: { 'items.status': { $ne: 'cancelled' } } },
    { $group: { _id: '$items.productId', name: { $first: '$items.name' }, recent: { $sum: { $cond: [{ $gte: ['$createdAt', d14] }, '$items.quantity', 0] } }, before: { $sum: { $cond: [{ $lt: ['$createdAt', d14] }, '$items.quantity', 0] } } } },
  ]);
  return rows
    .filter((x) => x.before >= 5 && x.recent <= x.before * 0.7)
    .map((x) => ({ productId: String(x._id), name: x.name, last14Days: x.recent, previous14Days: x.before, changePercent: pctChange(x.recent, x.before) }))
    .sort((a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0));
}

export async function businessOverview(tenant: ResolvedTenant, q: { from?: string; to?: string; period?: string }) {
  const tenantId = tenant._id;
  const r = rangeFor(tenant, q);
  const prior = priorRange(r);
  const [summary, priorSummary, econ, daily, hours, customers, coupons, waste, declining, ordersAll] = await Promise.all([
    financialSummary(tenantId, r),
    financialSummary(tenantId, prior),
    productEconomics(tenantId, r),
    dailySeries(tenantId, r),
    topHours(tenantId, r),
    customerMetrics(tenantId, r, prior),
    couponMetrics(tenantId, r),
    wasteAndConsumption(tenantId, r),
    decliningProducts(tenantId),
    Order.countDocuments({ tenantId, createdAt: { $gte: r.from, $lt: r.to } }),
  ]);
  const netItemRevenue = summary.grossSales - summary.discounts;
  const known = econ.products.filter((p) => p.foodCost != null);
  const foodCost = known.reduce((s, p) => s + (p.foodCost ?? 0), 0);
  const knownRevenue = known.reduce((s, p) => s + p.revenue, 0);
  const weekdays = { weekday: { days: 0, orders: 0, sales: 0 }, weekend: { days: 0, orders: 0, sales: 0 } };
  const byDow = Array.from({ length: 7 }, (_, i) => ({ dayOfWeek: i, orders: 0, sales: 0, days: 0 }));
  for (const d of daily) {
    const dow = d.dow - 1; // Mongo: 1 = Sunday
    byDow[dow].orders += d.orders;
    byDow[dow].sales += d.sales;
    byDow[dow].days++;
    const k = dow === 0 || dow === 6 ? 'weekend' : 'weekday';
    weekdays[k].days++;
    weekdays[k].orders += d.orders;
    weekdays[k].sales += d.sales;
  }
  const cancelRate = ordersAll ? round1((summary.cancelledOrders / ordersAll) * 100) : 0;
  const sufficient = summary.orders >= MIN_ORDERS_FOR_TRENDS;
  return {
    range: r,
    dataQuality: {
      salesOrders: summary.orders,
      daysWithSales: daily.length,
      sufficientForTrends: sufficient,
      message: sufficient ? null : `Only ${summary.orders} sales orders in this period; trends and comparisons need at least ${MIN_ORDERS_FOR_TRENDS}.`,
      costCoveragePercent: econ.costCoveragePercent,
    },
    money: {
      grossItemSales: summary.grossSales,
      discounts: summary.discounts,
      netItemRevenue,
      serviceCharges: summary.serviceCharges,
      taxes: summary.taxes,
      orderTotals: summary.netSales,
      verifiedCollections: summary.verifiedCollections,
      refunds: summary.refunds,
      foodCost: known.length ? foodCost : null,
      grossProfit: known.length ? knownRevenue - foodCost : null,
      grossMarginPercent: known.length && knownRevenue ? round1(((knownRevenue - foodCost) / knownRevenue) * 100) : null,
      profitBasis: known.length ? `Food cost and gross profit cover ${econ.costCoveragePercent}% of item revenue (dishes with complete recipe costs). Labour, rent and other costs are not included.` : 'No dish has a recipe with ingredient costs, so food cost and profit cannot be calculated.',
    },
    orders: { count: summary.orders, averageOrderValue: summary.averageOrderValue, cancelledOrRejected: summary.cancelledOrders, cancellationRatePercent: cancelRate, allOrders: ordersAll },
    comparison: sufficient ? { previousOrders: priorSummary.orders, ordersChangePercent: pctChange(summary.orders, priorSummary.orders), previousOrderTotals: priorSummary.netSales, salesChangePercent: pctChange(summary.netSales, priorSummary.netSales) } : null,
    daily,
    dayOfWeek: byDow.map((d) => ({ ...d, averageSales: d.days ? Math.round(d.sales / d.days) : 0 })),
    weekdayVsWeekend: Object.fromEntries(Object.entries(weekdays).map(([k, v]) => [k, { ...v, averageDailySales: v.days ? Math.round(v.sales / v.days) : 0, averageDailyOrders: v.days ? round1(v.orders / v.days) : 0 }])),
    peakHours: [...hours].sort((a, b) => b.orders - a.orders).slice(0, 5).map((h) => ({ hour: h._id, orders: h.orders, sales: h.sales })),
    topByRevenue: econ.products.slice(0, 10),
    topByProfit: [...known].sort((a, b) => (b.grossProfit ?? 0) - (a.grossProfit ?? 0)).slice(0, 10),
    lowPerformers: [...econ.products].sort((a, b) => a.quantity - b.quantity).slice(0, 5),
    highFoodCost: known.filter((p) => (p.foodCostPercent ?? 0) > (tenant.settings?.intelligence?.foodCostTargetPercent ?? 35)).sort((a, b) => (b.foodCostPercent ?? 0) - (a.foodCostPercent ?? 0)),
    declining,
    categories: await categoryTotals(tenantId, econ.products),
    customers,
    discounts: coupons,
    waste,
  };
}

async function categoryTotals(tenantId: Types.ObjectId, products: any[]) {
  const cats = await Category.find({ tenantId }).select('name').lean();
  const name = new Map(cats.map((c) => [String(c._id), c.name?.en ?? '']));
  const by = new Map<string, { name: string; quantity: number; revenue: number }>();
  for (const p of products) {
    const k = p.categoryId ?? 'none';
    const row = by.get(k) ?? { name: name.get(k) ?? 'Uncategorised', quantity: 0, revenue: 0 };
    row.quantity += p.quantity;
    row.revenue += p.revenue;
    by.set(k, row);
  }
  return [...by.values()].sort((a, b) => b.revenue - a.revenue);
}

/** Small, safe aggregates used by the AI assistant and the recommendation engine. */
export async function salesForPeriod(tenant: ResolvedTenant, q: { from?: string; to?: string; period?: string }) {
  const r = rangeFor(tenant, q);
  const s = await financialSummary(tenant._id, r);
  const payments = await Payment.countDocuments({ tenantId: tenant._id, createdAt: { $gte: r.from, $lt: r.to }, status: 'verified', kind: 'charge' });
  return { range: r, ...s, verifiedPaymentCount: payments };
}

export async function customerCounts(tenantId: Types.ObjectId) {
  const rows = await Customer.aggregate([{ $match: { tenantId } }, { $unwind: { path: '$segments', preserveNullAndEmptyArrays: false } }, { $group: { _id: '$segments', n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((x) => [x._id, x.n]));
}
