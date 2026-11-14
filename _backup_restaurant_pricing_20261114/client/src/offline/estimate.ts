import { priceOrder, type ManualDiscountInput } from './pricing';
import type { LocalItem, LocalOrder } from './types';

export interface MenuSnapshot {
  products: any[];
  categories: any[];
  stations?: any[];
}
export interface PricingConfig {
  currency: string;
  taxRatePercent: number;
  taxInclusive: boolean;
  serviceChargePercent: number;
  deliveryFee?: number;
  orderTypes?: string[];
  requireTableForDineIn?: boolean;
  maxManualDiscountPercent?: number;
}
export interface OfflineDraft {
  type: 'dine_in' | 'takeaway' | 'pickup' | 'delivery';
  tableId?: string;
  customer?: { name?: string; phone?: string };
  delivery?: { address?: string };
  notes?: string;
  couponCode?: string;
  orderDiscount?: ManualDiscountInput;
  discountReason?: string;
  items: { productId: string; variantId?: string; addonIds?: string[]; quantity: number; notes?: string; discount?: ManualDiscountInput }[];
}
export interface Actor {
  name: string;
  role: string;
  canDiscount: boolean;
}

export class OfflineValidationError extends Error {}

export function effectivePrice(p: { price: number; promoPrice?: number | null; promoEndsAt?: string | Date | null }, now = new Date()) {
  if (p.promoPrice != null && p.promoPrice < p.price && (!p.promoEndsAt || new Date(p.promoEndsAt) > now)) return p.promoPrice;
  return p.price;
}

/** Stock a tracked dish has left on THIS device: last synced stock minus quantities in unsynced local orders. */
export function provisionalStock(products: any[], localOrders: LocalOrder[]) {
  const reserved = new Map<string, number>();
  for (const o of localOrders) if (o.syncState !== 'confirmed') for (const i of o.items) reserved.set(i.productId, (reserved.get(i.productId) ?? 0) + i.quantity);
  const left = new Map<string, number>();
  for (const p of products) if (p.trackStock) left.set(p._id, (p.stockQty ?? 0) - (reserved.get(p._id) ?? 0));
  return left;
}

/**
 * Builds an OFFLINE estimate with the same rules the server applies (same pricing code, same validations).
 * It is only an estimate: the server re-validates and re-prices everything when the order synchronises and
 * reports a conflict instead of silently charging a different amount.
 */
export function estimateOffline(menu: MenuSnapshot, cfg: PricingConfig, draft: OfflineDraft, actor: Actor, opts: { tables?: any[]; localOrders?: LocalOrder[] } = {}) {
  if (!draft.items.length) throw new OfflineValidationError('Add at least one item');
  if (cfg.orderTypes && !cfg.orderTypes.includes(draft.type)) throw new OfflineValidationError('Order type not available');
  if (draft.couponCode) throw new OfflineValidationError('Coupons need a connection to be checked; remove the coupon or wait until you are online');
  const table = draft.type === 'dine_in' && draft.tableId ? opts.tables?.find((t) => t._id === draft.tableId && t.isActive !== false) : undefined;
  if (draft.type === 'dine_in' && draft.tableId && !table) throw new OfflineValidationError('Table not found on this device');
  if (draft.type === 'dine_in' && cfg.requireTableForDineIn && !table) throw new OfflineValidationError('Dine-in orders require a table');
  if (draft.type === 'delivery' && (!draft.delivery?.address || draft.delivery.address.trim().length < 5)) throw new OfflineValidationError('A delivery address is required');
  if (draft.type === 'delivery' && !draft.customer?.phone) throw new OfflineValidationError('A contact phone number is required for delivery');
  if (draft.type === 'pickup' && !draft.customer?.name && !draft.customer?.phone) throw new OfflineValidationError('A customer name or phone number is required for pickup orders');
  const manual = !!draft.orderDiscount || draft.items.some((i) => i.discount);
  if (manual && !actor.canDiscount) throw new OfflineValidationError('You are not allowed to apply discounts');
  if (manual && (!draft.discountReason || draft.discountReason.trim().length < 3)) throw new OfflineValidationError('A reason is required for manual discounts');

  const byId = new Map(menu.products.map((p) => [p._id, p]));
  const catById = new Map(menu.categories.map((c) => [c._id, c]));
  const defaultStation = menu.stations?.find((s) => s.isDefault && s.isActive !== false)?._id ?? null;
  const left = provisionalStock(menu.products, opts.localOrders ?? []);
  const want = new Map<string, number>();
  const lines = draft.items.map((it) => {
    const p = byId.get(it.productId);
    if (!p || p.isArchived) throw new OfflineValidationError('One or more items are no longer available');
    const cat = catById.get(p.categoryId);
    if (!p.isAvailable || !cat?.isActive) throw new OfflineValidationError(`${p.name.en} is currently unavailable`);
    const variant = it.variantId ? p.variants.find((v: any) => v._id === it.variantId) : undefined;
    if (it.variantId && !variant) throw new OfflineValidationError(`Invalid option for ${p.name.en}`);
    if (!it.variantId && p.variants.length > 0) throw new OfflineValidationError(`Please choose an option for ${p.name.en}`);
    const addons = (it.addonIds ?? []).map((aid) => {
      const a = p.addons.find((x: any) => x._id === aid && x.isAvailable);
      if (!a) throw new OfflineValidationError(`Invalid add-on for ${p.name.en}`);
      return { name: a.name, price: a.price };
    });
    want.set(p._id, (want.get(p._id) ?? 0) + it.quantity);
    return {
      productId: p._id, name: p.name.en, basePrice: effectivePrice(p), variantName: variant?.name, variantDelta: variant?.priceDelta ?? 0, addons, quantity: it.quantity,
      lineDiscount: it.discount ?? null, _p: p, _cat: cat, _it: it,
    };
  });
  for (const [pid, q] of want) {
    if (left.has(pid) && left.get(pid)! < q) throw new OfflineValidationError(`${byId.get(pid).name.en} may be out of stock (${Math.max(0, left.get(pid)!)} left on this device)`);
  }
  const priced = priceOrder(lines, { taxRatePercent: cfg.taxRatePercent ?? 0, taxInclusive: !!cfg.taxInclusive, serviceChargePercent: cfg.serviceChargePercent ?? 0 }, null, {
    manualDiscount: draft.orderDiscount ?? null,
    deliveryFee: draft.type === 'delivery' ? cfg.deliveryFee ?? 0 : 0,
  });
  if (manual && actor.role !== 'owner') {
    const cap = cfg.maxManualDiscountPercent ?? 100;
    if (priced.subtotal > 0 && ((priced.lineDiscount + priced.manualDiscount) / priced.subtotal) * 100 > cap + 1e-9) throw new OfflineValidationError(`Manual discounts above ${cap}% need the owner`);
  }
  const items: LocalItem[] = priced.lines.map((l, i) => ({
    productId: l.productId, name: l.name, variantId: lines[i]._it.variantId, variantName: l.variantName, addonIds: lines[i]._it.addonIds ?? [], addons: l.addons ?? [],
    quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, discount: l.lineDiscountAmount, notes: lines[i]._it.notes,
    stationId: lines[i]._cat?.stationId ?? defaultStation, prepMinutes: typeof lines[i]._p.prepMinutes === 'number' ? lines[i]._p.prepMinutes : undefined, status: 'queued',
  }));
  return {
    table,
    items,
    totals: { subtotal: priced.subtotal, discount: priced.discount, lineDiscount: priced.lineDiscount, manualDiscount: priced.manualDiscount, serviceCharge: priced.serviceCharge, deliveryFee: priced.deliveryFee, tax: priced.tax, total: priced.total },
    /** What the server receives: ids and quantities only, plus the total this device showed the guest. */
    payload: {
      type: draft.type, tableId: table?._id, customer: draft.customer, delivery: draft.type === 'delivery' ? draft.delivery : undefined, notes: draft.notes,
      orderDiscount: draft.orderDiscount, discountReason: manual ? draft.discountReason : undefined,
      items: draft.items.map((i) => ({ productId: i.productId, variantId: i.variantId, addonIds: i.addonIds, quantity: i.quantity, notes: i.notes, discount: i.discount })),
      expectedTotal: priced.total,
    },
  };
}
