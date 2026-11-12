# Super Admin User Guide

For the platform operator. The Super Admin console lives at the platform's root address: `https://yourdomain.com` in production, `http://localhost:5173` locally.

## 1. Signing in

1. Open `https://yourdomain.com/login`.
2. Enter the Super Admin email and password. The first Super Admin is created automatically on the server's first start from `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` (see `TABLESAAS_PRODUCTION_GUIDE.md` §D).
3. Change the password straight away: **key icon** (bottom of the sidebar) → **Change password**.

Super Admin sign-in only works on the root address, never on a restaurant's subdomain. A forgotten Super Admin password is reset by the server operator: `SUPERADMIN_NEW_PASSWORD='…' npm run superadmin -- --email you@example.com --reset-password`.

## 2. Overview

**Overview** shows, for the last 30 days across all restaurants:
- **Restaurants**: total, active and suspended;
- **Orders (30d)** and **GMV (30d)**, the value of orders;
- **Est. MRR**: monthly plan prices of *paying* subscriptions only (active or in grace; trials excluded);
- **Platform orders per day** chart, the **Subscriptions** breakdown and **Most active restaurants**.

## 3. Creating a restaurant

1. **Restaurants → New restaurant.**
2. **Business name.** The **Subdomain** fills in automatically; edit it if needed. It becomes the address `subdomain.yourdomain.com`.
   - Rules: 3–40 characters, lowercase letters, numbers and hyphens; reserved words (`www`, `api`, `admin`, `app`, …) aren't allowed; it must be unique.
   - **Choose it carefully: it can't be changed later**, because it is printed inside every QR code.
3. **Business type**, **Plan** (each shows its free-trial length), **Currency** (3-letter code, e.g. PKR), **City**, **Business email**, **Business phone**.
4. **Owner account:** **Owner name**, **Owner email**, **Temporary password** (at least 10 characters).
5. **Create restaurant.** You land on the restaurant's page; its address is at the top.

If the **Plan** list is empty, create a plan first (§6). Three default plans are created automatically on a fresh installation.

### Sharing onboarding credentials securely
- Send the **address and email** in one message and the **temporary password** through a different channel (e.g. a phone call or an encrypted messenger). Never put passwords in a handover document or a shared spreadsheet.
- Ask the owner to change the password at first sign-in (key icon → Change password).
- The client-facing handover pack is `CLIENT_ONBOARDING_GUIDE.md` and `CLIENT_HANDOVER_CHECKLIST.md`.

## 4. Managing a restaurant

**Restaurants** lists all restaurants with search (name or subdomain) and filters (account status, subscription status). Click a row, or press Enter on it, to open the restaurant page:

| Section | What you can do |
|---|---|
| Header | Open the restaurant's website; **Suspend** (reason required) or **Reactivate** |
| Usage tiles | Orders and GMV (30 days); staff, dishes and tables against plan limits |
| **Subscription** | Change plan and **Renew** for N months; **Extend trial** by N days; **Mark past due** / **Mark expired** |
| **Feature entitlements** | Click a feature to cycle: *in plan → revoked*, *off → granted*. Overrides apply on top of the plan |
| **Owner account** | Name, email, last sign-in; **Reset owner password** |
| **Restaurant details** | Edit name, business type, email, phone, address, city, country, currency, time zone, default language. The subdomain is fixed |
| **Accounts** | Every staff account: role, status, last sign-in. **Reset password**, **Unlock** (after too many failed sign-ins), **Deactivate / Reactivate** (owners are handled by suspension) |
| **Custom domain** | Optional own domain for the customer website (e.g. `menu.restaurant.com`); needs DNS and a certificate first |

**Suspending** takes the website offline immediately and signs out every staff member. **Reactivating** restores both. Every password reset or deactivation signs that person out everywhere.

## 5. Subscriptions: how the lifecycle works

- New restaurants start in **trial** for the plan's trial days (or **active** if the plan has 0 trial days).
- An hourly check moves ended trials to **expired**, and lapsed paid periods to **past due**, then to **expired** after 7 days of grace.
- **Expired** restaurants can still sign in and read data, but cannot make changes, and their website is offline. **Renew** fixes it immediately.
- Subscription payments are not collected by TableSaaS: record them by renewing.

## 6. Plans

**Plans → New plan / Edit**: name, code (permanent), monthly price, currency, trial days, limits (max staff, dishes, tables), features, and **Available for new restaurants**. Changes take effect for all restaurants on that plan.

## 7. Audit log

**Audit log** lists platform actions (restaurant created, suspended, plan changes, password resets, …) with actor, time and IP address.

## 8. Things the console does not do (by design or not yet built)

- No platform-settings screen: configuration lives in the server's `.env` file.
- No screen to manage other Super Admins: use the `npm run superadmin` command.
- No reports beyond the Overview, and no automatic subscription billing.

See `PLATFORM_FEATURE_STATUS.md`.

## 9. Common problems

| Problem | Fix |
|---|---|
| "That subdomain is already taken" | Choose another subdomain |
| "Subdomain must be 3–40 chars…" | Use only lowercase letters, numbers and single hyphens |
| Plan dropdown is empty | Create or activate a plan under **Plans** |
| Owner says the login fails | Restaurants → the restaurant → **Accounts** → **Unlock** or **Reset password** |
| Restaurant website shows "Temporarily unavailable" | It is suspended or its subscription expired → **Reactivate** / **Renew** |
| Super Admin login refused | Make sure you are on the root address, not a restaurant subdomain |
