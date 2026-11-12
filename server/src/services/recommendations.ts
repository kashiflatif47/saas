/**
 * Recommendation engine: explicit rules over measured metrics (no AI, no invented numbers).
 * Nothing is executed automatically: people accept, reject or dismiss. Accepted recommendations are
 * re-measured 14 days later against the baseline stored when they were created (outcome tracking).
 */
import { Types } from 'mongoose';
import { Recommendation } from '../models/growth';
import { Order } from '../models/operations';
import type { ResolvedTenant } from '../types/express';
import { businessOverview, decliningProducts, SALE_STATUSES } from './intelligence';
import { computeForecast } from './forecast';
import { customerCounts } from './intelligence';
import { deliveryAnalytics } from './delivery';

const fmt = (minor: number, tenant: ResolvedTenant) => (minor / 10 ** (tenant.settings?.currencyDecimals ?? 2)).toFixed(tenant.settings?.currencyDecimals ?? 2);

export function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

interface Draft {
  rule: string;
  subject: string;
  title: string;
  explanation: string;
  metrics: Record<string, unknown>;
  expectedBenefit?: string;
  priority: 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  action: string;
  baseline?: { metric: string; value: number | null; subject?: string };
}

export async function buildRecommendations(tenant: ResolvedTenant, now = new Date()): Promise<Draft[]> {
  const out: Draft[] = [];
  const ov = await businessOverview(tenant, { period: 'month' });
  const sufficient = ov.dataQuality.sufficientForTrends;
  const cur = (n: number) => `${fmt(n, tenant)} ${tenant.settings?.currency ?? ''}`.trim();

  // 1. Ingredients likely to run out (forecast × recipes vs stock on hand)
  const fc: any = await computeForecast(tenant, 7, now);
  if (fc.sufficient) {
    for (const i of fc.ingredients.items.filter((x: any) => x.reorderSuggested).slice(0, 5)) {
      out.push({
        rule: 'ingredient_runout', subject: i.inventoryItemId, priority: i.daysOfCover < 1 ? 'high' : 'medium', confidence: fc.accuracy.confidence,
        title: `Reorder ${i.name}`,
        explanation: `${i.onHand} ${i.unit} on hand covers about ${i.daysOfCover} day(s) at the forecast use of ${i.expectedUsePerDay} ${i.unit}/day (next 7 days: ${i.expectedUse} ${i.unit}). Your lead time setting is ${i.leadDays} days.`,
        metrics: i, action: 'Create a purchase order in Inventory', expectedBenefit: 'Avoids selling out of dishes that use it',
        baseline: { metric: 'days_of_cover', value: i.daysOfCover, subject: i.inventoryItemId },
      });
    }
    const peak = fc.hourly.peakHours?.[0];
    if (peak && peak.predicted >= 5) {
      out.push({
        rule: 'staffing_peak', subject: `${peak.date}-${peak.hour}`, priority: 'medium', confidence: fc.accuracy.confidence,
        title: `Busy period expected ${String(peak.hour).padStart(2, '0')}:00 on ${peak.date}`,
        explanation: `About ${peak.predicted} orders are expected in that hour (80% range ${peak.low}–${peak.high}), based on the same weekday and hour over recent weeks.`,
        metrics: { peakHours: fc.hourly.peakHours }, action: 'Schedule extra kitchen and service staff for that hour',
      });
    }
  }

  // 2. Dishes with food cost above the target
  const target = tenant.settings?.intelligence?.foodCostTargetPercent ?? 35;
  for (const p of ov.highFoodCost.filter((x: any) => x.quantity >= 5).slice(0, 3)) {
    out.push({
      rule: 'high_food_cost', subject: p.productId, priority: (p.foodCostPercent ?? 0) > target + 15 ? 'high' : 'medium', confidence: 'high',
      title: `Review the cost of ${p.name}`,
      explanation: `Food cost is ${p.foodCostPercent}% of its revenue (target ${target}%): ${p.quantity} sold for ${cur(p.revenue)} with ingredients costing ${cur(p.foodCost ?? 0)} at today's ingredient prices.`,
      metrics: p, action: 'Check the recipe quantities and supplier prices, or adjust the menu price',
      expectedBenefit: `Bringing it to ${target}% would add about ${cur(Math.round(p.revenue * (((p.foodCostPercent ?? 0) - target) / 100)))} gross profit per month at the current volume`,
      baseline: { metric: 'food_cost_percent', value: p.foodCostPercent, subject: p.productId },
    });
  }

  // 3. Declining dishes
  for (const d of (await decliningProducts(tenant._id, now)).slice(0, 3)) {
    out.push({
      rule: 'declining_product', subject: d.productId, priority: 'medium', confidence: d.previous14Days >= 15 ? 'medium' : 'low',
      title: `${d.name} is selling less`,
      explanation: `${d.last14Days} sold in the last 14 days vs ${d.previous14Days} in the 14 days before (${d.changePercent}%).`,
      metrics: d, action: 'Check availability, quality feedback and price; consider featuring it',
      baseline: { metric: 'product_qty_14d', value: d.last14Days, subject: d.productId },
    });
  }

  // 4. Profitable but under-ordered dishes
  const known = ov.topByProfit.filter((p: any) => p.marginPercent != null);
  if (known.length >= 4) {
    const qtys = ov.topByRevenue.map((p: any) => p.quantity).sort((a: number, b: number) => a - b);
    const lowQ = qtys[Math.floor(qtys.length / 4)] ?? 0;
    for (const p of known.filter((x: any) => (x.marginPercent ?? 0) >= 70 && x.quantity <= lowQ).slice(0, 2)) {
      out.push({
        rule: 'promote_profitable', subject: p.productId, priority: 'low', confidence: 'medium',
        title: `Promote ${p.name}`,
        explanation: `It keeps ${p.marginPercent}% of its price after food cost but sold only ${p.quantity} this month (bottom quarter by volume).`,
        metrics: p, action: 'Mark it featured or include it in a campaign',
        baseline: { metric: 'product_qty_14d', value: null, subject: p.productId },
      });
    }
  }

  // 5. Coupons with deep discounts
  for (const c of ov.discounts.coupons.filter((x: any) => x.orders >= 5 && x.averageDiscountPercent >= 20)) {
    out.push({
      rule: 'reduce_discount', subject: c.code, priority: 'medium', confidence: 'medium',
      title: `Coupon ${c.code} gives away ${c.averageDiscountPercent}%`,
      explanation: `${c.orders} orders used it this month with ${cur(c.discount)} of discounts; its orders average ${cur(c.averageOrderValue)} vs ${ov.discounts.averageOrderValueWithoutCoupon != null ? cur(ov.discounts.averageOrderValueWithoutCoupon) : 'n/a'} without a coupon.`,
      metrics: c, action: 'Lower the value, add a minimum order or a maximum discount',
      baseline: { metric: 'coupon_discount_percent', value: c.averageDiscountPercent, subject: c.code },
    });
  }

  // 6. Cancellations
  if (ov.orders.allOrders >= 20 && ov.orders.cancellationRatePercent >= 8) {
    out.push({
      rule: 'high_cancellations', subject: 'all', priority: ov.orders.cancellationRatePercent >= 15 ? 'high' : 'medium', confidence: 'high',
      title: 'Many orders are cancelled or rejected',
      explanation: `${ov.orders.cancelledOrRejected} of ${ov.orders.allOrders} orders (${ov.orders.cancellationRatePercent}%) this month were cancelled or rejected. Reasons are listed on each order.`,
      metrics: ov.orders, action: 'Review the reasons in Orders (filter: cancelled) and fix the most common cause',
      baseline: { metric: 'cancellation_rate', value: ov.orders.cancellationRatePercent },
    });
  }

  // 7. Win-back
  const seg = await customerCounts(tenant._id);
  const lapsing = (seg.at_risk ?? 0) + (seg.inactive ?? 0);
  if (lapsing >= 10) {
    out.push({
      rule: 'winback', subject: 'customers', priority: 'medium', confidence: 'medium',
      title: `${lapsing} customers have stopped ordering`,
      explanation: `${seg.at_risk ?? 0} at-risk and ${seg.inactive ?? 0} inactive customers (segment rules in Marketing). Only those who agreed to receive messages can be contacted.`,
      metrics: seg, action: 'Create a win-back campaign for the at-risk segment (needs approval before sending)',
      baseline: { metric: 'lapsing_customers', value: lapsing },
    });
  }

  // 8. Delivery lateness
  const del = await deliveryAnalytics(tenant, { period: 'month' });
  if (del.delivered >= 10 && del.onTimeRatePercent != null && del.onTimeRatePercent < 80) {
    out.push({
      rule: 'delivery_late', subject: 'delivery', priority: del.onTimeRatePercent < 60 ? 'high' : 'medium', confidence: 'high',
      title: `Only ${del.onTimeRatePercent}% of deliveries arrive on time`,
      explanation: `${del.late} of ${del.delivered} delivered orders this month arrived after their estimated time. Busiest delivery hours: ${del.peakHours.slice(0, 3).map((h: any) => `${h.hour}:00`).join(', ') || 'n/a'}.`,
      metrics: { onTime: del.onTimeRatePercent, late: del.late, averageDeliveryMinutes: del.averageDeliveryMinutes }, action: 'Add riders in peak hours or raise zone delivery times',
      baseline: { metric: 'on_time_rate', value: del.onTimeRatePercent },
    });
  }

  // 9. Waste
  if (ov.waste.waste.length && ov.waste.wasteCostKnown && ov.waste.wasteCost > 0 && ov.money.netItemRevenue > 0 && (ov.waste.wasteCost / ov.money.netItemRevenue) * 100 >= 3) {
    const pct = Math.round((ov.waste.wasteCost / ov.money.netItemRevenue) * 1000) / 10;
    out.push({
      rule: 'waste', subject: 'stock', priority: pct >= 6 ? 'high' : 'medium', confidence: 'high',
      title: `Waste is ${pct}% of item revenue`,
      explanation: `Recorded wastage cost ${cur(ov.waste.wasteCost)} this month; top items: ${ov.waste.waste.slice(0, 3).map((w: any) => w.name).join(', ')}.`,
      metrics: { items: ov.waste.waste.slice(0, 5) }, action: 'Reduce order quantities for those items or use them in specials',
      baseline: { metric: 'waste_percent', value: pct },
    });
  }

  if (!sufficient) out.forEach((d) => { if (d.confidence === 'high') d.confidence = 'medium'; });
  return out;
}

/** Stores new recommendations; existing ones for the same rule/subject/week are left untouched. */
export async function refreshRecommendations(tenant: ResolvedTenant, now = new Date()) {
  const drafts = await buildRecommendations(tenant, now);
  const week = isoWeek(now);
  let created = 0;
  for (const d of drafts) {
    const r = await Recommendation.updateOne(
      { tenantId: tenant._id, key: `${d.rule}:${d.subject}:${week}` },
      { $setOnInsert: { tenantId: tenant._id, key: `${d.rule}:${d.subject}:${week}`, rule: d.rule, title: d.title, explanation: d.explanation, metrics: d.metrics, expectedBenefit: d.expectedBenefit, priority: d.priority, confidence: d.confidence, action: d.action, baseline: d.baseline, status: 'open' } },
      { upsert: true },
    );
    created += r.upsertedCount;
  }
  return { generated: drafts.length, created };
}

/** Re-measures accepted recommendations 14+ days after the decision. */
export async function evaluateOutcomes(tenant: ResolvedTenant, now = new Date()) {
  const due = await Recommendation.find({ tenantId: tenant._id, status: 'accepted', outcome: { $exists: false }, decidedAt: { $lte: new Date(now.getTime() - 14 * 86400_000) } }).lean();
  for (const r of due) {
    const b: any = r.baseline ?? {};
    let after: number | null = null;
    let measurable = true;
    if (b.metric === 'product_qty_14d' && b.subject) after = await productQty(tenant._id, b.subject, now);
    else if (b.metric === 'cancellation_rate') after = (await businessOverview(tenant, { from: new Date(now.getTime() - 14 * 86400_000).toISOString(), to: now.toISOString() })).orders.cancellationRatePercent;
    else if (b.metric === 'lapsing_customers') { const s = await customerCounts(tenant._id); after = (s.at_risk ?? 0) + (s.inactive ?? 0); }
    else if (b.metric === 'on_time_rate') after = (await deliveryAnalytics(tenant, { from: new Date(now.getTime() - 14 * 86400_000).toISOString(), to: now.toISOString() })).onTimeRatePercent;
    else measurable = false;
    await Recommendation.updateOne({ tenantId: tenant._id, _id: r._id }, { $set: { outcome: { measurable, metric: b.metric, before: b.value ?? null, after, change: measurable && after != null && b.value != null ? Math.round((after - b.value) * 10) / 10 : null, evaluatedAt: now } } });
  }
  return { evaluated: due.length };
}

async function productQty(tenantId: Types.ObjectId, productId: string, now: Date) {
  const [r] = await Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: new Date(now.getTime() - 14 * 86400_000), $lt: now }, status: { $in: SALE_STATUSES } } },
    { $unwind: '$items' },
    { $match: { 'items.productId': new Types.ObjectId(productId), 'items.status': { $ne: 'cancelled' } } }, // aggregation does not cast ids
    { $group: { _id: null, q: { $sum: '$items.quantity' } } },
  ]);
  return r?.q ?? 0;
}
