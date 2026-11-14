import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Banknote, ChefHat, CloudOff, ImageOff, Minus, Percent, Plus, Search, ShoppingBag, Tag, Trash2, UserRound, Wallet, X } from 'lucide-react';
import { api, assetUrl, isNetworkFailure, qs } from '../../api/client';
import { useOffline } from '../../offline/OfflineProvider';
import { createOfflineOrder } from '../../offline/pos';
import { uuid } from '../../offline/engine';
import { estimateOffline, provisionalStock } from '../../offline/estimate';
import { isQuotaError } from '../../offline/idbStore';
import { LocalOrderPanel, LocalOrdersDrawer } from '../../components/LocalOrders';
import { useAuth } from '../../store/auth';
import { useSocket } from '../../hooks/useSocket';
import { Badge, Button, Drawer, Field, Input, Loading, Modal, Select, useFeedback } from '../../components/ui';
import { OrderDrawer } from '../../components/OrderDrawer';
import { cn, formatMoney, ORDER_TYPE_LABEL, toMajor, toMinor } from '../../lib/util';

interface Line {
  key: string;
  productId: string;
  name: string;
  image?: string;
  variantId?: string;
  variantName?: string;
  addonIds: string[];
  addonNames: string[];
  estUnit: number; // display estimate only — the server prices the cart (quote) and the order
  quantity: number;
  notes: string;
  discount?: { type: 'percent' | 'fixed'; value: number } | null;
}

const TABLE_TONE: Record<string, string> = {
  available: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  occupied: 'border-amber-300 bg-amber-50 text-amber-900',
  reserved: 'border-sky-300 bg-sky-50 text-sky-900',
  cleaning: 'border-stone-300 bg-stone-100 text-stone-600',
};

/** Point of sale: fast order entry for counters, tablets and desktops. Every total shown comes from the server. */
export default function Pos() {
  const { tenant, can, user } = useAuth();
  const fb = useFeedback();
  const s = tenant?.settings ?? {};
  const dec = s.currencyDecimals ?? 2;
  const money = (n: number) => formatMoney(n, s.currency, dec);
  const types: string[] = (s.orderTypes ?? ['dine_in']).filter((t: string) => ORDER_TYPE_LABEL[t]);

  const [products, setProducts] = useState<any[] | null>(null);
  const [cats, setCats] = useState<any[]>([]);
  const [tables, setTables] = useState<any[]>([]);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [type, setType] = useState<string>(types.includes('dine_in') ? 'dine_in' : types[0]);
  const [tableId, setTableId] = useState('');
  const [customer, setCustomer] = useState({ name: '', phone: '', address: '' });
  const [notes, setNotes] = useState('');
  const [coupon, setCoupon] = useState('');
  const [orderDiscount, setOrderDiscount] = useState<{ type: 'percent' | 'fixed'; value: string } | null>(null);
  const [discountReason, setDiscountReason] = useState('');
  const [quote, setQuote] = useState<any | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [picking, setPicking] = useState<{ p: any; line?: Line } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [tablePicker, setTablePicker] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [shift, setShift] = useState<{ shift: any; required: boolean } | null>(null);
  // UUID: the same key is used online and, if the connection drops mid-request, for the offline copy.
  const orderKey = useRef(uuid());
  const off = useOffline();
  const offline = !off.online;
  const [stations, setStations] = useState<any[]>([]);
  const [pricesAsOf, setPricesAsOf] = useState<string | null>(null);
  const [localOrders, setLocalOrders] = useState<any[]>([]);
  const [localListOpen, setLocalListOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState<string | null>(null);
  useEffect(() => {
    off.engine?.orders().then(setLocalOrders).catch(() => undefined);
  }, [off.engine, off.version]);

  /** Live data when online (also saved on this device); the last saved copy when the server cannot be reached. */
  const applyMenu = (m: { products: any[]; categories: any[]; stations: any[] }, asOf: string) => {
    const activeCats = m.categories.filter((x: any) => x.isActive);
    const catIds = new Set(activeCats.map((x: any) => x._id));
    setProducts(m.products.filter((x: any) => catIds.has(x.categoryId)));
    setCats(activeCats);
    setStations(m.stations ?? []);
    setPricesAsOf(asOf);
  };
  const loadMenu = useCallback(async () => {
    try {
      const [p, c, st] = await Promise.all([api.get('/api/staff/menu/products?limit=200'), api.get('/api/staff/menu/categories'), api.get('/api/staff/menu/stations?limit=100').catch(() => ({ items: [] }))]);
      const m = { products: p.items, categories: c.items, stations: st.items };
      applyMenu(m, new Date().toISOString());
      await off.engine?.saveSnapshot('menu', m);
    } catch (e) {
      if (!isNetworkFailure(e)) throw e;
      off.reportOffline();
      const snap = await off.engine?.snapshot('menu');
      if (!snap) throw new Error('No connection, and the menu has not been downloaded on this device yet. Open the POS once while online.');
      applyMenu(snap.data, snap.syncedAt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [off.engine]);
  const loadTables = useCallback(async () => {
    try {
      const t = await api.get('/api/staff/tables');
      setTables(t.items.filter((x: any) => x.isActive));
      await off.engine?.saveSnapshot('tables', t.items);
    } catch (e) {
      if (!isNetworkFailure(e)) return;
      const snap = await off.engine?.snapshot('tables');
      if (snap) setTables(snap.data.filter((x: any) => x.isActive));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [off.engine]);
  const loadShift = useCallback(async () => {
    if (!can('shifts:operate')) return;
    try {
      const r = await api.get('/api/staff/shifts/current');
      setShift(r);
      await off.engine?.saveSnapshot('shift', r);
    } catch (e) {
      if (isNetworkFailure(e)) setShift((await off.engine?.snapshot('shift'))?.data ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [can, off.engine]);
  useEffect(() => {
    if (!off.engine && !off.storageError) return; // wait for this device's storage (snapshots)
    loadMenu().catch(fb.fail);
    loadTables();
    loadShift();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [off.engine, off.storageError]);
  // Back online: refresh menu, prices, stock and tables from the server.
  useEffect(() => {
    if (off.online && off.engine) {
      loadMenu().catch(() => undefined);
      loadTables();
      loadShift();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [off.online]);
  // Availability, prices and table status change while the POS is open.
  useSocket({
    'menu:updated': () => loadMenu().catch(() => undefined),
    'table:updated': () => loadTables(),
    'order:new': () => loadTables(),
    'order:updated': () => loadTables(),
    reconnect: () => { loadMenu().catch(() => undefined); loadTables(); },
  });

  // Offline: stock from the last sync minus this device's unsynced orders (may be outdated).
  const localStock = useMemo(() => (offline ? provisionalStock(products ?? [], localOrders) : null), [offline, products, localOrders]);
  const soldOut = (p: any) => !p.isAvailable || (p.trackStock && (localStock?.get(p._id) ?? p.stockQty) <= 0);
  const base = (p: any) => (p.promoPrice != null && p.promoPrice < p.price && (!p.promoEndsAt || new Date(p.promoEndsAt) > new Date()) ? p.promoPrice : p.price);
  const shown = useMemo(() => (products ?? []).filter((p) => (!cat || p.categoryId === cat) && (!q || p.name.en.toLowerCase().includes(q.toLowerCase()))), [products, cat, q]);

  const addLine = (p: any, variantId?: string, addonIds: string[] = [], replace?: Line) => {
    const v = p.variants.find((x: any) => x._id === variantId);
    const addons = addonIds.map((id) => p.addons.find((a: any) => a._id === id)).filter(Boolean);
    const estUnit = base(p) + (v?.priceDelta ?? 0) + addons.reduce((t: number, a: any) => t + a.price, 0);
    const key = [p._id, variantId ?? '', [...addonIds].sort().join('+')].join('|');
    setLines((prev) => {
      const rest = replace ? prev.filter((l) => l.key !== replace.key) : prev;
      const hit = rest.find((l) => l.key === key && !l.notes && !l.discount);
      if (hit) return rest.map((l) => (l === hit ? { ...l, quantity: Math.min(99, l.quantity + (replace?.quantity ?? 1)) } : l));
      return [...rest, { key: replace && replace.key !== key ? key : replace?.key ?? key, productId: p._id, name: p.name.en, image: p.images?.[0], variantId, variantName: v?.name, addonIds, addonNames: addons.map((a: any) => a.name), estUnit, quantity: replace?.quantity ?? 1, notes: replace?.notes ?? '', discount: replace?.discount ?? null }];
    });
  };
  const choose = (p: any) => {
    if (soldOut(p)) return fb.info(`${p.name.en} is unavailable`);
    if (p.variants.length || p.addons.some((a: any) => a.isAvailable)) setPicking({ p });
    else addLine(p);
  };
  const update = (key: string, patch: Partial<Line>) => setLines((p) => p.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const setQty = (key: string, n: number) => setLines((p) => (n <= 0 ? p.filter((l) => l.key !== key) : p.map((l) => (l.key === key ? { ...l, quantity: Math.min(99, n) } : l))));

  const payload = useCallback(() => {
    const disc = orderDiscount && Number(orderDiscount.value) > 0 ? { type: orderDiscount.type, value: orderDiscount.type === 'fixed' ? toMinor(orderDiscount.value, dec) : Number(orderDiscount.value) } : undefined;
    const anyDiscount = !!disc || lines.some((l) => l.discount);
    return {
      type,
      tableId: type === 'dine_in' && tableId ? tableId : undefined,
      customer: customer.name || customer.phone ? { name: customer.name || undefined, phone: customer.phone || undefined } : undefined,
      delivery: type === 'delivery' ? { address: customer.address } : undefined,
      notes: notes || undefined,
      couponCode: coupon.trim() || undefined,
      orderDiscount: disc,
      discountReason: anyDiscount ? discountReason || undefined : undefined,
      items: lines.map((l) => ({ productId: l.productId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes || undefined, discount: l.discount ?? undefined })),
    };
  }, [type, tableId, customer, notes, coupon, orderDiscount, discountReason, lines, dec]);

  const offlineCtx = () => ({
    menu: { products: products ?? [], categories: cats, stations },
    cfg: { currency: s.currency, taxRatePercent: s.taxRatePercent ?? 0, taxInclusive: !!s.taxInclusive, serviceChargePercent: s.serviceChargePercent ?? 0, deliveryFee: s.deliveryFee ?? 0, orderTypes: s.orderTypes, requireTableForDineIn: s.requireTableForDineIn, maxManualDiscountPercent: s.maxManualDiscountPercent },
    tables,
    actor: { name: user?.name ?? '', role: user?.role ?? '', canDiscount: can('orders:discount') },
    tenantId: user?.tenantId ?? '',
    pricesAsOf: pricesAsOf ?? new Date().toISOString(),
  });

  // Server-side quote, debounced: discounts, coupon, service, delivery fee and tax.
  // Offline: the same pricing code runs on this device against the last synchronised prices (an estimate).
  useEffect(() => {
    if (!lines.length) { setQuote(null); setQuoteError(''); return; }
    if (offline) {
      try {
        const body: any = payload();
        const ctx = offlineCtx();
        // Like the online quote, the address/table/reason are only required when the order is placed.
        const draft = {
          ...body,
          couponCode: undefined,
          delivery: body.type === 'delivery' ? { address: body.delivery?.address || 'pending address' } : undefined,
          customer: body.type === 'delivery' && !body.customer?.phone ? { ...(body.customer ?? {}), phone: '0000000' } : body.type === 'pickup' && !body.customer ? { name: 'walk-in' } : body.customer,
          type: body.type === 'dine_in' && !body.tableId && types.includes('takeaway') ? 'takeaway' : body.type,
          discountReason: body.discountReason || (body.orderDiscount || body.items.some((i: any) => i.discount) ? 'estimate' : undefined),
        };
        const est = estimateOffline(ctx.menu, ctx.cfg, draft, ctx.actor, { tables, localOrders });
        setQuote({ ...est.totals, lines: est.items.map((i) => ({ lineTotal: i.lineTotal, discount: i.discount })), offline: true });
        setQuoteError('');
      } catch (e: any) {
        setQuote(null);
        setQuoteError(e.message);
      }
      return;
    }
    const t = setTimeout(() => {
      const body: any = payload();
      // The quote needs no address or table yet; those are checked when the order is placed.
      if (body.type === 'delivery') body.delivery = { address: body.delivery?.address || 'pending address' };
      if (body.type === 'delivery' && !body.customer?.phone) body.customer = { ...(body.customer ?? {}), phone: '0000000' };
      if (body.type === 'pickup' && !body.customer) body.customer = { name: 'walk-in' };
      if (body.type === 'dine_in' && !body.tableId) body.type = types.includes('takeaway') ? 'takeaway' : body.type;
      api.post('/api/staff/orders/quote', body).then((r) => { setQuote(r); setQuoteError(''); }).catch((e) => {
        // Server gone mid-shift: switch to offline mode (the local estimate takes over) instead of blocking the till.
        if (isNetworkFailure(e)) return off.reportOffline();
        setQuote(null);
        setQuoteError(e.message);
      });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, lines.length, types, offline, products, tables, localOrders]);

  const table = tables.find((t) => t._id === tableId);
  const missing = !lines.length ? 'Add items' : type === 'dine_in' && s.requireTableForDineIn && !tableId ? 'Choose a table' : type === 'delivery' && (customer.address.trim().length < 5 || !customer.phone) ? 'Delivery address and phone needed' : type === 'pickup' && !customer.name && !customer.phone ? 'Customer name or phone needed' : '';

  const resetCart = () => {
    setLines([]); setNotes(''); setCoupon(''); setOrderDiscount(null); setDiscountReason(''); setCustomer({ name: '', phone: '', address: '' }); setTableId(''); setCartOpen(false);
  };

  /** Saves the order on this device; success is reported only after it is durably stored. */
  const placeOffline = async (andPay: boolean, key = orderKey.current) => {
    if (!off.engine) throw new Error(off.storageError ? `This browser cannot store orders offline (${off.storageError})` : 'Offline storage is still opening; try again in a moment');
    try {
      const local = await createOfflineOrder(off.engine, offlineCtx(), { ...(payload() as any), couponCode: undefined }, key);
      orderKey.current = uuid();
      fb.ok(`Saved on this device as ${local.localNumber}. It goes to the kitchen and server when the connection returns.`);
      resetCart();
      if (andPay) setLocalOpen(local.localId);
    } catch (e: any) {
      if (isQuotaError(e)) throw new Error('This device is out of storage: the order was NOT saved. Free up space or reconnect.');
      throw e;
    }
  };

  const place = async (andPay: boolean) => {
    setBusy(andPay ? 'pay' : 'send');
    try {
      if (offline) {
        await placeOffline(andPay);
        return;
      }
      let o;
      try {
        o = await api.post('/api/staff/orders', { ...payload(), confirm: true, idempotencyKey: orderKey.current });
      } catch (e) {
        if (!isNetworkFailure(e)) throw e;
        // The connection dropped while sending: keep the cart and save the order on this device instead.
        // The offline copy reuses THIS attempt's key, so if the server did receive the request, the later sync
        // returns that order instead of creating a second one.
        off.reportOffline();
        await placeOffline(andPay, orderKey.current);
        return;
      }
      orderKey.current = uuid();
      fb.ok(`Order #${o.orderNumber} sent to the kitchen`);
      resetCart();
      loadTables();
      if (andPay) setOpenOrder(o._id);
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };

  const findCustomer = async () => {
    if (!customer.phone || !can('customers:manage')) return;
    try {
      const r = await api.get(`/api/staff/customers${qs({ q: customer.phone, limit: 1 })}`);
      const c = r.items?.[0];
      if (c) setCustomer((x) => ({ ...x, name: x.name || c.name || '', phone: c.phone }));
      else fb.info('New customer — they will be saved with the order');
    } catch (e) {
      fb.fail(e);
    }
  };

  const cart = (
    <div className="flex h-full flex-col">
      <div className="space-y-3 border-b border-stone-200 p-4">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-stone-100 p-1 sm:grid-cols-4">
          {types.map((t) => (
            <button key={t} type="button" onClick={() => setType(t)} className={cn('rounded-lg px-2 py-2 text-sm font-medium transition', type === t ? 'bg-white shadow-sm' : 'text-stone-500 hover:text-stone-800')}>{ORDER_TYPE_LABEL[t]}</button>
          ))}
        </div>
        {type === 'dine_in' && (
          <button type="button" onClick={() => setTablePicker(true)} className={cn('flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-start text-sm', table ? 'border-brand bg-brand/5' : 'border-dashed border-stone-300 text-stone-500')}>
            <span>{table ? <>Table <b>{table.label}</b>{table.openOrders ? ` · ${table.openOrders} open order(s)` : ''}</> : 'Choose a table'}</span>
            <span className="text-xs text-brand">Change</span>
          </button>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="Customer name" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} maxLength={80} aria-label="Customer name" />
          <div className="flex gap-1">
            <Input placeholder="Phone" value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} onBlur={findCustomer} maxLength={25} aria-label="Customer phone" />
            {can('customers:manage') && <Button size="icon" variant="ghost" onClick={findCustomer} aria-label="Find customer"><UserRound className="h-4 w-4" /></Button>}
          </div>
          {type === 'delivery' && <Input className="col-span-2" placeholder="Delivery address" value={customer.address} onChange={(e) => setCustomer({ ...customer, address: e.target.value })} maxLength={300} aria-label="Delivery address" />}
        </div>
      </div>

      <ul className="flex-1 divide-y divide-stone-100 overflow-y-auto">
        {lines.length === 0 && <li className="flex flex-col items-center gap-2 p-10 text-center text-sm text-stone-400"><ShoppingBag className="h-8 w-8" />Tap dishes to add them</li>}
        {lines.map((l) => {
          const ql = quote?.lines?.[lines.indexOf(l)];
          return (
            <li key={l.key} className="px-4 py-2.5">
              <div className="flex items-start gap-2">
                <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setEditing(editing === l.key ? null : l.key)}>
                  <p className="truncate text-sm font-medium">{l.name}</p>
                  <p className="truncate text-xs text-stone-500">{[l.variantName, ...l.addonNames.map((a) => `+${a}`)].filter(Boolean).join(' · ')}{l.notes && <span className="italic text-amber-700"> “{l.notes}”</span>}</p>
                  {ql?.discount > 0 && <p className="text-xs text-emerald-700">−{money(ql.discount)}</p>}
                </button>
                <div className="flex items-center">
                  <Button size="icon" variant="ghost" onClick={() => setQty(l.key, l.quantity - 1)} aria-label={`Fewer ${l.name}`}><Minus className="h-3.5 w-3.5" /></Button>
                  <span className="w-6 text-center text-sm font-semibold tabular-nums">{l.quantity}</span>
                  <Button size="icon" variant="ghost" onClick={() => setQty(l.key, l.quantity + 1)} aria-label={`More ${l.name}`}><Plus className="h-3.5 w-3.5" /></Button>
                </div>
                <span className="w-20 pt-2 text-end text-sm tabular-nums">{money(ql?.lineTotal ?? l.estUnit * l.quantity)}</span>
              </div>
              {editing === l.key && (
                <div className="mt-2 space-y-2 rounded-lg bg-stone-50 p-2">
                  <Input placeholder="Instructions for the kitchen" value={l.notes} maxLength={300} onChange={(e) => update(l.key, { notes: e.target.value })} aria-label="Item instructions" />
                  <div className="flex flex-wrap items-center gap-2">
                    {(() => { const p = products?.find((x) => x._id === l.productId); return p && (p.variants.length > 0 || p.addons.length > 0) ? <Button size="sm" variant="outline" onClick={() => setPicking({ p, line: l })}>Change options</Button> : null; })()}
                    {can('orders:discount') && (
                      <>
                        <Select className="h-9 w-24 py-0" value={l.discount?.type ?? ''} onChange={(e) => update(l.key, { discount: e.target.value ? { type: e.target.value as any, value: 0 } : null })} aria-label="Item discount type">
                          <option value="">No discount</option><option value="percent">%</option><option value="fixed">Amount</option>
                        </Select>
                        {l.discount && <Input className="h-9 w-24" type="number" min={0} step="0.01" value={l.discount.type === 'fixed' ? toMajor(l.discount.value, dec) : l.discount.value} onChange={(e) => update(l.key, { discount: { type: l.discount!.type, value: l.discount!.type === 'fixed' ? toMinor(e.target.value, dec) : Number(e.target.value) } })} aria-label="Item discount value" />}
                      </>
                    )}
                    <Button size="sm" variant="ghost" className="ms-auto text-red-600" onClick={() => setQty(l.key, 0)}><Trash2 className="h-4 w-4" /> Remove</Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="space-y-2 border-t border-stone-200 p-4">
        <div className="grid grid-cols-2 gap-2">
          <div className="relative"><Tag className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" /><Input className="ps-8" placeholder={offline ? 'Coupons need connection' : 'Coupon'} disabled={offline} value={offline ? '' : coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} maxLength={40} aria-label="Coupon code" /></div>
          <Input placeholder="Order notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} aria-label="Order notes" />
        </div>
        {can('orders:discount') && (
          <div className="flex flex-wrap items-center gap-2">
            <Percent className="h-4 w-4 text-stone-400" />
            <Select className="h-9 w-28 py-0" value={orderDiscount?.type ?? ''} onChange={(e) => setOrderDiscount(e.target.value ? { type: e.target.value as any, value: '' } : null)} aria-label="Order discount type">
              <option value="">No discount</option><option value="percent">% off order</option><option value="fixed">Amount off</option>
            </Select>
            {orderDiscount && <Input className="h-9 w-24" type="number" min={0} step="0.01" value={orderDiscount.value} onChange={(e) => setOrderDiscount({ ...orderDiscount, value: e.target.value })} aria-label="Order discount value" />}
            {(orderDiscount || lines.some((l) => l.discount)) && <Input className="h-9 min-w-[8rem] flex-1" placeholder="Reason (required)" value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} maxLength={200} aria-label="Discount reason" />}
          </div>
        )}
        <dl className="space-y-1 text-sm">
          {quote ? (
            <>
              <Row k="Subtotal" v={money(quote.subtotal)} />
              {quote.discount > 0 && <Row k={`Discounts${quote.couponApplied ? ` (incl. ${quote.couponApplied})` : ''}`} v={`− ${money(quote.discount)}`} />}
              {quote.serviceCharge > 0 && <Row k="Service charge" v={money(quote.serviceCharge)} />}
              {quote.deliveryFee > 0 && <Row k="Delivery fee" v={money(quote.deliveryFee)} />}
              <Row k={`${s.taxLabel || 'Tax'}${s.taxInclusive ? ' (included)' : ` ${s.taxRatePercent ?? 0}%`}`} v={money(quote.tax)} />
              <Row k={quote.offline ? 'Total (offline estimate)' : 'Total'} v={money(quote.total)} strong />
              {quote.offline && <p className="text-xs text-amber-700">Saved on this device and re-priced by the server when it syncs; any difference is shown in the Sync centre.</p>}
            </>
          ) : lines.length ? <p className={cn('text-sm', quoteError ? 'text-red-600' : 'text-stone-400')}>{quoteError || 'Calculating…'}</p> : null}
        </dl>
        {missing && lines.length > 0 && <p className="text-xs text-amber-700">{missing}</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="lg" loading={busy === 'send'} disabled={!!missing || !quote || !!busy} onClick={() => place(false)}><ChefHat className="h-4 w-4" /> Send to kitchen</Button>
          <Button size="lg" loading={busy === 'pay'} disabled={!!missing || !quote || !!busy || !can('payments:collect')} onClick={() => place(true)}><Wallet className="h-4 w-4" /> Charge {quote ? money(quote.total) : ''}</Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="-mx-4 -my-4 sm:-mx-6 lg:-my-8">
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 bg-white/80 px-4 py-3 backdrop-blur sm:px-6">
        <h1 className="font-display text-xl font-semibold">Point of sale</h1>
        {offline && <Badge tone="warn" dot><CloudOff className="me-1 inline h-3.5 w-3.5" />Offline · prices as of {pricesAsOf ? new Date(pricesAsOf).toLocaleString() : '—'}</Badge>}
        {localOrders.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => setLocalListOpen(true)}>
            Orders on this device{localOrders.some((o) => o.syncState !== 'confirmed') ? ` · ${localOrders.filter((o) => o.syncState !== 'confirmed').length} not confirmed` : ''}
          </Button>
        )}
        {shift && (shift.shift ? <Badge tone="good" dot>Shift open · {new Date(shift.shift.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Badge> : <Badge tone={shift.required ? 'bad' : 'warn'} dot>{shift.required ? 'Open a shift to take cash' : 'No shift open'}</Badge>)}
        {can('shifts:operate') && <Link to="/dashboard/shifts" className="text-sm text-brand hover:underline"><Banknote className="me-1 inline h-4 w-4" />Cash shift</Link>}
        <div className="relative ms-auto w-full sm:w-72">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
          <Input className="ps-9" placeholder="Search dishes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search dishes" />
        </div>
      </div>
      <div className="grid lg:h-[calc(100vh-8.5rem)] lg:grid-cols-[1fr_400px]">
        <section className="min-w-0 overflow-y-auto p-4 pb-28 sm:p-6 lg:pb-6">
          <div className="scrollbar-thin -mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1">
            <CatButton active={!cat} onClick={() => setCat('')}>All</CatButton>
            {cats.map((c) => <CatButton key={c._id} active={cat === c._id} onClick={() => setCat(c._id)}>{c.name.en}</CatButton>)}
          </div>
          {!products ? <Loading /> : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {shown.map((p) => {
                const out = soldOut(p);
                return (
                  <button key={p._id} type="button" onClick={() => choose(p)} disabled={out} className={cn('group flex flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white text-start shadow-sm transition active:scale-[0.98]', out ? 'cursor-not-allowed opacity-50' : 'hover:border-brand hover:shadow-md')}>
                    <div className="relative aspect-[4/3] w-full bg-stone-100">
                      {p.images?.[0] ? <img src={assetUrl(p.images[0])} alt="" loading="lazy" className="h-full w-full object-cover" /> : <ImageOff className="absolute inset-0 m-auto h-6 w-6 text-stone-300" />}
                      {out && <span className="absolute inset-x-0 bottom-0 bg-stone-900/80 py-1 text-center text-xs font-semibold text-white">Unavailable</span>}
                    </div>
                    <div className="p-3">
                      <p className="line-clamp-2 text-sm font-semibold leading-snug text-stone-900">{p.name.en}</p>
                      <p className="mt-1 text-[13px] font-medium text-stone-500 tabular-nums">{money(base(p))}{p.variants.length ? '+' : ''}</p>
                    </div>
                  </button>
                );
              })}
              {shown.length === 0 && <p className="col-span-full py-12 text-center text-sm text-stone-400">No dishes match.</p>}
            </div>
          )}
        </section>
        <aside className="hidden border-s border-stone-200 bg-white lg:block">{cart}</aside>
      </div>

      {/* Phones and small tablets: the cart opens as a panel. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-white/95 p-3 backdrop-blur lg:hidden">
        <Button size="lg" className="w-full" onClick={() => setCartOpen(true)}>
          <ShoppingBag className="h-4 w-4" /> Order · {lines.reduce((t, l) => t + l.quantity, 0)} item(s){quote ? ` · ${money(quote.total)}` : ''}
        </Button>
      </div>
      <Drawer open={cartOpen} onClose={() => setCartOpen(false)} title="Current order" width="max-w-md">{cart}</Drawer>

      <OptionPicker pick={picking} money={money} onClose={() => setPicking(null)} onAdd={(p, v, a, line) => { addLine(p, v, a, line); setPicking(null); }} />

      <Modal open={tablePicker} onClose={() => setTablePicker(false)} title="Choose a table" size="lg">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {tables.map((t) => (
            <button key={t._id} type="button" onClick={() => { setTableId(t._id); setTablePicker(false); }} className={cn('rounded-xl border-2 p-3 text-center transition hover:scale-[1.02]', TABLE_TONE[t.status] ?? TABLE_TONE.available, tableId === t._id && 'ring-2 ring-brand')}>
              <p className="font-display text-lg font-semibold">{t.label}</p>
              <p className="text-[11px] capitalize">{t.status}{t.openOrders ? ` · ${t.openOrders}` : ''}</p>
              {t.amountDue > 0 && <p className="text-[11px] tabular-nums">{money(t.amountDue)} due</p>}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-stone-500">Occupied tables can take another order (e.g. a second round). Open table orders are listed under Orders.</p>
      </Modal>

      <OrderDrawer orderId={openOrder} onClose={() => setOpenOrder(null)} onChanged={loadTables} />
      <LocalOrdersDrawer open={localListOpen} onClose={() => setLocalListOpen(false)} onOpen={(id) => { setLocalListOpen(false); setLocalOpen(id); }} />
      <LocalOrderPanel localId={localOpen} onClose={() => setLocalOpen(null)} />
    </div>
  );
}

function CatButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className={cn('whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition', active ? 'bg-stone-900 text-white' : 'bg-white text-stone-600 ring-1 ring-stone-200 hover:ring-stone-300')}>{children}</button>;
}

function OptionPicker({ pick, money, onClose, onAdd }: { pick: { p: any; line?: Line } | null; money: (n: number) => string; onClose: () => void; onAdd: (p: any, variantId?: string, addonIds?: string[], line?: Line) => void }) {
  const [variantId, setVariantId] = useState('');
  const [addonIds, setAddonIds] = useState<string[]>([]);
  useEffect(() => {
    if (!pick) return;
    setVariantId(pick.line?.variantId ?? pick.p.variants[0]?._id ?? '');
    setAddonIds(pick.line?.addonIds ?? []);
  }, [pick]);
  const p = pick?.p;
  return (
    <Modal open={!!p} onClose={onClose} title={p?.name?.en} size="sm" footer={<Button size="lg" className="w-full" onClick={() => onAdd(p, variantId || undefined, addonIds, pick?.line)}>{pick?.line ? 'Update' : 'Add to order'}</Button>}>
      {p && (
        <div className="space-y-4">
          {p.variants.length > 0 && (
            <div className="space-y-2">
              <p className="label">Choose one</p>
              {p.variants.map((v: any) => (
                <label key={v._id} className={cn('flex cursor-pointer items-center justify-between rounded-xl border px-3 py-3 text-sm', variantId === v._id ? 'border-brand bg-brand/5' : 'border-stone-200')}>
                  <span><input type="radio" className="me-2" checked={variantId === v._id} onChange={() => setVariantId(v._id)} />{v.name}</span>
                  <span className="text-stone-500">{v.priceDelta ? `${v.priceDelta > 0 ? '+' : ''}${money(v.priceDelta)}` : ''}</span>
                </label>
              ))}
            </div>
          )}
          {p.addons.filter((a: any) => a.isAvailable).length > 0 && (
            <div className="space-y-2">
              <p className="label">Add-ons</p>
              {p.addons.filter((a: any) => a.isAvailable).map((a: any) => (
                <label key={a._id} className="flex cursor-pointer items-center justify-between rounded-xl border border-stone-200 px-3 py-3 text-sm">
                  <span><input type="checkbox" className="me-2" checked={addonIds.includes(a._id)} onChange={(e) => setAddonIds((x) => (e.target.checked ? [...x, a._id] : x.filter((y) => y !== a._id)))} />{a.name}</span>
                  <span className="text-stone-500">+{money(a.price)}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      <button type="button" className="sr-only" onClick={onClose}><X /></button>
    </Modal>
  );
}

const Row = ({ k, v, strong }: { k: string; v: string; strong?: boolean }) => (
  <div className={cn('flex justify-between gap-3', strong && 'border-t border-stone-100 pt-1.5 text-base font-semibold text-stone-900')}>
    <dt className={strong ? '' : 'text-stone-500'}>{k}</dt>
    <dd className="tabular-nums">{v}</dd>
  </div>
);
