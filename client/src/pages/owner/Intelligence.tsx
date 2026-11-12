import { useState } from 'react';
import { Bot, RefreshCw, Send, Sparkles } from 'lucide-react';
import { api, qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../store/auth';
import { Badge, Button, Card, DataTable, Empty, ErrorState, Loading, PageHeader, Select, Stat, Tabs, Textarea, useFeedback } from '../../components/ui';
import { BarChart, RankBars } from '../../components/Chart';
import { formatMoney, timeAgo } from '../../lib/util';
import { Sparkles as HeaderIcon } from 'lucide-react';

type Tab = 'overview' | 'forecast' | 'recommendations' | 'assistant' | 'jobs';
const CONF_TONE: Record<string, any> = { high: 'good', medium: 'info', low: 'warn' };
const PRIO_TONE: Record<string, any> = { high: 'bad', medium: 'warn', low: 'neutral' };

export default function Intelligence() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <>
      <PageHeader icon={HeaderIcon} accent="violet" eyebrow="Owner insights" title="Business intelligence" subtitle="Figures come from your own orders, recipes and stock. Where data is missing the page says so instead of guessing." />
      <div className="mb-4 overflow-x-auto">
        <Tabs value={tab} onChange={setTab} items={[{ value: 'overview', label: 'Overview' }, { value: 'forecast', label: 'Forecast' }, { value: 'recommendations', label: 'Recommendations' }, { value: 'assistant', label: 'Assistant' }, { value: 'jobs', label: 'Background jobs' }]} />
      </div>
      {tab === 'overview' && <Overview />}
      {tab === 'forecast' && <Forecast />}
      {tab === 'recommendations' && <Recommendations />}
      {tab === 'assistant' && <Assistant />}
      {tab === 'jobs' && <Jobs />}
    </>
  );
}

function useMoney() {
  const { tenant } = useAuth();
  return (n: number | null | undefined) => (n == null ? '—' : formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals));
}

function Overview() {
  const money = useMoney();
  const [period, setPeriod] = useState('month');
  const o = useApi<any>(`/api/staff/intelligence/overview${qs({ period })}`, [period]);
  const sum = useApi<any>('/api/staff/intelligence/summary');
  if (o.loading && !o.data) return <Loading />;
  if (o.error) return <ErrorState message={o.error} onRetry={o.reload} />;
  const d = o.data;
  const m = d.money;
  const s = sum.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40">
          <option value="today">Today</option><option value="week">Last 7 days</option><option value="month">Last 30 days</option><option value="year">Last 365 days</option>
        </Select>
        {d.dataQuality?.message && <Badge tone="warn">{d.dataQuality.message}</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat accent="brand" label="Net item revenue" value={money(m.netItemRevenue)} sub={`Gross ${money(m.grossItemSales)} − discounts ${money(m.discounts)}`} />
        <Stat accent="amber" label="Food cost" value={money(m.foodCost)} sub={m.foodCost == null ? 'No recipe costs yet' : `Covers ${d.dataQuality?.costCoveragePercent ?? 0}% of revenue`} />
        <Stat label="Gross profit" value={money(m.grossProfit)} sub={m.grossMarginPercent != null ? `${m.grossMarginPercent}% margin` : 'Needs recipe costs'} accent="emerald" />
        <Stat accent="blue" label="Orders" value={d.orders.count} sub={`Avg ${money(d.orders.averageOrderValue)} · ${d.orders.cancellationRatePercent ?? 0}% cancelled`} />
      </div>
      <p className="text-xs text-stone-500">{m.profitBasis} Order totals ({money(m.orderTotals)}) include tax, service and delivery fees and are not revenue. Verified collections: {money(m.verifiedCollections)}; refunds {money(m.refunds)}.</p>

      {s && (
        <div className="grid gap-3 lg:grid-cols-3">
          <Card title="Next 24 hours">
            {s.forecastTomorrowish?.sufficient === false ? <p className="text-sm text-stone-500">{s.forecastTomorrowish.reason}</p> : s.forecastTomorrowish ? (
              <div className="space-y-1 text-sm">
                <div>Expected sales <b>{money(s.forecastTomorrowish.sales?.predicted)}</b> <span className="text-stone-500">({money(s.forecastTomorrowish.sales?.low)}–{money(s.forecastTomorrowish.sales?.high)})</span></div>
                <div>About <b>{s.forecastTomorrowish.orders?.predicted}</b> orders · confidence <Badge tone={CONF_TONE[s.forecastTomorrowish.confidence]}>{s.forecastTomorrowish.confidence}</Badge></div>
                {s.forecastTomorrowish.reorder?.length > 0 && <div className="text-amber-700">Reorder soon: {s.forecastTomorrowish.reorder.map((r: any) => r.name).join(', ')}</div>}
              </div>
            ) : null}
          </Card>
          {s.marketing && <Card title="Marketing"><div className="space-y-1 text-sm"><div>{s.marketing.running} running · {s.marketing.scheduled} scheduled</div><div>{s.marketing.awaitingApproval} awaiting your approval</div><div>{s.marketing.consenting} customers agreed to receive messages</div></div></Card>}
          {s.delivery && <Card title="Delivery now"><div className="space-y-1 text-sm"><div>{s.delivery.active} active · {s.delivery.awaitingRider} waiting for a rider</div><div className={s.delivery.delayed ? 'text-red-700' : ''}>{s.delivery.delayed} past their due time</div><div>{s.delivery.ridersAvailable} riders available</div></div></Card>}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Daily order totals">{d.daily?.length ? <BarChart data={d.daily.map((x: any) => ({ label: String(x._id).slice(5), value: x.sales }))} format={(n) => money(n)} /> : <Empty title="No sales in this period" />}</Card>
        <Card title="Busiest hours">{d.peakHours?.length ? <BarChart data={d.peakHours.map((x: any) => ({ label: `${String(x.hour).padStart(2, '0')}h`, value: x.orders }))} /> : <Empty title="No orders yet" />}</Card>
        <Card title="Top dishes by revenue">{d.topByRevenue?.length ? <RankBars rows={d.topByRevenue.map((p: any) => ({ label: p.name, value: p.revenue, sub: `${p.quantity} sold` }))} format={(n) => money(n)} /> : <Empty title="No dish sales" />}</Card>
        <Card title="Top dishes by gross profit">{d.topByProfit?.length ? <RankBars rows={d.topByProfit.map((p: any) => ({ label: p.name, value: p.grossProfit, sub: `${p.marginPercent}% margin` }))} format={(n) => money(n)} /> : <Empty title="No dish has a complete recipe cost" hint="Add recipes and ingredient costs to see profit." />}</Card>
        <Card title="High food-cost dishes">{d.highFoodCost?.length ? <RankBars rows={d.highFoodCost.map((p: any) => ({ label: p.name, value: p.foodCostPercent, sub: money(p.revenue) }))} format={(n) => `${n}%`} /> : <Empty title="None above your target" />}</Card>
        <Card title="Selling less (last 14 vs previous 14 days)">{d.declining?.length ? <RankBars rows={d.declining.map((p: any) => ({ label: p.name, value: p.changePercent, sub: `${p.previous14Days} → ${p.last14Days}` }))} format={(n) => `${n}%`} /> : <Empty title="No dish dropped sharply" />}</Card>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Identified customers" value={d.customers?.identifiedCustomers ?? 0} sub={`${d.customers?.newCustomers ?? 0} new · ${d.customers?.returningCustomers ?? 0} returning`} />
        <Stat label="Retention" value={d.customers?.retentionPercent != null ? `${d.customers.retentionPercent}%` : '—'} sub="Of the previous period's customers" />
        <Stat label="Waste cost" value={money(d.waste?.wasteCost)} sub={d.waste?.wasteCostKnown ? 'From waste records' : 'Some waste has no cost'} />
      </div>
    </div>
  );
}

function Forecast() {
  const money = useMoney();
  const fb = useFeedback();
  const [h, setH] = useState(7);
  const f = useApi<any>(`/api/staff/intelligence/forecast?horizon=${h}`, [h]);
  const refresh = async () => {
    try {
      f.setData(await api.get(`/api/staff/intelligence/forecast?horizon=${h}&refresh=true`));
    } catch (e: any) { fb.push('error', e.message); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={String(h)} onChange={(v) => setH(Number(v))} items={[{ value: '1', label: '24 hours' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
        <Button variant="ghost" size="sm" onClick={refresh}><RefreshCw className="h-4 w-4" /> Recalculate</Button>
      </div>
      {f.loading && !f.data ? <Loading /> : f.error ? <ErrorState message={f.error} onRetry={f.reload} /> : !f.data.sufficient ? (
        <Card><Empty title="Not enough history for this forecast" hint={f.data.reason} /></Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat accent="violet" label="Expected order totals" value={money(f.data.sales.total.predicted)} sub={`80% range ${money(f.data.sales.total.low)} – ${money(f.data.sales.total.high)}`} />
            <Stat label="Expected orders" value={f.data.orders.total.predicted} sub={`${f.data.orders.total.low} – ${f.data.orders.total.high}`} />
            <Stat label="Same period before" value={money(f.data.sales.previousPeriodActual)} sub="Actual" />
            <Stat label="Confidence" value={<Badge tone={CONF_TONE[f.data.accuracy.confidence]}>{f.data.accuracy.confidence}</Badge>} sub={f.data.accuracy.backtestMapePercent != null ? `Back-test error ${f.data.accuracy.backtestMapePercent}%` : 'No back-test yet'} />
          </div>
          <Card title="Forecast by day" subtitle="Expected order totals (statistical estimate)" icon={Sparkles} accent="violet"><BarChart data={f.data.sales.days.map((d: any) => ({ label: d.date.slice(5), value: d.predicted }))} format={(n) => money(n)} label="Forecast" accent="violet" /></Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Dishes expected to sell">
              <DataTable rows={f.data.products.items.slice(0, 15).map((p: any) => ({ ...p, _id: p.productId }))} empty={<Empty title="No dish history" />} columns={[
                { key: 'n', header: 'Dish', render: (p: any) => <span>{p.name}{!p.currentlyAvailable && <Badge tone="warn" className="ms-2">unavailable</Badge>}</span> },
                { key: 'q', header: 'Expected', className: 'text-end', render: (p: any) => (p.predicted == null ? '—' : `${p.predicted} (${p.low}–${p.high})`) },
              ]} />
            </Card>
            <Card title="Ingredients">
              <DataTable rows={f.data.ingredients.items.map((i: any) => ({ ...i, _id: i.inventoryItemId }))} empty={<Empty title="No recipes link dishes to stock" />} columns={[
                { key: 'n', header: 'Ingredient', render: (i: any) => i.name },
                { key: 'u', header: 'Expected use', render: (i: any) => `${i.expectedUse} ${i.unit}` },
                { key: 'h', header: 'On hand', render: (i: any) => `${i.onHand} ${i.unit}` },
                { key: 'c', header: 'Cover', className: 'text-end', render: (i: any) => (i.reorderSuggested ? <Badge tone="bad">{i.daysOfCover} days – reorder</Badge> : i.daysOfCover == null ? '—' : `${i.daysOfCover} days`) },
              ]} />
            </Card>
          </div>
          {f.data.hourly?.next24h?.length > 0 && h === 1 && <Card title="Next 24 hours by hour"><BarChart data={f.data.hourly.next24h.map((x: any) => ({ label: `${String(x.hour).padStart(2, '0')}h`, value: x.predicted }))} /></Card>}
          <Card title="How this was calculated">
            <ul className="list-disc space-y-1 ps-5 text-sm text-stone-600">
              <li>{f.data.method}</li>
              <li>History: {f.data.coverage.historyDays} days ({f.data.coverage.from} → {f.data.coverage.to}), sales on {f.data.coverage.coveragePercent}% of days.</li>
              <li>{f.data.accuracy.explanation}</li>
              {(f.data.factors ?? []).map((x: any, i: number) => <li key={i}>{typeof x === 'string' ? x : x.description ?? JSON.stringify(x)}</li>)}
              <li>{f.data.externalFactors}</li>
              <li>Generated {timeAgo(f.data.generatedAt)}.</li>
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

function Recommendations() {
  const fb = useFeedback();
  const [status, setStatus] = useState('open');
  const r = useApi<any>(`/api/staff/intelligence/recommendations${qs({ status, limit: 50 })}`, [status]);
  const refresh = async () => {
    try {
      const x = await api.post('/api/staff/intelligence/recommendations/refresh');
      fb.push('success', `${x.created} new recommendation(s)`);
      r.reload();
    } catch (e: any) { fb.push('error', e.message); }
  };
  const decide = async (id: string, decision: string) => {
    const note = await fb.confirm({ title: `Mark as ${decision}?`, input: { label: 'Note (optional)' }, confirmLabel: 'Save' });
    if (note === false) return;
    try {
      await api.post(`/api/staff/intelligence/recommendations/${id}/decision`, { decision, note: typeof note === 'string' && note ? note : undefined });
      r.reload();
    } catch (e: any) { fb.push('error', e.message); }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={status} onChange={setStatus} items={[{ value: 'open', label: 'Open' }, { value: 'accepted', label: 'Accepted' }, { value: 'rejected', label: 'Rejected' }, { value: 'dismissed', label: 'Dismissed' }]} />
        <Button variant="ghost" size="sm" onClick={refresh}><RefreshCw className="h-4 w-4" /> Check now</Button>
      </div>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState message={r.error} onRetry={r.reload} /> : !r.data.items.length ? <Card><Empty title="Nothing here" hint="Recommendations are generated daily from your data. None are shown when the data does not support one." /></Card> : r.data.items.map((x: any) => (
        <Card key={x._id}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{x.title}</h3><Badge tone={PRIO_TONE[x.priority]}>{x.priority} priority</Badge><Badge tone={CONF_TONE[x.confidence]}>{x.confidence} confidence</Badge></div>
              <p className="mt-1 text-sm text-stone-600">{x.explanation}</p>
              <p className="mt-1 text-sm"><b>Next step:</b> {x.action}</p>
              {x.expectedBenefit && <p className="text-sm text-stone-500">Expected benefit: {x.expectedBenefit}</p>}
              {x.outcome && <p className="mt-1 text-sm text-emerald-700">Result after 14 days: {x.outcome.summary ?? JSON.stringify(x.outcome)}</p>}
              {x.decidedBy && <p className="text-xs text-stone-400">{x.status} by {x.decidedBy} {timeAgo(x.decidedAt)}{x.decisionNote ? ` — ${x.decisionNote}` : ''}</p>}
            </div>
            {x.status === 'open' && (
              <div className="flex gap-1">
                <Button size="sm" onClick={() => decide(x._id, 'accepted')}>Accept</Button>
                <Button size="sm" variant="ghost" onClick={() => decide(x._id, 'rejected')}>Reject</Button>
                <Button size="sm" variant="ghost" onClick={() => decide(x._id, 'dismissed')}>Dismiss</Button>
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

const SUGGESTIONS = ['What were my sales this week?', 'Which dishes make the most profit?', 'What should I reorder?', 'When are my busiest hours?', 'Why did sales change this month?', 'How are my deliveries doing?'];

function Assistant() {
  const status = useApi<any>('/api/staff/intelligence/ai-status');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ role: 'user' | 'assistant'; content: string; meta?: any }[]>([]);
  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    const history = log.map(({ role, content }) => ({ role, content }));
    setLog((l) => [...l, { role: 'user', content: question }]);
    setQ('');
    setBusy(true);
    try {
      const r = await api.post('/api/staff/intelligence/assistant', { question, history });
      setLog((l) => [...l, { role: 'assistant', content: r.answer, meta: r }]);
    } catch (e: any) {
      setLog((l) => [...l, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally { setBusy(false); }
  };
  return (
    <Card icon={Bot} accent="violet" title="Ask about your business" subtitle="Read-only answers from your own data" actions={status.data && <Badge tone={status.data.configured ? 'ai' : 'neutral'}>{status.data.configured ? `AI: ${status.data.model}` : 'Built-in reports (AI not configured)'}</Badge>}>
      <p className="mb-3 text-sm text-stone-500">Read-only: the assistant can look up your reports but cannot change anything. It only uses data your role may see.</p>
      <div className="mb-3 space-y-3">
        {log.length === 0 && <div className="flex flex-wrap gap-2">{SUGGESTIONS.map((s) => <button key={s} className="rounded-full border border-stone-200 px-3 py-1 text-sm hover:bg-stone-50" onClick={() => ask(s)}>{s}</button>)}</div>}
        {log.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'ms-auto max-w-[85%] rounded-2xl bg-violet-50 px-4 py-2.5 text-sm text-violet-950' : 'max-w-[95%] whitespace-pre-wrap rounded-2xl bg-stone-50 px-4 py-3 text-sm ring-1 ring-inset ring-stone-100'}>
            {m.content}
            {m.meta && (
              <div className="mt-2 flex flex-wrap gap-1 text-xs text-stone-500">
                <Badge tone={m.meta.mode === 'ai' ? 'ai' : 'neutral'}>{m.meta.mode === 'ai' ? <><Sparkles className="me-1 inline h-3 w-3" />AI</> : 'Built-in'}</Badge>
                {m.meta.toolsUsed?.map((t: any, j: number) => <Badge key={j}>{t.name}</Badge>)}
                {m.meta.notice && <span>{m.meta.notice}</span>}
              </div>
            )}
          </div>
        ))}
        {busy && <Loading label="Looking it up…" />}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <Textarea value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} placeholder="e.g. Which dish sold the most last week?" className="min-h-[44px] flex-1" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(q); } }} />
        <Button type="submit" loading={busy} aria-label="Ask"><Send className="h-4 w-4" /></Button>
      </form>
    </Card>
  );
}

function Jobs() {
  const j = useApi<any>('/api/staff/intelligence/jobs');
  const tone: Record<string, any> = { done: 'good', failed: 'bad', running: 'info', queued: 'neutral', cancelled: 'neutral' };
  if (j.loading && !j.data) return <Loading />;
  if (j.error) return <ErrorState message={j.error} onRetry={j.reload} />;
  return (
    <Card pad={false} title="Background jobs" actions={<Button size="sm" variant="ghost" onClick={j.reload}><RefreshCw className="h-4 w-4" /></Button>}>
      <DataTable rows={j.data.items} empty={<Empty title="No jobs yet" hint="Forecasts, segments and recommendations refresh daily; campaign and delivery jobs appear when used." />} columns={[
        { key: 't', header: 'Job', render: (x: any) => x.type },
        { key: 's', header: 'Status', render: (x: any) => <Badge tone={tone[x.status]}>{x.status}</Badge> },
        { key: 'r', header: 'Run at', render: (x: any) => new Date(x.runAt).toLocaleString() },
        { key: 'a', header: 'Attempts', render: (x: any) => `${x.attempts}/${x.maxAttempts}` },
        { key: 'e', header: 'Last error', render: (x: any) => <span className="text-xs text-red-700">{x.lastError ?? ''}</span> },
      ]} />
    </Card>
  );
}
