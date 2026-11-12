import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';

/** Opt-out page linked from every marketing message. A click is required (link scanners do not unsubscribe people). */
export default function Unsubscribe() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const go = async () => {
    setState('busy');
    try {
      await api.post('/api/public/unsubscribe', { c: params.get('c') ?? '', t: params.get('t') ?? '' });
      setState('done');
    } catch (e: any) {
      setMsg(e.message);
      setState('error');
    }
  };
  return (
    <main className="mx-auto max-w-md px-6 py-20 text-center">
      <h1 className="font-display text-3xl font-semibold">{t('unsubTitle')}</h1>
      {state === 'done' ? <p className="mt-4 opacity-80">{t('unsubDone')}</p> : (
        <>
          <button onClick={go} disabled={state === 'busy'} className="mt-6 rounded-brand-sm bg-brand px-6 py-3 font-semibold text-brand-ink disabled:opacity-50">{t('unsubConfirm')}</button>
          {state === 'error' && <p className="mt-3 text-sm text-red-600">{msg}</p>}
        </>
      )}
    </main>
  );
}
