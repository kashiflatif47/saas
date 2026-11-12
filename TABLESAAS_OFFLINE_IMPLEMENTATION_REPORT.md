# TableSaaS — Offline-First POS & Kitchen: Implementation Report

**Date:** 2026-11-11 · Built inside the existing repository on top of the existing POS, KDS, order, payment and shift services.
- No new dependencies.
- No deployment.
- No connection to the Atlas database: all tests used in-memory MongoDB.

User documentation: `docs/TABLESAAS_USER_GUIDE/OFFLINE_POS_AND_KITCHEN_GUIDE.md`.

## 1. Audit before the change

| Area | Before | Offline before |
|---|---|---|
| PWA / service worker (`vite-plugin-pwa`, Workbox) | Precached app shell and assets; `/api` never cached; uploads stale-while-revalidate | App shell only |
| Session | Access token in memory; refresh cookie | **A refresh while offline signed the user out** (refresh failed → login page) |
| Local storage | localStorage for UI preferences and the storefront cart only; no IndexedDB | No data |
| POS, KDS, payments, shifts | Online only; every action a live API call | Not usable |
| Idempotency | Order and cash-payment keys (unique per tenant); kitchen bulk action skips items already in the state | Reused as the basis of sync |
| Socket.IO | Tenant-scoped rooms, reconnect re-sync | Not applicable |

## 2. Architecture

```
Browser (one origin per restaurant)                         Server
┌──────────────────────────────────────────────┐            ┌────────────────────────────────────────────┐
│ POS / KDS / Shifts ──► OfflineProvider        │            │ POST /api/staff/sync  (one operation)      │
│   online: live API (unchanged)                │            │  · session tenant+user must match record   │
│   offline / network failure:                  │  online    │  · permission re-check                     │
│     createOfflineOrder / kitchen / cash /     │ ─────────► │  · receipt by op UUID (replay → stored     │
│     shift ──► OfflineEngine (queue)           │            │    result)                                 │
│        └► IdbStore: tablesaas-offline-        │ ◄───────── │  · existing services: quote → price check, │
│           <tenantId>-<userId>                 │  result /  │    placeOrder, collectPayment,             │
│           ops · orders · snapshots ·          │  4xx code  │    updateItemsStatus, addMovement,         │
│           meta · quarantine                   │            │    closeShift                              │
│ BroadcastChannel (tabs) · Web Locks (1 sender)│            │  · audit sync.<type>                       │
│ cached session (no tokens): tablesaas-session │            └────────────────────────────────────────────┘
│ service worker: app shell (unchanged config)  │
└──────────────────────────────────────────────┘
```

**Queue record:** UUID (also the idempotency key), sequence, tenant, user, device, type, local creation time, payload, status (Pending / Syncing / Synced / Failed / Conflict), retry count, next attempt, last error, dependency, result, resolution.

**Sync rules:**
- creation order is kept; dependants wait for their parent;
- network errors keep the record Pending with exponential backoff (2 s × 2ⁿ, cap 5 min, ±20 % jitter);
- 401 keeps it Pending until sign-in;
- 403 and 402 → Failed;
- 5xx, 429 and 408 → backoff, then Failed after 8 attempts;
- other 4xx → Conflict;
- a record is Synced only after a successful server response;
- `syncing` left by a crash goes back to Pending at startup;
- unreadable or foreign records are quarantined, never executed.

**Offline estimate:** `client/src/offline/pricing.ts` is a verbatim copy of `server/src/lib/pricing.ts`, enforced by a test that compares the files and 500 randomised results. `estimate.ts` repeats the server's validations: availability, options, table, delivery, pickup, discount permission, reason and cap, coupons refused, and provisional stock.

**Price safety:** the device sends the total it showed (`expectedTotal`). The server re-quotes, and on any difference returns `409 PRICE_CHANGED` without creating anything. Staff can accept the server price or discard.

## 3. Files

**New (client):**
- `src/offline/types.ts`
- `src/offline/engine.ts` (queue and sync)
- `src/offline/idbStore.ts`
- `src/offline/memoryStore.ts` (tests)
- `src/offline/pricing.ts` (copy of server pricing)
- `src/offline/estimate.ts`
- `src/offline/pos.ts`
- `src/offline/browser.ts` (transport, device id, cached session)
- `src/offline/OfflineProvider.tsx`
- `src/components/SyncCenter.tsx` (status chip, banner, Sync centre)
- `src/components/LocalOrders.tsx` (orders on this device, local order panel, local cash)

**New (server):**
- `src/routes/sync.ts`
- `src/services/paymentFlow.ts` (cash collection shared by the POS route and sync)
- `SyncReceipt` model in `src/models/operations.ts`
- `tests/integration/offlineSync.test.ts` (15 tests)
- `tests/unit/offlinePricingParity.test.ts` (3 tests)

**Modified (server):**
- `models/operations.ts`: `Order.offline {deviceId, createdAt, syncedAt}`; cash movement `key`
- `services/shiftService.ts`: idempotent movements with an offline timestamp
- `services/orderService.ts`: kitchen actions accept a clamped offline timestamp
- `routes/orders.ts`: cash route uses `collectPayment`
- `app.ts`: `/api/staff/sync` mounted
- `tsconfig.test.json`: `rootDir: ".."` so server tests can run the real client engine

**Modified (client):**
- `api/client.ts`: network failures are distinguishable (`isNetworkFailure`, `NETWORK` code); a session probe throws when the server is unreachable
- `store/auth.tsx`: cached session without tokens, `offlineSession`, `resumeOnline`, logout hooks
- `App.tsx`: `OfflineProvider` around restaurant dashboards
- `components/DashboardLayout.tsx`: status chip and banner
- `components/Receipt.tsx`: offline receipts with a notice; `printHtml` exported
- `components/PaymentPanel.tsx`: cash fallback with the same key
- `pages/staff/Pos.tsx`: snapshots, offline estimate, offline save (also on a mid-request network failure, reusing the same key), orders on this device, coupon disabled offline
- `pages/staff/Kitchen.tsx`: snapshot queue, local tickets, queued and optimistic kitchen actions, pending markers, freshness
- `pages/staff/Shifts.tsx`: cached open shift, queued cash in/out and close, local cash included and labelled

**Docs:**
- `docs/TABLESAAS_USER_GUIDE/OFFLINE_POS_AND_KITCHEN_GUIDE.md` (new)
- `docs/TABLESAAS_USER_GUIDE/README.md` index

## 4. Offline capabilities

**Work offline** (after the device has been used online once within 24 h):
- the POS: menu, search, variants, add-ons, quantities, notes, order types, cached tables, delivery details, authorised discounts within the cap
- device-side estimate labelled "offline estimate" with the price snapshot time
- multiple orders, saved durably
- cash payments, with an equal-split helper
- receipts at 58 mm, 80 mm and A4, marked "recorded offline"
- the list of orders on this device with their sync status
- KDS: cached queue plus this device's offline orders; Start, Ready and bulk actions, timestamped and attributed
- an already open cash shift: cash in/out and close
- provisional stock
- refresh and browser restart
- automatic sync on reconnect
- the Sync centre with Retry, Accept server price and Discard (with reason)

**Require the internet:**
- card terminal and Stripe payments
- coupons and refunds
- opening a shift
- item-based split shares
- changing orders already on the server (add or remove items, transfer, merge, bill request)
- sign-in
- management screens and reports

## 5. Single device vs multiple devices

| Mode | Status |
|---|---|
| Single device, offline | Implemented and browser-tested |
| Several tabs on one device | Implemented: shared IndexedDB, BroadcastChannel updates, Web Locks so one tab sends; browser-tested POS → KDS on the same device |
| Several devices on a LAN without internet | **Not implemented.** Browsers cannot share storage between devices. It needs a local gateway server (own database, TLS, device pairing, replay to the cloud with the same keys); documented in the guide §7 as a separate project |
| Several devices after reconnection | Implemented: each syncs its own queue; the server is authoritative; conflicts are tested (two tills overselling the same stock, shift closed on another device, item removed while the kitchen was offline) |

## 6. Tests: commands and actual results

| Command | Result |
|---|---|
| `npm run typecheck` (server src + tests, client) | **pass** |
| `npm run build` (server + client, PWA 59 precache entries) | **pass** |
| `npm test` | **119/119 pass** (101 existing + 15 offline integration + 3 parity), 144 s |
| `npm run e2e` | **20/20 steps pass** |
| Offline real-browser test (headless Chrome, built app with its real service worker and IndexedDB; script kept outside the repo) | **24/24 checks pass** |
| Online regression browser sweep (same as the previous phase) | **159 page states, 0 overflow, 0 console errors; 12/12 functional checks pass** |

**Offline integration tests** (`offlineSync.test.ts`): the real client engine against the real API.
- Orders: offline creation; restart while offline; sync exactly once; repeated syncs and a replayed operation (`replayed: true`).
- Interruptions: a response lost after the server processed it; a crash mid-sync (`syncing` → recovered); no duplicate order or payment.
- Payments: offline cash with a dependency on its order; the local overpayment guard; offline card refused (`OFFLINE_CARD_UNSUPPORTED`).
- Price changed → conflict → accept server price → order at the server price, cash as taken, balance visible.
- Disabled product → conflict → discard needs a reason → its cash becomes a conflict.
- Provisional stock and two-device overselling → conflict; server stock untouched.
- Kitchen: offline actions with a lost response (no duplicate); conflict after an item was removed elsewhere; a kitchen action on an offline order mapped to server items.
- Shift: offline movement and close once; closed elsewhere → `SHIFT_CLOSED`.
- Tenant and user mismatch; a forged tenant claim; `KEY_REUSED`; foreign records quarantined.
- Permission revoked → session revoked (Pending) → Failed (403) → restored → retry → Synced.
- Backoff: no resend before the timer; Failed after 8; manual retry.
- Storage full: nothing half-saved. Corrupted records quarantined.
- Stale and future-dated records refused.
- Connection drop mid-request: the offline copy with the same key produces no second order or payment.

**Offline browser checks:**
- service worker control
- **refresh while offline**: shell, restored session and cached menu
- snapshot age badge; device estimate
- two offline orders; offline cash, marked local
- **KDS in the same browser shows the offline orders**; offline kitchen action
- second offline refresh keeps everything; nothing reached the server
- status chip
- **reconnect → automatic sync, exactly once**: confirmed to the kitchen, server-priced, `offline.deviceId` set, cash once and paid, kitchen action synced with the cook's name
- POS shows them confirmed; repeated syncs create no duplicates
- **backend process stopped mid-shift → order saved locally → backend restarted → synced once**
- per-tenant, per-user database; another restaurant's origin cannot see it
- logout deletes local data when nothing is waiting; the offline POS then requires sign-in
- no uncaught exceptions

**Bug found and fixed during browser testing:** if the backend went down while the browser still believed it was online, the server price quote failed and "Send to kitchen" stayed disabled. A network failure on the quote now switches the POS to offline mode immediately.

## 7. Known limitations and incomplete work

- **Multi-device offline over a LAN:** not implemented (see §5); a local gateway is required.
- **Not available offline:** refunds, card and online payments, coupons, opening shifts, item-based splits, and changes to orders already on the server.
- **Offline equal split** suggests amounts on the device and records plain cash amounts. The server's split allocation is not used for offline payments.
- **Offline session:** valid for 24 h after the last online validation. Signing in requires the server.
- **Logout with unsynced records** keeps them on the device (to avoid losing orders or cash) until the same person signs in again. Clearing browser data at that point would lose them; the guide warns about this.
- **Kitchen timestamps** from offline devices use the device clock, clamped between the order's confirmation and the server time.
- **Server-side indexes** are additive and created at the next server start: `syncreceipts {tenantId, key}` unique; `orders {tenantId, idempotencyKey}` from the earlier phase. The dev configuration still points at the shared Atlas `test` database (TS-016); that owner decision still applies before starting a server against it.
- **Not tested** on physical tablets, iOS/Safari or Firefox; only Chrome (headless).
- **Hardware:** no direct printer, cash-drawer or card-terminal integration.
