/**
 * Cash shifts (one cash drawer session per cashier). Expected cash is always derived from persisted
 * records: opening float + verified cash sales − verified cash refunds + cash in − cash out, where sales
 * and refunds are the payments recorded by that cashier while the shift was open (Payment.shiftId).
 */
import { Types } from 'mongoose';
import { CashShift, Payment } from '../models/operations';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { roleHas } from '../config/permissions';
import type { AuthUser } from '../types/express';

export function findOpenShift(tenantId: Types.ObjectId, userId: string) {
  return CashShift.findOne({ tenantId, cashierId: userId, status: 'open' }).lean();
}

export async function shiftTotals(tenantId: Types.ObjectId, shift: any) {
  const rows = await Payment.aggregate([
    { $match: { tenantId, shiftId: shift._id, status: 'verified' } },
    { $group: { _id: { kind: '$kind', method: '$method' }, amount: { $sum: '$amount' }, n: { $sum: 1 } } },
  ]);
  const get = (kind: string, method: string) => rows.find((r) => r._id.kind === kind && r._id.method === method) ?? { amount: 0, n: 0 };
  const cashIn = (shift.movements ?? []).filter((m: any) => m.type === 'in').reduce((s: number, m: any) => s + m.amount, 0);
  const cashOut = (shift.movements ?? []).filter((m: any) => m.type === 'out').reduce((s: number, m: any) => s + m.amount, 0);
  const cashSales = get('charge', 'cash').amount;
  const cashRefunds = get('refund', 'cash').amount;
  return {
    cashSales,
    cashSalesCount: get('charge', 'cash').n,
    cashRefunds,
    cardTerminal: get('charge', 'card_terminal').amount,
    cardTerminalRefunds: get('refund', 'card_terminal').amount,
    online: get('charge', 'online').amount,
    cashIn,
    cashOut,
    expectedCash: shift.openingFloat + cashSales - cashRefunds + cashIn - cashOut,
  };
}

export async function openShift(tenantId: Types.ObjectId, actor: AuthUser, openingFloat: number, notes?: string) {
  if (await findOpenShift(tenantId, actor.id)) throw conflict('You already have an open shift. Close it before opening a new one.');
  try {
    return await CashShift.create({ tenantId, cashierId: actor.id, cashierName: actor.name, openingFloat, openingNotes: notes, status: 'open', openedAt: new Date() });
  } catch (e: any) {
    if (e?.code === 11000) throw conflict('You already have an open shift. Close it before opening a new one.');
    throw e;
  }
}

/** Loads a shift the actor may act on: their own, or any shift with shifts:manage. */
export async function loadShiftFor(tenantId: Types.ObjectId, shiftId: string, actor: AuthUser) {
  const shift = await CashShift.findOne({ tenantId, _id: shiftId });
  if (!shift) throw notFound('Shift not found');
  if (String(shift.cashierId) !== actor.id && !roleHas(actor.role, 'shifts:manage', actor.permissionOverrides)) throw forbidden('This is another cashier’s shift');
  return shift;
}

/** `key` (optional) makes the movement idempotent: the same key is recorded at most once per shift. */
export async function addMovement(tenantId: Types.ObjectId, shiftId: string, actor: AuthUser, type: 'in' | 'out', amount: number, reason: string, key?: string, at?: Date) {
  await loadShiftFor(tenantId, shiftId, actor);
  const filter: any = { tenantId, _id: shiftId, status: 'open' };
  if (key) filter['movements.key'] = { $ne: key };
  const s = await CashShift.findOneAndUpdate(
    filter,
    { $push: { movements: { key, type, amount, reason, by: actor.name, byId: actor.id, at: at ?? new Date() } } },
    { new: true },
  ).lean();
  if (!s) {
    if (key) {
      const dup = await CashShift.findOne({ tenantId, _id: shiftId, 'movements.key': key }).lean();
      if (dup) return dup; // already recorded: a retry, not a second movement
    }
    throw badRequest('The shift is already closed');
  }
  return s;
}

export async function closeShift(tenantId: Types.ObjectId, shiftId: string, actor: AuthUser, countedCash: number, notes?: string) {
  const shift = await loadShiftFor(tenantId, shiftId, actor);
  if (shift.status !== 'open') throw badRequest('The shift is already closed');
  const totals = await shiftTotals(tenantId, shift.toObject());
  const closed = await CashShift.findOneAndUpdate(
    { tenantId, _id: shiftId, status: 'open' }, // atomic: a shift is closed exactly once
    {
      $set: {
        status: 'closed', closedAt: new Date(), closedBy: actor.name, countedCash, closingNotes: notes,
        expectedCash: totals.expectedCash, discrepancy: countedCash - totals.expectedCash,
        totals: { cashSales: totals.cashSales, cashRefunds: totals.cashRefunds, cashIn: totals.cashIn, cashOut: totals.cashOut, cardTerminal: totals.cardTerminal, online: totals.online },
      },
    },
    { new: true },
  ).lean();
  if (!closed) throw badRequest('The shift is already closed');
  return closed;
}
