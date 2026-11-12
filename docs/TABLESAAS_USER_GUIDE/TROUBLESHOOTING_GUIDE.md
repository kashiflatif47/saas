# Troubleshooting Guide

Messages in quotes are the exact texts the application shows. Every cause listed was checked against the source code.

## Cannot log in

| Message / symptom | Cause | Solution |
|---|---|---|
| "Invalid credentials" | Wrong email or password, **or** signing in on the wrong address (a restaurant login on another restaurant's subdomain; a Super Admin login on a restaurant subdomain) | Check the address: Super Admin at `yourdomain.com/login`, staff at `<their-restaurant>.yourdomain.com/login` |
| "Invalid credentials" after several attempts | 8 failed attempts lock the account for 15 minutes | Wait 15 minutes, or Super Admin → restaurant → **Accounts** → **Unlock** |
| "Invalid credentials" for a former employee | Account deactivated | Owner/admin → **Staff & roles** → set **Active**, or Super Admin → **Accounts** → **Reactivate** |
| "This restaurant account is suspended" | The platform suspended the restaurant | Super Admin → **Reactivate** |
| Signed in, but nothing can be saved: "Subscription inactive — renew to continue" | Trial or subscription expired (read-only mode) | Super Admin → **Renew** / **Extend trial** |
| Forgot password | — | Staff: ask the owner or admin (Staff & roles → edit → new password). Owner: ask the Super Admin (**Reset owner password**). Super Admin: server command `npm run superadmin -- --email … --reset-password` |
| Signed out unexpectedly | Your password, role or permissions were changed, or you were deactivated: all sessions end by design | Sign in again |

## Restaurant URL not opening

| Symptom | Cause | Solution |
|---|---|---|
| "Restaurant not found" | No restaurant has that subdomain | Check the subdomain on the Super Admin restaurant page (e.g. `the-broast`, not `brost`) |
| "Temporarily unavailable" / "This restaurant is currently unavailable" | Suspended, or trial/subscription expired | Super Admin → Reactivate / Renew |
| Locally: "This site can't be reached / refused to connect" | Address missing `:5173`, or `npm run dev` not running | Use `http://<subdomain>.localhost:5173`; start `npm run dev` |
| Locally on a phone | Phones can't open `*.localhost` | Test on the laptop browser; use the deployed domain for phones |
| Locally with `curl` / PowerShell: "Could not resolve host" | Windows does not resolve `*.localhost` (browsers do) | `curl -H "Host: <subdomain>.localhost:5173" http://localhost:5173/...` |
| In production: subdomains don't resolve | Wildcard DNS (`*.yourdomain.com`) or wildcard certificate missing | See `docs/DNS_SSL.md` |

## Categories not appearing on the website

A category is hidden when **any** of these is true:
1. **Visible on menu** is off (Menu → edit category).
2. Its **Schedule** excludes the current day or time. The schedule uses the restaurant's **time zone** (Settings → Ordering & tax).
3. It is a subcategory and its parent is hidden.
4. It has no live dishes (empty categories are not shown).
5. A search is active on the website (clear the search box).

## Products not appearing

| Cause | Solution |
|---|---|
| Dish archived | Menu → **Archived** tab → **Restore** |
| Its category is hidden | See above |
| Dish shows "Sold out" (this is visible, not hidden) | **Available** is off, or stock tracking reached 0 → switch Available on / raise stock |
| "Your plan allows N products" when adding | Plan dish limit reached → archive dishes or ask the Super Admin for a bigger plan |

## Images not loading or not uploading

| Message / symptom | Cause | Solution |
|---|---|---|
| "Only PNG, JPEG, WEBP or ICO images are allowed" | Wrong file type (e.g. SVG, HEIC, PDF), detected from the file's content not its name | Export as PNG, JPEG or WEBP |
| "File too large" | Over the upload limit (default 5 MB, `MAX_UPLOAD_MB`) | Compress the image (≈ 1600 px wide is plenty) |
| "A product can have at most 8 images" | Limit reached | Remove a photo first |
| Images uploaded earlier now show broken | The server's upload folder (`UPLOAD_DIR`) was not persistent and was wiped on redeploy | Use a persistent volume and restore from backup (`docs/BACKUP_RECOVERY.md`) |
| Images blocked in production | `VITE_API_URL` points to another origin, so the security policy blocks cross-origin images | Leave `VITE_API_URL` empty (same origin) |

## QR code problems

| Message / symptom | Cause | Solution |
|---|---|---|
| "This QR code is no longer valid. Please ask staff for help." / "QR code expired" page | The code was replaced (**New QR**), the table was disabled or deleted, or the code belongs to a different restaurant | Print the current code from Tables & QR; check the table is **Active** |
| "This table QR code is invalid or has been regenerated. Please scan again." (when ordering) | Code regenerated after the guest scanned it | Scan the new code |
| "QR ordering is not enabled for this restaurant" | Plan lacks the `qr_ordering` feature | Super Admin → plan or feature override |
| Phone camera doesn't react | Printed too small, low contrast or glossy | Print ≥ 3 × 3 cm with a white margin on matte paper |

## Orders not appearing

| Cause | Solution |
|---|---|
| "Online ordering is disabled" shown to guests | Settings → Ordering & tax → turn on **Customers can order from the website / QR** |
| "Dine-in orders require a table. Please scan the QR code on your table." | **Dine-in orders must come from a table QR** is on and the guest didn't scan | Guest scans the table code, or chooses takeaway |
| "Order type not available" | That order type is switched off | Settings → Ordering & tax → order types |
| Order exists but you don't see it | You're on a filtered tab (e.g. **New**) or you're a waiter (waiters see their tables, their orders and unassigned new/ready orders) | Use the **All** tab; managers see everything |
| No live updates | Connection interrupted | Refresh the page; live updates reconnect automatically |
| Website offline | Subscription expired / suspended | See *Cannot log in* |

## Permission errors

| Message | Meaning |
|---|---|
| "You do not have permission for this action" | Your role lacks the permission (see `STAFF_USER_GUIDE.md`) |
| "Your plan does not include …" / "… are not included in your plan" | The restaurant's plan lacks that feature |
| "Subscription inactive — renew to continue" | Read-only mode after expiry |
| "Only the owner can manage admins" / "Only the owner can create admins" | Admin accounts are owner-only |
| "You cannot grant permissions you do not have" / "You cannot change your own role or permissions" | Anti-escalation rules |
| "The owner account can only be edited by the owner" / "The owner cannot be removed" | Owner protection |

## Payment issues

| Message / symptom | Cause / solution |
|---|---|
| No **Pay online now** button for guests | Online payments not configured **and verified** (Settings → Payments → **Verify with Stripe**), or the plan lacks `online_payments` |
| "Online payments are not configured for this restaurant" | Same as above |
| Online payment stuck as *pending* | Stripe's webhook isn't reaching the server: set the webhook URL shown in Settings → Payments in your Stripe dashboard and paste the signing secret |
| "Amount exceeds outstanding balance (…)" / "Order is already fully paid" | Collect only what is due |
| "Order cannot accept payments" | Order is rejected or refunded |
| Refund exceeds the refundable amount | You can refund at most what was paid on that payment, minus earlier refunds |

## Common browser issues

| Symptom | Solution |
|---|---|
| Old design or old menu after an update | Hard refresh (Ctrl+Shift+R). The app is a PWA, and the new version activates on the next load |
| Tracking link lost | The tracking link is in the browser that placed the order; staff can look the order up by number |
| Firefox doesn't open `*.localhost` locally | Use Chrome or Edge, or add hosts-file lines (`TABLESAAS_LOCAL_DEVELOPMENT_GUIDE.md` §5) |
| Fonts look plain | Fonts load from Google Fonts; offline networks fall back to system fonts |
