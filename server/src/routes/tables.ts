import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import { Table, Order } from '../models/operations';
import { Plan } from '../models/platform';
import { ah, badRequest, conflict, notFound, paymentRequired } from '../lib/errors';
import { can } from '../middleware/auth';
import { checkIdParams, validateBody } from '../middleware/validate';
import { randomToken } from '../lib/crypto';
import { audit } from '../services/audit';
import { tableUrl } from '../lib/appUrl';
import { roleHas } from '../config/permissions';
import { mergeTables } from '../services/orderOps';
import { emit } from '../sockets';

export const tablesRouter = Router();


const tableSchema = z.object({
  label: z.string().min(1).max(30),
  area: z.string().max(60).optional(),
  capacity: z.number().int().min(1).max(100).optional(),
  status: z.enum(['available', 'occupied', 'reserved', 'cleaning']).optional(),
  isActive: z.boolean().optional(),
});

tablesRouter.get('/', can('tables:view'), ah(async (req, res) => {
  const tables = await Table.find({ tenantId: req.tenantId }).sort({ area: 1, label: 1 }).lean();
  const open = await Order.aggregate([
    { $match: { tenantId: req.tenantId, tableId: { $in: tables.map((t) => t._id) }, status: { $nin: ['completed', 'rejected', 'cancelled', 'refunded'] } } },
    { $group: { _id: '$tableId', orders: { $sum: 1 }, due: { $sum: { $subtract: ['$total', '$amountPaid'] } } } },
  ]);
  const byTable = new Map<string, any>(open.map((o) => [String(o._id), o]));
  res.json({ items: tables.map((t) => ({ ...t, qrUrl: tableUrl(req.tenant!.slug, t.qrToken, req), openOrders: byTable.get(String(t._id))?.orders ?? 0, amountDue: byTable.get(String(t._id))?.due ?? 0 })) });
}));

const createTablesSchema = tableSchema
  .extend({ label: z.string().min(1).max(30).optional(), count: z.number().int().min(1).max(100).optional(), prefix: z.string().max(10).optional() })
  .refine((b) => (b.count ?? 1) > 1 || !!b.label, { message: 'Label is required', path: ['label'] });

tablesRouter.post('/', can('tables:manage'), validateBody(createTablesSchema), ah(async (req, res) => {
  const plan = req.tenant!.subscription?.planId ? await Plan.findById(req.tenant!.subscription.planId).lean() : null;
  const existingLabels = new Set((await Table.find({ tenantId: req.tenantId }).select('label').lean()).map((t) => t.label.toLowerCase()));
  const { count, prefix, ...base } = req.body;
  const n = count ?? 1;
  if (plan?.limits?.maxTables && existingLabels.size + n > plan.limits.maxTables) throw paymentRequired(`Your plan allows ${plan.limits.maxTables} tables`);
  // Bulk mode: next free numbers for the prefix, skipping labels that already exist (e.g. after deletions).
  const labels: string[] = [];
  if (n > 1) {
    const p = prefix ?? 'T';
    for (let i = 1; labels.length < n && i < 100_000; i++) {
      const l = `${p}${i}`;
      if (!existingLabels.has(l.toLowerCase())) labels.push(l);
    }
  } else {
    if (existingLabels.has(String(base.label).toLowerCase())) throw conflict(`A table labelled “${base.label}” already exists`);
    labels.push(base.label);
  }
  const docs = labels.map((label) => ({ ...base, label, qrToken: randomToken(18), tenantId: req.tenantId }));
  const created = await Table.insertMany(docs);
  await audit(req, 'table.create', 'Table', undefined, { count: n });
  res.status(201).json({ items: created });
}));

tablesRouter.patch('/:id', can('tables:manage', 'orders:deliver'), checkIdParams, validateBody(tableSchema.partial()), ah(async (req, res) => {
  // Waiters may only change status (e.g. cleaning -> available); structural edits need tables:manage.
  const canManage = roleHas(req.user!.role, 'tables:manage', req.user!.permissionOverrides);
  const body = canManage ? req.body : { status: req.body.status };
  if (!canManage && !body.status) throw badRequest('Only status can be changed');
  const t = await Table.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: body }, { new: true, runValidators: true });
  if (!t) throw notFound('Table not found');
  await audit(req, 'table.update', 'Table', t._id, body);
  emit.staff(String(req.tenantId), 'table:updated', { _id: t._id, label: t.label, status: t.status });
  res.json(t);
}));

tablesRouter.delete('/:id', can('tables:manage'), checkIdParams, ah(async (req, res) => {
  const open = await Order.countDocuments({ tenantId: req.tenantId, tableId: req.params.id, status: { $nin: ['completed', 'rejected', 'cancelled', 'refunded'] } });
  if (open) throw badRequest('Table has open orders');
  const t = await Table.findOneAndDelete({ tenantId: req.tenantId, _id: req.params.id });
  if (!t) throw notFound('Table not found');
  await audit(req, 'table.delete', 'Table', t._id);
  res.json({ ok: true });
}));

/** Regenerating invalidates the old QR immediately (old token no longer resolves). */
tablesRouter.post('/:id/regenerate', can('tables:manage'), checkIdParams, ah(async (req, res) => {
  const t = await Table.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: { qrToken: randomToken(18) }, $inc: { qrVersion: 1 } }, { new: true });
  if (!t) throw notFound('Table not found');
  await audit(req, 'table.qr_regenerate', 'Table', t._id);
  res.json({ ...t.toObject(), qrUrl: tableUrl(req.tenant!.slug, t.qrToken, req) });
}));

tablesRouter.get('/:id/qr', can('tables:view'), checkIdParams, ah(async (req, res) => {
  const t = await Table.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
  if (!t) throw notFound('Table not found');
  const url = tableUrl(req.tenant!.slug, t.qrToken, req);
  const format = req.query.format === 'svg' ? 'svg' : 'png';
  const filename = `${req.tenant!.slug}-table-${t.label.replace(/[^\w-]/g, '')}.${format}`;
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${filename}"`);
  if (format === 'svg') {
    res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
  } else {
    res.type('image/png').send(await QRCode.toBuffer(url, { width: 768, margin: 2, errorCorrectionLevel: 'M' }));
  }
}));

/** Printable A4 PDF with one QR card per table (2×3 grid per page). */
tablesRouter.get('/qr/print', can('tables:view'), ah(async (req, res) => {
  const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',').filter((x) => /^[a-f0-9]{24}$/i.test(x)) : [];
  const filter: any = { tenantId: req.tenantId, isActive: true };
  if (ids.length) filter._id = { $in: ids };
  const tables = await Table.find(filter).sort({ label: 1 }).lean();
  if (!tables.length) throw notFound('No tables to print');
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${req.tenant!.slug}-table-qr-codes.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.pipe(res);
  const cardW = 255, cardH = 240, cols = 2;
  for (let i = 0; i < tables.length; i++) {
    const pos = i % 6;
    if (i > 0 && pos === 0) doc.addPage();
    const x = 36 + (pos % cols) * (cardW + 13);
    const y = 36 + Math.floor(pos / cols) * (cardH + 12);
    const t = tables[i];
    const png = await QRCode.toBuffer(tableUrl(req.tenant!.slug, t.qrToken, req), { width: 400, margin: 1 });
    doc.roundedRect(x, y, cardW, cardH, 10).lineWidth(1).stroke('#D6D3D1');
    doc.fontSize(13).fillColor('#1C1917').text(req.tenant!.name, x, y + 12, { width: cardW, align: 'center' });
    doc.image(png, x + (cardW - 150) / 2, y + 34, { width: 150 });
    doc.fontSize(18).text(`Table ${t.label}`, x, y + 190, { width: cardW, align: 'center' });
    doc.fontSize(9).fillColor('#78716C').text('Scan to view the menu & order', x, y + 214, { width: cardW, align: 'center' });
  }
  doc.end();
}));

/** Merge tables: every open order of this table moves to `intoTableId` (guests joined another table). */
tablesRouter.post('/:id/merge', can('orders:transfer'), checkIdParams, validateBody(z.object({ intoTableId: z.string().regex(/^[a-f0-9]{24}$/i) })), ah(async (req, res) => {
  const r = await mergeTables(req.tenant!, req.params.id, req.body.intoTableId, req.user!);
  await audit(req, 'table.merge', 'Table', req.params.id, { into: req.body.intoTableId, orders: r.moved });
  res.json(r);
}));
