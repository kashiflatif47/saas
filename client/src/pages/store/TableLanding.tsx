import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useCart } from '../../store/cart';
import { useI18n } from '../../i18n';
import { Loading } from '../../components/ui';

/** QR entry point: validates the table token against THIS tenant, remembers it, then opens the menu. */
export default function TableLanding() {
  const { token } = useParams();
  const { setTable } = useCart();
  const { t } = useI18n();
  const [state, setState] = useState<'loading' | 'ok' | 'bad'>('loading');
  useEffect(() => {
    api
      .get(`/api/public/tables/${encodeURIComponent(token ?? '')}`)
      .then((r) => {
        setTable(r.token, r.label);
        setState('ok');
      })
      .catch(() => {
        setTable(null, null);
        setState('bad');
      });
  }, [token, setTable]);
  if (state === 'loading') return <Loading />;
  if (state === 'ok') return <Navigate to="/" replace />;
  return (
    <div className="mx-auto max-w-md px-6 py-24 text-center">
      <p className="font-display text-2xl font-semibold">QR code expired</p>
      <p className="mt-2 opacity-70">{t('scanAgain')}</p>
      <Link to="/" className="store-btn mt-6">{t('viewMenu')}</Link>
    </div>
  );
}
