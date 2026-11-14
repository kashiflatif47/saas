import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDown, CalendarDays, Check, Clock, Flame, Leaf, MapPin, Minus, Phone, Plus, Search, ShoppingBag, Sparkles, Star, Tag, Trash2, UtensilsCrossed, X } from 'lucide-react';
import { api, assetUrl } from '../../api/client';
import { useI18n } from '../../i18n';
import { useCart } from '../../store/cart';
import { cn, formatMoney } from '../../lib/util';
import { Loading } from '../../components/ui';
import { useReveal, useScrollSpy } from '../../hooks/useInView';
import type { StoreInfo } from './Storefront';

type Money = (n: number) => string;

export default function MenuView({ store }: { store: StoreInfo }) {
  const { t, pick, lang } = useI18n();
  const cart = useCart();
  const [menu, setMenu] = useState<{ categories: any[]; products: any[] } | null>(null);
  const [reviews, setReviews] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState<any | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [added, setAdded] = useState(false);
  const pillBar = useRef<HTMLDivElement>(null);
  const money: Money = (n) => formatMoney(n, store.settings.currency, store.settings.currencyDecimals, lang === 'en' ? 'en' : lang === 'ur' ? 'ur-PK' : 'ar');
  const b = store.branding ?? {};

  useEffect(() => {
    api.get('/api/public/menu').then(setMenu).catch((e) => setError(e.message));
    // Published guest reviews (owners choose which to publish in Dashboard → Feedback).
    api.get('/api/public/feedback').then((r) => setReviews(r.items ?? [])).catch(() => setReviews([]));
  }, []);

  const top = useMemo(() => (menu?.categories ?? []).filter((c) => !c.parentId), [menu]);
  const byCat = useMemo(() => {
    const m = new Map<string, any[]>();
    const needle = q.trim().toLowerCase();
    for (const p of menu?.products ?? []) {
      if (needle && ![p.name.en, p.name.ur, p.name.ar, p.description?.en, ...(p.tags ?? [])].some((s) => s?.toLowerCase().includes(needle))) continue;
      const cat = menu!.categories.find((c) => c._id === p.categoryId);
      const key = cat?.parentId ?? p.categoryId;
      m.set(key, [...(m.get(key) ?? []), p]);
    }
    return m;
  }, [menu, q]);
  const shownCats = top.filter((c) => (byCat.get(c._id) ?? []).length > 0);
  const featured = (menu?.products ?? []).filter((p) => p.isFeatured && !p.soldOut).slice(0, 10);
  const offers = (menu?.products ?? []).filter((p) => p.effectivePrice < p.price && !p.soldOut).slice(0, 10);
  const active = useScrollSpy(shownCats.map((c) => `cat-${c._id}`), 150);

  // Keep the active category pill visible inside the horizontally scrolling bar.
  useEffect(() => {
    const bar = pillBar.current;
    const pill = bar?.querySelector<HTMLElement>(`[data-cat="${active}"]`);
    if (bar && pill) bar.scrollTo({ left: pill.offsetLeft - bar.clientWidth / 2 + pill.clientWidth / 2, behavior: 'smooth' });
  }, [active]);

  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 140, behavior: 'smooth' });
  };
  const onAdded = () => {
    setAdded(true);
    window.setTimeout(() => setAdded(false), 1800);
  };

  if (error) return <p className="px-6 pb-24 pt-32 text-center opacity-70">{error}</p>;
  if (!menu) return <div className="pt-24"><Loading /></div>;

  const heroImage = b.heroUrl || b.coverUrl;
  const avg = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
  const types: string[] = store.settings.orderTypes ?? [];

  return (
    <>
      {/* ---------- Hero ---------- */}
      <section className="relative isolate overflow-hidden bg-ink-950 text-white">
        {heroImage ? (
          <img src={assetUrl(heroImage)} alt="" className="absolute inset-0 -z-10 h-full w-full animate-ken-burns object-cover" />
        ) : (
          <div className="absolute inset-0 -z-10 bg-[radial-gradient(70%_60%_at_15%_10%,rgb(var(--brand)/0.55),transparent_70%),radial-gradient(60%_50%_at_90%_100%,rgb(var(--accent)/0.35),transparent_70%)]" />
        )}
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/85 via-black/45 to-black/30" />
        <div className="mx-auto flex min-h-[68vh] max-w-6xl flex-col justify-end px-4 pb-14 pt-28 sm:min-h-[560px] sm:px-6 sm:pb-20">
          <div className="max-w-2xl animate-fade-up">
            {b.logoUrl && <img src={assetUrl(b.logoUrl)} alt={store.name} className="mb-6 h-16 w-16 rounded-2xl bg-white object-cover shadow-float ring-1 ring-white/30 sm:h-20 sm:w-20" />}
            <p className="eyebrow mb-3 text-white/70">
              {[store.businessType?.replace('_', ' '), store.contact?.city].filter(Boolean).join(' · ')}
            </p>
            <h1 className="font-display text-[40px] font-semibold leading-[1.02] tracking-tight sm:text-6xl">{pick(b.heroTitle) || store.name}</h1>
            {pick(b.heroSubtitle) && <p className="mt-4 max-w-xl text-base leading-relaxed text-white/80 sm:text-lg">{pick(b.heroSubtitle)}</p>}
            <div className="mt-8 flex flex-wrap gap-3">
              <button onClick={() => jump('menu')} className="store-btn">
                {t('browseMenu')} <ArrowDown className="h-4 w-4" />
              </button>
              {store.features.reservations && (
                <Link to="/reserve" className="inline-flex h-12 items-center gap-2 rounded-full bg-white/10 px-6 font-semibold text-white ring-1 ring-white/25 backdrop-blur transition hover:bg-white/20">
                  <CalendarDays className="h-4 w-4" /> {t('reserve')}
                </Link>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ---------- Info strip ---------- */}
      <div className="relative z-10 mx-auto -mt-6 max-w-6xl px-4 sm:px-6">
        <div className="flex flex-wrap gap-x-1 gap-y-0.5 rounded-brand-lg bg-store-surface p-2 shadow-lift ring-1 ring-store-text/5">
          {store.settings.openingHours && (
            <span className="store-chip whitespace-normal border-transparent bg-transparent">
              <Clock className="h-4 w-4 text-brand" /> {store.settings.openingHours}
            </span>
          )}
          {(store.contact?.address || store.contact?.city) && (
            <span className="store-chip whitespace-normal border-transparent bg-transparent">
              <MapPin className="h-4 w-4 text-brand" /> {[store.contact.address, store.contact.city].filter(Boolean).join(', ')}
            </span>
          )}
          {store.contact?.phone && (
            <a href={`tel:${store.contact.phone}`} className="store-chip whitespace-normal border-transparent bg-transparent hover:bg-store-text/5">
              <Phone className="h-4 w-4 text-brand" /> {store.contact.phone}
            </a>
          )}
          {types.length > 0 && (
            <span className="store-chip whitespace-normal border-transparent bg-transparent">
              <UtensilsCrossed className="h-4 w-4 text-brand" /> {types.map((x) => t(x === 'dine_in' ? 'dineIn' : x === 'takeaway' ? 'takeaway' : x === 'pickup' ? 'pickup' : 'delivery')).join(' · ')}
            </span>
          )}
          {reviews.length > 0 && (
            <span className="store-chip whitespace-normal border-transparent bg-transparent">
              <Star className="h-4 w-4 fill-accent text-accent" /> {avg.toFixed(1)} · {t('guestRating')}
            </span>
          )}
        </div>
      </div>

      {!store.settings.guestOrdering && <p className="mx-auto mt-6 max-w-6xl rounded-brand bg-amber-100 px-4 py-3 text-center text-sm text-amber-900">{t('orderingClosed')}</p>}

      <div className="mx-auto max-w-6xl px-4 pb-32 sm:px-6">
        {!q && offers.length > 0 && (
          <Shelf title={t('offers')} icon={<Tag className="h-4 w-4" />}>
            {offers.map((p) => (
              <ShelfCard key={p._id} p={p} money={money} onOpen={() => setSheet(p)} badge={`−${Math.round((1 - p.effectivePrice / p.price) * 100)}%`} />
            ))}
          </Shelf>
        )}
        {!q && featured.length > 0 && (
          <Shelf title={t('featured')} icon={<Sparkles className="h-4 w-4" />}>
            {featured.map((p) => (
              <ShelfCard key={p._id} p={p} money={money} onOpen={() => setSheet(p)} />
            ))}
          </Shelf>
        )}

        {/* ---------- Menu ---------- */}
        <section id="menu" className="scroll-mt-20 pt-14" aria-label={t('ourMenu')}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow text-brand">{store.name}</p>
              <h2 className="mt-1 font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('ourMenu')}</h2>
            </div>
            <p className="text-sm opacity-60">
              {menu.products.length} {t(menu.products.length === 1 ? 'dish' : 'dishes')}
            </p>
          </div>
        </section>

        <div className="sticky top-16 z-30 -mx-4 mt-5 border-b border-store-text/[0.06] bg-store-bg/90 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:px-6">
          <div className="relative">
            <Search className="pointer-events-none absolute start-4 top-1/2 h-4 w-4 -translate-y-1/2 opacity-45" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="store-input h-11 rounded-full ps-11" aria-label={t('search')} type="search" />
            {q && (
              <button onClick={() => setQ('')} className="absolute end-2 top-1/2 -translate-y-1/2 rounded-full p-2 opacity-60 hover:opacity-100" aria-label="Clear search">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {shownCats.length > 1 && (
            <nav ref={pillBar} className="scrollbar-none -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 sm:-mx-6 sm:px-6" aria-label="Menu categories">
              {shownCats.map((c) => {
                const on = active === `cat-${c._id}`;
                return (
                  <button
                    key={c._id}
                    data-cat={`cat-${c._id}`}
                    onClick={() => jump(`cat-${c._id}`)}
                    aria-current={on ? 'true' : undefined}
                    className={cn('whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition duration-200', on ? 'bg-brand text-brand-ink shadow-soft' : 'bg-store-surface ring-1 ring-store-text/[0.08] hover:ring-store-text/20')}
                  >
                    {pick(c.name)}
                  </button>
                );
              })}
            </nav>
          )}
        </div>

        {menu.products.length === 0 && <p className="py-24 text-center opacity-70" role="status">{t('menuEmpty')}</p>}
        {menu.products.length > 0 && q.trim() !== '' && byCat.size === 0 && <p className="py-20 text-center opacity-70" role="status">{t('noResults')}</p>}

        {shownCats.map((c) => (
          <CategorySection key={c._id} id={`cat-${c._id}`} category={c} items={byCat.get(c._id) ?? []} money={money} onOpen={setSheet} />
        ))}

        {/* ---------- Reviews ---------- */}
        {!q && reviews.length > 0 && <Reviews reviews={reviews} avg={avg} />}
      </div>

      {/* ---------- Floating cart ---------- */}
      {cart.count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {added && (
            <p className="mx-auto mb-2 flex w-fit animate-scale-in items-center gap-2 rounded-full bg-ink-900/90 px-4 py-2 text-sm font-medium text-white shadow-lift backdrop-blur" role="status">
              <Check className="h-4 w-4 text-emerald-400" /> {t('addedToCart')}
            </p>
          )}
          <button onClick={() => setCartOpen(true)} className="mx-auto flex h-14 w-full max-w-md animate-fade-up items-center gap-3 rounded-full bg-brand px-5 text-brand-ink shadow-float transition active:scale-[0.99]">
            <span key={cart.count} className="flex h-8 min-w-8 animate-pop items-center justify-center rounded-full bg-black/15 px-2 text-sm font-bold">
              {cart.count}
            </span>
            <span className="font-semibold">{t('viewOrder')}</span>
            <span className="tabular ms-auto font-semibold">{money(cart.subtotal)}</span>
            <ShoppingBag className="h-5 w-5" />
          </button>
        </div>
      )}

      {sheet && <ProductSheet p={sheet} money={money} onClose={() => setSheet(null)} onAdded={onAdded} />}
      {cartOpen && <CartSheet store={store} money={money} onClose={() => setCartOpen(false)} />}
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

function Shelf({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  const ref = useReveal<HTMLElement>();
  return (
    <section ref={ref} className="reveal pt-14">
      <h2 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-tight sm:text-[28px]">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand/10 text-brand">{icon}</span>
        {title}
      </h2>
      <div className="scrollbar-none -mx-4 mt-5 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6">{children}</div>
    </section>
  );
}

function ShelfCard({ p, money, onOpen, badge }: { p: any; money: Money; onOpen: () => void; badge?: string }) {
  const { pick } = useI18n();
  return (
    <button onClick={onOpen} className="group w-[248px] shrink-0 snap-start overflow-hidden rounded-brand-lg bg-store-surface text-start shadow-card ring-1 ring-store-text/[0.06] transition duration-300 hover:-translate-y-1 hover:shadow-lift sm:w-[280px]">
      <div className="relative aspect-[4/3] overflow-hidden bg-accent/15">
        {p.images[0] ? (
          <img src={assetUrl(p.images[0])} alt="" className="h-full w-full object-cover transition duration-700 ease-out group-hover:scale-105" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center text-store-text/25">
            <UtensilsCrossed className="h-10 w-10" />
          </div>
        )}
        {badge && <span className="absolute start-3 top-3 rounded-full bg-brand px-2.5 py-1 text-xs font-bold text-brand-ink shadow-soft">{badge}</span>}
      </div>
      <div className="p-4">
        <p className="line-clamp-1 font-display text-lg font-semibold leading-snug">{pick(p.name)}</p>
        {pick(p.description) && <p className="mt-1 line-clamp-1 text-sm opacity-60">{pick(p.description)}</p>}
        <div className="mt-2.5">
          <Price p={p} money={money} />
        </div>
      </div>
    </button>
  );
}

function CategorySection({ id, category, items, money, onOpen }: { id: string; category: any; items: any[]; money: Money; onOpen: (p: any) => void }) {
  const { pick, t } = useI18n();
  const ref = useReveal<HTMLElement>(0.05);
  return (
    <section ref={ref} id={id} className="reveal scroll-mt-36 pt-12">
      <div className="flex items-end gap-4">
        {category.imageUrl && <img src={assetUrl(category.imageUrl)} alt="" className="h-14 w-14 shrink-0 rounded-brand object-cover shadow-soft" loading="lazy" />}
        <div className="min-w-0">
          <h3 className="font-display text-2xl font-semibold tracking-tight sm:text-[28px]">{pick(category.name)}</h3>
          {pick(category.description) && <p className="mt-1 text-sm opacity-65">{pick(category.description)}</p>}
        </div>
        <span className="ms-auto shrink-0 pb-1 text-xs font-medium opacity-50">
          {items.length} {t(items.length === 1 ? 'dish' : 'dishes')}
        </span>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2 md:gap-5">
        {items.map((p) => (
          <DishCard key={p._id} p={p} money={money} onOpen={() => onOpen(p)} />
        ))}
      </div>
    </section>
  );
}

function DishCard({ p, money, onOpen }: { p: any; money: Money; onOpen: () => void }) {
  const { t, pick } = useI18n();
  return (
    <button
      disabled={p.soldOut}
      onClick={onOpen}
      className={cn(
        'group relative flex gap-4 rounded-brand-lg bg-store-surface p-4 text-start shadow-card ring-1 ring-store-text/[0.06] transition duration-300 sm:gap-5 sm:p-5',
        p.soldOut ? 'cursor-not-allowed opacity-60' : 'hover:-translate-y-0.5 hover:shadow-lift',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start gap-2">
          <p className="font-display text-[17px] font-semibold leading-snug sm:text-lg">{pick(p.name)}</p>
          {p.isFeatured && <Sparkles className="mt-1 h-3.5 w-3.5 shrink-0 text-accent" aria-label="Chef's pick" />}
        </div>
        {pick(p.description) && <p className="mt-1 line-clamp-2 text-sm leading-relaxed opacity-65">{pick(p.description)}</p>}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
          <Price p={p} money={money} />
          {p.tags?.some((x: string) => /spic/i.test(x)) && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-600">
              <Flame className="h-3 w-3" aria-hidden /> spicy
            </span>
          )}
          {p.tags?.some((x: string) => /veg/i.test(x)) && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
              <Leaf className="h-3 w-3" aria-hidden /> veg
            </span>
          )}
          {p.soldOut && <span className="rounded-full bg-store-text/10 px-2 py-0.5 text-[11px] font-semibold">{t('soldOut')}</span>}
        </div>
      </div>
      <div className="relative h-[108px] w-[108px] shrink-0 overflow-hidden rounded-brand bg-accent/15 sm:h-32 sm:w-32">
        {p.images[0] ? (
          <img src={assetUrl(p.images[0])} alt="" className="h-full w-full object-cover transition duration-700 ease-out group-hover:scale-105" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center text-store-text/25">
            <UtensilsCrossed className="h-7 w-7" />
          </div>
        )}
        {!p.soldOut && (
          <span className="absolute bottom-2 end-2 flex h-8 w-8 items-center justify-center rounded-full bg-brand text-brand-ink shadow-lift transition duration-200 group-hover:scale-110">
            <Plus className="h-4 w-4" />
          </span>
        )}
      </div>
    </button>
  );
}

function Price({ p, money }: { p: any; money: Money }) {
  const { t } = useI18n();
  const promo = p.effectivePrice < p.price;
  return (
    <span className="tabular text-[15px] font-semibold">
      {p.variants?.length > 0 && <span className="me-1 text-xs font-normal opacity-60">{t('from')}</span>}
      <span className={promo ? 'text-brand' : ''}>{money(p.effectivePrice)}</span>
      {promo && <span className="ms-1.5 text-xs font-normal line-through opacity-45">{money(p.price)}</span>}
    </span>
  );
}

function Reviews({ reviews, avg }: { reviews: any[]; avg: number }) {
  const { t } = useI18n();
  const ref = useReveal<HTMLElement>();
  return (
    <section ref={ref} className="reveal pt-20">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-display text-3xl font-semibold tracking-tight">{t('reviews')}</h2>
        <p className="flex items-center gap-2 text-sm">
          <Stars n={Math.round(avg)} /> <span className="tabular font-semibold">{avg.toFixed(1)}</span>
          <span className="opacity-55">({reviews.length})</span>
        </p>
      </div>
      <div className="stagger mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {reviews.map((r) => (
          <figure key={r._id} className="store-card flex flex-col p-5">
            <Stars n={r.rating} />
            {r.comment && <blockquote className="mt-3 flex-1 text-[15px] leading-relaxed opacity-85">“{r.comment}”</blockquote>}
            <figcaption className="mt-4 text-sm font-medium opacity-65">
              {r.name || 'Guest'} · {new Date(r.createdAt).toLocaleDateString()}
            </figcaption>
            {r.response && <p className="mt-3 rounded-brand-sm bg-store-text/[0.04] p-3 text-sm opacity-80">{r.response}</p>}
          </figure>
        ))}
      </div>
    </section>
  );
}

const Stars = ({ n }: { n: number }) => (
  <span className="flex gap-0.5" aria-label={`${n} / 5`}>
    {[1, 2, 3, 4, 5].map((i) => (
      <Star key={i} className={cn('h-4 w-4', i <= n ? 'fill-accent text-accent' : 'text-store-text/20')} />
    ))}
  </span>
);

/* ------------------------------------------------------------------ sheets */

function Sheet({ children, onClose, label }: { children: ReactNode; onClose: () => void; label: string }) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', h);
      document.body.style.overflow = '';
      opener?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={label}>
      <div className="absolute inset-0 animate-fade-in bg-black/55 backdrop-blur-[3px]" onClick={onClose} />
      <div className="relative flex max-h-[94vh] w-full max-w-lg animate-sheet-up flex-col overflow-hidden rounded-t-[calc(var(--radius)*1.8)] bg-store-bg text-store-text shadow-float sm:max-w-xl sm:animate-scale-in sm:rounded-[calc(var(--radius)*1.6)]">
        <button onClick={onClose} className="absolute end-3 top-3 z-10 rounded-full bg-white/90 p-2.5 text-stone-900 shadow-soft backdrop-blur transition hover:bg-white" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
        {children}
      </div>
    </div>
  );
}

function ProductSheet({ p, money, onClose, onAdded }: { p: any; money: Money; onClose: () => void; onAdded: () => void }) {
  const { t, pick } = useI18n();
  const cart = useCart();
  const gallery = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState(0);
  const [variantId, setVariantId] = useState<string>(p.variants[0]?._id ?? '');
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const v = p.variants.find((x: any) => x._id === variantId);
  const unit = p.effectivePrice + (v?.priceDelta ?? 0) + addonIds.reduce((s, id) => s + (p.addons.find((a: any) => a._id === id)?.price ?? 0), 0);

  const add = () => {
    cart.add({ productId: p._id, name: p.name, image: p.images[0], variantId: variantId || undefined, variantName: v?.name, addonIds, addonNames: addonIds.map((id) => p.addons.find((a: any) => a._id === id)?.name ?? ''), unitPrice: unit, quantity: qty, notes: notes.trim() || undefined });
    onAdded();
    onClose();
  };
  const goTo = (i: number) => {
    const el = gallery.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };

  return (
    <Sheet onClose={onClose} label={pick(p.name)}>
      <div className="scrollbar-thin overflow-y-auto">
        {p.images.length > 0 ? (
          <div className="relative bg-accent/15">
            {/* Swipeable gallery (scroll-snap); dots and thumbnails stay in sync with the visible photo. */}
            <div ref={gallery} onScroll={(e) => setImg(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))} className="scrollbar-none flex aspect-[4/3] snap-x snap-mandatory overflow-x-auto">
              {p.images.map((src: string, i: number) => (
                <img key={src} src={assetUrl(src)} alt={i === 0 ? pick(p.name) : ''} className="h-full w-full shrink-0 snap-center object-cover" />
              ))}
            </div>
            {p.images.length > 1 && (
              <div className="absolute bottom-3 flex w-full justify-center gap-1.5">
                {p.images.map((_: string, i: number) => (
                  <button key={i} onClick={() => goTo(i)} className={cn('h-1.5 rounded-full transition-all duration-300', i === img ? 'w-5 bg-white' : 'w-1.5 bg-white/55')} aria-label={`Photo ${i + 1}`} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="h-14" />
        )}
        {p.images.length > 1 && (
          <div className="scrollbar-none hidden gap-2 overflow-x-auto px-6 pt-4 sm:flex">
            {p.images.map((src: string, i: number) => (
              <button key={src} onClick={() => goTo(i)} className={cn('h-14 w-14 shrink-0 overflow-hidden rounded-brand-sm ring-2 transition', i === img ? 'ring-brand' : 'ring-transparent opacity-60 hover:opacity-100')} aria-label={`Photo ${i + 1}`}>
                <img src={assetUrl(src)} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}
        <div className="space-y-6 p-6">
          <div>
            <div className="flex flex-wrap gap-1.5">
              {(p.tags ?? []).slice(0, 4).map((tag: string) => (
                <span key={tag} className="rounded-full bg-brand/10 px-2.5 py-0.5 text-xs font-medium capitalize text-brand">
                  {tag}
                </span>
              ))}
            </div>
            <h3 className="mt-2 font-display text-[28px] font-semibold leading-tight tracking-tight">{pick(p.name)}</h3>
            <div className="mt-1.5">
              <Price p={p} money={money} />
            </div>
            {pick(p.description) && <p className="mt-3 text-[15px] leading-relaxed opacity-75">{pick(p.description)}</p>}
          </div>
          {p.variants.length > 0 && (
            <fieldset>
              <legend className="mb-2.5 text-sm font-semibold">{t('chooseOption')}</legend>
              <div className="space-y-2">
                {p.variants.map((x: any) => (
                  <label key={x._id} className={cn('flex cursor-pointer items-center justify-between rounded-brand-sm border px-4 py-3.5 transition', variantId === x._id ? 'border-brand bg-brand/[0.06] ring-1 ring-brand' : 'border-store-text/10 bg-store-surface hover:border-store-text/25')}>
                    <span className="flex items-center gap-3">
                      <input type="radio" name="variant" checked={variantId === x._id} onChange={() => setVariantId(x._id)} className="h-4 w-4 accent-[rgb(var(--brand))]" />
                      {x.name}
                    </span>
                    {x.priceDelta !== 0 && (
                      <span className="tabular text-sm opacity-70">
                        {x.priceDelta > 0 ? '+' : '−'}
                        {money(Math.abs(x.priceDelta))}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {p.addons.length > 0 && (
            <fieldset>
              <legend className="mb-2.5 text-sm font-semibold">{t('extras')}</legend>
              <div className="space-y-2">
                {p.addons.map((a: any) => {
                  const on = addonIds.includes(a._id);
                  return (
                    <label key={a._id} className={cn('flex cursor-pointer items-center justify-between rounded-brand-sm border px-4 py-3.5 transition', on ? 'border-brand bg-brand/[0.06]' : 'border-store-text/10 bg-store-surface hover:border-store-text/25')}>
                      <span className="flex items-center gap-3">
                        <input type="checkbox" checked={on} onChange={(e) => setAddonIds((prev) => (e.target.checked ? [...prev, a._id] : prev.filter((x) => x !== a._id)))} className="h-4 w-4 accent-[rgb(var(--brand))]" />
                        {a.name}
                      </span>
                      <span className="tabular text-sm opacity-70">+{money(a.price)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder={t('notes')} className="store-input h-auto min-h-[84px] py-3" />
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-store-text/[0.06] bg-store-bg/95 p-4 backdrop-blur">
        <div className="flex items-center rounded-full bg-store-surface ring-1 ring-store-text/10">
          <button className="rounded-full p-3 transition hover:bg-store-text/5" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Decrease">
            <Minus className="h-4 w-4" />
          </button>
          <span className="tabular w-7 text-center font-semibold" aria-live="polite">
            {qty}
          </span>
          <button className="rounded-full p-3 transition hover:bg-store-text/5" onClick={() => setQty((q) => Math.min(99, q + 1))} aria-label="Increase">
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <button onClick={add} className="store-btn h-12 flex-1 justify-between px-5">
          <span>{t('addToCart')}</span>
          <span className="tabular">{money(unit * qty)}</span>
        </button>
      </div>
    </Sheet>
  );
}

/** Random checkout key. getRandomValues also works on plain-http LAN addresses, where randomUUID is unavailable. */
function newCheckoutKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function CartSheet({ store, money, onClose }: { store: StoreInfo; money: Money; onClose: () => void }) {
  const { t, pick } = useI18n();
  const cart = useCart();
  const nav = useNavigate();
  const types: string[] = store.settings.orderTypes ?? ['dine_in'];
  const [type, setType] = useState<string>(cart.tableToken && types.includes('dine_in') ? 'dine_in' : types.find((x) => x !== 'dine_in') ?? types[0]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const zones = store.deliveryZones ?? [];
  const [zoneId, setZoneId] = useState('');
  const [loc, setLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [locMsg, setLocMsg] = useState('');
  const [consent, setConsent] = useState(false);
  const [notes, setNotes] = useState('');
  const [coupon, setCoupon] = useState('');
  const [couponInfo, setCouponInfo] = useState<any | null>(null);
  const [couponErr, setCouponErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // One key per checkout: a retry after a timeout or a double tap returns the same order instead of a duplicate.
  const checkoutKey = useRef(newCheckoutKey());
  const placing = useRef(false);

  // Display estimate only; the server recomputes every amount when the order is placed.
  const s = store.settings;
  const sub = cart.subtotal;
  const disc = couponInfo ? (couponInfo.minOrder && sub < couponInfo.minOrder ? 0 : couponInfo.type === 'percent' ? Math.min(Math.round((sub * couponInfo.value) / 100), couponInfo.maxDiscount ?? Infinity) : Math.min(couponInfo.value, sub)) : 0;
  const after = sub - disc;
  const service = Math.round((after * (s.serviceChargePercent ?? 0)) / 100);
  const zone = zones.find((z) => z._id === zoneId);
  // Display only: with zones the server picks the zone (from the shared location when given) and its fee.
  const fee = type === 'delivery' ? (zones.length ? zone?.fee ?? 0 : s.deliveryFee ?? 0) : 0; // same rule as the server: taxed, no service charge
  const taxable = after + service + fee;
  const tax = s.taxInclusive ? Math.round(taxable - taxable / (1 + (s.taxRatePercent ?? 0) / 100)) : Math.round((taxable * (s.taxRatePercent ?? 0)) / 100);
  const total = s.taxInclusive ? taxable : taxable + tax;
  const needsTable = type === 'dine_in' && s.requireTableForDineIn && !cart.tableToken;
  const needsAddress = type === 'delivery' && (address.trim().length < 5 || !phone.trim() || (zones.length > 0 && !zoneId && !loc));
  const shareLocation = () => {
    if (!('geolocation' in navigator)) return setLocMsg(t('locationFailed'));
    navigator.geolocation.getCurrentPosition((p) => { setLoc({ lat: p.coords.latitude, lng: p.coords.longitude }); setLocMsg(t('locationShared')); }, () => setLocMsg(t('locationFailed')), { timeout: 15_000 });
  };

  const applyCoupon = async () => {
    setCouponErr('');
    try {
      setCouponInfo(await api.post('/api/public/coupons/validate', { code: coupon }));
    } catch (e: any) {
      setCouponInfo(null);
      setCouponErr(e.message);
    }
  };

  const place = async () => {
    if (placing.current) return; // a second tap before the button re-renders as disabled
    placing.current = true;
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/api/public/orders', {
        type,
        tableToken: type === 'dine_in' ? cart.tableToken ?? undefined : undefined,
        customer: name || phone ? { name: name || undefined, phone: phone || undefined } : undefined,
        delivery: type === 'delivery' ? { address, zoneId: zoneId || undefined, location: loc ?? undefined } : undefined,
        marketingConsent: consent && phone ? true : undefined,
        notes: notes || undefined,
        couponCode: couponInfo?.code,
        idempotencyKey: checkoutKey.current,
        items: cart.lines.map((l) => ({ productId: l.productId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes })),
      });
      try {
        const mine = JSON.parse(localStorage.getItem(`orders:${store.slug}`) || '[]');
        localStorage.setItem(`orders:${store.slug}`, JSON.stringify([{ id: r.order._id, token: r.trackingToken, n: r.order.orderNumber, at: Date.now() }, ...mine].slice(0, 10)));
      } catch {
        /* storage unavailable (private mode): tracking still works from the URL */
      }
      cart.clear();
      onClose();
      nav(`/order/${r.order._id}?token=${encodeURIComponent(r.trackingToken)}&new=1`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      placing.current = false;
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onClose} label={t('cart')}>
      <div className="scrollbar-thin overflow-y-auto p-6">
        <h3 className="font-display text-[28px] font-semibold tracking-tight">{t('cart')}</h3>
        {cart.tableLabel && (
          <p className="mt-1 text-sm opacity-65">
            {t('table')} {cart.tableLabel}
          </p>
        )}
        {cart.lines.length === 0 ? (
          <div className="py-14 text-center">
            <ShoppingBag className="mx-auto h-10 w-10 opacity-25" />
            <p className="mt-3 font-medium">{t('emptyCart')}</p>
            <p className="mt-1 text-sm opacity-60">{t('emptyCartHint')}</p>
          </div>
        ) : (
          <>
            <ul className="mt-5 space-y-3">
              {cart.lines.map((l) => (
                <li key={l.key} className="flex animate-fade-up gap-3 rounded-brand bg-store-surface p-3 ring-1 ring-store-text/[0.06]">
                  {l.image && <img src={assetUrl(l.image)} alt="" className="h-16 w-16 shrink-0 rounded-brand-sm object-cover" />}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium leading-snug">{pick(l.name)}</p>
                    {(l.variantName || l.addonNames.length > 0) && <p className="text-xs opacity-60">{[l.variantName, ...l.addonNames].filter(Boolean).join(' · ')}</p>}
                    {l.notes && <p className="text-xs italic opacity-60">“{l.notes}”</p>}
                    <p className="tabular mt-1 text-sm font-semibold">{money(l.unitPrice * l.quantity)}</p>
                  </div>
                  <div className="flex items-center self-center rounded-full ring-1 ring-store-text/10">
                    <button className="rounded-full p-2 transition hover:bg-store-text/5" onClick={() => cart.setQty(l.key, l.quantity - 1)} aria-label={l.quantity === 1 ? t('remove') : 'Decrease'}>
                      {l.quantity === 1 ? <Trash2 className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
                    </button>
                    <span className="tabular w-5 text-center text-sm">{l.quantity}</span>
                    <button className="rounded-full p-2 transition hover:bg-store-text/5" onClick={() => cart.setQty(l.key, l.quantity + 1)} aria-label="Increase">
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {types.length > 1 && (
              <div className="mt-6">
                <p className="mb-2.5 text-sm font-semibold">{t('orderType')}</p>
                <div className="flex gap-1 rounded-full bg-store-text/[0.05] p-1">
                  {types.map((x) => (
                    <button key={x} onClick={() => setType(x)} className={cn('flex-1 rounded-full px-3 py-2 text-sm font-medium transition', type === x ? 'bg-brand text-brand-ink shadow-soft' : 'opacity-70 hover:opacity-100')}>
                      {t(x === 'dine_in' ? 'dineIn' : x === 'takeaway' ? 'takeaway' : x === 'pickup' ? 'pickup' : 'delivery')}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {needsTable && <p className="mt-3 rounded-brand-sm bg-amber-100 px-3.5 py-2.5 text-sm text-amber-900">{t('scanAgain')}</p>}

            <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('yourName')} className="store-input" maxLength={80} autoComplete="name" />
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t('phone')} inputMode="tel" className="store-input" maxLength={25} autoComplete="tel" />
              {type === 'delivery' && <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t('deliveryAddress')} className="store-input sm:col-span-2" maxLength={300} autoComplete="street-address" />}
              {type === 'delivery' && zones.length > 0 && (
                <>
                  <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} className="store-input" aria-label={t('deliveryArea')}>
                    <option value="">{t('chooseArea')}</option>
                    {zones.map((z) => <option key={z._id} value={z._id}>{z.name} · {money(z.fee)} · ~{z.etaMinutes} min</option>)}
                  </select>
                  <button type="button" onClick={shareLocation} className="store-input text-start text-sm">{loc ? `✓ ${t('locationShared')}` : t('shareLocation')}{locMsg && !loc ? ` — ${locMsg}` : ''}</button>
                  {zone && zone.minOrder > 0 && <p className="text-xs opacity-70 sm:col-span-2">{t('minOrderArea')}: {money(zone.minOrder)}</p>}
                </>
              )}
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('notes')} className="store-input sm:col-span-2" maxLength={500} />
              {phone.trim() && (
                <label className="flex items-start gap-2 text-sm opacity-80 sm:col-span-2">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" /> {t('consentMarketing')}
                </label>
              )}
            </div>
            <div className="mt-2.5 flex gap-2">
              <input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} placeholder={t('coupon')} className="store-input flex-1 uppercase" />
              <button onClick={applyCoupon} disabled={!coupon} className="rounded-brand-sm px-5 text-sm font-semibold ring-1 ring-store-text/15 transition hover:bg-store-text/5 disabled:opacity-40">
                {t('apply')}
              </button>
            </div>
            {couponErr && <p className="mt-1.5 text-xs text-red-600">{couponErr}</p>}

            <dl className="mt-6 space-y-2 rounded-brand bg-store-surface p-4 text-sm ring-1 ring-store-text/[0.06]">
              <div className="flex justify-between">
                <dt className="opacity-65">{t('subtotal')}</dt>
                <dd className="tabular">{money(sub)}</dd>
              </div>
              {disc > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <dt>
                    {t('discount')} ({couponInfo.code})
                  </dt>
                  <dd className="tabular">− {money(disc)}</dd>
                </div>
              )}
              {service > 0 && (
                <div className="flex justify-between">
                  <dt className="opacity-65">
                    {t('service')} ({s.serviceChargePercent}%)
                  </dt>
                  <dd className="tabular">{money(service)}</dd>
                </div>
              )}
              {fee > 0 && (
                <div className="flex justify-between">
                  <dt className="opacity-65">{t('deliveryFee')}</dt>
                  <dd className="tabular">{money(fee)}</dd>
                </div>
              )}
              {(s.taxRatePercent ?? 0) > 0 && (
                <div className="flex justify-between">
                  <dt className="opacity-65">
                    {t('tax')} ({s.taxRatePercent}%{s.taxInclusive ? ' incl.' : ''})
                  </dt>
                  <dd className="tabular">{money(tax)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-store-text/10 pt-2.5 text-base font-semibold">
                <dt>{t('total')}</dt>
                <dd className="tabular">{money(total)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs opacity-55">{t('estimate')}</p>
            {err && (
              <p className="mt-3 rounded-brand-sm bg-red-50 px-3.5 py-2.5 text-sm text-red-700" role="alert">
                {err}
              </p>
            )}
          </>
        )}
      </div>
      {cart.lines.length > 0 && (
        <div className="border-t border-store-text/[0.06] bg-store-bg/95 p-4 backdrop-blur">
          {needsAddress && <p className="mb-2 text-center text-xs opacity-70">{t('needAddress')}</p>}
          <button onClick={place} disabled={busy || needsTable || needsAddress || !s.guestOrdering} className="store-btn w-full">
            {busy ? '…' : `${t('checkout')} · ${money(total)}`}
          </button>
        </div>
      )}
    </Sheet>
  );
}
