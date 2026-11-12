import { badRequest } from '../lib/errors';
import type { AuthUser, ResolvedTenant } from '../types/express';
import { recordCashPayment } from './paymentService';
import { splitQuote } from './orderOps';
import { findOpenShift } from './shiftService';

export interface CollectInput {
  amount?: number;
  method: 'cash' | 'card_terminal';
  allocation?: { mode: 'equal'; parts: number; part: number; label?: string } | { mode: 'items'; items: { itemId: string; quantity: number }[]; label?: string };
  idempotencyKey?: string;
}

/**
 * Staff-collected payment (cash or card terminal), shared by the POS route and offline synchronisation so both
 * apply exactly the same rules: split shares computed by the server (a different client amount is refused),
 * the open-shift requirement, the balance check and idempotency.
 */
export async function collectPayment(tenant: ResolvedTenant, actor: AuthUser, orderId: string, body: CollectInput) {
  let amount = body.amount;
  const allocation = body.allocation;
  if (allocation) {
    const q: any = await splitQuote(tenant, orderId, allocation.mode === 'equal' ? { mode: 'equal', parts: allocation.parts } : { mode: 'items', items: allocation.items });
    const share = allocation.mode === 'equal' ? q.parts.find((p: any) => p.part === allocation.part)?.amount : q.amount;
    if (!share) throw badRequest('Invalid split part');
    if (amount != null && amount !== share) throw badRequest(`This share is ${share}, not ${amount}. Refresh the split.`);
    amount = share;
  }
  if (amount == null || amount <= 0) throw badRequest('Enter an amount or choose a split');
  const shift = await findOpenShift(tenant._id, actor.id);
  if (!shift && body.method === 'cash' && tenant.settings?.requireOpenShiftForCash) throw badRequest('Open your cash shift before taking cash payments');
  const payment = await recordCashPayment(tenant._id, orderId, amount, actor, body.method, { allocation, idempotencyKey: body.idempotencyKey, shiftId: shift?._id });
  return { payment, amount, shiftId: shift?._id };
}
