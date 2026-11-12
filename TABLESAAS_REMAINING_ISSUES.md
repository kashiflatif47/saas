# TableSaaS — Remaining Issues

**Date:** 2026-11-11 · Items found during the bug audit that were **not** changed, with the reason and the next step. IDs continue from `TABLESAAS_BUG_AUDIT.md`.

## Needs an owner decision

### TS-016 · Development and planned production share MongoDB's `test` database (High)
- **Exact problem:** the Atlas URI in `server/.env` has no database name, so MongoDB uses `test`. The same configuration was chosen for production in the deployment report.
- **Why unresolved:** these instructions forbid changing database targets or touching existing data without authorisation.
- **Decision needed:** keep `test` deliberately, or create e.g. `tablesaas_prod` (empty) and a separate development database.
- **Next action:**
  1. Add a database name to the production URI.
  2. Point development at its own database (local MongoDB or a separate Atlas database).
  3. Only then run `npm run test:local-routing`, which **writes test restaurants into the dev server's database**. It was deliberately not run in this pass.
  4. Note that the next server start creates the new partial index `orders {tenantId, idempotencyKey}` on whichever database is configured. It is additive and affects no existing documents.

### TS-017 · Cancelling an order returns stock for dishes already prepared or served (Medium)
- **Exact problem:** cancellation restores tracked product stock and recipe ingredients for every item, even items that were `ready` or `served`.
- **Why unresolved:** this is a business rule (wastage vs. return), not a technical defect. Changing it alters inventory numbers.
- **Decision needed:** should prepared or served items count as wastage on cancellation?
- **Next action:** if yes, skip restoration for items past `queued`/`preparing`, and record them as wastage.

### TS-018 · Seating a reservation marks the table occupied, but completing it does not free the table (Low)
- **Why unresolved:** whether completion should set the table to `cleaning` or `available` is an operational choice.
- **Next action:** set the table to `cleaning` when a seated reservation becomes `completed` or `no_show`.

## Needs external credentials or access

### TS-019 · Stripe online payments are not verified against a real account
- **Exact problem:** the integration (intent creation, signed webhooks, refunds) is covered by unit and integration tests with stubbed network access only.
- **Why unresolved:** no Stripe test-mode credentials were provided, and real transactions must not be used.
- **Next action:** with **test-mode** keys, verify credential check → intent → webhook (`payment_intent.succeeded`) → order shows paid → partial refund.

### TS-020 · A stale payment intent for a different amount can still be paid (Medium)
- **Exact problem:** TS-009 reuses an open intent for the **same** amount. If cash is collected after an online form was opened, the balance changes and the next press creates a new intent. The old intent can still be confirmed by a customer who kept that tab open, so verified payments can exceed the order total.
- **Why unresolved:** the correct fix cancels the stale intent through the Stripe API (`POST /v1/payment_intents/:id/cancel`), which cannot be verified without credentials (TS-019).
- **Next action:** cancel pending intents when a new one is created or cash covers the balance. Flag overpayments for refund in the order panel.

## Low-risk edge cases (documented, not changed)

### TS-021 · Narrow cash-payment race with a concurrent webhook recompute
- **Exact problem:** the TS-003 fix makes cash collection atomic. A webhook recompute for the **same order** landing in the few milliseconds between the cash claim and the payment insert can briefly release the claim.
- **Why unresolved:** it needs a simultaneous online and cash payment on one order; closing it fully needs a transaction-based ledger, which is a larger change than this phase allows.
- **Next action:** move payment recording into a MongoDB transaction (the Atlas cluster is a replica set, so transactions are available).

### TS-022 · After changing your own password, your *other* devices' live screens stay connected until they reconnect
- **Why unresolved:** closing the user's sockets inside the change-password request races the new session cookie and could trip the refresh-token reuse guard. Admin-initiated revocations (TS-006) do close sockets.
- **Next action:** close only sockets whose token predates the change (store `tokenVersion` on the socket and compare on emit).

### TS-023 · An `inventory_manager` on a plan without Inventory lands on a page that returns 402
- **Why unresolved:** cosmetic; the API correctly refuses access.
- **Next action:** route that role to `/dashboard` when the `inventory` feature is missing (`client/src/App.tsx`, `homeFor`).

### TS-024 · Timezone names accepted by Node but unknown to MongoDB
- **Exact problem:** analytics groups by timezone inside MongoDB (`$dateTrunc`). A zone valid in Node's ICU but missing from the server's timezone database would fail there.
- **Why unresolved:** not observed. Atlas ships a current timezone database.
- **Next action:** none unless reported.

## Not tested in this pass
- Physical phones, Safari/iOS and Firefox: only Chrome (headless, device emulation) is available on this machine.
- The socket token-expiry reconnect path (TS-005) in a real browser: it needs a 15-minute idle token and a dropped connection.
- `npm run test:local-routing`: writes to the dev database (see TS-016).
- `docker build`: Docker is not installed.

## Features known to be missing (not bugs; out of scope for this phase)
Carried over from `docs/TABLESAAS_USER_GUIDE/PLATFORM_FEATURE_STATUS.md`. **No code exists for these**, so they cannot be "repaired" without building them:
- expenses module
- platform settings screen
- super admin user-management screen (CLI only)
- platform reports beyond Overview
- owner subscription/billing page
- automated subscription billing
- SMS/e-mail notifications
- delivery dispatch

## Scope note: premium redesign request
The request contained a pasted section asking for a glassmorphism redesign in this pass. The request's own Phase 12 explicitly excludes any redesign. Functional work came first under both versions, so this pass made no visual changes. A premium redesign was already completed on 2026-11-10 (`TABLESAAS_PREMIUM_REDESIGN_FINAL_REPORT.md`). The 143 page states checked today show no layout regressions. **Decision needed:** whether a further glassmorphism-specific visual pass should be the next phase.
