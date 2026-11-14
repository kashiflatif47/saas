import { useState } from 'react';
import { FileText, Printer } from 'lucide-react';
import { api, assetUrl } from '../api/client';
import { Button, useFeedback } from './ui';
import { formatMoney, ORDER_TYPE_LABEL } from '../lib/util';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Receipt HTML for the browser's print dialog. Thermal widths use the roll width as the page size. */
export function receiptHtml(r: any, width: '58' | '80' | 'a4') {
  const m = (n: number) => formatMoney(n, r.currency, r.currencyDecimals);
  const t = r.totals;
  const rtl = /[؀-ۿ]/.test(`${r.restaurant.name}${r.items.map((i: any) => i.name).join('')}`);
  const page = width === 'a4' ? 'A4' : `${width}mm auto`;
  const body = width === 'a4' ? '120mm' : `${Number(width) - 6}mm`;
  const row = (k: string, v: string, cls = '') => `<tr class="${cls}"><td>${k}</td><td class="r">${v}</td></tr>`;
  const items = r.items
    .map((i: any) => `<tr><td>${i.quantity} × ${esc(i.name)}${i.variantName ? ` (${esc(i.variantName)})` : ''}${i.addons.length ? `<div class="s">+ ${esc(i.addons.join(', '))}</div>` : ''}${i.quantity > 1 ? `<div class="s">@ ${m(i.unitPrice)}</div>` : ''}${i.discount ? `<div class="s">Item discount −${m(i.discount)}</div>` : ''}</td><td class="r">${m(i.lineTotal)}</td></tr>`)
    .join('');
  const taxRows = r.tax.inclusive
    ? row(`<b>Total (incl. ${esc(r.tax.label)} ${r.tax.ratePercent}%)</b>`, `<b>${m(t.total)}</b>`, 'big') + row(`${esc(r.tax.label)} included`, m(t.tax)) + row(`Amount excl. ${esc(r.tax.label)}`, m(r.tax.taxable))
    : row(`${esc(r.tax.label)} ${r.tax.ratePercent}% on ${m(r.tax.taxable)}`, m(t.tax)) + row('<b>Total</b>', `<b>${m(t.total)}</b>`, 'big');
  return `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>Receipt #${r.order.orderNumber}</title><style>
@page{size:${page};margin:${width === 'a4' ? '18mm' : '3mm'}}
*{box-sizing:border-box}body{margin:0 auto;width:${body};font:${width === '58' ? 10 : 11}px/1.35 system-ui,'Segoe UI',Tahoma,Arial,sans-serif;color:#000}
h1{font-size:1.45em;margin:0 0 2px;text-align:center}.c{text-align:center}.s{font-size:.85em;opacity:.8}
table{width:100%;border-collapse:collapse}td{vertical-align:top;padding:1px 0}.r{text-align:end;white-space:nowrap;padding-inline-start:6px}
hr{border:0;border-top:1px dashed #000;margin:6px 0}.big td{font-size:1.15em;padding-top:3px}img{display:block;margin:0 auto 4px;max-height:48px}
</style></head><body>
${r.restaurant.logoUrl ? `<img src="${esc(assetUrl(r.restaurant.logoUrl))}" alt="">` : ''}<h1>${esc(r.restaurant.name)}</h1>
<div class="c s">${[r.restaurant.address, r.restaurant.phone].filter(Boolean).map(esc).join('<br>')}${r.restaurant.taxRegistrationNumber ? `<br>${esc(r.tax.label)} No. ${esc(r.restaurant.taxRegistrationNumber)}` : ''}</div><hr>
${r.notice ? `<div class="c" style="border:1px solid #000;padding:3px;margin:4px 0;font-weight:700">${esc(r.notice)}</div>` : ''}
<table>${row(`<b>Order #${r.order.orderNumber}</b>`, new Date(r.order.createdAt).toLocaleString())}${row(ORDER_TYPE_LABEL[r.order.type] ?? r.order.type, r.order.tableLabel ? `Table ${esc(r.order.tableLabel)}` : '')}
${r.order.takenBy ? row(`Taken by ${esc(r.order.takenBy)}`, '') : ''}${r.order.cashiers.length ? row(`Cashier ${esc(r.order.cashiers.join(', '))}`, '') : ''}
${r.order.customer?.name || r.order.customer?.phone ? row(esc([r.order.customer?.name, r.order.customer?.phone].filter(Boolean).join(' · ')), '') : ''}${r.order.delivery?.address ? row(`Deliver to: ${esc(r.order.delivery.address)}`, '') : ''}</table><hr>
<table>${items}</table><hr><table>
${row('Subtotal', m(t.subtotal))}${t.lineDiscount ? row('Item discounts', `−${m(t.lineDiscount)}`) : ''}${t.couponDiscount ? row(`Coupon ${esc(t.couponCode ?? '')}`, `−${m(t.couponDiscount)}`) : ''}
${t.manualDiscount ? row(`Discount${t.manualDiscountReason ? ` (${esc(t.manualDiscountReason)})` : ''}`, `−${m(t.manualDiscount)}`) : ''}${t.serviceCharge ? row('Service charge', m(t.serviceCharge)) : ''}${t.deliveryFee ? row('Delivery fee', m(t.deliveryFee)) : ''}
${taxRows}</table><hr><table>
${r.payments.map((p: any) => row(`Paid · ${esc(p.method.replace('_', ' '))}${p.label ? ` · ${esc(p.label)}` : ''}`, m(p.amount))).join('')}${r.refunds.map((p: any) => row(`Refund · ${esc(p.method.replace('_', ' '))}`, `−${m(p.amount)}`)).join('')}
${row('<b>Total paid</b>', `<b>${m(t.paid)}</b>`)}${t.refunded ? row('Refunded', `−${m(t.refunded)}`) : ''}${row(`<b>${t.balance > 0 ? 'Balance due' : 'Balance'}</b>`, `<b>${m(t.balance)}</b>`)}</table><hr>
<div class="c s">${esc(r.restaurant.footer || 'Thank you!')}</div></body></html>`;
}

/** Prints through a hidden iframe so the dashboard page itself is never replaced. */
export function printHtml(html: string) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  const go = () => {
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 1000);
  };
  const img = doc.querySelector('img');
  if (img && !img.complete) img.onload = img.onerror = go;
  else setTimeout(go, 50);
}

export function ReceiptActions({ orderId, compact = false }: { orderId: string; compact?: boolean }) {
  const fb = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const [width, setWidth] = useState<'58' | '80' | 'a4'>(() => (localStorage.getItem('receipt:width') as any) || '80');
  const choose = (w: '58' | '80' | 'a4') => {
    setWidth(w);
    try { localStorage.setItem('receipt:width', w); } catch { /* storage unavailable */ }
  };
  const print = async () => {
    setBusy('print');
    try {
      printHtml(receiptHtml(await api.get(`/api/staff/orders/${orderId}/receipt`), width));
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };
  const pdf = async () => {
    setBusy('pdf');
    try {
      const url = await api.blobUrl(`/api/staff/orders/${orderId}/receipt?format=pdf&width=${width}`);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className="input h-9 w-auto py-0 text-sm" value={width} onChange={(e) => choose(e.target.value as any)} aria-label="Receipt paper">
        <option value="80">80 mm</option>
        <option value="58">58 mm</option>
        <option value="a4">A4</option>
      </select>
      <Button size="sm" variant="outline" loading={busy === 'print'} onClick={print}><Printer className="h-4 w-4" /> {compact ? 'Print' : 'Print receipt'}</Button>
      <Button size="sm" variant="ghost" loading={busy === 'pdf'} onClick={pdf}><FileText className="h-4 w-4" /> PDF</Button>
    </div>
  );
}

/**
 * Receipt data for an order saved on this device (offline). Same layout as server receipts, with a clear notice
 * and each payment marked as recorded locally or confirmed. Amounts are the device's estimate until synced.
 */
export function localReceiptData(o: any, tenant: any) {
  const st = tenant?.settings ?? {};
  const paid = o.payments.reduce((t: number, p: any) => t + p.amount, 0);
  const confirmed = o.syncState === 'confirmed';
  return {
    notice: confirmed ? `Confirmed by server as order #${o.serverOrderNumber}` : 'RECORDED OFFLINE · NOT YET CONFIRMED BY THE SERVER · amounts are this device’s estimate',
    restaurant: { name: tenant?.name ?? '', logoUrl: tenant?.branding?.logoUrl, address: '', phone: '', taxRegistrationNumber: st.taxRegistrationNumber || undefined, footer: st.receiptFooter || undefined },
    currency: o.currency, currencyDecimals: st.currencyDecimals ?? 2,
    order: { orderNumber: confirmed ? o.serverOrderNumber : o.localNumber, createdAt: o.createdAt, type: o.type, tableLabel: o.tableLabel, customer: o.customer, delivery: o.delivery, takenBy: o.createdBy, cashiers: [...new Set(o.payments.map((p: any) => p.by))] },
    items: o.items.map((i: any) => ({ name: i.name, variantName: i.variantName, addons: i.addons.map((a: any) => a.name), quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal, discount: i.discount })),
    totals: { ...o.totals, couponDiscount: 0, manualDiscountReason: o.manualDiscount?.reason, paid, refunded: 0, balance: Math.max(0, o.totals.total - paid) },
    tax: { label: st.taxLabel || 'Tax', ratePercent: st.taxRatePercent ?? 0, inclusive: !!st.taxInclusive, taxable: o.totals.total - o.totals.tax },
    payments: o.payments.map((p: any) => ({ method: 'cash', amount: p.amount, at: p.at, by: p.by, label: p.status === 'confirmed' ? 'confirmed' : 'recorded on this device' })),
    refunds: [],
  };
}
