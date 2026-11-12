# Module Reference

Every module that exists in the application, from the routes and navigation in `client/src/App.tsx` and the API permissions in `server/src`. "Plan feature" means the module only appears if the restaurant's plan (or a Super Admin override) includes it.

## Platform console (Super Admin) — `https://yourdomain.com`

| Module | Route | Purpose | Manages | Limitations |
|---|---|---|---|---|
| Overview | `/admin` | Platform health at a glance | Restaurants count, 30-day orders and GMV, paying MRR, orders per day, subscription mix, most active restaurants | 30-day window only; GMV is shown in one currency format |
| Restaurants | `/admin/tenants` | Find and create restaurants | Restaurant list, search, filters, **New restaurant** (restaurant + owner account) | — |
| Restaurant detail | `/admin/tenants/:id` | Support one restaurant | Status (suspend/reactivate), subscription (renew, trial, status), feature overrides, owner password, restaurant details, staff accounts (reset/unlock/deactivate), custom domain | Subdomain can't be changed after creation |
| Plans | `/admin/plans` | Commercial packaging | Price, trial days, limits, features, availability | Prices are informational: no automated billing |
| Audit log | `/admin/audit` | Accountability | Platform actions with actor, time, IP | Read-only |

## Restaurant dashboard — `https://<subdomain>.yourdomain.com/dashboard`

| Module | Route | Who (permission) | Plan feature | Purpose / manages | Related | Limitations |
|---|---|---|---|---|---|---|
| Dashboard | `/dashboard` | orders:view | — | Today's sales, collections, active orders, tables, latest orders, pipeline, reservations, low stock, tax | Orders, Analytics | Kitchen and inventory roles are redirected to their own screens |
| Orders | `/dashboard/orders` | orders:view | — | Live order list and tabs; order panel with actions, timeline, payments, refunds, waiter assignment; **New order** | Kitchen, Payments | — |
| Kitchen display | `/dashboard/kitchen` | kitchen:operate | `kds` | Live tickets by station; start/ready per item; bump; full screen | Menu → Kitchen stations | — |
| Waiter view | `/dashboard/waiter` | orders:deliver | — | Ready / New / In kitchen / Served tabs; tables; **Take order** | Tables | Waiters see their tables, their orders and unassigned new/ready orders |
| Payments | `/dashboard/payments` | payments:collect or analytics:view | — | Awaiting payment; transaction history with filters | Orders, Settings → Payments | Online card payments need Stripe set up per restaurant |
| Reservations | `/dashboard/reservations` | reservations:manage | `reservations` | Booking list, create/edit, status, table, double-booking guard | Tables, storefront **Book a table** | No automatic SMS or e-mail confirmations |
| Menu | `/dashboard/menu` | menu:manage | — | Categories (2 levels, schedule, station, image), dishes (prices, promo, options, add-ons, tags, stock, recipe, photos, availability, featured, archive), kitchen stations | Storefront, Kitchen, Inventory | Up to 8 photos per dish |
| Tables & QR | `/dashboard/tables` | tables:view (manage to edit) | — | Tables, areas, seats, status, QR PNG/SVG/PDF, new QR | Storefront QR landing | — |
| Inventory | `/dashboard/inventory` | inventory:view (manage to edit) | `inventory` | Stock items, adjustments and wastage, movement history, purchase orders, suppliers | Menu recipes | No expense tracking |
| Customers | `/dashboard/customers` | customers:manage | — | Customer records (auto-created from orders with a phone), visits, spend, loyalty points | Settings → loyalty | — |
| Feedback | `/dashboard/feedback` | feedback:view | — | Ratings and comments, average, **publish** to the website, reply | Storefront "What guests say" | Only after an order is served |
| Coupons | `/dashboard/coupons` | coupons:manage | — | Percent / fixed coupons, minimum order, cap, dates, usage limit | Checkout | — |
| Analytics | `/dashboard/analytics` | analytics:view | export: `analytics_export` | Period summaries, sales trend, collections, top dishes and categories, busy hours, CSV/PDF export | Payments | — |
| Staff & roles | `/dashboard/staff` | staff:view (manage to edit) | plan staff limit | Accounts, roles, per-person permissions, tables, stations, activity | — | Only one owner; only the owner manages admins |
| Branding | `/dashboard/branding` | branding:manage | — | Logo, favicon, hero, cover, colours, fonts, radius, website texts, socials, live preview | Storefront | Layout is fixed by design; colours, fonts and content are customisable |
| Settings | `/dashboard/settings` | settings:manage or payments:configure | languages: `multi_language`; online: `online_payments` | General profile; ordering, tax, currency, time zone, hours, languages, loyalty; payments (cash, Stripe); My account | — | — |
| Audit log | `/dashboard/audit` | audit:view | — | Who changed what and when, in this restaurant | Staff activity | Read-only |
| Notifications | bell (top bar) | notifications:view | — | New orders, ready orders, low stock, reservations, feedback; live with sound | All | — |
| My account | key icon (sidebar) | everyone | — | Change own password | — | — |

## Customer storefront — `https://<subdomain>.yourdomain.com`

| Page | Route | Purpose |
|---|---|---|
| Home / menu | `/` | Hero, info strip, offers, chef's picks, menu with search and category bar, reviews, dish details, cart and checkout |
| QR landing | `/t/:token` | Validates the table code, remembers the table, opens the menu |
| Order tracking | `/order/:id?token=…` | Live status, payment status, pay online (if configured), feedback |
| Reservations | `/reserve` | Booking request (plan feature `reservations`) |

## Not implemented (no screens exist)
Expenses · platform settings screen · Super Admin user management screen (CLI only) · Super Admin reports beyond Overview · owner subscription/billing page · delivery dispatch · SMS/e-mail notifications. See `PLATFORM_FEATURE_STATUS.md`.
