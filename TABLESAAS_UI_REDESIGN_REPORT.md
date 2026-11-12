# TableSaaS: Premium UI & Dashboard Redesign — Report

This was a visual redesign only. No backend, API, database, auth, permission, pricing, order, kitchen, offline, AI, marketing, delivery or job code was changed. Nothing was deployed, and every test ran against in-memory MongoDB.

## 1. Files changed (all under `client/`)

| File | Change |
|---|---|
| `tailwind.config.js` | Typography tokens (`page-title`, `section-title`, `card-title`, `metric`); spacing tokens (`card-pad`, `grid-gap`, `section`); palette rules documented |
| `src/index.css` | Taller, rounder inputs; readable sentence-case labels; roomier table cells; `.grid-stats`, `.grid-modules` and `.section-title` layout helpers |
| `src/components/ui.tsx` | Changed and added components (see below) |
| `src/components/Chart.tsx` | Bar chart: legend, peak/total summary, y-axis values, larger axis labels, a tooltip kept inside the chart area, a proper empty state, accent colours. Ranked bars: rank numbers, thicker bars, accent colours |
| `src/components/DashboardLayout.tsx` | Sidebar 264 → 280 px; 44 px items with 20 px icons; soft tinted active item; separators between groups; profile panel; 72 px header with a larger page title; wider page container |
| `src/pages/owner/Dashboard.tsx` | Restaurant dashboard rebuilt (§3) |
| `src/pages/admin/Overview.tsx` | Super admin dashboard rebuilt (§3) |
| `src/pages/owner/Analytics.tsx`, `Intelligence.tsx` | Semantic accents on metrics and charts; violet for AI/forecast elements |
| `src/pages/owner/Menu.tsx`, `src/pages/staff/Pos.tsx` | Larger menu dish cards; slightly roomier POS tiles (density kept) |
| `src/pages/store/MenuView.tsx` | More padding and spacing for storefront dish cards, and larger images |
| 19 module pages* | Category icon tile and accent in the page header |
| `Marketing.tsx`, `Delivery.tsx`, `Rider.tsx` | Fixed non-existent colour classes (`bg-brand-50`, `border-brand-500`, `text-brand-700`) that previously rendered no colour |

\*Plans, Restaurants, Audit, Analytics, Branding, Feedback, Delivery, Intelligence, Inventory (3 views), Marketing, Menu, Orders, Payments, Settings, Staff, Tables, Rider, Cash shifts, Waiter.

**Changes in `ui.tsx`:**
- **New components:**
  - `ACCENTS` palette and `IconTile`;
  - `NavCard` (large module card);
  - `SectionHeader` and `FormSection` (headed groups for long forms).
- **Changed components:**
  - `Card`: optional icon, subtitle and accent; 24 px padding; 15 px titles.
  - `Stat`: larger; accent tile and top rule.
  - `PageHeader`: optional icon and accent; 32 px title.
  - `Badge`: larger; new `ai` (violet) tone; info is now blue.
  - Buttons: 36 / 44 / 48 px heights; rounder.
  - Tabs: larger.
  - Modal and Drawer: more padding.
  - Table rows: hover state on every row.

All changes are backward compatible: existing `tone="brand"` and element icons keep working.

## 2. Design system

- **Neutrals:**
  - background: warm stone-50;
  - cards: white with a hairline border and a very soft shadow;
  - text: stone-900, stone-700 and stone-500 (contrast checked against white).
- **Primary:** the restaurant's own brand colour (the tenant theme, unchanged). The platform console keeps its default.
- **Semantic accents, used as soft tints only** (50-level background, 600-level icon, thin rule; never saturated fills):

  | Accent | Used for |
  |---|---|
  | emerald | success, completed, money in |
  | amber | pending, warning |
  | rose / red | errors, cancelled, critical |
  | blue | information, volume |
  | violet | AI and intelligence |

- **Typography:**
  - page title 32 px; section title 18 px; card title 15 px;
  - metrics 32 px (26 px on phones);
  - body 14–15 px; labels 13 px. Nothing smaller than 11 px.
- **Spacing:**
  - card padding 24 px;
  - grid gap 20 px;
  - 32 px between page sections.

## 3. Dashboards

**Restaurant dashboard:**
- the date as eyebrow; four large metric cards (sales in brand, collected in emerald, active orders in amber/blue, tables in blue);
- tinted alert strips for orders awaiting acceptance, low stock and upcoming reservations;
- latest orders (live);
- a "Kitchen & floor activity" pipeline with proportional bars;
- for users with `analytics:view`, real figures from the existing summary endpoint:
  - sales this week (chart);
  - popular dishes (ranked);
- a **Quick access** grid of large module cards (≈200 px tall). Each card is shown only when the user's permissions and the plan allow it, and some show live figures (active orders, items in the kitchen, low stock).

**Super admin dashboard:**
- four large metrics (restaurants, orders, GMV, MRR, each with its own accent);
- a "New restaurant" primary action;
- orders-per-day chart (blue);
- subscriptions with proportional status bars, and the by-plan breakdown;
- most active restaurants table;
- a new **Recent activity** feed from the existing audit endpoint;
- "Manage the platform" module cards.

## 4. Menu and navigation cards

- **Module cards (`NavCard`):**
  - 56 px icon tile, 16 px title, description and an optional live figure;
  - 24 px padding, minimum height 196 px;
  - 1 / 2 / 3 columns across sizes;
  - measured at 201 px tall in the browser at 1440 px.
- **Menu dish cards:** 20 px padding, 15 px semibold titles, larger badges and spacing.
- **POS tiles:** slightly roomier (it is an operational screen).
- **Sidebar items:** 44 px tall.

## 5. Storefront

The restaurant-specific identity is preserved: theme colours, fonts, radius, layout, RTL/LTR, cart, checkout and QR context are untouched. Only the dish cards got more padding, larger gaps and larger images (108–128 px). The Arabic storefront was verified to render right-to-left.

## 6. Responsive and browser QA (headless Chrome, in-memory MongoDB)

| Run | Widths | Page states | Overflow | Console errors | Error screens | Functional |
|---|---|---|---|---|---|---|
| Full app (platform, storefront, all 17 dashboard pages) + Arabic RTL + module cards | 360, 390, 768, 1024, 1440, 1920 | 181 | 0 | 0 | 0 | 12 / 12 |
| Intelligence, marketing, delivery, rider, tracking, unsubscribe (with tab clicks) | 360, 390, 768, 1024, 1440, 1920 | 95 | 0 | 0 | 0 | 9 / 9 |
| Offline POS & kitchen | — | — | — | — | — | 24 / 24 |

**Functional checks include:**
- QR ordering; double-click checkout creating exactly one order;
- live tracking; the kitchen display receiving orders live;
- the assistant;
- campaign preview;
- dispatch, the rider accept flow and customer delivery tracking;
- RTL at 360 / 390 / 768 / 1440;
- the presence and size of module cards on both dashboards.

## 7. Build and tests

- Client: `tsc --noEmit` clean; `vite build` succeeds.
- Server: `npm test`: **157 / 157 pass** (it includes the client offline pricing parity test).

## 8. Remaining UI notes

- Most deeper pages (orders, inventory, settings forms and so on) pick up the redesign through the shared components and tokens. Their individual layouts were not re-composed. `FormSection` is available but long forms have not yet been regrouped with it.
- The kitchen display and POS keep their compact, operational layouts on purpose.
- Charts are SVG bar and ranked-bar charts only (no line or donut charts were added). Multi-series charts would need a small extension.
- The Super admin "Recent activity" shows audit actions by their technical names (e.g. `tenant.create`).
- The visual review was automated (layout, overflow and console checks, plus element measurements). A human design review on real devices is still recommended.
