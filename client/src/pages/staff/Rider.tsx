import { useEffect, useRef, useState } from 'react';
import { MapPin, Phone, RefreshCw } from 'lucide-react';
import { api } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useSocket } from '../../hooks/useSocket';
import { useAuth } from '../../store/auth';
import { Badge, Button, Card, Empty, ErrorState, Input, Loading, PageHeader, Toggle, useFeedback } from '../../components/ui';
import { formatMoney, timeAgo } from '../../lib/util';
import { DELIVERY_LABEL } from '../owner/Delivery';
import { Bike as HeaderIcon } from 'lucide-react';

/** Rider app: the rider's own deliveries only. Location is sent only while sharing is on and the rider is available. */
export default function Rider() {
  const fb = useFeedback();
  const { tenant } = useAuth();
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals);
  const me = useApi<any>('/api/staff/delivery/me');
  const [busy, setBusy] = useState<string | null>(null);
  const watch = useRef<number | null>(null);
  const lastSent = useRef(0);
  useSocket({
    'delivery:assigned': (o: any) => { fb.push('info', `New delivery #${o.orderNumber ?? ''}`); me.reload(); try { navigator.vibrate?.(300); } catch { /* not supported */ } },
    'delivery:updated': () => me.reload(),
    'delivery:withdrawn': () => { fb.push('info', 'A delivery was reassigned'); me.reload(); },
  }, { onConnect: () => me.reload() });

  const p = me.data?.profile ?? {};
  // Location sharing uses the browser's permission prompt; we send at most one update per 30 s.
  useEffect(() => {
    if (!p.locationSharing || !p.available || !('geolocation' in navigator)) return;
    watch.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (Date.now() - lastSent.current < 30_000) return;
        lastSent.current = Date.now();
        api.post('/api/staff/delivery/me/location', { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => undefined);
      },
      () => undefined,
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => { if (watch.current != null) navigator.geolocation.clearWatch(watch.current); };
  }, [p.locationSharing, p.available]);

  const setProfile = async (body: any) => {
    try { await api.patch('/api/staff/delivery/me', body); me.reload(); } catch (e: any) { fb.push('error', e.message); }
  };
  const act = async (id: string, action: string, body: any = {}) => {
    if (action === 'reject' || action === 'fail') {
      const reason = await fb.confirm({ title: action === 'reject' ? 'Decline this delivery?' : 'Mark delivery as failed?', input: { label: 'Reason', required: true }, danger: true });
      if (typeof reason !== 'string') return;
      body.reason = reason;
    }
    setBusy(id + action);
    try { await api.post(`/api/staff/delivery/orders/${id}/rider/${action}`, body); me.reload(); } catch (e: any) { fb.push('error', e.message); } finally { setBusy(null); }
  };

  if (me.loading && !me.data) return <Loading />;
  if (me.error) return <ErrorState message={me.error} onRetry={me.reload} />;
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader icon={HeaderIcon} accent="amber" title="My deliveries" subtitle={`${me.data.deliveredLast24h} delivered in the last 24 hours`} actions={<Button size="sm" variant="ghost" onClick={me.reload} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>} />
      <Card className="mb-4">
        <div className="space-y-3">
          <Toggle checked={!!p.available} onChange={(v) => setProfile({ available: v })} label={p.available ? 'Available for deliveries' : 'Not available (no new deliveries)'} />
          <Toggle checked={!!p.locationSharing} onChange={(v) => setProfile({ locationSharing: v })} label="Share my location with the restaurant while available" />
          <p className="text-xs text-stone-500">Your location is used only to pick the nearest rider and is deleted when you go unavailable or stop sharing. Customers never see it.</p>
        </div>
      </Card>
      {me.data.deliveries.length === 0 ? <Card><Empty title="No deliveries assigned" hint={p.available ? 'New deliveries appear here automatically.' : 'Turn on availability to receive deliveries.'} /></Card> : (
        <div className="space-y-3">
          {me.data.deliveries.map((o: any) => <DeliveryCard key={o._id} o={o} money={money} busy={busy} act={act} />)}
        </div>
      )}
    </div>
  );
}

function DeliveryCard({ o, money, busy, act }: { o: any; money: (n: number) => string; busy: string | null; act: (id: string, a: string, b?: any) => void }) {
  const [code, setCode] = useState('');
  const st = o.delivery.status;
  const maps = o.delivery.location?.lat != null ? `https://www.google.com/maps/search/?api=1&query=${o.delivery.location.lat},${o.delivery.location.lng}` : o.delivery.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.delivery.address)}` : null;
  return (
    <Card>
      <div className="flex items-center justify-between gap-2"><span className="text-lg font-semibold">#{o.orderNumber}</span><Badge tone={st === 'assigned' ? 'warn' : 'brand'}>{DELIVERY_LABEL[st]}</Badge></div>
      <div className="mt-2 space-y-1 text-sm">
        <div className="font-medium">{o.customer?.name ?? 'Customer'}</div>
        {o.customer?.phone && <a href={`tel:${o.customer.phone}`} className="flex items-center gap-1 text-brand"><Phone className="h-4 w-4" /> {o.customer.phone}</a>}
        <div>{o.delivery.zoneName ? <Badge className="me-1">{o.delivery.zoneName}</Badge> : null}{o.delivery.address}</div>
        {o.delivery.notes && <div className="text-stone-500">{o.delivery.notes}</div>}
        {maps && <a href={maps} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand"><MapPin className="h-4 w-4" /> Open in maps</a>}
        <ul className="list-disc ps-5 text-stone-600">{o.items.map((i: any, k: number) => <li key={k}>{i.quantity}× {i.name}{i.variantName ? ` (${i.variantName})` : ''}</li>)}</ul>
        <div className="font-semibold">{o.amountDue > 0 ? `Collect ${money(o.amountDue)}` : 'Paid'}</div>
        {o.delivery.etaAt && <div className="text-xs text-stone-500">Due {new Date(o.delivery.etaAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · assigned {timeAgo(o.delivery.assignedAt)} · kitchen: {o.status}</div>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {st === 'assigned' && <><Button onClick={() => act(o._id, 'accept')} loading={busy === o._id + 'accept'}>Accept</Button><Button variant="ghost" onClick={() => act(o._id, 'reject')}>Decline</Button></>}
        {st === 'rider_accepted' && <><Button onClick={() => act(o._id, 'pickup')} loading={busy === o._id + 'pickup'} disabled={o.status !== 'ready'}>{o.status === 'ready' ? 'Picked up' : 'Waiting for kitchen'}</Button><Button variant="ghost" onClick={() => act(o._id, 'reject')}>Decline</Button></>}
        {st === 'picked_up' && <Button onClick={() => act(o._id, 'on_the_way')}>On the way</Button>}
        {(st === 'picked_up' || st === 'on_the_way') && (
          <div className="flex w-full flex-wrap items-center gap-2">
            <Input inputMode="numeric" maxLength={4} placeholder="Customer code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="w-36" />
            <Button onClick={() => act(o._id, 'deliver', code ? { code } : {})} loading={busy === o._id + 'deliver'}>Delivered</Button>
            <Button variant="danger" onClick={() => act(o._id, 'fail')}>Could not deliver</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
