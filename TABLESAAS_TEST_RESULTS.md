# TableSaaS — Test Results

**Date:** 2026-11-11 · Machine: Windows 11, Node 24.19.0, Chrome (headless).

All results below are **actual results from this pass**. Every automated run used in-memory MongoDB; nothing touched the Atlas database in `server/.env`.

## Baseline (before any change)

| Check | Result |
|---|---|
| `npm run typecheck` (server src + tests, client) | pass |
| `npm test` (unit + integration) | **69/69 pass** |

The historical figures (67/67 tests, 20/20 E2E, 27 and later 100 browser states) were treated as history only. The current suite had 69 tests before this pass.

## Reproduction of discovered bugs (before fixes)

`server/tests/integration/regressions.test.ts` was run against the unmodified code. Every reproduction **failed**, confirming each bug:

| Test | Failure observed before the fix |
|---|---|
| BUG-001 | Invalid timezone accepted (200); `RangeError: Invalid time zone specified` confirmed in the menu path |
| BUG-002 | New Starter tenant had `['en','ur','ar']`; settings save → 402 |
| BUG-002b | Existing multi-language tenant on Starter: settings save → 402 |
| BUG-003 | Three concurrent full cash payments → 201, 201, 201 |
| BUG-004 | Three concurrent accepts → 200, 200, 200 |
| BUG-005 | Same checkout key → two different orders |
| BUG-006 | Cash on a cancelled order → 201 |
| BUG-007 | Category with children moved under another → 200 |
| BUG-008 | Reactivation over the staff limit → 200 |
| BUG-010 | Owner's own session → 401 after editing their profile (old logic restored temporarily) |
| BUG-011 | Second "pay" tried to create a new intent (stubbed network) → 500 |
| BUG-012 | Deactivated user's socket stayed connected (timed out waiting for disconnect) |
| BUG-013 | Restoring an archived dish over the limit → 200 (check disabled temporarily) |

## After fixes (final state)

| Check | Command | Result |
|---|---|---|
| TypeScript (server src + tests, client) | `npm run typecheck` | **pass** |
| Server build | `npm --prefix server run build` | **pass** |
| Client build (tsc + Vite + PWA) | `npm --prefix client run build` | **pass**, 56 precache entries; main bundle 279 kB, storefront chunk 65 kB (unchanged scale) |
| Unit + integration | `npm test` | **85/85 pass** (69 existing + 16 new), 89 s |
| New regression file alone | `tsx --test tests/integration/regressions.test.ts` | **16/16 pass** |
| E2E business journey (built server + built SPA, real HTTP/Host headers) | `npm run e2e` | **20/20 steps pass** |
| Real-browser sweep (see below) | scratch script, not committed | **143 page states, 0 overflow, 0 console errors; 5/5 functional checks pass** |

**Existing tests:** all 69 pre-existing tests still pass. None was edited, skipped or deleted.

## Real-browser sweep

**Method**
- The built server ran in single-service mode (serving `client/dist`) on a random port against an in-memory MongoDB.
- One restaurant was seeded through the real API.
- Headless Chrome was driven over the DevTools protocol at **390, 768, 1024, 1440 and 1920 px** (mobile emulation below 800 px).

**Coverage: 28 pages per width**
- Platform: login, overview, restaurants, restaurant detail, plans, audit.
- Storefront: menu, order tracking, reservations, unknown path.
- Restaurant login.
- All 17 dashboard pages: home, orders, kitchen, waiter, payments, reservations, menu, tables, inventory, customers, feedback, coupons, analytics, staff, branding, settings, audit.

**Per page, the sweep recorded:**
- uncaught exceptions
- `console.error` calls
- browser error logs (including failed resource loads)
- horizontal overflow (`scrollWidth > innerWidth`)
- unexpected redirects to login
- visible error states

| Result | Count |
|---|---|
| Page states checked | 143 (140 sweep + 3 functional visits) |
| Horizontal overflow | 0 |
| Pages with console errors / exceptions | 0 |
| Unexpected login redirects | 0 |
| Error states | 0 |

**Functional checks in the browser**

| Check | Result |
|---|---|
| QR landing (`/t/<token>`) opens the menu with the "Table T1" badge | pass |
| UI checkout at 390 px: add dish → open cart → **double-click "Place order"** → exactly one new order, tracking page opens | pass (orders 1 → 2) |
| Order tracking updates live after staff accept, and keeps "Chicken Karahi · Full" | pass |
| After cash collection the tracking page shows "Paid" and drops the payment prompt with no reload | pass |
| Kitchen display shows a newly accepted order live | pass |

## Not run, with reasons

| Check | Reason |
|---|---|
| `npm run test:local-routing` | **Writes** test restaurants into the dev server's database, which is the shared Atlas `test` database (TS-016) |
| Socket token-expiry reconnect in a browser | Needs a 15-minute idle token plus a dropped connection; fix verified by build and code path only |
| Stripe test-mode round trip | No credentials provided; never use real transactions |
| Safari/iOS, Firefox, physical phones | Not available on this machine |
| `docker build` | Docker not installed |
| Load/performance testing | Out of scope for this phase |
