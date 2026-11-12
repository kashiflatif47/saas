# TableSaaS — Pre-Redesign Audit

**Date:** 2026-11-10 · Based on the source code (routes, models, pages, components, tests). Nothing here is assumed from README text.

## 1. Architecture (as built)

| Layer | Implementation | Key files |
|---|---|---|
| Frontend | React 18 + TypeScript, Vite 6, Tailwind 3, React Router 6, PWA | `client/src/App.tsx`, `client/src/main.tsx` |
| Host routing | `localhost` → platform console; `<slug>.<root>` → restaurant (storefront + staff dashboard); custom domain → storefront only | `client/src/lib/util.ts` (`currentTenantSlug`, `isCustomDomainHost`), `client/src/App.tsx` |
| Design layer | Tailwind tokens + CSS variables; shared components | `client/tailwind.config.js`, `client/src/index.css`, `client/src/components/ui.tsx` |
| Tenant theming | Per-tenant CSS variables (`--brand`, `--accent`, `--store-*`, `--radius`, fonts) applied at runtime | `client/src/lib/util.ts` (`applyTheme`) |
| Backend | Express 4 + TypeScript, Zod, Mongoose 8, Socket.IO 4 | `server/src/app.ts`, `server/src/routes/*` |
| Tenancy | Tenant from Host (public) or JWT (staff); DB guard throws on any query missing `tenantId` | `server/src/middleware/tenant.ts`, `server/src/models/tenantScope.ts` |
| Auth | JWT access token (memory) + rotating refresh cookie (host-only), token-version revocation, lockout | `server/src/routes/auth.ts`, `server/src/middleware/auth.ts` |
| Tests | 24 unit + 45 integration (`npm test`), 20-step built-app journey (`npm run e2e`), local routing check | `server/tests/**` |

## 2. Users and permissions (from `server/src/config/permissions.ts`)

Super admin (platform only) · owner (all permissions) · admin (all except `payments:configure`) · manager · waiter · cashier · kitchen · inventory_manager. Per-user grant/revoke overrides; a non-owner can only grant permissions they hold.

## 3. Module inventory

Status: ✅ implemented (UI + API + tests) · 🟡 partial · ❌ not implemented.

### Super Admin (`client/src/pages/admin/*`, `server/src/routes/superadmin.ts`)
| Module | Status | Notes |
|---|---|---|
| Login | ✅ | `pages/auth/Login.tsx` (shared with staff) |
| Overview (stats, orders/day chart, top restaurants, plan mix) | ✅ | `Overview.tsx`; the MRR caption still described the old formula (fixed in this pass) |
| Restaurants list, search, filters, pagination | ✅ | `Tenants.tsx` |
| Create restaurant + owner account | ✅ | `Tenants.tsx` modal → `POST /api/platform/tenants` |
| Restaurant details: edit, suspend/reactivate, subscription, entitlements, custom domain, accounts | ✅ | `TenantDetail.tsx`, `TenantAccounts.tsx` |
| Subscription plans | ✅ | `Plans.tsx` |
| Audit log | ✅ | `Audit.tsx` |
| Platform settings page | ❌ | Configuration lives in `server/.env` |
| Platform users (other super admins) UI | ❌ | CLI only (`npm run superadmin`) |
| Reports beyond the overview | ❌ | |
| Notifications for super admin | ❌ | Socket room `platform` exists; no UI |

### Restaurant dashboard (`client/src/pages/owner/*`, `staff/*`)
| Module | Status | Notes |
|---|---|---|
| Dashboard overview | ✅ | `Dashboard.tsx` → `/api/staff/analytics/dashboard` |
| Profile / general settings, ordering, tax, service charge | ✅ | `Settings.tsx` |
| Branding & theme (colours, fonts, radius, images, hero text, socials) | 🟡 | Works, but only Fraunces/Inter fonts are ever loaded (other font choices silently fall back), and poor text contrast is only warned about |
| Menu: categories, subcategories (2 levels), schedule, stations | ✅ | `Menu.tsx` |
| Products: variants, add-ons, promo, tags, stock, recipes, photos (≤8), availability, featured, archive | ✅ | `Menu.tsx` |
| Category images | 🟡 | API exists (`POST /menu/categories/:id/image`); no UI, and the storefront doesn't display them |
| Tables & QR (PNG/SVG/PDF, regenerate, status) | ✅ | `Tables.tsx` |
| Orders + order drawer, staff-entered orders | ✅ | `Orders.tsx`, `OrderDrawer.tsx`, `NewOrderModal.tsx` |
| Kitchen display (stations, item states) | ✅ | `staff/Kitchen.tsx` (plan feature `kds`) |
| Waiter view | ✅ | `staff/Waiter.tsx` |
| Cashier / payments (cash, card terminal, refunds; Stripe per tenant) | ✅ / 🟡 | `Payments.tsx`, `OrderDrawer.tsx`; Stripe not verified against a real account |
| Staff, roles, permission overrides, activity | ✅ | `Staff.tsx` |
| Customers, reservations, feedback, coupons, audit | ✅ | `Business.tsx` via `ResourcePage.tsx` |
| Inventory: stock, movements, purchase orders, suppliers | ✅ | `Inventory.tsx` (feature `inventory`) |
| Analytics + CSV/PDF export | ✅ | `Analytics.tsx` (export needs `analytics_export`) |
| Notifications (bell, live) | ✅ | `DashboardLayout.tsx` |
| Subscription view for owners | 🟡 | Trial/expiry banner only; no plan page |
| Expenses | ❌ | No model, route or page anywhere |

### Customer storefront (`client/src/pages/store/*`)
| Feature | Status | Notes |
|---|---|---|
| Branded landing (hero, logo, about, hours, address, socials) | ✅ | Functional but plain: hero + list; no info strip, offers or reviews section |
| Featured dishes | ✅ | Horizontal strip |
| Category navigation + search | 🟡 | Pills scroll to sections, but the active pill doesn't follow scrolling |
| Special offers (active promo prices) | 🟡 | Promo prices shown per dish; no offers section |
| Guest reviews | 🟡 | `GET /api/public/feedback` returns published reviews and owners can publish them, but the storefront never shows them |
| Dish details (gallery, variants, add-ons, notes, quantity) | ✅ | Bottom sheet; gallery is dots only |
| Cart, order types, coupon, taxes/service, checkout | ✅ | `CartSheet` |
| Order tracking (live), online pay (Stripe), feedback | ✅ | `OrderTracking.tsx` |
| Reservations | ✅ | `Reserve.tsx` (feature `reservations`) |
| Languages EN / UR / AR (RTL) | ✅ | `i18n/index.tsx` |

## 4. Design-layer findings

1. **One design for all tenants already exists structurally.** All restaurants render the same storefront components; tenants change CSS variables only. Server validation (`server/src/routes/tenantAdmin.ts` `brandingSchema`) restricts the theme to hex colours, a font whitelist and a 0–32 px radius, so arbitrary CSS can't be injected. This is the right base for Phase 6.
2. **Visual polish is uneven.** Flat shadows, plain tabs and modals without backdrop or scale transitions; data tables have no hover or keyboard affordance; a basic login screen; a plain storefront.
3. **Accessibility:** clickable table rows aren't keyboard-reachable (`DataTable` uses `tr onClick` only); modals don't restore focus; the storefront pill nav lacks `aria-current`.
4. **Motion:** only `fade-up`, `slide-in` and `pulse2`; `prefers-reduced-motion` is already respected globally.
5. **Fonts:** tenant font choices beyond Fraunces/Inter are never loaded.

## 5. Implementation plan (this pass)

1. **Design tokens** (`tailwind.config.js`, `index.css`): neutral "ink" scale, layered shadows, easing curves, motion keyframes (fade, scale, slide, shimmer skeleton, pop), reveal-on-scroll utility, refined inputs, selection and scrollbars.
2. **Shared components** (`ui.tsx`): Button (press feedback), Card, Stat, Badge (status dot), Tabs (segmented), Modal/Drawer (animated backdrop, focus restore), Empty, Loading skeleton, PageHeader, keyboard-accessible DataTable, Pagination, toasts. Every dashboard page uses these, so the upgrade reaches all modules consistently without rewriting business logic.
3. **Shells:** dashboard sidebar and top bar, page transitions, premium login.
4. **Storefront** (one central layout, tenant-branded): new hero with logo and info strip, offers section, featured carousel, scroll-spy category nav, image-forward dish cards, reviews section, refined dish sheet with thumbnail gallery, cart with add-to-cart feedback, refined order tracking and reservations.
5. **Theme safety:** runtime contrast guard (text/surface vs background) and a whitelisted Google Fonts loader.
6. **QA:** typecheck, builds, all tests, E2E, Chrome at 390/768/1024/1440/1920 with console and overflow checks.
7. **Documentation:** user guides, client handover kit, feature status, final report.

Out of scope (truthfully reported, not faked): Expenses, a platform-settings UI, platform-user management UI, super-admin reports, an owner subscription page, category-image UI.
