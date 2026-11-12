# Platform Feature Status

Status: **Fully Implemented** (UI + API + automated test or verified run) · **Partially Implemented** · **Not Implemented** · **Requires Configuration** (works once credentials or settings are supplied) · **Needs Testing** (code complete, not verified end to end).
Evidence: `UT`/`IT` = server unit/integration tests (`npm test`, 69 passing) · `E2E` = `npm run e2e` built-app journey (20/20) · `LR` = `npm run test:local-routing` (9/9) · `BR` = real-browser sweep (100 page states, 5 widths, 0 errors). As of 2026-11-10.

## Platform & security
| Feature | Status | Evidence |
|---|---|---|
| Multi-tenant isolation (API, DB guard, sockets, QR, uploads) | Fully Implemented | `server/src/models/tenantScope.ts`; IT `isolation.test.ts` (15); E2E step 16 |
| Subdomain routing per restaurant (+ local `*.localhost`) | Fully Implemented | `server/src/middleware/tenant.ts`, `lib/appUrl.ts`; LR |
| Custom domain per restaurant (storefront) | Requires Configuration | `superadmin.ts` PATCH; IT "custom domains…"; needs DNS + certificate |
| Authentication (JWT + rotating refresh cookie, lockout, revocation) | Fully Implemented | `routes/auth.ts`; IT `hardening.test.ts`; E2E 3–4, 17–19 |
| Role permissions + per-user overrides with anti-escalation | Fully Implemented | `config/permissions.ts`; IT hardening |
| Production configuration guard | Fully Implemented | `config/env.ts`; UT |
| Audit logs (platform and restaurant) | Fully Implemented | `services/audit.ts`; `admin/Audit.tsx`, Business → audit |

## Super Admin
| Feature | Status | Evidence |
|---|---|---|
| Login, overview statistics, MRR (paying only) | Fully Implemented | `admin/Overview.tsx`; IT MRR test; BR |
| Create restaurant + owner account | Fully Implemented | `admin/Tenants.tsx`; E2E step 5 |
| Edit details, suspend/reactivate, entitlements, custom domain | Fully Implemented | `admin/TenantDetail.tsx`, `TenantAccounts.tsx`; IT; E2E 6, 18 |
| Subscription lifecycle (trial, renew, past due, expire, grace) | Fully Implemented | `jobs/subscriptions.ts`; UT grace; IT expiry |
| Manage restaurant staff accounts (reset/unlock/deactivate) | Fully Implemented | IT "super admin lists and manages…" |
| Plans management | Fully Implemented | `admin/Plans.tsx`; BR |
| Automated subscription billing | Not Implemented | renewals are recorded manually |
| Platform settings screen | Not Implemented | configuration via `server/.env` |
| Super Admin user management screen | Partially Implemented | CLI `npm run superadmin` only |
| Platform reports beyond Overview / platform notifications | Not Implemented | — |

## Restaurant dashboard
| Feature | Status | Evidence |
|---|---|---|
| Dashboard overview | Fully Implemented | `owner/Dashboard.tsx`; BR |
| Profile, ordering rules, tax, service charge, languages, loyalty | Fully Implemented | `owner/Settings.tsx`; E2E step 8 |
| Branding: images, colours, fonts, radius, texts, live preview | Fully Implemented | `owner/Branding.tsx`; E2E 8; BR theme test (3 themes + contrast guard) |
| Categories, subcategories, schedules, stations, category images | Fully Implemented | `owner/Menu.tsx`; E2E 10; BR |
| Dishes: prices, promo, variants, add-ons, tags, availability, featured, stock, recipes, photos, archive | Fully Implemented | `owner/Menu.tsx`, `routes/menu.ts`; E2E 10; IT orderFlow |
| Tables & QR (PNG, SVG, PDF, new QR, status) | Fully Implemented | `owner/Tables.tsx`; E2E 11 (QR decoded); IT |
| Orders, order panel, staff-entered orders, waiter assignment | Fully Implemented | `owner/Orders.tsx`, `OrderDrawer.tsx`; IT orderFlow; E2E 13–14 |
| Kitchen display (stations, item states, bump) | Fully Implemented | `staff/Kitchen.tsx`; IT kitchen routing |
| Waiter view | Fully Implemented | `staff/Waiter.tsx`; BR |
| Cash and card-terminal payments, partial payments, refunds | Fully Implemented | `services/paymentService.ts`; IT; E2E 14 |
| Online card payments (Stripe, per restaurant) | Requires Configuration | Signed webhook verified in IT; **not verified against a real Stripe account** |
| Staff, roles, permission overrides, activity | Fully Implemented | `owner/Staff.tsx`; IT hardening |
| Customers, reservations (double-booking guard), feedback (publish), coupons | Fully Implemented | `routes/business.ts`; IT orderFlow; BR |
| Inventory: stock, movements, purchase orders, suppliers, recipe deduction | Fully Implemented | `owner/Inventory.tsx`, `services/inventoryService.ts`; IT orderFlow |
| Analytics + CSV/PDF export | Fully Implemented | `owner/Analytics.tsx`, `routes/analytics.ts`; IT exports |
| Notifications (bell, live, sound) | Fully Implemented | `DashboardLayout.tsx`; IT socket isolation |
| Expenses | Not Implemented | no model, route or page |
| Owner subscription / billing page | Partially Implemented | trial/expiry banner only |
| SMS / e-mail notifications | Not Implemented | — |
| Delivery dispatch / drivers | Not Implemented | "delivery" exists only as an order type |

## Customer storefront
| Feature | Status | Evidence |
|---|---|---|
| One central premium layout, tenant-branded (colours, fonts, radius, logo, images, texts) | Fully Implemented | `store/StoreLayout.tsx`, `MenuView.tsx`, `lib/util.ts applyTheme`; BR theme test |
| Hero, info strip, offers, chef's picks, menu with scroll-spy categories, search, reviews | Fully Implemented | `store/MenuView.tsx`; BR at 5 widths |
| Dish details (gallery, variants, add-ons, notes, quantity) | Fully Implemented | BR; E2E 13 |
| Cart, order types, coupon, totals, place order | Fully Implemented | E2E 13; BR cart test |
| QR table landing | Fully Implemented | LR; BR; E2E 12 |
| Live order tracking + feedback | Fully Implemented | `store/OrderTracking.tsx`; IT; BR |
| Reservations | Fully Implemented | `store/Reserve.tsx`; IT |
| English / Urdu / Arabic (RTL) | Fully Implemented | `i18n/index.tsx` |
| Online payment on the tracking page | Requires Configuration | see Stripe above |
| Real phone scan of a printed QR | Needs Testing | needs a deployed domain (`*.localhost` is laptop-only) |

## Operations
| Feature | Status | Evidence |
|---|---|---|
| Local multi-subdomain development | Fully Implemented | LR; `TABLESAAS_LOCAL_DEVELOPMENT_GUIDE.md` |
| Production image (Dockerfile) and deployment docs | Needs Testing | Docker not installed on the development machine; image not built yet |
| Live deployment | Not Implemented | not deployed (owner decision) |
