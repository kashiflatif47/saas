import { useEffect, useMemo, useState } from 'react';
import { Minus, Plus, Search } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { Button, Field, Input, Loading, Modal, Select, useFeedback } from './ui';
import { formatMoney } from '../lib/util';
import { OptionSelector, initialSelection, useItemSelection } from './OptionSelector';
import { hasOptions, selectionPayload, selectionSummary } from '../lib/options';
import { displayPrice, resolveSelection, selectionKey, type ItemSelection } from '../offline/menuPricing';

interface Line { key: string; productId: string; name: string; selection: ItemSelection; summary: string[]; unit: number; quantity: number }

/** Staff-entered order (waiter at the table, cashier at the counter). Prices are recomputed by the server. */
/** Also used to add items to an existing order (`appendTo` = order id): the server re-prices the order. */
export function NewOrderModal({ open, onClose, onCreated, presetTableId, appendTo }: { open: boolean; onClose: () => void; onCreated: (o: any) => void; presetTableId?: string; appendTo?: string }) {
  const { tenant } = useAuth();
  const fb = useFeedback();
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals);
  const [products, setProducts] = useState<any[] | null>(null);
  const [tables, setTables] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [type, setType] = useState('dine_in');
  const [tableId, setTableId] = useState(presetTableId ?? '');
  const [notes, setNotes] = useState('');
  const [picking, setPicking] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLines([]);
    setNotes('');
    setTableId(presetTableId ?? '');
    Promise.all([api.get('/api/staff/menu/products?limit=200'), api.get('/api/staff/menu/categories'), api.get('/api/staff/tables')])
      .then(([p, c, t]) => {
        setProducts(p.items.filter((x: any) => x.isAvailable));
        setCats(c.items.filter((x: any) => x.isActive));
        setTables(t.items.filter((x: any) => x.isActive));
      })
      .catch(fb.fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const shown = useMemo(() => (products ?? []).filter((p) => (!cat || p.categoryId === cat) && (!q || p.name.en.toLowerCase().includes(q.toLowerCase()))), [products, cat, q]);
  /** Preview price from the same rules the server charges with (an option REPLACES the dish price). */
  const addLine = (p: any, selection: ItemSelection = {}) => {
    let r;
    try {
      r = resolveSelection(p, selection);
    } catch (e: any) {
      return fb.info(e.message);
    }
    const key = selectionKey(p._id, selection);
    const line: Line = { key, productId: p._id, name: p.name.en, selection, summary: selectionSummary(r), unit: r.unitPrice, quantity: 1 };
    setLines((prev) => (prev.some((l) => l.key === key) ? prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l)) : [...prev, line]));
  };

  const choose = (p: any) => {
    if (hasOptions(p)) setPicking(p);
    else addLine(p, initialSelection(p));
  };

  const submit = async () => {
    setBusy(true);
    try {
      const items = lines.map((l) => ({ productId: l.productId, ...selectionPayload(l.selection), quantity: l.quantity, notes: appendTo && notes ? notes : undefined }));
      const o = appendTo
        ? await api.post(`/api/staff/orders/${appendTo}/items`, { items })
        : await api.post('/api/staff/orders', { type, tableId: type === 'dine_in' ? tableId || undefined : undefined, notes: notes || undefined, items });
      fb.ok(appendTo ? 'Items added — the kitchen has been notified' : `Order #${o.orderNumber} created`);
      onCreated(o);
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const est = lines.reduce((s, l) => s + l.unit * l.quantity, 0);

  return (
    <Modal open={open} onClose={onClose} title={appendTo ? 'Add items' : 'New order'} size="xl" footer={<><span className="me-auto self-center text-sm text-stone-500">Estimate {money(est)} + tax/service</span><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={busy} disabled={!lines.length || (!appendTo && type === 'dine_in' && !tableId && tenant?.settings?.requireTableForDineIn)}>{appendTo ? 'Add to order' : 'Place order'}</Button></>}>
      {!products ? <Loading /> : (
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div>
            <div className="mb-3 flex gap-2">
              <div className="relative flex-1"><Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" /><Input className="ps-9" placeholder="Search menu" value={q} onChange={(e) => setQ(e.target.value)} /></div>
              <Select className="w-44" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{cats.map((c) => <option key={c._id} value={c._id}>{c.name.en}</option>)}</Select>
            </div>
            <div className="grid max-h-[50vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
              {shown.map((p) => (
                <button key={p._id} onClick={() => choose(p)} className="rounded-xl border border-stone-200 p-3 text-start transition hover:border-brand hover:bg-brand/5">
                  <p className="line-clamp-2 text-sm font-medium">{p.name.en}</p>
                  <p className="mt-1 text-xs text-stone-500">{(() => { const d = displayPrice(p); return `${money(d.amount)}${d.from ? '+' : ''}`; })()}</p>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            {!appendTo && <div className="grid grid-cols-2 gap-2">
              <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)}>{(tenant?.settings?.orderTypes ?? ['dine_in']).map((t: string) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</Select></Field>
              {type === 'dine_in' && <Field label="Table"><Select value={tableId} onChange={(e) => setTableId(e.target.value)}><option value="">—</option>{tables.map((t) => <option key={t._id} value={t._id}>{t.label}</option>)}</Select></Field>}
            </div>}
            <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200">
              {lines.length === 0 && <li className="p-6 text-center text-sm text-stone-400">Tap items to add them</li>}
              {lines.map((l) => (
                <li key={l.key} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1"><p className="truncate font-medium">{l.name}</p>{l.summary.length > 0 && <p className="text-xs text-stone-500">{l.summary.join(' · ')}</p>}</div>
                  <Button size="icon" variant="ghost" onClick={() => setLines((p) => p.flatMap((x) => (x.key === l.key ? (x.quantity > 1 ? [{ ...x, quantity: x.quantity - 1 }] : []) : [x])))} aria-label="Decrease"><Minus className="h-3.5 w-3.5" /></Button>
                  <span className="w-5 text-center tabular-nums">{l.quantity}</span>
                  <Button size="icon" variant="ghost" onClick={() => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, quantity: x.quantity + 1 } : x)))} aria-label="Increase"><Plus className="h-3.5 w-3.5" /></Button>
                </li>
              ))}
            </ul>
            <Field label={appendTo ? 'Instructions for these items' : 'Kitchen notes'}><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
          </div>
        </div>
      )}
      {picking && <PickOptions key={picking._id} p={picking} money={money} onClose={() => setPicking(null)} onAdd={(sel) => { addLine(picking, sel); setPicking(null); }} />}
    </Modal>
  );
}

function PickOptions({ p, money, onClose, onAdd }: { p: any; money: (n: number) => string; onClose: () => void; onAdd: (s: ItemSelection) => void }) {
  const { selection, setSelection, resolved, error } = useItemSelection(p);
  return (
    <Modal open onClose={onClose} title={p.name?.en} size="sm" footer={<>{error && <span className="me-auto self-center text-sm text-amber-700">{error}</span>}<Button disabled={!resolved} onClick={() => onAdd(selection)}>Add{resolved ? ` · ${money(resolved.unitPrice)}` : ''}</Button></>}>
      <OptionSelector product={p} value={selection} onChange={setSelection} money={money} />
    </Modal>
  );
}
