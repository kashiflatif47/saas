# Marketing Automation Guide

**For:** restaurant owners, admins and managers. **Where:** Dashboard → **Marketing**.

**What TableSaaS does not do:** it never sends a message without (1) the customer's consent for that channel, (2) a person approving the message, and (3) a messaging provider *you* configured with your own account. It never buys ads or spends money on its own, and it never reports a message as delivered unless the provider confirmed it.

| Permission | Who has it by default | Allows |
|---|---|---|
| `marketing:manage` | owner, admin, manager | Segments, customer consent records, drafting/submitting/pausing campaigns and automations, test sends, opt-out list |
| `marketing:approve` | owner, admin | Approving, scheduling, resuming campaigns; activating automations; sending rules; segment rules; removing an opt-out block |
| `settings:manage` | owner, admin | Provider credentials (Channels) |

---

## 1. Channels (set up first)

| Channel | Provider | Notes |
|---|---|---|
| SMS | **Twilio** (your account) | Account SID, auth token, sender number (+E.164). |
| WhatsApp | **Twilio** (same account) | A WhatsApp-enabled sender. Outside a 24-hour customer session WhatsApp only accepts **pre-approved templates**; free text may be rejected by WhatsApp. |
| Email | **SendGrid** (your account) | API key and a verified sender address. |
| Push | — | **Not implemented.** |

- Credentials are encrypted on the server (AES-GCM with the server's `ENCRYPTION_KEY`) and never shown again. Changing them clears the "verified" mark. Press **Verify**: it makes one read-only call to the provider to check the credentials.
- **Delivery receipts (SMS/WhatsApp):** Twilio calls `…/api/webhooks/twilio/<restaurant-id>` (shown on the Channels tab), and the server checks Twilio's signature. Only these callbacks mark a message **delivered** (or failed later). Without them a message stays **sent**, meaning the provider accepted it.
- **Email:** SendGrid delivery events are not imported, so "sent" means SendGrid accepted the email.
- **Cost per message:** enter your provider's price per message. It is used for budgets, previews and reports. These are estimates; the provider's invoice is authoritative.
- **Country code** (Opt-outs & rules): needed to turn local numbers such as `0300…` into international format. Without it those customers are excluded and the preview shows how many.

## 2. Consent

- Checkout shows an **unticked** checkbox: "Send me offers by SMS/WhatsApp/email". Consent is recorded only when the customer ticks it (with time and source).
- Staff can record consent the customer gave in person (Segments & customers → customer → toggles). The app reminds you to record only real consent, and every change is audit-logged with your name.
- Every marketing message ends with an **opt-out link**. The link opens a page with a "Stop marketing messages" button; it does not opt out automatically, so link scanners cannot unsubscribe people. Opting out:
  - withdraws consent on all channels,
  - adds the phone and email to the **suppression list**,
  - skips anything still queued for that customer.
- Suppressed addresses are never messaged, even if consent is later re-entered. Removing a block (owner/admin) does not restore consent.
- Order-status texts for deliveries (if enabled in Delivery → Settings) are **transactional**: they do not need marketing consent, but suppression still applies.

## 3. Segments

Recalculated nightly (and with **Recalculate now**) from each customer's orders. Only orders with a phone number are linked to a customer.

| Segment | Rule (defaults; owner/admin can change them via `PATCH /api/staff/marketing/segments/rules`) |
|---|---|
| new | exactly 1 order, first order within 30 days |
| returning | 2 or more orders |
| loyal | 5 or more orders and ordered within the last 60 days |
| high_value | top 20 % by spend (only when there are at least 5 customers) |
| at_risk | 2+ orders, last order 31–60 days ago |
| inactive | no order for more than 60 days |
| frequent_delivery / frequent_dine_in | 3+ such orders and at least half of their orders |
| promotion_responsive | 2+ coupon orders and at least half of their orders |
| declining | fewer than half as many orders in the last 60 days as in the 60 before (with ≥ 2 before) |

The customer list masks phone numbers and emails for staff without `customers:manage`.

## 4. Campaigns

**Lifecycle:** Draft → *Submit* → Pending approval → *Approve* (owner/admin) → *Schedule* or *Send now* → Scheduled → Running → Completed. You can **pause**, **resume** (owner/admin) or **cancel** a campaign. Editing a draft or an approved campaign sends it back to Draft, so the text that goes out is always the text that was approved. After a campaign has started, its message, audience and offer cannot change.

1. **New campaign:**
   - name, channel, audience (segments; none = everyone who consented to that channel), subject (email) and message;
   - placeholders: `{{name}}`, `{{restaurant}}`, `{{coupon}}`;
   - the opt-out line is added automatically.
2. **Draft with AI** (optional): describe the goal and Claude writes a draft. No customer data is sent. The campaign is marked "AI copy" and still needs review and approval. If AI is not configured, you write the text yourself.
3. **Offer** (optional): percent or fixed amount, minimum order and how many days it is valid. When the campaign starts, one coupon code is created that only the messaged customers can use. Their phone number is checked at checkout. A coupon can also be limited to dishes or categories (via the API: `coupon.productIds` / `categoryIds`). All coupon rules are checked on the server when the order is placed.
4. **Budget** (optional): the campaign **pauses itself** before a message would exceed the limit, based on your cost per message.
5. **Preview:** recipient count, how many were excluded (no valid address, opted out), a fully rendered sample message and the estimated cost.
6. **Send test:** sends one message marked `[TEST]` to the number or email you enter, through your provider. It is logged as a test.
7. **Approve → Schedule/Send now.** Scheduling needs a configured provider.

**When a campaign starts** (a persistent background job), the server:
- takes a snapshot of the audience,
- queues exactly one message per customer (a duplicate-proof key, so restarts or double triggers cannot send twice),
- sends through the dispatcher.

**At send time every rule is checked again:**
- consent;
- suppression;
- **quiet hours** (default 21:00–09:00 restaurant time; the message is held until the end of the quiet period);
- **frequency**: no more than 2 marketing messages per customer per week, at least 24 hours apart (defaults);
- campaign end date;
- budget.

**Provider errors:**
- temporary errors (rate limit, provider down) retry up to 3 times with growing delays;
- permanent errors (for example an invalid number) are marked **failed**;
- a send interrupted mid-request (server crash) is marked **unknown** and **not** retried automatically, so the customer is never messaged twice. Check the provider's log.

## 5. Automations

| Trigger | Fires for | Sent once per |
|---|---|---|
| New customer joined | customers created in the last 24 h | customer |
| After first order / after second order | that order in the last 7 days | customer |
| Inactive for N days | last order more than N days ago | inactive spell (a new spell after they order again) |
| Birthday | customers whose birthday (MM-DD, entered by staff) is today | year |
| Reached N orders | order count ≥ N | customer |
| Spent at least an amount | total spend ≥ amount | customer |

- Automations start as drafts. **Approve & activate** (owner/admin) requires a configured provider for the channel.
- Any edit returns the automation to draft until it is approved again.
- They are checked hourly, with the same consent, opt-out, quiet-hour and frequency rules as campaigns.
- An automation can include a personal coupon.

## 6. Results (campaign → Results)

- **Messages:** accepted by the provider, delivery confirmed (from Twilio callbacks), failed, skipped (with the reason for each), unknown.
- **Verified:** orders that used the campaign's coupon code: count, revenue, customers and conversion rate (customers who redeemed ÷ messages sent).
- **Estimated:** other orders by messaged customers within the attribution window (default 7 days). This is a correlation, not proof that the message caused them.
- **Clicks:** not tracked; no link-tracking provider is integrated.
- **Cost:** sum of the per-message cost you entered (estimate).

The message log (campaign drawer, or Opt-outs & rules) shows each message with its status and reason. Recipient addresses are masked.

## 7. Troubleshooting

| You see | Why / fix |
|---|---|
| "No sms provider is configured" | Set up Channels, then Verify. |
| Preview: "excluded N without a valid address" | Local numbers need the country code (Opt-outs & rules), or the customer has no email. |
| Skipped: "frequency limit" | The customer already received messages within your limits. |
| Skipped: "no consent" / "suppressed" / "unsubscribed" | Working as designed. |
| Campaign paused: "Budget limit reached" | Raise the budget (edit while paused) and resume, or leave it. |
| Status "unknown" | The server stopped while sending. Check the provider's console before re-sending manually. |
| Message stays "sent" and never becomes "delivered" | The Twilio status callback URL is not reachable from the internet (local development), or this is email. |
