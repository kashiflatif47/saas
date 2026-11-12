import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { api, qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useSocket } from '../../hooks/useSocket';
import { useAuth } from '../../store/auth';
import { Badge, Button, Card, DataTable, Drawer, Empty, ErrorState, Field, Input, Loading, PageHeader, Select, Stat, Tabs, Textarea, Toggle, useFeedback } from '../../components/ui';
import { BarChart } from '../../components/Chart';
import { formatMoney, toMajor, toMinor, timeAgo } from '../../lib/util';
import { Bike as HeaderIcon } from 'lucide-react';

type Tab = 'board' | 'riders' | 'zones' | 'analytics' | 'settings';
export const DELIVERY_LABEL: Record<string, string> = { awaiting_assignment: 'Needs rider', assigned: 'Assigned', rider_accepted: 'Rider accepted', picked_up: 'Picked up', on_the_way: 'On the way', delivered: 'Delivered', failed: 'Failed', returned: 'Returned', cancelled: 'Cancelled' };
const TONE: Record<string, any> = { awaiting_assignment: 'warn', assigned: 'info', rider_accepted: 'info', picked_up: 'brand', on_the_way: 'brand', delivered: 'good', failed: 'bad', returned: 'neutral', cancelled: 'neutral' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Delivery() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>(can('delivery:dispatch') ? 'board' : 'zones');
  const items = [
    can('delivery:dispatch') && { value: 'board' as Tab, label: 'Dispatch' },
    { value: 'riders' as Tab, label: 'Riders' },
    { value: 'zones' as Tab, label: 'Zones' },
    { value: 'analytics' as Tab, label: 'Analytics' },
    can('delivery:manage') && { value: 'settings' as Tab, label: 'Settings' },
  ].filter(Boolean) as { value: Tab; label: string }[];
  return (
    <>
      <PageHeader icon={HeaderIcon} accent="amber" eyebrow="Operate" title="Delivery" subtitle="Status-based tracking from the rider app. Distances are straight-line and only used when a rider shares a recent location; no travel times are invented." />
      <div className="mb-4 overflow-x-auto"><Tabs value={tab} onChange={setTab} items={items} /></div>
      {tab === 'board' && <Board />}
      {tab === 'riders' && <Riders />}
      {tab === 'zones' && <Zones />}
      {tab === 'analytics' && <Analytics />}
      {tab === 'settings' && <DeliverySettings />}
    </>
  );
}

function useMoney() {
  const { tenant } = useAuth();
  return (n?: number | null) => (n == null ? '—' : formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals));
}

function Board() {
  const fb = useFeedback();
  const money = useMoney();
  const b = useApi<any>('/api/staff/delivery/board');
  const [open, setOpen] = useState<any>(null);
  useSocket({ 'delivery:updated': () => b.reload(), 'delivery:needs_rider': (p: any) => { fb.push('info', `Order #${p.orderNumber} needs a rider`); b.reload(); }, 'order:updated': (o: any) => { if (o?.type === 'delivery') b.reload(); } });
  if (b.loading && !b.data) return <Loading />;
  if (b.error) return <ErrorState message={b.error} onRetry={b.reload} />;
  const now = new Date(b.data.serverTime).getTime();
  const cols = [
    { key: 'awaiting', title: 'Needs rider', st: ['awaiting_assignment'] },
    { key: 'assigned', title: 'Assigned', st: ['assigned', 'rider_accepted'] },
    { key: 'road', title: 'Out for delivery', st: ['picked_up', 'on_the_way'] },
    { key: 'done', title: 'Finished (24 h) / problems', st: ['delivered', 'failed', 'returned'] },
  ];
  return (
    <>
      <div className="mb-2 flex justify-end"><Button size="sm" variant="ghost" onClick={b.reload}><RefreshCw className="h-4 w-4" /> Refresh</Button></div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {cols.map((c) => {
          const rows = b.data.items.filter((o: any) => c.st.includes(o.delivery?.status));
          return (
            <div key={c.key} className="rounded-2xl bg-stone-100/70 p-2">
              <div className="mb-2 flex items-center justify-between px-1 text-sm font-semibold">{c.title}<Badge>{rows.length}</Badge></div>
              <div className="space-y-2">
                {rows.length === 0 && <p className="px-1 py-4 text-center text-xs text-stone-400">Nothing here</p>}
                {rows.map((o: any) => {
                  const late = o.delivery?.etaAt && new Date(o.delivery.etaAt).getTime() < now && !['delivered', 'returned', 'cancelled'].includes(o.delivery.status);
                  return (
                    <button key={o._id} onClick={() => setOpen(o)} className="w-full rounded-xl bg-white p-3 text-start shadow-sm ring-1 ring-stone-200 hover:ring-brand/60">
                      <div className="flex items-center justify-between gap-2"><span className="font-semibold">#{o.orderNumber}</span><Badge tone={TONE[o.delivery.status]}>{DELIVERY_LABEL[o.delivery.status]}</Badge></div>
                      <div className="mt-1 truncate text-sm text-stone-600">{o.delivery.zoneName ? `${o.delivery.zoneName} · ` : ''}{o.delivery.address ?? 'No address'}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                        <span>Kitchen: {o.status}</span>
                        {o.delivery.riderName && <span>· {o.delivery.riderName}</span>}
                        {o.delivery.etaAt && <span className={late ? 'font-semibold text-red-700' : ''}>· due {new Date(o.delivery.etaAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{late ? ' (late)' : ''}</span>}
                        <span>· {money(o.total - o.amountPaid)} to collect</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {open && <DispatchDrawer order={open} onClose={() => { setOpen(null); b.reload(); }} />}
    </>
  );
}

function DispatchDrawer({ order, onClose }: { order: any; onClose: () => void }) {
  const fb = useFeedback();
  const c = useApi<any>(`/api/staff/delivery/orders/${order._id}/candidates`);
  const [busy, setBusy] = useState(false);
  const act = async (action: string, body: any = {}) => {
    if (action === 'unassign' || action === 'return') {
      const reason = await fb.confirm({ title: action === 'unassign' ? 'Take the delivery away from the rider?' : 'Mark as returned to the restaurant?', input: action === 'unassign' ? { label: 'Reason' } : undefined });
      if (reason === false) return;
      if (typeof reason === 'string') body.reason = reason;
    }
    setBusy(true);
    try { await api.post(`/api/staff/delivery/orders/${order._id}/dispatch/${action}`, body); fb.push('success', 'Updated'); onClose(); } catch (e: any) { fb.push('error', e.message); } finally { setBusy(false); }
  };
  const d = order.delivery;
  return (
    <Drawer open onClose={onClose} title={`Delivery #${order.orderNumber}`}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2"><Badge tone={TONE[d.status]}>{DELIVERY_LABEL[d.status]}</Badge>{d.zoneName && <Badge>{d.zoneName}</Badge>}</div>
        <div><b>{order.customer?.name}</b> {order.customer?.phone}<div>{d.address}</div>{d.notes && <div className="text-stone-500">{d.notes}</div>}{d.location?.lat != null && <div className="text-xs text-stone-500">Customer shared a location ({d.location.source ?? 'map'})</div>}</div>
        <div className="flex flex-wrap gap-2">
          {['awaiting_assignment'].includes(d.status) && <Button onClick={() => act('auto')} loading={busy}>Auto-assign</Button>}
          {['assigned', 'rider_accepted'].includes(d.status) && <Button variant="ghost" onClick={() => act('unassign')}>Unassign</Button>}
          {d.status === 'failed' && <><Button onClick={() => act('retry')}>Retry delivery</Button><Button variant="ghost" onClick={() => act('return')}>Returned to restaurant</Button></>}
        </div>
        {['awaiting_assignment', 'assigned', 'rider_accepted', 'failed'].includes(d.status) && (
          <Card title="Choose a rider" pad={false}>
            {c.loading ? <Loading /> : (
              <div className="divide-y divide-stone-100">
                {c.data?.candidates.map((r: any, i: number) => (
                  <div key={r.riderId} className="flex items-center justify-between gap-2 p-3">
                    <div><div className="font-medium">{r.name}{i === 0 && <Badge tone="brand" className="ms-2">best match</Badge>}</div><div className="text-xs text-stone-500">{r.load} active · {r.km != null ? `${r.km} km straight-line` : 'distance unknown'}</div></div>
                    <Button size="sm" variant="ghost" onClick={() => act('assign', { riderId: r.riderId })}>Assign</Button>
                  </div>
                ))}
                {c.data?.skipped.map((r: any) => <div key={r.riderId} className="p-3 text-xs text-stone-400">{r.name}: {r.reason}</div>)}
                {!c.data?.candidates.length && !c.data?.skipped.length && <p className="p-3 text-stone-500">No rider accounts. Add staff with the Rider role.</p>}
              </div>
            )}
          </Card>
        )}
        <Card title="History">
          <ul className="space-y-1 text-xs">
            {(d.attempts ?? []).map((a: any, i: number) => <li key={i}><b>{a.outcome}</b> {a.riderName ?? ''} · {timeAgo(a.at)} by {a.by}{a.reason ? ` — ${a.reason}` : ''}{a.explanation ? <div className="text-stone-400">{a.explanation}</div> : null}</li>)}
            {d.failureReason && <li className="text-red-700">Failed: {d.failureReason}</li>}
            {d.proof && <li>Proof: {d.proof.codeConfirmed ? 'customer code confirmed' : 'no code'}{d.proof.note ? ` — ${d.proof.note}` : ''}</li>}
          </ul>
        </Card>
      </div>
    </Drawer>
  );
}

function Riders() {
  const fb = useFeedback();
  const { can } = useAuth();
  const r = useApi<any>('/api/staff/delivery/riders');
  const zones = useApi<any>('/api/staff/delivery/zones');
  const update = async (id: string, body: any) => {
    try { await api.patch(`/api/staff/delivery/riders/${id}`, body); r.reload(); } catch (e: any) { fb.push('error', e.message); }
  };
  if (r.loading && !r.data) return <Loading />;
  return (
    <Card pad={false} title="Riders" actions={<span className="text-xs text-stone-500">Add riders in Staff & roles with the Rider role.</span>}>
      <DataTable rows={r.data?.items ?? []} empty={<Empty title="No riders yet" hint="Create staff accounts with the Rider role; they sign in to the rider app on their phone." />} columns={[
        { key: 'n', header: 'Rider', render: (x: any) => <div><div className="font-medium">{x.name}</div><div className="text-xs text-stone-500">{x.riderProfile?.vehicle ?? ''} {x.riderProfile?.phone ?? x.phone ?? ''}</div></div> },
        { key: 'a', header: 'Available', render: (x: any) => <Toggle checked={!!x.riderProfile?.available} disabled={!can('delivery:manage')} onChange={(v) => update(x._id, { available: v })} /> },
        { key: 'l', header: 'Active', render: (x: any) => x.activeDeliveries },
        { key: 'g', header: 'Location', render: (x: any) => (x.riderProfile?.location ? `shared ${timeAgo(x.riderProfile.location.at)}` : x.riderProfile?.locationSharing ? 'sharing on, none yet' : 'not shared') },
        { key: 'z', header: 'Zones', render: (x: any) => (
          <Select multiple disabled={!can('delivery:manage')} value={x.riderProfile?.zoneIds ?? []} onChange={(e) => update(x._id, { zoneIds: Array.from(e.target.selectedOptions).map((o) => o.value) })} className="h-20 w-40 text-xs">
            {(zones.data?.items ?? []).map((z: any) => <option key={z._id} value={z._id}>{z.name}</option>)}
          </Select>
        ) },
      ]} />
      <p className="p-3 text-xs text-stone-500">No zones selected = the rider covers every zone.</p>
    </Card>
  );
}

function parsePolygon(text: string): [number, number][] | null {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v) && v.length >= 3 && v.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return v;
  } catch { /* fall through */ }
  const pts = text.split(/\n|;/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[ ,]+/).map(Number));
  if (pts.length >= 3 && pts.every((p) => p.length === 2 && p.every(Number.isFinite))) return pts.map(([lat, lng]) => [lng, lat]);
  return null;
}

function Zones() {
  const fb = useFeedback();
  const { can } = useAuth();
  const money = useMoney();
  const z = useApi<any>('/api/staff/delivery/zones');
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    const body: any = { name: edit.name, fee: toMinor(edit.feeMajor ?? 0), minOrder: toMinor(edit.minMajor ?? 0), etaMinutes: Number(edit.etaMinutes ?? 30), isActive: edit.isActive !== false, hours: { days: edit.days ?? [], from: edit.from ?? '', to: edit.to ?? '' } };
    if (edit.shape === 'circle') body.circle = { center: { lat: Number(edit.lat), lng: Number(edit.lng) }, radiusKm: Number(edit.radiusKm) };
    else {
      const poly = parsePolygon(edit.polygonText ?? '');
      if (!poly) return fb.push('error', 'Enter at least 3 points, one "lat, lng" per line');
      body.polygon = poly;
    }
    try {
      if (edit._id) await api.put(`/api/staff/delivery/zones/${edit._id}`, body);
      else await api.post('/api/staff/delivery/zones', body);
      setEdit(null);
      z.reload();
    } catch (e: any) { fb.push('error', e.message); }
  };
  const openEdit = (x: any) => setEdit({ ...x, shape: x.circle?.center ? 'circle' : 'polygon', lat: x.circle?.center?.lat, lng: x.circle?.center?.lng, radiusKm: x.circle?.radiusKm, polygonText: (x.polygon ?? []).map(([lng, lat]: number[]) => `${lat}, ${lng}`).join('\n'), feeMajor: toMajor(x.fee), minMajor: toMajor(x.minOrder), days: x.hours?.days ?? [], from: x.hours?.from, to: x.hours?.to });
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-500">With no zones, delivery uses the flat fee from Settings. Once you add zones, customers must pick a zone or share a location inside one, and the zone's fee, minimum order and delivery time apply.</p>
      {can('delivery:manage') && <div className="flex justify-end"><Button onClick={() => setEdit({ name: '', shape: 'circle', radiusKm: 3, etaMinutes: 30, feeMajor: 0, minMajor: 0, isActive: true, days: [] })}><Plus className="h-4 w-4" /> New zone</Button></div>}
      <Card pad={false}>
        <DataTable rows={z.data?.items ?? []} onRowClick={can('delivery:manage') ? openEdit : undefined} empty={<Empty title="No delivery zones" />} columns={[
          { key: 'n', header: 'Zone', render: (x: any) => <span className="font-medium">{x.name}{!x.isActive && <Badge className="ms-2">inactive</Badge>}</span> },
          { key: 's', header: 'Area', render: (x: any) => (x.circle?.center ? `${x.circle.radiusKm} km radius` : `${x.polygon?.length ?? 0}-point boundary`) },
          { key: 'f', header: 'Fee', render: (x: any) => money(x.fee) },
          { key: 'm', header: 'Min order', render: (x: any) => money(x.minOrder) },
          { key: 'e', header: 'Delivery time', render: (x: any) => `${x.etaMinutes} min` },
          { key: 'h', header: 'Hours', render: (x: any) => (x.hours?.from ? `${x.hours.from}–${x.hours.to}${x.hours.days?.length ? ` · ${x.hours.days.map((d: number) => DAYS[d]).join(' ')}` : ''}` : 'Always') },
        ]} />
      </Card>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?._id ? 'Edit zone' : 'New zone'} footer={<div className="flex justify-between gap-2">{edit?._id ? <Button variant="ghost" onClick={async () => { await api.del(`/api/staff/delivery/zones/${edit._id}`); setEdit(null); z.reload(); }}>Deactivate</Button> : <span />}<Button onClick={save}>Save</Button></div>}>
        {edit && (
          <div className="space-y-3">
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Area shape"><Select value={edit.shape} onChange={(e) => setEdit({ ...edit, shape: e.target.value })}><option value="circle">Circle around a point</option><option value="polygon">Boundary points</option></Select></Field>
            {edit.shape === 'circle' ? (
              <div className="grid grid-cols-3 gap-2">
                <Field label="Centre latitude"><Input type="number" step="any" value={edit.lat ?? ''} onChange={(e) => setEdit({ ...edit, lat: e.target.value })} /></Field>
                <Field label="Centre longitude"><Input type="number" step="any" value={edit.lng ?? ''} onChange={(e) => setEdit({ ...edit, lng: e.target.value })} /></Field>
                <Field label="Radius (km)"><Input type="number" step="0.1" min={0.1} value={edit.radiusKm ?? ''} onChange={(e) => setEdit({ ...edit, radiusKm: e.target.value })} /></Field>
              </div>
            ) : (
              <Field label="Boundary" hint='One point per line as "latitude, longitude" (copy from any map). At least 3 points.'><Textarea rows={6} value={edit.polygonText ?? ''} onChange={(e) => setEdit({ ...edit, polygonText: e.target.value })} /></Field>
            )}
            <div className="grid grid-cols-3 gap-2">
              <Field label="Fee"><Input type="number" min={0} value={edit.feeMajor} onChange={(e) => setEdit({ ...edit, feeMajor: e.target.value })} /></Field>
              <Field label="Minimum order"><Input type="number" min={0} value={edit.minMajor} onChange={(e) => setEdit({ ...edit, minMajor: e.target.value })} /></Field>
              <Field label="Delivery minutes"><Input type="number" min={5} max={240} value={edit.etaMinutes} onChange={(e) => setEdit({ ...edit, etaMinutes: e.target.value })} /></Field>
            </div>
            <Field label="Delivery hours (optional)">
              <div className="flex flex-wrap items-center gap-2">
                <Input type="time" value={edit.from ?? ''} onChange={(e) => setEdit({ ...edit, from: e.target.value })} className="w-32" /> to <Input type="time" value={edit.to ?? ''} onChange={(e) => setEdit({ ...edit, to: e.target.value })} className="w-32" />
              </div>
              <div className="mt-2 flex flex-wrap gap-1">{DAYS.map((d, i) => <label key={d} className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${edit.days?.includes(i) ? 'border-brand bg-brand/10' : 'border-stone-200'}`}><input type="checkbox" className="sr-only" checked={edit.days?.includes(i)} onChange={(e) => setEdit({ ...edit, days: e.target.checked ? [...edit.days, i] : edit.days.filter((x: number) => x !== i) })} />{d}</label>)}</div>
            </Field>
            <Toggle checked={edit.isActive !== false} onChange={(v) => setEdit({ ...edit, isActive: v })} label="Active" />
          </div>
        )}
      </Drawer>
    </div>
  );
}

function Analytics() {
  const money = useMoney();
  const [period, setPeriod] = useState('week');
  const a = useApi<any>(`/api/staff/delivery/analytics${qs({ period })}`, [period]);
  if (a.loading && !a.data) return <Loading />;
  if (a.error) return <ErrorState message={a.error} onRetry={a.reload} />;
  const d = a.data;
  return (
    <div className="space-y-4">
      <Select value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40"><option value="today">Today</option><option value="week">Last 7 days</option><option value="month">Last 30 days</option></Select>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Deliveries" value={d.total} sub={`${d.delivered} delivered · ${d.failed} failed/returned · ${d.cancelled} cancelled`} />
        <Stat label="On time" value={d.onTimeRatePercent != null ? `${d.onTimeRatePercent}%` : '—'} sub={`${d.late} late`} tone="brand" />
        <Stat label="Avg pickup → delivered" value={d.averageDeliveryMinutes != null ? `${d.averageDeliveryMinutes} min` : '—'} sub={`Order → delivered ${d.averageTotalMinutes ?? '—'} min`} />
        <Stat label="Delivery fees" value={money(d.feesCollected)} sub={`Prep avg ${d.averagePrepMinutes ?? '—'} min`} />
      </div>
      <p className="text-xs text-stone-500">{d.basis}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Riders" pad={false}>
          <DataTable rows={d.riders.map((r: any) => ({ ...r, _id: r.riderId }))} empty={<Empty title="No rider activity" />} columns={[
            { key: 'n', header: 'Rider', render: (r: any) => r.name },
            { key: 'd', header: 'Delivered', render: (r: any) => r.delivered },
            { key: 'o', header: 'On time', render: (r: any) => (r.onTimeRatePercent != null ? `${r.onTimeRatePercent}%` : '—') },
            { key: 'a', header: 'Avg min', render: (r: any) => r.averageDeliveryMinutes ?? '—' },
            { key: 'x', header: 'Declined / timed out / failed', render: (r: any) => `${r.rejected} / ${r.timeouts} / ${r.failed}` },
          ]} />
        </Card>
        <Card title="Zones" pad={false}>
          <DataTable rows={d.zones.map((z: any) => ({ ...z, _id: z.zone }))} empty={<Empty title="No deliveries" />} columns={[
            { key: 'z', header: 'Zone', render: (z: any) => z.zone },
            { key: 'o', header: 'Orders', render: (z: any) => z.orders },
            { key: 't', header: 'On time', render: (z: any) => (z.onTimeRatePercent != null ? `${z.onTimeRatePercent}%` : '—') },
            { key: 'f', header: 'Fees', className: 'text-end', render: (z: any) => money(z.fees) },
          ]} />
        </Card>
      </div>
      {d.peakHours.length > 0 && <Card title="Delivery orders by hour"><BarChart data={[...d.peakHours].sort((x: any, y: any) => x.hour - y.hour).map((h: any) => ({ label: `${String(h.hour).padStart(2, '0')}h`, value: h.orders }))} /></Card>}
    </div>
  );
}

function DeliverySettings() {
  const fb = useFeedback();
  const { tenant } = useAuth();
  const s: any = tenant?.settings?.delivery ?? {};
  const [v, setV] = useState<any>({ autoAssign: s.autoAssign ?? true, acceptTimeoutSec: s.acceptTimeoutSec ?? 120, maxAttempts: s.maxAttempts ?? 3, maxConcurrentPerRider: s.maxConcurrentPerRider ?? 2, delayGraceMinutes: s.delayGraceMinutes ?? 10, requireCode: s.requireCode ?? false, notifyCustomerSms: s.notifyCustomerSms ?? false });
  const save = async () => {
    try { await api.patch('/api/staff/delivery/settings', v); fb.push('success', 'Saved'); } catch (e: any) { fb.push('error', e.message); }
  };
  return (
    <Card title="Dispatch rules">
      <div className="grid gap-3 sm:grid-cols-2">
        <Toggle checked={v.autoAssign} onChange={(x) => setV({ ...v, autoAssign: x })} label="Assign riders automatically when an order is accepted" />
        <Toggle checked={v.requireCode} onChange={(x) => setV({ ...v, requireCode: x })} label="Rider must enter the customer's 4-digit code to complete" />
        <Toggle checked={v.notifyCustomerSms} onChange={(x) => setV({ ...v, notifyCustomerSms: x })} label="Text the customer on assignment, pickup, delivery and delays (needs SMS provider)" />
        <Field label="Seconds a rider has to accept"><Input type="number" min={30} max={1800} value={v.acceptTimeoutSec} onChange={(e) => setV({ ...v, acceptTimeoutSec: Number(e.target.value) })} /></Field>
        <Field label="Automatic attempts before asking a dispatcher"><Input type="number" min={1} max={10} value={v.maxAttempts} onChange={(e) => setV({ ...v, maxAttempts: Number(e.target.value) })} /></Field>
        <Field label="Max active deliveries per rider"><Input type="number" min={1} max={10} value={v.maxConcurrentPerRider} onChange={(e) => setV({ ...v, maxConcurrentPerRider: Number(e.target.value) })} /></Field>
        <Field label="Minutes late before alerting"><Input type="number" min={0} max={120} value={v.delayGraceMinutes} onChange={(e) => setV({ ...v, delayGraceMinutes: Number(e.target.value) })} /></Field>
      </div>
      <Button className="mt-3" onClick={save}>Save</Button>
    </Card>
  );
}
