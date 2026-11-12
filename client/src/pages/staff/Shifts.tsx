import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Lock, Unlock } from 'lucide-react';
import { api, isNetworkFailure, qs } from '../../api/client';
import { useOffline } from '../../offline/OfflineProvider';
import type { OfflineOp } from '../../offline/types';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../store/auth';
import { Badge, Button, Card, DataTable, Empty, ErrorState, Field, Input, Loading, Modal, PageHeader, Pagination, Stat, useFeedback } from '../../components/ui';
import { cn, formatMoney, toMinor } from '../../lib/util';
import { Banknote as HeaderIcon } from 'lucide-react';

/** Cashier shift / cash drawer: open with a float, record cash in/out, close by counting the drawer. */
export default function Shifts() {
  const { tenant, can } = useAuth();
  const fb = useFeedback();
  const dec = tenant?.settings?.currencyDecimals ?? 2;
  const money = (n?: number | null) => formatMoney(n ?? 0, tenant?.settings?.currency, dec);
  const current = useApi<any>(can('shifts:operate') ? '/api/staff/shifts/current' : null);
  const [page, setPage] = useState(1);
  const history = useApi<any>(`/api/staff/shifts${qs({ page, limit: 20 })}`, [page]);
  const [dialog, setDialog] = useState<null | 'open' | 'in' | 'out' | 'close'>(null);
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<any | null>(null);

  const off = useOffline();
  const { user } = useAuth();
  const [snap, setSnap] = useState<{ data: any; syncedAt: string } | null>(null);
  const [localOps, setLocalOps] = useState<OfflineOp[]>([]);
  // Keep a copy of the open shift on this device; use it when the server cannot be reached.
  useEffect(() => {
    if (current.data) void off.engine?.saveSnapshot('shift', current.data);
    else if (current.error && off.engine) off.engine.snapshot('shift').then((s) => setSnap(s ?? null));
  }, [current.data, current.error, off.engine]);
  useEffect(() => {
    off.engine?.ops().then((o) => setLocalOps(o.filter((x) => x.status !== 'synced' && !x.resolution && x.userId === user?.id)));
  }, [off.engine, off.version, user?.id]);
  useEffect(() => {
    if (off.online) current.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [off.online, off.summary?.lastSyncAt]);

  const fromDevice = !current.data && !!snap;
  const base = current.data ?? snap?.data;
  const shift = base?.shift;
  // Cash recorded on this device but not yet on the server is included, and marked as such.
  const unsynced = localOps.filter((o) => o.type === 'payment.cash' || (o.type === 'shift.movement' && o.payload.shiftId === shift?._id));
  const localDelta = unsynced.reduce((d, o) => d + (o.type === 'payment.cash' ? o.payload.amount : o.payload.type === 'in' ? o.payload.amount : -o.payload.amount), 0);
  const t = base?.totals ? { ...base.totals, expectedCash: base.totals.expectedCash + localDelta } : null;
  const closePending = localOps.some((o) => o.type === 'shift.close' && o.payload.shiftId === shift?._id);
  const reload = () => { current.reload(); history.reload(); };

  const submit = async () => {
    setBusy(true);
    try {
      const v = toMinor(amount, dec);
      if (dialog === 'open') {
        if (!off.online) throw new Error('Opening a shift needs a connection. An already open shift keeps working offline.');
        await api.post('/api/staff/shifts/open', { openingFloat: v, notes: text || undefined });
      }
      const queue = async () => {
        if (!off.engine) throw new Error('Offline storage is not available on this device');
        if (dialog === 'close') await off.engine.shiftClose(shift._id, v, text || undefined);
        else await off.engine.shiftMovement(shift._id, dialog as 'in' | 'out', v, text);
        fb.ok(dialog === 'close' ? 'Close saved on this device. The shift is closed on the server only once it syncs.' : 'Saved on this device; it syncs when the connection returns.');
      };
      if (dialog === 'in' || dialog === 'out' || dialog === 'close') {
        if (!off.online) {
          await queue();
          setDialog(null);
          setAmount('');
          setText('');
          return;
        }
        try {
          if (dialog === 'close') setView(await api.post(`/api/staff/shifts/${shift._id}/close`, { countedCash: v, notes: text || undefined }));
          else await api.post(`/api/staff/shifts/${shift._id}/movements`, { type: dialog, amount: v, reason: text });
        } catch (e) {
          if (!isNetworkFailure(e)) throw e;
          off.reportOffline();
          await queue();
          setDialog(null);
          setAmount('');
          setText('');
          return;
        }
      }
      fb.ok({ open: 'Shift opened', in: 'Cash in recorded', out: 'Cash out recorded', close: 'Shift closed' }[dialog!]);
      setDialog(null);
      setAmount('');
      setText('');
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="emerald" title="Cash shifts" subtitle="Expected cash = opening float + cash sales − cash refunds + cash in − cash out, from recorded transactions." />
      {can('shifts:operate') && (
        current.loading && !current.data && !snap ? <Loading /> : current.error && !fromDevice ? <ErrorState message={current.error} onRetry={current.reload} /> : (
          <Card
            className="mb-6"
            title={shift ? <span className="flex items-center gap-2"><Unlock className="h-4 w-4 text-emerald-600" /> Your shift is open</span> : <span className="flex items-center gap-2"><Lock className="h-4 w-4 text-stone-400" /> No open shift</span>}
            actions={shift ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setDialog('in')}><ArrowDownToLine className="h-4 w-4" /> Cash in</Button>
                <Button size="sm" variant="outline" onClick={() => setDialog('out')}><ArrowUpFromLine className="h-4 w-4" /> Cash out</Button>
                <Button size="sm" variant="danger" disabled={closePending} onClick={() => setDialog('close')}>{closePending ? 'Close pending sync' : 'Close shift'}</Button>
              </div>
            ) : <Button onClick={() => setDialog('open')}>Open shift</Button>}
          >
            {shift ? (
              <>
                {(fromDevice || unsynced.length > 0 || closePending) && (
                  <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    {fromDevice ? `Offline: figures from ${new Date(snap!.syncedAt).toLocaleString()}. ` : ''}
                    {unsynced.length > 0 ? `Includes ${unsynced.length} cash record(s) saved on this device and not yet confirmed by the server. ` : ''}
                    {closePending ? 'The close is saved on this device; the shift is closed on the server only after it syncs.' : ''}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="Opening float" value={money(shift.openingFloat)} sub={`since ${new Date(shift.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`} />
                  <Stat label="Cash sales" value={money(t.cashSales)} sub={`${t.cashSalesCount} payment(s) · refunds ${money(t.cashRefunds)}`} />
                  <Stat label="Card terminal" value={money(t.cardTerminal)} sub="Not in the drawer" />
                  <Stat label="Expected in drawer" value={money(t.expectedCash)} tone="brand" sub={`in ${money(t.cashIn)} · out ${money(t.cashOut)}`} />
                </div>
                {shift.movements?.length > 0 && (
                  <ul className="mt-4 divide-y divide-stone-100 rounded-xl border border-stone-200 text-sm">
                    {shift.movements.map((m: any) => (
                      <li key={m._id} className="flex items-center gap-3 px-4 py-2">
                        <Badge tone={m.type === 'in' ? 'good' : 'warn'}>{m.type === 'in' ? 'Cash in' : 'Cash out'}</Badge>
                        <span className="flex-1">{m.reason}</span>
                        <span className="tabular-nums">{money(m.amount)}</span>
                        <span className="text-xs text-stone-400">{new Date(m.at).toLocaleTimeString()} · {m.by}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : <p className="text-sm text-stone-500">{current.data?.required ? 'This restaurant requires an open shift before cash can be accepted.' : 'Open a shift to track your cash drawer. Card and online payments do not need one.'}</p>}
          </Card>
        )
      )}

      <Card title={can('shifts:manage') ? 'All shifts' : 'Your shifts'} pad={false}>
        {history.loading && !history.data ? <Loading /> : history.error ? <ErrorState message={history.error} onRetry={history.reload} /> : !history.data.items.length ? <Empty title="No shifts yet" /> : (
          <>
            <DataTable
              rows={history.data.items}
              onRowClick={setView}
              columns={[
                { key: 'cashier', header: 'Cashier', render: (s: any) => <span className="font-medium">{s.cashierName}</span> },
                { key: 'opened', header: 'Opened', render: (s: any) => new Date(s.openedAt).toLocaleString() },
                { key: 'closed', header: 'Closed', render: (s: any) => (s.closedAt ? new Date(s.closedAt).toLocaleString() : <Badge tone="good" dot>Open</Badge>) },
                { key: 'expected', header: 'Expected', render: (s: any) => <span className="tabular-nums">{money(s.expectedCash ?? s.live?.expectedCash)}</span> },
                { key: 'counted', header: 'Counted', render: (s: any) => <span className="tabular-nums">{s.countedCash != null ? money(s.countedCash) : '—'}</span> },
                { key: 'diff', header: 'Difference', render: (s: any) => (s.discrepancy == null ? '—' : <span className={cn('font-semibold tabular-nums', s.discrepancy === 0 ? 'text-emerald-700' : 'text-red-600')}>{s.discrepancy > 0 ? '+' : ''}{money(s.discrepancy)}</span>) },
              ]}
            />
            <div className="p-3"><Pagination page={page} limit={20} total={history.data.total} onPage={setPage} /></div>
          </>
        )}
      </Card>

      <Modal
        open={!!dialog}
        onClose={() => setDialog(null)}
        title={{ open: 'Open shift', in: 'Cash in', out: 'Cash out', close: 'Close shift' }[dialog ?? 'open']}
        size="sm"
        footer={<><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button loading={busy} onClick={submit} disabled={!amount || ((dialog === 'in' || dialog === 'out') && text.trim().length < 3)}>Confirm</Button></>}
      >
        <div className="space-y-3">
          {dialog === 'close' && t && <p className="rounded-lg bg-stone-50 p-3 text-sm">Expected in the drawer: <b className="tabular-nums">{money(t.expectedCash)}</b>. Count the cash and enter what is actually there.</p>}
          <Field label={dialog === 'open' ? 'Opening float (cash in drawer)' : dialog === 'close' ? 'Counted cash' : 'Amount'}><Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
          <Field label={dialog === 'in' || dialog === 'out' ? 'Reason (required)' : 'Notes'}><Input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} /></Field>
        </div>
      </Modal>

      <Modal open={!!view} onClose={() => setView(null)} title={view ? `Shift · ${view.cashierName}` : ''} size="md">
        {view && <ShiftSummary s={view} money={money} />}
      </Modal>
    </>
  );
}

function ShiftSummary({ s, money }: { s: any; money: (n?: number | null) => string }) {
  const t = s.totals ?? s.live ?? {};
  const rows: [string, string][] = [
    ['Opened', `${new Date(s.openedAt).toLocaleString()}`],
    ['Closed', s.closedAt ? `${new Date(s.closedAt).toLocaleString()} by ${s.closedBy}` : 'still open'],
    ['Opening float', money(s.openingFloat)],
    ['Cash sales', money(t.cashSales)],
    ['Cash refunds', `− ${money(t.cashRefunds)}`],
    ['Cash in', money(t.cashIn)],
    ['Cash out', `− ${money(t.cashOut)}`],
    ['Expected cash', money(s.expectedCash ?? t.expectedCash)],
    ['Counted cash', s.countedCash != null ? money(s.countedCash) : '—'],
    ['Difference', s.discrepancy != null ? money(s.discrepancy) : '—'],
    ['Card terminal (not in drawer)', money(t.cardTerminal)],
  ];
  return (
    <dl className="space-y-1.5 text-sm">
      {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-stone-500">{k}</dt><dd className="tabular-nums">{v}</dd></div>)}
      {s.closingNotes && <p className="pt-2 text-stone-600">“{s.closingNotes}”</p>}
    </dl>
  );
}
