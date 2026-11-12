import { useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { api, qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../store/auth';
import { Button, Card, ErrorState, Input, Loading, PageHeader, Select, Stat, Tabs, useFeedback, Badge } from '../../components/ui';
import { BarChart, RankBars } from '../../components/Chart';
import { formatMoney } from '../../lib/util';
import { OperationsReport } from '../../components/OperationsReport';
import { BarChart3 as HeaderIcon } from 'lucide-react';

export default function Analytics() {
  const fb = useFeedback();
  const { tenant, hasFeature } = useAuth();
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals);
  const [period, setPeriod] = useState('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [unit, setUnit] = useState('');
  const [metric, setMetric] = useState<'sales' | 'orders' | 'collected'>('sales');
  const params = period === 'custom' ? { from, to, unit } : { period, unit };
  const { data, loading, error, reload } = useApi<any>(period === 'custom' && (!from || !to) ? null : `/api/staff/analytics/summary${qs(params)}`);
  const [exporting, setExporting] = useState<string | null>(null);

  const exp = async (kind: string, format: 'csv' | 'pdf') => {
    setExporting(`${kind}-${format}`);
    try {
      await api.download(`/api/staff/analytics/export${qs({ ...params, kind, format })}`, `${kind}.${format}`);
    } catch (e) {
      fb.fail(e);
    } finally {
      setExporting(null);
    }
  };

  const fmtPeriod = (iso: string) => {
    const d = new Date(iso);
    const u = data?.unit;
    return u === 'month' ? d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : u === 'year' ? String(d.getFullYear()) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="blue"
        title="Analytics"
        subtitle="Sales are counted from accepted orders; collections only from verified payments"
        actions={
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <Tabs value={period} onChange={setPeriod} items={[{ value: 'today', label: 'Today' }, { value: 'week', label: '7 days' }, { value: 'month', label: '30 days' }, { value: 'year', label: '12 months' }, { value: 'custom', label: 'Custom' }]} />
            {period === 'custom' && (<><Input type="date" className="w-auto" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" /><Input type="date" className="w-auto" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" /></>)}
            <Select className="w-auto" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Group by"><option value="">Auto</option><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option><option value="year">Yearly</option></Select>
          </div>
        }
      />
      {period === 'custom' && (!from || !to) ? <Card><p className="py-8 text-center text-sm text-stone-500">Choose a start and end date.</p></Card> : loading && !data ? <Loading /> : error ? <ErrorState message={error} onRetry={reload} /> : (
        <>
          <div className="grid-stats">
            <Stat label="Net sales" value={money(data.summary.netSales)} sub={`${data.summary.orders} orders · AOV ${money(data.summary.averageOrderValue)}`} tone="brand" />
            <Stat accent="emerald" label="Verified collections" value={money(data.summary.verifiedCollections)} sub={`Net of refunds ${money(data.summary.netCollections)}`} />
            <Stat accent="amber" label="Pending payments" value={money(data.summary.pendingPayments)} sub={data.summary.pendingOnlineIntents ? `${money(data.summary.pendingOnlineIntents)} online awaiting confirmation` : 'Unpaid balance on sales'} />
            <Stat accent="rose" label="Refunds" value={money(data.summary.refunds)} sub={`${data.summary.cancelledOrders} cancelled / rejected orders`} />
            <Stat label="Gross (before discounts)" value={money(data.summary.grossSales)} />
            <Stat label="Discounts" value={money(data.summary.discounts)} />
            <Stat label="Taxes" value={money(data.summary.taxes)} sub={tenant?.settings?.taxInclusive ? 'Included in prices' : 'Added to bills'} />
            <Stat label="Service charges" value={money(data.summary.serviceCharges)} />
          </div>

          <Card className="mt-section" title="Trend" actions={<Tabs value={metric} onChange={setMetric} items={[{ value: 'sales', label: 'Sales' }, { value: 'collected', label: 'Collected' }, { value: 'orders', label: 'Orders' }]} />}>
            <BarChart data={data.series.map((r: any) => ({ label: fmtPeriod(r.period), value: r[metric] }))} format={metric === 'orders' ? String : money} label="Sales trend" />
          </Card>

          <div className="mt-section grid gap-grid-gap lg:grid-cols-2">
            <Card title="Top dishes"><RankBars rows={data.products.slice(0, 10).map((p: any) => ({ label: p.name, value: p.revenue, sub: `×${p.quantity}` }))} format={money} /></Card>
            <Card title="By category"><RankBars accent="blue" rows={data.categories.map((c: any) => ({ label: c.name, value: c.revenue, sub: `×${c.quantity}` }))} format={money} /></Card>
            <Card title="Payment methods">
              <RankBars accent="emerald" rows={[{ label: 'Cash', value: data.summary.byMethod.cash }, { label: 'Card terminal', value: data.summary.byMethod.cardTerminal }, { label: 'Online', value: data.summary.byMethod.online }]} format={money} />
            </Card>
            <Card title="Busiest hours"><BarChart height={180} data={Array.from({ length: 24 }, (_, h) => ({ label: `${h}`, value: data.hours.find((x: any) => x._id === h)?.orders ?? 0 }))} label="Orders per hour" accent="blue" /></Card>
          </div>

          <OperationsReport params={period === 'custom' ? { from, to } : { period }} money={money} />

          <Card className="mt-6" title="Export reports" actions={!hasFeature('analytics_export') && <Badge tone="warn">Not in your plan</Badge>}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {[['summary', 'Financial summary'], ['orders', 'Orders'], ['payments', 'Transactions'], ['products', 'Product sales'], ['categories', 'Category sales']].map(([k, label]) => (
                <div key={k} className="rounded-xl border border-stone-200 p-4">
                  <p className="mb-2 text-sm font-medium">{label}</p>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" disabled={!hasFeature('analytics_export')} loading={exporting === `${k}-csv`} onClick={() => exp(k, 'csv')}><Download className="h-3.5 w-3.5" /> CSV</Button>
                    <Button size="sm" variant="outline" disabled={!hasFeature('analytics_export')} loading={exporting === `${k}-pdf`} onClick={() => exp(k, 'pdf')}><FileText className="h-3.5 w-3.5" /> PDF</Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}
