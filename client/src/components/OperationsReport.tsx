import { qs } from '../api/client';
import { useApi } from '../hooks/useApi';
import { Card, ErrorState, Loading, Stat } from './ui';
import { BarChart, RankBars } from './Chart';

const dur = (secs: number | null | undefined) => (secs == null ? '—' : secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`);
const TYPE_LABEL: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', pickup: 'Pickup', delivery: 'Delivery' };
const SOURCE_LABEL: Record<string, string> = { staff: 'POS / staff', qr: 'QR at table', website: 'Website' };

/** POS & kitchen operations for a date range: persisted orders, payments, shifts and kitchen timestamps only. */
export function OperationsReport({ params, money }: { params: Record<string, string>; money: (n: number) => string }) {
  const { data, loading, error, reload } = useApi<any>(`/api/staff/analytics/operations${qs(params)}`);
  if (loading && !data) return <div className="mt-6"><Loading /></div>;
  if (error) return <div className="mt-6"><ErrorState message={error} onRetry={reload} /></div>;
  if (!data) return null;
  const k = data.kitchen;
  const discountRows: [string, number][] = [
    ['Item discounts', data.discounts.lines],
    ['Coupons', data.discounts.coupon],
    ['Manual order discounts', data.discounts.manual],
    ['All discounts', data.discounts.total],
    ['Refunds', data.refunds.amount],
  ];
  return (
    <>
      <h2 className="mb-3 mt-10 font-display text-xl font-semibold">POS operations</h2>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Sales by order type"><RankBars rows={data.byType.map((x: any) => ({ label: TYPE_LABEL[x.type] ?? x.type, value: x.sales, sub: `${x.orders} orders` }))} format={money} /></Card>
        <Card title="Sales by channel"><RankBars rows={data.bySource.map((x: any) => ({ label: SOURCE_LABEL[x.source] ?? x.source, value: x.sales, sub: `${x.orders} orders` }))} format={money} /></Card>
        <Card title="Payments by method">
          <RankBars rows={data.byMethod.map((m: any) => ({ label: m.method.replace('_', ' '), value: m.collected, sub: m.refunded ? `refunded ${money(m.refunded)}` : `${m.count} payments` }))} format={money} />
        </Card>
        <Card title="Discounts and refunds">
          <dl className="space-y-1.5 text-sm">
            {discountRows.map(([label, v]) => (
              <div key={label} className="flex justify-between"><dt className="text-stone-500">{label}</dt><dd className="tabular-nums">{money(v)}</dd></div>
            ))}
            <p className="pt-1 text-xs text-stone-500">{data.discounts.ordersWithDiscount} order(s) had a discount. Manual discounts record who gave them and why.</p>
          </dl>
        </Card>
      </div>

      <Card className="mt-6" title="Staff performance" pad={false}>
        {!data.cashiers.length ? <p className="p-6 text-sm text-stone-500">No staff transactions in this period.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                <tr><th className="px-4 py-2 text-start">Staff</th><th className="px-4 py-2 text-end">Orders taken</th><th className="px-4 py-2 text-end">Order value</th><th className="px-4 py-2 text-end">Collected</th><th className="px-4 py-2 text-end">Refunded</th></tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {data.cashiers.map((c: any) => (
                  <tr key={c.userId}>
                    <td className="px-4 py-2 font-medium">{c.name ?? '—'}<span className="ms-1 text-xs capitalize text-stone-400">{c.role?.replace('_', ' ')}</span></td>
                    <td className="px-4 py-2 text-end tabular-nums">{c.orders}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{money(c.sales)}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{money(c.collected)}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{money(c.refunded)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-6" title="Shift closings" pad={false}>
        {!data.shifts.length ? <p className="p-6 text-sm text-stone-500">No cash shifts in this period.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                <tr><th className="px-4 py-2 text-start">Cashier</th><th className="px-4 py-2 text-start">Opened</th><th className="px-4 py-2 text-end">Expected</th><th className="px-4 py-2 text-end">Counted</th><th className="px-4 py-2 text-end">Difference</th></tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {data.shifts.map((s: any) => (
                  <tr key={s._id}>
                    <td className="px-4 py-2 font-medium">{s.cashierName}</td>
                    <td className="px-4 py-2">{new Date(s.openedAt).toLocaleString()}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{s.status === 'open' ? 'open' : money(s.expectedCash)}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{s.countedCash != null ? money(s.countedCash) : '—'}</td>
                    <td className={`px-4 py-2 text-end font-semibold tabular-nums ${s.discrepancy ? 'text-red-600' : 'text-emerald-700'}`}>{s.discrepancy != null ? money(s.discrepancy) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <h2 className="mb-3 mt-10 font-display text-xl font-semibold">Kitchen performance</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Tickets completed" value={String(k.ticketsReady)} sub="Confirmed → ready" />
        <Stat label="Average ticket time" value={dur(k.averageTicketSeconds)} />
        <Stat label="Delayed tickets" value={String(k.delayedTickets)} sub={`of ${k.ticketsWithPrepTime} with prep times · grace ${k.graceMinutes} min`} />
        <Stat label="Stations active" value={String(k.stations.length)} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Stations">
          <ul className="divide-y divide-stone-100 text-sm">
            {k.stations.map((s: any) => (
              <li key={s.stationId ?? 'none'} className="flex flex-wrap justify-between gap-x-3 py-2"><span className="font-medium">{s.name}</span><span className="text-stone-500">{s.items} items · prep {dur(s.averagePrepSeconds)} · ready after {dur(s.averageReadySeconds)}</span></li>
            ))}
            {!k.stations.length && <li className="py-4 text-stone-500">No kitchen activity yet.</li>}
          </ul>
        </Card>
        <Card title="Busiest kitchen hours">
          <BarChart height={180} data={Array.from({ length: 24 }, (_, h) => ({ label: `${h}`, value: k.peakHours.find((x: any) => x.hour === h)?.orders ?? 0 }))} label="Tickets per hour" />
        </Card>
        <Card title="Dish preparation" className="lg:col-span-2">
          <ul className="grid gap-x-6 text-sm sm:grid-cols-2">
            {k.items.map((i: any) => (
              <li key={i.name} className="flex justify-between gap-3 border-b border-stone-100 py-1.5"><span className="truncate">{i.name}</span><span className="shrink-0 tabular-nums text-stone-500">×{i.count} · {dur(i.averagePrepSeconds)}</span></li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-stone-500">Preparation is measured from Start to Ready on the kitchen display. Items marked ready without being started have no preparation time.</p>
        </Card>
      </div>
    </>
  );
}
