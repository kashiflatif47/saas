/** Order + item state machines. Pure and dependency-free. */

export const ORDER_STATUSES = [
  'pending', 'accepted', 'rejected', 'preparing', 'partially_ready', 'ready',
  'delivered', 'completed', 'cancelled', 'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ITEM_STATUSES = ['queued', 'preparing', 'ready', 'served', 'cancelled'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid', 'partially_refunded', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Allowed manual transitions performed by staff. Kitchen-driven states are derived. */
const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['partially_ready', 'ready', 'cancelled'],
  partially_ready: ['ready', 'preparing', 'cancelled'],
  ready: ['delivered', 'cancelled'],
  delivered: ['completed'],
  completed: ['refunded'],
  rejected: [],
  cancelled: ['refunded'],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

const ITEM_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  queued: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'queued', 'cancelled'],
  ready: ['served', 'preparing'],
  served: [],
  cancelled: [],
};

export function canTransitionItem(from: ItemStatus, to: ItemStatus): boolean {
  return ITEM_TRANSITIONS[from].includes(to);
}

const KITCHEN_PHASE: OrderStatus[] = ['accepted', 'preparing', 'partially_ready', 'ready'];

/**
 * Derives the parent order status from its item statuses while the order is in the kitchen phase.
 * Outside the kitchen phase (pending, delivered, completed…) the current status is kept.
 */
export function deriveOrderStatus(current: OrderStatus, items: { status: ItemStatus }[]): OrderStatus {
  if (!KITCHEN_PHASE.includes(current)) return current;
  const active = items.filter((i) => i.status !== 'cancelled');
  if (active.length === 0) return 'cancelled';
  const done = active.filter((i) => i.status === 'ready' || i.status === 'served').length;
  const started = active.some((i) => i.status !== 'queued');
  if (done === active.length) return 'ready';
  if (done > 0) return 'partially_ready';
  if (started) return 'preparing';
  return current === 'accepted' ? 'accepted' : 'preparing';
}

/** Payment status is independent of order status and derived only from verified money movements. */
export function derivePaymentStatus(total: number, verifiedPaid: number, refunded: number): PaymentStatus {
  if (refunded > 0 && refunded >= verifiedPaid && verifiedPaid > 0) return 'refunded';
  if (refunded > 0) return 'partially_refunded';
  if (verifiedPaid <= 0) return 'unpaid';
  if (verifiedPaid >= total) return 'paid';
  return 'partially_paid';
}
