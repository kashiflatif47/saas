import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, ChefHat, Clock, CreditCard, PartyPopper, Star, UtensilsCrossed, Wifi } from 'lucide-react';
import { api } from '../../api/client';
import { useI18n, type TKey } from '../../i18n';
import { useSocket } from '../../hooks/useSocket';
import { cn, formatMoney } from '../../lib/util';
import { Loading } from '../../components/ui';
import type { StoreInfo } from './Storefront';

const STEPS = [
  { key: 'pending', icon: Clock },
  { key: 'accepted', icon: CheckCircle2 },
  { key: 'preparing', icon: ChefHat },
  { key: 'ready', icon: UtensilsCrossed },
  { key: 'delivered', icon: PartyPopper },
];
const RANK: Record<string, number> = { pending: 0, accepted: 1, preparing: 2, partially_ready: 2, ready: 3, delivered: 4, completed: 4 };

export default function OrderTracking({ store }: { store: StoreInfo }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { t, lang } = useI18n();
  const money = (n: number) => formatMoney(n, store.settings.currency, store.settings.currencyDecimals, lang === 'en' ? 'en' : lang === 'ur' ? 'ur-PK' : 'ar');
  const [order, setOrder] = useState<any | null>(null);
  const [error, setError] = useState('');

  const load = () => api.get(`/api/public/orders/${id}?token=${encodeURIComponent(token)}`).then(setOrder).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token]);
  // Live updates carry only status fields per item: merge them so names, options and prices stay visible.
  const { connected } = useSocket(
    {
      'order:status': (o) =>
        setOrder((p: any) => {
          if (!p) return p;
          const byId = new Map<string, any>((o.items ?? []).map((i: any) => [String(i._id), i]));
          return { ...p, ...o, delivery: o.delivery ? { ...p.delivery, ...o.delivery } : p.delivery, items: (p.items ?? []).map((i: any) => ({ ...i, ...(byId.get(String(i._id)) ?? {}) })) };
        }),
      reconnect: () => load(),
    },
    { orderId: id, trackingToken: token, enabled: !!id && !!token },
  );

  if (error) return <p className="mx-auto max-w-md px-6 py-24 text-center opacity-70">{error}</p>;
  if (!order) return <Loading />;
  const rank = RANK[order.status] ?? -1;
  const failed = ['rejected', 'cancelled', 'refunded'].includes(order.status);
  const due = Math.max(0, order.total - (order.amountPaid ?? 0));

  return (
    <main className="mx-auto max-w-xl animate-fade-up px-4 py-10 sm:py-14">
      {params.get('new') && (
        <div className="mb-6 animate-scale-in text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand text-brand-ink shadow-lift"><CheckCircle2 className="h-7 w-7" /></span>
          <p className="mt-4 font-display text-3xl font-semibold tracking-tight">{t('orderPlaced')}</p>
        </div>
      )}
      <section className="store-card p-6 sm:p-7">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm opacity-60">{t('orderNo')}</p>
            <p className="font-display text-4xl font-semibold">#{order.orderNumber}</p>
            {order.tableLabel && <p className="mt-1 text-sm opacity-70">{t('table')} {order.tableLabel}</p>}
          </div>
          {connected && <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800"><Wifi className="h-3 w-3" /> {t('live')}</span>}
        </div>
        <p className={cn('mt-5 text-lg font-semibold', failed ? 'text-red-600' : 'text-brand')}>{t(`st_${order.status}` as TKey)}</p>
        {order.type === 'delivery' && order.delivery?.status && <DeliveryStatus d={order.delivery} t={t} />}
        {!failed && (
          <ol className="mt-5 grid grid-cols-5 gap-1">
            {STEPS.map((s, i) => (
              <li key={s.key} className="flex flex-col items-center gap-1.5">
                <span className={cn('flex h-10 w-10 items-center justify-center rounded-full transition', i <= rank ? 'bg-brand text-brand-ink' : 'bg-black/5 opacity-50', i === rank && 'ring-4 ring-brand/25')}>
                  <s.icon className="h-5 w-5" />
                </span>
                <span className={cn('h-1 w-full rounded-full', i <= rank ? 'bg-brand' : 'bg-black/10')} />
              </li>
            ))}
          </ol>
        )}
        <ul className="mt-6 space-y-2 border-t border-black/5 pt-4 text-sm">
          {order.items.map((i: any) => (
            <li key={i._id} className="flex justify-between gap-3">
              <span>{i.quantity}× {i.name}{i.variantName ? ` · ${i.variantName}` : ''}</span>
              <span className="text-xs opacity-60">{i.status === 'ready' || i.status === 'served' ? '✓' : ''}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-4 space-y-1 border-t border-black/5 pt-4 text-sm">
          <div className="flex justify-between"><dt className="opacity-60">{t('subtotal')}</dt><dd>{money(order.subtotal)}</dd></div>
          {order.discount > 0 && <div className="flex justify-between"><dt className="opacity-60">{t('discount')}</dt><dd>− {money(order.discount)}</dd></div>}
          {order.serviceCharge > 0 && <div className="flex justify-between"><dt className="opacity-60">{t('service')}</dt><dd>{money(order.serviceCharge)}</dd></div>}
          {order.tax > 0 && <div className="flex justify-between"><dt className="opacity-60">{t('tax')}</dt><dd>{money(order.tax)}</dd></div>}
          <div className="flex justify-between text-base font-semibold"><dt>{t('total')}</dt><dd>{money(order.total)}</dd></div>
          <div className="flex justify-between"><dt className="opacity-60">{t('payment')}</dt><dd className={order.paymentStatus === 'paid' ? 'font-medium text-emerald-700' : ''}>{t(`pay_${order.paymentStatus}` as TKey)}</dd></div>
        </dl>
      </section>

      {!failed && due > 0 && (
        <section className="mt-4 store-card p-6 sm:p-7">
          {store.payments.cash && <p className="text-sm opacity-75">💵 {t('payCash')}</p>}
          {store.payments.online && <OnlinePay orderId={order._id} token={token} publicKey={store.payments.online.publicKey} label={`${t('payOnline')} · ${money(due)}`} onDone={load} />}
        </section>
      )}

      {['delivered', 'completed'].includes(order.status) && <FeedbackForm orderId={order._id} token={token} alreadyGiven={!!order.feedbackGiven} />}

      <div className="mt-6 text-center"><Link to="/" className="text-sm font-medium text-brand underline-offset-4 hover:underline">{t('viewMenu')}</Link></div>
    </main>
  );
}

/** Stripe Payment Element. The order is marked paid ONLY by the server after the signed webhook arrives. */
function OnlinePay({ orderId, token, publicKey, label, onDone }: { orderId: string; token: string; publicKey: string; label: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const mount = useRef<HTMLDivElement>(null);
  const ctx = useRef<{ stripe: any; elements: any } | null>(null);

  const start = async () => {
    setBusy(true);
    setMsg('');
    try {
      const { clientSecret } = await api.post(`/api/public/orders/${orderId}/pay`, { token });
      const { loadStripe } = await import('@stripe/stripe-js');
      const stripe = await loadStripe(publicKey);
      if (!stripe) throw new Error('Could not load the payment form');
      const elements = stripe.elements({ clientSecret });
      setOpen(true);
      setTimeout(() => elements.create('payment').mount(mount.current!), 0);
      ctx.current = { stripe, elements };
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!ctx.current) return;
    setBusy(true);
    setMsg('');
    const { error } = await ctx.current.stripe.confirmPayment({ elements: ctx.current.elements, redirect: 'if_required', confirmParams: { return_url: window.location.href } });
    setBusy(false);
    if (error) return setMsg(error.message ?? 'Payment failed');
    setMsg('Payment submitted — waiting for confirmation from the bank…');
    setOpen(false);
    // Poll briefly; the socket also pushes the update when the webhook verifies it.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      onDone();
    }
  };

  return (
    <div className="mt-3">
      {!open ? (
        <button onClick={start} disabled={busy} className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-brand font-semibold text-brand-ink disabled:opacity-50"><CreditCard className="h-4 w-4" /> {busy ? '…' : label}</button>
      ) : (
        <>
          <div ref={mount} className="min-h-[120px]" />
          <button onClick={confirm} disabled={busy} className="store-btn mt-4 w-full">{busy ? '…' : label}</button>
        </>
      )}
      {msg && <p className="mt-2 text-sm opacity-75">{msg}</p>}
    </div>
  );
}

function FeedbackForm({ orderId, token, alreadyGiven }: { orderId: string; token: string; alreadyGiven?: boolean }) {
  const { t } = useI18n();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | string>(alreadyGiven ? 'done' : 'idle');
  const send = async () => {
    setState('busy');
    try {
      await api.post(`/api/public/orders/${orderId}/feedback`, { token, rating, comment: comment || undefined });
      setState('done');
    } catch (e: any) {
      setState(e.message);
    }
  };
  if (state === 'done') return <p className="store-card mt-4 animate-fade-up p-6 text-center">{t('thanks')}</p>;
  return (
    <section className="mt-4 store-card p-6 sm:p-7">
      <p className="font-semibold">{t('rate')}</p>
      <div className="mt-3 flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => <button key={n} onClick={() => setRating(n)} aria-label={`${n} stars`}><Star className={cn('h-8 w-8', n <= rating ? 'fill-amber-400 text-amber-400' : 'opacity-25')} /></button>)}
      </div>
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('comment')} maxLength={1000} className="mt-3 min-h-[70px] w-full rounded-[calc(var(--radius)*0.7)] border border-black/10 bg-store-bg p-3 text-sm outline-none" />
      {!['idle', 'busy'].includes(state) && <p className="mt-1 text-xs text-red-600">{state}</p>}
      <button onClick={send} disabled={!rating || state === 'busy'} className="mt-3 rounded-full bg-brand px-6 py-2.5 text-sm font-semibold text-brand-ink disabled:opacity-40">{t('send')}</button>
    </section>
  );
}

const DELIVERY_TEXT: Record<string, string> = { awaiting_assignment: 'Finding a rider', assigned: 'Rider assigned', rider_accepted: 'Rider is coming to the restaurant', picked_up: 'Picked up', on_the_way: 'On the way to you', delivered: 'Delivered', failed: 'Delivery attempt failed — the restaurant will contact you', returned: 'Returned to the restaurant', cancelled: 'Delivery cancelled' };

/** Status-based delivery tracking: no live map; the rider's position is never shown to customers. */
function DeliveryStatus({ d, t }: { d: any; t: (k: TKey) => string }) {
  const showCode = d.code && ['assigned', 'rider_accepted', 'picked_up', 'on_the_way'].includes(d.status);
  return (
    <div className="mt-3 rounded-brand-sm bg-black/5 px-4 py-3 text-sm">
      <p className="font-semibold">{DELIVERY_TEXT[d.status] ?? d.status}</p>
      {d.riderFirstName && <p className="opacity-75">{t('riderLabel')}: {d.riderFirstName}</p>}
      {d.etaAt && !['delivered', 'returned', 'cancelled'].includes(d.status) && <p className="opacity-75">{t('dueBy')}: {new Date(d.etaAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
      {showCode && <p className="mt-1">{t('deliveryCode')}: <b className="font-mono text-lg tracking-widest">{d.code}</b></p>}
    </div>
  );
}
