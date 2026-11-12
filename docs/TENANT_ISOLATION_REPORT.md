# Tenant isolation report

Requirement: *Restaurant A must never access Restaurant B's data through APIs, database queries, WebSockets, reports, uploads or admin operations.*

## Isolation layers (defence in depth)

| Layer | Mechanism | Code |
|---|---|---|
| 1. Identity | The tenant of a staff request comes **only** from the signed JWT `tid` claim, re-validated against the DB (`tokenVersion`, `isActive`) on every request | `middleware/auth.ts`, `middleware/tenant.ts#requireStaffTenant` |
| 2. Host binding | If the request host is a tenant subdomain it must equal the JWT tenant (403 otherwise). Login and refresh are refused when host and tenant differ. Refresh cookies are host-only | `requireStaffTenant`, `routes/auth.ts` |
| 3. Public resolution | Storefront requests resolve the tenant from the host via the DB. Unknown/reserved/foreign hosts → 404 | `resolvePublicTenant`, `lib/subdomain.ts` |
| 4. Query scoping | Every route/service query includes `tenantId: req.tenantId`. References (category, table, station, supplier, inventory item, waiter) are checked to belong to the same tenant before use | all routes & services |
| 5. **Database guard** | `tenantScopePlugin` on every tenant-owned model: any `find/findOne/count/update/delete/findOneAndX/distinct/aggregate` without `tenantId` in the filter (or first `$match`) **throws before reaching MongoDB**. `tenantId` is immutable. Cross-tenant platform analytics must opt in explicitly via `runCrossTenant()` | `models/tenantScope.ts` |
| 6. Indexes | All unique constraints are compound with `tenantId` (order numbers, table labels, QR tokens, coupon codes, staff emails…), so tenants cannot collide or probe each other's identifiers | models |
| 7. QR tokens | 144-bit random tokens, unique per tenant, resolved only within the host's tenant. Regeneration invalidates the old token immediately | `routes/tables.ts`, `routes/public.ts` |
| 8. Order tracking | 144-bit secret token, constant-time comparison, scoped to host tenant | `routes/public.ts` |
| 9. WebSockets | Auth on handshake. Server-built room names `t:<tenantId>:…`. Station subscriptions are prefixed with the socket's own tenant. Customers join only their order room | `sockets/index.ts` |
| 10. Uploads | Files stored at `uploads/<tenantId>/<folder>/<random>`. Deletion refuses paths outside that tenant's directory | `middleware/upload.ts` |
| 11. Reports/exports | Analytics aggregations start with `$match: { tenantId }`, enforced by the DB guard | `services/analyticsService.ts`, `routes/analytics.ts` |
| 12. Admin operations | Super admin APIs are a separate router and role. Super admins cannot call tenant staff APIs, and tenant staff cannot call platform APIs | `app.ts`, `routes/superadmin.ts` |
| 13. Caching | The tenant resolver cache is keyed by slug/domain only and invalidated on tenant changes. Responses are never cached across tenants. The service worker does not cache API responses | `services/tenantResolver.ts`, `client/vite.config.ts` |

## Test evidence

`server/tests/integration/isolation.test.ts` provisions two tenants (`alpha`, `bravo`) through the real platform API and asserts:

| Test | Asserts |
|---|---|
| list endpoints return only own tenant data | A's product list contains only A's product |
| reading/updating/deleting another tenant record by id → 404 | GET/PATCH/DELETE on B's product with A's token all 404, and B's document is unchanged in the DB |
| cannot create records referencing another tenant | Product in B's category → 400. Staff order on B's table → 400 |
| tenantId in body is ignored | Category created with `tenantId: B` belongs to A |
| staff token on another tenant host → 403 | |
| staff cannot log in to another tenant | |
| login is bound to the requesting tenant host | Wrong host → 401. Super admin on tenant host → 401. Alpha's refresh cookie on bravo's host → 401 |
| public menu scoped by host; foreign QR tokens don't resolve | A's host shows only A's menu. B's table token on A's host → 404. Ordering B's product on A's host → 400 |
| unknown/root/foreign hosts don't resolve | 404 |
| order tracking requires secret token and right host | Missing/wrong token or other tenant's host → 404. Token never echoed |
| analytics, audit and staff lists are tenant scoped | B sees zero of A's orders |
| platform/tenant API separation | Staff → platform 403. Super admin → staff API 403 |
| model guard throws without tenantId | `find({})`, `updateMany({})`, `aggregate([{ $match: {} }])` reject with `TenantScopeError` |
| upload paths namespaced per tenant | URL starts with `/uploads/<A>/`. Non-image rejected |
| Socket.IO events never cross tenants | A's new order reaches A's socket. B's socket receives nothing, even after trying to subscribe to A's IDs. Anonymous socket refused |

`server/tests/integration/orderFlow.test.ts` additionally verifies suspension (sessions revoked, login refused, storefront offline) and expiry (writes blocked, reads allowed).

## Status

| Item | Status |
|---|---|
| Controls implemented | ✅ All layers above |
| Unit tests (subdomain parsing, RBAC) | ✅ Executed and passing (see VERIFICATION_STATUS.md) |
| Integration isolation suite | ⚠️ Written, **not executed** in the build environment (no MongoDB/npm). Run `cd server && npm run test:integration`. It must pass before production |
