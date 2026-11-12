import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, BarChart3, ChefHat, Eye, EyeOff, LockKeyhole, QrCode, ShieldCheck, Store, Users } from 'lucide-react';
import { useAuth } from '../../store/auth';
import { api, assetUrl } from '../../api/client';
import { applyTheme } from '../../lib/util';
import { Button, Field, Input } from '../../components/ui';
import TenantNotFound from '../store/TenantNotFound';

interface TenantBrand { name: string; logoUrl?: string }

const PLATFORM_POINTS = [
  { icon: Store, text: 'Provision restaurants at their own web address in minutes' },
  { icon: BarChart3, text: 'Monitor orders, revenue and subscriptions across the network' },
  { icon: ShieldCheck, text: 'Strict tenant isolation with a full audit trail' },
];
const TENANT_POINTS = [
  { icon: QrCode, text: 'Table QR ordering, live to your screens' },
  { icon: ChefHat, text: 'Kitchen display routed by station' },
  { icon: Users, text: 'Staff roles with precise permissions' },
];

export default function LoginPage({ tenantSlug }: { tenantSlug?: string }) {
  const { login, user, ready } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brand, setBrand] = useState<TenantBrand | null>(null);
  const [missing, setMissing] = useState(false);

  // On a restaurant page, show that restaurant's real name, logo and colours (public storefront data).
  // An unknown restaurant gets the not-found page; a suspended/lapsed one (503) still shows the sign-in form.
  useEffect(() => {
    if (!tenantSlug) return;
    api
      .get('/api/public/storefront')
      .then((s) => {
        setBrand({ name: s.name, logoUrl: s.branding?.logoUrl });
        applyTheme(s.branding?.theme);
      })
      .catch((e) => {
        setBrand(null);
        if (e?.status === 404) setMissing(true);
      });
  }, [tenantSlug]);

  if (missing) return <TenantNotFound slug={tenantSlug} />;

  if (ready && user) {
    const next = params.get('next');
    const fallback = user.role === 'superadmin' ? '/admin' : '/dashboard';
    return <Navigate to={next && next.startsWith(user.role === 'superadmin' ? '/admin' : '/dashboard') ? next : fallback} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password, tenantSlug);
    } catch (err: any) {
      setError(err?.message ?? 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const name = brand?.name ?? (tenantSlug ? tenantSlug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'TableSaaS');
  const points = tenantSlug ? TENANT_POINTS : PLATFORM_POINTS;

  return (
    <div className="grid min-h-screen bg-white lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden bg-ink-950 lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(60%_50%_at_20%_15%,rgb(var(--brand)/0.55),transparent_70%),radial-gradient(50%_45%_at_85%_90%,rgb(var(--accent)/0.28),transparent_70%)]" />
        <div className="absolute inset-0 opacity-[0.06] [background-image:radial-gradient(rgb(255_255_255)_1px,transparent_1px)] [background-size:22px_22px]" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white xl:p-16">
          <div className="flex items-center gap-3">
            {brand?.logoUrl ? (
              <img src={assetUrl(brand.logoUrl)} alt="" className="h-10 w-10 rounded-xl bg-white object-cover ring-1 ring-white/20" />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-accent font-display text-lg font-bold text-white shadow-lift">{name[0]}</div>
            )}
            <p className="font-display text-xl font-semibold tracking-tight">{name}</p>
          </div>
          <div className="max-w-lg animate-fade-up">
            <p className="eyebrow mb-4 text-white/60">{tenantSlug ? 'Restaurant workspace' : 'Platform console'}</p>
            <p className="font-display text-[44px] font-semibold leading-[1.05] tracking-tight">
              {tenantSlug ? 'Run service, not spreadsheets.' : 'Every restaurant on one platform.'}
            </p>
            <ul className="stagger mt-10 space-y-4">
              {points.map((p) => (
                <li key={p.text} className="flex items-center gap-3 text-[15px] text-white/80">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/[0.08] ring-1 ring-white/10">
                    <p.icon className="h-4 w-4" />
                  </span>
                  {p.text}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-white/40">© {new Date().getFullYear()} {tenantSlug ? name : 'TableSaaS'}</p>
        </div>
      </div>

      {/* Form */}
      <div className="flex items-center justify-center px-6 py-12 sm:px-10">
        <form onSubmit={submit} className="w-full max-w-[380px] animate-fade-up" noValidate>
          <div className="mb-9">
            <div className="mb-6 flex items-center gap-3 lg:hidden">
              {brand?.logoUrl ? (
                <img src={assetUrl(brand.logoUrl)} alt="" className="h-10 w-10 rounded-xl object-cover" />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand font-display text-lg font-bold text-brand-ink">{name[0]}</div>
              )}
              <p className="font-display text-lg font-semibold">{name}</p>
            </div>
            <div className="mb-5 inline-flex rounded-2xl bg-brand/10 p-3 text-brand">
              <LockKeyhole className="h-5 w-5" />
            </div>
            <h1 className="font-display text-[30px] font-semibold leading-tight tracking-tight">{tenantSlug ? 'Staff sign in' : 'Platform sign in'}</h1>
            <p className="mt-2 text-sm text-stone-500">{tenantSlug ? `Signing in to ${tenantSlug}` : 'Super administrators only'}</p>
          </div>
          <div className="space-y-5">
            <Field label="Email">
              <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className="h-11" placeholder="you@example.com" />
            </Field>
            <Field label="Password">
              <div className="relative">
                <Input type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-11 pe-11" />
                <button type="button" onClick={() => setShow((v) => !v)} className="focus-ring absolute end-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-stone-400 hover:text-stone-700" aria-label={show ? 'Hide password' : 'Show password'}>
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
            {error && (
              <p className="animate-fade-up rounded-xl border border-red-100 bg-red-50 px-3.5 py-2.5 text-sm text-red-700" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full justify-center" size="lg" loading={busy} disabled={!email || !password}>
              Sign in {!busy && <ArrowRight className="h-4 w-4 rtl:rotate-180" />}
            </Button>
          </div>
          <p className="mt-8 text-center text-xs leading-relaxed text-stone-400">
            {tenantSlug ? 'Forgot your password? Ask your restaurant owner or the platform administrator to reset it.' : 'Forgot your password? Reset it with the superadmin command described in the production guide.'}
          </p>
        </form>
      </div>
    </div>
  );
}
