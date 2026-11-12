import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw, Wifi } from 'lucide-react';
import { useOfflineOptional } from '../offline/OfflineProvider';
import { useAuth } from '../store/auth';
import type { OfflineOp } from '../offline/types';
import { Badge, Button, Drawer, useFeedback } from './ui';
import { cn, formatMoney, timeAgo } from '../lib/util';

const TYPE_LABEL: Record<string, string> = {
  'order.create': 'Order',
  'payment.cash': 'Cash payment',
  'kitchen.items': 'Kitchen update',
  'shift.movement': 'Cash in/out',
  'shift.close': 'Shift close',
};
const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warn' | 'good' | 'bad'> = { pending: 'warn', syncing: 'info', synced: 'good', failed: 'bad', conflict: 'bad' };
const STATUS_TEXT: Record<string, string> = { pending: 'Waiting to sync', syncing: 'Syncing…', synced: 'Confirmed by server', failed: 'Failed', conflict: 'Needs attention' };

/** Header status chip + offline banner + Sync centre drawer (restaurant dashboards only). */
export function OfflineIndicator() {
  const off = useOfflineOptional();
  const [open, setOpen] = useState(false);
  if (!off) return null;
  const s = off.summary;
  const attention = (s?.failed ?? 0) + (s?.conflict ?? 0);
  const waiting = (s?.pending ?? 0) + (s?.syncing ?? 0);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn('focus-ring flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition', off.online ? 'border-stone-200 bg-white text-stone-700 hover:border-stone-300' : 'border-amber-300 bg-amber-50 text-amber-900')}
        aria-label="Connection and synchronisation status"
      >
        {off.syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : off.online ? <Wifi className="h-3.5 w-3.5 text-emerald-600" /> : <CloudOff className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">{off.online ? 'Online' : 'Offline'}</span>
        {waiting > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-amber-900">{waiting}</span>}
        {attention > 0 && <span className="rounded-full bg-red-100 px-1.5 text-red-700">{attention}!</span>}
      </button>
      <SyncDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function OfflineBanner() {
  const off = useOfflineOptional();
  const { offlineSession } = useAuth();
  if (!off || (off.online && !offlineSession)) return null;
  return (
    <div className="no-print flex items-center justify-center gap-2 bg-amber-100 px-4 py-2 text-center text-sm text-amber-950" role="status">
      <CloudOff className="h-4 w-4 shrink-0" />
      {off.storageError
        ? `Offline and this browser cannot store data (${off.storageError}). Orders cannot be saved until the connection returns.`
        : 'Offline: orders, cash and kitchen updates are saved on this device and sync automatically when the connection returns. Card payments, coupons and refunds need the connection.'}
    </div>
  );
}

function SyncDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const off = useOfflineOptional()!;
  const { can, user, tenant } = useAuth();
  const fb = useFeedback();
  const [ops, setOps] = useState<OfflineOp[]>([]);
  const [fresh, setFresh] = useState<{ menu?: string; tables?: string; kitchen?: string }>({});
  const [quarantine, setQuarantine] = useState<any[]>([]);
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals);

  useEffect(() => {
    if (!open || !off.engine) return;
    const e = off.engine;
    Promise.all([e.ops(), e.snapshot('menu'), e.snapshot('tables'), e.snapshot('kitchen:'), e.quarantined()]).then(([o, m, t, k, q]) => {
      setOps(o.reverse());
      setFresh({ menu: m?.syncedAt, tables: t?.syncedAt, kitchen: k?.syncedAt });
      setQuarantine(q);
    });
  }, [open, off.engine, off.version]);

  const s = off.summary;
  const canResolve = (op: OfflineOp) => (op.type.startsWith('shift') ? can('shifts:manage') : can('orders:manage')) || op.userId === user?.id;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      fb.ok(ok);
      if (off.online) void off.syncNow();
    } catch (e) {
      fb.fail(e);
    }
  };
  const discard = async (op: OfflineOp) => {
    const reason = await fb.confirm({
      title: `Discard this ${TYPE_LABEL[op.type].toLowerCase()}?`,
      body: op.type === 'order.create' ? 'The order will never reach the server or the kitchen. Any cash recorded for it is flagged so it can be returned.' : 'It will never be sent to the server. The record stays on this device with your reason.',
      danger: true,
      input: { label: 'Reason (kept for the audit trail)', required: true },
      confirmLabel: 'Discard',
    });
    if (typeof reason !== 'string') return;
    act(() => off.engine!.discard(op.id, user!.name, reason), 'Discarded');
  };

  const rows: [string, string | number][] = [
    ['Connection', off.online ? 'Online' : 'Offline'],
    ['Last successful sync', s?.lastSyncAt ? `${new Date(s.lastSyncAt).toLocaleString()} (${timeAgo(s.lastSyncAt)} ago)` : 'Not yet'],
    ['Orders waiting', s?.pendingOrders ?? 0],
    ['Kitchen updates waiting', s?.pendingKitchen ?? 0],
    ['Cash payments waiting', s?.pendingPayments ?? 0],
    ['Shift records waiting', s?.pendingShift ?? 0],
    ['Failed', s?.failed ?? 0],
    ['Conflicts', s?.conflict ?? 0],
    ['Menu & prices on this device', fresh.menu ? `as of ${new Date(fresh.menu).toLocaleString()}` : 'not downloaded yet: open the POS once while online'],
    ['Tables on this device', fresh.tables ? `as of ${new Date(fresh.tables).toLocaleString()}` : 'not downloaded yet'],
  ];

  return (
    <Drawer open={open} onClose={onClose} title="Sync centre" footer={<Button onClick={() => off.syncNow()} loading={off.syncing} disabled={!off.online || !off.engine}><RefreshCw className="h-4 w-4" /> Sync now</Button>}>
      {off.storageError && <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">Offline storage unavailable: {off.storageError}</p>}
      {off.lastError && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{off.lastError}</p>}
      <dl className="space-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3"><dt className="text-stone-500">{k}</dt><dd className="text-end font-medium">{v}</dd></div>
        ))}
      </dl>
      {quarantine.length > 0 && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="me-1 inline h-4 w-4" />{quarantine.length} unreadable record(s) were set aside on this device and not sent. Ask your administrator before clearing this browser’s data.</p>}

      <p className="label mt-6">Records on this device</p>
      {ops.length === 0 ? <p className="text-sm text-stone-500">Nothing recorded offline.</p> : (
        <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 text-sm">
          {ops.slice(0, 100).map((op) => (
            <li key={op.id} className="space-y-1.5 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{TYPE_LABEL[op.type]}</span>
                {op.type === 'payment.cash' && <span className="tabular-nums">{money(op.payload.amount)}</span>}
                {op.type === 'shift.movement' && <span className="tabular-nums">{op.payload.type === 'in' ? '+' : '−'}{money(op.payload.amount)}</span>}
                <Badge tone={op.resolution?.action === 'discarded' ? 'neutral' : STATUS_TONE[op.status]} dot>{op.resolution?.action === 'discarded' ? 'Discarded' : STATUS_TEXT[op.status]}</Badge>
                {op.status === 'synced' && op.result?.order?.orderNumber && <span className="text-xs text-stone-500">Order #{op.result.order.orderNumber}</span>}
                <span className="ms-auto text-xs text-stone-400">{new Date(op.createdAt).toLocaleString()}</span>
              </div>
              {op.waitingFor && op.status === 'pending' && <p className="text-xs text-stone-500">{op.waitingFor}</p>}
              {op.lastError && op.status !== 'synced' && <p className={cn('text-xs', op.status === 'pending' ? 'text-stone-500' : 'text-red-700')}>{op.lastError.message}{op.retryCount > 0 && op.status === 'pending' ? ` · attempt ${op.retryCount}, retrying automatically` : ''}</p>}
              {op.resolution && <p className="text-xs text-stone-500">{op.resolution.action === 'discarded' ? `Discarded by ${op.resolution.by}: ${op.resolution.reason}` : op.resolution.action === 'accepted_server_price' ? `Server price accepted by ${op.resolution.by}` : ''}</p>}
              {(op.status === 'failed' || op.status === 'conflict') && op.resolution?.action !== 'discarded' && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {op.lastError?.code === 'PRICE_CHANGED' && can('orders:create') && (
                    <Button size="sm" onClick={() => act(() => off.engine!.acceptServerPrice(op.id, user!.name), 'Server price accepted')}>Accept server price {money((op.lastError.details as any)?.serverTotal ?? 0)}</Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => act(() => off.engine!.retry(op.id, user!.name), 'Will retry')}>Retry</Button>
                  {canResolve(op) && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => discard(op)}>Discard…</Button>}
                </div>
              )}
              {op.status === 'synced' && <p className="flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Confirmed {op.syncedAt ? new Date(op.syncedAt).toLocaleTimeString() : ''}</p>}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
