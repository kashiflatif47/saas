# API reference

Base URL: `https://api.<ROOT_DOMAIN>` or the same origin via reverse proxy (`/api`). All bodies are JSON. Money is always an **integer in minor units** (paisa/cents/fils). Errors look like:

```json
{ "error": { "code": "VALIDATION|BAD_REQUEST|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|DUPLICATE|SUBSCRIPTION_REQUIRED|TENANT_UNAVAILABLE|INTERNAL", "message": "…", "details": {} } }
```

## Authentication

- `POST /api/auth/login` `{ email, password, tenantSlug? }`. Omit `tenantSlug` for super admin. It returns `{ accessToken, user, permissions, tenant }` and sets an httpOnly refresh cookie `rt` (path `/api/auth`).
- Send `Authorization: Bearer <accessToken>` (15 min TTL).
- `POST /api/auth/refresh` rotates the refresh token (cookie). Reuse of an old token revokes all sessions.
- `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/change-password` `{ currentPassword, newPassword }`, `GET /api/auth/roles`.
- Rate limit: 20 logins / 15 min / IP. 8 failed attempts lock the account for 15 min.

**Tenant context.** Staff endpoints take the tenant **only from the JWT**. If the request host is a tenant subdomain it must match, otherwise `403`. Public endpoints resolve the tenant from `Host` (or `X-Tenant-Host` sent by the SPA). It is validated against the database.

## Platform (super admin), prefix `/api/platform`

| Method | Path | Notes |
|---|---|---|
| GET | `/overview` | Tenants by status/subscription, 30-day orders/GMV, daily series, top tenants, est. MRR |
| GET/POST | `/plans` | Plans: price, trialDays, features[], limits{maxStaff,maxProducts,maxTables} |
| PATCH | `/plans/:id` | |
| GET | `/tenants?q&status&subscription&page&limit` | |
| POST | `/tenants` | **Provision**: `{ name, slug?, businessType, planId, currency, contact, owner{name,email,password} }`. Creates tenant, owner, default station and trial |
| GET | `/tenants/:id` | Tenant + usage (staff/products/tables/orders/GMV) + owner + URL |
| PATCH | `/tenants/:id` | name, businessType, contact, customDomain |
| POST | `/tenants/:id/status` | `{ status: active\|suspended, reason }`. Suspension revokes all sessions |
| POST | `/tenants/:id/subscription` | `{ action: renew\|extend_trial\|set_status\|set_overrides, planId?, months?, days?, status?, grant?, revoke? }` |
| POST | `/tenants/:id/owner-password` | Support reset |
| GET | `/audit?tenantId&action&page` | Platform-wide audit trail |

## Tenant staff, prefix `/api/staff` (Bearer token, tenant from JWT)

Writes return `402 SUBSCRIPTION_REQUIRED` when the subscription has lapsed (reads still work). Feature-gated modules return `402` if the plan lacks the feature.

| Area | Endpoints | Permission |
|---|---|---|
| Profile/settings | `GET /tenant`, `PATCH /tenant/settings`, `PATCH /tenant/branding`, `POST /tenant/branding/:slot` (logo\|favicon\|cover\|hero, multipart `file`) | settings:manage / branding:manage |
| Payment config | `GET/PATCH /tenant/payments`, `POST /tenant/payments/verify` | payments:configure (owner) |
| Staff | `GET/POST /staff`, `PATCH/DELETE /staff/:id`, `GET /staff/:id/activity` | staff:view / staff:manage |
| Notifications | `GET /notifications`, `POST /notifications/read {ids?}` | notifications:view |
| Audit | `GET /audit?action` | audit:view |
| Stations | CRUD `/menu/stations` | menu:view / menu:manage |
| Categories | `GET/POST /menu/categories`, `PATCH/DELETE /menu/categories/:id`, `POST /menu/categories/reorder {ids}`, `POST /menu/categories/:id/image` | menu:manage |
| Products | `GET /menu/products?categoryId&archived&featured&q`, `GET/POST`, `PATCH /:id` (incl. `isArchived`), `DELETE /:id` (archive), `POST /:id/images` (multipart `files`, ≤8), `DELETE /:id/images {url}`, `POST /:id/stock` | menu:view / menu:manage |
| Tables & QR | `GET/POST /tables` (`count`+`prefix` for bulk), `PATCH/DELETE /tables/:id`, `POST /tables/:id/regenerate`, `GET /tables/:id/qr?format=png\|svg&download=1`, `GET /tables/qr/print?ids=` (PDF) | tables:view / tables:manage |
| Orders | `GET /orders?status&paymentStatus&tableId&from&to&q&mine`, `GET /orders/:id` (+payments), `POST /orders` (staff order), `POST /orders/:id/status {status, reason?}`, `POST /orders/:id/assign {waiterId}`, `POST /orders/:id/items/:itemId/status {status}` | per transition (see below) |
| Payments | `POST /orders/:id/payments/cash {amount, method: cash\|card_terminal}`, `POST /orders/payments/:paymentId/refund {amount, reason}`, `GET /payments?status&kind&method` | payments:collect / payments:refund |
| Kitchen | `GET /kitchen/queue?stationId` | kitchen:operate + `kds` feature |
| Inventory | `GET/POST /inventory/items`, `PATCH/DELETE /inventory/items/:id`, `POST /inventory/items/:id/adjust {type: adjustment\|wastage, quantity, reason}`, `GET /inventory/movements`, CRUD `/inventory/suppliers`, `GET/POST /inventory/purchase-orders`, `POST /inventory/purchase-orders/:id/status {ordered\|cancelled}`, `POST /inventory/purchase-orders/:id/receive` | inventory:* + `inventory` feature |
| Reservations | CRUD `/reservations?status` (double-booking guard) | reservations:manage + feature |
| Customers | CRUD `/customers` | customers:manage |
| Feedback | `GET /feedback`, `PATCH /feedback/:id {isPublished, response}` | feedback:view |
| Coupons | CRUD `/coupons` | coupons:manage |
| Analytics | `GET /analytics/dashboard`, `GET /analytics/summary?period=today\|week\|month\|year&from&to&unit`, `GET /analytics/export?kind=summary\|orders\|payments\|products\|categories&format=csv\|pdf` | orders:view / analytics:view (+ `analytics_export`) |

**Order transitions and the permission each needs**: accept/reject → `orders:accept`; preparing/partially_ready/ready → `kitchen:operate`; delivered/completed → `orders:deliver`; cancelled → `orders:manage`; refunded → `payments:refund`. Only valid state-machine transitions are allowed (see ARCHITECTURE.md).

## Public storefront, prefix `/api/public` (tenant from Host)

| Method | Path | Notes |
|---|---|---|
| GET | `/storefront` | Name, branding/theme, public settings, payment availability, features |
| GET | `/menu` | Active categories (schedule-aware, tenant timezone) and products with `effectivePrice`, `soldOut` |
| GET | `/tables/:token` | Validates a QR token **for this tenant only** |
| POST | `/coupons/validate {code}` | |
| POST | `/orders` | `{ type, tableToken?, customer?, notes?, couponCode?, items[{productId, variantId?, addonIds?, quantity, notes?}] }`. Client prices are ignored. Returns `{ order, trackingToken }`. 15/min/IP |
| GET | `/orders/:id?token=` | Tracking (secret token required) |
| POST | `/orders/:id/pay {token}` | Creates a Stripe PaymentIntent (only if configured and verified) and returns `clientSecret` |
| POST | `/orders/:id/feedback {token, rating, comment?}` | After served |
| GET | `/feedback` | Published reviews |
| POST | `/reservations` | Reservation request (feature-gated) |

## Webhooks

`POST /api/webhooks/stripe/:tenantId`. Raw body, `Stripe-Signature` verified with the tenant's signing secret (5-minute tolerance). Handles `payment_intent.succeeded`, `payment_intent.payment_failed`, `refund.created`, `refund.updated`. Idempotent. Amount and currency must match the pending payment.

## Socket.IO

Connect to path `/socket.io` with `auth: { token }` (staff) or `auth: { orderId, trackingToken }` (customer tracking). Unauthenticated connections are refused.

| Event (server → client) | Rooms | Payload |
|---|---|---|
| `order:new` | tenant staff | order |
| `order:updated` | tenant staff | order |
| `kitchen:new`, `kitchen:updated` | tenant kitchen + relevant stations | order |
| `order:ready`, `order:assigned` | assigned waiter | order |
| `order:status` | the tracked order only | `{ status, paymentStatus, items[] }` |
| `notification` | tenant staff | notification |
| `subscriptions:swept` | platform | counts |

Client → server: `kitchen:watchStation(stationId)`. It always joins under the caller's own tenant prefix.

## Health

`GET /api/health` → `200 {status:"ok"}` when MongoDB is connected, `503` otherwise.
