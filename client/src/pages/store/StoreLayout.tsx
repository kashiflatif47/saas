import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { CalendarDays, Globe, Instagram, Facebook, MessageCircle, MapPin, Clock, Phone, Music2 } from 'lucide-react';
import { assetUrl } from '../../api/client';
import { useI18n, LANG_LABEL, type Lang } from '../../i18n';
import { useCart } from '../../store/cart';
import { cn } from '../../lib/util';
import type { StoreInfo } from './Storefront';

/**
 * The single storefront frame shared by every restaurant. Restaurants change only theme variables
 * (colours, fonts, radius) and content (logo, name, text, images, menu); the structure is fixed.
 */
export function StoreLayout({ store, languages }: { store: StoreInfo; languages: Lang[] }) {
  const { t, lang, setLang, pick } = useI18n();
  const { tableLabel } = useCart();
  const loc = useLocation();
  const b = store.branding ?? {};
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  // The home page has a full-bleed hero: the header floats over it until the page scrolls.
  const overHero = loc.pathname === '/' && !scrolled;
  const year = new Date().getFullYear();
  const socials = [
    b.socials?.instagram && { href: b.socials.instagram, label: 'Instagram', Icon: Instagram },
    b.socials?.facebook && { href: b.socials.facebook, label: 'Facebook', Icon: Facebook },
    b.socials?.tiktok && { href: b.socials.tiktok, label: 'TikTok', Icon: Music2 },
    b.socials?.whatsapp && { href: `https://wa.me/${b.socials.whatsapp.replace(/[^\d]/g, '')}`, label: 'WhatsApp', Icon: MessageCircle },
  ].filter(Boolean) as { href: string; label: string; Icon: typeof Instagram }[];

  return (
    <div className="min-h-screen bg-store-bg font-sans text-store-text">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[70] focus:rounded-full focus:bg-brand focus:px-4 focus:py-2 focus:text-brand-ink">
        {t('browseMenu')}
      </a>
      <header
        className={cn(
          'fixed inset-x-0 top-0 z-40 transition-[background-color,box-shadow,color] duration-300',
          overHero ? 'bg-transparent text-white' : 'bg-store-secondary/95 text-store-secondary-ink shadow-[0_1px_0_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.25)] backdrop-blur-xl',
        )}
      >
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-2.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
            {b.logoUrl ? (
              <img src={assetUrl(b.logoUrl)} alt="" className="h-9 w-9 shrink-0 rounded-xl bg-white object-cover ring-1 ring-black/5" />
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand font-display text-base font-bold text-brand-ink">{store.name[0]}</span>
            )}
            <span className="truncate font-display text-lg font-semibold tracking-tight">{store.name}</span>
          </Link>
          {tableLabel && (
            <span className="hidden shrink-0 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold ring-1 ring-white/25 min-[400px]:inline">
              {t('table')} {tableLabel}
            </span>
          )}
          <div className="ms-auto flex shrink-0 items-center gap-1">
            {store.features.reservations && (
              <Link to="/reserve" className="flex items-center gap-1.5 rounded-full px-2.5 py-2 text-sm font-medium transition hover:bg-white/10 hover:bg-store-secondary-ink/10 sm:px-3.5" aria-label={t('reserve')}>
                <CalendarDays className="h-4 w-4" /> <span className="hidden sm:inline">{t('reserve')}</span>
              </Link>
            )}
            {languages.length > 1 && (
              <label className="relative flex items-center gap-1 rounded-full px-2.5 py-2 text-sm transition hover:bg-store-secondary-ink/10">
                <Globe className="h-4 w-4" aria-hidden />
                <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="cursor-pointer appearance-none bg-transparent pe-1 font-medium outline-none" aria-label="Language">
                  {languages.map((l) => (
                    <option key={l} value={l} className="text-stone-900">
                      {LANG_LABEL[l]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
        {tableLabel && (
          <div className={cn('px-4 pb-2 text-center text-xs font-semibold min-[400px]:hidden', overHero ? 'text-white/90' : '')}>
            {t('table')} {tableLabel}
          </div>
        )}
      </header>

      {/* Pages other than home sit below the fixed header. */}
      <div id="main" className={loc.pathname === '/' ? '' : 'pt-16'}>
        <Outlet />
      </div>

      <footer className="mt-20 bg-store-secondary text-store-secondary-ink">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-3">
              {b.logoUrl ? <img src={assetUrl(b.logoUrl)} alt="" className="h-11 w-11 rounded-xl bg-white object-cover" /> : <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand font-display text-lg font-bold text-brand-ink">{store.name[0]}</span>}
              <p className="font-display text-2xl font-semibold tracking-tight">{store.name}</p>
            </div>
            {pick(b.about) && <p className="mt-4 max-w-md text-sm leading-relaxed opacity-75">{pick(b.about)}</p>}
            {socials.length > 0 && (
              <div className="mt-6 flex gap-2">
                {socials.map(({ href, label, Icon }) => (
                  <a key={label} href={href} target="_blank" rel="noreferrer" aria-label={label} className="rounded-full bg-store-secondary-ink/10 p-2.5 ring-1 ring-store-secondary-ink/15 transition hover:bg-store-secondary-ink/20">
                    <Icon className="h-4 w-4" />
                  </a>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-3 text-sm">
            <p className="eyebrow opacity-60">{t('visit')}</p>
            {(store.contact?.address || store.contact?.city) && (
              <p className="flex gap-2.5 opacity-90">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 opacity-70" /> {[store.contact.address, store.contact.city, store.contact.country].filter(Boolean).join(', ')}
              </p>
            )}
            {store.contact?.phone && (
              <a className="flex gap-2.5 opacity-90 hover:opacity-100" href={`tel:${store.contact.phone}`}>
                <Phone className="mt-0.5 h-4 w-4 shrink-0 opacity-70" /> {store.contact.phone}
              </a>
            )}
          </div>
          <div className="space-y-3 text-sm">
            <p className="eyebrow opacity-60">{t('hours')}</p>
            {store.settings.openingHours ? (
              <p className="flex gap-2.5 whitespace-pre-line opacity-90">
                <Clock className="mt-0.5 h-4 w-4 shrink-0 opacity-70" /> {store.settings.openingHours}
              </p>
            ) : (
              <p className="opacity-60">—</p>
            )}
          </div>
        </div>
        <div className="border-t border-store-secondary-ink/10">
          <p className="mx-auto max-w-6xl px-4 py-5 text-xs opacity-55 sm:px-6">
            © {year} {store.name}
          </p>
        </div>
      </footer>
    </div>
  );
}
