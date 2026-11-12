# TableSaaS — Fixes Report

**Date:** 2026-11-11 · Companion to `TABLESAAS_BUG_AUDIT.md` (full root-cause analysis) and `TABLESAAS_TEST_RESULTS.md` (all measured results).

**Constraints kept**
- No visual redesign.
- No new dependencies.
- No schema redesign. One optional field and one additive partial index on `orders`.
- No deployment.
- No reads or writes against the Atlas database: all testing used in-memory MongoDB.
- No existing test was modified, skipped or deleted.

## Fixed issues

| ID | Original problem | Root cause | Files modified | Fix | Test | Result |
|---|---|---|---|---|---|---|
| TS-001 | Invalid timezone → storefront menu, dashboard and analytics return 500 | No IANA validation on the owner settings route; `Intl` throws `RangeError` | `server/src/lib/timezone.ts` (new), `routes/tenantAdmin.ts`, `routes/superadmin.ts`, `services/tenantResolver.ts` | Validate on save; resolver falls back to UTC for stored bad values | `BUG-001`, `BUG-001b` | Failed before, pass after |
| TS-002 | Starter-plan owners get 402 on every Settings save | Provisioning set 3 languages regardless of plan; check compared count, not additions | `routes/superadmin.ts`, `routes/tenantAdmin.ts` | Plan-aware default languages; refuse only *adding* languages without the feature | `BUG-002`, `BUG-002b` | Failed before, pass after |
| TS-003 | Concurrent cash payments over-collect | Non-atomic check-then-insert | `services/paymentService.ts` | Atomic compare-and-set claim on `amountPaid`; totals re-derived from verified records in `finally` | `BUG-003` | 3×201 before → exactly 1×201 after |
| TS-004 | Concurrent accepts applied 3×, stock deducted 3× | Orders saved without optimistic concurrency | `models/operations.ts`, `services/orderService.ts`, `services/paymentService.ts`, `services/inventoryService.ts`, `middleware/error.ts` | `optimisticConcurrency`; `withOrderRetry` re-validates after conflicts; atomic inventory flag; VersionError → 409 | `BUG-004`, `BUG-004b` | Failed before, pass after; concurrent item updates still both succeed |
| TS-005 | Live staff screens stop updating after token expiry + reconnect; missed events never re-fetched | Static socket auth token; middleware rejections are not retried by socket.io | `client/src/hooks/useSocket.ts`, `client/src/api/client.ts`, `Kitchen.tsx`, `Waiter.tsx`, `Orders.tsx`, `Dashboard.tsx`, `DashboardLayout.tsx` | Token read on each connect; refresh + reconnect on `unauthorized`; `reconnect` handlers reload data | Typecheck/build; browser kitchen live check | Live path verified; expiry path not reproduced in a browser (see audit) |
| TS-006 | Deactivated staff / suspended tenants keep receiving live orders | Sockets authenticated only at handshake | `server/src/sockets/index.ts`, `routes/tenantAdmin.ts`, `routes/superadmin.ts`, `client/src/hooks/useSocket.ts` | Per-user rooms; revocations and suspensions close sockets | `BUG-012` | Fails without fix, passes with it |
| TS-007 | Any staff profile edit signs the person out; owners sign themselves out | Revocation triggered by field *presence* | `routes/tenantAdmin.ts` | Revoke only on real role/override/activation/password change | `BUG-010` | 401 before → 200 after; real role change still revokes |
| TS-008 | Duplicate orders on retry or double tap | No idempotency | `routes/orders.ts`, `services/orderService.ts`, `models/operations.ts`, `client/src/pages/store/MenuView.tsx` | Client checkout key + unique partial index; duplicates return the original order; same-tick click guard | `BUG-005`; browser double-click | Failed before, pass after; 1 order from a double click |
| TS-009 | Each "Pay online" press opens a new intent; network errors → 500 | No reuse of pending intent; `fetch` errors unhandled | `services/paymentService.ts` | Reuse open intent for same amount; 502 + 20 s timeout on provider failures | `BUG-011` (network stubbed) | Failed before, pass after |
| TS-010 | Stock/coupon released for an order that was created | Catch block rolled back unconditionally | `services/orderService.ts` | Roll back only if the order was not created | Code review + full suite | No direct reproduction (needs failure injection) |
| TS-011 | Cash recordable on cancelled orders | Status list omitted `cancelled` | `services/paymentService.ts` | Refused, consistent with online payments | `BUG-006` | Failed before, pass after |
| TS-012 | Staff reactivation bypasses plan limit | Limit checked only on create | `routes/tenantAdmin.ts` | Checked on reactivation | `BUG-008` | Failed before, pass after |
| TS-013 | Restoring archived dish bypasses plan limit | Limit checked only on create | `routes/menu.ts` | Checked on un-archive | `BUG-013` | Fails without fix, passes with it |
| TS-014 | Category with children nestable → 3 levels | Parent check ignored the moved category's own children | `routes/menu.ts` | Refused with clear message | `BUG-007` | Failed before, pass after |
| TS-015 | Tracking page loses option names; amount due not updated live | Reduced item objects replaced full ones; no `amountPaid` in payload | `services/orderService.ts`, `client/src/pages/store/OrderTracking.tsx` | Totals in payload; merge items by id; reload after reconnect | Browser functional checks 3 and 4 | Pass |

## Behaviour changes worth knowing

- **Concurrent edits of one order:** the losing request now gets a clear 400 ("Cannot change order from accepted to accepted") or 409 ("…just updated… refresh"). Before, it silently succeeded twice.
- **Server-closed sockets:** after a role change, the person's open screens reconnect with their new permissions. A deactivated person's screens disconnect and stay disconnected.
- **Settings for languages:** on plans without multi-language, adding a second language is still refused (402). An existing set can always be re-saved.
- **New index:** `orders {tenantId, idempotencyKey}` (unique, partial: only documents that have a key). It is created automatically on the next server start against the configured database. See TS-016 in the audit before starting a server against the shared Atlas `test` database.

## Tests added
`server/tests/integration/regressions.test.ts`: 16 tests.
- 15 are regression tests (`BUG-001` … `BUG-013`, including `001b`, `002b`, `004b`). Each names the audit issue it covers.
- 1 coverage test for changing your own password, a required workflow that had no test. It uses the same in-memory MongoDB helpers as the existing suites and stubs `fetch` wherever a payment provider could be called.

## Not changed on purpose
- Visual design: unchanged. The only UI-adjacent edits are the checkout click guard and the live merge on the tracking page, both functional.
- Database target and data: unchanged (owner decision, TS-016).
- Items in `TABLESAAS_REMAINING_ISSUES.md`: unchanged, with reasons.
