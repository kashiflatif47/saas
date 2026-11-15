import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { api } from '../../api/client';
import { I18nProvider, type Lang } from '../../i18n';
import { CartProvider } from '../../store/cart';
import { applyTheme } from '../../lib/util';
import { assetUrl } from '../../api/client';
import { Loading } from '../../components/ui';
import { StoreLayout } from './StoreLayout';
import MenuView from './MenuView';
import TableLanding from './TableLanding';
import OrderTracking from './OrderTracking';
import Reserve from './Reserve';

import Unsubscribe from './Unsubscribe';
import TenantNotFound from './TenantNotFound';

export interface StoreInfo {
  name: string;
  slug: string;
  businessType: string;
  contact: any;
  branding: any;
  settings: any;
  payments: { cash: boolean; online: { provider: 'stripe'; publicKey: string } | null };
  features: { reservations: boolean; qrOrdering: boolean };
  deliveryZones?: { _id: string; name: string; fee: number; minOrder: number; etaMinutes: number }[];
}

export default function Storefront({ slug }: { slug: string }) {
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [err, setErr] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    api
      .get<StoreInfo>('/api/public/storefront')
      .then((s) => {
        setStore(s);
        applyTheme(s.branding?.theme);
        document.title = s.name;
        const fav = document.getElementById('favicon') as HTMLLinkElement | null;
        if (fav && s.branding?.faviconUrl) {
          fav.href = assetUrl(s.branding.faviconUrl);
          fav.type = 'image/png';
        }
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta && s.branding?.theme?.secondary) meta.setAttribute('content', s.branding.theme.secondary);
      })
      .catch((e) => setErr({ status: e.status, message: e.message }));
  }, []);

  if (err?.status === 404) return <TenantNotFound slug={slug} />;
  if (err)
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-8 text-center">
        <p className="font-display text-3xl font-semibold">{err.status === 404 ? 'Restaurant not found' : 'Temporarily unavailable'}</p>
        <p className="mt-2 max-w-md text-stone-500">{err.status === 404 ? `There is no restaurant at “${slug}”. Check the address or scan the QR code again.` : 'This restaurant is not taking orders online right now. Please ask staff for help.'}</p>
      </div>
    );
  if (!store) return <Loading />;

  const langs = (store.settings.languages?.length ? store.settings.languages : ['en']) as Lang[];
  return (
    <I18nProvider storageKey={`lang:${slug}`} initial={(store.settings.defaultLanguage ?? 'en') as Lang}>
      <CartProvider tenantSlug={slug}>
        <Routes>
          <Route element={<StoreLayout store={store} languages={langs} />}>
            <Route index element={<MenuView store={store} />} />
            <Route path="t/:token" element={<TableLanding />} />
            <Route path="order/:id" element={<OrderTracking store={store} />} />
            <Route path="reserve" element={<Reserve store={store} />} />
            <Route path="unsubscribe" element={<Unsubscribe />} />
            <Route path="*" element={<MenuView store={store} />} />
          </Route>
        </Routes>
      </CartProvider>
    </I18nProvider>
  );
}
