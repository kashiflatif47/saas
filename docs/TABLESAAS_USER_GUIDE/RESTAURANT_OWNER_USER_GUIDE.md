# Restaurant Owner User Guide

A step-by-step guide to running your restaurant on TableSaaS. Your restaurant lives at `https://<your-subdomain>.yourdomain.com` (on a laptop during testing: `http://<your-subdomain>.localhost:5173`).

---

## 1. Signing in for the first time
1. Open `https://<your-subdomain>.yourdomain.com/login`.
2. Enter the email and temporary password from your platform provider → **Sign in**.
3. **Change the temporary password now:** click the **key icon** at the bottom of the left menu → enter the current password, a new one (at least 10 characters) twice → **Change password**.

## 2. The dashboard
**Dashboard** shows today's figures: net sales, money collected, active orders, tables occupied, the latest orders, the order pipeline, upcoming reservations, low-stock items and tax collected. The bell at the top shows notifications (new orders, ready orders, low stock, reservations, feedback). **View storefront** opens your website.

The left menu is grouped into **Operate** (daily work), **Manage** (menu, tables, stock, customers…) and **Business** (staff, branding, settings, audit). You only see what your plan and role allow.

## 3. Restaurant profile and opening hours
**Settings → General:** business name, email, phone, address, city, country → **Save**.

**Settings → Ordering & tax:** currency, decimals, time zone, **Opening hours (shown on website)**, **Menu languages** (English, Urdu, Arabic; more than one needs the multi-language plan feature) and **Default language**, order types (dine-in, takeaway, delivery), **Customers can order from the website / QR**, **Dine-in orders must come from a table QR**, **Auto-accept new orders**, **Tax rate %**, **Menu prices already include tax**, **Service charge %**, **Loyalty points** → **Save**.

## 4. Logo, branding and colours
**Branding:**
1. **Images:** upload **Logo**, **Favicon**, **Hero image** (the big picture at the top of your website) and **Cover**. PNG, JPEG or WEBP, up to 5 MB each.
2. **Colours:** pick a preset (Terracotta, Emerald, Midnight, Berry, Ocean) or set each colour: *Primary* (buttons and highlights), *Secondary* (header and footer), *Accent*, *Page background*, *Cards*, *Text*.
3. **Fonts and corner roundness:** choose a heading font and a body font from the list, and a corner radius.
4. **Website text:** headline, sub-headline and "About" text, in each of your languages; social links (Instagram, Facebook, TikTok, WhatsApp).
5. The **live preview** updates as you change things. Click **Publish changes**.

Your website always keeps the same professional layout; branding changes its look, not its structure. If your text colour would be hard to read on your background, the website automatically uses a readable colour instead.

## 5. Categories and subcategories
**Menu → + Category:**
1. Name (English required; Urdu and Arabic optional).
2. Optional **Parent** (to make it a subcategory, one level deep), **Kitchen station** (where its dishes go on the kitchen display), **Schedule** (days and times when it is visible, e.g. Breakfast Mon–Sun 07:00–11:30), **Visible on menu**.
3. **Save.** Open the category again (pencil icon) to add a **Category image**, which is shown next to the category title on your website.
4. Reorder categories with the ↑ ↓ arrows. Delete (bin icon) only works on empty categories.

## 6. Adding dishes
**Menu → + Dish:**
1. **Name** and **Description** (per language), **Category**, **Price**.
2. Optional: **Promo price** and **Promo ends** (the dish then appears under *Today's offers* on your website), **Prep time**, **Tags** (e.g. *spicy, vegetarian*; these show icons on the menu).
3. **Options (variants):** e.g. *Half / Full* with a price difference. If a dish has options, the customer must choose one.
4. **Add-ons:** e.g. *Extra naan +80*. Each can be switched off individually.
5. **Available**, **Featured** (appears in *Chef's picks*), **Track portions in stock** (with a count; at 0 it shows *Sold out*).
6. With the inventory feature: **Recipe** ingredients, deducted from stock when an order is accepted.
7. **Save.** The dialog stays open so you can **upload photos** (up to 8; the first is the main photo).

On a dish card: **Available** toggle, **star** (featured), **pencil** (edit), **archive** (removes it from the menu but keeps its history; restore it from the **Archived** tab).

## 7. Tables and QR codes
See `QR_AND_TABLE_GUIDE.md`. In short: **Tables & QR → Add tables** → download PNG or SVG, or **Print all (PDF)** → place the codes on the tables.

## 8. Orders
**Orders** lists orders live, with tabs **Open, New, In kitchen, Ready, Served, Completed, Cancelled, All**, a search box and date filters. Click an order to open its panel: items, timeline, payments, and the next action (**Accept**, **Reject**, **Start preparing**, **Mark all ready**, **Mark served**, **Complete & close**, **Cancel**), **Assigned waiter**, **Collect payment** and **Refund**. **New order** lets staff enter an order themselves. The whole flow is in `COMPLETE_ORDER_WORKFLOW.md`.

## 9. Kitchen
**Kitchen display** (plan feature *KDS*): live tickets per **station** (set up in **Menu → Kitchen stations**). Kitchen staff tap **Start** / **Ready** per item, or **Bump — all ready**. Use the full-screen button on a kitchen tablet.

## 10. Staff
**Staff & roles → Add staff:** full name, email (their login), phone, temporary password, **Role** (admin, manager, waiter, cashier, kitchen, inventory manager), **Assigned tables** (waiters), **Kitchen stations** (kitchen staff), optional per-person permission changes, **Active**. Click a person to edit them, reset their password, or deactivate them (signs them out everywhere). What each role can do: `STAFF_USER_GUIDE.md`.

## 11. Payments
- **Settings → Payments:** **Accept payment at the counter / to waiter** (cash and card terminal). **Online payments (Stripe)**, if your plan includes it: paste your own Stripe publishable key, secret key and webhook signing secret, set the webhook URL shown there in your Stripe dashboard, then **Verify with Stripe**. Only after verification does your website offer **Pay online now**.
- **Payments** page: **Awaiting payment** (orders with money due) and **Transaction history** (filter by method and status).

## 12. Reports
**Analytics:** today, 7 days, 30 days, 12 months or a custom range; sales trend, payment collections, best-selling dishes and categories, busiest hours. With the *analytics export* feature: download CSV or PDF reports (orders, payments, products, categories, summary).

## 13. Other modules
- **Reservations:** booking requests from your website plus your own entries; confirm, seat (marks the table occupied), complete, cancel. Double-booking a table is prevented.
- **Customers:** created automatically from orders with a phone number (visits, spend, loyalty points).
- **Feedback:** ratings and comments after served orders. **Publish** the ones you want shown in *What guests say* on your website, optionally with a reply.
- **Coupons:** percentage or fixed discounts with minimum order, maximum discount, dates and usage limit.
- **Inventory:** stock, adjustments and wastage, movement history, purchase orders and suppliers.
- **Audit log:** who changed what, and when.

## 14. Subscription
A banner at the top of the dashboard shows when your free trial ends, or if your subscription is overdue or inactive. If it's inactive, the dashboard becomes read-only and your website goes offline: contact your platform provider to renew. There is no in-app plan page or payment for the subscription itself.
