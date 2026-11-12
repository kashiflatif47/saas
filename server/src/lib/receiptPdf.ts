import PDFDocument from 'pdfkit';
import type { receiptData } from '../services/orderOps';

type Receipt = Awaited<ReturnType<typeof receiptData>>;

const MM = 72 / 25.4;

/** Formats integer minor units without currency symbols (PDF core fonts have no Arabic or ر.س glyphs). */
export function fmtMinor(n: number, decimals: number) {
  return (n / 10 ** decimals).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * Receipt PDF: 58 mm and 80 mm thermal roll widths (page height grows with the content) or A4.
 * Uses the PDF core fonts, so Latin text only; Arabic receipts are printed from the browser view, which
 * uses the system fonts and right-to-left layout.
 */
export function renderReceiptPdf(r: Receipt, width: '58' | '80' | 'a4') {
  const thermal = width !== 'a4';
  const pageW = thermal ? Number(width) * MM : 595.28;
  const margin = thermal ? 3 * MM : 48;
  const lineCount = 22 + r.items.length * 2 + r.items.filter((i) => i.addons.length || i.notes).length + r.payments.length + r.refunds.length;
  const pageH = thermal ? Math.max(120 * MM, lineCount * 13 + 60) : 841.89;
  const doc = new PDFDocument({ size: [pageW, pageH], margin, info: { Title: `Receipt #${r.order.orderNumber}` } });
  const w = pageW - margin * 2;
  const base = thermal ? (width === '58' ? 7 : 8) : 10;
  const d = r.currencyDecimals;
  const m = (n: number) => fmtMinor(n, d);
  const row = (left: string, right: string, opts: { bold?: boolean; size?: number } = {}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size ?? base);
    const y = doc.y;
    doc.text(left, margin, y, { width: w * 0.68 });
    const after = doc.y;
    doc.text(right, margin + w * 0.6, y, { width: w * 0.4, align: 'right' });
    doc.y = Math.max(after, doc.y);
  };
  const rule = () => {
    doc.moveDown(0.3);
    doc.moveTo(margin, doc.y).lineTo(pageW - margin, doc.y).dash(2, { space: 2 }).lineWidth(0.5).stroke('#555').undash();
    doc.moveDown(0.4);
  };

  doc.font('Helvetica-Bold').fontSize(base + 4).text(r.restaurant.name, { align: 'center', width: w });
  doc.font('Helvetica').fontSize(base - 0.5);
  if (r.restaurant.address) doc.text(r.restaurant.address, { align: 'center', width: w });
  if (r.restaurant.phone) doc.text(r.restaurant.phone, { align: 'center', width: w });
  if (r.restaurant.taxRegistrationNumber) doc.text(`${r.tax.label} No. ${r.restaurant.taxRegistrationNumber}`, { align: 'center', width: w });
  rule();
  row(`Order #${r.order.orderNumber}`, new Date(r.order.createdAt as any).toLocaleString('en-GB'), { bold: true });
  row(`Type: ${r.order.type.replace('_', ' ')}`, r.order.tableLabel ? `Table ${r.order.tableLabel}` : '');
  if (r.order.takenBy) row(`Taken by: ${r.order.takenBy}`, '');
  if (r.order.cashiers.length) row(`Cashier: ${r.order.cashiers.join(', ')}`, '');
  if (r.order.customer?.name || r.order.customer?.phone) row(`Customer: ${[r.order.customer?.name, r.order.customer?.phone].filter(Boolean).join(' · ')}`, '');
  if (r.order.delivery?.address) row(`Deliver to: ${r.order.delivery.address}`, '');
  rule();
  for (const i of r.items) {
    row(`${i.quantity} × ${i.name}${i.variantName ? ` (${i.variantName})` : ''}`, m(i.lineTotal));
    if (i.addons.length) row(`   + ${i.addons.join(', ')}`, '', { size: base - 1 });
    if (i.quantity > 1) row(`   @ ${m(i.unitPrice)}`, '', { size: base - 1 });
    if (i.discount) row('   Item discount', `-${m(i.discount)}`, { size: base - 1 });
  }
  rule();
  const t = r.totals;
  row('Subtotal', m(t.subtotal));
  if (t.lineDiscount) row('Item discounts', `-${m(t.lineDiscount)}`);
  if (t.couponDiscount) row(`Coupon ${t.couponCode ?? ''}`.trim(), `-${m(t.couponDiscount)}`);
  if (t.manualDiscount) row(`Discount${t.manualDiscountReason ? ` (${t.manualDiscountReason})` : ''}`, `-${m(t.manualDiscount)}`);
  if (t.serviceCharge) row('Service charge', m(t.serviceCharge));
  if (t.deliveryFee) row('Delivery fee', m(t.deliveryFee));
  if (r.tax.inclusive) {
    row(`Total (incl. ${r.tax.label} ${r.tax.ratePercent}%)`, `${m(t.total)} ${r.currency}`, { bold: true, size: base + 2 });
    row(`${r.tax.label} included`, m(t.tax));
    row(`Amount excl. ${r.tax.label}`, m(r.tax.taxable));
  } else {
    row(`${r.tax.label} ${r.tax.ratePercent}% on ${m(r.tax.taxable)}`, m(t.tax));
    row('Total', `${m(t.total)} ${r.currency}`, { bold: true, size: base + 2 });
  }
  rule();
  for (const p of r.payments) row(`Paid · ${p.method.replace('_', ' ')}${p.label ? ` · ${p.label}` : ''}`, m(p.amount));
  for (const p of r.refunds) row(`Refund · ${p.method.replace('_', ' ')}`, `-${m(p.amount)}`);
  row('Total paid', m(t.paid), { bold: true });
  if (t.refunded) row('Refunded', `-${m(t.refunded)}`);
  row(t.balance > 0 ? 'Balance due' : 'Balance', m(t.balance), { bold: true });
  rule();
  doc.font('Helvetica').fontSize(base - 1).text(r.restaurant.footer || 'Thank you!', { align: 'center', width: w });
  doc.end();
  return doc;
}
