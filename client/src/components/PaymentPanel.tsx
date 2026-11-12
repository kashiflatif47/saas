import { useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, CreditCard, Users, ListChecks } from 'lucide-react';
import { api, isNetworkFailure } from '../api/client';
import { useOfflineOptional } from '../offline/OfflineProvider';
import { uuid } from '../offline/engine';
import { useAuth } from '../store/auth';
import { Button, Field, Input, Select, Tabs, useFeedback } from './ui';
import { cn, formatMoney, toMajor, toMinor } from '../lib/util';

type Mode = 'full' | 'equal' | 'items';

/**
 * Collect payments for one order: full/custom amount, equal split or split by items. Amounts for splits
 * are computed by the server (split-quote); the server also refuses overpayment and repeated requests.
 * Card means a manually confirmed card-terminal transaction, never a charge made by this software.
 */
export function PaymentPanel({ order, payments, onPaid }: { order: any; payments: any[]; onPaid: () => void }) {
  const { tenant } = useAuth();
  const fb = useFeedback();
  const dec = tenant?.settings?.currencyDecimals ?? 2;
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, dec);
  const due = Math.max(0, order.total - order.amountPaid);
  const [mode, setMode] = useState<Mode>('full');
  const [method, setMethod] = useState<'cash' | 'card_terminal'>('cash');
  const [amount, setAmount] = useState(toMajor(due, dec));
  const [tendered, setTendered] = useState('');
  const [parts, setParts] = useState(2);
  const [equal, setEqual] = useState<any | null>(null);
  const [pick, setPick] = useState<Record<string, number>>({});
  const [itemsQuote, setItemsQuote] = useState<any | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());
  const off = useOfflineOptional();

  useEffect(() => setAmount(toMajor(due, dec)), [due, dec]);

  // Item quantities already paid through item splits.
  const paidQty = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of payments) if (p.kind === 'charge' && p.status === 'verified' && p.allocation?.mode === 'items') for (const i of p.allocation.items) m.set(i.itemId, (m.get(i.itemId) ?? 0) + i.quantity);
    return m;
  }, [payments]);
  const paidParts = useMemo(() => new Set(payments.filter((p) => p.kind === 'charge' && p.status === 'verified' && p.allocation?.mode === 'equal' && p.allocation.parts === parts).map((p) => p.allocation.part)), [payments, parts]);
  const active = order.items.filter((i: any) => i.status !== 'cancelled');

  useEffect(() => {
    if (mode !== 'equal') return;
    api.post(`/api/staff/orders/${order._id}/split-quote`, { mode: 'equal', parts }).then(setEqual).catch(() => setEqual(null));
  }, [mode, parts, order._id, order.amountPaid]);

  useEffect(() => {
    if (mode !== 'items') return;
    const items = Object.entries(pick).filter(([, q]) => q > 0).map(([itemId, quantity]) => ({ itemId, quantity }));
    if (!items.length) return void setItemsQuote(null);
    api.post(`/api/staff/orders/${order._id}/split-quote`, { mode: 'items', items }).then(setItemsQuote).catch((e) => { setItemsQuote(null); fb.fail(e); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pick, order._id]);

  const pay = async (body: any) => {
    setBusy(true);
    try {
      await api.post(`/api/staff/orders/${order._id}/payments/cash`, { method, idempotencyKey: key.current, ...body });
      key.current = uuid();
      fb.ok('Payment recorded');
      setPick({});
      setItemsQuote(null);
      setTendered('');
      onPaid();
    } catch (e) {
      // Connection lost: plain cash can be kept on this device and sent later with the SAME key, so it is
      // recorded once even if this request did reach the server. Card and split payments need the server.
      if (isNetworkFailure(e) && off?.engine && method === 'cash' && !body.allocation && body.amount > 0) {
        try {
          await off.engine.enqueue('payment.cash', { orderId: order._id, amount: body.amount, method: 'cash' }, { id: key.current });
          key.current = uuid();
          off.reportOffline();
          fb.ok('No connection: cash saved on this device. It is confirmed when the connection returns.');
          setTendered('');
        } catch (err) {
          fb.fail(err);
        }
        return;
      }
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const fullAmount = toMinor(amount, dec);
  const change = method === 'cash' && tendered ? toMinor(tendered, dec) - (mode === 'full' ? fullAmount : 0) : 0;

  return (
    <div className="space-y-3 rounded-xl border border-stone-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="me-auto text-sm font-semibold">Collect payment · <span className="tabular-nums">{money(due)}</span> due</p>
        <div className="flex gap-1 rounded-lg bg-stone-100 p-1">
          {(['cash', 'card_terminal'] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMethod(m)} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', method === m ? 'bg-white font-medium shadow-sm' : 'text-stone-500')}>
              {m === 'cash' ? <Banknote className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}{m === 'cash' ? 'Cash' : 'Card terminal'}
            </button>
          ))}
        </div>
      </div>
      <Tabs<Mode> value={mode} onChange={setMode} items={[{ value: 'full', label: 'Amount' }, { value: 'equal', label: 'Split equally' }, { value: 'items', label: 'Split by items' }]} />

      {mode === 'full' && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Amount" className="w-36"><Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          {method === 'cash' && <Field label="Cash received" className="w-36"><Input type="number" step="0.01" min="0" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder="optional" /></Field>}
          <Button loading={busy} disabled={fullAmount <= 0 || fullAmount > due} onClick={() => pay({ amount: fullAmount })}>Record {money(fullAmount)}</Button>
          {change > 0 && <p className="w-full text-sm font-medium text-emerald-700">Change to give: {money(change)}</p>}
          {change < 0 && tendered && <p className="w-full text-sm text-red-600">Cash received is less than the amount.</p>}
        </div>
      )}

      {mode === 'equal' && (
        <div className="space-y-2">
          <Field label="Guests" className="w-28"><Select value={parts} onChange={(e) => setParts(Number(e.target.value))}>{Array.from({ length: 11 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
          <div className="grid gap-2 sm:grid-cols-2">
            {equal?.parts?.map((p: any) => (
              <div key={p.part} className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2 text-sm">
                <span><Users className="me-1.5 inline h-4 w-4 text-stone-400" />Guest {p.part} · <b className="tabular-nums">{money(p.amount)}</b></span>
                {paidParts.has(p.part) ? <span className="text-xs text-emerald-700">Paid</span> : <Button size="sm" loading={busy} onClick={() => pay({ allocation: { mode: 'equal', parts, part: p.part } })}>Pay</Button>}
              </div>
            ))}
          </div>
          <p className="text-xs text-stone-500">Shares are calculated by the server from the current balance and always add up exactly.</p>
        </div>
      )}

      {mode === 'items' && (
        <div className="space-y-2">
          <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 text-sm">
            {active.map((i: any) => {
              const left = i.quantity - (paidQty.get(i._id) ?? 0);
              return (
                <li key={i._id} className={cn('flex items-center gap-2 px-3 py-2', left <= 0 && 'opacity-50')}>
                  <ListChecks className="h-4 w-4 text-stone-400" />
                  <span className="min-w-0 flex-1 truncate">{i.quantity}× {i.name}{i.variantName ? ` · ${i.variantName}` : ''}</span>
                  {left <= 0 ? <span className="text-xs text-emerald-700">Paid</span> : (
                    <Select className="h-8 w-20 py-0" value={pick[i._id] ?? 0} onChange={(e) => setPick((p) => ({ ...p, [i._id]: Number(e.target.value) }))} aria-label={`Quantity of ${i.name} to pay`}>
                      {Array.from({ length: left + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}
                    </Select>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Guest name (optional)" className="w-48"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} /></Field>
            <Button loading={busy} disabled={!itemsQuote} onClick={() => pay({ allocation: { mode: 'items', items: itemsQuote.items, label: label || undefined } })}>
              {itemsQuote ? `Pay ${money(itemsQuote.amount)}` : 'Choose items'}
            </Button>
          </div>
          <p className="text-xs text-stone-500">Each guest pays their items’ share of discounts, service, delivery and tax.</p>
        </div>
      )}
      <p className="text-xs text-stone-500">Record a payment only once the money has been received. Card terminal payments are recorded as manually confirmed.</p>
    </div>
  );
}
