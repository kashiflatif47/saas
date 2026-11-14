# TableSaaS: menu option pricing fix (Halwa Puri, Rs 2,850)

**Dates:** 2026-11-14 to 2026-11-15 · **Status:** implemented and tested locally. **Not deployed, committed or pushed.**
Backups of every modified file: `_backup_restaurant_pricing_20261114/` (same relative paths).

## 1. Root cause

The bug was in the **data model**, not in one screen.

- A dish option (`variants[]`) could only store `priceDelta`, an amount **added** to the dish price. There was no
  way to say "this option *is* the price".
- The admin field for it was labelled **"+ price"**. An owner who typed each option's full price
  (Three Persons = 2,000) stored a +2,000 delta.
- Every price calculation applied `dish effective price + delta + add-ons`: 850 (promo) + 2,000 = **2,850**.
- The calculation existed in **seven separate places**, all additive:
  - `server/src/lib/pricing.ts` `computeUnitPrice` (the price actually charged)
  - its offline copy, `client/src/offline/pricing.ts`, used through `client/src/offline/estimate.ts`
  - React price previews in `MenuView.tsx` (product sheet), `Pos.tsx` and `NewOrderModal.tsx`, each with its own copy of
    the promo logic
- The architecture underneath was sound. The server already priced every order from database records (the client sends
  IDs), stored price snapshots, used idempotency keys and enforced an order state machine. So every channel agreed on the
  wrong number.

## 2. The new pricing model

One pure module decides what a selection costs: `server/src/lib/menuPricing.ts`. Its byte-identical browser copy is
`client/src/offline/menuPricing.ts`, and a test fails if the two ever differ. The server, storefront, cart, POS, staff
order entry and the offline estimate all call the same `resolveSelection()`. The server re-resolves every order from the
database; any price a browser sends is stripped by validation before it reaches pricing.

| Kind | Pricing rule |
|---|---|
| **Options**, `variantPricing: 'replace'` (sizes, portions, persons, packages, deals) | The option's own price **replaces** the dish price. Its sale price applies while the sale runs. The dish promo is **never** applied to an option, and the dish price is never added. |
| **Options**, `variantPricing: 'add'` (legacy) | Dish price + delta. Kept only so existing dishes keep charging exactly what they charge today. |
| **Extras** | Price × quantity, added on top. Each extra has its own maximum quantity (default 1). |
| **Choice groups** (sauce, crust, toppings, meal upgrade, substitution) | Must choose between `minSelect` and `maxSelect`. Each choice has a price (0 = included). `freeQty` makes that many paid units free, cheapest first. |
| **Removable ingredients** | Never change the price. Shown to the kitchen as "No onions". |

The order is then priced in a fixed sequence (unchanged, defined in `pricing.ts`). **Each discount is applied once:**

1. Unit price = selected base + extras + choices. Line total = unit price × quantity.
2. Subtract staff line discounts.
3. Subtract the coupon, calculated on the already-discounted subtotal, or on eligible lines only for restricted coupons.
4. Subtract the manual order discount.
5. Add the service charge, calculated on the discounted amount.
6. Add the delivery fee.
7. Apply tax on (discounted amount + service charge + delivery fee): extracted from the price when tax is inclusive,
   added on top when exclusive.

All arithmetic is in integer minor units (paisa), and no amount can go below zero.

**Inventory per unit sold:** dish recipe × the option's recipe multiplier (for example 3 for Three Persons), plus each
extra's or choice's linked ingredient × its quantity, minus removed ingredients. This consumption is stored on the order
item when the order is placed, so later recipe edits never change what an old order deducts. Deduction still happens once,
when the order is accepted, guarded by the existing `inventoryDeducted` flag. Cancelling returns the ingredients.

## 3. Files

**Server**

- New:
  - `src/lib/menuPricing.ts` (the rules and the configuration validator)
- Changed:
  - `src/lib/pricing.ts`: add-on quantities
  - `src/models/menu.ts`: new option fields
  - `src/models/operations.ts`: order item snapshot fields
  - `src/routes/menu.ts`: product validation
  - `src/routes/orders.ts`: order request fields
  - `src/routes/public.ts`: `displayPrice`, only active options shown, internal fields hidden from guests
  - `src/services/orderService.ts`: `buildLines` uses the resolver; shared `itemSnapshot`
  - `src/services/orderOps.ts`: items added to open orders use the same snapshot; receipt labels
  - `src/services/inventoryService.ts`: consumption snapshot
  - `src/seed.ts`: demo dishes use replacement pricing

**Client**

- New:
  - `offline/menuPricing.ts` (verbatim copy of the server module)
  - `components/OptionSelector.tsx` (one picker for storefront, POS and staff order entry)
  - `lib/options.ts`
  - `pages/owner/ProductOptionsEditor.tsx`
- Changed:
  - `store/cart.tsx`: lines store the selection; old saved carts are upgraded when loaded
  - `pages/store/MenuView.tsx`, `pages/staff/Pos.tsx`, `components/NewOrderModal.tsx`: shared selector; duplicate price
    formulas removed
  - `offline/estimate.ts`, `offline/types.ts`, `offline/pricing.ts`: offline estimate uses the same rules
  - `pages/owner/Menu.tsx`: new options editor; real customer price in the dish list; warning on legacy dishes
  - `Kitchen.tsx`, `OrderDrawer.tsx`, `LocalOrders.tsx`, `Receipt.tsx`, `OrderTracking.tsx`: show quantities, included
    choices and removed ingredients
  - `i18n/index.tsx`: new storefront labels in English, Urdu and Arabic

## 4. Database and migration safety

- **Additive only.** No collection dropped, no data rewritten, no migration script.
- New product fields, all optional: `variantPricing`, `variantGroupName`, `variantRequired`,
  `variants[].{price, salePrice, saleEndsAt, isActive, recipeMultiplier}`, `addons[].{maxQty, ingredient}`,
  `modifierGroups[]`, `removableIngredients[]`.
- New order item fields: `variantId`, `pricingMode`, `basePrice`, `listPrice`, `addons[].{id, quantity, group, included}`,
  `removed`, `consumption`.
- **Existing dishes** have no `variantPricing`, so they are read as legacy `add` and keep charging exactly what they charge
  today. The existing test suite passed unchanged after the engine change.
- **Existing orders** keep their stored prices. Orders placed before this change have no consumption snapshot and fall back
  to the current recipe, which is the old behaviour.
- `tenantId` and all tenancy fields are untouched.

**Fixing Halwa Puri in production is a deliberate owner action.** The dish list marks it "Options add to the dish price —
review". The editor shows what each option costs today (2,850) and offers two buttons:

- **"They are full prices"**: options become 500 / 1,000 / 2,000.
- **"Keep what customers pay now"**: replacement pricing that reproduces today's amounts, including the promo.

Nothing changes until the owner chooses and saves.

## 5. Tests added (all passing)

- `tests/unit/menuPricing.test.ts` (14 tests): the full Halwa Puri table (850 / 500 / 1,000 / 2,000 / 2,100 / 2,200 /
  4,000); missing, invalid and inactive options; over-limit extras; optional options; option sale prices; no stacking of
  the dish promo; each discount applied once through `priceOrder`; legacy dishes; pizza sizes, crust and included
  toppings; ingredient removal; inventory multipliers; menu card "from" price; cart line keys; configuration validation.
- `tests/integration/menuOptions.test.ts` (14 tests, real API and database), covering in order:
  - admin create and validation; public menu
  - storefront orders, including the legacy request form
  - rejections; client-sent prices ignored
  - POS quote, staff order, order detail, kitchen ticket, receipt and cash payment all at 2,100
  - items added to an open order (2,200); customer tracking (4,000)
  - historical prices preserved after a menu change
  - option sale + coupon each applied once
  - choice groups and removals (burger); legacy additive dish
  - inventory deducted once and returned on cancellation; duplicate checkout returns the first order; guests never see
    internal ingredient data
- `tests/unit/clientPricingFlow.test.ts` (4 tests): the same scenario through the browser code (product-page preview,
  cart → checkout payload accepted by the server schema, offline POS estimate) agrees with the server.
- `tests/unit/offlinePricingParity.test.ts`: the browser pricing module must be a verbatim copy of the server module.

## 6–7. Commands and results (2026-11-15)

| Command | Result |
|---|---|
| `npm --prefix server run typecheck` | pass |
| `npm --prefix server test` | **221 / 221 pass** (was 188; +33 new tests) |
| `npm --prefix server run build` | pass |
| `npm --prefix client run typecheck` | pass |
| `npm --prefix client run build` | pass |
| Client tests | none: the client has no test runner. Its pricing logic is tested from the server suite (above). |

## 8. Workflows verified by automated tests

Product configuration, storefront and QR ordering, cart payload, POS quote, staff orders, adding items to open orders, order
details, kitchen queue, receipt, cash payment, customer tracking, coupon and discount stacking, idempotent checkout,
historical price preservation, inventory deduction and return. The existing suite also passes: tenant isolation,
permissions, order state machine, offline sync, delivery, marketing.

## 9. Not done in this pass, or not verified

- **No browser click-through.** The project has no browser test tool, so the UI (option picker, cart, admin editor, mobile
  layout) was type-checked and built but not exercised in a browser.
- **Phases 3–4 were not re-implemented.** POS split bills, KDS item-status concurrency, payments, tax settings, roles,
  restaurant settings and theming were not reworked. They are covered only by the existing tests, which pass. The order
  state machine, optimistic-concurrency retries, payment idempotency keys and backend permission checks already exist; I
  did not audit them in depth here.
- **Inventory UI scope:** choice options can be linked to an ingredient through the API, but the editor only offers
  ingredient links for extras and removable ingredients, plus a recipe multiplier per option.
- **No multi-document transactions.** Stock reservation and inventory use atomic conditional updates with compensation (the
  existing approach), not MongoDB transactions.
- **Product-level discount inheritance by options is deliberately not supported.** Options use their own sale prices. This
  is the explicit rule that prevents double discounting.

## 10. Manual browser checklist (local, before any deploy)

1. **Menu → Halwa Puri:**
   - The card shows the amber "Options add to the dish price" warning.
   - Open it, choose **"They are full prices"**, check that "Customer pays" reads 500 / 1,000 / 2,000, and save.
2. **Add an extra:** Extra Cheese, 100, max qty 2.
3. **Storefront product sheet:**
   - Choose an option: the button shows 2,000.
   - Add 1 cheese: 2,100. Add 2 cheese: 2,200.
   - Add the dish without choosing an option: blocked with "Choose an option".
4. **Cart:** two Three Persons → 4,000. A different configuration stays on its own cart line. Place the order.
5. **POS:** same selections → the line, the quote total and the order total all match. Take cash; print the receipt.
6. **Kitchen display:** shows "Three Persons", "2× Extra Cheese" and any "No …" removals.
7. **History:** change the Three Persons price, then reopen the earlier order: its total is unchanged.
8. **Phone width:** check the storefront sheet and the admin editor.
