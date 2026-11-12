import { useEffect, useMemo, useState } from 'react';
import { ImagePlus, RotateCcw } from 'lucide-react';
import { api, assetUrl } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../store/auth';
import { Button, Card, ErrorState, Field, Input, Loading, PageHeader, Select, Tabs, Textarea, useFeedback } from '../../components/ui';
import { applyTheme, contrastRatio, inkFor } from '../../lib/util';
import { Palette as HeaderIcon } from 'lucide-react';

const DEFAULT_THEME = { primary: '#B4532A', secondary: '#1F2937', accent: '#E9B44C', background: '#FFFBF5', surface: '#FFFFFF', text: '#1C1917', fontHeading: 'Fraunces', fontBody: 'Inter', radius: 14 };
const PRESETS: { name: string; theme: Partial<typeof DEFAULT_THEME> }[] = [
  { name: 'Terracotta', theme: { primary: '#B4532A', secondary: '#2B2118', accent: '#E9B44C', background: '#FFF8EF', text: '#1C1917' } },
  { name: 'Emerald', theme: { primary: '#047857', secondary: '#0F172A', accent: '#FBBF24', background: '#F6FBF8', text: '#0F172A' } },
  { name: 'Midnight', theme: { primary: '#C9A227', secondary: '#0B0B0F', accent: '#E5E7EB', background: '#111114', surface: '#1B1B20', text: '#F5F5F4' } },
  { name: 'Berry', theme: { primary: '#BE185D', secondary: '#3F0D23', accent: '#F9A8D4', background: '#FFF7FA', text: '#1F1720' } },
  { name: 'Ocean', theme: { primary: '#0E7490', secondary: '#082F49', accent: '#F59E0B', background: '#F5FBFD', text: '#0C1A24' } },
];
const COLOR_FIELDS: [keyof typeof DEFAULT_THEME, string][] = [['primary', 'Primary (buttons, highlights)'], ['secondary', 'Secondary (header, footer)'], ['accent', 'Accent'], ['background', 'Page background'], ['surface', 'Cards'], ['text', 'Text']];

export default function Branding() {
  const fb = useFeedback();
  const { refreshMe } = useAuth();
  const { data, loading, error, reload } = useApi<any>('/api/staff/tenant');
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [texts, setTexts] = useState<any>({ heroTitle: {}, heroSubtitle: {}, about: {}, socials: {} });
  const [lang, setLang] = useState<'en' | 'ur' | 'ar'>('en');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setTheme({ ...DEFAULT_THEME, ...(data.branding?.theme ?? {}) });
    setTexts({ heroTitle: data.branding?.heroTitle ?? {}, heroSubtitle: data.branding?.heroSubtitle ?? {}, about: data.branding?.about ?? {}, socials: data.branding?.socials ?? {} });
  }, [data]);

  // Live preview: theme vars are scoped to the preview element only.
  const previewStyle = useMemo(() => {
    const el = document.createElement('div');
    applyTheme(theme, el);
    return Object.fromEntries(Array.from(el.style).map((k) => [k, el.style.getPropertyValue(k)])) as React.CSSProperties;
  }, [theme]);

  const contrast = contrastRatio(theme.text, theme.background);

  const save = async () => {
    setBusy('save');
    try {
      const socials = Object.fromEntries(Object.entries(texts.socials ?? {}).filter(([, v]) => v !== undefined));
      await api.patch('/api/staff/tenant/branding', { theme, heroTitle: texts.heroTitle, heroSubtitle: texts.heroSubtitle, about: texts.about, socials });
      await refreshMe();
      applyTheme(theme);
      fb.ok('Branding published to your storefront');
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };

  const upload = async (slot: string, file?: File) => {
    if (!file) return;
    setBusy(slot);
    try {
      await api.upload(`/api/staff/tenant/branding/${slot}`, file);
      await refreshMe();
      reload();
      fb.ok('Image updated');
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const b = data.branding ?? {};

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="brand" title="Branding & website" subtitle="Your logo, colours and homepage text — preview updates live" actions={<Button onClick={save} loading={busy === 'save'}>Publish changes</Button>} />
      <div className="grid gap-6 xl:grid-cols-[1fr_440px] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card title="Images">
            <div className="grid gap-4 sm:grid-cols-4">
              {[['logo', 'Logo', b.logoUrl], ['favicon', 'Favicon', b.faviconUrl], ['hero', 'Hero image', b.heroUrl], ['cover', 'Cover / about', b.coverUrl]].map(([slot, label, url]) => (
                <label key={slot} className="group cursor-pointer">
                  <span className="label">{label}</span>
                  <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-stone-300 bg-stone-50 transition group-hover:border-brand">
                    {url ? <img src={assetUrl(url)} alt="" className="h-full w-full object-cover" /> : <ImagePlus className="h-6 w-6 text-stone-400" />}
                    {busy === slot && <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-xs">Uploading…</div>}
                  </div>
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/x-icon" className="hidden" onChange={(e) => upload(slot!, e.target.files?.[0])} />
                </label>
              ))}
            </div>
            <p className="mt-3 text-xs text-stone-500">PNG, JPG or WEBP up to 5 MB. Square logo (512×512) and wide hero (1600×900) look best.</p>
          </Card>

          <Card title="Colour theme" actions={<Button size="sm" variant="ghost" onClick={() => setTheme(DEFAULT_THEME)}><RotateCcw className="h-3.5 w-3.5" /> Reset</Button>}>
            <div className="mb-5 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button key={p.name} onClick={() => setTheme({ ...theme, surface: '#FFFFFF', ...p.theme })} className="flex items-center gap-2 rounded-full border border-stone-200 py-1 pe-3 ps-1 text-xs hover:border-stone-400">
                  <span className="flex">{[p.theme.primary, p.theme.accent, p.theme.background].map((c, i) => <span key={i} className="-ms-1 h-5 w-5 rounded-full border-2 border-white first:ms-0" style={{ background: c }} />)}</span>
                  {p.name}
                </button>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {COLOR_FIELDS.map(([k, label]) => (
                <Field key={k} label={label}>
                  <div className="flex gap-2">
                    <input type="color" value={String(theme[k])} onChange={(e) => setTheme({ ...theme, [k]: e.target.value.toUpperCase() })} className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-stone-300 p-1" aria-label={`${label} picker`} />
                    <Input value={String(theme[k])} onChange={(e) => { const v = e.target.value.trim(); setTheme({ ...theme, [k]: v.startsWith('#') ? v : `#${v}` }); }} maxLength={7} pattern="^#[0-9A-Fa-f]{6}$" className="font-mono uppercase" aria-label={`${label} hex`} />
                  </div>
                </Field>
              ))}
              <Field label="Heading font"><Select value={theme.fontHeading} onChange={(e) => setTheme({ ...theme, fontHeading: e.target.value })}>{['Fraunces', 'Playfair Display', 'DM Serif Display', 'Cormorant Garamond', 'Poppins', 'Inter'].map((f) => <option key={f}>{f}</option>)}</Select></Field>
              <Field label="Body font"><Select value={theme.fontBody} onChange={(e) => setTheme({ ...theme, fontBody: e.target.value })}>{['Inter', 'Poppins', 'DM Sans', 'Nunito', 'Lato'].map((f) => <option key={f}>{f}</option>)}</Select></Field>
              <Field label={`Corner radius · ${theme.radius}px`}><input type="range" min={0} max={32} value={theme.radius} onChange={(e) => setTheme({ ...theme, radius: Number(e.target.value) })} className="w-full accent-[rgb(var(--brand))]" /></Field>
            </div>
            {contrast < 4.5 && <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Text/background contrast is {contrast.toFixed(1)}:1 — below the 4.5:1 accessibility guideline. Consider a darker text or lighter background.</p>}
          </Card>

          <Card title="Homepage text" actions={<Tabs value={lang} onChange={setLang} items={[{ value: 'en', label: 'EN' }, { value: 'ur', label: 'اردو' }, { value: 'ar', label: 'عربي' }]} />}>
            <div className="space-y-4" dir={lang === 'en' ? 'ltr' : 'rtl'}>
              <Field label="Headline"><Input value={texts.heroTitle[lang] ?? ''} onChange={(e) => setTexts({ ...texts, heroTitle: { ...texts.heroTitle, [lang]: e.target.value } })} /></Field>
              <Field label="Sub-headline"><Input value={texts.heroSubtitle[lang] ?? ''} onChange={(e) => setTexts({ ...texts, heroSubtitle: { ...texts.heroSubtitle, [lang]: e.target.value } })} /></Field>
              <Field label="About"><Textarea rows={4} value={texts.about[lang] ?? ''} onChange={(e) => setTexts({ ...texts, about: { ...texts.about, [lang]: e.target.value } })} /></Field>
            </div>
            <div className="mt-6 grid gap-4 border-t border-stone-100 pt-5 sm:grid-cols-2">
              {['instagram', 'facebook', 'tiktok'].map((s) => <Field key={s} label={s}><Input type="url" placeholder="https://" value={texts.socials[s] ?? ''} onChange={(e) => setTexts({ ...texts, socials: { ...texts.socials, [s]: e.target.value } })} /></Field>)}
              <Field label="WhatsApp number"><Input value={texts.socials.whatsapp ?? ''} onChange={(e) => setTexts({ ...texts, socials: { ...texts.socials, whatsapp: e.target.value } })} placeholder="+92…" /></Field>
            </div>
          </Card>
        </div>

        <div className="xl:sticky xl:top-24 xl:self-start">
          <p className="label">Live preview</p>
          <div style={previewStyle} className="overflow-hidden rounded-[22px] border-[6px] border-stone-900 shadow-lift">
            <div className="bg-store-bg font-sans text-store-text">
              <div className="flex items-center gap-2 bg-store-secondary px-4 py-3" style={{ color: `rgb(${inkFor(theme.secondary)})` }}>
                {b.logoUrl ? <img src={assetUrl(b.logoUrl)} alt="" className="h-7 w-7 rounded-md object-cover" /> : <div className="h-7 w-7 rounded-md bg-brand" />}
                <span className="font-display font-semibold">{data.name}</span>
              </div>
              <div className="relative h-40 bg-cover bg-center" style={{ backgroundImage: b.heroUrl ? `url(${assetUrl(b.heroUrl)})` : undefined, backgroundColor: theme.secondary }}>
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-black/10" />
                <div className="absolute bottom-3 start-4 end-4 text-white" dir={lang === 'en' ? 'ltr' : 'rtl'}>
                  <p className="font-display text-xl font-semibold leading-tight">{texts.heroTitle[lang] || texts.heroTitle.en || data.name}</p>
                  <p className="text-xs opacity-90">{texts.heroSubtitle[lang] || texts.heroSubtitle.en}</p>
                </div>
              </div>
              <div className="space-y-3 p-4">
                <div className="flex gap-2">{['All', 'Starters', 'Mains'].map((c, i) => <span key={c} className={i === 0 ? 'rounded-full bg-brand px-3 py-1 text-xs text-brand-ink' : 'rounded-full bg-store-surface px-3 py-1 text-xs shadow-card'}>{c}</span>)}</div>
                {[1, 2].map((i) => (
                  <div key={i} className="flex gap-3 rounded-brand bg-store-surface p-3 shadow-card">
                    <div className="h-14 w-14 shrink-0 rounded-[calc(var(--radius)*0.7)] bg-accent/40" />
                    <div className="flex-1"><p className="font-display text-sm font-semibold">Signature dish {i}</p><p className="text-[11px] opacity-70">Slow cooked, house spices</p></div>
                    <span className="self-end rounded-full bg-brand px-3 py-1 text-xs font-semibold text-brand-ink">Add</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
