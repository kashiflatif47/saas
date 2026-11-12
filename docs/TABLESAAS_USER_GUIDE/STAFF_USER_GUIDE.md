# Staff User Guide

For everyone who works in a restaurant on TableSaaS. Every permission below is generated from the platform's source (`server/src/config/permissions.ts`); the server enforces it on every request.

## Signing in

1. Open your restaurant's address followed by `/login`, e.g. `https://the-broast.yourdomain.com/login` (locally `http://the-broast.localhost:5173/login`).
2. Enter the email and password your owner or manager gave you, then **Sign in**.
3. You land on the screen for your role: kitchen staff on **Kitchen display**, waiters on **Waiter view**, cashiers on **Point of sale**, inventory managers on **Inventory**, everyone else on **Dashboard**.
4. Change your password: the **key icon** at the bottom of the sidebar → **Change password**. This signs you out on your other devices.
5. Sign out: the **door icon** next to it.

After 8 wrong passwords in a row the account locks for 15 minutes. Your owner, or the platform administrator, can reset your password.

## The roles

### Owner
Everything, including **Settings → Payments** (online payment keys), the only permission an admin lacks. Created by the platform administrator. There is exactly one owner per restaurant.

### Admin
Everything except configuring online payments. Can create and edit staff, but only the owner can create or edit other admins.

### Manager
Runs the floor and the menu: menu and tables, orders (accept, cancel, serve, complete), kitchen display, collecting payments and refunds, reports, reservations, customers, coupons, feedback, and stock levels (view). **Cannot** manage staff accounts, settings, branding, the audit log or online payments.

### Waiter
Takes orders (**New order** / **Take order**), accepts and serves them (**Mark served**), sees tables and sets a table's status (e.g. *cleaning → available*), and manages reservations. Waiters can claim an order for themselves only. In **Orders** a waiter sees orders on their assigned tables, orders assigned to them, and unassigned new or ready orders. **Cannot** collect payments, change the menu, or move kitchen preparation states.

### Cashier
Sees orders and tables, **collects payments** (cash or card terminal) and manages customers. **Cannot** refund, accept orders or change the menu.

### Kitchen
Uses the **Kitchen display**: **Start** an item, mark it **Ready**, **Undo ready**, or **Bump — all ready** for the whole ticket. Can filter by station. **Cannot** accept or serve orders or take payments.

### Inventory manager
**Inventory**: stock items, adjustments and wastage, movement history, purchase orders and suppliers. Can view the menu. **Cannot** see orders or payments.

### Rider
Uses **My deliveries** on a phone: goes available/unavailable, optionally shares location (only while available), accepts or declines assigned deliveries, marks **Picked up** (only when the kitchen marked the order ready), **On the way**, **Delivered** (with the customer's 4-digit code when required) or **Could not deliver** (reason required). **Cannot** see other riders' deliveries, the order list, POS, payments, menu management or customer lists. Riders do not receive the restaurant-wide live order feed.

## Exact permission matrix

| Permission | owner | admin | manager | waiter | cashier | kitchen | inventory_manager | rider |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `settings:manage` | ✓ | ✓ | — | — | — | — | — | — |
| `branding:manage` | ✓ | ✓ | — | — | — | — | — | — |
| `staff:manage` | ✓ | ✓ | — | — | — | — | — | — |
| `staff:view` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `menu:manage` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `menu:view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `tables:manage` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `tables:view` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `orders:view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `orders:manage` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `orders:accept` | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| `orders:deliver` | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| `kitchen:operate` | ✓ | ✓ | ✓ | — | — | ✓ | — | — |
| `payments:collect` | ✓ | ✓ | ✓ | — | ✓ | — | — | — |
| `payments:refund` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `payments:configure` | ✓ | — | — | — | — | — | — | — |
| `analytics:view` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `inventory:manage` | ✓ | ✓ | — | — | — | — | ✓ | — |
| `inventory:view` | ✓ | ✓ | ✓ | — | — | — | ✓ | — |
| `reservations:manage` | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| `customers:manage` | ✓ | ✓ | ✓ | — | ✓ | — | — | — |
| `feedback:view` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `coupons:manage` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `audit:view` | ✓ | ✓ | — | — | — | — | — | — |
| `notifications:view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `orders:create` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `orders:modify` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `orders:discount` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `orders:transfer` | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| `shifts:operate` | ✓ | ✓ | ✓ | — | ✓ | — | — | — |
| `shifts:manage` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `intelligence:view` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `marketing:manage` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `marketing:approve` | ✓ | ✓ | — | — | — | — | — | — |
| `delivery:dispatch` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `delivery:manage` | ✓ | ✓ | ✓ | — | — | — | — | — |
| `delivery:ride` | — | — | — | — | — | — | — | ✓ |

What the permissions unlock:

| Permission | Unlocks |
|---|---|
| `settings:manage` | Settings → General, Ordering & tax |
| `branding:manage` | Branding (logo, colours, website text) |
| `staff:manage` / `staff:view` | Staff & roles: edit / view |
| `menu:manage` / `menu:view` | Menu: edit / view |
| `tables:manage` / `tables:view` | Tables & QR: edit, regenerate, delete / view and download QR |
| `orders:view` | Orders list and order details |
| `orders:accept` | Accept or reject new orders; create orders; claim orders |
| `orders:manage` | Cancel orders; assign waiters |
| `orders:deliver` | Mark served / complete; change a table's status |
| `kitchen:operate` | Kitchen display and item preparation states |
| `payments:collect` / `payments:refund` | Record cash or card-terminal payments / refund |
| `payments:configure` | Online payment (Stripe) keys — owner only |
| `analytics:view` | Analytics and report exports |
| `inventory:manage` / `inventory:view` | Inventory: edit / view |
| `reservations:manage`, `customers:manage`, `coupons:manage`, `feedback:view`, `audit:view` | The matching Business pages |
| `notifications:view` | The bell (new orders, ready orders, low stock, reservations, feedback) |
| `orders:create` | Point of sale; Take order (the person taking a POS order confirms it) |
| `orders:modify` | Add items to open orders; change or remove items the kitchen has not started |
| `orders:discount` | Item and order discounts at the POS, capped by Settings → POS & kitchen (owners uncapped); reason required |
| `orders:transfer` | Move an order to another table; merge tables |
| `shifts:operate` | Open/close your own cash shift; cash in / cash out |
| `shifts:manage` | See and close every cashier's shift |
| `intelligence:view` | Intelligence: business overview, forecasts, recommendations (accept/reject/dismiss), assistant, background jobs |
| `marketing:manage` | Marketing: segments, customers' consent records, draft/submit/pause campaigns and automations, test sends, opt-out list |
| `marketing:approve` | Approve, schedule and resume campaigns; activate automations; sending rules; segment rules; remove an opt-out block |
| `delivery:dispatch` | Delivery dispatch board: assign, auto-assign, unassign, retry, mark returned; delivery analytics |
| `delivery:manage` | Delivery zones, rider profiles and availability, dispatch settings |
| `delivery:ride` | Rider app (My deliveries) — rider role only; owners and admins do not have it |

### Custom permissions per person
In **Staff & roles**, an owner or admin can give an individual extra permissions or take some away. Rules enforced by the server:
- Only the owner can grant **any** permission. Everyone else can only grant permissions they have themselves.
- Nobody except the owner can change their **own** role or permissions.
- Changing someone's role, permissions, password or active status **signs that person out everywhere**.

Some modules also depend on the restaurant's **plan**: Kitchen display (`kds`), Inventory, Reservations, report exports, online payments and multiple languages. If a menu item is missing for everyone, the plan doesn't include it.

## Daily routines

**Waiter.** **Waiter view** → tabs **Ready to serve / New / In kitchen / Served**. Serve ready orders (**Mark served**), accept new ones, set tables back to *available* after cleaning, and take orders with **Take order**.

**Kitchen.** Keep **Kitchen display** open, full screen (the expand button). New tickets appear automatically. Tap **Start** when you begin an item, **Ready** when it is done; **Bump — all ready** finishes the ticket.

**Cashier.** **Payments → Awaiting payment** lists orders with money due. Open one → **Collect payment** → choose **Cash** or **Card terminal** → amount → confirm. Partial payments are fine.

**Manager.** **Orders** is the control room: filter by **New / In kitchen / Ready / Served**, open any order to accept, cancel (reason required), assign a waiter, take payment, refund, or close (**Complete & close**).
