import { Link } from 'react-router-dom';
import { Activity, Building2, CreditCard, Plus, Receipt, ScrollText, TrendingUp, Wallet } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { Badge, Card, ErrorState, Loading, NavCard, PageHeader, SectionHeader, Stat, type Accent } from '../../components/ui';
import { BarChart } from '../../components/Chart';
import { cn, formatMoney, timeAgo } from '../../lib/util';

const SUB_ACCENT: Record<string, { tone: any; bar: string }> = {
  active: { tone: 'good', bar: 'bg-emerald-500' },
  trial: { tone: 'info', bar: 'bg-blue-500' },
  past_due: { tone: 'warn', bar: 'bg-amber-500' },
  grace: { tone: 'warn', bar: 'bg-amber-400' },
};

export default function AdminOverview() {
  const { data, loading, error, reload } = useApi<any>('/api/platform/overview');
  const audit = useApi<any>('/api/platform/audit?limit=8');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const d = data!;
  const subCount = Object.values(d.bySubscription as Record<string, number>).reduce((a, b) => a + Number(b), 0);
  const subTotal = subCount || 1;
  const modules: { to: string; icon: any; title: string; description: string; accent: Accent; meta?: string }[] = [
    { to: '/admin/tenants', icon: Building2, title: 'Restaurants', description: 'Create restaurants, manage owners, status and subscriptions.', accent: 'brand', meta: `${d.totalTenants} restaurants` },
    { to: '/admin/plans', icon: CreditCard, title: 'Plans', description: 'Prices, trial length and the features each plan includes.', accent: 'violet', meta: `${d.plans.length} plan${d.plans.length === 1 ? '' : 's'} in use` },
    { to: '/admin/audit', icon: ScrollText, title: 'Audit log', description: 'Every sensitive action across the platform, with who and when.', accent: 'blue' },
  ];
  return (
    <>
      <PageHeader
        eyebrow="Platform console"
        title="Platform overview"
        subtitle="Last 30 days across every restaurant."
        actions={<Link to="/admin/tenants" className="focus-ring inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-medium text-brand-ink shadow-[0_1px_2px_rgb(0_0_0/0.12)] hover:brightness-[1.07]"><Plus className="h-4 w-4" /> New restaurant</Link>}
      />
      <div className="grid-stats">
        <Stat label="Restaurants" value={d.totalTenants} sub={`${d.byStatus.active ?? 0} active · ${d.byStatus.suspended ?? 0} suspended`} icon={<Building2 />} accent="brand" />
        <Stat label="Orders (30 days)" value={d.orders30.toLocaleString()} sub="All restaurants" icon={<Receipt />} accent="blue" />
        <Stat label="GMV (30 days)" value={formatMoney(d.gmv30)} sub="Mixed currencies shown in PKR format" icon={<TrendingUp />} accent="emerald" />
        <Stat label="Estimated MRR" value={formatMoney(d.estimatedMRR)} sub="Paying subscriptions only; trials excluded" icon={<Wallet />} accent="violet" />
      </div>

      <div className="mt-section grid gap-grid-gap xl:grid-cols-3">
        <Card title="Platform orders per day" subtitle="Confirmed orders, every restaurant" icon={Activity} accent="blue" className="xl:col-span-2">
          <BarChart data={d.daily.map((x: any) => ({ label: new Date(x._id).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), value: x.orders }))} label="Orders" accent="blue" />
        </Card>
        <Card title="Subscriptions" subtitle={`${subCount} restaurants`} icon={CreditCard} accent="violet">
          <ul className="space-y-4">
            {Object.entries(d.bySubscription).map(([k, v]) => (
              <li key={k}>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <Badge dot tone={SUB_ACCENT[k]?.tone ?? 'bad'}>{k.replace('_', ' ')}</Badge>
                  <span className="tabular font-semibold">{String(v)}</span>
                </div>
                <div className="h-2 rounded-full bg-stone-100"><div className={cn('h-2 rounded-full', SUB_ACCENT[k]?.bar ?? 'bg-rose-500')} style={{ width: `${(Number(v) / subTotal) * 100}%` }} /></div>
              </li>
            ))}
            {!Object.keys(d.bySubscription).length && <li className="text-sm text-stone-400">No subscriptions yet</li>}
          </ul>
          <div className="mt-6 border-t border-stone-100 pt-5">
            <p className="mb-2 text-[13px] font-medium text-stone-500">By plan</p>
            {d.plans.map((p: any) => (
              <div key={String(p._id)} className="flex justify-between py-1.5 text-sm">
                <span className="text-stone-700">{p.name ?? 'No plan'}</span>
                <span className="tabular font-medium text-stone-900">{p.n}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="mt-section grid gap-grid-gap xl:grid-cols-3">
        <Card title="Most active restaurants" subtitle="By orders, last 30 days" icon={Building2} accent="brand" className="xl:col-span-2" pad={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px]">
              <thead className="border-b border-stone-200/70 bg-stone-50/80">
                <tr>
                  <th className="th">Restaurant</th>
                  <th className="th text-end">Orders</th>
                  <th className="th text-end">GMV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {d.topTenants.map((t: any) => (
                  <tr key={String(t._id)} className="transition-colors hover:bg-stone-50/60">
                    <td className="td">
                      <Link to={`/admin/tenants/${t._id}`} className="font-medium text-stone-900 hover:text-brand">{t.name}</Link>
                      <span className="ms-2 text-xs text-stone-400">{t.slug}</span>
                    </td>
                    <td className="td text-end tabular-nums">{t.orders}</td>
                    <td className="td text-end font-medium tabular-nums">{formatMoney(t.gmv)}</td>
                  </tr>
                ))}
                {d.topTenants.length === 0 && (
                  <tr><td colSpan={3} className="td py-12 text-center text-stone-400">No orders yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Recent activity" subtitle="From the audit log" icon={ScrollText} accent="neutral" actions={<Link to="/admin/audit" className="text-sm font-medium text-brand hover:underline">All</Link>}>
          {audit.loading && !audit.data ? <Loading /> : (
            <ol className="space-y-4">
              {(audit.data?.items ?? []).slice(0, 8).map((a: any) => (
                <li key={a._id} className="flex gap-3">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand/60" aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-stone-800">{a.action}</p>
                    <p className="truncate text-xs text-stone-500">{a.actorName ?? 'system'} · {timeAgo(a.createdAt)} ago</p>
                  </div>
                </li>
              ))}
              {!audit.data?.items?.length && <li className="text-sm text-stone-400">No activity yet</li>}
            </ol>
          )}
        </Card>
      </div>

      <section className="mt-section">
        <SectionHeader title="Manage the platform" />
        <div className="grid-modules">{modules.map((m) => <NavCard key={m.to} {...m} />)}</div>
      </section>
    </>
  );
}
