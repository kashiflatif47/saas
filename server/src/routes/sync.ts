import { Router } from 'express';
import { z } from 'zod';
import { Order, SyncReceipt } from '../models/operations';
import { AppError, ah, badRequest, forbidden } from '../lib/errors';
import { validateBody, zId, zMoney } from '../middleware/validate';
import { roleHas, type Permission } from '../config/permissions';
import { audit } from '../services/audit';
import { placeOrder, quoteOrder, updateItemsStatus } from '../services/orderService';
import { collectPayment } from '../services/paymentFlow';
import { addMovement, closeShift, loadShiftFor } from '../services/shiftService';
import { placeOrderSchema } from './orders';
import type { Request } from 'express';

/**
 * Offline synchronisation: replays ONE operation recorded on a device while it had no connection.
 *
 * Every operation goes through the same services, validation and permission checks as the live POS:
 *  - tenant and user come from the verified session; the operation must claim the same tenant and user;
 *  - prices, discounts, stock, tables and payment balances are re-checked here, never trusted from the device;
 *  - the operation UUID is the idempotency key: an operation accepted once returns its stored result forever
 *    (retries, interrupted connections, replays), and the underlying order/payment keys are the same UUID.
 * Business rejections are returned as 4xx with a code so the device can show a conflict to a person.
 */
export const syncRouter = Router();

const MAX_AGE_DAYS = 14;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const opSchema = z.object({
  id: z.string().regex(UUID, 'Operation id must be a UUID'),
  type: z.enum(['order.create', 'payment.cash', 'kitchen.items', 'shift.movement', 'shift.close']),
  tenantId: zId,
  userId: zId,
  deviceId: z.string().min(4).max(64),
  createdAt: z.coerce.date(),
  payload: z.record(z.unknown()),
});

const payloads = {
  'order.create': placeOrderSchema.omit({ idempotencyKey: true, confirm: true, tableToken: true }).extend({
    expectedTotal: zMoney, // what the device showed the guest
    acceptPriceChange: z.boolean().optional(), // staff accepted the current server price after a conflict
  }),
  'payment.cash': z.object({
    orderId: zId,
    amount: zMoney.refine((n) => n > 0),
    method: z.string(),
    allocation: z.object({ mode: z.literal('equal'), parts: z.number().int().min(2).max(50), part: z.number().int().min(1).max(50) }).optional(),
  }),
  'kitchen.items': z.object({ orderId: zId, itemIds: z.array(zId).min(1).max(100), status: z.enum(['preparing', 'ready']), at: z.coerce.date().optional() }),
  'shift.movement': z.object({ shiftId: zId, type: z.enum(['in', 'out']), amount: zMoney.refine((n) => n > 0), reason: z.string().min(3).max(200) }),
  'shift.close': z.object({ shiftId: zId, countedCash: zMoney, notes: z.string().max(500).optional() }),
} as const;

const PERM: Record<keyof typeof payloads, Permission[]> = {
  'order.create': ['orders:create', 'orders:accept'],
  'payment.cash': ['payments:collect'],
  'kitchen.items': ['kitchen:operate'],
  'shift.movement': ['shifts:operate', 'shifts:manage'],
  'shift.close': ['shifts:operate', 'shifts:manage'],
};

const conflict = (code: string, message: string, details?: unknown) => new AppError(409, message, code, details);

function parsePayload<K extends keyof typeof payloads>(type: K, payload: unknown): z.infer<(typeof payloads)[K]> {
  const r = payloads[type].safeParse(payload);
  if (!r.success) throw new AppError(400, 'This offline record is incomplete or invalid', 'INVALID_OPERATION', r.error.flatten());
  return r.data as any;
}

async function run(req: Request, op: z.infer<typeof opSchema>) {
  const tenant = req.tenant!;
  const user = req.user!;
  switch (op.type) {
    case 'order.create': {
      const p = parsePayload('order.create', op.payload);
      const existing = await Order.findOne({ tenantId: tenant._id, idempotencyKey: op.id }).lean();
      if (existing) return { order: existing };
      const { expectedTotal, acceptPriceChange, ...input } = p as any;
      // Re-price with today's menu: if the guest was shown a different total, a person must decide.
      const quote = await quoteOrder(tenant, input, user);
      if (quote.total !== expectedTotal && !acceptPriceChange) {
        throw conflict('PRICE_CHANGED', `Prices changed since this device last synced: it showed ${expectedTotal}, the current total is ${quote.total}`, { expectedTotal, serverTotal: quote.total, lines: quote.lines });
      }
      const { order } = await placeOrder(tenant, { ...input, idempotencyKey: op.id, confirm: true }, 'staff', user);
      const set: any = { offline: { deviceId: op.deviceId, createdAt: op.createdAt, syncedAt: new Date() } };
      if (user.role === 'waiter') set.assignedWaiterId = user.id;
      await Order.updateOne(
        { tenantId: tenant._id, _id: order!._id },
        { $set: set, $push: { modifications: { at: new Date(), by: user.name, byId: user.id, action: 'offline_synced', detail: { deviceId: op.deviceId, offlineCreatedAt: op.createdAt, expectedTotal, serverTotal: order!.total, priceAccepted: !!acceptPriceChange } } } },
      );
      return { order: await Order.findOne({ tenantId: tenant._id, _id: order!._id }).lean() };
    }
    case 'payment.cash': {
      const p = parsePayload('payment.cash', op.payload);
      // Card and online payments are never accepted from an offline record: they need live confirmation.
      if (p.method !== 'cash') throw new AppError(400, 'Only cash can be recorded offline; card payments need a live connection', 'OFFLINE_CARD_UNSUPPORTED');
      const { payment } = await collectPayment(tenant, user, p.orderId, { amount: p.amount, method: 'cash', allocation: p.allocation, idempotencyKey: op.id });
      return { payment };
    }
    case 'kitchen.items': {
      const p = parsePayload('kitchen.items', op.payload);
      const order = await Order.findOne({ tenantId: tenant._id, _id: p.orderId }).lean();
      if (!order) throw new AppError(404, 'Order not found', 'NOT_FOUND');
      if (!['accepted', 'preparing', 'partially_ready', 'ready'].includes(order.status)) {
        throw conflict('ORDER_NOT_IN_KITCHEN', `The order is now ${order.status}; this kitchen update was not applied`, { status: order.status });
      }
      const gone = p.itemIds.filter((id) => {
        const it: any = order.items.find((i: any) => String(i._id) === id);
        return !it || it.status === 'cancelled';
      });
      if (gone.length) throw conflict('ORDER_CHANGED', 'The order was changed on another device: some of these items were removed', { itemIds: gone });
      return { order: await updateItemsStatus(tenant, p.orderId, p.itemIds, p.status, user, p.at ?? op.createdAt) };
    }
    case 'shift.movement': {
      const p = parsePayload('shift.movement', op.payload);
      const shift = await addMovement(tenant._id, p.shiftId, user, p.type, p.amount, p.reason, op.id, op.createdAt);
      return { shift };
    }
    case 'shift.close': {
      const p = parsePayload('shift.close', op.payload);
      const shift = await loadShiftFor(tenant._id, p.shiftId, user);
      if (shift.status !== 'open') throw conflict('SHIFT_CLOSED', `This shift was already closed by ${shift.closedBy ?? 'someone else'}`, { closedBy: shift.closedBy, closedAt: shift.closedAt, countedCash: shift.countedCash });
      return { shift: await closeShift(tenant._id, p.shiftId, user, p.countedCash, p.notes) };
    }
  }
  throw badRequest('Unknown operation');
}

syncRouter.post('/', validateBody(opSchema), ah(async (req, res) => {
  const op = req.body as z.infer<typeof opSchema>;
  // Records are bound to the account that created them; the session decides, not the device.
  if (op.tenantId !== String(req.tenantId)) throw new AppError(403, 'This record belongs to another restaurant', 'TENANT_MISMATCH');
  if (op.userId !== req.user!.id) throw new AppError(403, 'This record was created by another staff member; they must sign in to send it', 'USER_MISMATCH');
  if (!PERM[op.type].some((p) => roleHas(req.user!.role, p, req.user!.permissionOverrides))) throw forbidden('Your current permissions do not allow this operation');

  const prior = await SyncReceipt.findOne({ tenantId: req.tenantId, key: op.id }).lean();
  if (prior) {
    if (prior.type !== op.type || String(prior.userId) !== req.user!.id) throw conflict('KEY_REUSED', 'This operation id was already used for a different operation');
    return void res.json({ ...(prior.response as object), replayed: true });
  }
  const age = Date.now() - op.createdAt.getTime();
  if (age < -10 * 60_000) throw conflict('CLOCK_AHEAD', 'This device’s clock is ahead of the server; fix the date and time, then retry');
  if (age > MAX_AGE_DAYS * 86400_000) throw conflict('STALE_OPERATION', `Offline records older than ${MAX_AGE_DAYS} days are not applied automatically`);

  const response = await run(req, op);
  try {
    await SyncReceipt.create({ tenantId: req.tenantId, key: op.id, type: op.type, userId: req.user!.id, deviceId: op.deviceId, offlineCreatedAt: op.createdAt, response });
  } catch (e: any) {
    if (e?.code !== 11000) throw e; // the same operation arrived twice at once: the first receipt stands
  }
  await audit(req, `sync.${op.type}`, 'SyncReceipt', op.id, { deviceId: op.deviceId, offlineCreatedAt: op.createdAt });
  res.json(response);
}));

