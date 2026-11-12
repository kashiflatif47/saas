import { Router } from 'express';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import { can } from '../middleware/auth';
import { requireFeature } from '../middleware/tenant';
import { validateQuery } from '../middleware/validate';
import { ah } from '../lib/errors';
import { categoryReport, financialSummary, parseRange, productReport, revenueSeries, topHours, type Granularity } from '../services/analyticsService';
import { Order, Payment, Reservation, Table } from '../models/operations';
import { InventoryItem } from '../models/inventory';
import { toCsv, minorToMajor } from '../lib/csv';

export const analyticsRouter = Router();

const rangeQuery = z.object({
  from: z.string().max(30).optional(),
  to: z.string().max(30).optional(),
  period: z.enum(['today', 'week', 'month', 'year']).optional(),
  unit: z.enum(['day', 'week', 'month', 'year']).optional(),
});

/** Live dashboard tiles for today in the tenant's timezone. */
analyticsRouter.get('/dashboard', can('orders:view'), ah(async (req, res) => {
  const tz = req.tenant!.settings?.timezone ?? 'UTC';
  const startOfDay = startOfLocalDay(tz);
  const tenantId = req.tenantId!;
  const [summary, active, tables, upcoming, lowStock, recent] = await Promise.all([
    financialSummary(tenantId, { from: startOfDay, to: new Date(Date.now() + 60_000), tz }),
    Order.aggregate([{ $match: { tenantId, status: { $in: ['pending', 'accepted', 'preparing', 'partially_ready', 'ready', 'delivered'] } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Table.aggregate([{ $match: { tenantId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Reservation.countDocuments({ tenantId, status: { $in: ['pending', 'confirmed'] }, reservedFor: { $gte: new Date(), $lt: new Date(Date.now() + 86400_000) } }),
    InventoryItem.countDocuments({ tenantId, isActive: true, $expr: { $and: [{ $gt: ['$lowStockThreshold', 0] }, { $lte: ['$quantity', '$lowStockThreshold'] }] } }),
    Order.find({ tenantId }).sort({ createdAt: -1 }).limit(8).select('orderNumber status paymentStatus total tableLabel createdAt type').lean(),
  ]);
  res.json({
    today: summary,
    activeOrders: Object.fromEntries(active.map((a) => [a._id, a.n])),
    tables: Object.fromEntries(tables.map((a) => [a._id, a.n])),
    upcomingReservations: upcoming,
    lowStockItems: lowStock,
    recentOrders: recent,
  });
}));

analyticsRouter.get('/summary', can('analytics:view'), validateQuery(rangeQuery), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const range = parseRange(q, req.tenant!.settings?.timezone ?? 'UTC');
  const unit: Granularity = q.unit ?? (q.period === 'year' ? 'month' : 'day');
  const [summary, series, products, categories, hours] = await Promise.all([
    financialSummary(req.tenantId!, range),
    revenueSeries(req.tenantId!, range, unit),
    productReport(req.tenantId!, range),
    categoryReport(req.tenantId!, range),
    topHours(req.tenantId!, range),
  ]);
  res.json({ range, unit, summary, series, products: products.slice(0, 50), categories, hours });
}));

/** Exports: kind = orders | payments | products | categories | summary ; format = csv | pdf */
analyticsRouter.get('/export', can('analytics:view'), requireFeature('analytics_export'), validateQuery(rangeQuery.extend({ kind: z.enum(['orders', 'payments', 'products', 'categories', 'summary']), format: z.enum(['csv', 'pdf']).default('csv') })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const tz = req.tenant!.settings?.timezone ?? 'UTC';
  const dec = req.tenant!.settings?.currencyDecimals ?? 2;
  const cur = req.tenant!.settings?.currency ?? 'PKR';
  const range = parseRange(q, tz);
  const m = (n: number) => minorToMajor(n ?? 0, dec);
  let headers: string[] = [];
  let rows: unknown[][] = [];

  if (q.kind === 'orders') {
    const orders = await Order.find({ tenantId: req.tenantId, createdAt: { $gte: range.from, $lt: range.to } }).sort({ createdAt: 1 }).limit(50_000).lean();
    headers = ['Order #', 'Date', 'Type', 'Table', 'Status', 'Payment status', 'Subtotal', 'Discount', 'Service', 'Tax', 'Total', 'Paid', 'Refunded', 'Coupon'];
    rows = orders.map((o) => [o.orderNumber, o.createdAt, o.type, o.tableLabel ?? '', o.status, o.paymentStatus, m(o.subtotal), m(o.discount), m(o.serviceCharge), m(o.tax), m(o.total), m(o.amountPaid), m(o.amountRefunded), o.couponCode ?? '']);
  } else if (q.kind === 'payments') {
    const pays = await Payment.find({ tenantId: req.tenantId, createdAt: { $gte: range.from, $lt: range.to } }).populate('orderId', 'orderNumber').sort({ createdAt: 1 }).limit(50_000).lean();
    headers = ['Date', 'Order #', 'Kind', 'Method', 'Provider', 'Status', 'Amount', 'Reference', 'Reason'];
    rows = pays.map((p: any) => [p.createdAt, p.orderId?.orderNumber ?? '', p.kind, p.method, p.provider, p.status, m(p.amount), p.providerRef ?? '', p.reason ?? '']);
  } else if (q.kind === 'products') {
    const prods = await productReport(req.tenantId!, range);
    headers = ['Product', 'Quantity sold', 'Revenue'];
    rows = prods.map((p) => [p.name, p.quantity, m(p.revenue)]);
  } else if (q.kind === 'categories') {
    const cats = await categoryReport(req.tenantId!, range);
    headers = ['Category', 'Quantity sold', 'Revenue'];
    rows = cats.map((c) => [c.name, c.quantity, m(c.revenue)]);
  } else {
    const s = await financialSummary(req.tenantId!, range);
    headers = ['Metric', `Value (${cur})`];
    rows = [
      ['Orders', s.orders], ['Gross sales', m(s.grossSales)], ['Discounts', m(s.discounts)], ['Service charges', m(s.serviceCharges)],
      ['Taxes', m(s.taxes)], ['Net sales', m(s.netSales)], ['Verified collections', m(s.verifiedCollections)], ['Refunds', m(s.refunds)],
      ['Net collections', m(s.netCollections)], ['Pending payments', m(s.pendingPayments)], ['Cash', m(s.byMethod.cash)], ['Online', m(s.byMethod.online)],
      ['Card terminal', m(s.byMethod.cardTerminal)], ['Cancelled orders', s.cancelledOrders],
    ];
  }

  const base = `${req.tenant!.slug}-${q.kind}-${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}`;
  if (q.format === 'csv') {
    res.type('text/csv; charset=utf-8').setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return void res.send('﻿' + toCsv(headers, rows));
  }

  res.type('application/pdf').setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 36, layout: headers.length > 6 ? 'landscape' : 'portrait' });
  doc.pipe(res);
  doc.fontSize(16).text(`${req.tenant!.name} — ${q.kind[0].toUpperCase()}${q.kind.slice(1)} report`);
  doc.fontSize(9).fillColor('#666').text(`${range.from.toISOString().slice(0, 10)} to ${range.to.toISOString().slice(0, 10)} · Amounts in ${cur} · Generated ${new Date().toISOString()}`);
  doc.moveDown();
  const width = doc.page.width - 72;
  const colW = width / headers.length;
  const drawRow = (cells: unknown[], bold = false) => {
    if (doc.y > doc.page.height - 60) doc.addPage();
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#111');
    cells.forEach((c, i) => doc.text(c instanceof Date ? c.toISOString().slice(0, 16).replace('T', ' ') : String(c ?? ''), 36 + i * colW, y, { width: colW - 4, ellipsis: true, lineBreak: false }));
    doc.moveDown(0.9);
  };
  drawRow(headers, true);
  rows.slice(0, 5000).forEach((r) => drawRow(r));
  if (rows.length > 5000) doc.text(`… ${rows.length - 5000} more rows — use CSV for the full export.`);
  doc.end();
}));

function startOfLocalDay(tz: string): Date {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(now).map((p) => [p.type, p.value]));
  const localAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offset = localAsUtc - now.getTime();
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset);
}
