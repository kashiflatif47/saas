# TableSaaS — POS, Cashier, Waiter, Manager and Kitchen Guide

For restaurant owners, managers, cashiers, waiters and kitchen staff. Every rule described here is enforced by the server; the screens only show what the server allows.

**Contents**
1. [POS user guide](#1-pos-user-guide)
2. [Cashier workflow](#2-cashier-workflow)
3. [Waiter workflow](#3-waiter-workflow)
4. [Manager workflow](#4-manager-workflow)
5. [Kitchen station setup](#5-kitchen-station-setup)
6. [Kitchen display usage](#6-kitchen-display-kds-usage)
7. [Order lifecycle](#7-order-lifecycle)
8. [Payment and refund workflow](#8-payment-and-refund-workflow)
9. [Shift opening and closing](#9-shift-opening-and-closing)
10. [Receipt printing](#10-receipt-printing)
11. [Roles and permissions](#11-roles-and-permissions)
12. [Troubleshooting](#12-troubleshooting)
13. [Known limitations](#13-known-limitations)
14. [Test results](#14-test-results)

---

## 1. POS user guide

Open **Dashboard → Point of sale** (`/dashboard/pos`). Cashiers land here after signing in.

| Area | What you do |
|---|---|
| Category bar and search | Filter dishes. Unavailable or sold-out dishes are greyed out and cannot be added |
| Dish tiles | Tap to add. Dishes with options open a picker (choose one variant, any add-ons) |
| Order type | Dine-in, Takeaway, Pickup, Delivery (only the types enabled in **Settings → Ordering rules**) |
| Table | Dine-in: tap **Choose a table**. Tiles show status (green available, amber occupied, blue reserved, grey cleaning), open orders and amount due |
| Customer | Name and phone. The person icon finds an existing customer by phone. Delivery also needs an address |
| Cart line | Tap a line to add kitchen instructions, change options or remove it. With discount permission: item discount (% or amount) |
| Coupon, notes, order discount | Coupon code; order notes for the kitchen; with discount permission, % or amount off the order, **reason required** |
| Totals | Calculated **by the server** (`POST /orders/quote`) every time the cart changes: discounts, service charge, delivery fee, tax |
| **Send to kitchen** | Creates the order, confirmed immediately: it appears on the kitchen display at once |
| **Charge** | Same as Send to kitchen, then opens the order with the payment panel |

On phones and small tablets the cart opens from the bottom bar. A double tap never creates two orders: each order carries a one-time key.

Requirements checked when the order is placed:
- Dine-in needs a table when **Dine-in orders must come from a table QR** is on.
- Pickup needs a name or phone number.
- Delivery needs an address and a phone number.

## 2. Cashier workflow

1. **Start the shift:** Dashboard → Cash shifts → **Open shift**, enter the opening float.
2. **Take orders** at the POS, or open existing ones from **Orders** or **Payments → Awaiting payment**.
3. **Collect payment** in the order panel. Choose Cash or Card terminal, then:
   - **Amount:** full or partial. Enter "Cash received" to see the change.
   - **Split equally:** choose the number of guests; each share is calculated by the server; tap **Pay** per guest.
   - **Split by items:** choose quantities per item; the server calculates that guest's share (including their part of discounts, service, delivery fee and tax); optional guest name.
4. **Print the receipt** (80 mm, 58 mm or A4) or open the PDF.
5. **Refunds:** cashiers cannot refund by default (managers can). The owner can grant `payments:refund` to a cashier in **Staff & roles**.
6. **Close the shift:** count the drawer, enter the counted cash. The difference to the expected amount is stored.

## 3. Waiter workflow

- **Waiter view** shows your tables and orders (assigned to you, on your tables, or unassigned pending/ready orders).
- **Take order** for a table, or use the POS.
- **Add items** to an open order from the order panel. New items go to the kitchen marked "Added later".
- **Change quantity or remove** an item only while the kitchen has not started it. Once it is being prepared, a manager must remove it.
- **Move to table** in the order panel transfers an order. Tables & QR merge moves all of one table's open orders to another table.
- **Bill** (request bill) notifies cashiers and managers; the order shows "Bill requested".
- **Served / Picked up / Dispatched** once the kitchen marks the order ready; **Close** when the guests have left.

## 4. Manager workflow

- **Monitor** live orders (Orders board), the kitchen display, and Waiter view.
- **Station workload:** Kitchen display with one station selected, plus Analytics → Kitchen performance.
- **Reassign orders:** "Assigned waiter" in the order panel.
- **Discounts:** managers can apply item and order discounts up to **Settings → POS & kitchen → Max manual discount**. Only owners are uncapped. A reason is required and saved on the order with your name.
- **Cancellations:** remove items already in preparation; cancel or reject orders. Orders with payments must be refunded first.
- **Refunds:** from the order's Transactions list.
- **Shift summaries:** Cash shifts shows every cashier's shift with expected, counted and difference.
- **Reports:** Analytics shows POS operations (type, channel, method, staff, discounts, refunds, shift closings) and Kitchen performance.

## 5. Kitchen station setup

1. **Menu → Kitchen stations** (button at the top of the Menu page): create stations such as Main Kitchen, Grill, Pizza, Drinks, Desserts, Bakery. Each restaurant starts with "Main Kitchen" as the default station. Mark one station as **default**: items whose category has no station go there.
2. **Menu → Categories → edit a category → Kitchen station:** assign the station. Every dish in the category is routed there.
3. **Menu → dish → Prep minutes:** the expected preparation time. It is used for the estimated ready time, the kitchen's "target" and delay alerts.
4. **Staff & roles → kitchen user → Stations** (optional): a cook assigned to exactly one station sees it by default on the KDS.
5. **Settings → POS & kitchen → Kitchen delay grace:** extra minutes before a ticket is flagged late.

When an order arrives, each item is routed to its category's station. One order can produce tickets on several stations, and every ticket keeps the order number.

## 6. Kitchen display (KDS) usage

Open **Kitchen display**. Choose **All stations** or a station.

| Element | Meaning |
|---|---|
| Ticket header | Order number, type, table or customer, timer since confirmation, target (longest prep time on the ticket) |
| Amber header | Target time reached |
| Red header and alert sound | Late: target plus grace minutes passed. The sound plays once per ticket |
| Blue strip "Changed after it was sent" | Items were added, changed or removed after sending; changed lines say "Added later" or "Removed" |
| **Start / Ready** per item | Records the time and the cook's name |
| **Start all / All ready** | Applies to the items shown on this station only |
| Ready list | Tickets done at this station; "other stations cooking" until the whole order is ready |

Partial readiness: the order becomes **Partly ready** when some items are ready, and **Ready** only when every item at every station is ready. Waiters are notified when the order is ready.

**Sound:** speaker button to mute or unmute (remembered per device). Browsers only play sound after a tap on the page, so tap the speaker once at the start of service.

**Reconnect:** if the network drops, the badge shows "Reconnecting…". When it is back, the screen reloads its tickets from the server, so nothing missed while offline is lost.

## 7. Order lifecycle

```
Pending ──► Confirmed ──► Preparing ──► Partly ready ──► Ready ──► Served / Picked up / Dispatched ──► Completed
   │            │             │               │             │                                          │
   └► Rejected  └────────── Cancelled ◄──────────────────────┘                          Refunded ◄──────┘ (also from Cancelled)
```

- **Confirmed** (stored as `accepted`): POS orders are confirmed by the person who takes them. QR and website orders wait in Pending unless **Auto-accept** is on.
- Preparing, Partly ready and Ready are driven by the kitchen's item updates.
- "Served", "Picked up" and "Dispatched" are the same stored status (`delivered`), labelled by order type.
- Invalid moves are refused (for example, Completed back to Pending; anything back to Pending).
- **Rejected** and **Cancelled** need a reason. An order with payments **cannot** be cancelled or rejected until the payments are refunded.
- Payment status (Unpaid, Part paid, Paid, Part refunded, Refunded) is separate from order status.

Order modification history (items added, changed or removed, table transfers, bill requests) is shown under **History** in the order panel, with times and names.

## 8. Payment and refund workflow

| Method | How it is recorded |
|---|---|
| Cash | Verified by the cashier who received it. Linked to their open shift |
| Card terminal | A **manually confirmed** transaction: the cashier confirms the external terminal approved it. TableSaaS does not talk to the terminal |
| Online (Stripe) | Only when the restaurant configured and verified Stripe. Marked paid only by a **signature-verified webhook** |

Rules:
- The server refuses any amount above the balance (no overpayment).
- Repeating the same payment request (double click, retry) is processed once.
- Split shares are calculated on the server; a tampered amount is refused.
- Card numbers or CVV are never entered or stored in TableSaaS.
- Refunds come from the Transactions list (permission `payments:refund`). They are limited to the original charge. Cash refunds are linked to the refunding cashier's open shift.
- An outstanding balance can still be collected after the order is completed, for example a guest returning to pay.

## 9. Shift opening and closing

- **Open:** Cash shifts → Open shift → opening float. One open shift per cashier.
- **During the shift:** **Cash in** (e.g. change from the bank) and **Cash out** (e.g. supplier paid from the drawer). Each needs a reason.
- **Expected cash** = opening float + cash sales − cash refunds + cash in − cash out. Card terminal and online payments are shown but are not in the drawer.
- **Close:** count the drawer and enter the counted cash. The expected amount, counted amount and difference are frozen. A shift closes exactly once.
- Managers (`shifts:manage`) see and can close every cashier's shift. Cashiers see only their own.
- **Settings → POS & kitchen → Cash only during an open shift:** when on, cash payments are refused without an open shift.
- Every open, cash-in, cash-out and close is written to the **Audit log**.

## 10. Receipt printing

In any order panel: choose **80 mm**, **58 mm** or **A4**, then:
- **Print receipt:** opens the browser print dialog with the receipt sized for that paper. Select your receipt printer and set margins to "None" if your driver adds them. This path supports Arabic and other right-to-left text.
- **PDF:** opens a PDF of the same size (Latin text only; use Print for Arabic receipts).

The receipt shows:
- logo, restaurant name, address and phone
- the tax registration number, if set
- order number, date and time, type and table, who took the order, cashier(s), customer, delivery address
- items with options, add-ons, unit price and item discounts
- subtotal, item, coupon and manual discounts, service charge, delivery fee
- the tax line, using the restaurant's label and rate:
  - tax-inclusive prices: "Total (incl. VAT 15%)" with the VAT included and the amount excluding VAT
  - tax-exclusive prices: "VAT 15% on X"
- payments (with split share or guest), refunds, total paid and balance due

Configure the tax label, registration number and footer in **Settings → POS & kitchen**; set the rate and inclusive/exclusive under **Money & tax**.

There is **no direct printer or cash-drawer hardware integration**. Printing goes through the browser.

## 11. Roles and permissions

New permissions added in this phase are marked ✚. Owners have everything. Admins have everything except payment-provider configuration.

| Permission | Manager | Waiter | Cashier | Kitchen |
|---|:-:|:-:|:-:|:-:|
| ✚ `orders:create` take orders (POS, table) | ✓ | ✓ | ✓ | |
| ✚ `orders:modify` add, change or remove unstarted items | ✓ | ✓ | ✓ | |
| ✚ `orders:discount` manual discounts (capped) | ✓ | | | |
| ✚ `orders:transfer` move and merge tables | ✓ | ✓ | | |
| ✚ `shifts:operate` own cash shift | ✓ | | ✓ | |
| ✚ `shifts:manage` all shifts | ✓ | | | |
| `orders:accept` confirm or reject | ✓ | ✓ | | |
| `orders:manage` cancel orders, remove items in preparation | ✓ | | | |
| `kitchen:operate` KDS item states | ✓ | | | ✓ |
| `orders:deliver` served, complete | ✓ | ✓ | | |
| `payments:collect` cash and card terminal | ✓ | | ✓ | |
| `payments:refund` refunds | ✓ | | | |
| `analytics:view` reports | ✓ | | | |

Any permission can be granted or revoked per person in **Staff & roles** (an owner can grant anything; others only what they hold). The server checks every request; hidden buttons are a convenience, not the protection.

## 12. Troubleshooting

| Message | Cause and fix |
|---|---|
| "A reason is required for manual discounts" | Enter a reason next to the discount |
| "Manual discounts above N% need the owner" | The cap in Settings → POS & kitchen; ask the owner |
| "You are not allowed to apply discounts" | Your role lacks `orders:discount` |
| "A delivery address is required" or "A contact phone number is required for delivery" | Fill in address and phone |
| "Open your cash shift before taking cash payments" | Cash shifts → Open shift, or turn off the setting |
| "You already have an open shift" | Close the current shift first |
| "This order has payments. Refund them first…" | Refund in Transactions, then cancel |
| "The kitchen has already started this item…" | Only a manager can remove it now |
| "This item is already prepared and cannot be removed" | Ready or served items stay on the bill; refund instead if needed |
| "The new total is below what has already been paid" | Refund the difference, then change the order |
| "This share is X, not Y. Refresh the split." | The balance changed (another payment); reopen the split |
| "Amount exceeds outstanding balance" | Someone already collected part of it; the panel shows the new balance |
| "This order was just updated…" (409) | Two people changed the same order at once; refresh and try again |
| KDS shows "Reconnecting…" | Network issue; the screen reloads its tickets automatically when back |
| No sound on the KDS | Tap the speaker icon once (browser autoplay rule) and check the device volume |
| Delay colours never appear | The dishes have no prep minutes set (Menu → dish) |

## 13. Known limitations

- **Hardware:** no direct receipt-printer, cash-drawer or card-terminal integration. Printing uses the browser; card terminal payments are recorded manually.
- **Delivery:** address, fee and status (Dispatched, then Completed) only. No courier or third-party delivery integration, no driver assignment, no distance-based fees.
- **Online payments** (Stripe) are implemented but have not been verified against a real Stripe account in this phase (no credentials).
- **Dashboard language:** the staff dashboards (including POS and KDS) are English (LTR). Arabic, Urdu and RTL are supported on the customer storefront and on browser-printed receipts. Currency (including SAR) and numbers follow the restaurant settings.
- **Receipt PDF** uses Latin fonts. Use browser printing for Arabic receipts.
- **Re-pricing after changes** uses each item's original unit price and the restaurant's **current** tax and service settings.
- **Split by customer** is the item split with a guest name; there is no separate customer-tab model.
- **Table merge** moves the orders to one table; each order keeps its own bill.
- **Recipe costing:** ingredient deduction uses the recipes configured on dishes. Removing an item that was never started returns its ingredients; started items count as used. No cost-of-goods reports.
- Physical device testing (tablets, thermal printers) was not possible in this environment.

## 14. Test results

See `TABLESAAS_POS_KITCHEN_IMPLEMENTATION_REPORT.md` in the project root for the commands, actual results and browser checks.
