import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LayoutGrid, List, Plus, Search } from 'lucide-react';
import { qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useSocket, beep } from '../../hooks/useSocket';
import { useAuth } from '../../store/auth';
import { Badge, Button, Card, DataTable, Empty, ErrorState, Input, Loading, PageHeader, Pagination, StatusBadge, Tabs } from '../../components/ui';
import { OrderDrawer } from '../../components/OrderDrawer';
import { NewOrderModal } from '../../components/NewOrderModal';
import { cn, formatMoney, timeAgo } from '../../lib/util';
import { ClipboardList as HeaderIcon } from 'lucide-react';

const BOARD = [
  { key: 'pending', label: 'New' },
  { key: 'accepted,preparing,partially_ready', label: 'In kitchen' },
  { key: 'ready', label: 'Ready' },
  { key: 'delivered', label: 'Served' },
];

export default function Orders() {
  const { id } = useParams();
  const nav = useNavigate();
  const { tenant, can } = useAuth();
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [tab, setTab] = useState('all');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [creating, setCreating] = useState(false);
  const [board, setBoard] = useState<any[]>([]);

  const active = useApi<any>(view === 'board' ? `/api/staff/orders${qs({ status: 'pending,accepted,preparing,partially_ready,ready,delivered', limit: 200 })}` : null, [view]);
  useEffect(() => {
    if (active.data) setBoard(active.data.items);
  }, [active.data]);
  const statusFilter = { all: '', open: 'pending,accepted,preparing,partially_ready,ready,delivered', completed: 'completed', cancelled: 'cancelled,rejected,refunded' }[tab];
  const list = useApi<any>(view === 'list' ? `/api/staff/orders${qs({ page, q, status: statusFilter, from, to })}` : null, [view]);

  useSocket({
    'order:new': (o) => {
      beep();
      setBoard((p) => [o, ...p.filter((x) => x._id !== o._id)]);
      if (view === 'list') list.reload();
    },
    'order:updated': (o) => {
      setBoard((p) => {
        const open = ['pending', 'accepted', 'preparing', 'partially_ready', 'ready', 'delivered'].includes(o.status);
        const rest = p.filter((x) => x._id !== o._id);
        return open ? [o, ...rest] : rest;
      });
      if (view === 'list') list.reload();
    },
    // Re-sync after a dropped connection: events sent while offline were missed.
    reconnect: () => (view === 'list' ? list.reload() : active.reload()),
  });

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="blue"
        title="Orders"
        subtitle="Live — new orders appear instantly"
        actions={
          <>
            <div className="flex rounded-lg border border-stone-200 bg-white p-0.5">
              <Button size="sm" variant={view === 'board' ? 'secondary' : 'ghost'} onClick={() => setView('board')}><LayoutGrid className="h-4 w-4" /> Board</Button>
              <Button size="sm" variant={view === 'list' ? 'secondary' : 'ghost'} onClick={() => setView('list')}><List className="h-4 w-4" /> History</Button>
            </div>
            {can('orders:accept') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New order</Button>}
          </>
        }
      />

      {view === 'board' ? (
        active.loading && !active.data ? <Loading /> : active.error ? <ErrorState message={active.error} onRetry={active.reload} /> : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {BOARD.map((col) => {
              const items = board.filter((o) => col.key.split(',').includes(o.status)).sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
              return (
                <section key={col.key} className="rounded-2xl bg-stone-100/70 p-3">
                  <header className="mb-3 flex items-center justify-between px-1">
                    <h2 className="text-sm font-semibold text-stone-700">{col.label}</h2>
                    <Badge>{items.length}</Badge>
                  </header>
                  <div className="space-y-2.5">
                    {items.length === 0 && <p className="py-6 text-center text-xs text-stone-400">Nothing here</p>}
                    {items.map((o) => (
                      <button key={o._id} onClick={() => nav(`/dashboard/orders/${o._id}`)} className={cn('card w-full animate-fade-up p-3.5 text-start transition hover:shadow-lift', o.status === 'pending' && 'ring-2 ring-brand/50')}>
                        <div className="flex items-center justify-between">
                          <span className="font-display text-lg font-semibold">#{o.orderNumber}</span>
                          <span className="text-xs text-stone-400">{timeAgo(o.createdAt)}</span>
                        </div>
                        <p className="text-xs text-stone-500">{o.tableLabel ? `Table ${o.tableLabel}` : o.type.replace('_', ' ')}{o.customer?.name ? ` · ${o.customer.name}` : ''}</p>
                        <ul className="mt-2 space-y-0.5 text-sm text-stone-700">
                          {o.items.slice(0, 4).map((i: any) => <li key={i._id} className="truncate">{i.quantity}× {i.name}</li>)}
                          {o.items.length > 4 && <li className="text-xs text-stone-400">+{o.items.length - 4} more</li>}
                        </ul>
                        <div className="mt-3 flex items-center justify-between">
                          <StatusBadge status={o.paymentStatus} />
                          <span className="text-sm font-semibold tabular-nums">{money(o.total)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )
      ) : (
        <Card pad={false}>
          <div className="flex flex-wrap items-center gap-3 border-b border-stone-100 p-4">
            <Tabs value={tab} onChange={(v) => { setTab(v); setPage(1); }} items={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' }]} />
            <div className="relative ms-auto w-56">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
              <Input className="ps-9" placeholder="# / phone / table" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            </div>
            <Input type="date" className="w-auto" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} aria-label="From" />
            <Input type="date" className="w-auto" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} aria-label="To" />
          </div>
          {list.loading && !list.data ? <Loading /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : (
            <>
              <DataTable
                rows={list.data?.items ?? []}
                onRowClick={(o: any) => nav(`/dashboard/orders/${o._id}`)}
                empty={<Empty title="No orders match" />}
                columns={[
                  { key: 'n', header: 'Order', render: (o: any) => <span className="font-semibold">#{o.orderNumber}</span> },
                  { key: 'd', header: 'Placed', render: (o: any) => new Date(o.createdAt).toLocaleString() },
                  { key: 't', header: 'Table / type', render: (o: any) => o.tableLabel ?? o.type.replace('_', ' ') },
                  { key: 's', header: 'Status', render: (o: any) => <StatusBadge status={o.status} /> },
                  { key: 'p', header: 'Payment', render: (o: any) => <StatusBadge status={o.paymentStatus} /> },
                  { key: 'tot', header: 'Total', className: 'text-end', render: (o: any) => <span className="tabular-nums">{money(o.total)}</span> },
                ]}
              />
              <Pagination page={page} limit={list.data?.limit ?? 25} total={list.data?.total ?? 0} onPage={setPage} />
            </>
          )}
        </Card>
      )}

      <OrderDrawer orderId={id ?? null} onClose={() => nav('/dashboard/orders')} onChanged={() => (view === 'list' ? list.reload() : active.reload())} />
      <NewOrderModal open={creating} onClose={() => setCreating(false)} onCreated={(o) => { setCreating(false); nav(`/dashboard/orders/${o._id}`); }} />
    </>
  );
}
