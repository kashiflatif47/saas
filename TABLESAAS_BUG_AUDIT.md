# TableSaaS — Bug Audit

**Date:** 2026-11-11 · **Scope:** functional bugs, security and stability in the existing application. No redesign, no new features, no deployment, no database writes outside in-memory test databases.

## How the audit was done

- Read every server module (`server/src`: app setup, auth, tenant middleware, tenant-scope plugin, all routes, services, models, sockets, jobs, configuration) and the client code behind each workflow (API client, auth and cart stores, socket hook, storefront, order tracking, kitchen, waiter, orders, dashboard, settings, staff, menu, tables, super admin pages).
- Traced each workflow from the screen through the API route and service to the database and back.
- **Baseline before any change:** `npm run typecheck` passed; `npm test` passed **69/69**.
- Every suspected bug got an automated reproduction (`server/tests/integration/regressions.test.ts`), run **against the unmodified code first**. All server-side issues below failed before their fix and pass after it. Where a reproduction was not possible, the entry says so.

## Summary

| ID | Module | Severity | Status |
|---|---|---|---|
| TS-001 | Settings / storefront / analytics | High | Fixed |
| TS-002 | Settings / provisioning | High | Fixed |
| TS-003 | Payments (cash) | High | Fixed |
| TS-004 | Orders / kitchen / inventory | High | Fixed |
| TS-005 | Real-time (staff screens) | High | Fixed |
| TS-006 | Security: live sockets after revocation | High | Fixed |
| TS-007 | Staff management | High | Fixed |
| TS-008 | Checkout (duplicate orders) | Medium | Fixed |
| TS-009 | Payments (online, duplicate intents) | Medium | Fixed |
| TS-010 | Order placement rollback | Medium | Fixed |
| TS-011 | Payments on cancelled orders | Medium | Fixed |
| TS-012 | Plan limits (staff reactivation) | Medium | Fixed |
| TS-013 | Plan limits (restoring archived dishes) | Low | Fixed |
| TS-014 | Menu categories (nesting) | Low | Fixed |
| TS-015 | Order tracking live view | Low | Fixed |
| TS-016 | Database configuration (shared `test` DB) | High | **Owner decision required** |
| TS-017 … TS-024 | Various | Low–Medium | Documented, not changed (see `TABLESAAS_REMAINING_ISSUES.md`) |

No Critical issues were found: tenant isolation (tenant-scope plugin, host/JWT cross-checks, Socket.IO room prefixes) held in every test.

---

## Fixed issues

### TS-001 · An invalid timezone takes the restaurant's menu and dashboard down
- **Module:** Settings → storefront menu, dashboard, analytics · **Severity:** High
- **Description:** The owner's settings endpoint accepted any text as timezone. Every code path that uses it calls `Intl.DateTimeFormat({ timeZone })`, which throws `RangeError: Invalid time zone specified`, so `GET /api/public/menu` (when any category has a schedule), the dashboard and analytics returned **500**.
- **Reproduction:** `PATCH /api/staff/tenant/settings {settings:{timezone:"Not/A_Zone"}}` → 200 (accepted); add a scheduled category; open the storefront → 500. The `RangeError` was confirmed directly against `categoryVisibleNow`.
- **Root cause:** `settingsSchema.timezone` was `z.string().max(60)` with no IANA check (the super-admin route already validated it).
- **Affected files:** `server/src/routes/tenantAdmin.ts`, `server/src/routes/superadmin.ts`, `server/src/services/tenantResolver.ts`, new `server/src/lib/timezone.ts`
- **Fix:** shared `isValidTimeZone` validation on both routes; the tenant resolver substitutes UTC for a stored invalid zone, so bad data saved before the fix cannot crash requests.
- **Verification:** `BUG-001`, `BUG-001b` (stored bad zone → menu, dashboard and summary return 200).

### TS-002 · Owners on plans without multi-language cannot save any settings
- **Module:** Super admin provisioning → owner Settings · **Severity:** High
- **Description:** New restaurants were created with languages `en, ur, ar` regardless of plan. The Settings page sends the whole settings object, and the server refuses more than one language without the `multi_language` feature, so on the default **Starter** plan, saving "Money & tax" or "Ordering rules" returned **402 "Multi-language menus are not included in your plan"**.
- **Reproduction:** provision on a plan without `multi_language`; `GET /api/staff/tenant`; send its settings back with any change → 402.
- **Root cause:** provisioning hard-coded three languages, and the check compared the language count, not whether languages were added.
- **Affected files:** `server/src/routes/superadmin.ts`, `server/src/routes/tenantAdmin.ts`
- **Fix:** new restaurants get `['en']` unless the plan includes multi-language. The settings check now refuses only **adding** languages without the feature; re-saving an existing set is allowed, so restaurants already affected recover without a data migration.
- **Verification:** `BUG-002`, `BUG-002b`.

### TS-003 · Concurrent cash payments over-collect an order
- **Module:** Payments · **Severity:** High
- **Description:** A double click on "Record payment", or two cashiers at once, recorded the full amount several times. The check-then-insert was not atomic.
- **Reproduction:** three simultaneous `POST /orders/:id/payments/cash` for the full total → **201, 201, 201**; three verified charges.
- **Root cause:** `recordCashPayment` read the balance, then inserted a payment with no guard between the two steps.
- **Affected files:** `server/src/services/paymentService.ts`
- **Fix:** an atomic compare-and-set claims the amount on the order (`amountPaid` must still equal the value read) before the payment record is written. Totals are always re-derived from verified payment records afterwards, which also releases the claim if the insert fails. The losing request gets 409 "This order was just updated…".
- **Verification:** `BUG-003` (exactly one 201; `amountPaid == total`; one verified charge).

### TS-004 · Concurrent order transitions are applied more than once
- **Module:** Orders, kitchen, inventory · **Severity:** High
- **Description:** Two staff accepting the same order (both see it on their screens) each succeeded. Recipe stock was deducted twice and the history showed two "accepted" entries. The same read-modify-save race could let a webhook, a payment recompute and a kitchen update overwrite each other.
- **Reproduction:** three simultaneous `POST /orders/:id/status {accepted}` → **200, 200, 200**; three stock consumptions.
- **Root cause:** `Order` documents were saved without optimistic concurrency, so the last writer won silently.
- **Affected files:** `server/src/models/operations.ts`, `server/src/services/orderService.ts`, `server/src/services/paymentService.ts`, `server/src/services/inventoryService.ts`, `server/src/middleware/error.ts`
- **Fix:** `optimisticConcurrency: true` on orders. Transitions, item updates and payment recomputes run inside `withOrderRetry`, which re-reads and re-validates after a conflict, so a second "accept" becomes a normal invalid-transition 400. The inventory-deducted flag is now an atomic update. A remaining `VersionError` maps to 409 instead of 500.
- **Verification:** `BUG-004` (one 200, one stock movement); `BUG-004b` (two cooks marking different items ready at the same moment **both succeed**, so no UX regression).

### TS-005 · Kitchen and other live staff screens silently stop updating
- **Module:** Real-time (client) · **Severity:** High
- **Description:** The staff socket sent the access token captured at page load. After a network blip, the reconnect presented that token. Once it had expired (15 minutes), the server refused it, and socket.io never retries middleware rejections. Kitchen display, waiter view, orders board, dashboard and notifications stopped receiving orders with no visible error beyond the "offline" badge. Orders accepted while disconnected were never re-fetched.
- **Root cause:** a static `auth` object in `useSocket`; no handling of `connect_error: unauthorized`; no re-sync after reconnect.
- **Affected files:** `client/src/hooks/useSocket.ts`, `client/src/api/client.ts`, `client/src/pages/staff/Kitchen.tsx`, `client/src/pages/staff/Waiter.tsx`, `client/src/pages/owner/Orders.tsx`, `client/src/pages/owner/Dashboard.tsx`, `client/src/components/DashboardLayout.tsx`
- **Fix:** the token is read on every (re)connect. On `unauthorized` the token is refreshed and the socket reconnects with back-off. A `reconnect` handler re-fetches each screen's data.
- **Verification:** typecheck and build; in the browser sweep, the kitchen display received a newly accepted order live. **The expiry-then-reconnect path itself was not reproduced in a browser** (it needs a 15-minute idle token plus a dropped connection). The fix follows socket.io's documented behaviour for middleware errors.

### TS-006 · Removed staff and suspended restaurants keep receiving live order data
- **Module:** Security / Socket.IO · **Severity:** High
- **Description:** Deactivating an employee, changing their role or resetting their password, or suspending a restaurant, revoked tokens for **new** requests. Sockets already open stayed connected and kept streaming orders, including customer names and phone numbers.
- **Reproduction:** connect a kitchen user's socket; deactivate the user → the socket stays connected (test timed out waiting for a disconnect).
- **Root cause:** revocation only bumped `tokenVersion`; sockets are authenticated once at handshake.
- **Affected files:** `server/src/sockets/index.ts`, `server/src/routes/tenantAdmin.ts`, `server/src/routes/superadmin.ts`, `client/src/hooks/useSocket.ts`
- **Fix:** each staff socket joins a per-user room. Staff deactivation, access changes, admin password resets and account changes close that user's sockets; suspension closes all of the tenant's staff sockets. The client tries one reconnect after a server-side close: a revoked user is refused, everyone else rejoins with a fresh token.
- **Verification:** `BUG-012` (fails without the fix, passes with it; other staff stay connected).

### TS-007 · Editing a staff profile signs that person out (including owners editing themselves)
- **Module:** Staff management · **Severity:** High
- **Description:** The Staff form always sends `role` and `permissionOverrides`. The server revoked sessions whenever those fields were **present**, so changing a waiter's phone logged the waiter out, and an owner saving their own name was logged out on the spot.
- **Reproduction:** owner `PATCH /staff/<ownerId>` with unchanged overrides → the owner's next request returns **401**.
- **Root cause:** `revoke = isActive === false || !!role || !!permissionOverrides`
- **Affected files:** `server/src/routes/tenantAdmin.ts`
- **Fix:** revoke only when the role really changes, the overrides really change, the account goes from active to inactive, or the password changes.
- **Verification:** `BUG-010` (fails on the old logic with 401; passes after; a real role change still revokes immediately).

### TS-008 · Checkout retries and double taps create duplicate orders
- **Module:** Storefront checkout · **Severity:** Medium
- **Description:** There was no server-side duplicate protection. A retry after a timeout, or two taps before the button re-rendered as disabled, created two orders and reserved stock twice.
- **Affected files:** `server/src/routes/orders.ts`, `server/src/services/orderService.ts`, `server/src/models/operations.ts`, `client/src/pages/store/MenuView.tsx`
- **Fix:** optional `idempotencyKey` (random, generated per checkout by the client). A repeated key returns the original order and tracking token. A simultaneous duplicate is caught by a unique partial index `{tenantId, idempotencyKey}`, its stock and coupon reservations are rolled back, and it returns the winner's order. The client also guards against same-tick double clicks. The key never appears in public or staff payloads.
- **Verification:** `BUG-005` (sequential and simultaneous); browser: double-clicking "Place order" created exactly one order.

### TS-009 · "Pay online" opens a new payment intent on every press
- **Module:** Online payments · **Severity:** Medium
- **Description:** Each press (or reload) created a new Stripe PaymentIntent and pending payment for the same balance. If two were confirmed, the customer was charged twice. A provider network failure surfaced as a raw 500.
- **Affected files:** `server/src/services/paymentService.ts`
- **Fix:** an open pending intent for the same order and amount is reused. Provider network failures and timeouts (20 s) return 502 "Payment provider is unreachable".
- **Verification:** `BUG-011`, with network access stubbed so **no call reaches Stripe**. Failed before (a second intent was attempted); passes after.

### TS-010 · Order placement could release stock that belongs to a created order
- **Module:** Order placement · **Severity:** Medium
- **Description:** If any step **after** the order document was written failed (e.g. the auto-accept transition), the catch block restored the reserved stock and coupon usage while the order stayed in the database.
- **Affected files:** `server/src/services/orderService.ts`
- **Fix:** rollback happens only when no order was created.
- **Verification:** code review plus the full regression suite. **No direct automated reproduction**: it needs failure injection after the insert, which the suite has no hook for.

### TS-011 · Cash could be recorded against a cancelled order
- **Module:** Payments · **Severity:** Medium
- **Fix:** cancelled orders are refused, matching the existing rule for online payments (`server/src/services/paymentService.ts`). **Verification:** `BUG-006`.

### TS-012 · Reactivating staff bypassed the plan's staff limit
- **Module:** Staff / subscriptions · **Severity:** Medium
- **Fix:** reactivation is checked like creation (`server/src/routes/tenantAdmin.ts`). **Verification:** `BUG-008`.

### TS-013 · Restoring an archived dish bypassed the plan's product limit
- **Module:** Menu / subscriptions · **Severity:** Low
- **Fix:** un-archiving is checked like creation (`server/src/routes/menu.ts`). **Verification:** `BUG-013`, which fails with the check disabled.

### TS-014 · A category with subcategories could be nested under another category
- **Module:** Menu · **Severity:** Low
- **Description:** This produced three levels, which the storefront and editor do not support.
- **Fix:** refused with a clear message (`server/src/routes/menu.ts`). **Verification:** `BUG-007`.

### TS-015 · Live order tracking dropped option names and never updated the amount due
- **Module:** Customer order tracking · **Severity:** Low
- **Description:** Live updates replaced each item with a reduced object, so "Chicken Karahi · Full" became "Chicken Karahi". The payload had no `amountPaid`, so "Pay at the counter" stayed after the order was paid.
- **Affected files:** `server/src/services/orderService.ts` (`broadcastOrder`), `client/src/pages/store/OrderTracking.tsx`
- **Fix:** the payload includes `total`, `amountPaid` and `amountRefunded`; items are merged by id; the page re-fetches after a reconnect.
- **Verification:** browser functional checks 3 and 4 (variant name kept; paid state shown live with no reload).

---

## Open: owner decision required

### TS-016 · Development configuration uses MongoDB's default `test` database on Atlas
- **Severity:** High (data safety) · **Status:** not changed (instructions: do not change database targets)
- **Finding:** `server/.env` uses a `mongodb+srv` Atlas URI **with no database name**, so all data goes to the default `test` database. Per the 2026-11-09 deployment report, this same configuration was planned for production. Re-checked today without printing the URI: the database name is still empty.
- **Consequences:**
  - Development and the planned production share data.
  - `npm run test:local-routing` **writes** restaurants into whatever database the dev server uses. It was **not run** in this pass for that reason.
  - Starting the dev server builds any newly declared index there. This pass added one: a unique **partial** index `orders {tenantId, idempotencyKey}`. It is additive and matches no existing document, but it would be created on the `test` database at the next dev-server start.
- **Required decision:** a dedicated production database name (e.g. `…mongodb.net/tablesaas_prod?…`) and a separate development database.

## Documented, not changed
TS-017 to TS-024 (business-rule questions, rare edge cases, untestable integrations) are listed with reasons in `TABLESAAS_REMAINING_ISSUES.md`.
