import { useState } from 'react';
import { BellRing, Check, HandPlatter, Plus, Sparkles, Receipt } from 'lucide-react';
import { api, qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useSocket, beep } from '../../hooks/useSocket';
import { useAuth } from '../../store/auth';
import { Badge, Button, Card, Empty, Loading, PageHeader, StatusBadge, Tabs, useFeedback } from '../../components/ui';
import { OrderDrawer } from '../../components/OrderDrawer';
import { NewOrderModal } from '../../components/NewOrderModal';
import { cn, formatMoney, timeAgo, fulfilmentLabel } from '../../lib/util';
import { ConciergeBell as HeaderIcon } from 'lucide-react';

export default function Waiter() {
  const fb = useFeedback();
  const { user, tenant, can } = useAuth();
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals);
  const [tab, setTab] = useState('ready');
  const [open, setOpen] = useState<string | null>(null);
  const [newFor, setNewFor] = useState<string | null>(null);
  const orders = useApi<any>(`/api/staff/orders${qs({ status: 'pending,accepted,preparing,partially_ready,ready,delivered', limit: 200, mine: 'true' })}`);
  const tables = useApi<{ items: any[] }>('/api/staff/tables');
  useSocket({
    'order:new': () => { beep(); orders.reload(); },
    'order:updated': () => { orders.reload(); tables.reload(); },
    'order:ready': (o) => { beep(1046, 300); fb.info(`Order #${o.orderNumber} is ready${o.tableLabel ? ` for table ${o.tableLabel}` : ''}`); },
    reconnect: () => { orders.reload(); tables.reload(); },
  });

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      fb.ok(ok);
      orders.reload();
      tables.reload();
    } catch (e) {
      fb.fail(e);
    }
  };

  if ((orders.loading && !orders.data) || (tables.loading && !tables.data)) return <Loading />;
  const all: any[] = orders.data?.items ?? [];
  const myTables = new Set((user?.assignedTableIds ?? []).map(String));
  const buckets: Record<string, any[]> = {
    ready: all.filter((o) => o.status === 'ready'),
    new: all.filter((o) => o.status === 'pending'),
    kitchen: all.filter((o) => ['accepted', 'preparing', 'partially_ready'].includes(o.status)),
    served: all.filter((o) => o.status === 'delivered'),
  };
  const list = buckets[tab];

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="blue" title="Floor" subtitle={myTables.size ? `${myTables.size} tables assigned to you` : 'All tables'} actions={can('orders:accept') && <Button onClick={() => setNewFor('')}><Plus className="h-4 w-4" /> Take order</Button>} />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px] [&>*]:min-w-0">
        <div>
          <div className="mb-4"><Tabs value={tab} onChange={setTab} items={[{ value: 'ready', label: 'Ready to serve', count: buckets.ready.length }, { value: 'new', label: 'New', count: buckets.new.length }, { value: 'kitchen', label: 'In kitchen', count: buckets.kitchen.length }, { value: 'served', label: 'Served', count: buckets.served.length }]} /></div>
          {list.length === 0 ? <Card><Empty title="Nothing here right now" icon={<Sparkles className="h-6 w-6" />} /></Card> : (
            <div className="grid gap-3 sm:grid-cols-2">
              {list.map((o) => (
                <Card key={o._id} className={cn(o.status === 'ready' && 'ring-2 ring-emerald-400')}>
                  <button className="w-full text-start" onClick={() => setOpen(o._id)}>
                    <div className="flex items-center justify-between">
                      <span className="font-display text-xl font-semibold">#{o.orderNumber}</span>
                      <span className="text-xs text-stone-400">{timeAgo(o.createdAt)} ago</span>
                    </div>
                    <p className="text-sm text-stone-500">{o.tableLabel ? `Table ${o.tableLabel}` : o.type.replace('_', ' ')} · {money(o.total)}</p>
                    <ul className="mt-2 text-sm">{o.items.map((i: any) => <li key={i._id} className={cn(i.status === 'served' && 'text-stone-400 line-through')}>{i.quantity}× {i.name} {i.status === 'ready' && <Badge tone="good">ready</Badge>}</li>)}</ul>
                  </button>
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-stone-100 pt-3">
                    <StatusBadge status={o.paymentStatus} />
                    <div className="ms-auto flex gap-2">
                      {o.status === 'pending' && can('orders:accept') && <Button size="sm" onClick={() => act(() => api.post(`/api/staff/orders/${o._id}/status`, { status: 'accepted' }), 'Sent to kitchen')}><Check className="h-4 w-4" /> Accept</Button>}
                      {!o.assignedWaiterId && o.status !== 'delivered' && <Button size="sm" variant="outline" onClick={() => act(() => api.post(`/api/staff/orders/${o._id}/assign`, { waiterId: user!.id }), 'Assigned to you')}><HandPlatter className="h-4 w-4" /> Claim</Button>}
                      {o.status === 'ready' && <Button size="sm" onClick={() => act(() => api.post(`/api/staff/orders/${o._id}/status`, { status: 'delivered' }), 'Marked served')}><BellRing className="h-4 w-4" /> {fulfilmentLabel(o.type)}</Button>}
                      {o.status === 'delivered' && <Button size="sm" variant="outline" onClick={() => act(() => api.post(`/api/staff/orders/${o._id}/status`, { status: 'completed' }), 'Order closed')}>Close</Button>}
                      {!o.billRequestedAt && o.status !== 'pending' && <Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/api/staff/orders/${o._id}/request-bill`), 'Cashier notified')}><Receipt className="h-4 w-4" /> Bill</Button>}
                      {o.billRequestedAt && <span className="self-center text-xs text-amber-700">Bill requested</span>}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
        <Card title="Tables">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-3">
            {tables.data!.items.filter((t) => t.isActive).map((t) => (
              <button
                key={t._id}
                onClick={() => (t.status === 'cleaning' ? act(() => api.patch(`/api/staff/tables/${t._id}`, { status: 'available' }), `${t.label} is ready for guests`) : can('orders:accept') && setNewFor(t._id))}
                className={cn('rounded-xl border p-3 text-start transition hover:shadow-card', myTables.has(t._id) && 'ring-2 ring-brand/40', { available: 'border-emerald-200 bg-emerald-50', occupied: 'border-brand/30 bg-brand/5', reserved: 'border-sky-200 bg-sky-50', cleaning: 'border-amber-200 bg-amber-50' }[t.status as string])}
                title={t.status === 'cleaning' ? 'Tap when cleaned' : 'Tap to take an order'}
              >
                <p className="font-display text-lg font-semibold">{t.label}</p>
                <p className="text-[11px] capitalize text-stone-500">{t.status}</p>
                {t.amountDue > 0 && <p className="mt-1 text-[11px] font-medium">{money(t.amountDue)} due</p>}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-stone-500">Tap a cleaning table once it's ready. Tap any other table to take an order for it.</p>
        </Card>
      </div>
      <OrderDrawer orderId={open} onClose={() => setOpen(null)} onChanged={() => { orders.reload(); tables.reload(); }} />
      <NewOrderModal open={newFor !== null} presetTableId={newFor || undefined} onClose={() => setNewFor(null)} onCreated={() => { setNewFor(null); orders.reload(); tables.reload(); }} />
    </>
  );
}
