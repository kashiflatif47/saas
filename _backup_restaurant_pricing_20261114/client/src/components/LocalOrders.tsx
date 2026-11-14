import { useEffect, useState } from 'react';
import { Banknote, CloudOff, CreditCard, Printer } from 'lucide-react';
import { useOffline } from '../offline/OfflineProvider';
import { useAuth } from '../store/auth';
import type { LocalOrder, OfflineOp } from '../offline/types';
import { isQuotaError } from '../offline/idbStore';
import { Badge, Button, Drawer, Field, Input, Select, useFeedback } from './ui';
import { localReceiptData, printHtml, receiptHtml } from './Receipt';
import { cn, formatMoney, ORDER_TYPE_LABEL, toMajor, toMinor } from '../lib/util';

export function orderSyncBadge(o: LocalOrder, op?: OfflineOp) {
  if (o.syncState === 'confirmed') return <Badge tone="good" dot>Confirmed · #{o.serverOrderNumber}</Badge>;
  if (o.syncState === 'attention' || op?.status === 'conflict' || op?.status === 'failed') return <Badge tone="bad" dot>Needs attention</Badge>;
  if (op?.status === 'syncing') return <Badge tone="info" dot>Syncing…</Badge>;
  return <Badge tone="warn" dot>Saved on this device · waiting to sync</Badge>;
}

/** Orders recorded on this device (offline or not yet confirmed), newest first. */
export function LocalOrdersDrawer({ open, onClose, onOpen }: { open: boolean; onClose: () => void; onOpen: (localId: string) => void }) {
  const { engine, version } = useOffline();
  const { tenant } = useAuth();
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals);
  const [orders, setOrders] = useState<LocalOrder[]>([]);
  const [ops, setOps] = useState<Map<string, OfflineOp>>(new Map());
  useEffect(() => {
    if (!open || !engine) return;
    Promise.all([engine.orders(), engine.ops()]).then(([o, p]) => {
      setOrders(o);
      setOps(new Map(p.map((x) => [x.id, x])));
    });
  }, [open, engine, version]);
  return (
    <Drawer open={open} onClose={onClose} title="Orders on this device">
      {orders.length === 0 ? <p className="text-sm text-stone-500">No orders recorded on this device.</p> : (
        <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200">
          {orders.map((o) => (
            <li key={o.localId}>
              <button type="button" onClick={() => onOpen(o.localId)} className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-start text-sm hover:bg-stone-50">
                <span className="font-mono font-semibold">{o.localNumber}</span>
                <span className="text-stone-500">{ORDER_TYPE_LABEL[o.type]}{o.tableLabel ? ` · Table ${o.tableLabel}` : ''}</span>
                <span className="ms-auto tabular-nums">{money(o.serverTotal ?? o.totals.total)}</span>
                <span className="w-full">{orderSyncBadge(o, ops.get(o.opId))}</span>
                <span className="text-xs text-stone-400">{new Date(o.createdAt).toLocaleString()} · {o.items.reduce((t, i) => t + i.quantity, 0)} item(s)</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-stone-500">Confirmed orders are also in Orders with their server number. Orders confirmed more than 7 days ago are removed from this device.</p>
    </Drawer>
  );
}

/** One order saved on this device: items, estimated totals, cash recorded locally, receipt. */
export function LocalOrderPanel({ localId, onClose }: { localId: string | null; onClose: () => void }) {
  const { engine, version } = useOffline();
  const { tenant, can } = useAuth();
  const fb = useFeedback();
  const dec = tenant?.settings?.currencyDecimals ?? 2;
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, dec);
  const [o, setO] = useState<LocalOrder | null>(null);
  const [op, setOp] = useState<OfflineOp | undefined>();
  const [amount, setAmount] = useState('');
  const [tendered, setTendered] = useState('');
  const [parts, setParts] = useState(1);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState<'58' | '80' | 'a4'>('80');

  useEffect(() => {
    if (!localId || !engine) return void setO(null);
    engine.order(localId).then(async (x) => {
      setO(x ?? null);
      setOp(x ? await engine.op(x.opId) : undefined);
    });
  }, [localId, engine, version]);

  const paid = o ? o.payments.reduce((t, p) => t + p.amount, 0) : 0;
  const due = o ? Math.max(0, o.totals.total - paid) : 0;
  useEffect(() => setAmount(toMajor(parts > 1 ? Math.ceil(due / parts) : due, dec)), [due, parts, dec]);

  const pay = async () => {
    if (!o || !engine) return;
    setBusy(true);
    try {
      await engine.recordCash({ localOrderId: o.localId }, toMinor(amount, dec));
      fb.ok('Cash recorded on this device. It will be confirmed when the order syncs.');
      setTendered('');
    } catch (e: any) {
      fb.fail(isQuotaError(e) ? new Error('This device is out of storage: the payment was NOT recorded. Free up space and try again.') : e);
    } finally {
      setBusy(false);
    }
  };
  const change = tendered ? toMinor(tendered, dec) - toMinor(amount, dec) : 0;

  return (
    <Drawer open={!!localId} onClose={onClose} title={o ? `Order ${o.localNumber}` : 'Order'} footer={o && (
      <div className="flex flex-wrap items-center gap-2">
        <Select className="h-9 w-auto py-0 text-sm" value={width} onChange={(e) => setWidth(e.target.value as any)} aria-label="Receipt paper"><option value="80">80 mm</option><option value="58">58 mm</option><option value="a4">A4</option></Select>
        <Button size="sm" variant="outline" onClick={() => printHtml(receiptHtml(localReceiptData(o, tenant), width))}><Printer className="h-4 w-4" /> Print receipt</Button>
      </div>
    )}>
      {!o ? null : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            {orderSyncBadge(o, op)}
            <Badge>{ORDER_TYPE_LABEL[o.type]}</Badge>
            {o.tableLabel && <Badge tone="brand">Table {o.tableLabel}</Badge>}
            <span className="ms-auto text-xs text-stone-400">{new Date(o.createdAt).toLocaleString()} · {o.createdBy}</span>
          </div>
          {o.syncState !== 'confirmed' && (
            <p className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><CloudOff className="mt-0.5 h-4 w-4 shrink-0" />Recorded on this device. Prices are the estimate from {new Date(o.pricesAsOf).toLocaleString()}; the server re-checks everything when it syncs and shows any difference in the Sync centre.</p>
          )}
          {op?.lastError && op.status !== 'synced' && op.status !== 'pending' && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{op.lastError.message}</p>}
          {o.serverTotal != null && o.serverTotal !== o.totals.total && <p className="rounded-lg bg-sky-50 p-3 text-sm text-sky-900">Server total: <b>{money(o.serverTotal)}</b> (this device estimated {money(o.totals.total)}). Collect or refund the difference from the order in Orders.</p>}
          <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 text-sm">
            {o.items.map((i, idx) => (
              <li key={idx} className="flex gap-3 px-4 py-2.5">
                <span className="font-semibold tabular-nums">{i.quantity}×</span>
                <div className="min-w-0 flex-1"><p className="font-medium">{i.name}{i.variantName && <span className="text-stone-500"> · {i.variantName}</span>}</p>{i.addons.length > 0 && <p className="text-xs text-stone-500">+ {i.addons.map((a) => a.name).join(', ')}</p>}{i.notes && <p className="text-xs italic text-amber-700">{i.notes}</p>}</div>
                <span className="tabular-nums">{money(i.lineTotal)}</span>
              </li>
            ))}
          </ul>
          <dl className="space-y-1 text-sm">
            {([['Subtotal', o.totals.subtotal], ['Discounts', -o.totals.discount], ['Service charge', o.totals.serviceCharge], ['Delivery fee', o.totals.deliveryFee], [tenant?.settings?.taxLabel || 'Tax', o.totals.tax]] as [string, number][]).filter(([, v]) => v !== 0).map(([k, v]) => (
              <div key={k} className="flex justify-between"><dt className="text-stone-500">{k}</dt><dd className="tabular-nums">{v < 0 ? `− ${money(-v)}` : money(v)}</dd></div>
            ))}
            <div className="flex justify-between border-t border-stone-100 pt-1.5 font-semibold"><dt>Total (estimate)</dt><dd className="tabular-nums">{money(o.totals.total)}</dd></div>
            <div className="flex justify-between"><dt className="text-stone-500">Cash recorded</dt><dd className="tabular-nums">{money(paid)}</dd></div>
            <div className="flex justify-between font-semibold"><dt>Balance</dt><dd className="tabular-nums">{money(due)}</dd></div>
          </dl>
          {o.payments.length > 0 && (
            <ul className="space-y-1 text-sm">
              {o.payments.map((p) => (
                <li key={p.opId} className="flex items-center gap-2"><Banknote className="h-4 w-4 text-stone-400" /><span className="tabular-nums">{money(p.amount)}</span><span className="text-xs text-stone-500">{p.by} · {new Date(p.at).toLocaleTimeString()}</span>
                  <Badge tone={p.status === 'confirmed' ? 'good' : p.status === 'attention' ? 'bad' : 'warn'} className="ms-auto">{p.status === 'confirmed' ? 'Confirmed by server' : p.status === 'attention' ? 'Needs attention' : 'Recorded on this device'}</Badge></li>
              ))}
            </ul>
          )}
          {can('payments:collect') && due > 0 && o.syncState !== 'confirmed' && (
            <div className="space-y-3 rounded-xl border border-stone-200 p-4">
              <p className="text-sm font-semibold">Record cash</p>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Split equally" className="w-28"><Select value={parts} onChange={(e) => setParts(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n === 1 ? 'No' : `${n} guests`}</option>)}</Select></Field>
                <Field label="Amount" className="w-32"><Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
                <Field label="Cash received" className="w-32"><Input type="number" step="0.01" min="0" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder="optional" /></Field>
                <Button loading={busy} disabled={toMinor(amount, dec) <= 0 || toMinor(amount, dec) > due} onClick={pay}><Banknote className="h-4 w-4" /> Record cash</Button>
              </div>
              {change > 0 && <p className="text-sm font-medium text-emerald-700">Change to give: {money(change)}</p>}
              <p className={cn('flex items-center gap-1.5 text-xs text-stone-500')}><CreditCard className="h-3.5 w-3.5" /> Card and online payments need a connection and are not available offline.</p>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
