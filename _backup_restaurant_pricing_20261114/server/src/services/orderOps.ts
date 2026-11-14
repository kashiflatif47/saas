/**
 * POS / service operations on existing orders: modification, table transfer and merge, bill requests,
 * split-bill quotes and receipt data. All money is integer minor units and is computed here, never taken
 * from the client.
 */
import { Types } from 'mongoose';
import { Coupon, Order, Payment, Table } from '../models/operations';
import { Tenant, User } from '../models/platform';
import { Product } from '../models/menu';
import { priceOrder, type CouponInput } from '../lib/pricing';
import { deriveOrderStatus, derivePaymentStatus, type OrderStatus } from '../lib/orderState';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { roleHas } from '../config/permissions';
import type { AuthUser, ResolvedTenant } from '../types/express';
import { emit } from '../sockets';
import { notify } from './notify';
import { adjustInventoryForItems } from './inventoryService';
import { broadcastOrder, buildLines, pricingSettings, publicOrder, restoreProductStock, withOrderRetry, type PlaceOrderInput } from './orderService';

const OPEN_STATUSES = ['pending', 'accepted', 'preparing', 'partially_ready', 'ready', 'delivered'];
/** Orders whose items can still be changed (nothing has left the kitchen yet). */
const MODIFIABLE = ['pending', 'accepted', 'preparing', 'partially_ready', 'ready'];

/* ------------------------------------------------------------------ totals */

/**
 * Re-prices an order from its stored lines (unit prices fixed at the time each item was ordered),
 * keeping its coupon, manual discount and delivery fee. Cancelled items no longer count.
 */
async function recomputeTotals(tenant: ResolvedTenant, order: any) {
  const active = order.items.filter((i: any) => i.status !== 'cancelled');
  if (!active.length) throw badRequest('An order needs at least one item. Cancel the order instead.');
  let coupon: CouponInput | null = null;
  if (order.couponCode) {
    const snap = order.couponSnapshot?.type ? order.couponSnapshot : await Coupon.findOne({ tenantId: tenant._id, code: order.couponCode }).lean();
    if (snap) coupon = { code: order.couponCode, type: snap.type, value: snap.value, maxDiscount: snap.maxDiscount ?? undefined, minOrder: snap.minOrder ?? undefined };
  }
  const priced = priceOrder(
    active.map((i: any) => ({
      productId: String(i.productId), name: i.name, basePrice: i.unitPrice, quantity: i.quantity,
      lineDiscount: i.discount > 0 ? { type: 'fixed' as const, value: i.discount } : null,
    })),
    pricingSettings(tenant),
    coupon,
    { manualDiscount: order.manualDiscount?.type ? { type: order.manualDiscount.type, value: order.manualDiscount.value } : null, deliveryFee: order.deliveryFee ?? 0 },
  );
  // A smaller order can make the coupon's minimum unmet: the coupon then simply stops applying.
  active.forEach((i: any, idx: number) => { i.discount = priced.lines[idx].lineDiscountAmount; });
  order.subtotal = priced.subtotal;
  order.discount = priced.discount;
  order.lineDiscountTotal = priced.lineDiscount;
  order.couponDiscount = priced.couponDiscount;
  if (order.manualDiscount?.type) order.manualDiscount.amount = priced.manualDiscount;
  order.serviceCharge = priced.serviceCharge;
  order.tax = priced.tax;
  order.total = priced.total;
  if (order.total < order.amountPaid - order.amountRefunded) {
    throw badRequest('The new total is below what has already been paid. Refund the difference first.');
  }
  order.paymentStatus = derivePaymentStatus(order.total, order.amountPaid, order.amountRefunded);
}

function afterChange(tenant: ResolvedTenant, order: any, detail: Record<string, unknown>) {
  const tenantId = String(tenant._id);
  broadcastOrder(tenantId, order);
  const stationIds = [...new Set<string>(order.items.map((i: any) => String(i.stationId ?? '')).filter(Boolean))];
  emit.kitchen(tenantId, stationIds, 'kitchen:modified', { ...publicOrder(order), change: detail });
  emit.staff(tenantId, 'order:modified', { _id: order._id, orderNumber: order.orderNumber, change: detail });
}

/* ------------------------------------------------------------------ modification */

/** Adds items to an open order. New items are queued for the kitchen; totals are re-priced on the server. */
export async function addOrderItems(tenant: ResolvedTenant, orderId: string, items: PlaceOrderInput['items'], actor: AuthUser) {
  if (items.some((i) => i.discount) && !roleHas(actor.role, 'orders:discount', actor.permissionOverrides)) throw forbidden('You are not allowed to apply discounts');
  const tenantId = tenant._id;
  const { lines, byId } = await buildLines(tenantId, items);
  let reserved: { productId: string; quantity: number }[] = [];
  const order = await withOrderRetry(async () => {
    const o = await Order.findOne({ tenantId, _id: orderId });
    if (!o) throw notFound('Order not found');
    if (!MODIFIABLE.includes(o.status)) throw badRequest(`Items cannot be added to a ${o.status} order`);
    reserved = await reserveStock(tenantId, lines, byId);
    try {
      const now = new Date();
      for (const l of lines) {
        o.items.push({
          productId: l.productId, categoryId: l.categoryId, stationId: l.stationId, name: l.name, variantName: l.variantName, addons: l.addons,
          quantity: l.quantity, unitPrice: 0, lineTotal: 0, notes: l.notes, prepMinutes: l.prepMinutes, addedAt: now,
          discount: 0,
        } as any);
        // Unit price from the same server pricing rules as a new order.
        const added: any = o.items[o.items.length - 1];
        const p = priceOrder([{ ...l, lineDiscount: l.lineDiscount ?? null }], { taxRatePercent: 0, taxInclusive: false, serviceChargePercent: 0 });
        added.unitPrice = p.lines[0].unitPrice;
        added.lineTotal = p.lines[0].lineTotal;
        added.discount = p.lines[0].lineDiscountAmount;
      }
      await recomputeTotals(tenant, o);
      if (['ready', 'preparing', 'partially_ready'].includes(o.status)) {
        const derived = deriveOrderStatus(o.status as OrderStatus, o.items as any);
        if (derived !== o.status) {
          o.statusHistory.push({ status: derived, at: now, by: actor.name });
          o.status = derived;
        }
      }
      o.modifications.push({ at: now, by: actor.name, byId: actor.id, action: 'items_added', detail: { items: lines.map((l) => ({ name: l.name, variantName: l.variantName, quantity: l.quantity })) } });
      await o.save();
      return o;
    } catch (e) {
      await restoreProductStock(tenantId, reserved);
      reserved = [];
      throw e;
    }
  });
  if (order.inventoryDeducted) await adjustInventoryForItems(tenantId, order, lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), -1, actor.id);
  const obj = order.toObject();
  afterChange(tenant, obj, { action: 'items_added', by: actor.name, items: lines.map((l) => `${l.quantity}× ${l.name}`) });
  if (order.status !== 'pending') await notify(tenantId, { type: 'order.modified', title: `Order #${order.orderNumber}: items added`, body: lines.map((l) => `${l.quantity}× ${l.name}`).join(', '), roles: ['kitchen', 'manager'] });
  return obj;
}

async function reserveStock(tenantId: Types.ObjectId, lines: { productId: string; quantity: number }[], byId: Map<string, any>) {
  const qty = new Map<string, number>();
  for (const l of lines) qty.set(l.productId, (qty.get(l.productId) ?? 0) + l.quantity);
  const reserved: { productId: string; quantity: number }[] = [];
  for (const [pid, q] of qty) {
    if (!byId.get(pid)?.trackStock) continue;
    const r = await Product.updateOne({ tenantId, _id: pid, trackStock: true, stockQty: { $gte: q } }, { $inc: { stockQty: -q } });
    if (r.modifiedCount !== 1) {
      await restoreProductStock(tenantId, reserved);
      throw conflict(`${byId.get(pid)!.name.en} is out of stock`);
    }
    reserved.push({ productId: pid, quantity: q });
  }
  return reserved;
}

/**
 * Changes quantity or instructions of an item the kitchen has NOT started. Items in preparation or done
 * keep their history: they can only be cancelled (by a manager) or left as they are.
 */
export async function updateOrderItem(tenant: ResolvedTenant, orderId: string, itemId: string, patch: { quantity?: number; notes?: string }, actor: AuthUser) {
  const tenantId = tenant._id;
  let qtyDelta = 0; // + more portions, − fewer
  let productId = '';
  const order = await withOrderRetry(async () => {
    const o = await Order.findOne({ tenantId, _id: orderId });
    if (!o) throw notFound('Order not found');
    if (!MODIFIABLE.includes(o.status)) throw badRequest(`Items of a ${o.status} order cannot be changed`);
    const item: any = o.items.find((i: any) => String(i._id) === itemId);
    if (!item) throw notFound('Item not found');
    if (item.status !== 'queued') throw badRequest('The kitchen has already started this item. Ask a manager to cancel it instead.');
    const before = { quantity: item.quantity, notes: item.notes };
    productId = String(item.productId);
    qtyDelta = patch.quantity != null ? patch.quantity - item.quantity : 0;
    const tracked = qtyDelta !== 0 && !!(await Product.exists({ tenantId, _id: item.productId, trackStock: true }));
    // Reserve extra portions of stock-tracked dishes before saving; fewer portions are returned after saving.
    if (tracked && qtyDelta > 0) {
      const r = await Product.updateOne({ tenantId, _id: item.productId, trackStock: true, stockQty: { $gte: qtyDelta } }, { $inc: { stockQty: -qtyDelta } });
      if (r.modifiedCount !== 1) throw conflict(`${item.name} is out of stock`);
    }
    if (qtyDelta !== 0) {
      // Keep a fixed line discount proportional to the quantity.
      if (item.discount > 0) item.discount = Math.round((item.discount / item.quantity) * patch.quantity!);
      item.quantity = patch.quantity;
      item.lineTotal = item.unitPrice * item.quantity;
    }
    if (patch.notes !== undefined) item.notes = patch.notes || undefined;
    try {
      await recomputeTotals(tenant, o);
      o.modifications.push({ at: new Date(), by: actor.name, byId: actor.id, action: 'item_changed', detail: { itemId, name: item.name, before, after: { quantity: item.quantity, notes: item.notes } } });
      await o.save();
    } catch (e) {
      if (tracked && qtyDelta > 0) await restoreProductStock(tenantId, [{ productId: item.productId, quantity: qtyDelta }]);
      throw e;
    }
    if (tracked && qtyDelta < 0) await restoreProductStock(tenantId, [{ productId: item.productId, quantity: -qtyDelta }]);
    return o;
  });
  if (order.inventoryDeducted && qtyDelta) await adjustInventoryForItems(tenantId, order, [{ productId, quantity: Math.abs(qtyDelta) }], qtyDelta > 0 ? -1 : 1, actor.id);
  const obj = order.toObject();
  afterChange(tenant, obj, { action: 'item_changed', by: actor.name, itemId });
  return obj;
}

/**
 * Cancels one item. Queued items: anyone with orders:modify. Items in preparation: orders:manage (the
 * kitchen already spent effort). Ready or served items cannot be cancelled here; history is preserved.
 */
export async function cancelOrderItem(tenant: ResolvedTenant, orderId: string, itemId: string, reason: string, actor: AuthUser) {
  const tenantId = tenant._id;
  let cancelled: any = null;
  const order = await withOrderRetry(async () => {
    const o = await Order.findOne({ tenantId, _id: orderId });
    if (!o) throw notFound('Order not found');
    if (!MODIFIABLE.includes(o.status)) throw badRequest(`Items of a ${o.status} order cannot be changed`);
    const item: any = o.items.find((i: any) => String(i._id) === itemId);
    if (!item) throw notFound('Item not found');
    if (item.status === 'cancelled') throw badRequest('Item is already cancelled');
    if (item.status === 'ready' || item.status === 'served') throw badRequest('This item is already prepared and cannot be removed');
    if (item.status === 'preparing' && !roleHas(actor.role, 'orders:manage', actor.permissionOverrides)) throw forbidden('The kitchen has started this item; a manager must cancel it');
    const now = new Date();
    const wasStarted = item.status === 'preparing';
    item.status = 'cancelled';
    item.cancelReason = reason;
    item.cancelledBy = actor.name;
    await recomputeTotals(tenant, o);
    const prev = o.status as OrderStatus;
    const derived = deriveOrderStatus(prev, o.items as any);
    if (derived !== prev) {
      o.status = derived;
      o.statusHistory.push({ status: derived, at: now, by: actor.name });
      if (derived === 'ready') o.readyAt = now;
    }
    o.modifications.push({ at: now, by: actor.name, byId: actor.id, action: 'item_cancelled', detail: { itemId, name: item.name, quantity: item.quantity, reason, wasStarted } });
    await o.save();
    cancelled = { productId: item.productId, quantity: item.quantity, wasStarted };
    return o;
  });
  await restoreProductStock(tenantId, [{ productId: cancelled.productId, quantity: cancelled.quantity }]);
  // Ingredients of an item that was never started go back to stock; started items count as used.
  if (order.inventoryDeducted && !cancelled.wasStarted) await adjustInventoryForItems(tenantId, order, [cancelled], 1, actor.id);
  const obj = order.toObject();
  afterChange(tenant, obj, { action: 'item_cancelled', by: actor.name, itemId, reason });
  return obj;
}

/* ------------------------------------------------------------------ tables */

async function freeTableIfIdle(tenantId: Types.ObjectId, tableId: Types.ObjectId | string) {
  const open = await Order.countDocuments({ tenantId, tableId, status: { $in: OPEN_STATUSES } });
  if (open === 0) {
    const t = await Table.findOneAndUpdate({ tenantId, _id: tableId, status: 'occupied' }, { $set: { status: 'cleaning' } }, { new: true }).lean();
    if (t) emit.staff(String(tenantId), 'table:updated', { _id: t._id, label: t.label, status: t.status });
  }
}

/** Moves a dine-in order to another table (guests changed tables). */
export async function transferOrder(tenant: ResolvedTenant, orderId: string, tableId: string, actor: AuthUser) {
  const tenantId = tenant._id;
  const target = await Table.findOne({ tenantId, _id: tableId, isActive: true }).lean();
  if (!target) throw badRequest('Table not found');
  let fromTable: any = null;
  const order = await withOrderRetry(async () => {
    const o = await Order.findOne({ tenantId, _id: orderId });
    if (!o) throw notFound('Order not found');
    if (!OPEN_STATUSES.includes(o.status)) throw badRequest(`A ${o.status} order cannot be moved`);
    if (o.type !== 'dine_in') throw badRequest('Only dine-in orders sit at a table');
    if (String(o.tableId) === String(target._id)) throw badRequest('The order is already at that table');
    fromTable = o.tableId;
    o.modifications.push({ at: new Date(), by: actor.name, byId: actor.id, action: 'table_transfer', detail: { from: o.tableLabel, to: target.label } });
    o.tableId = target._id;
    o.tableLabel = target.label;
    await o.save();
    return o;
  });
  await Table.updateOne({ tenantId, _id: target._id }, { $set: { status: 'occupied' } });
  emit.staff(String(tenantId), 'table:updated', { _id: target._id, label: target.label, status: 'occupied' });
  if (fromTable) await freeTableIfIdle(tenantId, fromTable);
  const obj = order.toObject();
  afterChange(tenant, obj, { action: 'table_transfer', by: actor.name, to: target.label });
  return obj;
}

/** Merges one table into another: every open order of `fromTableId` moves to `intoTableId`. */
export async function mergeTables(tenant: ResolvedTenant, fromTableId: string, intoTableId: string, actor: AuthUser) {
  if (fromTableId === intoTableId) throw badRequest('Choose two different tables');
  const tenantId = tenant._id;
  const [from, into] = await Promise.all([
    Table.findOne({ tenantId, _id: fromTableId }).lean(),
    Table.findOne({ tenantId, _id: intoTableId, isActive: true }).lean(),
  ]);
  if (!from || !into) throw badRequest('Table not found');
  const orders = await Order.find({ tenantId, tableId: from._id, status: { $in: OPEN_STATUSES } }).select('_id').lean();
  if (!orders.length) throw badRequest(`Table ${from.label} has no open orders to merge`);
  const moved = [];
  for (const o of orders) moved.push(await transferOrder(tenant, String(o._id), String(into._id), actor));
  return { moved: moved.length, into: { _id: into._id, label: into.label } };
}

/** A waiter asks for the bill: cashiers and managers are notified; the order shows "bill requested". */
export async function requestBill(tenant: ResolvedTenant, orderId: string, actor: AuthUser) {
  const tenantId = tenant._id;
  const order = await Order.findOneAndUpdate(
    { tenantId, _id: orderId, status: { $in: OPEN_STATUSES } },
    { $set: { billRequestedAt: new Date() }, $push: { modifications: { at: new Date(), by: actor.name, byId: actor.id, action: 'bill_requested' } } },
    { new: true },
  ).lean();
  if (!order) throw badRequest('Order not found or already closed');
  broadcastOrder(String(tenantId), order);
  await notify(tenantId, { type: 'order.bill', title: `Bill requested · #${order.orderNumber}`, body: order.tableLabel ? `Table ${order.tableLabel}` : undefined, link: `/dashboard/orders/${order._id}`, roles: ['cashier', 'manager', 'owner', 'admin'] });
  return order;
}

/* ------------------------------------------------------------------ split bills */

export interface SplitRequest {
  mode: 'equal' | 'items';
  parts?: number; // equal: number of guests
  items?: { itemId: string; quantity: number }[]; // items: what this guest pays for
}

/** Item quantities already covered by verified item-split payments. */
async function paidItemQuantities(tenantId: Types.ObjectId, orderId: Types.ObjectId) {
  const pays = await Payment.find({ tenantId, orderId, kind: 'charge', status: 'verified', 'allocation.mode': 'items' }).select('allocation').lean();
  const paid = new Map<string, number>();
  for (const p of pays) for (const i of p.allocation?.items ?? []) paid.set(i.itemId!, (paid.get(i.itemId!) ?? 0) + (i.quantity ?? 0));
  return paid;
}

/**
 * Server-side split-bill amounts.
 *  - equal: the outstanding balance divided into `parts`, remainders on the first parts (sums exactly).
 *  - items: the selected items' share of the order total (after discounts, service, delivery and tax, in
 *    proportion to their discounted line value), capped at the balance; selecting everything unpaid equals the balance.
 */
export async function splitQuote(tenant: ResolvedTenant, orderId: string, req: SplitRequest) {
  const tenantId = tenant._id;
  const order = await Order.findOne({ tenantId, _id: orderId }).lean();
  if (!order) throw notFound('Order not found');
  const due = Math.max(0, order.total - order.amountPaid);
  if (due <= 0) throw badRequest('Order is already fully paid');
  if (req.mode === 'equal') {
    const n = req.parts ?? 0;
    if (!Number.isInteger(n) || n < 2 || n > 50) throw badRequest('Split between 2 and 50 guests');
    const base = Math.floor(due / n);
    const rem = due - base * n;
    return { mode: 'equal', due, parts: Array.from({ length: n }, (_, i) => ({ part: i + 1, amount: base + (i < rem ? 1 : 0) })) };
  }
  const active = order.items.filter((i: any) => i.status !== 'cancelled');
  const paid = await paidItemQuantities(tenantId, order._id);
  const net = (i: any) => i.lineTotal - (i.discount ?? 0);
  const activeNet = active.reduce((s: number, i: any) => s + net(i), 0);
  const selected = req.items ?? [];
  if (!selected.length) throw badRequest('Choose at least one item');
  let selNet = 0;
  let coversAllRemaining = true;
  const chosen = new Map(selected.map((s) => [s.itemId, s.quantity]));
  for (const i of active) {
    const id = String(i._id);
    const remaining = i.quantity - (paid.get(id) ?? 0);
    const q = chosen.get(id) ?? 0;
    if (!Number.isInteger(q) || q < 0) throw badRequest('Invalid quantity');
    if (q > remaining) throw badRequest(`Only ${remaining} × ${i.name} left to pay`);
    if (q < remaining) coversAllRemaining = false;
    selNet += (net(i) * q) / i.quantity;
  }
  for (const id of chosen.keys()) if (!active.some((i: any) => String(i._id) === id)) throw badRequest('Unknown item');
  let amount = activeNet > 0 ? Math.round((order.total * selNet) / activeNet) : 0;
  if (coversAllRemaining) amount = due;
  amount = Math.min(amount, due);
  if (amount <= 0) throw badRequest('Nothing to pay for that selection');
  return { mode: 'items', due, amount, items: selected.filter((s) => s.quantity > 0) };
}

/* ------------------------------------------------------------------ receipts */

export async function receiptData(tenant: ResolvedTenant, orderId: string) {
  const tenantId = tenant._id;
  const [order, t, payments] = await Promise.all([
    Order.findOne({ tenantId, _id: orderId }).lean(),
    Tenant.findById(tenantId).select('name contact branding.logoUrl settings').lean(),
    Payment.find({ tenantId, orderId, status: 'verified' }).populate('verifiedBy', 'name').sort({ createdAt: 1 }).lean(),
  ]);
  if (!order || !t) throw notFound('Order not found');
  const s: any = t.settings ?? {};
  const cashierIds = [...new Set(payments.map((p: any) => String(p.verifiedBy?._id ?? '')).filter(Boolean))];
  const cashiers = cashierIds.length ? await User.find({ tenantId, _id: { $in: cashierIds } }).select('name').lean() : [];
  const charges = payments.filter((p) => p.kind === 'charge');
  const refunds = payments.filter((p) => p.kind === 'refund');
  return {
    restaurant: { name: t.name, logoUrl: (t.branding as any)?.logoUrl, address: [t.contact?.address, t.contact?.city, t.contact?.country].filter(Boolean).join(', '), phone: t.contact?.phone, email: t.contact?.email, taxRegistrationNumber: s.taxRegistrationNumber || undefined, footer: s.receiptFooter || undefined },
    currency: order.currency,
    currencyDecimals: s.currencyDecimals ?? 2,
    order: {
      _id: order._id, orderNumber: order.orderNumber, createdAt: order.createdAt, type: order.type, source: order.source,
      tableLabel: order.tableLabel, customer: order.customer, delivery: order.delivery, status: order.status, paymentStatus: order.paymentStatus,
      takenBy: order.createdBy?.name, cashiers: cashiers.map((c) => c.name),
    },
    items: order.items.filter((i: any) => i.status !== 'cancelled').map((i: any) => ({
      name: i.name, variantName: i.variantName, addons: (i.addons ?? []).map((a: any) => a.name), quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal, discount: i.discount ?? 0, notes: i.notes,
    })),
    totals: {
      subtotal: order.subtotal, lineDiscount: order.lineDiscountTotal ?? 0, couponDiscount: order.couponDiscount ?? (order.couponCode ? order.discount : 0), couponCode: order.couponCode,
      manualDiscount: order.manualDiscount?.amount ?? 0, manualDiscountReason: order.manualDiscount?.reason, discount: order.discount,
      serviceCharge: order.serviceCharge, deliveryFee: order.deliveryFee ?? 0, tax: order.tax, total: order.total,
      paid: order.amountPaid, refunded: order.amountRefunded, balance: Math.max(0, order.total - order.amountPaid),
    },
    // Net amount the tax was calculated on (inclusive: extracted from the total; exclusive: added on top).
    tax: { label: s.taxLabel || 'Tax', ratePercent: s.taxRatePercent ?? 0, inclusive: !!s.taxInclusive, taxable: order.total - order.tax },
    payments: charges.map((p: any) => ({ method: p.method, amount: p.amount, at: p.verifiedAt ?? p.createdAt, by: p.verifiedBy?.name, label: p.allocation?.label ?? (p.allocation?.mode === 'equal' ? `Share ${p.allocation.part}/${p.allocation.parts}` : undefined) })),
    refunds: refunds.map((p: any) => ({ method: p.method, amount: p.amount, at: p.verifiedAt ?? p.createdAt, reason: p.reason })),
    printedAt: new Date(),
  };
}
