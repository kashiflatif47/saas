import { Router } from 'express';
import { z } from 'zod';
import { InventoryItem, PurchaseOrder, StockMovement, Supplier } from '../models/inventory';
import { Coupon, Customer, Feedback, Reservation, Table } from '../models/operations';
import { ah, badRequest, notFound } from '../lib/errors';
import { can } from '../middleware/auth';
import { requireFeature } from '../middleware/tenant';
import { checkIdParams, validateBody, validateQuery, zId, zMoney, zPage } from '../middleware/validate';
import { applyStockDelta } from '../services/inventoryService';
import { nextSequence } from '../services/orderService';
import { audit } from '../services/audit';
import { crudRouter } from './crudFactory';

/* ================================ Inventory ================================ */
export const inventoryRouter = Router();
inventoryRouter.use(requireFeature('inventory'));

inventoryRouter.use('/suppliers', crudRouter({
  model: Supplier,
  entity: 'Supplier',
  create: z.object({ name: z.string().min(1).max(120), contactName: z.string().max(80).optional(), phone: z.string().max(30).optional(), email: z.string().email().or(z.literal('')).optional(), address: z.string().max(300).optional(), notes: z.string().max(1000).optional(), isActive: z.boolean().optional() }),
  viewPerm: 'inventory:view',
  managePerm: 'inventory:manage',
  searchFields: ['name', 'contactName', 'phone'],
  defaultSort: { name: 1 },
  softDeleteField: 'isActive',
}));

const itemSchema = z.object({
  name: z.string().min(1).max(120),
  sku: z.string().max(40).optional(),
  unit: z.enum(['g', 'kg', 'ml', 'l', 'pcs', 'pack', 'box']),
  lowStockThreshold: z.number().min(0).max(1e7).optional(),
  costPerUnit: zMoney.optional(),
  supplierId: zId.nullable().optional(),
  isActive: z.boolean().optional(),
});

inventoryRouter.get('/items', can('inventory:view'), validateQuery(zPage.extend({ lowStock: z.enum(['true', 'false']).optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId, isActive: true };
  if (q.q) filter.name = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (q.lowStock === 'true') filter.$expr = { $and: [{ $gt: ['$lowStockThreshold', 0] }, { $lte: ['$quantity', '$lowStockThreshold'] }] };
  const [items, total] = await Promise.all([
    InventoryItem.find(filter).populate('supplierId', 'name').sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    InventoryItem.countDocuments(filter),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
}));

inventoryRouter.post('/items', can('inventory:manage'), validateBody(itemSchema.extend({ openingQuantity: z.number().min(0).max(1e9).optional() })), ah(async (req, res) => {
  const { openingQuantity, ...data } = req.body;
  if (data.supplierId && !(await Supplier.exists({ tenantId: req.tenantId, _id: data.supplierId }))) throw badRequest('Supplier not found');
  const item = await InventoryItem.create({ ...data, quantity: 0, tenantId: req.tenantId });
  if (openingQuantity) await applyStockDelta(req.tenantId!, item._id, openingQuantity, 'adjustment', { reason: 'Opening stock', actorId: req.user!.id });
  await audit(req, 'inventory.create', 'InventoryItem', item._id);
  res.status(201).json(await InventoryItem.findOne({ tenantId: req.tenantId, _id: item._id }).lean());
}));

inventoryRouter.patch('/items/:id', can('inventory:manage'), checkIdParams, validateBody(itemSchema.partial()), ah(async (req, res) => {
  if (req.body.supplierId && !(await Supplier.exists({ tenantId: req.tenantId, _id: req.body.supplierId }))) throw badRequest('Supplier not found');
  const item = await InventoryItem.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: req.body }, { new: true, runValidators: true });
  if (!item) throw notFound('Item not found');
  await audit(req, 'inventory.update', 'InventoryItem', item._id);
  res.json(item);
}));

inventoryRouter.delete('/items/:id', can('inventory:manage'), checkIdParams, ah(async (req, res) => {
  const item = await InventoryItem.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: { isActive: false } });
  if (!item) throw notFound('Item not found');
  await audit(req, 'inventory.deactivate', 'InventoryItem', item._id);
  res.json({ ok: true });
}));

/** Manual stock adjustments and wastage. Quantity is a signed delta for adjustments, positive for wastage. */
inventoryRouter.post('/items/:id/adjust', can('inventory:manage'), checkIdParams, validateBody(z.object({
  type: z.enum(['adjustment', 'wastage']),
  quantity: z.number().refine((n) => n !== 0 && Math.abs(n) < 1e9, 'Quantity must be non-zero'),
  reason: z.string().min(2).max(300),
})), ah(async (req, res) => {
  const delta = req.body.type === 'wastage' ? -Math.abs(req.body.quantity) : req.body.quantity;
  const item = await applyStockDelta(req.tenantId!, req.params.id, delta, req.body.type, { reason: req.body.reason, actorId: req.user!.id });
  await audit(req, `inventory.${req.body.type}`, 'InventoryItem', req.params.id, { delta, reason: req.body.reason });
  res.json(item);
}));

inventoryRouter.get('/movements', can('inventory:view'), validateQuery(zPage.extend({ itemId: z.string().optional(), type: z.string().optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId };
  if (q.itemId && /^[a-f0-9]{24}$/i.test(q.itemId)) filter.inventoryItemId = q.itemId;
  if (q.type) filter.type = q.type;
  const [items, total] = await Promise.all([
    StockMovement.find(filter).populate('inventoryItemId', 'name unit').sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    StockMovement.countDocuments(filter),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
}));

/* -------- Purchase orders -------- */
const poSchema = z.object({
  supplierId: zId,
  lines: z.array(z.object({ inventoryItemId: zId, quantity: z.number().positive().max(1e9), unitCost: zMoney })).min(1).max(100),
  expectedAt: z.coerce.date().optional(),
  notes: z.string().max(1000).optional(),
});

inventoryRouter.get('/purchase-orders', can('inventory:view'), validateQuery(zPage.extend({ status: z.string().optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId };
  if (q.status) filter.status = q.status;
  const [items, total] = await Promise.all([
    PurchaseOrder.find(filter).populate('supplierId', 'name').sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    PurchaseOrder.countDocuments(filter),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
}));

inventoryRouter.post('/purchase-orders', can('inventory:manage'), validateBody(poSchema), ah(async (req, res) => {
  if (!(await Supplier.exists({ tenantId: req.tenantId, _id: req.body.supplierId }))) throw badRequest('Supplier not found');
  const ids = [...new Set(req.body.lines.map((l: any) => l.inventoryItemId))];
  const items = await InventoryItem.find({ tenantId: req.tenantId, _id: { $in: ids } }).select('name').lean();
  if (items.length !== ids.length) throw badRequest('Unknown inventory item');
  const names = new Map(items.map((i) => [String(i._id), i.name]));
  const lines = req.body.lines.map((l: any) => ({ ...l, name: names.get(l.inventoryItemId) }));
  const total = Math.round(lines.reduce((s: number, l: any) => s + l.quantity * l.unitCost, 0));
  const po = await PurchaseOrder.create({ ...req.body, lines, total, poNumber: await nextSequence(req.tenantId!, 'po'), tenantId: req.tenantId });
  await audit(req, 'po.create', 'PurchaseOrder', po._id);
  res.status(201).json(po);
}));

inventoryRouter.post('/purchase-orders/:id/status', can('inventory:manage'), checkIdParams, validateBody(z.object({ status: z.enum(['ordered', 'cancelled']) })), ah(async (req, res) => {
  const allowedFrom = req.body.status === 'ordered' ? ['draft'] : ['draft', 'ordered'];
  const po = await PurchaseOrder.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id, status: { $in: allowedFrom } }, { $set: { status: req.body.status } }, { new: true });
  if (!po) throw badRequest('Purchase order not found or cannot change to that status');
  await audit(req, `po.${req.body.status}`, 'PurchaseOrder', po._id);
  res.json(po);
}));

/** Receiving a PO adds stock (purchase movements) and updates unit costs. Atomic status guard prevents double receipt. */
inventoryRouter.post('/purchase-orders/:id/receive', can('inventory:manage'), checkIdParams, ah(async (req, res) => {
  const po = await PurchaseOrder.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id, status: { $in: ['draft', 'ordered'] } }, { $set: { status: 'received', receivedAt: new Date() } }, { new: true });
  if (!po) throw badRequest('Purchase order not found or already received/cancelled');
  for (const l of po.lines as any[]) {
    await applyStockDelta(req.tenantId!, l.inventoryItemId, l.quantity, 'purchase', { refType: 'PurchaseOrder', refId: po._id, actorId: req.user!.id, reason: `PO #${po.poNumber}` });
    await InventoryItem.updateOne({ tenantId: req.tenantId, _id: l.inventoryItemId }, { $set: { costPerUnit: l.unitCost } });
    l.receivedQty = l.quantity;
  }
  po.markModified('lines');
  await po.save();
  await audit(req, 'po.receive', 'PurchaseOrder', po._id);
  res.json(po);
}));

/* ================================ Reservations ================================ */
export const reservationsRouter = Router();
reservationsRouter.use(requireFeature('reservations'));
reservationsRouter.use('/', crudRouter({
  model: Reservation,
  entity: 'Reservation',
  create: z.object({
    name: z.string().min(2).max(80),
    phone: z.string().min(5).max(25),
    email: z.string().email().or(z.literal('')).optional(),
    partySize: z.number().int().min(1).max(100),
    reservedFor: z.coerce.date(),
    durationMinutes: z.number().int().min(15).max(600).optional(),
    tableId: zId.nullable().optional(),
    status: z.enum(['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show']).optional(),
    notes: z.string().max(500).optional(),
  }),
  viewPerm: 'reservations:manage',
  managePerm: 'reservations:manage',
  searchFields: ['name', 'phone'],
  filterKeys: ['status'],
  defaultSort: { reservedFor: 1 },
  beforeSave: async (data, req, existing) => {
    const tableId = data.tableId ?? existing?.tableId;
    if (data.tableId && !(await Table.exists({ tenantId: req.tenantId, _id: data.tableId }))) throw badRequest('Table not found');
    // Double-booking guard for confirmed/seated reservations on the same table.
    const status = data.status ?? existing?.status;
    if (tableId && ['confirmed', 'seated'].includes(status)) {
      const start = new Date(data.reservedFor ?? existing.reservedFor);
      const dur = (data.durationMinutes ?? existing?.durationMinutes ?? 90) * 60_000;
      const clash = await Reservation.findOne({
        tenantId: req.tenantId,
        tableId,
        status: { $in: ['confirmed', 'seated'] },
        _id: { $ne: existing?._id },
        reservedFor: { $lt: new Date(start.getTime() + dur), $gt: new Date(start.getTime() - 10 * 3600_000) },
      }).lean();
      if (clash && new Date(clash.reservedFor).getTime() + (clash.durationMinutes ?? 90) * 60_000 > start.getTime()) {
        throw badRequest('That table is already booked for an overlapping time');
      }
    }
    if (data.status === 'seated' && tableId) await Table.updateOne({ tenantId: req.tenantId, _id: tableId }, { $set: { status: 'occupied' } });
    return data;
  },
}));

/* ================================ Customers ================================ */
export const customersRouter = crudRouter({
  model: Customer,
  entity: 'Customer',
  create: z.object({ name: z.string().max(80).optional(), phone: z.string().min(5).max(25).transform((p) => p.replace(/[^\d+]/g, '')), email: z.string().email().or(z.literal('')).optional(), notes: z.string().max(1000).optional(), tags: z.array(z.string().max(30)).max(10).optional(), loyaltyPoints: z.number().int().min(0).optional() }),
  viewPerm: 'customers:manage',
  managePerm: 'customers:manage',
  searchFields: ['name', 'phone', 'email'],
  defaultSort: { lastOrderAt: -1 },
});

/* ================================ Feedback ================================ */
export const feedbackRouter = Router();
feedbackRouter.get('/', can('feedback:view'), validateQuery(zPage), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter = { tenantId: req.tenantId };
  const [items, total, stats] = await Promise.all([
    Feedback.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Feedback.countDocuments(filter),
    Feedback.aggregate([{ $match: filter }, { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } }]),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit, average: stats[0]?.avg ?? null });
}));
feedbackRouter.patch('/:id', can('feedback:view'), checkIdParams, validateBody(z.object({ isPublished: z.boolean().optional(), response: z.string().max(1000).optional() })), ah(async (req, res) => {
  const fb = await Feedback.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: req.body }, { new: true });
  if (!fb) throw notFound('Feedback not found');
  await audit(req, 'feedback.update', 'Feedback', fb._id);
  res.json(fb);
}));

/* ================================ Coupons ================================ */
export const couponsRouter = crudRouter({
  model: Coupon,
  entity: 'Coupon',
  create: z.object({
    code: z.string().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/).transform((s) => s.toUpperCase()),
    description: z.string().max(200).optional(),
    type: z.enum(['percent', 'fixed']),
    value: z.number().int().min(1).max(1_000_000_000),
    maxDiscount: zMoney.nullable().optional(),
    minOrder: zMoney.nullable().optional(),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    usageLimit: z.number().int().min(1).nullable().optional(),
    isActive: z.boolean().optional(),
  }),
  viewPerm: 'coupons:manage',
  managePerm: 'coupons:manage',
  searchFields: ['code', 'description'],
  beforeSave: (data, _req, existing) => {
    const type = data.type ?? existing?.type;
    const value = data.value ?? existing?.value;
    if (type === 'percent' && value > 100) throw badRequest('Percent coupons must be 1–100');
    return data;
  },
});
