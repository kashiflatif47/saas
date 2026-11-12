# Complete Order Workflow

This describes exactly what the system does, using the real statuses from `server/src/lib/orderState.ts`. Screen labels are shown in **bold**.

## 1. Order statuses

| Status (system) | Shown to staff | Shown to customer | Meaning |
|---|---|---|---|
| `pending` | **New** | Received — waiting for confirmation | Just placed |
| `accepted` | **Accepted** | Confirmed by the restaurant | Sent to the kitchen |
| `preparing` | **Preparing** | Being prepared | At least one item started |
| `partially_ready` | **Partly ready** | Partly ready | Some items ready |
| `ready` | **Ready** | Ready! | Everything ready to serve or pick up |
| `delivered` | **Served** | Served — enjoy! | Handed to the customer |
| `completed` | **Completed** | Completed | Closed |
| `rejected` | **Rejected** | Declined by the restaurant | Refused before acceptance (reason required) |
| `cancelled` | **Cancelled** | Cancelled | Stopped after acceptance (reason required) |
| `refunded` | **Refunded** | Refunded | Money returned after cancellation or completion |

## 2. Allowed transitions

| From | Can move to |
|---|---|
| New | Accepted · Rejected · Cancelled |
| Accepted | Preparing · Cancelled |
| Preparing | Partly ready · Ready · Cancelled |
| Partly ready | Ready · Preparing · Cancelled |
| Ready | Served · Cancelled |
| Served | Completed |
| Completed | Refunded |
| Cancelled | Refunded |
| Rejected, Refunded | — (final) |

Anything else is refused with an error. Orders can never go back to **New**.

## 3. Step by step

**1. Customer → menu → cart → checkout.** The customer scans the table QR or opens the restaurant website, adds dishes (with options and extras), chooses **Dine-in** or **Takeaway** (whichever the restaurant enabled), optionally adds name, phone, notes and a coupon, and taps **Place order**. The server recalculates every price, discount, service charge and tax; the amount shown in the cart is only an estimate. Unavailable or sold-out dishes are refused. If the restaurant requires it, dine-in orders must come from a table QR.

**2. New order.** The order appears instantly in **Orders** (tab **New**) with a notification sound and bell alert. The customer is taken to a live tracking page. If **Auto-accept new orders** is on (Settings → Ordering & tax), the order skips straight to Accepted.

**3. Accept or reject.** Staff with the *accept orders* permission (owner, admin, manager, waiter) open the order and choose **Accept** or **Reject** (a reason is required for rejection). Accepting deducts recipe ingredients from inventory (if recipes are set) and routes each item to its kitchen station.

**4. Kitchen.** On the **Kitchen display**, each ticket lists its items for the selected station. Kitchen staff tap **Start** on an item (→ preparing) and **Ready** when done, **Undo ready** to reopen an item, or **Bump — all ready** for the whole ticket. The order status follows the items automatically: some ready → Partly ready; all ready → Ready. In the order panel a manager can also use **Start preparing** and **Mark all ready**.

**5. Ready → serve, pick-up or delivery.** When an order becomes Ready, waiters and managers are notified, and the assigned waiter gets a direct alert. Staff with *deliver orders* (waiter, manager, admin, owner) use **Mark served**. For takeaway the same button means "handed over". Delivery is available as an order type only if the restaurant enables it; there is no driver or dispatch module.

**6. Complete.** **Complete & close** finishes the order. If the order has a customer phone number, their visit count and spend are updated, and loyalty points are awarded when loyalty is enabled. When a table has no more open orders it is set to **cleaning**; staff set it back to available on the Tables or Waiter screen.

**7. Cancel or reject.** Cancelling (reason required) returns tracked dish stock and recipe ingredients, and gives back a used coupon.

## 4. Payment lifecycle (separate from the order status)

| Payment status | Meaning |
|---|---|
| **Unpaid** | Nothing collected |
| **Part paid** | Some money collected |
| **Paid** | Full total collected |
| **Part refunded** | Some money returned |
| **Refunded** | Everything returned |

- **Cash / card terminal:** staff with *collect payments* (owner, admin, manager, cashier) use **Collect payment** in the order panel, choose **Cash** or **Card terminal**, and enter the amount. Partial payments are allowed; paying more than the outstanding balance is refused.
- **Online (Stripe), if configured:** the customer taps **Pay online now** on the tracking page. The order is marked paid **only** when Stripe's signed confirmation reaches the server, never because the browser says so.
- **Refunds:** staff with *refunds* (owner, admin, manager) open a verified payment and choose **Refund** with a reason. An order becomes **Refunded** once verified refunds cover what was paid.

An order can be served before it is paid, and paid before it is served; the two statuses are independent.

## 5. Staff-entered orders

Waiters and managers can take an order themselves (Orders → **New order**, or Waiter view → **Take order**), optionally for a table. It follows the same lifecycle.
