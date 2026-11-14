import type { Types } from 'mongoose';
import { InventoryItem, StockMovement } from '../models/inventory';
import { Product } from '../models/menu';
import { Order } from '../models/operations';
import { badRequest, notFound } from '../lib/errors';
import { notify } from './notify';

type MovementType = 'purchase' | 'consumption' | 'adjustment' | 'wastage' | 'return';

/**
 * Applies a signed stock delta atomically and records a StockMovement with the resulting balance.
 * Negative deltas for wastage/adjustment cannot drive stock below zero; consumption may (kitchen reality),
 * but triggers a low-stock alert.
 */
export async function applyStockDelta(
  tenantId: Types.ObjectId,
  itemId: string | Types.ObjectId,
  delta: number,
  type: MovementType,
  opts: { reason?: string; refType?: string; refId?: Types.ObjectId; actorId?: string; allowNegative?: boolean } = {},
) {
  if (!Number.isFinite(delta) || delta === 0) throw badRequest('Quantity must be a non-zero number');
  const filter: any = { tenantId, _id: itemId };
  if (delta < 0 && !opts.allowNegative) filter.quantity = { $gte: -delta };
  const item = await InventoryItem.findOneAndUpdate(filter, { $inc: { quantity: delta } }, { new: true });
  if (!item) {
    const exists = await InventoryItem.exists({ tenantId, _id: itemId });
    if (!exists) throw notFound('Inventory item not found');
    throw badRequest('Insufficient stock for this adjustment');
  }
  await StockMovement.create({
    tenantId,
    inventoryItemId: item._id,
    type,
    quantity: delta,
    balanceAfter: item.quantity,
    reason: opts.reason,
    refType: opts.refType,
    refId: opts.refId,
    actorId: opts.actorId,
  });
  await checkLowStock(tenantId, item);
  return item;
}

async function checkLowStock(tenantId: Types.ObjectId, item: any) {
  if (item.lowStockThreshold > 0 && item.quantity <= item.lowStockThreshold) {
    // De-duplicate: at most one alert per item per 6h.
    const since = new Date(Date.now() - 6 * 3600_000);
    if (!item.lowStockNotifiedAt || item.lowStockNotifiedAt < since) {
      await InventoryItem.updateOne({ tenantId, _id: item._id }, { $set: { lowStockNotifiedAt: new Date() } });
      await notify(tenantId, {
        type: 'stock.low',
        title: `Low stock: ${item.name}`,
        body: `${item.quantity} ${item.unit} left (threshold ${item.lowStockThreshold})`,
        link: '/dashboard/inventory',
        roles: ['owner', 'admin', 'manager', 'inventory_manager'],
      });
    }
  }
}

/** Deducts recipe ingredients for every item in an accepted order. Idempotent via order.inventoryDeducted. */
export async function consumeInventoryForOrder(tenantId: Types.ObjectId, order: any, actorId?: string) {
  const productIds = [...new Set(order.items.filter((i: any) => i.status !== 'cancelled').map((i: any) => String(i.productId)))];
  const products = await Product.find({ tenantId, _id: { $in: productIds }, 'recipe.0': { $exists: true } }).select('recipe').lean();
  if (products.length === 0) {
    await markDeducted(order, true);
    return;
  }
  const recipeBy = new Map<string, any[]>(products.map((p) => [String(p._id), p.recipe]));
  const totals = new Map<string, number>();
  for (const it of order.items) {
    if (it.status === 'cancelled') continue;
    for (const r of recipeBy.get(String(it.productId)) ?? []) {
      const k = String(r.inventoryItemId);
      totals.set(k, (totals.get(k) ?? 0) + r.quantity * it.quantity);
    }
  }
  for (const [itemId, qty] of totals) {
    try {
      await applyStockDelta(tenantId, itemId, -qty, 'consumption', { refType: 'Order', refId: order._id, actorId, allowNegative: true, reason: `Order #${order.orderNumber}` });
    } catch (e) {
      console.error('[INVENTORY] consumption failed', itemId, e);
    }
  }
  await markDeducted(order, true);
}

export async function restoreInventoryForOrder(tenantId: Types.ObjectId, order: any, actorId?: string) {
  const moves = await StockMovement.find({ tenantId, refType: 'Order', refId: order._id, type: 'consumption' }).lean();
  for (const m of moves) {
    await applyStockDelta(tenantId, m.inventoryItemId, -m.quantity, 'return', { refType: 'Order', refId: order._id, actorId, reason: `Order #${order.orderNumber} cancelled` });
  }
  await markDeducted(order, false);
}

/**
 * Atomic flag update. Re-saving the whole order document here could hit a version conflict caused by an
 * unrelated concurrent change (e.g. a payment) after the stock movements were already written.
 */
async function markDeducted(order: any, value: boolean) {
  await Order.updateOne({ tenantId: order.tenantId, _id: order._id }, { $set: { inventoryDeducted: value } });
  order.inventoryDeducted = value;
}

/**
 * Item-level recipe adjustment for an order whose ingredients were already deducted (items added to or
 * removed from an accepted order). Uses the products' configured recipes only; products without a recipe
 * move no stock. `sign` -1 consumes, +1 returns. Every movement references the order for the audit trail.
 */
export async function adjustInventoryForItems(
  tenantId: Types.ObjectId,
  order: { _id: Types.ObjectId; orderNumber: number },
  items: { productId: Types.ObjectId | string; quantity: number }[],
  sign: 1 | -1,
  actorId?: string,
) {
  if (!items.length) return;
  const ids = [...new Set(items.map((i) => String(i.productId)))];
  const products = await Product.find({ tenantId, _id: { $in: ids }, 'recipe.0': { $exists: true } }).select('recipe').lean();
  const recipeBy = new Map<string, any[]>(products.map((p) => [String(p._id), p.recipe]));
  const totals = new Map<string, number>();
  for (const it of items) {
    for (const r of recipeBy.get(String(it.productId)) ?? []) {
      const k = String(r.inventoryItemId);
      totals.set(k, (totals.get(k) ?? 0) + r.quantity * it.quantity);
    }
  }
  for (const [itemId, qty] of totals) {
    try {
      await applyStockDelta(tenantId, itemId, sign * qty, sign < 0 ? 'consumption' : 'return', {
        refType: 'Order', refId: order._id, actorId, allowNegative: sign < 0,
        reason: `Order #${order.orderNumber} ${sign < 0 ? 'item added' : 'item removed'}`,
      });
    } catch (e) {
      console.error('[INVENTORY] item adjustment failed', itemId, e);
    }
  }
}
