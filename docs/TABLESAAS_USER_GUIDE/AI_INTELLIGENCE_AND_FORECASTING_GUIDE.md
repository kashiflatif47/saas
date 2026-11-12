# AI Intelligence & Forecasting Guide

**For:** restaurant owners, admins and managers. **Where:** Dashboard → **Intelligence** (permission `intelligence:view`).

Everything on this page is calculated from your own orders, recipes, stock and deliveries. When there is not enough data, the page says so ("Not enough history…", "No dish has a complete recipe cost") instead of showing a number.

---

## 1. Overview tab

| Figure | What it is | What it is **not** |
|---|---|---|
| **Gross item sales** | Dish prices × quantities for confirmed orders | — |
| **Discounts** | Item, coupon and manual discounts | — |
| **Net item revenue** | Gross item sales − discounts | Not profit; excludes tax, service and delivery fees |
| **Order totals** | What customers were billed (includes tax, service charge, delivery fee) | Not revenue |
| **Verified collections** | Payments recorded as received | — |
| **Food cost** | Quantity sold × recipe × each ingredient's *current* cost per unit | Only for dishes whose every recipe ingredient has a cost |
| **Gross profit / margin** | Net item revenue − food cost, for those same dishes | Labour, rent, utilities and packaging are **not** included |

The line under the figures states the **cost coverage** (the share of revenue from dishes with complete recipe costs). If coverage is 40 %, the profit figure describes only that 40 %.

Other cards: daily order totals, busiest hours, top dishes by revenue and by gross profit, high food-cost dishes (above your target, default 35 %), dishes selling less (last 14 days vs the 14 before, at least a 30 % drop and 5 sold before), customer counts (new / returning / retention), and waste cost. Trends and comparisons are only shown when the period has at least 20 sales orders.

"Sales" always means confirmed orders: accepted, preparing, ready, served/dispatched, completed, refunded. Pending, rejected and cancelled orders are excluded.

## 2. Forecast tab

Choose **24 hours, 7, 30 or 90 days**.

**Method** (deterministic, no AI model): for each future day, the average of the same weekday over the last up-to-8 weeks, multiplied by the square root of the recent trend (last 28 days vs the 28 before, limited to ±30 %, only applied with 8 weeks of history). The **80 % range** is ±1.28 standard deviations of those same weekdays.

**Minimum history** (days since your first sale): 24 h → 14 days, 7 days → 14, 30 days → 28, 90 days → 56. With less history the forecast is refused and the reason is shown.

Each forecast shows:
- expected order totals and orders, each with its 80 % range;
- **the same period before** (actual figures) for comparison;
- **confidence** (high / medium / low), based on a back-test: the model predicts each of the last 7 days using only earlier data, and the average error is shown;
- **coverage**: number of history days and the share of days with sales;
- **factors**: weekday pattern, trend, and the share of orders that used a coupon;
- dishes expected to sell (top 25), with a warning when a dish is currently unavailable;
- **ingredients**: expected use = dish forecast × recipe, compared with stock on hand, days of cover, and "reorder" when cover is below your lead time (Settings default 3 days);
- for 24 h: expected orders per hour;
- when it was generated. Forecasts are refreshed nightly (from 02:00 restaurant time) and cached for 6 hours; **Recalculate** forces a refresh.

**Not included:** holidays, weather, local events, competitors, marketing you have not run yet. The page says so on every forecast.

## 3. Recommendations tab

Generated daily (and with **Check now**) from rules over your data. Each one shows a title, explanation with the numbers behind it, priority, confidence, expected benefit and the next action. Rules:

| Rule | Triggered when (last 30 days unless stated) |
|---|---|
| Reorder an ingredient | 7-day forecast use leaves less cover than your lead time |
| Staff a busy hour | An hour in the next 24 h is expected to have ≥ 5 orders |
| High food cost | A dish's food cost % is above your target (high priority when 15 points above) |
| Declining dish | Sold ≥ 30 % less in the last 14 days than the 14 before (≥ 5 sold before) |
| Promote a profitable dish | At least 4 dishes have costs; a dish keeps ≥ 70 % after food cost and is in the bottom quarter by quantity |
| Reduce discounting | A coupon was used on ≥ 5 orders with an average discount ≥ 20 % |
| Cancellations | ≥ 20 orders and ≥ 8 % cancelled or rejected |
| Win back customers | ≥ 10 customers in the at-risk or inactive segments |
| Late deliveries | ≥ 10 deliveries and an on-time rate below 80 % |
| Waste | Waste cost (fully costed) is ≥ 3 % of net item revenue |

**Accept, Reject or Dismiss** each one (with an optional note). The same recommendation is not repeated in the same week. For accepted recommendations with a measurable metric (dish quantity, cancellation rate, lapsing customers, delivery on-time rate) the result 14 days later is recorded as **before vs after**. This is a comparison, not proof that the action caused the change.

## 4. Assistant tab

Ask questions in plain language ("Which dishes made the most profit last week?", "What should I reorder?", "Why did sales drop this month?").

- **Read-only.** The assistant can only call report tools (sales summary, top dishes, profitability, sales change, forecast, ingredient needs, busiest hours, retention, campaign results, recommendations, delivery performance). It cannot change prices, stock, orders, campaigns or settings.
- **Scoped to you.** Tools are filtered by your role's permissions, and every tool reads only your restaurant's data. Customer names and phone numbers are never sent to the AI; tools return totals.
- **Shows its working.** Each answer lists the tools used. The AI is instructed to answer only from tool results and to state periods and bases.
- **Two modes.**
  - *AI* — when the server operator set `ANTHROPIC_API_KEY`. Model: Claude Opus 5.5 (`claude-opus-5-5`), with server-side fallback, a 60-second timeout and 2 retries.
  - *Built-in* — no AI key, or the AI service failed. Common questions are answered from the same reports by fixed rules, and a notice explains why.
- Limited to 20 questions per minute per user.
- **Usage and cost** (owner/admin, `settings:manage`): API → `GET /api/staff/intelligence/ai-usage` shows calls, tokens and an estimated cost for 30 days. The estimate uses published prices ($4 / $20 per million input/output tokens); your Anthropic invoice is authoritative.

The API key lives only in the server environment; it is never sent to browsers or stored in the database. With `AI_PROVIDER=none` the AI is switched off.

## 5. Background jobs tab

Shows this restaurant's scheduled work: segment recalculation, forecasts and recommendations (nightly), automation checks (hourly), delivery delay checks (every 2 minutes), campaign starts, message dispatch and rider accept timeouts. Each job lists its status, attempts and last error. Jobs are stored in the database, so they survive restarts. A job interrupted by a crash is picked up again after its 5-minute lease expires. Unique keys stop duplicates when several servers run at once.

## 6. Settings

`PATCH /api/staff/intelligence/settings` (owner/admin): `foodCostTargetPercent` (default 35) and `reorderLeadDays` (default 3).

## 7. Getting better numbers

1. Add **recipes** to dishes (Menu → dish → Recipe) and a **cost per unit** to each inventory item. Profit and ingredient forecasts depend on them.
2. Record **wastage** in Inventory.
3. Take customers' phone numbers at checkout to link orders to customers (retention, segments).
4. Keep orders flowing through the system for at least 2 weeks before relying on forecasts. 8 weeks gives the trend adjustment and 90-day forecasts.
