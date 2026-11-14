import { useEffect, useState } from 'react';
import { ArrowRightLeft, Banknote, BellRing, CreditCard, Minus, Plus, PlusCircle, Undo2, UserCheck, X } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { useSocket } from '../hooks/useSocket';
import { Badge, Button, Drawer, Field, Loading, Select, StatusBadge, useFeedback } from './ui';
import { PaymentPanel } from './PaymentPanel';
import { ReceiptActions } from './Receipt';
import { NewOrderModal } from './NewOrderModal';
import { cn, formatMoney, fulfilmentLabel, ORDER_TYPE_LABEL, toMajor, toMinor } from '../lib/util';

const NEXT: Record<string, { to: string; label: string; perm: string; variant?: 'primary' | 'outline' | 'danger' }[]> = {
  pending: [{ to: 'accepted', label: 'Confirm', perm: 'orders:accept' }, { to: 'rejected', label: 'Reject', perm: 'orders:accept', variant: 'danger' }],
  accepted: [{ to: 'preparing', label: 'Start preparing', perm: 'kitchen:operate' }, { to: 'cancelled', label: 'Cancel', perm: 'orders:manage', variant: 'danger' }],
  preparing: [{ to: 'ready', label: 'Mark all ready', perm: 'kitchen:operate' }, { to: 'cancelled', label: 'Cancel', perm: 'orders:manage', variant: 'danger' }],
  partially_ready: [{ to: 'ready', label: 'Mark all ready', perm: 'kitchen:operate' }, { to: 'cancelled', label: 'Cancel', perm: 'orders:manage', variant: 'danger' }],
  ready: [{ to: 'delivered', label: 'Mark served', perm: 'orders:deliver' }, { to: 'cancelled', label: 'Cancel', perm: 'orders:manage', variant: 'danger' }],
  delivered: [{ to: 'completed', label: 'Complete & close', perm: 'orders:deliver' }],
  completed: [],
  cancelled: [],
  rejected: [],
  refunded: [],
};
const OPEN = ['pending', 'accepted', 'preparing', 'partially_ready', 'ready', 'delivered'];
const MODIFIABLE = ['pending', 'accepted', 'preparing', 'partially_ready', 'ready'];

export function OrderDrawer({ orderId, onClose, onChanged }: { orderId: string | null; onClose: () => void; onChanged?: () => void }) {
  const { can, tenant } = useAuth();
  const fb = useFeedback();
  const cur = tenant?.settings?.currency ?? 'PKR';
  const dec = tenant?.settings?.currencyDecimals ?? 2;
  const money = (n: number) => formatMoney(n, cur, dec);
  const [data, setData] = useState<{ order: any; payments: any[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [waiters, setWaiters] = useState<any[]>([]);
  const [tables, setTables] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    if (!orderId) return;
    setData(await api.get(`/api/staff/orders/${orderId}`));
  };
  useEffect(() => {
    setData(null);
    load().catch(fb.fail);
    if (orderId && can('orders:manage') && can('staff:view', 'staff:manage')) api.get('/api/staff/staff?role=waiter').then((r) => setWaiters(r.items)).catch(() => undefined);
    if (orderId && can('orders:transfer')) api.get('/api/staff/tables').then((r) => setTables(r.items.filter((t: any) => t.isActive))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);
  // Kitchen progress and other cashiers' payments appear without reopening the panel.
  useSocket({ 'order:updated': (o) => { if (o._id === orderId) load().catch(() => undefined); } }, { enabled: !!orderId });

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      fb.ok(ok);
      await load();
      onChanged?.();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };

  const transition = async (to: string) => {
    let reason: string | undefined;
    if (to === 'rejected' || to === 'cancelled') {
      const r = await fb.confirm({ title: to === 'rejected' ? 'Reject this order?' : 'Cancel this order?', body: 'Stock and coupon usage are restored automatically. Paid orders must be refunded first.', danger: true, input: { label: 'Reason (shown to staff)', required: true }, confirmLabel: to === 'rejected' ? 'Reject' : 'Cancel order' });
      if (typeof r !== 'string') return;
      reason = r;
    }
    run(to, () => api.post(`/api/staff/orders/${orderId}/status`, { status: to, reason }), 'Order updated');
  };

  const refund = async (p: any) => {
    const r = await fb.confirm({ title: `Refund ${money(p.amount)} payment`, body: 'Enter the reason. You can refund part of the amount on the next step.', input: { label: 'Reason', required: true }, confirmLabel: 'Continue' });
    if (typeof r !== 'string') return;
    const amt = await fb.confirm({ title: 'Refund amount', input: { label: `Amount (max ${toMajor(p.amount, dec)})`, required: true }, confirmLabel: 'Refund', danger: true });
    if (typeof amt !== 'string') return;
    run('refund', () => api.post(`/api/staff/orders/payments/${p._id}/refund`, { amount: toMinor(amt, dec), reason: r }), 'Refund recorded');
  };

  const cancelItem = async (i: any) => {
    const r = await fb.confirm({ title: `Remove ${i.quantity}× ${i.name}?`, body: i.status === 'preparing' ? 'The kitchen has started this item.' : 'The bill is recalculated by the server.', danger: true, input: { label: 'Reason', required: true }, confirmLabel: 'Remove item' });
    if (typeof r !== 'string') return;
    run(`c${i._id}`, () => api.post(`/api/staff/orders/${orderId}/items/${i._id}/cancel`, { reason: r }), 'Item removed');
  };
  const setQty = (i: any, quantity: number) => run(`q${i._id}`, () => api.patch(`/api/staff/orders/${orderId}/items/${i._id}`, { quantity }), 'Quantity updated');

  const o = data?.order;
  const due = o ? Math.max(0, o.total - o.amountPaid) : 0;
  const modifiable = o && MODIFIABLE.includes(o.status) && can('orders:modify');

  return (
    <Drawer
      open={!!orderId}
      onClose={onClose}
      title={o ? `Order #${o.orderNumber}` : 'Order'}
      footer={
        o && (
          <div className="flex flex-wrap items-center gap-2">
            {(NEXT[o.status] ?? []).filter((n) => can(n.perm)).map((n) => (
              <Button key={n.to} variant={n.variant ?? 'primary'} loading={busy === n.to} onClick={() => transition(n.to)}>
                {n.to === 'delivered' ? `Mark ${fulfilmentLabel(o.type).toLowerCase()}` : n.label}
              </Button>
            ))}
            <div className="ms-auto"><ReceiptActions orderId={o._id} compact /></div>
          </div>
        )
      }
    >
      {!o ? (
        <Loading />
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={o.status} type={o.type} />
            <StatusBadge status={o.paymentStatus} />
            <Badge>{ORDER_TYPE_LABEL[o.type] ?? o.type}</Badge>
            {o.tableLabel && <Badge tone="brand">Table {o.tableLabel}</Badge>}
            {o.billRequestedAt && OPEN.includes(o.status) && <Badge tone="warn">Bill requested</Badge>}
            <span className="ms-auto text-xs text-stone-400">{new Date(o.createdAt).toLocaleString()}</span>
          </div>
          {(o.customer?.name || o.customer?.phone) && (
            <p className="text-sm text-stone-600">
              {o.customer?.name} {o.customer?.phone && <a href={`tel:${o.customer.phone}`} className="text-brand">{o.customer.phone}</a>}
            </p>
          )}
          {o.delivery?.address && <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">Deliver to: {o.delivery.address}{o.delivery.notes ? ` · ${o.delivery.notes}` : ''}</p>}
          {o.estimatedReadyAt && OPEN.includes(o.status) && o.status !== 'delivered' && <p className="text-xs text-stone-500">Estimated ready {new Date(o.estimatedReadyAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (from the dishes’ preparation times)</p>}
          {o.notes && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">“{o.notes}”</p>}
          {o.rejectionReason && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">Reason: {o.rejectionReason}</p>}

          <div className="flex flex-wrap gap-2">
            {modifiable && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><PlusCircle className="h-4 w-4" /> Add items</Button>}
            {OPEN.includes(o.status) && !o.billRequestedAt && <Button size="sm" variant="outline" loading={busy === 'bill'} onClick={() => run('bill', () => api.post(`/api/staff/orders/${orderId}/request-bill`), 'Cashier notified')}><BellRing className="h-4 w-4" /> Request bill</Button>}
            {o.type === 'dine_in' && OPEN.includes(o.status) && tables.length > 0 && (
              <label className="flex items-center gap-1.5 text-sm">
                <ArrowRightLeft className="h-4 w-4 text-stone-400" />
                <Select className="h-9 w-auto py-0" value="" onChange={(e) => e.target.value && run('transfer', () => api.post(`/api/staff/orders/${orderId}/transfer`, { tableId: e.target.value }), 'Order moved')} aria-label="Move to table">
                  <option value="">Move to table…</option>
                  {tables.filter((t) => t._id !== o.tableId).map((t) => <option key={t._id} value={t._id}>{t.label}{t.openOrders ? ` (${t.openOrders} open)` : ''}</option>)}
                </Select>
              </label>
            )}
          </div>

          <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200">
            {o.items.map((i: any) => (
              <li key={i._id} className={cn('flex gap-3 px-4 py-3', i.status === 'cancelled' && 'opacity-50')}>
                <span className="font-semibold tabular-nums">{i.quantity}×</span>
                <div className="min-w-0 flex-1">
                  <p className={cn('font-medium', i.status === 'cancelled' && 'line-through')}>{i.name}{i.variantName && <span className="text-stone-500"> · {i.variantName}</span>}</p>
                  {i.addons?.length > 0 && <p className="text-xs text-stone-500">+ {i.addons.map((a: any) => a.name).join(', ')}</p>}
                  {i.notes && <p className="text-xs italic text-amber-700">{i.notes}</p>}
                  {i.discount > 0 && <p className="text-xs text-emerald-700">Discount −{money(i.discount)}{i.discountReason ? ` · ${i.discountReason}` : ''}</p>}
                  {i.status === 'cancelled' && i.cancelReason && <p className="text-xs text-red-600">Removed by {i.cancelledBy}: {i.cancelReason}</p>}
                  {modifiable && i.status === 'queued' && (
                    <div className="mt-1.5 flex items-center gap-1">
                      <Button size="icon" variant="ghost" disabled={i.quantity <= 1} loading={busy === `q${i._id}`} onClick={() => setQty(i, i.quantity - 1)} aria-label="Decrease"><Minus className="h-3.5 w-3.5" /></Button>
                      <Button size="icon" variant="ghost" loading={busy === `q${i._id}`} onClick={() => setQty(i, i.quantity + 1)} aria-label="Increase"><Plus className="h-3.5 w-3.5" /></Button>
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <p className="text-sm tabular-nums">{money(i.lineTotal)}</p>
                  <StatusBadge status={i.status} />
                  {modifiable && (i.status === 'queued' || (i.status === 'preparing' && can('orders:manage'))) && (
                    <button className="text-xs text-red-600 hover:underline" onClick={() => cancelItem(i)} disabled={busy === `c${i._id}`}><X className="me-0.5 inline h-3 w-3" />Remove</button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <dl className="space-y-1.5 text-sm">
            <Row k="Subtotal" v={money(o.subtotal)} />
            {o.lineDiscountTotal > 0 && <Row k="Item discounts" v={`− ${money(o.lineDiscountTotal)}`} />}
            {(o.couponDiscount > 0 || (o.couponCode && !o.couponDiscount && o.discount > 0)) && <Row k={`Coupon ${o.couponCode ?? ''}`} v={`− ${money(o.couponDiscount || o.discount)}`} />}
            {o.manualDiscount?.amount > 0 && <Row k={`Discount${o.manualDiscount.reason ? ` · ${o.manualDiscount.reason}` : ''} (${o.manualDiscount.by})`} v={`− ${money(o.manualDiscount.amount)}`} />}
            {o.serviceCharge > 0 && <Row k="Service charge" v={money(o.serviceCharge)} />}
            {o.deliveryFee > 0 && <Row k="Delivery fee" v={money(o.deliveryFee)} />}
            <Row k={`${tenant?.settings?.taxLabel || 'Tax'}${tenant?.settings?.taxInclusive ? ' (included)' : ''}`} v={money(o.tax)} />
            <Row k="Total" v={money(o.total)} strong />
            <Row k="Paid (verified)" v={money(o.amountPaid)} />
            {o.amountRefunded > 0 && <Row k="Refunded" v={`− ${money(o.amountRefunded)}`} />}
            <Row k="Balance due" v={money(due)} strong />
          </dl>

          {can('payments:collect') && due > 0 && !['rejected', 'refunded', 'cancelled'].includes(o.status) && <PaymentPanel order={o} payments={data!.payments} onPaid={() => { load(); onChanged?.(); }} />}

          {waiters.length > 0 && OPEN.includes(o.status) && (
            <Field label="Assigned waiter">
              <div className="flex gap-2">
                <Select value={o.assignedWaiterId ?? ''} onChange={(e) => run('assign', () => api.post(`/api/staff/orders/${orderId}/assign`, { waiterId: e.target.value || null }), 'Assignment updated')}>
                  <option value="">Unassigned</option>
                  {waiters.filter((w) => w.isActive).map((w) => <option key={w._id} value={w._id}>{w.name}</option>)}
                </Select>
                <UserCheck className="mt-2.5 h-4 w-4 text-stone-400" />
              </div>
            </Field>
          )}

          {data!.payments.length > 0 && (
            <div>
              <p className="label">Transactions</p>
              <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 text-sm">
                {data!.payments.map((p) => (
                  <li key={p._id} className="flex items-center gap-3 px-4 py-2.5">
                    {p.method === 'online' || p.method === 'card_terminal' ? <CreditCard className="h-4 w-4 text-stone-400" /> : <Banknote className="h-4 w-4 text-stone-400" />}
                    <div className="flex-1">
                      <p className="font-medium">{p.kind === 'refund' ? 'Refund' : p.method.replace('_', ' ')} · {money(p.amount)}{p.allocation?.mode === 'equal' && ` · share ${p.allocation.part}/${p.allocation.parts}`}{p.allocation?.mode === 'items' && ` · items${p.allocation.label ? ` (${p.allocation.label})` : ''}`}</p>
                      <p className="text-xs text-stone-400">{new Date(p.createdAt).toLocaleString()} {p.reason && `· ${p.reason}`}</p>
                    </div>
                    <StatusBadge status={p.status} />
                    {p.kind === 'charge' && p.status === 'verified' && can('payments:refund') && (
                      <Button variant="ghost" size="icon" onClick={() => refund(p)} aria-label="Refund" title="Refund">
                        <Undo2 className="h-4 w-4" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="label">History</p>
            <ol className="space-y-1 text-xs text-stone-500">
              {[
                ...o.statusHistory.map((h: any) => ({ at: h.at, text: <><span className="font-medium text-stone-700">{h.status === 'delivered' ? fulfilmentLabel(o.type) : h.status.replace('_', ' ')}</span> · {h.by}</> })),
                ...(o.modifications ?? []).map((m: any) => ({ at: m.at, text: <><span className="font-medium text-stone-700">{m.action.replace(/_/g, ' ')}</span>{m.detail?.name ? ` · ${m.detail.name}` : ''}{m.detail?.to ? ` → ${m.detail.to}` : ''}{m.detail?.reason ? ` · ${m.detail.reason}` : ''} · {m.by}</> })),
              ]
                .sort((a, b) => +new Date(a.at) - +new Date(b.at))
                .map((h, i) => <li key={i}>{new Date(h.at).toLocaleTimeString()} · {h.text}</li>)}
            </ol>
          </div>
        </div>
      )}
      <NewOrderModal open={adding} appendTo={o?._id} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); load(); onChanged?.(); }} />
    </Drawer>
  );
}

const Row = ({ k, v, strong }: { k: string; v: string; strong?: boolean }) => (
  <div className={cn('flex justify-between gap-3', strong && 'border-t border-stone-100 pt-1.5 font-semibold text-stone-900')}>
    <dt className={strong ? '' : 'text-stone-500'}>{k}</dt>
    <dd className="tabular-nums">{v}</dd>
  </div>
);
