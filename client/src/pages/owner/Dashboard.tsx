import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, BarChart3, Bike, Boxes, CalendarClock, ChefHat, ClipboardList, Megaphone, MonitorSmartphone, Receipt, Sparkles, TrendingUp, UtensilsCrossed, Wallet,
} from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { useSocket } from '../../hooks/useSocket';
import { useAuth } from '../../store/auth';
import { Card, ErrorState, IconTile, Loading, NavCard, PageHeader, SectionHeader, Stat, StatusBadge, type Accent } from '../../components/ui';
import { BarChart, RankBars } from '../../components/Chart';
import { OrderDrawer } from '../../components/OrderDrawer';
import { cn, formatMoney, timeAgo } from '../../lib/util';

const PIPELINE: { key: string; label: string; accent: Accent }[] = [
  { key: 'pending', label: 'Awaiting acceptance', accent: 'amber' },
  { key: 'accepted', label: 'Accepted', accent: 'blue' },
  { key: 'preparing', label: 'Preparing', accent: 'blue' },
  { key: 'partially_ready', label: 'Partly ready', accent: 'violet' },
  { key: 'ready', label: 'Ready', accent: 'emerald' },
  { key: 'delivered', label: 'Served / dispatched', accent: 'neutral' },
];
const BAR: Record<Accent, string> = { brand: 'bg-brand', blue: 'bg-blue-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500', violet: 'bg-violet-500', neutral: 'bg-stone-400' };

export default function OwnerDashboard() {
  const { tenant, user, can, hasFeature } = useAuth();
  const { data, loading, error, reload } = useApi<any>('/api/staff/analytics/dashboard');
  // Week view (top dishes, trend) only for people who may see analytics.
  const week = useApi<any>(can('analytics:view') ? '/api/staff/analytics/summary?period=week' : null);
  const [open, setOpen] = useState<string | null>(null);
  useSocket({ 'order:new': () => reload(), 'order:updated': () => reload(), reconnect: () => reload() });
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const d = data!;
  const active = Object.values(d.activeOrders as Record<string, number>).reduce((a, b) => a + b, 0);
  const tableTotal = Object.values(d.tables as Record<string, number>).reduce((a, b) => a + b, 0);
  const hour = new Date().getHours();

  const modules = [
    can('orders:create') && { to: '/dashboard/pos', icon: MonitorSmartphone, title: 'Point of sale', description: 'Take counter, phone and table orders and collect payment.', accent: 'brand' as Accent },
    can('orders:view') && { to: '/dashboard/orders', icon: ClipboardList, title: 'Orders', description: 'Accept, track, serve and close every order.', accent: 'blue' as Accent, meta: `${active} active now` },
    can('kitchen:operate') && hasFeature('kds') && { to: '/dashboard/kitchen', icon: ChefHat, title: 'Kitchen display', description: 'Live tickets by station, start and mark items ready.', accent: 'amber' as Accent, meta: `${(d.activeOrders.accepted ?? 0) + (d.activeOrders.preparing ?? 0)} in the kitchen` },
    can('menu:manage') && { to: '/dashboard/menu', icon: UtensilsCrossed, title: 'Menu', description: 'Dishes, prices, options, photos and availability.', accent: 'emerald' as Accent },
    can('inventory:view') && hasFeature('inventory') && { to: '/dashboard/inventory', icon: Boxes, title: 'Inventory', description: 'Stock levels, wastage, suppliers and purchase orders.', accent: d.lowStockItems ? 'rose' as Accent : 'neutral' as Accent, meta: d.lowStockItems ? `${d.lowStockItems} items low on stock` : 'Stock levels OK' },
    can('analytics:view') && { to: '/dashboard/analytics', icon: BarChart3, title: 'Analytics', description: 'Sales, collections, dishes, categories and exports.', accent: 'blue' as Accent },
    can('intelligence:view') && { to: '/dashboard/intelligence', icon: Sparkles, title: 'Intelligence', description: 'Profit, forecasts, recommendations and the assistant.', accent: 'violet' as Accent },
    can('marketing:manage') && { to: '/dashboard/marketing', icon: Megaphone, title: 'Marketing', description: 'Segments, approved campaigns and automations.', accent: 'rose' as Accent },
    can('delivery:dispatch', 'delivery:manage') && { to: '/dashboard/delivery', icon: Bike, title: 'Delivery', description: 'Dispatch board, riders, zones and delivery times.', accent: 'amber' as Accent },
  ].filter(Boolean) as any[];

  return (
    <>
      <PageHeader eyebrow={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} title={`Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${user?.name?.split(' ')[0]}`} subtitle={`Here is how ${tenant?.name} is doing today.`} />

      <div className="grid-stats">
        <Stat label="Net sales today" value={money(d.today.netSales)} sub={`${d.today.orders} orders · avg ${money(d.today.averageOrderValue)}`} icon={<TrendingUp />} accent="brand" />
        <Stat label="Collected (verified)" value={money(d.today.netCollections)} sub={`Pending ${money(d.today.pendingPayments)}`} icon={<Wallet />} accent="emerald" />
        <Stat label="Active orders" value={active} sub={`${d.activeOrders.pending ?? 0} awaiting acceptance`} icon={<ClipboardList />} accent={d.activeOrders.pending ? 'amber' : 'blue'} />
        <Stat label="Tables occupied" value={`${d.tables.occupied ?? 0} / ${tableTotal}`} sub={`${d.tables.cleaning ?? 0} need cleaning`} icon={<Receipt />} accent="blue" />
      </div>

      {(d.lowStockItems > 0 || d.upcomingReservations > 0 || (d.activeOrders.pending ?? 0) > 0) && (
        <div className="mt-grid-gap grid gap-3 md:grid-cols-3">
          {(d.activeOrders.pending ?? 0) > 0 && <Alert to="/dashboard/orders" accent="amber" icon={ClipboardList} text={`${d.activeOrders.pending} order${d.activeOrders.pending === 1 ? '' : 's'} waiting to be accepted`} />}
          {d.lowStockItems > 0 && <Alert to="/dashboard/inventory" accent="rose" icon={AlertTriangle} text={`${d.lowStockItems} inventory item${d.lowStockItems === 1 ? '' : 's'} low on stock`} />}
          {d.upcomingReservations > 0 && <Alert to="/dashboard/reservations" accent="blue" icon={CalendarClock} text={`${d.upcomingReservations} reservation${d.upcomingReservations === 1 ? '' : 's'} in the next 24 hours`} />}
        </div>
      )}

      <div className="mt-section grid gap-grid-gap xl:grid-cols-3">
        <Card title="Latest orders" subtitle="Live — updates as orders arrive" icon={ClipboardList} accent="blue" className="xl:col-span-2" pad={false} actions={<Link to="/dashboard/orders" className="text-sm font-medium text-brand hover:underline">All orders</Link>}>
          <ul className="divide-y divide-stone-100">
            {d.recentOrders.length === 0 && <li className="px-6 py-14 text-center text-sm text-stone-400">No orders yet today. Share your QR codes to start receiving orders.</li>}
            {d.recentOrders.map((o: any) => (
              <li key={o._id}>
                <button className="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 px-6 py-4 text-start transition hover:bg-stone-50/70 sm:flex-nowrap" onClick={() => setOpen(o._id)}>
                  <span className="w-16 font-display text-[15px] font-semibold">#{o.orderNumber}</span>
                  <span className="w-24 text-sm capitalize text-stone-500">{o.tableLabel ? `Table ${o.tableLabel}` : o.type.replace('_', ' ')}</span>
                  <StatusBadge status={o.status} type={o.type} />
                  <StatusBadge status={o.paymentStatus} />
                  <span className="ms-auto text-sm font-semibold tabular-nums">{money(o.total)}</span>
                  <span className="w-12 text-end text-xs text-stone-400">{timeAgo(o.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Kitchen & floor activity" subtitle={`${active} orders in progress`} icon={ChefHat} accent="amber">
          <ul className="space-y-4">
            {PIPELINE.map((p) => {
              const n = d.activeOrders[p.key] ?? 0;
              return (
                <li key={p.key}>
                  <div className="mb-1.5 flex items-center justify-between text-sm">
                    <span className="text-stone-700">{p.label}</span>
                    <span className="tabular font-semibold text-stone-900">{n}</span>
                  </div>
                  <div className="h-2 rounded-full bg-stone-100"><div className={cn('h-2 rounded-full', BAR[p.accent])} style={{ width: `${active ? Math.max(n ? 4 : 0, (n / active) * 100) : 0}%` }} /></div>
                </li>
              );
            })}
          </ul>
          <p className="mt-5 border-t border-stone-100 pt-4 text-[13px] text-stone-500">Tax collected today: <b className="font-semibold text-stone-800">{money(d.today.taxes)}</b></p>
        </Card>
      </div>

      {week.data && (
        <div className="mt-section grid gap-grid-gap lg:grid-cols-2">
          <Card title="Sales this week" subtitle="Net sales per day, last 7 days" icon={TrendingUp} accent="brand">
            <BarChart data={week.data.series.map((r: any) => ({ label: new Date(r.period).toLocaleDateString(undefined, { weekday: 'short' }), value: r.sales }))} format={money} label="Net sales" />
          </Card>
          <Card title="Popular dishes" subtitle="By revenue, last 7 days" icon={UtensilsCrossed} accent="emerald" actions={<Link to="/dashboard/analytics" className="text-sm font-medium text-brand hover:underline">Analytics</Link>}>
            <RankBars rows={week.data.products.slice(0, 6).map((p: any) => ({ label: p.name, value: p.revenue, sub: `×${p.quantity}` }))} format={money} accent="emerald" />
          </Card>
        </div>
      )}

      {modules.length > 0 && (
        <section className="mt-section">
          <SectionHeader title="Quick access" description="Everything your role can open, in one place." />
          <div className="grid-modules">
            {modules.map((m) => <NavCard key={m.to} {...m} />)}
          </div>
        </section>
      )}
      <OrderDrawer orderId={open} onClose={() => setOpen(null)} onChanged={reload} />
    </>
  );
}

function Alert({ to, accent, icon, text }: { to: string; accent: Accent; icon: any; text: string }) {
  return (
    <Link to={to} className="card card-hover focus-ring flex items-center gap-4 px-5 py-4">
      <IconTile icon={icon} accent={accent} size="sm" />
      <span className="text-sm font-medium text-stone-800">{text}</span>
    </Link>
  );
}
