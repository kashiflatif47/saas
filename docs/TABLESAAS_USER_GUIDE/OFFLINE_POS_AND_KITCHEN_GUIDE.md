# TableSaaS — Offline POS & Kitchen Guide

For owners, managers, cashiers and kitchen staff. It explains what keeps working when the internet or the TableSaaS server is unavailable, and what happens when the connection returns.

**Contents**
1. [How offline mode works](#1-how-offline-mode-works)
2. [What works offline](#2-what-works-offline)
3. [What needs the internet](#3-what-needs-the-internet)
4. [How synchronisation works](#4-how-synchronisation-works)
5. [How conflicts are resolved](#5-how-conflicts-are-resolved)
6. [Refresh, restart and closing the browser](#6-refresh-restart-and-closing-the-browser)
7. [One device, several tabs, several devices](#7-one-device-several-tabs-several-devices)
8. [Security and data protection](#8-security-and-data-protection)
9. [Troubleshooting](#9-troubleshooting)
10. [Hardware limitations](#10-hardware-limitations)

---

## 1. How offline mode works

**Before you lose connection, prepare each till once while online:**
- open **Point of sale**, **Kitchen display** and (for cashiers) **Cash shifts**;
- the device then keeps a copy of the menu, prices, stock, tables, stations, the kitchen queue and your open shift;
- the app itself is also stored by the browser (the existing service worker), so it opens without internet.

**When the connection drops** (no internet, or the TableSaaS server not answering), the header switches to **Offline** and an amber banner appears:
- **Orders, cash and kitchen updates** are saved **on this device first**, in the browser's database (IndexedDB).
- Every saved record becomes a queued operation with:
  - a unique id (UUID), which is also its **idempotency key**
  - the restaurant id, your user id and the device id
  - the operation type and payload
  - the time it was created on the device
  - its status, retry count and last error
- Saving is confirmed **only after the record is stored on the device**. If the device storage is full, the screen says the order was **not** saved.

**When the connection returns**, the device sends the queue automatically, oldest first. The server checks **every** record again exactly as if it were entered live (restaurant, staff permissions, current prices, stock, table, balance). It answers:
- **Confirmed:** the record is applied once and marked confirmed on the device.
- **Conflict or failed:** nothing is applied. The record waits in the **Sync centre** for a person to decide.

### Statuses you will see

| Where | Status | Meaning |
|---|---|---|
| Order, payment or kitchen record | **Saved on this device · waiting to sync** (Pending) | Stored locally; the server has not seen it yet |
| | **Syncing…** | Being sent right now |
| | **Confirmed by server** (Synced) | The server applied it; confirmed orders show their real order number |
| | **Failed** | Permission or plan problem, or too many temporary errors; needs a person |
| | **Needs attention** (Conflict) | The server refused it for a business reason (price changed, sold out, item removed elsewhere…) |
| Header chip | Online / Offline · number waiting · number needing attention | Click it to open the **Sync centre** |

## 2. What works offline

| Area | Offline behaviour |
|---|---|
| **Open the POS, KDS and Cash shifts** | Yes, if the device was used online at least once in the last 24 h (see §8). A refresh while offline keeps you signed in on that device |
| **Browse and search the menu** | From the copy saved on the device. The badge shows "prices as of …" |
| **Variants, add-ons, notes, quantities** | Yes |
| **Order types and tables** | Dine-in (saved tables), takeaway, pickup, delivery (address and phone required) |
| **Discounts** | Only if your role allows discounts; the restaurant's maximum % applies; a reason is required. Same rules as online |
| **Prices, tax, service, delivery fee** | Calculated on the device with **the same pricing code as the server**, from the last saved prices. Shown as "Total (offline estimate)" |
| **Save orders, several in a row** | Yes. Each gets a device number like `OFF-3F2A-0007` until the server gives it a real number |
| **Cash payments** | Yes. Recorded with amount, cashier, time and device, marked "Recorded on this device". An equal-split helper suggests each guest's amount |
| **Receipts (58 mm, 80 mm, A4)** | Yes, for orders saved on the device. They show "RECORDED OFFLINE · NOT YET CONFIRMED BY THE SERVER" and each payment's status |
| **Order history on the device** | POS → **Orders on this device**: every order, its sync status and its server number once confirmed |
| **Kitchen display** | Shows the last saved tickets plus orders taken offline on this device. Start / Ready / Start all / All ready are saved with the time and cook, shown at once, and marked "pending sync" |
| **Cash shift** | An **already open** shift keeps working: cash in, cash out and close are saved and sent later. Expected cash includes this device's unsynced cash, labelled as such |
| **Stock** | Tracked dishes show the last synced stock minus quantities in this device's unsynced orders. The device refuses to sell more than that. The real stock is decided by the server when orders sync |

## 3. What needs the internet

| Feature | Why |
|---|---|
| **Card terminal and online (Stripe) payments** | Never recorded as successful without live confirmation; the buttons explain this offline |
| **Coupons** | Usage limits and validity can only be checked by the server |
| **Refunds** | Not queued offline: money must not be returned against payments the device cannot verify |
| **Opening a new cash shift** | Prevents two open drawers for the same cashier |
| **Split by items; server split quotes** | Item shares are calculated by the server |
| **Adding or removing items on an order already on the server**, transfers, merges, bill requests | Need the current version of the order |
| **Signing in** | Passwords are checked by the server only |
| Menu, staff, settings, reports, analytics, Super Admin | Management screens need the server |

## 4. How synchronisation works

- **Automatic:** when the connection returns (the device checks the server every 5 seconds while offline), every 15 seconds while online, and shortly after each new record. **Sync centre → Sync now** sends immediately.
- **Order:** records are sent in the order they were made. A payment or kitchen update for an order taken offline **waits for that order** ("Waiting for its order to sync").
- **No duplicates, ever:**
  - each record's UUID is stored by the server with its result, so sending it again returns the first result (replay protection);
  - the order and payment created from it carry the same key;
  - if the connection drops after the server processed a record but before the answer arrived, the next attempt is recognised and not applied twice;
  - when the connection drops **while the POS is sending a live order** or a cash payment, the device keeps a copy with **the same key**, so if the server did get it, it is still recorded only once.
- **Temporary problems** (server busy, gateway errors) are retried with growing waits: 2 s, 4 s, 8 s … up to 5 min (±20 %). After 8 attempts the record becomes **Failed** and waits for a person; it is never dropped.
- **Signed out on the server** (session expired, password or permission change): records stay **Pending** until someone signs in again on that device. They are then sent under that person's current permissions.
- **Records are marked Confirmed only after the server answers.** A closed tab or crash in the middle of sending is detected next time ("interrupted") and safely re-sent.
- The server records which device took an order and when (`Order → History: offline synced`), and writes every applied record to the **Audit log** (`sync.order.create`, `sync.payment.cash`, …).

## 5. How conflicts are resolved

Open the header chip → **Sync centre**. Each record shows its status, the server's reason and the possible actions.

| Situation | What the server does | What staff do |
|---|---|---|
| **Price changed** while offline | Refuses: "Prices changed since this device last synced: it showed X, the current total is Y". The order's payments wait | **Accept server price** (the order is created at today's price; collect or refund the difference in Orders), or **Discard** with a reason |
| **Dish disabled, deleted or sold out**; **table removed** | Refuses with the reason | Discard with a reason, or fix the menu and **Retry** |
| **Stock ran out** (another till sold the last ones) | Refuses: "… is out of stock". Server stock is never overwritten by the device | Discard (refund the guest if they paid), or restock and Retry |
| **Order changed elsewhere** (an item removed or the order closed while the kitchen was offline) | Refuses the kitchen update ("ORDER_CHANGED", "ORDER_NOT_IN_KITCHEN") | Discard the kitchen update; the KDS reloads the live ticket |
| **Shift already closed on another device** | Refuses ("SHIFT_CLOSED", with who closed it) | Compare counts with the manager; discard |
| **Permissions changed** | Refuses (Failed, 403) | Ask the owner; **Retry** once permissions are restored, or discard |
| **Payment exceeds the server balance** (e.g. the server price was lower) | Refuses: "Amount exceeds outstanding balance" | Return the difference to the guest, discard the cash record with a reason |
| **Duplicate or out-of-order records** | Duplicates return the original result; dependent records wait for their parent | Nothing to do |
| **Record older than 14 days**, or device clock more than 10 min ahead | Refused (STALE_OPERATION, CLOCK_AHEAD) | Fix the device date and time; managers decide on old records |

**Discard** asks for a reason, keeps the record on the device with who discarded it and why, and turns anything depending on it (e.g. cash taken for that order) into a conflict so it is not forgotten. Discarding needs `orders:manage` (shift records: `shifts:manage`), or being the person who created the record. Nothing is ever deleted silently.

## 6. Refresh, restart and closing the browser

- **Refresh while offline:**
  - the app opens from the browser's stored copy;
  - you stay signed in on that device (from the cached session, see §8);
  - all saved orders, payments and kitchen updates are still there.
- **Browser or computer restart:** same. Records live in IndexedDB until the server confirms them.
- **Closed during sync:** the interrupted record is re-sent safely next time.
- **Session older than 24 h without connection:** offline use stops and someone must sign in online. **Records are kept** and sent after that person signs in.
- Confirmed orders and records are removed from the device **7 days** after confirmation, to keep customer data on the device to a minimum.

## 7. One device, several tabs, several devices

| Setup | What works without internet |
|---|---|
| **One device, one tab** | Everything in §2 |
| **One device, several tabs** (e.g. POS in one tab, KDS in another) | Same data on that device. Tabs tell each other about changes instantly (BroadcastChannel), so an order taken offline in the POS tab appears on the KDS tab. Only one tab sends to the server at a time (Web Locks); the server's deduplication protects even if two did |
| **Several devices on the same local network, internet down** | **Not supported.** Each device works on its own. The cashier's till and a separate kitchen tablet **cannot see each other's offline orders** until the internet returns: browser storage cannot be shared between devices. Use a KDS tab on the cashier's device, or printed tickets, during an outage |
| **Several devices after the internet returns** | Each device synchronises its own records; the server applies them in arrival order and resolves conflicts as in §5. Kitchen screens then show every order |

**Why not a local server?** True multi-device offline operation needs a **local gateway**: a small server on the restaurant's network with its own database, that devices talk to during an outage and that later synchronises with the cloud. That would mean:
- installing and maintaining hardware at each restaurant;
- a second copy of orders, payments and stock that must be reconciled;
- local TLS certificates and device pairing;
- its own security model for staff sessions.

It was investigated and **not built**, because it cannot be added safely without that infrastructure and would weaken the single source of truth. If you need it, it is a separate project: a gateway exposing the same `/api/staff/sync` contract, with its records replayed to the cloud with the same idempotency keys.

## 8. Security and data protection

- **Separate per restaurant:** each restaurant runs on its own address (e.g. `brost.example.com`), and browsers never share stored data between addresses. Restaurant A's data cannot appear on restaurant B.
- **Separate per person:** on the same device, every staff member has their own local database. Another employee signing in does not see the previous person's queue.
- **Re-checked on the server:** every record is re-checked against the signed-in person:
  - the record's restaurant and user must match the session ("TENANT_MISMATCH", "USER_MISMATCH");
  - current permissions;
  - current prices, discounts, stock, tables and balances.

  Prices, permissions and payment statuses stored on the device are **never trusted**.
- **No passwords or tokens stored.** The cached session contains your name, role, permissions and restaurant settings, so a refresh can show the POS. Sending anything needs a real online session.
- **Logout:**
  - If nothing is waiting, your local database and cached session are **deleted**.
  - If records are still waiting, they are **kept** (so no order or cash record is lost) and sent when you sign in again. The cached session is deleted, so the offline POS cannot be opened without signing in.
- **Customer data** on the device (names, phone numbers, delivery addresses of offline orders) stays only until 7 days after confirmation. Treat tills like any device holding customer data: lock them, and don't share browser profiles.
- **Unreadable records:** damaged or incomplete records are set aside ("quarantined"), never executed, and counted in the Sync centre.

## 9. Troubleshooting

| Problem | What to do |
|---|---|
| "No connection, and the menu has not been downloaded on this device yet" | Open the POS once while online |
| The POS asks you to sign in while offline | The session on this device is older than 24 h, or you logged out. Sign in once the connection is back |
| "This device is out of storage: the order was NOT saved" | Free space on the device (other sites' data, downloads), then retry. The order was not recorded |
| "Offline storage is not available in this browser" | Private/incognito windows and some locked-down browsers block storage. Use a normal browser window |
| A record stays "Waiting for its order to sync" | Its order has a conflict. Resolve the order first (Sync centre) |
| "Sign in again to send waiting records" | Your server session ended (password or permission change). Sign in; the records are then sent |
| Records keep retrying | The server reports a temporary problem. They retry automatically; after 8 attempts they show **Failed** with a **Retry** button |
| "This device's clock is ahead of the server" | Fix the device's date, time and time zone, then Retry |
| KDS shows "Offline · tickets as of …" | It is showing the last saved queue; new orders from **other** devices appear when the connection returns |
| A price on an offline receipt differs from the final bill | The server re-priced the order (conflict accepted); the confirmed order in Orders is authoritative |
| Clearing browser data | Do **not** clear site data while the Sync centre shows records waiting: they would be lost |

## 10. Hardware limitations

- No direct receipt-printer, cash-drawer or card-terminal integration: printing goes through the browser's print dialog, online or offline.
- Card terminals are not used offline in TableSaaS. If your terminal works offline on its own, record the payment in TableSaaS once the connection returns.
- Offline mode was tested in Chrome on a desktop (automated, headless), with simulated internet loss and a stopped server. It was not tested on physical tablets, iOS/Safari or Firefox.
- Browsers may delete stored data when a device is very low on space. TableSaaS asks the browser to keep it ("persistent storage"), but the browser decides.
