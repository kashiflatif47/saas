# Architecture

## Tenancy model

**Shared application, shared database, row-level isolation.** Every tenant-owned document carries an immutable, indexed `tenantId`. The `Tenant` document holds branding, theme, settings, subscription and payment-provider configuration. Every storefront and dashboard renders from it. There are no per-tenant code paths, builds or deployments.

```
Browser ─▶ <slug>.ROOT_DOMAIN ─▶ reverse proxy (wildcard TLS) ─▶ SPA (static)  ──┐
                                                            └─▶ /api, /socket.io ─▶ Express + Socket.IO ─▶ MongoDB
```

Tenant resolution:

| Request kind | Tenant source | Guard |
|---|---|---|
| Public storefront `/api/public/*` | Host header subdomain (or verified custom domain) | Tenant must exist and its subscription must allow operation, else 404/503 |
| Staff `/api/staff/*` | Signed JWT `tid` claim only | Host subdomain (if any) must equal JWT tenant, else 403 |
| Platform `/api/platform/*` | none (super admin role) | `role === superadmin` |
| Sockets | JWT (staff) / order tracking token (customer) | Rooms are always prefixed `t:<tenantId>:` |

See TENANT_ISOLATION_REPORT.md for the full defence-in-depth list.

## Data model (collections)

`plans`, `tenants`, `users` (staff + super admins), `auditlogs`, `kitchenstations`, `categories`, `products`, `tables`, `orders`, `counters`, `payments`, `reservations`, `customers`, `feedbacks`, `coupons`, `notifications`, `suppliers`, `inventoryitems`, `purchaseorders`, `stockmovements`.

Every compound index starts with `tenantId`, e.g. `orders {tenantId, createdAt}`, `{tenantId, status, createdAt}`, `{tenantId, orderNumber}` unique, `tables {tenantId, qrToken}` unique, `users {tenantId, email}` unique.

## Money

All amounts are integers in minor units. `src/lib/pricing.ts` is a pure function:

```
unit      = max(0, effectiveBase + variantDelta + Σ addons)
subtotal  = Σ unit × qty
discount  = coupon (percent capped by maxDiscount, fixed capped by subtotal; minOrder enforced)
service   = round((subtotal − discount) × service%)
tax       = exclusive: round((subtotal − discount + service) × tax%)
            inclusive: extracted from (subtotal − discount + service); total unchanged
total     = subtotal − discount + service (+ tax if exclusive)
```

Prices always come from the database at order time. Anything the client sends as a price is discarded by schema validation.

## Order lifecycle

```
pending ─▶ accepted ─▶ preparing ─▶ partially_ready ─▶ ready ─▶ delivered ─▶ completed ─▶ (refunded)
   │           │            │               │             │
   └▶ rejected └────────────┴───────────────┴─────────────┴▶ cancelled ─▶ (refunded)
```

- Each item has `queued → preparing → ready → served` (or `cancelled`). While an order is in the kitchen phase its status is **derived** from its items (`deriveOrderStatus`). The KDS works per item and per station, and the parent order stays in sync.
- Items route to the category's kitchen station, falling back to the tenant's default station.
- Accept → recipe ingredients are deducted (idempotent). Cancel/reject → product stock, ingredients and coupon usage are restored.
- Completion with a known customer → customer stats and loyalty points.

## Payments

Payment status is **independent** of order status and derived solely from **verified** payment records:

```
unpaid → partially_paid → paid → partially_refunded → refunded
```

- Cash / card-terminal: recorded by staff with `payments:collect`. The recording staff member is stored as verifier. Overpayment is rejected.
- Online (Stripe): `POST /pay` creates a PaymentIntent and a **pending** payment. It becomes **verified only** from a signature-checked webhook whose amount and currency match. No client-side "success" is trusted.
- Refunds: capped at the refundable amount per charge. Stripe refunds go through the API and are confirmed by webhook.

## Subscriptions

Plans define price, trial days, feature flags and limits. Tenants carry `subscription {planId, status, trialEndsAt, currentPeriodEnd, featureOverrides}`. An hourly idempotent sweep moves expired trials to `expired`, lapsed paid periods to `past_due` (7-day grace) and then to `expired`. Expired or suspended tenants have their storefront offline and the dashboard read-only.

## Real-time

Socket.IO with tenant-prefixed rooms. Every emit helper builds the room name from a server-side tenant id. For multiple API instances, add `@socket.io/redis-adapter` (see DEPLOYMENT.md).

## Frontend

A single SPA decides by hostname:
- root domain → platform console (`/login`, `/admin/*`)
- `<slug>.ROOT_DOMAIN` → storefront (`/`, `/t/:token`, `/order/:id`, `/reserve`) and staff app (`/login`, `/dashboard/*`)

Theme colours become CSS variables at runtime from the tenant's HEX palette. The storefront supports English, Urdu and Arabic with `dir="rtl"` and appropriate fonts. Menu content is stored per language with English fallback.
