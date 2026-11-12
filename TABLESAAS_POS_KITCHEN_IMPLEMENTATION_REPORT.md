# TableSaaS — Advanced POS & Smart Kitchen: Implementation Report

**Date:** 2026-11-11 · Built inside the existing repository: same API, authentication, tenant isolation, models and design system.
- No new dependencies.
- No deployment.
- No access to the Atlas database: every test used in-memory MongoDB.

User documentation: `docs/TABLESAAS_USER_GUIDE/POS_AND_KITCHEN_GUIDE.md`.

## 1. Gap analysis (Phase 0)

| Capability | Before this phase | Now |
|---|---|---|
| Staff order entry | Basic "New order" modal (no images, notes, discounts or quote) | **Full POS page** `/dashboard/pos` |
| Order types | Dine-in, takeaway, delivery (delivery had no address or fee) | + **Pickup**; delivery **address, phone, fee**; type-aware "Served / Picked up / Dispatched" |
| Server-side pricing | Yes (variants, add-ons, coupons, service, tax) | + item and order **manual discounts**, delivery fee, **POS quote endpoint** |
| Discounts | Coupons only | + manual item/order discounts with **permission, mandatory reason, configurable cap**, audit |
| Partial / multiple payments | Partial cash and card-terminal existed | + **split equal**, **split by items** (server-computed shares), payment **idempotency keys** |
| Cash management | Missing | **Cash shifts**: float, cash in/out, expected vs counted, discrepancy, history, one open drawer per cashier, audit |
| Receipts | Missing (page `window.print()` only) | **Receipt data API**, browser print **58 mm / 80 mm / A4**, **PDF**, VAT label and number |
| Order lifecycle | State machine existed | + paid orders cannot be cancelled until refunded; "Confirmed" on POS creation; estimated ready time |
| Order modification | Missing | **Add / change / cancel items**, history preserved, re-priced on the server, kitchen notified |
| Tables | Status only | + **transfer order**, **merge tables**, live `table:updated` events |
| Kitchen stations and routing | Existed and worked (category → station, default station) | Kept; per-station bulk actions; station shown per item |
| KDS | Existed; delay thresholds **hard-coded** (12 and 20 min) | Delay from **dish prep times + configurable grace**; Start all / Station ready (one request); modified-ticket banner; mute; late alert once |
| Item-level kitchen state | Existed | + who started and who finished each item (`startedBy`, `readyBy`) |
| Real-time | Existed (tenant-scoped rooms, reconnect re-sync fixed in the previous phase) | + `kitchen:modified`, `order:modified`, `table:updated`, `menu:updated` |
| Waiter | Waiter view existed | + request bill, transfer table, add items |
| Recipe inventory | Existed, idempotent per order | + item-level consume/return when items are added or removed |
| Reports | Sales, products, categories, hours, methods | + **operations report**: type, channel, method, staff performance, discounts, refunds, shift closings, **kitchen performance** |

Existing working modules were kept and extended, not rebuilt: KDS routing, the payment service, coupons, the order state machine, the QR storefront.

## 2. Files changed

**Server, new**
- `src/services/orderOps.ts`: modification, transfer/merge, bill request, split quote, receipt data
- `src/services/shiftService.ts`, `src/routes/shifts.ts`: cash shifts
- `src/routes/operationsReport.ts`: POS and kitchen report
- `src/lib/receiptPdf.ts`: thermal and A4 PDF receipts
- `tests/integration/pos.test.ts`: 16 tests

**Server, modified**
- `src/config/permissions.ts`: `orders:create`, `orders:modify`, `orders:discount`, `orders:transfer`, `shifts:operate`, `shifts:manage`
- `src/models/operations.ts`:
  - Order: pickup, delivery, deliveryFee, manualDiscount, line discounts, couponSnapshot, createdBy, estimatedReadyAt, billRequestedAt, modifications
  - Order items: prepMinutes, startedBy, readyBy, addedAt, cancel info
  - Payment: shiftId, allocation, idempotencyKey
  - New `CashShift` model
- `src/models/platform.ts`, `src/routes/tenantAdmin.ts`: settings deliveryFee, maxManualDiscountPercent, requireOpenShiftForCash, kitchenDelayGraceMinutes, taxLabel, taxRegistrationNumber, receiptFooter
- `src/lib/pricing.ts`: line and order discounts, delivery fee (order of operations documented in code)
- `src/services/orderService.ts`:
  - shared `prepareOrder` / `buildLines`, `quoteOrder`
  - POS confirm and type validations
  - paid-order cancellation rule, estimated ready time
  - bulk item status, staff attribution, table events
- `src/services/paymentService.ts`: allocation, idempotency key, shift link (charges and cash refunds)
- `src/services/inventoryService.ts`: `adjustInventoryForItems`
- `src/routes/orders.ts`: quote, items add/patch/cancel, bulk-status, transfer, request-bill, split-quote, split payments, receipt; `cancelled` item status now goes through the cancel workflow
- `src/routes/tables.ts`: merge, table events
- `src/routes/menu.ts`: `menu:updated` events
- `src/routes/public.ts`: staff-only fields stripped from public orders; storefront gets deliveryFee and taxLabel
- `src/app.ts`: routers mounted

**Client, new**
- `pages/staff/Pos.tsx`
- `pages/staff/Shifts.tsx`
- `components/PaymentPanel.tsx`
- `components/Receipt.tsx`
- `components/OperationsReport.tsx`

**Client, modified**
- `pages/staff/Kitchen.tsx` (rewritten)
- `components/OrderDrawer.tsx` (rewritten: payment panel, receipts, item changes, add items, transfer, bill request, history)
- `components/NewOrderModal.tsx` (append mode)
- `pages/staff/Waiter.tsx`
- `pages/owner/Settings.tsx` (POS & kitchen card, pickup)
- `pages/owner/Tables.tsx` (merge)
- `pages/owner/Analytics.tsx`
- `pages/store/MenuView.tsx` (delivery address and fee, pickup)
- `i18n/index.tsx` (en, ur, ar keys)
- `lib/util.ts`, `components/ui.tsx`
- `App.tsx` (routes, navigation; cashiers land on the POS)

**Docs**
- `docs/TABLESAAS_USER_GUIDE/POS_AND_KITCHEN_GUIDE.md` (new)
- `README.md` index
- `STAFF_USER_GUIDE.md`: permission matrix regenerated from source; landing page

## 3. Security and data integrity

- **Tenant scope:** every new query is tenant-scoped; the existing tenant-scope plugin refuses unscoped queries. Cross-tenant tests cover:
  - reading, paying for and printing another restaurant's order
  - ordering another restaurant's products
  - socket events
- **Prices:** the server never reads client prices. Split shares are server-computed, and a tampered share amount is refused. The public storefront cannot send manual discounts or staff-only fields.
- **Concurrency:** all read-modify-save order changes run under optimistic concurrency with retry (from the previous phase). Stock reservations are compensated on failure. A shift closes exactly once, enforced by an atomic status guard.
- **Idempotency:** order keys (POS and storefront) and payment keys.
- **Inventory:** recipes are deducted once per order (concurrent confirmations tested). Item additions and removals adjust only those items.
- **Audit:** every financial and operational action is written to the audit log:
  - order creation (with discount details)
  - item changes, transfers, merges, bill requests, bulk kitchen actions
  - payments (with split and shift), refunds
  - shift open, cash in, cash out, close

## 4. Tests: commands and actual results

| Command | Result |
|---|---|
| `npm run typecheck` (server src + tests, client) | **pass** |
| `npm run build` (server + client, PWA) | **pass** (59 precache entries) |
| `npm test` (unit + integration) | **101/101 pass** (85 existing + 16 new), 117 s |
| `npx tsx --test tests/integration/pos.test.ts` | **16/16 pass** |
| `npm run e2e` (built server + SPA) | **20/20 steps pass** |
| Real-browser sweep (headless Chrome, built app, in-memory DB; script kept outside the repo) | **159 page states, 0 horizontal overflow, 0 console errors, 0 login redirects, 0 error states; 12/12 functional checks pass** |

**New automated tests** (`pos.test.ts`)
- POS dine-in, takeaway, pickup and delivery orders; variants, add-ons and 15% VAT; client prices ignored
- station routing with two stations in one order
- unavailable products; cross-tenant products
- discount permission, reason, cap, owner uncapped, storefront refused
- duplicate order keys
- item-level preparation, bulk station actions, partial and full readiness with timestamps and names
- real-time `kitchen:new` / `kitchen:modified` with no cross-tenant events; reconnect state from the database
- modification: add, change, cancel; prepared history preserved; manager-only for started items; re-pricing; recipe adjustments
- table transfer and merge; permissions
- equal split summing exactly; item split; tampered share refused; card terminal recorded as manual; overpayment refused; payment status separate from order status
- payment idempotency; refund permissions; paid order cannot be cancelled until refunded
- shifts: open, single drawer, cash in/out, expected 193.00 vs counted 190.00 → −3.00, close once, permissions, required-shift setting, audit
- receipts: VAT label and number, taxable amount, payments, balance; PDFs at 58, 80 and A4
- operations report; inventory never deducted twice; waiter bill request and served

**Browser sweep** at 390, 768, 1024, 1440 and 1920 px across all platform, storefront and dashboard pages, including the new POS and Cash shifts pages. Functional checks in the real UI:
- POS dish → takeaway → server quote → Send to kitchen (1440 px)
- option picker → Charge → payment panel with amount, equal and item splits → cash → paid
- POS at 390 px through the bottom-bar cart
- delivery fee from the quote, sending blocked without an address
- opening a cash shift from the UI
- KDS Start all and All ready
- the existing storefront checkout and tracking checks

**Not tested in this environment**
- physical tablets, thermal printers and card terminals
- Safari/iOS and Firefox
- Stripe against a real account (no credentials)
- the browser print dialog itself (receipt HTML is generated; the PDF is tested)

## 5. Remaining limitations and external dependencies

- **Hardware:** no direct printer, cash-drawer or card-terminal integration (needs device SDKs or a print agent). Printing goes through the browser. Card terminal payments are recorded as manually confirmed.
- **Delivery providers:** none integrated. Delivery is address, fee and Dispatched → Completed.
- **Stripe:** implemented with verified webhooks; still needs test-mode credentials to verify end to end.
- **Dashboard localisation:** staff screens are English (LTR). Arabic and RTL cover the storefront and browser-printed receipts. SAR and other currencies follow settings. Translating the dashboards is a separate piece of work.
- **PDF receipts** are Latin-only; Arabic receipts use browser printing.
- **Re-pricing** after an order change uses current tax and service settings.
- **Table merge** combines tables, not bills; each order keeps its own bill.
- **Simultaneous duplicate payment requests** with the same key: the second gets a 409 ("refresh") rather than the first payment. Sequential retries return the original payment.
- **New indexes** are created automatically at the next server start against the configured database:
  - `cashshifts {tenantId, cashierId}`, unique partial on open shifts
  - `payments {tenantId, idempotencyKey}`, unique partial
  - `payments {tenantId, shiftId}`

  All are additive and match no existing documents. The dev configuration still points at the shared Atlas `test` database (TS-016 in `TABLESAAS_REMAINING_ISSUES.md`), so that owner decision still applies before starting a server against it.
