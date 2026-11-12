# Delivery Automation Guide

**For:** owners, managers, dispatchers and riders. **Where:** Dashboard → **Delivery** (dispatch, riders, zones, analytics, settings) and **My deliveries** (rider app).

**What tracking means here:** tracking is **status-based**. The customer sees the delivery status, the rider's first name, the expected time and their delivery code, but never a map or the rider's position. No routing or maps provider is connected: distances are straight-line and used only to rank riders who shared a recent location, and travel times come from the delivery minutes you set per zone.

| Permission | Default roles | Allows |
|---|---|---|
| `delivery:dispatch` | owner, admin, manager | Dispatch board, assign/auto-assign/unassign, retry, mark returned, delivery analytics |
| `delivery:manage` | owner, admin, manager | Zones, rider profiles and availability, dispatch settings |
| `delivery:ride` | **rider** only | The rider app; riders see only deliveries assigned to them |

---

## 1. Turn delivery on

1. Settings → Ordering: add **Delivery** to order types, and set the flat **delivery fee** (used only while you have no zones).
2. Staff & roles: create accounts with the **Rider** role. Riders sign in on their phone at your restaurant's address; they land on **My deliveries**.
3. Optional: create **zones** (below).

## 2. Zones

- **Area:** a circle (centre latitude/longitude + radius in km) or a boundary (at least 3 points, one "latitude, longitude" per line, copied from any map).
- **Fee, minimum order, delivery minutes**, optional **hours and days**, active/inactive.
- Once at least one active zone exists, customers must **choose their area** or **share their location**. A shared location is matched to the zone that contains it; outside every zone the order is refused ("outside our delivery area"). The zone's fee replaces the flat fee, and its minimum order is checked on the server. Closed zones refuse orders.
- Zone boundaries never leave the server; the storefront only receives zone names, fees, minimums and times.
- With **no** zones, delivery works as before: flat fee, address only.
- Deactivating a zone keeps its history.

## 3. What happens to a delivery order

| Order (kitchen) | Delivery status | Who |
|---|---|---|
| accepted | **Needs rider** (`awaiting_assignment`): due time = acceptance + longest item prep time + zone minutes (30 without a zone); a 4-digit delivery code is created | system |
| | **Assigned** | automatic or dispatcher |
| | **Rider accepted** | rider |
| ready → dispatched | **Picked up** (only when the kitchen marked the order *ready*) | rider |
| | **On the way** | rider |
| completed | **Delivered**, with proof: code confirmed yes/no, note, rider, time | rider |
| | **Failed** (reason required) → **Retry** (back to *Needs rider*) or **Returned** | rider / dispatcher |
| cancelled / rejected | **Cancelled** (automatically when the order is cancelled) | staff |

All changes are atomic: two people acting at once cannot both succeed; the second gets "updated by someone else". Every assignment, acceptance, decline, timeout and unassignment is kept in the delivery's history.

## 4. Automatic assignment

When **Assign riders automatically** is on (default), a rider is picked as soon as the order is accepted.

- **Eligible riders:**
  - active Rider accounts marked **available**;
  - covering the order's zone (a rider with no zones covers all of them);
  - under the per-rider limit (default 2 active deliveries);
  - who have not already declined or timed out on this order.
- **Ranking**, in this order:
  1. fewest active deliveries;
  2. straight-line distance, only when the rider shared a location in the last 10 minutes **and** the customer shared one;
  3. longest since their last assignment;
  4. a stable tie-break.

  The explanation is stored with the assignment ("1 active delivery; distance unknown (no recent location); last assigned 25 min ago").
- **Accept timeout:** the rider has 120 s by default to accept. Otherwise a persistent background job takes the delivery back, records "timeout" and assigns the next rider. This survives server restarts.
- After **3** automatic attempts by default, or when nobody is eligible, the dispatcher is notified ("Order #12 needs a rider") with the reason.

## 5. Dispatch board (Delivery → Dispatch)

- **Columns:** Needs rider · Assigned · Out for delivery · Finished in the last 24 h and problems. Each card shows the zone, address, kitchen status, rider, due time ("late" in red) and amount to collect. It updates live.
- **Open a card** to:
  - see the ranked rider list, with the reason any rider was skipped;
  - **Assign** a rider (manual assignment or reassignment; the previous rider is notified);
  - **Auto-assign**, or **Unassign** (with a reason);
  - for failed deliveries: **Retry** or **Returned to restaurant**;
  - view the full history and proof.
- **Delay alerts:** every 2 minutes, deliveries past their due time plus the grace period (default 10 min) trigger a notification, once per delivery.

## 6. Rider app (My deliveries)

- **Available** toggle: no new deliveries while off.
- **Share my location** toggle: when on and available, the phone sends its position at most every 30 s. It is used only for ranking. Dispatchers see only *when* it was last shared, not the coordinates. It is deleted when the rider goes unavailable or stops sharing. Customers never see it.
- Each delivery shows:
  - order number, customer name and a **tap-to-call** phone number;
  - zone and address, with **Open in maps** (opens the rider's own maps app on the address or shared pin);
  - items, the amount to collect and the due time.
- **Buttons:**
  - Accept / Decline (reason);
  - Picked up (enabled when the kitchen marks the order ready);
  - On the way;
  - Delivered: with the customer's code, which is **required** if "Rider must enter the customer's code" is on, and checked whenever it is entered;
  - Could not deliver (reason).
- Riders cannot see other riders' deliveries, the order list, POS, payments or customer lists, and are not connected to the restaurant-wide live order feed.

## 7. Customer side

- Checkout: choose the area or **Use my location** (the browser asks for permission), address and phone.
- The tracking page shows the delivery status ("Finding a rider", "Rider assigned", "On the way to you", …), the rider's **first name**, the expected time and the **delivery code** while the order is on its way. It updates live.
- Optional SMS updates (Delivery → Settings → "Text the customer…", needs a configured SMS provider): rider assigned, picked up, delivered, failed, running late. One text per event, never repeated.

## 8. Analytics (Delivery → Analytics)

- **Totals:** deliveries, delivered, failed or returned, cancelled.
- **On-time rate:** delivered before the due time.
- **Average times:** prep (accepted → ready), assignment (accepted → rider accepted), pickup → delivered, order → delivered.
- **Delivery fees** collected.
- **Per rider:** delivered, on-time rate, average minutes, declines, timeouts, failures.
- **Per zone:** orders, on-time rate, fees.
- **Orders by hour.**

All times come from recorded timestamps. Distances are not measured.

## 9. Settings (Delivery → Settings)

| Setting | Default |
|---|---|
| Assign automatically | on |
| Seconds to accept | 120 |
| Automatic attempts before asking a dispatcher | 3 |
| Max active deliveries per rider | 2 |
| Minutes late before alerting | 10 |
| Require customer code | off |
| Text the customer | off |

## 10. Limits (honest)

- No live map, no turn-by-turn navigation, no traffic-aware travel times.
- Proof of delivery is the code plus a note. Photo and signature capture are not implemented.
- Cash collected by riders is not yet reconciled per rider. Record payments on the order as usual.
