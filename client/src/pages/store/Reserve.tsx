import { useState, type FormEvent } from 'react';
import { CalendarCheck } from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type { StoreInfo } from './Storefront';
import { toLocalInputValue } from '../../lib/util';

export default function Reserve({ store }: { store: StoreInfo }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', phone: '', email: '', partySize: 2, reservedFor: '', notes: '' });
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [err, setErr] = useState('');
  if (!store.features.reservations) return <p className="py-24 text-center opacity-60">—</p>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('busy');
    setErr('');
    try {
      await api.post('/api/public/reservations', { ...f, email: f.email || undefined, notes: f.notes || undefined, partySize: Number(f.partySize), reservedFor: new Date(f.reservedFor).toISOString() });
      setState('done');
    } catch (e: any) {
      setErr(e.message);
      setState('idle');
    }
  };

  const input = 'store-input appearance-none';
  const min = toLocalInputValue(new Date(Date.now() + 30 * 60_000)); // datetime-local is local time

  return (
    <main className="mx-auto max-w-md animate-fade-up px-4 py-12 sm:py-16">
      <p className="eyebrow text-brand">{store.name}</p>
      <h1 className="mt-1 font-display text-[34px] font-semibold tracking-tight">{t('reserveTitle')}</h1>
      {store.settings.openingHours && <p className="mt-1 text-sm opacity-70">{t('hours')}: {store.settings.openingHours}</p>}
      {state === 'done' ? (
        <div className="mt-8 store-card animate-scale-in p-8 text-center">
          <CalendarCheck className="mx-auto h-10 w-10 text-brand" />
          <p className="mt-3 font-medium">{t('reservationSent')}</p>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-3">
          <input required className={input} placeholder={t('yourName')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} />
          <input required className={input} placeholder={t('phone')} inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={25} />
          <input type="email" className={input} placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3">
            <label className="block"><span className="mb-1 block text-xs opacity-70">{t('partySize')}</span><input required type="number" min={1} max={50} className={input} value={f.partySize} onChange={(e) => setF({ ...f, partySize: Number(e.target.value) })} /></label>
            <label className="block min-w-0"><span className="mb-1 block text-xs opacity-70">{t('dateTime')}</span><input required type="datetime-local" min={min} className={input} value={f.reservedFor} onChange={(e) => setF({ ...f, reservedFor: e.target.value })} /></label>
          </div>
          <textarea className={`${input} h-24 py-3`} placeholder={t('notes')} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={500} />
          {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
          <button disabled={state === 'busy'} className="store-btn w-full">{state === 'busy' ? '…' : t('submit')}</button>
        </form>
      )}
    </main>
  );
}
