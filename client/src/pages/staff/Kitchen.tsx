import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, BellRing, CloudOff, Check, ChefHat, Flame, Maximize, PencilLine, Undo2, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react';
import { api, isNetworkFailure, qs } from '../../api/client';
import { useOffline } from '../../offline/OfflineProvider';
import { useSocket, beep } from '../../hooks/useSocket';
import { useAuth } from '../../store/auth';
import { useApi } from '../../hooks/useApi';
import { Button, Loading, useFeedback } from '../../components/ui';
import { cn, ORDER_TYPE_LABEL } from '../../lib/util';

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function elapsed(from: string | undefined, now: number) {
  if (!from) return { label: '—', mins: 0 };
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  return { label: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, mins: s / 60 };
}

const readPref = (k: string, d: string) => {
  try { return localStorage.getItem(k) ?? d; } catch { return d; }
};
const writePref = (k: string, v: string) => {
  try { localStorage.setItem(k, v); } catch { /* storage unavailable */ }
};

/**
 * Kitchen Display. Tickets show only the items routed to the selected station. Timing:
 *  - expected = the longest configured preparation time of the ticket's dishes (Menu → dish → prep minutes);
 *  - "due" once that time has passed, "late" after the restaurant's grace minutes (Settings → POS & kitchen).
 * Dishes without a prep time are never flagged (no invented durations).
 */
export default function Kitchen() {
  const fb = useFeedback();
  const { user } = useAuth();
  const stations = useApi<{ items: any[] }>('/api/staff/menu/stations?limit=100');
  const [stationId, setStationId] = useState<string>(() => readPref('kds:station', user?.stationIds?.length === 1 ? user.stationIds[0] : ''));
  const [orders, setOrders] = useState<any[] | null>(null);
  const [grace, setGrace] = useState(5);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sound, setSound] = useState(() => readPref('kds:sound', 'on') === 'on');
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const alerted = useRef(new Set<string>());
  const now = useNow();

  const ping = (f: number, ms: number) => soundRef.current && beep(f, ms);

  const off = useOffline();
  const offline = !off.online;
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [localTickets, setLocalTickets] = useState<any[]>([]);
  const [pending, setPending] = useState<{ items: Map<string, string>; orders: Set<string> }>({ items: new Map(), orders: new Set() });
  const [snapStations, setSnapStations] = useState<any[]>([]);

  // Live queue when online (saved on this device); the last saved queue when the server cannot be reached.
  const load = useCallback(async () => {
    const key = `kitchen:${stationId}`;
    try {
      const r = await api.get(`/api/staff/kitchen/queue${qs({ stationId })}`);
      setOrders(r.items);
      setGrace(r.delayGraceMinutes ?? 5);
      setSnapshotAt(null);
      await off.engine?.saveSnapshot(key, { items: r.items, delayGraceMinutes: r.delayGraceMinutes });
    } catch (e) {
      if (!isNetworkFailure(e)) return fb.fail(e);
      off.reportOffline();
      const snap = await off.engine?.snapshot(key);
      if (snap) {
        setOrders(snap.data.items);
        setGrace(snap.data.delayGraceMinutes ?? 5);
        setSnapshotAt(snap.syncedAt);
      } else setOrders((o) => o ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId, off.engine]);

  // Orders created offline on THIS device (POS in another tab) and kitchen actions waiting to sync.
  useEffect(() => {
    const e = off.engine;
    if (!e) return;
    Promise.all([e.orders(), e.ops(), e.snapshot('menu')]).then(([orders, ops, menu]) => {
      setSnapStations(menu?.data?.stations ?? []);
      setLocalTickets(
        orders
          .filter((o) => !o.serverOrderId && o.syncState !== 'confirmed')
          .map((o) => ({
            _id: o.localId, _local: true, orderNumber: o.localNumber, type: o.type, tableLabel: o.tableLabel, customer: o.customer, notes: o.notes, status: 'accepted', acceptedAt: o.createdAt, createdAt: o.createdAt,
            items: o.items.map((i, idx) => ({ ...i, _id: `${o.localId}:${idx}`, _index: idx })),
          }))
          .map((o) => (stationId ? { ...o, items: o.items.filter((i: any) => String(i.stationId ?? '') === stationId) } : o))
          .filter((o) => o.items.length),
      );
      const items = new Map<string, string>();
      const ords = new Set<string>();
      for (const op of ops) {
        if (op.type !== 'kitchen.items' || op.status === 'synced' || op.resolution) continue;
        if (op.payload.orderId) ords.add(op.payload.orderId);
        if (op.localOrderId) ords.add(op.localOrderId);
        for (const r of op.payload.items ?? []) if (r.itemId) items.set(r.itemId, op.payload.status);
      }
      setPending({ items, orders: ords });
    });
  }, [off.engine, off.version, stationId]);
  useEffect(() => {
    writePref('kds:station', stationId);
    load();
  }, [stationId, load]);
  useEffect(() => {
    if (!offline) load(); // connection back or a sync finished: replace the saved copy with the live queue
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline, off.summary?.lastSyncAt]);

  const filterForStation = (o: any) => (stationId ? { ...o, items: o.items.filter((i: any) => String(i.stationId) === stationId) } : o);
  const upsert = (o: any) => {
    const view = filterForStation(o);
    setOrders((prev) => {
      const rest = (prev ?? []).filter((x) => x._id !== o._id);
      const inKitchen = ['accepted', 'preparing', 'partially_ready', 'ready'].includes(o.status) && view.items.length > 0;
      return inKitchen ? [...rest, view] : rest;
    });
  };
  const highlight = (id: string) => {
    setFlash(id);
    setTimeout(() => setFlash(null), 4000);
  };

  const { connected } = useSocket(
    {
      'kitchen:new': (o) => {
        if (!filterForStation(o).items.length) return;
        ping(988, 220);
        setTimeout(() => ping(1318, 220), 260);
        highlight(o._id);
        upsert(o);
      },
      'kitchen:updated': upsert,
      'kitchen:modified': (o) => {
        if (!['accepted', 'preparing', 'partially_ready', 'ready'].includes(o.status)) return upsert(o);
        ping(660, 300);
        highlight(o._id);
        upsert(o);
      },
      // Orders accepted while the screen was offline never arrive as events: reload the queue.
      reconnect: () => load(),
    },
    { onConnect: (s) => stationId && s.emit('kitchen:watchStation', stationId) },
  );

  const act = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    try {
      upsert(await fn());
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };
  /**
   * Kitchen action. Online: straight to the server. Offline (or if the request fails for network reasons):
   * saved on this device with its time and cook, shown at once, and synchronised later.
   */
  const queueLocally = async (o: any, items: any[], status: 'preparing' | 'ready') => {
    if (!off.engine) throw new Error(off.storageError ? `This browser cannot store kitchen actions offline (${off.storageError})` : 'Offline storage is still opening');
    if (o._local) await off.engine.kitchen({ localOrderId: o._id }, items.map((i) => ({ index: i._index })), status);
    else {
      await off.engine.kitchen({ orderId: o._id }, items.map((i) => ({ itemId: i._id })), status);
      // Optimistic local view of a server ticket (the saved queue is updated too, so a refresh keeps it).
      const at = new Date().toISOString();
      const next = { ...o, items: o.items.map((i: any) => (items.some((x) => x._id === i._id) ? { ...i, status, startedAt: i.startedAt ?? at, readyAt: status === 'ready' ? at : i.readyAt, startedBy: i.startedBy ?? user?.name } : i)) };
      upsert(next);
      const key = `kitchen:${stationId}`;
      const snap = await off.engine.snapshot(key);
      if (snap) await off.engine.saveSnapshot(key, { ...snap.data, items: snap.data.items.map((x: any) => (x._id === o._id ? next : x)) });
    }
  };
  const runKitchen = async (key: string, o: any, items: any[], status: 'preparing' | 'ready', online: () => Promise<any>) => {
    setBusy(key);
    try {
      if (offline || o._local) await queueLocally(o, items, status);
      else {
        try {
          upsert(await online());
        } catch (e) {
          if (!isNetworkFailure(e)) throw e;
          off.reportOffline();
          await queueLocally(o, items, status);
        }
      }
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };
  const itemTo = (o: any, item: any, status: 'preparing' | 'ready') => runKitchen(item._id, o, [item], status, () => api.post(`/api/staff/orders/${o._id}/items/${item._id}/status`, { status }));
  // Bulk actions apply to the items this screen shows (this station), in one request.
  const ticketTo = (o: any, status: 'preparing' | 'ready') => {
    const items = o.items.filter((i: any) => (status === 'preparing' ? i.status === 'queued' : i.status === 'queued' || i.status === 'preparing'));
    if (items.length) runKitchen(`${o._id}:${status}`, o, items, status, () => api.post(`/api/staff/orders/${o._id}/items/bulk-status`, { itemIds: items.map((i: any) => i._id), status }));
  };
  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    writePref('kds:sound', next ? 'on' : 'off');
    if (next) beep(880, 120); // also unlocks audio: browsers allow sound after a tap
  };

  const stationList = stations.data?.items ?? snapStations;
  const stationName = new Map(stationList.map((s: any) => [s._id, s.name]));
  const expectedMins = (o: any) => Math.max(0, ...o.items.filter((i: any) => i.status !== 'cancelled').map((i: any) => i.prepMinutes ?? 0));
  // Actions still waiting to sync are shown as already done (with a "pending sync" marker).
  const withPending = (orders ?? []).map((o) => (pending.orders.has(o._id) ? { ...o, items: o.items.map((i: any) => (pending.items.has(i._id) ? { ...i, status: pending.items.get(i._id) } : i)) } : o));
  const sorted = [...withPending, ...localTickets].sort((a, b) => +new Date(a.acceptedAt ?? a.createdAt) - +new Date(b.acceptedAt ?? b.createdAt));
  const active = sorted.filter((o) => o.items.some((i: any) => i.status === 'queued' || i.status === 'preparing'));
  const done = sorted.filter((o) => !active.includes(o));

  // One alert sound per ticket when it becomes late.
  useEffect(() => {
    for (const o of active) {
      const exp = expectedMins(o);
      if (exp > 0 && elapsed(o.acceptedAt ?? o.createdAt, now).mins > exp + grace && !alerted.current.has(o._id)) {
        alerted.current.add(o._id);
        ping(440, 500);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  return (
    <div className="-m-4 min-h-[calc(100vh-4rem)] bg-stone-950 p-4 text-stone-100 sm:-m-6 sm:p-6 lg:-my-8">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <ChefHat className="h-6 w-6 text-amber-400" />
        <h1 className="font-display text-2xl font-semibold">Kitchen</h1>
        <span className={cn('flex items-center gap-1 rounded-full px-2 py-0.5 text-xs', connected ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300')}>{connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}{connected ? 'Live' : 'Reconnecting…'}</span>
        {snapshotAt && <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-200">Offline · tickets as of {new Date(snapshotAt).toLocaleTimeString()}</span>}
        <span className="text-xs text-stone-400">{active.length} cooking · {done.length} ready</span>
        <div className="ms-auto flex max-w-full gap-1 overflow-x-auto rounded-xl bg-white/5 p-1">
          <button onClick={() => setStationId('')} className={cn('rounded-lg px-3 py-1.5 text-sm', !stationId ? 'bg-white text-stone-900' : 'text-stone-300 hover:bg-white/10')}>All stations</button>
          {stationList.filter((s: any) => s.isActive).map((s: any) => (
            <button key={s._id} onClick={() => setStationId(s._id)} className={cn('whitespace-nowrap rounded-lg px-3 py-1.5 text-sm', stationId === s._id ? 'bg-white text-stone-900' : 'text-stone-300 hover:bg-white/10')}>
              <span className="me-1.5 inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon" className="text-stone-300 hover:bg-white/10 hover:text-white" onClick={toggleSound} aria-label={sound ? 'Mute alerts' : 'Turn alert sound on'} title={sound ? 'Sound on — tap to mute' : 'Muted — tap to turn sound on'}>{sound ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}</Button>
        <Button variant="ghost" size="icon" className="text-stone-300 hover:bg-white/10 hover:text-white" onClick={() => document.documentElement.requestFullscreen?.()} aria-label="Full screen"><Maximize className="h-4 w-4" /></Button>
      </div>

      {!orders ? <Loading label="Loading tickets…" /> : active.length === 0 && done.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-32 text-stone-500"><ChefHat className="mb-3 h-10 w-10" /><p>No tickets. New confirmed orders appear here instantly.</p></div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {active.map((o) => {
              const t = elapsed(o.acceptedAt ?? o.createdAt, now);
              const exp = expectedMins(o);
              const late = exp > 0 && t.mins > exp + grace;
              const due = exp > 0 && !late && t.mins >= exp;
              const modified = (o.modifications ?? []).some((m: any) => ['items_added', 'item_changed', 'item_cancelled'].includes(m.action));
              const anyQueued = o.items.some((i: any) => i.status === 'queued');
              return (
                <article key={o._id} className={cn('flex flex-col overflow-hidden rounded-2xl bg-stone-900 ring-1 ring-white/10', flash === o._id && 'animate-pulse2 ring-4 ring-amber-400', late && 'ring-2 ring-red-500')}>
                  <header className={cn('flex items-center justify-between gap-2 px-4 py-3', late ? 'bg-red-600' : due ? 'bg-amber-500 text-stone-950' : 'bg-white/5')}>
                    <div className="min-w-0">
                      <p className="font-display text-xl font-semibold">#{o.orderNumber}</p>
                      <p className="truncate text-xs opacity-80">{ORDER_TYPE_LABEL[o.type] ?? o.type}{o.tableLabel ? ` · Table ${o.tableLabel}` : ''}{o.customer?.name && o.type !== 'dine_in' ? ` · ${o.customer.name}` : ''}</p>
                    </div>
                    <div className="text-end">
                      <p className="font-mono text-2xl font-semibold tabular-nums">{t.label}</p>
                      <p className="text-[11px] opacity-80">{late ? <><AlertTriangle className="me-0.5 inline h-3 w-3" />late</> : exp ? `target ${exp} min` : 'no prep time set'}</p>
                    </div>
                  </header>
                  {o._local && <p className="flex items-center gap-1.5 border-b border-white/10 bg-amber-500/20 px-4 py-1.5 text-xs text-amber-100"><CloudOff className="h-3.5 w-3.5" /> Taken offline on this device · not yet on the server</p>}
                  {!o._local && pending.orders.has(o._id) && <p className="flex items-center gap-1.5 border-b border-white/10 bg-amber-500/20 px-4 py-1.5 text-xs text-amber-100"><CloudOff className="h-3.5 w-3.5" /> Kitchen updates saved on this device · pending sync</p>}
                  {modified && <p className="flex items-center gap-1.5 border-b border-white/10 bg-sky-500/15 px-4 py-1.5 text-xs text-sky-200"><PencilLine className="h-3.5 w-3.5" /> Changed after it was sent — check the items</p>}
                  {o.notes && <p className="border-b border-white/10 bg-amber-400/10 px-4 py-2 text-sm text-amber-200">⚠ {o.notes}</p>}
                  <ul className="flex-1 divide-y divide-white/5">
                    {o.items.map((i: any) => (
                      <li key={i._id} className={cn('flex items-start gap-3 px-4 py-3', i.status === 'ready' && 'opacity-40', i.status === 'cancelled' && 'opacity-30')}>
                        <span className="mt-0.5 min-w-[2rem] rounded-md bg-white/10 px-1.5 py-0.5 text-center font-semibold tabular-nums">{i.quantity}</span>
                        <div className="min-w-0 flex-1">
                          <p className={cn('font-medium leading-snug', i.status === 'cancelled' && 'line-through')}>{i.name}{i.variantName && <span className="text-amber-300"> · {i.variantName}</span>}</p>
                          {i.addons?.length > 0 && <p className="text-xs text-stone-400">+ {i.addons.map((a: any) => a.name).join(', ')}</p>}
                          {i.notes && <p className="text-xs italic text-amber-300">“{i.notes}”</p>}
                          {i.status === 'cancelled' && <p className="text-xs text-red-300">Removed{i.cancelReason ? `: ${i.cancelReason}` : ''}</p>}
                          {i.addedAt && i.status !== 'cancelled' && <p className="text-xs text-sky-300">Added later</p>}
                          {!stationId && i.stationId && <p className="text-[11px] uppercase tracking-wide text-stone-500">{stationName.get(String(i.stationId)) ?? ''}</p>}
                        </div>
                        {i.status === 'queued' && <Button size="sm" className="bg-white/10 text-white hover:bg-white/20" loading={busy === i._id} onClick={() => itemTo(o, i, 'preparing')}><Flame className="h-3.5 w-3.5" /> Start</Button>}
                        {i.status === 'preparing' && <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-500" loading={busy === i._id} onClick={() => itemTo(o, i, 'ready')}><Check className="h-3.5 w-3.5" /> Ready</Button>}
                        {i.status === 'ready' && <button className="text-stone-400 hover:text-white" onClick={() => itemTo(o, i, 'preparing')} aria-label="Undo ready"><Undo2 className="h-4 w-4" /></button>}
                      </li>
                    ))}
                  </ul>
                  <div className="grid grid-cols-2">
                    <button disabled={!anyQueued || !!busy} onClick={() => ticketTo(o, 'preparing')} className="flex items-center justify-center gap-2 bg-white/5 py-3 text-sm font-semibold text-stone-200 transition hover:bg-white/10 disabled:opacity-40"><Flame className="h-4 w-4" /> Start all</button>
                    <button disabled={!!busy} onClick={() => ticketTo(o, 'ready')} className="flex items-center justify-center gap-2 bg-emerald-600 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-60"><BellRing className="h-4 w-4" /> {stationId ? 'Station ready' : 'All ready'}</button>
                  </div>
                </article>
              );
            })}
          </div>
          {done.length > 0 && (
            <>
              <p className="mb-2 mt-8 text-xs font-semibold uppercase tracking-wider text-stone-500">{stationId ? 'Done at this station' : 'Ready — waiting for pickup'}</p>
              <div className="flex flex-wrap gap-2">
                {done.map((o) => <span key={o._id} className="rounded-xl bg-emerald-600/20 px-4 py-2 font-display text-lg font-semibold text-emerald-300">#{o.orderNumber}{o.tableLabel && <span className="ms-2 text-xs font-normal">T{o.tableLabel.replace(/^T/i, '')}</span>}{o.status !== 'ready' && <span className="ms-2 text-xs font-normal text-amber-300">other stations cooking</span>}</span>)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
