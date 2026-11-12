# TableSaaS — Complete Platform Guide

## What TableSaaS is

TableSaaS is an online platform that runs many restaurants, cafés and hotels from one system. Each restaurant gets:

- its own **website and QR menu** at its own address, e.g. `the-broast.yourdomain.com` (locally: `http://the-broast.localhost:5173`);
- a **restaurant dashboard** for menu, tables and QR codes, orders, kitchen, staff, payments, stock and reports;
- **live ordering**: a customer scans the QR on a table, orders from their phone, and the order appears instantly on the restaurant's screens.

Every restaurant's data is kept completely separate: one restaurant can never see another's menu, orders, staff or customers.

## How it fits together

```
                ┌───────────────────────── TableSaaS platform ─────────────────────────┐
 Super Admin ──▶│ Platform console (yourdomain.com)                                      │
                │   creates restaurants · plans · subscriptions · support                │
                │                                                                         │
 Restaurant ───▶│ <restaurant>.yourdomain.com/dashboard    ◀── live updates ──┐           │
 owner & staff  │   menu · tables & QR · orders · kitchen · staff · reports    │           │
                │                                                              │           │
 Customer  ────▶│ <restaurant>.yourdomain.com  (no login)  ── places order ───┘           │
 (phone)        │   menu · cart · checkout · order tracking · reservations                │
                └─────────────────────────────────────────────────────────────────────────┘
```

- **One address per restaurant.** The part before the domain (the *subdomain*, e.g. `the-broast`) tells TableSaaS which restaurant to show.
- **One design for every restaurant.** All storefronts share the same professionally designed layout. Each restaurant brands it with its logo, colours, fonts, photos and text.
- **Live.** New orders, kitchen progress and "order ready" alerts arrive on staff screens and the customer's tracking page without refreshing.

## Types of users

| User | Signs in at | Does |
|---|---|---|
| **Super Admin** (platform operator) | `yourdomain.com/login` | Creates restaurants and their owner accounts, manages plans and subscriptions, suspends or reactivates restaurants, supports restaurant accounts |
| **Owner** | `<restaurant>.yourdomain.com/login` | Everything in their restaurant, including payment settings and staff |
| **Admin** | same | Everything except online-payment configuration |
| **Manager** | same | Daily operations: menu, tables, orders, kitchen, payments, refunds, reservations, customers, coupons, reports |
| **Waiter** | same | Takes and serves orders, manages reservations, sees tables |
| **Cashier** | same | Collects payments, sees orders and customers |
| **Kitchen** | same | Kitchen display: prepares items and marks them ready |
| **Inventory manager** | same | Stock, suppliers and purchase orders |
| **Customer** | the restaurant's website or QR | Browses the menu, orders, tracks the order, pays, reserves a table, leaves feedback. No account needed |

Exact permissions per role are in `STAFF_USER_GUIDE.md`.

## How a restaurant uses TableSaaS

1. The Super Admin creates the restaurant, its subdomain, plan and owner account.
2. The owner signs in, changes the temporary password, then adds branding, menu, tables and staff.
3. The owner prints the table QR codes and places them on the tables.
4. Customers scan, order and pay; staff accept, cook, serve and collect payment.
5. The owner follows sales, payments and stock in **Dashboard** and **Analytics**.

## How customers use a storefront

Scan a table QR (or open the restaurant's address) → browse categories, offers and chef's picks → open a dish, choose options and extras → add to order → choose dine-in or takeaway, optionally add name, phone, notes and a coupon → place the order → follow live progress on the tracking page → pay at the counter or online (if the restaurant has set up online payments) → rate the experience. Details: `CUSTOMER_USER_GUIDE.md`.

## The order lifecycle in one picture

```
Customer orders ─▶ NEW (pending) ─▶ ACCEPTED ─▶ PREPARING ─▶ READY ─▶ SERVED (delivered) ─▶ COMPLETED
                        │                │            │           │
                        └▶ REJECTED      └────────────┴───────────┴▶ CANCELLED ─▶ (REFUNDED)
Payment (separate): UNPAID ─▶ PART PAID ─▶ PAID ─▶ (PART REFUNDED / REFUNDED)
```

The full rules are in `COMPLETE_ORDER_WORKFLOW.md`.

## Subscriptions and plans

Each restaurant is on a plan (default: Starter, Growth, Pro) that sets limits (staff, dishes, tables) and features (QR ordering, kitchen display, inventory, reservations, online payments, loyalty, report exports, multiple languages). New restaurants start on the plan's free trial. When a trial or paid period ends, the restaurant becomes **read-only** and its website goes offline until the Super Admin renews it. Paid periods have a 7-day grace period. Subscription payments are recorded by the Super Admin; TableSaaS does not charge restaurants automatically.

## Where to go next

| You are | Read |
|---|---|
| Platform operator | `SUPER_ADMIN_USER_GUIDE.md`, `CLIENT_HANDOVER_CHECKLIST.md` |
| Restaurant owner | `CLIENT_ONBOARDING_GUIDE.md`, then `RESTAURANT_OWNER_USER_GUIDE.md` |
| Restaurant staff | `STAFF_USER_GUIDE.md` |
| Anyone with a problem | `TROUBLESHOOTING_GUIDE.md` |
| Want to know what exists | `PLATFORM_FEATURE_STATUS.md`, `MODULE_REFERENCE_GUIDE.md` |
