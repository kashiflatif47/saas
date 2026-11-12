import mongoose, { Types } from 'mongoose';
import { Category, KitchenStation, Product, effectivePrice } from '../models/menu';
import { Counter, Coupon, Customer, Order, Table } from '../models/operations';
import { priceOrder, type CouponInput, type ManualDiscountInput, type PricingLineInput } from '../lib/pricing';
import { canTransition, canTransitionItem, deriveOrderStatus, type ItemStatus, type OrderStatus } from '../lib/orderState';
import { randomToken } from '../lib/crypto';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { roleHas } from '../config/permissions';
import type { ResolvedTenant, AuthUser } from '../types/express';
import { emit } from '../sockets';
import { notify } from './notify';
import { consumeInventoryForOrder, restoreInventoryForOrder } from './inventoryService';
import { cancelDeliveryOn, customerDeliveryView, resolveDeliveryZone } from './delivery';
import { setConsent } from './marketing';

export interface PlaceOrderInput {
  type: 'dine_in' | 'takeaway' | 'pickup' | 'delivery';
  delivery?: { address?: string; notes?: string; zoneId?: string; location?: { lat: number; lng: number } };
  /** Customer ticked "send me offers" at checkout (explicit opt-in; never assumed). */
  marketingConsent?: boolean;
  /** Authorised manual discounts (staff with orders:discount only) and the reason recorded for audit. */
  orderDiscount?: ManualDiscountInput;
  discountReason?: string;
  /** Staff orders: confirm immediately (send to the kitchen) instead of waiting in Pending. */
  confirm?: boolean;
  tableToken?: string;
  tableId?: string; // staff-created orders only
  customer?: { name?: string; phone?: string; email?: string };
  notes?: string;
  couponCode?: string;
  idempotencyKey?: string;
  items: { productId: string; variantId?: string; addonIds?: string[]; quantity: number; notes?: string; discount?: ManualDiscountInput }[];
}

/** The order already placed with this checkout key (tenant-scoped), with its tracking token. */
async function findByIdempotencyKey(tenantId: Types.ObjectId, key: string) {
  const o = await Order.findOne({ tenantId, idempotencyKey: key }).select('+trackingToken').lean();
  if (!o) return null;
  const { trackingToken, ...order } = o as any;
  return { order, trackingToken: trackingToken as string };
}

const isVersionError = (e: unknown) => e instanceof mongoose.Error.VersionError;

/**
 * Runs a read-modify-save on an order, re-running it from a fresh read when another request saved the same
 * order in between (optimistic concurrency). Re-running re-checks every rule against the new state, so a
 * second "accept" correctly fails as an invalid transition instead of being applied twice.
 */
export async function withOrderRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isVersionError(e) || i >= attempts) throw e;
    }
  }
}

export async function nextSequence(tenantId: Types.ObjectId, key: string): Promise<number> {
  const c = await Counter.findOneAndUpdate({ tenantId, key }, { $inc: { seq: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return c!.seq;
}

/** Loads and validates an active coupon for a tenant. Returns null if not usable. */
async function loadCoupon(tenantId: Types.ObjectId, code: string, now = new Date()) {
  const c = await Coupon.findOne({ tenantId, code: code.toUpperCase().trim(), isActive: true }).lean();
  if (!c) return null;
  if (c.startsAt && c.startsAt > now) return null;
  if (c.endsAt && c.endsAt < now) return null;
  if (c.usageLimit != null && c.usedCount >= c.usageLimit) return null;
  return c;
}

/** Restores product stock for tracked products (used on failure rollback and on cancellation). */
export async function restoreProductStock(tenantId: Types.ObjectId, items: { productId: Types.ObjectId | string; quantity: number }[]) {
  for (const i of items) {
    await Product.updateOne({ tenantId, _id: i.productId, trackStock: true }, { $inc: { stockQty: i.quantity } });
  }
}

export interface PreparedLine extends PricingLineInput {
  categoryId: Types.ObjectId;
  stationId?: Types.ObjectId;
  notes?: string;
  prepMinutes?: number;
}

const SALE_TYPES_NEEDING_NAME = ['pickup'];

/**
 * Validates an order request against THIS tenant's data and prices it on the server. Used to place
 * orders, to quote them in the POS (nothing is persisted) and to price items added to an open order.
 * Client-submitted prices, taxes and totals are never read: only ids, quantities and discount requests.
 */
export async function prepareOrder(tenant: ResolvedTenant, input: PlaceOrderInput, source: 'qr' | 'website' | 'staff', staff?: AuthUser) {
  const tenantId = tenant._id;
  const s = tenant.settings ?? {};

  if (source !== 'staff' && !s.guestOrdering) throw new AppError(403, 'Online ordering is disabled', 'ORDERING_DISABLED');
  if (!(s.orderTypes ?? ['dine_in']).includes(input.type)) throw badRequest('Order type not available');

  /* 1. Table identification */
  let table: { _id: Types.ObjectId; label: string } | null = null;
  if (input.tableToken) {
    table = await Table.findOne({ tenantId, qrToken: input.tableToken, isActive: true }).select('label').lean();
    if (!table) throw badRequest('This table QR code is invalid or has been regenerated. Please scan again.');
  } else if (input.tableId && source === 'staff') {
    table = await Table.findOne({ tenantId, _id: input.tableId, isActive: true }).select('label').lean();
    if (!table) throw badRequest('Table not found');
  }
  if (input.type === 'dine_in' && s.requireTableForDineIn && !table) throw badRequest('Dine-in orders require a table. Please scan the QR code on your table.');
  if (input.type !== 'dine_in') table = null; // takeaway, pickup and delivery never occupy a table

  /* 1b. Fulfilment details */
  if (input.type === 'delivery') {
    if (!input.delivery?.address || input.delivery.address.trim().length < 5) throw badRequest('A delivery address is required');
    if (!input.customer?.phone) throw badRequest('A contact phone number is required for delivery');
  }
  if (SALE_TYPES_NEEDING_NAME.includes(input.type) && !input.customer?.name && !input.customer?.phone) {
    throw badRequest('A customer name or phone number is required for pickup orders');
  }

  /* 2b. Manual discounts: permission, reason and limit */
  const wantsManual = !!input.orderDiscount || input.items.some((i) => i.discount);
  if (wantsManual) {
    if (source !== 'staff' || !staff) throw badRequest('Discounts can only be applied by staff');
    if (!roleHas(staff.role, 'orders:discount', staff.permissionOverrides)) throw forbidden('You are not allowed to apply discounts');
    if (!input.discountReason || input.discountReason.trim().length < 3) throw badRequest('A reason is required for manual discounts');
  }

  const { lines, byId } = await buildLines(tenantId, input.items);

  /* 3. Coupon + server-side pricing */
  let couponDoc: Awaited<ReturnType<typeof loadCoupon>> = null;
  if (input.couponCode) {
    couponDoc = await loadCoupon(tenantId, input.couponCode);
    if (!couponDoc) throw badRequest('Coupon is invalid or expired');
  }
  let eligibleProductIds: string[] | undefined;
  if (couponDoc) {
    // Customer-specific coupons (e.g. a campaign offer): the order's phone must belong to a targeted customer.
    if (couponDoc.customerIds?.length) {
      const phone = input.customer?.phone?.replace(/[^\d+]/g, '');
      const cust = phone ? await Customer.findOne({ tenantId, phone }).select('_id').lean() : null;
      if (!cust || !couponDoc.customerIds.includes(String(cust._id))) throw badRequest('This coupon is personal: enter the phone number it was sent to');
    }
    // Dish- or category-restricted coupons discount only eligible lines.
    if (couponDoc.productIds?.length || couponDoc.categoryIds?.length) {
      eligibleProductIds = lines.filter((l) => couponDoc!.productIds?.includes(l.productId) || couponDoc!.categoryIds?.includes(String(l.categoryId))).map((l) => l.productId);
      if (!eligibleProductIds.length) throw badRequest('This coupon does not apply to the dishes in your order');
    }
  }
  const coupon: CouponInput | null = couponDoc
    ? { code: couponDoc.code, type: couponDoc.type as 'percent' | 'fixed', value: couponDoc.value, maxDiscount: couponDoc.maxDiscount ?? undefined, minOrder: couponDoc.minOrder ?? undefined, eligibleProductIds }
    : null;

  /* 3b. Delivery zone (fee, minimum order, opening hours) when the restaurant has zones */
  const zone = input.type === 'delivery' ? await resolveDeliveryZone(tenant, { zoneId: input.delivery?.zoneId, location: input.delivery?.location }) : null;
  const priced = priceOrder(lines, pricingSettings(tenant), coupon, {
    manualDiscount: input.orderDiscount ?? null,
    deliveryFee: input.type === 'delivery' ? (zone ? zone.fee ?? 0 : s.deliveryFee ?? 0) : 0,
  });
  if (coupon && priced.couponRejectedReason) throw badRequest(`Coupon not applied: ${priced.couponRejectedReason}`);
  if (zone?.minOrder && priced.subtotal - priced.discount < zone.minOrder) throw badRequest(`The minimum order for delivery to ${zone.name} is ${(zone.minOrder / 10 ** (s.currencyDecimals ?? 2)).toFixed(s.currencyDecimals ?? 2)}`);
  if (wantsManual) assertDiscountWithinLimit(tenant, staff!, priced.subtotal, priced.lineDiscount + priced.manualDiscount);

  return { table, lines, byId, priced, couponDoc, zone };
}

/** Loads products strictly from this tenant and builds priced-ready lines (availability, options, stations). */
export async function buildLines(tenantId: Types.ObjectId, items: PlaceOrderInput['items']) {
  /* 2. Load products strictly from this tenant */
  const ids = [...new Set(items.map((i) => i.productId))];
  const products = await Product.find({ tenantId, _id: { $in: ids }, isArchived: false }).lean();
  if (products.length !== ids.length) throw badRequest('One or more items are no longer available');
  const byId = new Map<string, any>(products.map((p) => [String(p._id), p]));
  const cats = await Category.find({ tenantId, _id: { $in: products.map((p) => p.categoryId) } }).select('isActive stationId').lean();
  const catById = new Map<string, any>(cats.map((c) => [String(c._id), c]));
  const defaultStation = await KitchenStation.findOne({ tenantId, isDefault: true, isActive: true }).select('_id').lean();

  const lines: PreparedLine[] = [];
  for (const it of items) {
    const p = byId.get(it.productId)!;
    const cat = catById.get(String(p.categoryId));
    if (!p.isAvailable || !cat?.isActive) throw badRequest(`${p.name.en} is currently unavailable`);
    const variant = it.variantId ? p.variants.find((v: any) => String(v._id) === it.variantId) : undefined;
    if (it.variantId && !variant) throw badRequest(`Invalid option for ${p.name.en}`);
    if (!it.variantId && p.variants.length > 0) throw badRequest(`Please choose an option for ${p.name.en}`);
    const addons = (it.addonIds ?? []).map((aid) => {
      const a = p.addons.find((x: any) => String(x._id) === aid && x.isAvailable);
      if (!a) throw badRequest(`Invalid add-on for ${p.name.en}`);
      return { name: a.name, price: a.price };
    });
    lines.push({
      productId: String(p._id),
      name: p.name.en,
      basePrice: effectivePrice(p as any),
      variantName: variant?.name,
      variantDelta: variant?.priceDelta ?? 0,
      addons,
      quantity: it.quantity,
      lineDiscount: it.discount ?? null,
      categoryId: p.categoryId,
      stationId: (cat?.stationId as Types.ObjectId | undefined) ?? (defaultStation?._id as Types.ObjectId | undefined),
      notes: it.notes,
      prepMinutes: typeof p.prepMinutes === 'number' ? p.prepMinutes : undefined,
    });
  }

  return { lines, byId };
}

export function pricingSettings(tenant: ResolvedTenant) {
  const s = tenant.settings ?? {};
  return { taxRatePercent: s.taxRatePercent ?? 0, taxInclusive: !!s.taxInclusive, serviceChargePercent: s.serviceChargePercent ?? 0 };
}

/** Owners are unrestricted; everyone else is capped by settings.maxManualDiscountPercent of the subtotal. */
export function assertDiscountWithinLimit(tenant: ResolvedTenant, staff: AuthUser, subtotal: number, manual: number) {
  if (staff.role === 'owner' || manual <= 0) return;
  const cap = tenant.settings?.maxManualDiscountPercent ?? 100;
  if (subtotal > 0 && (manual / subtotal) * 100 > cap + 1e-9) throw forbidden(`Manual discounts above ${cap}% need the owner`);
}

/** Server-side price preview for the POS. Nothing is reserved or saved. */
export async function quoteOrder(tenant: ResolvedTenant, input: PlaceOrderInput, staff: AuthUser) {
  const { priced } = await prepareOrder(tenant, input, 'staff', staff);
  return {
    lines: priced.lines.map((l) => ({ productId: l.productId, name: l.name, variantName: l.variantName, addons: l.addons, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, discount: l.lineDiscountAmount })),
    subtotal: priced.subtotal,
    lineDiscount: priced.lineDiscount,
    couponDiscount: priced.couponDiscount,
    manualDiscount: priced.manualDiscount,
    discount: priced.discount,
    serviceCharge: priced.serviceCharge,
    deliveryFee: priced.deliveryFee,
    tax: priced.tax,
    total: priced.total,
    couponApplied: priced.couponApplied,
  };
}

export async function placeOrder(
  tenant: ResolvedTenant,
  input: PlaceOrderInput,
  source: 'qr' | 'website' | 'staff',
  staff?: AuthUser,
) {
  const tenantId = tenant._id;
  const s = tenant.settings ?? {};

  /* 0. Duplicate submission (retry after a timeout, double tap): return the order already placed. */
  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(tenantId, input.idempotencyKey);
    if (existing) return existing;
  }

  const { table, lines, byId, priced, couponDoc, zone } = await prepareOrder(tenant, input, source, staff);

  /* 4. Atomic stock reservation for tracked products (compensating rollback on failure) */
  const qtyByProduct = new Map<string, number>();
  for (const l of lines) qtyByProduct.set(l.productId, (qtyByProduct.get(l.productId) ?? 0) + l.quantity);
  const reserved: { productId: string; quantity: number }[] = [];
  for (const [pid, qty] of qtyByProduct) {
    if (!byId.get(pid)!.trackStock) continue;
    const r = await Product.updateOne({ tenantId, _id: pid, trackStock: true, stockQty: { $gte: qty } }, { $inc: { stockQty: -qty } });
    if (r.modifiedCount !== 1) {
      await restoreProductStock(tenantId, reserved);
      throw conflict(`${byId.get(pid)!.name.en} is out of stock`);
    }
    reserved.push({ productId: pid, quantity: qty });
  }

  // Once the order document exists, stock and coupon usage belong to it: a later failure (e.g. auto-accept)
  // must not hand them back, or the order would be sold without its reservation.
  let created = false;
  try {
    /* 5. Coupon usage (atomic against usageLimit) */
    if (couponDoc) {
      const filter: any = { tenantId, _id: couponDoc._id };
      if (couponDoc.usageLimit != null) filter.usedCount = { $lt: couponDoc.usageLimit };
      const r = await Coupon.updateOne(filter, { $inc: { usedCount: 1 } });
      if (r.modifiedCount !== 1) throw badRequest('Coupon usage limit reached');
    }

    /* 6. Customer record */
    let customerId: Types.ObjectId | undefined;
    const phone = input.customer?.phone?.replace(/[^\d+]/g, '');
    if (phone) {
      const c = await Customer.findOneAndUpdate(
        { tenantId, phone },
        // Filter fields (tenantId, phone) are written on insert; timestamps guarantee a non-empty update.
        { $set: { ...(input.customer?.name ? { name: input.customer.name } : {}), ...(input.customer?.email ? { email: input.customer.email } : {}) } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      customerId = c!._id;
      if (input.marketingConsent === true) await setConsent(tenantId, c!._id, input.customer?.email ? ['sms', 'whatsapp', 'email'] : ['sms', 'whatsapp'], true, source === 'staff' ? 'staff' : 'checkout');
    }

    const orderNumber = await nextSequence(tenantId, 'order');
    const trackingToken = randomToken(18);
    const order = await Order.create({
      tenantId,
      orderNumber,
      type: input.type,
      source,
      tableId: table?._id,
      tableLabel: table?.label,
      customer: input.customer,
      customerId,
      items: priced.lines.map((l, idx) => ({
        productId: l.productId,
        categoryId: lines[idx].categoryId,
        stationId: lines[idx].stationId,
        name: l.name,
        variantName: l.variantName,
        addons: l.addons,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        discount: l.lineDiscountAmount,
        discountReason: l.lineDiscountAmount ? input.discountReason : undefined,
        notes: lines[idx].notes,
        prepMinutes: lines[idx].prepMinutes,
      })),
      subtotal: priced.subtotal,
      discount: priced.discount,
      lineDiscountTotal: priced.lineDiscount,
      couponDiscount: priced.couponDiscount,
      manualDiscount: input.orderDiscount && priced.manualDiscount ? { ...input.orderDiscount, amount: priced.manualDiscount, reason: input.discountReason, by: staff?.name, byId: staff?.id } : undefined,
      couponSnapshot: couponDoc ? { type: couponDoc.type, value: couponDoc.value, maxDiscount: couponDoc.maxDiscount ?? undefined, minOrder: couponDoc.minOrder ?? undefined } : undefined,
      deliveryFee: priced.deliveryFee,
      delivery: input.type === 'delivery' ? { address: input.delivery?.address?.trim(), notes: input.delivery?.notes, zoneId: zone?._id, zoneName: zone?.name, location: input.delivery?.location ? { ...input.delivery.location, source: source === 'staff' ? 'staff' : 'customer' } : undefined } : undefined,
      createdBy: staff ? { id: staff.id, name: staff.name } : undefined,
      serviceCharge: priced.serviceCharge,
      tax: priced.tax,
      total: priced.total,
      couponCode: priced.couponApplied,
      currency: s.currency ?? 'PKR',
      notes: input.notes,
      trackingToken,
      idempotencyKey: input.idempotencyKey,
      statusHistory: [{ status: 'pending', by: staff?.name ?? 'customer' }],
    });
    created = true;

    if (table) {
      await Table.updateOne({ tenantId, _id: table._id }, { $set: { status: 'occupied' } });
      emit.staff(String(tenantId), 'table:updated', { _id: table._id, label: table.label, status: 'occupied' });
    }

    const summary = publicOrder(order.toObject());
    emit.staff(String(tenantId), 'order:new', summary);
    await notify(tenantId, {
      type: 'order.new',
      title: `New order #${orderNumber}`,
      body: `${table ? `Table ${table.label} · ` : ''}${order.items.length} item(s)`,
      link: `/dashboard/orders/${order._id}`,
      roles: ['owner', 'admin', 'manager', 'waiter', 'cashier'],
    });

    // Staff orders from the POS are confirmed by the person taking them; others follow the auto-accept setting.
    if (s.autoAcceptOrders || (source === 'staff' && input.confirm)) {
      await transitionOrder(tenant, String(order._id), 'accepted', staff ?? { id: '', tenantId: tenant.id, role: 'owner', name: 'auto-accept' });
    }

    return { order: await Order.findOne({ tenantId, _id: order._id }).lean(), trackingToken };
  } catch (e: any) {
    if (created) throw e;
    await restoreProductStock(tenantId, reserved);
    if (couponDoc) await Coupon.updateOne({ tenantId, _id: couponDoc._id, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
    // Two simultaneous submissions with the same key: the loser returns the winner's order.
    if (e?.code === 11000 && e?.keyPattern?.idempotencyKey && input.idempotencyKey) {
      const existing = await findByIdempotencyKey(tenantId, input.idempotencyKey);
      if (existing) return existing;
    }
    throw e;
  }
}

/** Fields safe to show a customer or broadcast to staff screens. */
export function publicOrder(o: any) {
  const { trackingToken: _t, idempotencyKey: _k, ...rest } = o;
  return rest;
}

export function transitionOrder(tenant: ResolvedTenant, orderId: string, to: OrderStatus, actor: AuthUser, reason?: string) {
  return withOrderRetry(() => transitionOrderOnce(tenant, orderId, to, actor, reason));
}

async function transitionOrderOnce(
  tenant: ResolvedTenant,
  orderId: string,
  to: OrderStatus,
  actor: AuthUser,
  reason?: string,
) {
  const tenantId = tenant._id;
  const order = await Order.findOne({ tenantId, _id: orderId });
  if (!order) throw notFound('Order not found');
  const from = order.status as OrderStatus;
  if (!canTransition(from, to)) throw badRequest(`Cannot change order from ${from} to ${to}`);
  // Money held for an order must be returned through the refund workflow before it can be cancelled.
  if ((to === 'cancelled' || to === 'rejected') && order.amountPaid - order.amountRefunded > 0) {
    throw badRequest('This order has payments. Refund them first (Payments → Refund), then cancel the order.');
  }
  if (to === 'refunded' && order.amountRefunded < order.amountPaid) {
    throw badRequest('Record the refund in Payments first; the order becomes refunded once verified refunds cover the paid amount');
  }

  const now = new Date();
  order.status = to;
  order.statusHistory.push({ status: to, at: now, by: actor.name });
  if (to === 'accepted') {
    order.acceptedAt = now;
    // Estimated ready time from the dishes' configured preparation times (longest dish), when configured.
    const prep = Math.max(0, ...order.items.filter((i: any) => i.status !== 'cancelled').map((i: any) => i.prepMinutes ?? 0));
    if (prep > 0) order.estimatedReadyAt = new Date(now.getTime() + prep * 60_000);
  }
  if (to === 'ready') {
    order.readyAt = now;
    order.items.forEach((i: any) => {
      if (i.status !== 'cancelled' && i.status !== 'served') {
        i.status = 'ready';
        i.readyAt = i.readyAt ?? now;
      }
    });
  }
  if (to === 'delivered') {
    order.deliveredAt = now;
    order.items.forEach((i: any) => {
      if (i.status !== 'cancelled') {
        i.status = 'served';
        i.servedAt = now;
      }
    });
  }
  if (to === 'completed') order.completedAt = now;
  if (to === 'rejected' || to === 'cancelled') {
    order.rejectionReason = reason;
    order.items.forEach((i: any) => {
      if (i.status !== 'served') i.status = 'cancelled';
    });
    cancelDeliveryOn(order, now); // a cancelled order is never dispatched
  }
  await order.save();

  /* Side effects */
  if (to === 'accepted' && !order.inventoryDeducted) {
    await consumeInventoryForOrder(tenantId, order, actor.id || undefined);
  }
  // Delivery orders enter dispatch once confirmed (due time, confirmation code, automatic assignment).
  if (to === 'accepted' && order.type === 'delivery') {
    const { onDeliveryOrderConfirmed } = await import('./delivery');
    await onDeliveryOrderConfirmed(tenant, String(order._id)).catch((e) => console.error('[DELIVERY] dispatch failed', e?.message));
  }
  if (to === 'rejected' || to === 'cancelled') {
    await restoreProductStock(tenantId, order.items.map((i: any) => ({ productId: i.productId, quantity: i.quantity })));
    if (order.inventoryDeducted) await restoreInventoryForOrder(tenantId, order, actor.id || undefined);
    if (order.couponCode) await Coupon.updateOne({ tenantId, code: order.couponCode, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
  }
  if (['completed', 'rejected', 'cancelled'].includes(to) && order.tableId) {
    const stillOpen = await Order.countDocuments({ tenantId, tableId: order.tableId, status: { $nin: ['completed', 'rejected', 'cancelled', 'refunded'] } });
    if (stillOpen === 0) {
      await Table.updateOne({ tenantId, _id: order.tableId }, { $set: { status: 'cleaning' } });
      emit.staff(String(tenantId), 'table:updated', { _id: order.tableId, label: order.tableLabel, status: 'cleaning' });
    }
  }
  if (to === 'completed' && order.customerId) {
    const pointsPer = tenant.settings?.loyaltyEnabled ? tenant.settings?.loyaltyPointsPerUnit ?? 0 : 0;
    const decimals = tenant.settings?.currencyDecimals ?? 2;
    const points = Math.floor((order.total / 10 ** decimals / 100) * pointsPer);
    await Customer.updateOne(
      { tenantId, _id: order.customerId },
      { $inc: { totalOrders: 1, totalSpent: order.total, loyaltyPoints: points }, $set: { lastOrderAt: now } },
    );
    if (points) await Order.updateOne({ tenantId, _id: order._id }, { $set: { loyaltyAwarded: points } });
  }

  broadcastOrder(String(tenantId), order.toObject());
  if (to === 'accepted') {
    const stationIds = [...new Set<string>(order.items.map((i: any) => String(i.stationId ?? '')).filter(Boolean))];
    emit.kitchen(String(tenantId), stationIds, 'kitchen:new', publicOrder(order.toObject()));
  }
  if (to === 'ready') {
    await notify(tenantId, { type: 'order.ready', title: `Order #${order.orderNumber} is ready`, body: order.tableLabel ? `Table ${order.tableLabel}` : undefined, roles: ['waiter', 'manager', 'owner', 'admin'] });
  }
  return order.toObject();
}

export function updateItemStatus(tenant: ResolvedTenant, orderId: string, itemId: string, to: ItemStatus, actor: AuthUser) {
  // Two cooks finishing different items of one order at the same moment must both succeed.
  return withOrderRetry(() => updateItemsStatusOnce(tenant, orderId, [itemId], to, actor, true));
}

/**
 * Moves several items of one order at once (a station's "Start all" / "All ready" on the KDS).
 * Items already in the target state, cancelled or served are skipped; any other item that cannot make the
 * transition fails the whole request so the screen never shows a half-applied bump.
 */
/** `at`: when the action happened (offline kitchen actions); clamped between the order's confirmation and now. */
export function updateItemsStatus(tenant: ResolvedTenant, orderId: string, itemIds: string[], to: ItemStatus, actor: AuthUser, at?: Date) {
  return withOrderRetry(() => updateItemsStatusOnce(tenant, orderId, itemIds, to, actor, false, at));
}

async function updateItemsStatusOnce(tenant: ResolvedTenant, orderId: string, itemIds: string[], to: ItemStatus, actor: AuthUser, strict: boolean, at?: Date) {
  const tenantId = tenant._id;
  const order = await Order.findOne({ tenantId, _id: orderId });
  if (!order) throw notFound('Order not found');
  if (!['accepted', 'preparing', 'partially_ready', 'ready'].includes(order.status)) throw badRequest('Order is not in the kitchen');
  const floor = order.acceptedAt ? new Date(order.acceptedAt).getTime() : 0;
  const now = at ? new Date(Math.min(Date.now(), Math.max(floor, at.getTime()))) : new Date();
  let changed = 0;
  for (const itemId of itemIds) {
    const item: any = order.items.find((i: any) => String(i._id) === itemId);
    if (!item) throw notFound('Item not found');
    if (!strict && (item.status === to || item.status === 'cancelled' || item.status === 'served')) continue;
    if (!canTransitionItem(item.status, to)) throw badRequest(`Cannot change ${item.name} from ${item.status} to ${to}`);
    item.status = to;
    if (to === 'preparing') {
      item.startedAt = item.startedAt ?? now;
      item.startedBy = item.startedBy ?? actor.name;
    }
    if (to === 'ready') {
      item.startedAt = item.startedAt ?? now;
      item.readyAt = now;
      item.readyBy = actor.name;
    }
    if (to === 'served') item.servedAt = now;
    changed++;
  }
  if (!changed) return order.toObject();

  const prev = order.status as OrderStatus;
  const derived = deriveOrderStatus(prev, order.items as any);
  if (derived !== prev) {
    order.status = derived;
    order.statusHistory.push({ status: derived, at: now, by: actor.name });
    if (derived === 'ready') order.readyAt = now;
  }
  await order.save();
  broadcastOrder(String(tenantId), order.toObject());
  if (derived === 'ready' && prev !== 'ready') {
    await notify(tenantId, { type: 'order.ready', title: `Order #${order.orderNumber} is ready`, body: order.tableLabel ? `Table ${order.tableLabel}` : undefined, roles: ['waiter', 'manager', 'owner', 'admin', 'cashier'] });
    if (order.assignedWaiterId) emit.waiter(String(tenantId), String(order.assignedWaiterId), 'order:ready', publicOrder(order.toObject()));
  }
  return order.toObject();
}

export function broadcastOrder(tenantId: string, order: any) {
  const pub = publicOrder(order);
  emit.staff(tenantId, 'order:updated', pub);
  const stationIds = [...new Set((order.items ?? []).map((i: any) => String(i.stationId ?? '')).filter(Boolean))] as string[];
  emit.kitchen(tenantId, stationIds, 'kitchen:updated', pub);
  emit.order(tenantId, String(order._id), 'order:status', {
    _id: order._id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    // Totals let the tracking page update the amount due live after a payment.
    total: order.total,
    amountPaid: order.amountPaid,
    amountRefunded: order.amountRefunded,
    items: (order.items ?? []).map((i: any) => ({ _id: i._id, name: i.name, quantity: i.quantity, status: i.status })),
    delivery: order.type === 'delivery' ? customerDeliveryView(order.delivery) : undefined,
    updatedAt: order.updatedAt,
  });
}
