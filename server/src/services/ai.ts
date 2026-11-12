/**
 * AI restaurant assistant and marketing-copy helper.
 *
 * Grounding: Claude never sees raw database access. It can only call the read-only tools below; each
 * tool re-checks the signed-in person's permissions and queries ONLY req.tenant's data through the same
 * deterministic services the dashboards use. Tools return aggregates (no customer names, phones or
 * emails) with money already formatted, so the model does not do arithmetic on minor units.
 *
 * Without credentials (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN), or when the provider fails, questions are
 * answered by a built-in, rule-based router over the same tools — and the reply says so.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AiUsage } from '../models/growth';
import { Campaign, Recommendation } from '../models/growth';
import { InventoryItem } from '../models/inventory';
import { roleHas, type Permission } from '../config/permissions';
import type { AuthUser, ResolvedTenant } from '../types/express';
import { financialSummary, topHours } from './analyticsService';
import { businessOverview, customerCounts, productEconomics, rangeFor } from './intelligence';
import { getForecast } from './forecast';
import { campaignReport } from './marketing';
import { deliveryAnalytics } from './delivery';
import { forbidden } from '../lib/errors';

export const AI_MODEL = 'claude-opus-5-5';
// Published list prices for the model above (USD per million tokens), used for the cost ESTIMATE only.
const PRICE_PER_MTOK = { input: 4, output: 20, cacheRead: 0.2 };

/* ---------------- provider abstraction ---------------- */
export interface AiProvider {
  name: string;
  createMessage(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage>;
}

class AnthropicProvider implements AiProvider {
  name = 'anthropic';
  private client = new Anthropic({ timeout: 60_000, maxRetries: 2 }); // credentials from the environment, server-side only
  createMessage(params: Anthropic.Beta.MessageCreateParamsNonStreaming) {
    return this.client.beta.messages.create(params);
  }
}

let override: AiProvider | null | undefined;
/** Tests inject a provider; `null` forces "not configured". */
export function setAiProvider(p: AiProvider | null | undefined) {
  override = p;
}
export function aiProvider(): AiProvider | null {
  if (override !== undefined) return override;
  if (process.env.AI_PROVIDER === 'none') return null;
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new AnthropicProvider() : null;
}
export function aiStatus() {
  const p = aiProvider();
  return { configured: !!p, provider: p?.name ?? null, model: p ? AI_MODEL : null };
}

/* ---------------- tools (read-only, tenant-scoped, permission-checked) ---------------- */
type Ctx = { tenant: ResolvedTenant; user: AuthUser };
const PERIOD = { type: 'string', enum: ['today', 'yesterday', 'week', 'month', 'year'], description: 'today/yesterday = calendar days in the restaurant time zone; week = last 7 days; month = last 30 days; year = last 365 days' };

function money(ctx: Ctx, minor: number | null | undefined) {
  if (minor == null) return null;
  const d = ctx.tenant.settings?.currencyDecimals ?? 2;
  return `${(minor / 10 ** d).toFixed(d)} ${ctx.tenant.settings?.currency ?? ''}`.trim();
}
function localDayStart(tz: string, now: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(now).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - (asUtc - now.getTime()));
}
function periodQuery(ctx: Ctx, period: string) {
  const tz = ctx.tenant.settings?.timezone ?? 'UTC';
  const now = new Date();
  if (period === 'today') return { from: localDayStart(tz, now).toISOString(), to: now.toISOString() };
  if (period === 'yesterday') {
    const start = localDayStart(tz, now);
    return { from: localDayStart(tz, new Date(start.getTime() - 3600_000)).toISOString(), to: start.toISOString() };
  }
  return { period: ['week', 'month', 'year'].includes(period) ? period : 'month' };
}

interface ToolDef {
  perm: Permission[];
  tool: Anthropic.Beta.BetaTool;
  run(ctx: Ctx, input: any): Promise<unknown>;
}
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required, additionalProperties: false });

const TOOLS: Record<string, ToolDef> = {
  sales_summary: {
    perm: ['analytics:view', 'intelligence:view'],
    tool: { name: 'sales_summary', description: 'Sales, order count, average order value, discounts, taxes, refunds and verified collections for a period.', input_schema: obj({ period: PERIOD }, ['period']), strict: true },
    async run(ctx, i) {
      const r = rangeFor(ctx.tenant, periodQuery(ctx, i.period));
      const s = await financialSummary(ctx.tenant._id, r);
      return { period: i.period, from: r.from, to: r.to, orders: s.orders, orderTotals: money(ctx, s.netSales), grossItemSales: money(ctx, s.grossSales), discounts: money(ctx, s.discounts), netItemRevenue: money(ctx, s.grossSales - s.discounts), taxes: money(ctx, s.taxes), averageOrderValue: money(ctx, s.averageOrderValue), verifiedCollections: money(ctx, s.verifiedCollections), refunds: money(ctx, s.refunds), cancelledOrRejectedOrders: s.cancelledOrders, definitions: 'orderTotals include tax, service and delivery fees; netItemRevenue = item sales minus discounts. Sales count confirmed orders only.' };
    },
  },
  top_products: {
    perm: ['analytics:view', 'intelligence:view'],
    tool: { name: 'top_products', description: 'Dishes ranked by revenue, quantity or gross profit for a period, with food cost where recipes have ingredient costs.', input_schema: obj({ period: PERIOD, sort_by: { type: 'string', enum: ['revenue', 'quantity', 'profit'] }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['period', 'sort_by', 'limit']), strict: true },
    async run(ctx, i) {
      const r = rangeFor(ctx.tenant, periodQuery(ctx, i.period));
      const e = await productEconomics(ctx.tenant._id, r);
      const key = i.sort_by === 'profit' ? 'grossProfit' : i.sort_by;
      const rows = e.products.filter((p: any) => (i.sort_by === 'profit' ? p.grossProfit != null : true)).sort((a: any, b: any) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, i.limit);
      return { period: i.period, costCoveragePercent: e.costCoveragePercent, note: i.sort_by === 'profit' ? 'Only dishes with complete recipe costs have a profit; costs use today’s ingredient prices; labour and overheads are excluded.' : undefined, dishes: rows.map((p: any) => ({ name: p.name, quantity: p.quantity, revenue: money(ctx, p.revenue), foodCost: money(ctx, p.foodCost), grossProfit: money(ctx, p.grossProfit), marginPercent: p.marginPercent, costUnknownReason: p.costUnknownReason })) };
    },
  },
  profitability: {
    perm: ['intelligence:view'],
    tool: { name: 'profitability', description: 'Revenue, food cost, gross profit and margin for a period, with highest food-cost dishes and data coverage.', input_schema: obj({ period: PERIOD }, ['period']), strict: true },
    async run(ctx, i) {
      const o = await businessOverview(ctx.tenant, periodQuery(ctx, i.period));
      return { period: i.period, netItemRevenue: money(ctx, o.money.netItemRevenue), foodCost: money(ctx, o.money.foodCost), grossProfit: money(ctx, o.money.grossProfit), grossMarginPercent: o.money.grossMarginPercent, basis: o.money.profitBasis, highFoodCostDishes: o.highFoodCost.slice(0, 5).map((p: any) => ({ name: p.name, foodCostPercent: p.foodCostPercent, revenue: money(ctx, p.revenue) })), waste: { cost: money(ctx, o.waste.wasteCost), complete: o.waste.wasteCostKnown, topItems: o.waste.waste.slice(0, 3).map((w: any) => w.name) }, dataQuality: o.dataQuality };
    },
  },
  sales_change: {
    perm: ['intelligence:view'],
    tool: { name: 'sales_change', description: 'Compares a period with the period of equal length before it: orders, sales, average order value, cancellations, declining dishes and day-of-week pattern. Use for "why did sales change".', input_schema: obj({ period: { type: 'string', enum: ['week', 'month'] } }, ['period']), strict: true },
    async run(ctx, i) {
      const o = await businessOverview(ctx.tenant, { period: i.period });
      const prev = rangeFor(ctx.tenant, { period: i.period });
      const len = prev.to.getTime() - prev.from.getTime();
      const before = await financialSummary(ctx.tenant._id, { from: new Date(prev.from.getTime() - len), to: prev.from, tz: prev.tz });
      return { period: i.period, now: { orders: o.orders.count, sales: money(ctx, o.money.orderTotals), averageOrderValue: money(ctx, o.orders.averageOrderValue), cancellationRatePercent: o.orders.cancellationRatePercent }, before: { orders: before.orders, sales: money(ctx, before.netSales), averageOrderValue: money(ctx, before.averageOrderValue) }, change: o.comparison, decliningDishes: o.declining.slice(0, 5), dayOfWeek: o.dayOfWeek.map((d: any) => ({ day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.dayOfWeek], orders: d.orders, averageSales: money(ctx, d.averageSales) })), dataQuality: o.dataQuality, note: 'These are correlations in the restaurant’s own data; external causes (weather, events, competitors) are not known to the system.' };
    },
  },
  forecast: {
    perm: ['intelligence:view'],
    tool: { name: 'forecast', description: 'Statistical forecast of sales, orders and peak hours for the next 1, 7 or 30 days, with an 80% range, confidence and data coverage.', input_schema: obj({ horizon_days: { type: 'integer', enum: [1, 7, 30] } }, ['horizon_days']), strict: true },
    async run(ctx, i) {
      const f: any = await getForecast(ctx.tenant, i.horizon_days);
      if (!f.sufficient) return { sufficient: false, reason: f.reason, coverage: f.coverage };
      return { sufficient: true, horizonDays: i.horizon_days, generatedAt: f.generatedAt, sales: { predicted: money(ctx, f.sales.total.predicted), range80: [money(ctx, f.sales.total.low), money(ctx, f.sales.total.high)], previousPeriodActual: money(ctx, f.sales.previousPeriodActual) }, orders: { predicted: f.orders.total.predicted, range80: [f.orders.total.low, f.orders.total.high] }, peakHours: f.hourly.peakHours, confidence: f.accuracy.confidence, accuracy: f.accuracy.explanation, coverage: f.coverage, method: f.method, limits: f.externalFactors };
    },
  },
  ingredient_needs: {
    perm: ['inventory:view', 'intelligence:view'],
    tool: { name: 'ingredient_needs', description: 'Ingredients that may run out (forecast use vs stock on hand) and items already below their low-stock threshold.', input_schema: obj({ horizon_days: { type: 'integer', enum: [1, 7] } }, ['horizon_days']), strict: true },
    async run(ctx, i) {
      const [f, low]: any = await Promise.all([getForecast(ctx.tenant, i.horizon_days), InventoryItem.find({ tenantId: ctx.tenant._id, isActive: true, $expr: { $and: [{ $gt: ['$lowStockThreshold', 0] }, { $lte: ['$quantity', '$lowStockThreshold'] }] } }).select('name unit quantity lowStockThreshold').lean()]);
      return { forecastAvailable: !!f.sufficient, reason: f.sufficient ? undefined : f.reason, expectedUse: f.sufficient ? f.ingredients.items.slice(0, 15) : [], belowThreshold: low.map((x: any) => ({ name: x.name, onHand: x.quantity, unit: x.unit, threshold: x.lowStockThreshold })), basis: f.sufficient ? f.ingredients.basis : undefined };
    },
  },
  busiest_hours: {
    perm: ['analytics:view', 'intelligence:view'],
    tool: { name: 'busiest_hours', description: 'Orders by hour of day for a period (restaurant time zone).', input_schema: obj({ period: PERIOD }, ['period']), strict: true },
    async run(ctx, i) {
      const r = rangeFor(ctx.tenant, periodQuery(ctx, i.period));
      const h = await topHours(ctx.tenant._id, r);
      return { period: i.period, timezone: r.tz, hours: [...h].sort((a, b) => b.orders - a.orders).slice(0, 6).map((x) => ({ hour: `${String(x._id).padStart(2, '0')}:00`, orders: x.orders, sales: money(ctx, x.sales) })) };
    },
  },
  customer_retention: {
    perm: ['intelligence:view'],
    tool: { name: 'customer_retention', description: 'New vs returning customers, retention from the previous period and segment counts (no personal data).', input_schema: obj({ period: PERIOD }, ['period']), strict: true },
    async run(ctx, i) {
      const o = await businessOverview(ctx.tenant, periodQuery(ctx, i.period));
      return { period: i.period, ...o.customers, segments: await customerCounts(ctx.tenant._id) };
    },
  },
  campaign_performance: {
    perm: ['marketing:manage'],
    tool: { name: 'campaign_performance', description: 'Results of recent marketing campaigns: messages sent/delivered, verified coupon redemptions and revenue, and separately estimated influenced revenue.', input_schema: obj({ limit: { type: 'integer', minimum: 1, maximum: 10 } }, ['limit']), strict: true },
    async run(ctx, i) {
      const cs = await Campaign.find({ tenantId: ctx.tenant._id, status: { $in: ['running', 'completed', 'paused'] } }).sort({ startedAt: -1 }).limit(i.limit).select('_id').lean();
      const reps = await Promise.all(cs.map((c) => campaignReport(ctx.tenant, String(c._id))));
      return { campaigns: reps.map((r) => ({ name: r.campaign.name, status: r.campaign.status, channel: r.campaign.channel, messages: r.messages, verifiedRedemptions: r.verified.couponRedemptions, verifiedRevenue: money(ctx, r.verified.revenue), conversionRatePercent: r.verified.conversionRatePercent, estimatedInfluencedRevenue: money(ctx, r.estimated.influencedRevenue), estimatedCost: money(ctx, r.estimatedCost) })), note: 'Verified = orders that used the campaign coupon. Influenced = an estimate (orders within the attribution window), not proof.' };
    },
  },
  recommendations: {
    perm: ['intelligence:view'],
    tool: { name: 'recommendations', description: 'Open, data-backed recommendations with their supporting numbers.', input_schema: obj({ limit: { type: 'integer', minimum: 1, maximum: 10 } }, ['limit']), strict: true },
    async run(ctx, i) {
      const rs = await Recommendation.find({ tenantId: ctx.tenant._id, status: 'open' }).sort({ createdAt: -1 }).limit(i.limit).lean();
      return { recommendations: rs.map((r) => ({ title: r.title, priority: r.priority, confidence: r.confidence, explanation: r.explanation, action: r.action, expectedBenefit: r.expectedBenefit })) };
    },
  },
  delivery_performance: {
    perm: ['delivery:dispatch', 'intelligence:view'],
    tool: { name: 'delivery_performance', description: 'Delivery counts, average delivery time, on-time rate, failures and busiest delivery hours.', input_schema: obj({ period: PERIOD }, ['period']), strict: true },
    async run(ctx, i) {
      const d = await deliveryAnalytics(ctx.tenant, periodQuery(ctx, i.period));
      return { period: i.period, total: d.total, delivered: d.delivered, failed: d.failed, onTimeRatePercent: d.onTimeRatePercent, averageDeliveryMinutes: d.averageDeliveryMinutes, averageTotalMinutes: d.averageTotalMinutes, feesCollected: money(ctx, d.feesCollected), peakHours: d.peakHours.slice(0, 3), basis: d.basis };
    },
  },
};

const allowed = (ctx: Ctx, name: string) => TOOLS[name] && TOOLS[name].perm.some((p) => roleHas(ctx.user.role, p, ctx.user.permissionOverrides));
export function toolsFor(ctx: Ctx) {
  return Object.keys(TOOLS).filter((n) => allowed(ctx, n));
}
export async function runTool(ctx: Ctx, name: string, input: unknown) {
  if (!allowed(ctx, name)) throw forbidden(`Not allowed to use ${name}`);
  return TOOLS[name].run(ctx, input ?? {});
}

const SYSTEM = `You are the analytics assistant inside TableSaaS, a restaurant management system, answering questions from restaurant staff.
Rules:
- Answer ONLY from the results of the tools you call. Never invent or estimate numbers that no tool returned. If the tools cannot answer, say what data is missing.
- Always state the time period and the figures you used, and say briefly how they were calculated (using the tool's definitions and basis notes).
- Revenue is not profit. Use "gross profit" only when the profitability or top_products tool returns it, and mention its coverage.
- Forecasts are statistical estimates: give the range and confidence the tool returned.
- You cannot change anything (prices, stock, discounts, orders, campaigns, settings). If an action would help, describe it and tell the user where to do it in the dashboard.
- Keep answers short: a direct answer first, then 2–5 bullet points of supporting numbers. Reply in the language of the question.`;

export interface AssistantReply {
  answer: string;
  mode: 'ai' | 'built-in';
  provider?: string;
  model?: string;
  toolsUsed: { name: string; input: unknown }[];
  notice?: string;
}

async function logUsage(ctx: Ctx, purpose: string, m: Anthropic.Beta.BetaMessage | null, provider: string, error?: string) {
  const u: any = m?.usage ?? {};
  const cost = m && m.model === AI_MODEL ? ((u.input_tokens ?? 0) * PRICE_PER_MTOK.input + (u.output_tokens ?? 0) * PRICE_PER_MTOK.output + (u.cache_read_input_tokens ?? 0) * PRICE_PER_MTOK.cacheRead) / 1e6 : null;
  await AiUsage.create({ tenantId: ctx.tenant._id, userId: ctx.user.id, provider, model: m?.model, inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens, estimatedCostUsd: cost, ok: !error, error, purpose }).catch(() => undefined);
}

function providerError(e: unknown) {
  if (e instanceof Anthropic.RateLimitError) return 'The AI service is busy (rate limited). Try again in a minute.';
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return 'The AI service credentials were rejected. Check the server configuration.';
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'The AI service timed out.';
  if (e instanceof Anthropic.APIConnectionError) return 'The AI service could not be reached.';
  if (e instanceof Anthropic.APIError) return `The AI service returned an error (${e.status}).`;
  return 'The AI service failed.';
}

/** Answers a question with Claude + tools; falls back to the built-in router when unavailable. */
export async function askAssistant(ctx: Ctx, question: string, history: { role: 'user' | 'assistant'; content: string }[] = []): Promise<AssistantReply> {
  const provider = aiProvider();
  if (!provider) return { ...(await builtInAnswer(ctx, question)), notice: 'AI is not configured on this server; answered with the built-in reports.' };
  const names = toolsFor(ctx);
  if (!names.length) return { answer: 'Your role does not give access to any business data.', mode: 'built-in', toolsUsed: [] };
  const tools = names.map((n) => TOOLS[n].tool);
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history.slice(-6).map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: question }];
  const used: { name: string; input: unknown }[] = [];
  let last: Anthropic.Beta.BetaMessage | null = null;
  try {
    for (let turn = 0; turn < 6; turn++) {
      last = await provider.createMessage({
        model: AI_MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: SYSTEM,
        tools,
        messages,
      });
      await logUsage(ctx, 'assistant', last, provider.name);
      if (last.stop_reason === 'refusal') return { answer: 'The AI declined to answer this question.', mode: 'ai', provider: provider.name, model: last.model, toolsUsed: used };
      if (last.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: last.content });
        continue;
      }
      const calls = last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (last.stop_reason !== 'tool_use' || !calls.length) {
        const text = last.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
        return { answer: text || 'No answer was produced.', mode: 'ai', provider: provider.name, model: last.model, toolsUsed: used, notice: last.stop_reason === 'max_tokens' ? 'The answer was cut short.' : undefined };
      }
      messages.push({ role: 'assistant', content: last.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        used.push({ name: call.name, input: call.input });
        try {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(await runTool(ctx, call.name, call.input)) });
        } catch (e: any) {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: `Error: ${e?.message ?? 'tool failed'}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return { answer: 'The question needed too many steps; please ask something more specific.', mode: 'ai', provider: provider.name, model: last?.model, toolsUsed: used };
  } catch (e) {
    const msg = providerError(e);
    await logUsage(ctx, 'assistant', null, provider.name, msg);
    return { ...(await builtInAnswer(ctx, question)), notice: `${msg} Answered with the built-in reports instead.` };
  }
}

/* ---------------- built-in (no AI) ---------------- */
const INTENTS: { test: RegExp; tool: string; input: (q: string) => any; render: (ctx: Ctx, r: any) => string }[] = [
  { test: /(reorder|run out|ingredient|stock)/i, tool: 'ingredient_needs', input: (q) => ({ horizon_days: /tomorrow|24/i.test(q) ? 1 : 7 }), render: (_c, r) => (r.forecastAvailable ? `Ingredients to watch (next days): ${r.expectedUse.filter((x: any) => x.reorderSuggested).map((x: any) => `${x.name} (${x.daysOfCover} days of cover)`).join(', ') || 'none below your lead time'}.` : `Forecast not available: ${r.reason}.`) + (r.belowThreshold.length ? ` Below threshold now: ${r.belowThreshold.map((x: any) => `${x.name} ${x.onHand} ${x.unit}`).join(', ')}.` : '') },
  { test: /(forecast|predict|expect|tomorrow|next week)/i, tool: 'forecast', input: (q) => ({ horizon_days: /week/i.test(q) ? 7 : /month/i.test(q) ? 30 : 1 }), render: (_c, r) => (r.sufficient ? `Forecast for the next ${r.horizonDays} day(s): sales ${r.sales.predicted} (80% range ${r.sales.range80.join('–')}), about ${r.orders.predicted} orders. Confidence: ${r.confidence}. ${r.accuracy}` : `Not enough history for a forecast: ${r.reason}`) },
  { test: /(profit|margin|food cost)/i, tool: 'top_products', input: (q) => ({ period: /today/i.test(q) ? 'today' : /month/i.test(q) ? 'month' : 'week', sort_by: 'profit', limit: 5 }), render: (_c, r) => (r.dishes.length ? `Highest gross profit (${r.period}): ${r.dishes.map((d: any) => `${d.name} ${d.grossProfit} (${d.marginPercent}% margin)`).join('; ')}. Cost data covers ${r.costCoveragePercent}% of revenue; costs use today’s ingredient prices.` : 'No dish has complete recipe costs yet, so profit cannot be calculated. Add recipes with ingredient costs in Menu and Inventory.') },
  { test: /(best|top|popular|selling)/i, tool: 'top_products', input: (q) => ({ period: /today/i.test(q) ? 'today' : /month/i.test(q) ? 'month' : 'week', sort_by: /quantit|count|most ordered/i.test(q) ? 'quantity' : 'revenue', limit: 5 }), render: (_c, r) => `Top dishes (${r.period}): ${r.dishes.map((d: any) => `${d.name} – ${d.quantity} sold, ${d.revenue}`).join('; ') || 'no sales yet'}.` },
  { test: /(busy|busiest|peak|hour)/i, tool: 'busiest_hours', input: () => ({ period: 'month' }), render: (_c, r) => `Busiest hours over the last 30 days (${r.timezone}): ${r.hours.map((h: any) => `${h.hour} (${h.orders} orders)`).join(', ') || 'no data'}.` },
  { test: /(return|retention|repeat|loyal|customers)/i, tool: 'customer_retention', input: () => ({ period: 'month' }), render: (_c, r) => `Last 30 days: ${r.identifiedCustomers} identified customers, ${r.returningCustomers} returning and ${r.newCustomers} new.${r.retentionPercent != null ? ` ${r.retentionPercent}% of the previous period's customers came back.` : ''} ${r.note}` },
  { test: /(campaign|marketing)/i, tool: 'campaign_performance', input: () => ({ limit: 5 }), render: (_c, r) => (r.campaigns.length ? r.campaigns.map((c: any) => `${c.name}: ${c.messages.sentAcceptedByProvider} sent, ${c.verifiedRedemptions} coupon orders (${c.verifiedRevenue})`).join('; ') + `. ${r.note}` : 'No campaign has run yet.') },
  { test: /(why|decline|drop|fell|change)/i, tool: 'sales_change', input: (q) => ({ period: /week/i.test(q) ? 'week' : 'month' }), render: (_c, r) => `Last ${r.period}: ${r.now.orders} orders / ${r.now.sales} vs ${r.before.orders} / ${r.before.sales} before. Average order ${r.now.averageOrderValue} vs ${r.before.averageOrderValue}; cancellations ${r.now.cancellationRatePercent}%. ${r.decliningDishes.length ? `Dishes selling less: ${r.decliningDishes.map((d: any) => d.name).join(', ')}.` : ''} ${r.note}` },
  { test: /(improve|recommend|action|should i)/i, tool: 'recommendations', input: () => ({ limit: 5 }), render: (_c, r) => (r.recommendations.length ? r.recommendations.map((x: any) => `• ${x.title}: ${x.action}`).join('\n') : 'No open recommendations. They are generated daily from your data.') },
  { test: /(deliver|rider)/i, tool: 'delivery_performance', input: () => ({ period: 'month' }), render: (_c, r) => `Last 30 days: ${r.delivered} of ${r.total} deliveries completed, ${r.onTimeRatePercent ?? 'n/a'}% on time, average ${r.averageDeliveryMinutes ?? 'n/a'} min from pickup.` },
  { test: /(sell|sale|revenue|earn|made|today|yesterday|week|month)/i, tool: 'sales_summary', input: (q) => ({ period: /yesterday/i.test(q) ? 'yesterday' : /today/i.test(q) ? 'today' : /year/i.test(q) ? 'year' : /month/i.test(q) ? 'month' : /week/i.test(q) ? 'week' : 'today' }), render: (_c, r) => `${r.period[0].toUpperCase()}${r.period.slice(1)}: ${r.orders} orders, ${r.orderTotals} billed (incl. tax/service), net item revenue ${r.netItemRevenue}, average order ${r.averageOrderValue}. Verified payments ${r.verifiedCollections}.` },
];

async function builtInAnswer(ctx: Ctx, question: string): Promise<AssistantReply> {
  for (const it of INTENTS) {
    if (!it.test.test(question)) continue;
    if (!allowed(ctx, it.tool)) return { answer: 'Your role does not have access to that information.', mode: 'built-in', toolsUsed: [] };
    const input = it.input(question);
    const r = await runTool(ctx, it.tool, input);
    return { answer: it.render(ctx, r), mode: 'built-in', toolsUsed: [{ name: it.tool, input }] };
  }
  return { answer: 'I can answer questions about sales, best sellers, profit, forecasts, ingredients to reorder, busy hours, returning customers, campaigns, deliveries and recommendations.', mode: 'built-in', toolsUsed: [] };
}

/** Marketing copy draft (no customer data is sent). Always returned as a DRAFT that needs approval. */
export async function draftMarketingCopy(ctx: Ctx, req: { goal: string; channel: 'sms' | 'whatsapp' | 'email'; offer?: string; tone?: string; language?: string }) {
  const provider = aiProvider();
  if (!provider) return { available: false, reason: 'AI is not configured on this server. Write the message yourself.' };
  const limit = req.channel === 'email' ? 'up to 120 words' : 'under 300 characters';
  const prompt = `Write one ${req.channel} marketing message for the restaurant "${ctx.tenant.name}". Goal: ${req.goal}. ${req.offer ? `Offer: ${req.offer}.` : 'No discount.'} Tone: ${req.tone ?? 'warm and concise'}. Language: ${req.language ?? 'English'}. Length: ${limit}. You may use the placeholders {{name}} (customer first name) and {{coupon}} (coupon code, only if there is an offer). Do not invent prices, dates or offers not given here. Do not add an opt-out line (it is added automatically). Reply with the message text only.`;
  try {
    const m = await provider.createMessage({ model: AI_MODEL, max_tokens: 2000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low' }, messages: [{ role: 'user', content: prompt }] });
    await logUsage(ctx, 'marketing_copy', m, provider.name);
    if (m.stop_reason === 'refusal') return { available: true, text: null, reason: 'The AI declined this request.' };
    const text = m.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { available: true, text, aiGenerated: true, note: 'AI draft: review and edit it. It is only sent after a person approves the campaign.' };
  } catch (e) {
    const msg = providerError(e);
    await logUsage(ctx, 'marketing_copy', null, provider.name, msg);
    return { available: false, reason: msg };
  }
}
