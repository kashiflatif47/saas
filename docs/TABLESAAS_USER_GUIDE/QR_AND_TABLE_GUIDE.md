# QR Codes and Tables Guide

Where: restaurant dashboard → **Tables & QR**. Viewing and downloading needs *tables:view* (owner, admin, manager, waiter, cashier); creating, editing, regenerating and deleting needs *tables:manage* (owner, admin, manager).

## Creating tables
1. **Add tables.**
2. **One table:** enter a **Label** (e.g. `T1`, `Patio 3`, `Room 204`), **Area** (e.g. Main hall, Terrace) and **Seats**.
   **Several at once:** **How many**, **Label prefix** (e.g. `T`), area and seats. TableSaaS numbers them automatically, skipping labels that already exist (so after deleting `T2`, adding 2 more creates `T2` and the next free number).
3. **Create.** Each table receives its own secret QR code.

Labels must be unique. Your plan limits the number of tables.

## The QR code
Each code opens `https://<your-subdomain>.yourdomain.com/t/<secret-code>`. Scanning it opens **your** menu with that table pre-selected. The code only works for your restaurant: on another restaurant's address it is refused.

## Downloading and printing
On each table card:
- **PNG**: high-resolution image (768 px), for printing or design tools;
- **SVG**: vector image, sharp at any size (best for professional printing);
- **Link**: copies the table's URL.

**Print all (PDF)**: an A4 PDF with one card per table (6 per page) showing your restaurant name, the QR code, *Table <label>* and "Scan to view the menu & order".

Tips: print at least 3 × 3 cm, keep a white border around the code, use matte material, and test-scan every printed code before placing it.

## Regenerating a QR code
Use **New QR** on the table card (confirm with **Regenerate**) if a printed code is lost, copied or misused. The old code **stops working immediately**, so replace the printed code on that table.

## Table status
Each table shows **available**, **occupied**, **reserved** or **cleaning**, plus open orders and the amount due.
- A table becomes **occupied** when an order is placed for it, or a reservation is seated.
- It becomes **cleaning** automatically when its last open order is completed or cancelled.
- Staff set it back to **available** (waiters can change status; structural edits need tables:manage).

**Edit** changes label, area, seats, status or **Active**. A disabled table's QR code stops working. **Delete** is only possible when the table has no open orders.

## How customers are identified by table
The QR code carries the table's secret token, never a guessable number. When the customer orders dine-in, the order is tagged with that table, so staff see *Table T4* on the order, kitchen ticket and waiter screen. If **Dine-in orders must come from a table QR** is on (Settings → Ordering & tax), customers who open the website without scanning can only order takeaway.

## Testing on a laptop (local development)
Locally, codes encode `http://<subdomain>.localhost:5173/t/<code>`. Open that link in Chrome or Edge on the same laptop. Phones can't open `*.localhost` addresses, so real phone scanning needs the deployed domain. See `TABLESAAS_LOCAL_DEVELOPMENT_GUIDE.md`.
