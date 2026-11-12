/**
 * Demand forecasting — deterministic, explainable statistics on the restaurant's own history.
 *
 * Model ("weekday-seasonal with damped trend"):
 *   prediction(day) = mean(the same weekday over the last K weeks, K ≤ 8) × √(trend)
 *   trend           = sales of the last 28 days ÷ the 28 days before, clipped to [0.7, 1.3]
 *   80 % interval   = prediction ± 1.28 × standard deviation of those same-weekday values
 * Accuracy is measured by a 7-day backtest (each day predicted from data before it) and drives the
 * confidence label. Holidays, weather and local events are NOT modelled (no data source is integrated);
 * promotions are reported as context only. With too little history the forecast says so instead of guessing.
 */
import type { Types } from 'mongoose';
import { Order } from '../models/operations';
import { InventoryItem } from '../models/inventory';
import { Product } from '../models/menu';
import { Forecast } from '../models/growth';
import type { ResolvedTenant } from '../types/express';
import { SALE_STATUSES } from './intelligence';

const DAY = 86400_000;
export const HISTORY_DAYS = 126; // 18 weeks
export const MIN_HISTORY_DAYS: Record<number, number> = { 1: 14, 7: 14, 30: 28, 90: 56 };

/* ---------- pure helpers (unit-testable) ---------- */

export function localDateKey(d: Date, tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function weekdayOfKey(key: string) {
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}
export function addDaysKey(key: string, n: number) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/** Dense daily series from the first day with data up to (not including) `todayKey`; missing days are 0. */
export function denseSeries(map: Map<string, number>, firstKey: string, todayKey: string) {
  const out: { key: string; value: number }[] = [];
  for (let k = firstKey; k < todayKey; k = addDaysKey(k, 1)) out.push({ key: k, value: map.get(k) ?? 0 });
  return out;
}

export function trendFactor(series: { value: number }[]) {
  if (series.length < 56) return 1;
  const last = series.slice(-28).reduce((s, x) => s + x.value, 0);
  const prev = series.slice(-56, -28).reduce((s, x) => s + x.value, 0);
  if (prev <= 0) return 1;
  return Math.min(1.3, Math.max(0.7, last / prev));
}

/** Predicts one future day from a dense history. Returns null when that weekday has fewer than 2 observations. */
export function predictDay(series: { key: string; value: number }[], targetKey: string, trend: number) {
  const wd = weekdayOfKey(targetKey);
  const same = series.filter((x) => weekdayOfKey(x.key) === wd).slice(-8).map((x) => x.value);
  if (same.length < 2) return null;
  const p = mean(same) * Math.sqrt(trend);
  const s = std(same);
  return { predicted: p, low: Math.max(0, p - 1.28 * s), high: p + 1.28 * s, basis: same.length };
}

/** Mean absolute percentage error over the last `days` days (days with zero actuals are skipped). */
export function backtest(series: { key: string; value: number }[], days = 7) {
  const errs: number[] = [];
  for (let i = series.length - days; i < series.length; i++) {
    if (i < 14) continue;
    const hist = series.slice(0, i);
    const pred = predictDay(hist, series[i].key, trendFactor(hist));
    if (!pred || series[i].value === 0) continue;
    errs.push(Math.abs(pred.predicted - series[i].value) / series[i].value);
  }
  return errs.length ? Math.round(mean(errs) * 1000) / 10 : null;
}

export function confidenceFrom(mape: number | null, coverage: number) {
  if (mape == null || coverage < 50) return 'low';
  if (mape <= 15 && coverage >= 80) return 'high';
  if (mape <= 35) return 'medium';
  return 'low';
}

/* ---------- data access ---------- */

async function dailyMap(tenantId: Types.ObjectId, tz: string, since: Date, extra: Record<string, unknown> = {}) {
  const rows = await Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: since }, status: { $in: SALE_STATUSES }, ...extra } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, orders: { $sum: 1 }, sales: { $sum: '$total' } } },
  ]);
  return { orders: new Map<string, number>(rows.map((r) => [r._id, r.orders])), sales: new Map<string, number>(rows.map((r) => [r._id, r.sales])), keys: rows.map((r) => r._id as string).sort() };
}

function forecastSeries(series: { key: string; value: number }[], todayKey: string, horizon: number) {
  const trend = trendFactor(series);
  const days: { date: string; predicted: number; low: number; high: number }[] = [];
  for (let i = 0; i < horizon; i++) {
    const key = addDaysKey(todayKey, i);
    const p = predictDay(series, key, trend);
    if (!p) return null;
    days.push({ date: key, predicted: Math.round(p.predicted), low: Math.round(p.low), high: Math.round(p.high) });
  }
  return { days, trend };
}

/**
 * Full forecast for the next `horizonDays` (1, 7, 30 or 90) starting today in the restaurant's time zone.
 */
export async function computeForecast(tenant: ResolvedTenant, horizonDays: 1 | 7 | 30 | 90, now = new Date()) {
  const tenantId = tenant._id;
  const tz = tenant.settings?.timezone ?? 'UTC';
  const todayKey = localDateKey(now, tz);
  const since = new Date(now.getTime() - HISTORY_DAYS * DAY);
  const all = await dailyMap(tenantId, tz, since);
  const generatedAt = new Date();
  const base = { horizonDays, generatedAt, timezone: tz, method: 'weekday-seasonal mean of up to 8 same weekdays × √(28-day trend), 80 % interval = ±1.28 σ', externalFactors: 'Holidays, weather and local events are not included (no data source is connected).' };
  const firstKey = all.keys.find((k) => k < todayKey);
  if (!firstKey) return { ...base, sufficient: false, reason: 'No sales history yet.', coverage: null };
  const history = denseSeries(all.orders, firstKey, todayKey);
  const daysWithData = history.filter((x) => x.value > 0).length;
  const coverage = { historyDays: history.length, daysWithSales: daysWithData, coveragePercent: Math.round((daysWithData / history.length) * 1000) / 10, from: firstKey, to: addDaysKey(todayKey, -1) };
  const need = MIN_HISTORY_DAYS[horizonDays];
  if (history.length < need) {
    return { ...base, sufficient: false, reason: `A ${horizonDays}-day forecast needs at least ${need} days of history; ${history.length} available.`, coverage };
  }
  const salesSeries = denseSeries(all.sales, firstKey, todayKey);
  const ordersF = forecastSeries(history, todayKey, horizonDays);
  const salesF = forecastSeries(salesSeries, todayKey, horizonDays);
  if (!ordersF || !salesF) return { ...base, sufficient: false, reason: 'Some weekdays have fewer than 2 past observations.', coverage };
  const mape = backtest(salesSeries);
  const confidence = confidenceFrom(mape, coverage.coveragePercent);
  const sum = (a: { predicted: number; low: number; high: number }[]) => ({ predicted: a.reduce((s, x) => s + x.predicted, 0), low: a.reduce((s, x) => s + x.low, 0), high: a.reduce((s, x) => s + x.high, 0) });
  // Historical comparison: the same number of days just before today.
  const prevSales = salesSeries.slice(-horizonDays).reduce((s, x) => s + x.value, 0);
  const prevOrders = history.slice(-horizonDays).reduce((s, x) => s + x.value, 0);
  const promoShare = await promotionShare(tenantId, since);
  const [hourly, products, delivery] = await Promise.all([
    hourlyDemand(tenantId, tz, todayKey, now),
    productDemand(tenantId, tz, todayKey, Math.min(horizonDays, 30), now, firstKey),
    deliveryDemand(tenantId, tz, todayKey, horizonDays, firstKey),
  ]);
  const ingredients = await ingredientDemand(tenantId, products.items, Math.min(horizonDays, 30), tenant.settings?.intelligence?.reorderLeadDays ?? 3);
  return {
    ...base,
    sufficient: true,
    coverage,
    accuracy: { backtestMapePercent: mape, confidence, explanation: mape == null ? 'Not enough recent data to backtest.' : `Over the last 7 days the model was off by ${mape}% on average (each day predicted from earlier data only).` },
    factors: [
      `Day of week: each day uses the average of the same weekday over the last ${Math.min(8, Math.floor(history.length / 7))} weeks.`,
      `Recent trend: last 28 days vs the 28 before = ${ordersF.trend === 1 && history.length < 56 ? 'not applied (needs 8 weeks)' : `${Math.round((salesF.trend - 1) * 100)}%`} (damped by a square root, capped at ±30%).`,
      `Promotions: ${promoShare}% of orders in the history used a coupon; future promotions are not modelled.`,
    ],
    sales: { days: salesF.days, total: sum(salesF.days), previousPeriodActual: prevSales },
    orders: { days: ordersF.days, total: sum(ordersF.days), previousPeriodActual: prevOrders },
    hourly,
    products,
    ingredients,
    delivery,
  };
}

async function promotionShare(tenantId: Types.ObjectId, since: Date) {
  const [all, promo] = await Promise.all([
    Order.countDocuments({ tenantId, createdAt: { $gte: since }, status: { $in: SALE_STATUSES } }),
    Order.countDocuments({ tenantId, createdAt: { $gte: since }, status: { $in: SALE_STATUSES }, couponCode: { $exists: true, $ne: null } }),
  ]);
  return all ? Math.round((promo / all) * 100) : 0;
}

/** Expected orders per hour for the next 24 hours, from the same weekday-and-hour over the last 8 weeks. */
async function hourlyDemand(tenantId: Types.ObjectId, tz: string, todayKey: string, now: Date) {
  const rows = await Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: new Date(now.getTime() - 56 * DAY) }, status: { $in: SALE_STATUSES } } },
    { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, hour: { $hour: { date: '$createdAt', timezone: tz } } }, n: { $sum: 1 } } },
  ]);
  const days = new Set(rows.map((r) => r._id.day));
  const hourNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now)) % 24;
  const out: { date: string; hour: number; predicted: number; low: number; high: number }[] = [];
  for (let i = 0; i < 24; i++) {
    const hour = (hourNow + i) % 24;
    const key = hourNow + i >= 24 ? addDaysKey(todayKey, 1) : todayKey;
    const wd = weekdayOfKey(key);
    const sameDays = [...days].filter((d) => weekdayOfKey(d) === wd && d < todayKey).sort().slice(-8);
    if (sameDays.length < 2) continue;
    const vals = sameDays.map((d) => rows.find((r) => r._id.day === d && r._id.hour === hour)?.n ?? 0);
    const m = mean(vals);
    out.push({ date: key, hour, predicted: Math.round(m * 10) / 10, low: Math.max(0, Math.round((m - 1.28 * std(vals)) * 10) / 10), high: Math.round((m + 1.28 * std(vals)) * 10) / 10 });
  }
  const peaks = [...out].sort((a, b) => b.predicted - a.predicted).slice(0, 3).filter((x) => x.predicted > 0);
  return { next24h: out, peakHours: peaks, note: out.length ? null : 'Not enough history per weekday and hour yet.' };
}

/** Expected quantity per dish (top 25 sellers of the last 8 weeks) for the next `days` days. */
async function productDemand(tenantId: Types.ObjectId, tz: string, todayKey: string, days: number, now: Date, firstSalesKey: string) {
  const rows = await Order.aggregate([
    { $match: { tenantId, createdAt: { $gte: new Date(now.getTime() - 56 * DAY) }, status: { $in: SALE_STATUSES } } },
    { $unwind: '$items' },
    { $match: { 'items.status': { $ne: 'cancelled' } } },
    { $group: { _id: { p: '$items.productId', day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } } }, name: { $first: '$items.name' }, q: { $sum: '$items.quantity' } } },
  ]);
  const byProduct = new Map<string, { name: string; days: Map<string, number> }>();
  for (const r of rows) {
    const k = String(r._id.p);
    const e = byProduct.get(k) ?? { name: r.name, days: new Map() };
    e.days.set(r._id.day, r.q);
    byProduct.set(k, e);
  }
  // Days before the restaurant's first sale are not zero-sales days; they are just missing history.
  const start = [addDaysKey(todayKey, -56), firstSalesKey].sort()[1];
  const totals = [...byProduct.entries()].map(([id, e]) => ({ id, e, sold: [...e.days.values()].reduce((s, x) => s + x, 0) })).sort((a, b) => b.sold - a.sold).slice(0, 25);
  const live = await Product.find({ tenantId, _id: { $in: totals.map((t) => t.id) } }).select('isAvailable isArchived').lean();
  const avail = new Map(live.map((p) => [String(p._id), p.isAvailable && !p.isArchived]));
  const items = totals.map(({ id, e }) => {
    const series = denseSeries(e.days, start, todayKey);
    let predicted = 0;
    let low = 0;
    let high = 0;
    let ok = true;
    for (let i = 0; i < days; i++) {
      const p = predictDay(series, addDaysKey(todayKey, i), 1);
      if (!p) { ok = false; break; }
      predicted += p.predicted;
      low += p.low;
      high += p.high;
    }
    return { productId: id, name: e.name, predicted: ok ? Math.round(predicted) : null, low: ok ? Math.round(low) : null, high: ok ? Math.round(high) : null, last56DaysSold: [...e.days.values()].reduce((s, x) => s + x, 0), currentlyAvailable: avail.get(id) ?? false };
  });
  return { days, items, note: 'Dishes that are currently unavailable are listed but will not sell until re-enabled.' };
}

/** Ingredient needs from the product forecast × recipes, compared with stock on hand. */
async function ingredientDemand(tenantId: Types.ObjectId, products: { productId: string; predicted: number | null; currentlyAvailable: boolean }[], days: number, leadDays: number) {
  const recipes = await Product.find({ tenantId, _id: { $in: products.map((p) => p.productId) } }).select('recipe').lean();
  const need = new Map<string, number>();
  for (const p of products) {
    if (p.predicted == null || !p.currentlyAvailable) continue;
    const rec = recipes.find((r) => String(r._id) === p.productId)?.recipe ?? [];
    for (const r of rec) need.set(String(r.inventoryItemId), (need.get(String(r.inventoryItemId)) ?? 0) + r.quantity * p.predicted);
  }
  const inv = await InventoryItem.find({ tenantId, _id: { $in: [...need.keys()] } }).select('name unit quantity lowStockThreshold').lean();
  const items = inv.map((i) => {
    const total = need.get(String(i._id)) ?? 0;
    const perDay = total / days;
    const cover = perDay > 0 ? Math.round((i.quantity / perDay) * 10) / 10 : null;
    return { inventoryItemId: String(i._id), name: i.name, unit: i.unit, onHand: i.quantity, expectedUse: Math.round(total * 100) / 100, expectedUsePerDay: Math.round(perDay * 100) / 100, daysOfCover: cover, reorderSuggested: cover != null && cover < leadDays, leadDays };
  });
  items.sort((a, b) => (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9));
  return { days, items, basis: 'Forecast dish quantities × each dish’s recipe. Dishes without recipes do not consume tracked stock.' };
}

async function deliveryDemand(tenantId: Types.ObjectId, tz: string, todayKey: string, horizon: number, firstKey: string) {
  const d = await dailyMap(tenantId, tz, new Date(Date.now() - HISTORY_DAYS * DAY), { type: 'delivery' });
  if (!d.keys.length) return { sufficient: false, reason: 'No delivery orders in the history.' };
  const series = denseSeries(d.orders, firstKey, todayKey);
  const f = forecastSeries(series, todayKey, horizon);
  if (!f) return { sufficient: false, reason: 'Not enough delivery history per weekday.' };
  return { sufficient: true, days: f.days, total: f.days.reduce((s, x) => s + x.predicted, 0) };
}

/** Latest stored forecast, recomputed when older than 6 hours (or on demand). */
export async function getForecast(tenant: ResolvedTenant, horizon: 1 | 7 | 30 | 90, opts: { refresh?: boolean } = {}) {
  if (!opts.refresh) {
    const last = await Forecast.findOne({ tenantId: tenant._id, horizonDays: horizon }).sort({ generatedAt: -1 }).lean();
    if (last && Date.now() - new Date(last.generatedAt!).getTime() < 6 * 3600_000) return last.result;
  }
  const result = await computeForecast(tenant, horizon);
  await Forecast.create({ tenantId: tenant._id, horizonDays: horizon, generatedAt: result.generatedAt, result });
  await Forecast.deleteMany({ tenantId: tenant._id, horizonDays: horizon, generatedAt: { $lt: new Date(Date.now() - 7 * DAY) } });
  return result;
}
