import { Router } from 'express';
import { z } from 'zod';
import { Order, Payment } from '../models/operations';
import { User } from '../models/platform';
import { ah, badRequest, forbidden, notFound } from '../lib/errors';
import { can } from '../middleware/auth';
import { requireFeature } from '../middleware/tenant';
import { checkIdParams, validateBody, validateQuery, zId, zMoney, zPage } from '../middleware/validate';
import { ORDER_STATUSES, ITEM_STATUSES } from '../lib/orderState';
import { placeOrder, quoteOrder, transitionOrder, updateItemStatus, updateItemsStatus, broadcastOrder, publicOrder } from '../services/orderService';
import { addOrderItems, cancelOrderItem, receiptData, requestBill, splitQuote, transferOrder, updateOrderItem } from '../services/orderOps';
import { findOpenShift } from '../services/shiftService';
import { collectPayment } from '../services/paymentFlow';
import { renderReceiptPdf } from '../lib/receiptPdf';
import { refundPayment } from '../services/paymentService';
import { audit } from '../services/audit';
import { emit } from '../sockets';
import { roleHas } from '../config/permissions';

export const ordersRouter = Router();

/** Manual discount request: percent (0–100] or a fixed amount in minor units. Applied and capped on the server. */
const zDiscount = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent'), value: z.number().gt(0).max(100) }),
  z.object({ type: z.literal('fixed'), value: z.number().int().min(1).max(1_000_000_000) }),
]);

export const placeOrderSchema = z.object({
  type: z.enum(['dine_in', 'takeaway', 'pickup', 'delivery']).default('dine_in'),
  delivery: z.object({
    address: z.string().max(300).optional(),
    notes: z.string().max(300).optional(),
    zoneId: zId.optional(),
    location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
  }).optional(),
  marketingConsent: z.boolean().optional(),
  orderDiscount: zDiscount.optional(),
  discountReason: z.string().max(200).optional(),
  confirm: z.boolean().optional(),
  tableToken: z.string().max(64).optional(),
  tableId: zId.optional(),
  customer: z.object({ name: z.string().max(80).optional(), phone: z.string().max(25).optional(), email: z.string().email().optional() }).optional(),
  notes: z.string().max(500).optional(),
  couponCode: z.string().max(40).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Invalid idempotency key').optional(),
  items: z.array(z.object({
    productId: zId,
    variantId: zId.optional(),
    addonIds: z.array(zId).max(20).optional(),
    quantity: z.number().int().min(1).max(99),
    notes: z.string().max(300).optional(),
    discount: zDiscount.optional(),
  })).min(1).max(100),
});

ordersRouter.get('/', can('orders:view'), validateQuery(zPage.extend({
  status: z.string().optional(), // comma separated
  paymentStatus: z.string().optional(),
  tableId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  mine: z.enum(['true', 'false']).optional(),
})), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId };
  if (q.status) filter.status = { $in: q.status.split(',').filter((s: string) => (ORDER_STATUSES as readonly string[]).includes(s)) };
  if (q.paymentStatus) filter.paymentStatus = q.paymentStatus;
  if (q.tableId && /^[a-f0-9]{24}$/i.test(q.tableId)) filter.tableId = q.tableId;
  if (q.from || q.to) {
    filter.createdAt = {};
    if (q.from) filter.createdAt.$gte = new Date(q.from);
    if (q.to) filter.createdAt.$lt = new Date(new Date(q.to).getTime() + (/^\d{4}-\d{2}-\d{2}$/.test(q.to) ? 86400_000 : 0));
  }
  if (q.q) {
    const n = Number(q.q.replace('#', ''));
    filter.$or = [...(Number.isInteger(n) ? [{ orderNumber: n }] : []), { 'customer.phone': q.q }, { tableLabel: q.q }];
  }
  if (q.mine === 'true' || req.user!.role === 'waiter') {
    // Waiters see orders assigned to them or on their tables (plus unassigned pending ones).
    const me = await User.findById(req.user!.id).select('assignedTableIds').lean();
    if (req.user!.role === 'waiter') {
      filter.$and = [{ $or: [{ assignedWaiterId: req.user!.id }, { tableId: { $in: me?.assignedTableIds ?? [] } }, { assignedWaiterId: null, status: { $in: ['pending', 'ready'] } }] }];
    }
  }
  const [items, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Order.countDocuments(filter),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
}));

ordersRouter.get('/:id', can('orders:view'), checkIdParams, ah(async (req, res) => {
  const order = await Order.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
  if (!order) throw notFound('Order not found');
  const payments = await Payment.find({ tenantId: req.tenantId, orderId: order._id }).sort({ createdAt: 1 }).lean();
  res.json({ order, payments });
}));

/** Staff-entered order (waiter taking an order at the table, cashier at the counter). */
ordersRouter.post('/', can('orders:create', 'orders:accept'), validateBody(placeOrderSchema), ah(async (req, res) => {
  const { order } = await placeOrder(req.tenant!, req.body, 'staff', req.user);
  if (req.user!.role === 'waiter') await Order.updateOne({ tenantId: req.tenantId, _id: order!._id }, { $set: { assignedWaiterId: req.user!.id } });
  await audit(req, 'order.create', 'Order', order!._id, {
    type: req.body.type, confirm: !!req.body.confirm,
    ...(req.body.orderDiscount || req.body.items.some((i: any) => i.discount) ? { discount: { order: req.body.orderDiscount, lines: req.body.items.filter((i: any) => i.discount).length, reason: req.body.discountReason } } : {}),
  });
  res.status(201).json(await Order.findOne({ tenantId: req.tenantId, _id: order!._id }).lean());
}));

/** POS price preview: the server prices the cart (discounts, service, delivery, tax). Nothing is saved. */
ordersRouter.post('/quote', can('orders:create', 'orders:accept'), validateBody(placeOrderSchema.omit({ idempotencyKey: true, confirm: true })), ah(async (req, res) => {
  res.json(await quoteOrder(req.tenant!, req.body, req.user!));
}));

const transitionPerm: Record<string, Parameters<typeof roleHas>[1]> = {
  accepted: 'orders:accept', rejected: 'orders:accept', preparing: 'kitchen:operate', partially_ready: 'kitchen:operate', ready: 'kitchen:operate',
  delivered: 'orders:deliver', completed: 'orders:deliver', cancelled: 'orders:manage', refunded: 'payments:refund',
};

ordersRouter.post('/:id/status', can('orders:view'), checkIdParams, validateBody(z.object({ status: z.enum(ORDER_STATUSES), reason: z.string().max(300).optional() })), ah(async (req, res) => {
  const perm = transitionPerm[req.body.status];
  // `pending` is the initial state only; no one can move an order back to it.
  if (!perm) throw badRequest(`Orders cannot be moved to ${req.body.status}`);
  if (!roleHas(req.user!.role, perm, req.user!.permissionOverrides)) throw forbidden();
  if ((req.body.status === 'rejected' || req.body.status === 'cancelled') && !req.body.reason) throw badRequest('A reason is required');
  const order = await transitionOrder(req.tenant!, req.params.id, req.body.status, req.user!, req.body.reason);
  await audit(req, `order.${req.body.status}`, 'Order', req.params.id, { reason: req.body.reason });
  res.json(order);
}));

ordersRouter.post('/:id/assign', can('orders:manage', 'orders:accept'), checkIdParams, validateBody(z.object({ waiterId: zId.nullable() })), ah(async (req, res) => {
  if (req.body.waiterId) {
    const w = await User.findOne({ tenantId: req.tenantId, _id: req.body.waiterId, isActive: true }).select('role').lean();
    if (!w) throw badRequest('Staff member not found');
  }
  // A waiter can only claim an order for themselves.
  if (req.user!.role === 'waiter' && req.body.waiterId !== req.user!.id) throw forbidden('Waiters can only claim orders for themselves');
  const order = await Order.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: { assignedWaiterId: req.body.waiterId } }, { new: true }).lean();
  if (!order) throw notFound('Order not found');
  broadcastOrder(String(req.tenantId), order);
  if (req.body.waiterId) emit.waiter(String(req.tenantId), req.body.waiterId, 'order:assigned', publicOrder(order));
  await audit(req, 'order.assign', 'Order', order._id, { waiterId: req.body.waiterId });
  res.json(order);
}));

ordersRouter.post('/:id/items/:itemId/status', can('kitchen:operate', 'orders:deliver'), checkIdParams, validateBody(z.object({ status: z.enum(ITEM_STATUSES) })), ah(async (req, res) => {
  // Removing an item changes the bill: it goes through the cancel endpoint, which re-prices the order.
  if (req.body.status === 'cancelled') throw badRequest('Use “cancel item” to remove an item from the order');
  // Waiters may only mark items served; kitchen handles preparation states.
  if (req.body.status !== 'served' && !roleHas(req.user!.role, 'kitchen:operate', req.user!.permissionOverrides)) throw forbidden();
  const order = await updateItemStatus(req.tenant!, req.params.id, req.params.itemId, req.body.status, req.user!);
  await audit(req, 'order.item_status', 'Order', req.params.id, { itemId: req.params.itemId, status: req.body.status });
  res.json(order);
}));

/** KDS ticket actions: "Start all" / "All ready" for the items a station shows. */
ordersRouter.post('/:id/items/bulk-status', can('kitchen:operate'), checkIdParams, validateBody(z.object({ itemIds: z.array(zId).min(1).max(100), status: z.enum(['preparing', 'ready']) })), ah(async (req, res) => {
  const order = await updateItemsStatus(req.tenant!, req.params.id, req.body.itemIds, req.body.status, req.user!);
  await audit(req, 'order.items_bulk_status', 'Order', req.params.id, { items: req.body.itemIds.length, status: req.body.status });
  res.json(order);
}));

/* --------------------------- Order modification --------------------------- */
const addItemsSchema = z.object({ items: placeOrderSchema.shape.items.element.omit({ discount: true }).array().min(1).max(50) });

ordersRouter.post('/:id/items', can('orders:modify'), checkIdParams, validateBody(addItemsSchema), ah(async (req, res) => {
  const order = await addOrderItems(req.tenant!, req.params.id, req.body.items, req.user!);
  await audit(req, 'order.items_added', 'Order', req.params.id, { items: req.body.items.length });
  res.status(201).json(order);
}));

ordersRouter.patch('/:id/items/:itemId', can('orders:modify'), checkIdParams, validateBody(z.object({ quantity: z.number().int().min(1).max(99).optional(), notes: z.string().max(300).optional() }).refine((b) => b.quantity != null || b.notes !== undefined, 'Nothing to change')), ah(async (req, res) => {
  const order = await updateOrderItem(req.tenant!, req.params.id, req.params.itemId, req.body, req.user!);
  await audit(req, 'order.item_changed', 'Order', req.params.id, { itemId: req.params.itemId, ...req.body });
  res.json(order);
}));

ordersRouter.post('/:id/items/:itemId/cancel', can('orders:modify'), checkIdParams, validateBody(z.object({ reason: z.string().min(3).max(200) })), ah(async (req, res) => {
  const order = await cancelOrderItem(req.tenant!, req.params.id, req.params.itemId, req.body.reason, req.user!);
  await audit(req, 'order.item_cancelled', 'Order', req.params.id, { itemId: req.params.itemId, reason: req.body.reason });
  res.json(order);
}));

ordersRouter.post('/:id/transfer', can('orders:transfer'), checkIdParams, validateBody(z.object({ tableId: zId })), ah(async (req, res) => {
  const order = await transferOrder(req.tenant!, req.params.id, req.body.tableId, req.user!);
  await audit(req, 'order.table_transfer', 'Order', req.params.id, { tableId: req.body.tableId });
  res.json(order);
}));

ordersRouter.post('/:id/request-bill', can('orders:view'), checkIdParams, ah(async (req, res) => {
  const order = await requestBill(req.tenant!, req.params.id, req.user!);
  await audit(req, 'order.bill_requested', 'Order', req.params.id);
  res.json(order);
}));

/* --------------------------- Split bills, payments, receipts --------------------------- */
const zAllocation = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('equal'), parts: z.number().int().min(2).max(50), part: z.number().int().min(1).max(50), label: z.string().max(60).optional() }),
  z.object({ mode: z.literal('items'), items: z.array(z.object({ itemId: zId, quantity: z.number().int().min(1).max(999) })).min(1).max(100), label: z.string().max(60).optional() }),
]);

ordersRouter.post('/:id/split-quote', can('payments:collect'), checkIdParams, validateBody(z.object({ mode: z.enum(['equal', 'items']), parts: z.number().int().min(2).max(50).optional(), items: z.array(z.object({ itemId: zId, quantity: z.number().int().min(0).max(999) })).max(100).optional() })), ah(async (req, res) => {
  res.json(await splitQuote(req.tenant!, req.params.id, req.body));
}));

ordersRouter.post('/:id/payments/cash', can('payments:collect'), checkIdParams, validateBody(z.object({
  amount: zMoney.refine((n) => n > 0).optional(),
  method: z.enum(['cash', 'card_terminal']).default('cash'),
  allocation: zAllocation.optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
}).refine((b) => b.amount != null || b.allocation, 'Enter an amount or choose a split')), ah(async (req, res) => {
  const { payment, amount, shiftId } = await collectPayment(req.tenant!, req.user!, req.params.id, req.body);
  await audit(req, 'payment.collect', 'Payment', payment._id, { amount, method: req.body.method, orderId: req.params.id, split: req.body.allocation?.mode, shiftId });
  res.status(201).json(payment);
}));

ordersRouter.post('/payments/:paymentId/refund', can('payments:refund'), checkIdParams, validateBody(z.object({ amount: zMoney.refine((n) => n > 0), reason: z.string().min(3).max(300) })), ah(async (req, res) => {
  const shift = await findOpenShift(req.tenantId!, req.user!.id);
  const refund = await refundPayment(req.tenantId!, req.params.paymentId, req.body.amount, req.body.reason, req.user!, shift?._id);
  await audit(req, 'payment.refund', 'Payment', refund._id, { amount: req.body.amount, chargeId: req.params.paymentId, shiftId: shift?._id });
  res.status(201).json(refund);
}));

/** Receipt data (JSON) for browser printing, or a PDF sized for 58 mm / 80 mm thermal paper or A4. */
ordersRouter.get('/:id/receipt', can('orders:view'), checkIdParams, validateQuery(z.object({ format: z.enum(['json', 'pdf']).default('json'), width: z.enum(['58', '80', 'a4']).default('80') })), ah(async (req, res) => {
  const data = await receiptData(req.tenant!, req.params.id);
  const q = (req as any).validQuery;
  if (q.format === 'json') return void res.json(data);
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="receipt-${data.order.orderNumber}.pdf"`);
  renderReceiptPdf(data, q.width).pipe(res);
}));

/* --------------------------- Kitchen display --------------------------- */
export const kitchenRouter = Router();
kitchenRouter.use(requireFeature('kds'));

kitchenRouter.get('/queue', can('kitchen:operate'), validateQuery(z.object({ stationId: z.string().optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId, status: { $in: ['accepted', 'preparing', 'partially_ready', 'ready'] } };
  const stationId = q.stationId && /^[a-f0-9]{24}$/i.test(q.stationId) ? q.stationId : null;
  if (stationId) filter['items.stationId'] = stationId;
  const orders = await Order.find(filter).sort({ acceptedAt: 1, createdAt: 1 }).limit(200).lean();
  const view = orders.map((o) => ({
    ...publicOrder(o),
    items: stationId ? o.items.filter((i: any) => String(i.stationId) === stationId) : o.items,
  }));
  res.json({ items: view, serverTime: new Date(), delayGraceMinutes: req.tenant!.settings?.kitchenDelayGraceMinutes ?? 5 });
}));
