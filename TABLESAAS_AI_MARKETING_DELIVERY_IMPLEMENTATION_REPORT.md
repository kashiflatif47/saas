# TableSaaS: AI Intelligence, Forecasting, Marketing and Delivery Automation — Implementation Report

**Scope:** local implementation only. Nothing was deployed. MongoDB Atlas was not accessed. DNS, hosting and payment credentials were not touched. No real messages were sent and no money was spent. Every test and browser check ran against in-memory MongoDB.

## 1. Summary

| Area | Status | Real or simulated |
|---|---|---|
| Business intelligence (revenue vs profit, food cost, margins, trends) | **Built** | Real: your own order, recipe and stock data |
| Demand forecasting (24 h / 7 / 30 / 90 days) | **Built** | Real: a deterministic statistical model with a back-test; no AI, no invented numbers |
| Recommendations with accept/reject/dismiss and 14-day outcome tracking | **Built** | Real rules over your data; outcomes are before/after comparisons, not proof of cause |
| AI business assistant | **Built** | Real Claude integration (official SDK), **active only when `ANTHROPIC_API_KEY` is set**. Not exercised against the live API here (no key; tests use a stub provider). Without a key it answers from built-in reports. |
| AI marketing copy drafts | **Built** | Same as above; drafts always need approval |
| Customer segmentation (10 explainable segments, configurable rules) | **Built** | Real |
| Consent, opt-out link, suppression list | **Built** | Real |
| Campaigns (CRUD, approval, schedule, pause/resume/cancel, budget, preview, test send, reports) | **Built** | Real logic. Provider calls are **real code paths for Twilio/SendGrid but untested against live providers** (no credentials; tests stub `fetch`). |
| Automations (joined, first/second order, inactive, birthday, order count, spend) | **Built** | Real |
| SMS / WhatsApp (Twilio) and email (SendGrid) | **Integrated, credentials needed** | Not verified live. WhatsApp free text outside a 24 h session may be rejected by WhatsApp (templates are needed); template management is not built. |
| Push notifications | **Not implemented** | Stated in the UI and docs |
| Delivery zones, auto/manual assignment, accept timeouts, rider app, proof code, status tracking, delay alerts, analytics | **Built** | Real. Tracking is status-based. Distances are straight-line and used only with fresh shared locations. Travel time = the zone minutes you enter. |
| Persistent job queue (restart-safe, idempotent, leased, tenant-scoped) | **Built** | Real; replaces nothing (the existing subscription timer is unchanged) |
| Owner dashboard (Intelligence page + summary) | **Built** | Real |

## 2. Audit and gap analysis

**Present before this work, and reused rather than duplicated:**
- analytics service (`financialSummary`, `parseRange`, `topHours`);
- inventory, recipes and `costPerUnit`; stock movements (wastage);
- customers and coupons;
- notifications (bell), Socket.IO rooms, the encrypted credential pattern (`encryptSecret`);
- the order state machine and the existing delivery fields (address, fee);
- the tenant-scope plugin.

**Missing:** any AI provider, forecasting, recommendations, segmentation, consent records, messaging providers, campaigns, delivery dispatch/riders/zones, and a persistent scheduler (the only background job was an in-memory hourly timer).

## 3. What was built

### Server
- **Models** (`src/models/growth.ts`): `Job`, `Forecast`, `Recommendation`, `AiUsage`, `Campaign`, `Journey`, `MessageLog`, `Suppression`, `DeliveryZone`.
- **Extended models:**
  - `Order.delivery`: zone, location, sub-status, rider, timestamps, code, proof, attempts;
  - `Coupon`: product/category/customer restrictions, `campaignId`;
  - `Customer`: consent per channel, birthday, segments, stats;
  - `User.riderProfile`;
  - tenant settings: marketing, delivery, intelligence, segment rules, encrypted messaging credentials.
- **Permissions:**
  - new: `intelligence:view`, `marketing:manage`, `marketing:approve`, `delivery:dispatch`, `delivery:manage`, `delivery:ride`;
  - new **rider** role, holding only `delivery:ride` and `notifications:view`;
  - owner and admin do not get `delivery:ride`.
- **Services:**
  - `intelligence.ts`, `forecast.ts`, `recommendations.ts`, `segments.ts`;
  - `ai.ts`: provider abstraction, Claude via `@anthropic-ai/sdk`, model `claude-opus-5-5`, read-only permission-checked tools, a manual tool loop, usage/cost logging, built-in fallback;
  - `messaging.ts`: Twilio and SendGrid over `fetch`, signature verification, E.164;
  - `marketing.ts`, `delivery.ts`.
- **Jobs** (`src/jobs/queue.ts`, `handlers.ts`):
  - the queue: atomic claim with a 5-minute lease, unique keys, backoff, maximum attempts;
  - the recurring scheduler, idempotent per tenant per day or hour: segments → forecasts → recommendations nightly, automations hourly, delay checks every 2 minutes, a dispatch safety net, cleanup/retention;
  - started from `server.ts` and stopped on shutdown.
- **Routes:**
  - `src/routes/growth.ts`: `/api/staff/intelligence/*`, `/api/staff/marketing/*`, `/api/staff/delivery/*`;
  - `POST /api/webhooks/twilio/:tenantId` (signature-verified);
  - `POST /api/public/unsubscribe` (HMAC token);
  - storefront `deliveryZones` (no boundaries);
  - delivery block in public tracking and in the live `order:status` event.
- **Order flow integration:**
  - personal and product/category coupons enforced on the server;
  - pricing applies restricted coupons to eligible lines only, in both server `pricing.ts` and the offline client copy, kept identical by the parity test;
  - zone fee and minimum order;
  - checkout consent;
  - delivery start on acceptance and delivery cancellation on order cancellation.

### Client
- **New pages:**
  - `pages/owner/Intelligence.tsx`: Overview, Forecast, Recommendations, Assistant, Background jobs;
  - `pages/owner/Marketing.tsx`: Campaigns, Automations, Segments & customers, Channels, Opt-outs & rules;
  - `pages/owner/Delivery.tsx`: Dispatch, Riders, Zones, Analytics, Settings;
  - `pages/staff/Rider.tsx`;
  - `pages/store/Unsubscribe.tsx`.
- **Navigation** entries are filtered by permission; riders land on **My deliveries**; the Rider role is available in Staff & roles.
- **Storefront checkout:** area selector, "Use my location", and an **unticked** marketing-consent checkbox. The tracking page shows delivery status, rider first name, expected time and delivery code (translated into English, Urdu and Arabic).

### Docs
- `docs/TABLESAAS_USER_GUIDE/AI_INTELLIGENCE_AND_FORECASTING_GUIDE.md`
- `docs/TABLESAAS_USER_GUIDE/MARKETING_AUTOMATION_GUIDE.md`
- `docs/TABLESAAS_USER_GUIDE/DELIVERY_AUTOMATION_GUIDE.md`
- Index updated.
- `STAFF_USER_GUIDE.md`: the permission matrix was regenerated from `permissions.ts` (37 permissions × 8 roles), and a Rider section and the new permission descriptions were added.
- `server/.env.example`: `ANTHROPIC_API_KEY` and `AI_PROVIDER` documented (commented out).

## 4. Safety and security design

- **Tenant isolation:**
  - every new tenant model uses the tenant-scope plugin (queries without `tenantId` throw);
  - jobs carry `tenantId` and reload the tenant, skipping suspended ones;
  - webhooks resolve the tenant from the URL and verify that tenant's own signature;
  - cross-tenant access is tested for intelligence, recommendations, jobs, campaigns, customers, unsubscribe tokens, zones, riders, dispatch and analytics.
- **Riders:**
  - riders only act on deliveries assigned to them;
  - their sockets join only their own room. Riders were previously placed in the restaurant-wide staff room, which would have pushed every order with customer details to them.
- **AI:**
  - the key stays server-side;
  - tools are read-only and filtered by the user's permissions;
  - tools return aggregates; customer personal data is not sent;
  - rate limited to 20 questions per minute per user;
  - a timeout and 2 retries; failures fall back to built-in reports and are logged.
- **Marketing:**
  - consent is never implicit;
  - every rule is re-checked at send time;
  - each message has a unique dedupe key, and messages are claimed atomically (`queued → sending`);
  - interrupted sends become `unknown` and are never retried blindly;
  - "delivered" only comes from signature-verified callbacks;
  - every send requires owner/admin approval, and AI drafts are flagged;
  - budgets pause campaigns;
  - credentials are encrypted with AES-256-GCM and never returned.
- **Delivery:**
  - every state change is an atomic conditional update;
  - timeouts are persistent and idempotent (keyed by attempt number);
  - rider locations are stored only while sharing is on and are hidden from dispatchers and customers;
  - customers see the rider's first name only.

## 5. Bugs found and fixed during testing

1. **Dish and ingredient forecasts were too low.** They padded the 56-day window with zeros before the restaurant's first sale. On 21 days of history this gave 0.43 kg/day of rice instead of about 1.15 kg/day. The window now starts at the first sale day.
2. **Messaging provider lookup crashed.** The query projection (`messaging` + `+messaging.sms.authTokenEnc`) caused a MongoDB "path collision", so scheduling, activation and sending failed with a 500.
3. **Test-send route was unreachable.** The generic `/campaigns/:id/:action` route was registered before `/campaigns/:id/test`.
4. **Messages could be stranded.** Dispatch jobs used one key per tenant per minute, so messages queued after that minute's job had run got no dispatch. The scheduler now reuses a queued dispatch or creates a new one, and the recurring scheduler sweeps for due queued messages.
5. **Riders received the full order feed** over sockets (see §4).
6. **Manual reassignment** did not notify the previous rider; it now does.

## 6. Verification (all local, in-memory MongoDB)

| Check | Result |
|---|---|
| Server typecheck (`tsc` app + tests) | Clean |
| Server test suite (`npm test`) | **157 / 157 pass** (119 existing, unchanged, plus 38 new: intelligence/AI/jobs 14, marketing 12, delivery 12) |
| Client typecheck + production build | Clean |
| New browser sweep (new pages + storefront + tracking + unsubscribe at 390 / 768 / 1024 / 1440 / 1920, plus tab clicks at 390 and 1440) | 88 page states: 0 horizontal overflow, 0 console errors, 0 error screens; **9 / 9 functional checks** |
| Earlier full-app browser sweep (regression) | 143 page states clean; 5 / 5 functional |
| Earlier offline POS/kitchen browser test (regression) | 24 / 24 pass |

**New tests cover:**
- **Forecasting:** insufficient history refused; deterministic maths; range, confidence and coverage present; unsupported horizon rejected.
- **Intelligence and recommendations:** revenue ≠ profit; permissions (waiter and rider denied); tenant isolation; recommendation dedupe and single decision.
- **AI assistant:** built-in fallback; stub-provider tool loop that uses the tenant's real numbers and offers no write tools; provider failure fallback; usage/cost logging; copy drafts.
- **Jobs:** idempotent keys, backoff, `maxAttempts`, lease recovery, concurrent workers running a job once, a restart-safe scheduler.
- **Consent, segments and approval:** checkout consent; segment rules; approval gating; scheduling refused without a provider.
- **Credentials and sending:** encryption at rest; secrets not returned; verification; preview, test send, dispatch and duplicate prevention.
- **Provider callbacks:** forged webhooks rejected; signed ones mark delivered; cross-tenant webhooks rejected.
- **Coupons and reporting:** personal and category coupons priced correctly; verified vs estimated report.
- **Send-time safety rules:** frequency cap, unsubscribe, suppression, transient retry, permanent failure, unknown-not-resent, budget pause, quiet hours, journey approval and once-per-spell.
- **Delivery:**
  - zones: validation, fee/minimum, location matching, boundaries not exposed;
  - assignment: no fake assignment without riders, deterministic auto-assignment, persistent timeout reassignment, idempotent re-run;
  - rider permissions; full lifecycle with the pickup-requires-ready check and the code check;
  - the customer view (no rider id, location or attempts);
  - manual reassignment, failure → returned, cancellation cascade;
  - location privacy, delay alert once, analytics, tenant isolation.

## 7. Restrictions honoured

- No deploy; no Atlas access (the `.env` database was never used; every run overrode `MONGODB_URI` with in-memory MongoDB); no DNS or hosting changes; payment credentials untouched; no real messages sent (`fetch` stubbed); no ad spend or purchases; no keys printed or committed.
- **No fabricated data:**
  - forecasts and recommendations come only from data, with explicit reasons when data is insufficient;
  - no invented locations or travel times;
  - "delivered" only from provider callbacks.
- **No duplicated modules:** existing analytics, customers, coupons, notifications and delivery fields were extended in place.
- **POS and QR ordering unchanged:** the existing and offline tests and the browser regressions all pass. The one pricing change (restricted coupons) is mirrored in the offline module and covered by the parity test.
- **One new dependency:** `@anthropic-ai/sdk`, the official SDK for the Claude integration. Twilio and SendGrid use plain `fetch` (no SDKs).

## 8. Behaviour changes worth knowing

- With **any active delivery zone**, delivery checkout requires choosing an area or sharing a location. Without zones, nothing changes.
- Public coupon validation now also returns the coupon's restrictions (`productIds`, `categoryIds`, `personal`).
- Delivery orders get a delivery sub-status when accepted. If auto-assignment is on and riders exist, a rider is assigned immediately.
- Rider accounts no longer receive the staff-wide socket feed.

## 9. Not done / limitations

- **Live provider verification:**
  - Claude (no `ANTHROPIC_API_KEY` in this environment);
  - Twilio and SendGrid (no accounts): the request formats follow the providers' documented REST APIs but have not been run against them;
  - Twilio status callbacks need a publicly reachable `PUBLIC_API_URL`.
- **Messaging features not built:**
  - WhatsApp template management;
  - SendGrid event webhook (email delivery and opens);
  - link click tracking;
  - push notifications.
- **Delivery not built:**
  - live maps and routing/traffic travel times;
  - photo/signature proof of delivery;
  - per-rider cash reconciliation.
- **Forecasting:**
  - holidays, weather and events are not modelled;
  - product and ingredient forecasts use dish history only (no trend factor);
  - costs use today's ingredient prices, not historical ones.
- **Coupons:** product/category coupon restrictions can be set via the API but have no editor in the campaign UI yet (percent/fixed, minimum and validity do).
- The background worker runs inside the API process. Several API instances are safe (atomic claims, unique keys), but there is no separate worker deployment.

## 10. Suggested next steps

1. Add `ANTHROPIC_API_KEY` in a staging environment, ask the assistant 10–20 real questions, and review answers and `/ai-usage` cost.
2. Create Twilio and SendGrid test accounts:
   - verify the credentials;
   - run a test send to your own number and email;
   - expose the API publicly (staging) and confirm Twilio callbacks mark messages delivered.
3. Enter recipes and ingredient costs for the main dishes so profit and ingredient forecasts cover most revenue.
4. Pilot delivery with 1–2 riders: set zones, keep "require code" off at first, then review analytics after a week.
