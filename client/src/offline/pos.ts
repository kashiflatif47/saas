import type { OfflineEngine } from './engine';
import { estimateOffline, type Actor, type MenuSnapshot, type OfflineDraft, type PricingConfig } from './estimate';
import type { LocalOrder } from './types';

/**
 * Saves an order on this device (no connection needed): validates and estimates it against the last
 * synchronised menu, prices and stock, then writes the local order and its queued "order.create" operation.
 * Resolves only after both are durably stored; throws (and stores nothing) on validation or storage errors.
 */
export async function createOfflineOrder(
  engine: OfflineEngine,
  ctx: { menu: MenuSnapshot; cfg: PricingConfig; tables: any[]; actor: Actor; tenantId: string; pricesAsOf: string },
  draft: OfflineDraft,
  opId?: string,
): Promise<LocalOrder> {
  const est = estimateOffline(ctx.menu, ctx.cfg, draft, ctx.actor, { tables: ctx.tables, localOrders: await engine.orders() });
  const localId = `local-${cryptoId()}`;
  const order: LocalOrder = {
    localId,
    localNumber: await engine.nextLocalNumber(),
    opId: '',
    tenantId: ctx.tenantId,
    createdAt: new Date().toISOString(),
    createdBy: ctx.actor.name,
    type: draft.type,
    tableId: est.table?._id,
    tableLabel: est.table?.label,
    customer: draft.customer,
    delivery: draft.type === 'delivery' ? draft.delivery : undefined,
    notes: draft.notes,
    items: est.items,
    totals: est.totals,
    manualDiscount: draft.orderDiscount ? { ...draft.orderDiscount, reason: draft.discountReason } : undefined,
    currency: ctx.cfg.currency,
    pricesAsOf: ctx.pricesAsOf,
    payments: [],
    syncState: 'saved_local',
  };
  return engine.saveLocalOrder(order, est.payload, opId);
}

function cryptoId() {
  const b = new Uint8Array(8);
  (globalThis as any).crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
