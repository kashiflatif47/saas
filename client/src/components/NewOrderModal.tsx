import { useEffect, useMemo, useState } from 'react';
import { Minus, Plus, Search } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { Button, Field, Input, Loading, Modal, Select, useFeedback } from './ui';
import { cn, formatMoney } from '../lib/util';

interface Line { key: string; productId: string; name: string; variantId?: string; variantName?: string; addonIds: string[]; unit: number; quantity: number }

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
  const [variantId, setVariantId] = useState('');
  const [addonIds, setAddonIds] = useState<string[]>([]);
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
  const base = (p: any) => (p.promoPrice != null && p.promoPrice < p.price && (!p.promoEndsAt || new Date(p.promoEndsAt) > new Date()) ? p.promoPrice : p.price);

  const addLine = (p: any, vId?: string, aIds: string[] = []) => {
    const v = p.variants.find((x: any) => x._id === vId);
    const unit = base(p) + (v?.priceDelta ?? 0) + aIds.reduce((s, id) => s + (p.addons.find((a: any) => a._id === id)?.price ?? 0), 0);
    const key = [p._id, vId ?? '', [...aIds].sort().join('+')].join('|');
    setLines((prev) => (prev.some((l) => l.key === key) ? prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l)) : [...prev, { key, productId: p._id, name: p.name.en, variantId: vId, variantName: v?.name, addonIds: aIds, unit, quantity: 1 }]));
  };

  const choose = (p: any) => {
    if (p.variants.length || p.addons.length) {
      setPicking(p);
      setVariantId(p.variants[0]?._id ?? '');
      setAddonIds([]);
    } else addLine(p);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const items = lines.map((l) => ({ productId: l.productId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: appendTo && notes ? notes : undefined }));
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
                  <p className="mt-1 text-xs text-stone-500">{money(base(p))}{p.variants.length ? '+' : ''}</p>
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
                  <div className="min-w-0 flex-1"><p className="truncate font-medium">{l.name}</p>{l.variantName && <p className="text-xs text-stone-500">{l.variantName}</p>}</div>
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
      <Modal open={!!picking} onClose={() => setPicking(null)} title={picking?.name?.en} size="sm" footer={<Button onClick={() => { addLine(picking, variantId || undefined, addonIds); setPicking(null); }}>Add</Button>}>
        {picking && (
          <div className="space-y-4">
            {picking.variants.length > 0 && (
              <div className="space-y-2">{picking.variants.map((v: any) => (
                <label key={v._id} className={cn('flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm', variantId === v._id ? 'border-brand bg-brand/5' : 'border-stone-200')}>
                  <span><input type="radio" className="me-2" checked={variantId === v._id} onChange={() => setVariantId(v._id)} />{v.name}</span>
                  <span className="text-stone-500">{v.priceDelta ? `+${money(v.priceDelta)}` : ''}</span>
                </label>))}</div>
            )}
            {picking.addons.filter((a: any) => a.isAvailable).map((a: any) => (
              <label key={a._id} className="flex items-center justify-between text-sm">
                <span><input type="checkbox" className="me-2" checked={addonIds.includes(a._id)} onChange={(e) => setAddonIds((p) => (e.target.checked ? [...p, a._id] : p.filter((x) => x !== a._id)))} />{a.name}</span>
                <span className="text-stone-500">+{money(a.price)}</span>
              </label>
            ))}
          </div>
        )}
      </Modal>
    </Modal>
  );
}
