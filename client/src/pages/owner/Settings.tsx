import { useEffect, useState } from 'react';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { api, session } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../store/auth';
import { toMajor, toMinor } from '../../lib/util';
import { Badge, Button, Card, ErrorState, Field, Input, Loading, PageHeader, Select, Tabs, Toggle, useFeedback } from '../../components/ui';
import { Settings as HeaderIcon } from 'lucide-react';

export default function SettingsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState(can('settings:manage') ? 'general' : 'payments');
  return (
    <>
      <PageHeader icon={HeaderIcon} accent="neutral" title="Settings" subtitle="Business details, ordering rules, taxes and payments" />
      <div className="mb-6">
        <Tabs value={tab} onChange={setTab} items={[...(can('settings:manage') ? [{ value: 'general', label: 'General' }, { value: 'ordering', label: 'Ordering & tax' }] : []), ...(can('payments:configure') ? [{ value: 'payments', label: 'Payments' }] : []), { value: 'account', label: 'My account' }]} />
      </div>
      {tab === 'general' && <General />}
      {tab === 'ordering' && <Ordering />}
      {tab === 'payments' && <Payments />}
      {tab === 'account' && <Account />}
    </>
  );
}

function useTenantForm() {
  const q = useApi<any>('/api/staff/tenant');
  const fb = useFeedback();
  const { refreshMe } = useAuth();
  const [busy, setBusy] = useState(false);
  const save = async (body: any) => {
    setBusy(true);
    try {
      await api.patch('/api/staff/tenant/settings', body);
      await refreshMe();
      fb.ok('Settings saved');
      q.reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return { ...q, save, busy };
}

function General() {
  const { data, loading, error, reload, save, busy } = useTenantForm();
  const [v, setV] = useState<any>(null);
  useEffect(() => {
    if (data) setV({ name: data.name, contact: { email: '', phone: '', address: '', city: '', country: '', ...data.contact } });
  }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!v) return null;
  const c = (k: string, val: string) => setV({ ...v, contact: { ...v.contact, [k]: val } });
  return (
    <Card title="Business profile" actions={<Button onClick={() => save(v)} loading={busy}>Save</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Business name" className="sm:col-span-2"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" value={v.contact.email ?? ''} onChange={(e) => c('email', e.target.value)} /></Field>
        <Field label="Phone"><Input value={v.contact.phone ?? ''} onChange={(e) => c('phone', e.target.value)} /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={v.contact.address ?? ''} onChange={(e) => c('address', e.target.value)} /></Field>
        <Field label="City"><Input value={v.contact.city ?? ''} onChange={(e) => c('city', e.target.value)} /></Field>
        <Field label="Country"><Input value={v.contact.country ?? ''} onChange={(e) => c('country', e.target.value)} /></Field>
      </div>
      <p className="mt-6 text-sm text-stone-500">Storefront address: <a className="font-medium text-brand" href={data.url} target="_blank" rel="noreferrer">{data.url}</a></p>
    </Card>
  );
}

function Ordering() {
  const { data, loading, error, reload, save, busy } = useTenantForm();
  const { hasFeature } = useAuth();
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    if (data) setS({ ...data.settings });
  }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!s) return null;
  const types = ['dine_in', 'takeaway', 'pickup', 'delivery'];
  const dec = s.currencyDecimals ?? 2;
  const langs = ['en', 'ur', 'ar'];
  const toggleIn = (key: string, val: string) => setS({ ...s, [key]: s[key].includes(val) ? s[key].filter((x: string) => x !== val) : [...s[key], val] });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Money & tax" actions={<Button onClick={() => save({ settings: s })} loading={busy}>Save</Button>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Currency (ISO)"><Input maxLength={3} value={s.currency} onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase() })} /></Field>
          <Field label="Decimals"><Select value={s.currencyDecimals} onChange={(e) => setS({ ...s, currencyDecimals: Number(e.target.value) })}>{[0, 2, 3].map((d) => <option key={d} value={d}>{d}</option>)}</Select></Field>
          <Field label="Tax rate %"><Input type="number" min={0} max={100} step="0.01" value={s.taxRatePercent} onChange={(e) => setS({ ...s, taxRatePercent: Number(e.target.value) })} /></Field>
          <Field label="Service charge %"><Input type="number" min={0} max={100} step="0.01" value={s.serviceChargePercent} onChange={(e) => setS({ ...s, serviceChargePercent: Number(e.target.value) })} /></Field>
          <div className="sm:col-span-2"><Toggle checked={s.taxInclusive} onChange={(taxInclusive) => setS({ ...s, taxInclusive })} label="Menu prices already include tax" /></div>
          <Field label="Timezone" className="sm:col-span-2"><Select value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })}>{(Intl as any).supportedValuesOf?.('timeZone')?.map((z: string) => <option key={z}>{z}</option>) ?? <option>{s.timezone}</option>}</Select></Field>
        </div>
        <p className="mt-4 text-xs text-stone-500">Changing currency decimals does not convert existing prices — set it before building your menu.</p>
      </Card>
      <Card title="Ordering rules" actions={<Button onClick={() => save({ settings: s })} loading={busy}>Save</Button>}>
        <div className="space-y-4">
          <Toggle checked={s.guestOrdering} onChange={(guestOrdering) => setS({ ...s, guestOrdering })} label="Customers can order from the website / QR" />
          <Toggle checked={s.autoAcceptOrders} onChange={(autoAcceptOrders) => setS({ ...s, autoAcceptOrders })} label="Auto-accept new orders (send straight to kitchen)" />
          <Toggle checked={s.requireTableForDineIn} onChange={(requireTableForDineIn) => setS({ ...s, requireTableForDineIn })} label="Dine-in orders must come from a table QR" />
          <div><span className="label">Order types</span><div className="flex flex-wrap gap-4">{types.map((t) => <Toggle key={t} checked={s.orderTypes.includes(t)} onChange={() => toggleIn('orderTypes', t)} label={t.replace('_', ' ')} />)}</div></div>
          <div><span className="label">Menu languages {!hasFeature('multi_language') && <Badge tone="warn">Upgrade for more than one</Badge>}</span><div className="flex flex-wrap gap-4">{langs.map((l) => <Toggle key={l} checked={s.languages.includes(l)} onChange={() => toggleIn('languages', l)} label={{ en: 'English', ur: 'Urdu', ar: 'Arabic' }[l]} />)}</div></div>
          <Field label="Default language"><Select value={s.defaultLanguage} onChange={(e) => setS({ ...s, defaultLanguage: e.target.value })}>{s.languages.map((l: string) => <option key={l} value={l}>{l}</option>)}</Select></Field>
          <Field label="Opening hours (shown on website)"><Input value={s.openingHours} onChange={(e) => setS({ ...s, openingHours: e.target.value })} placeholder="Mon–Sun 12:00 – 23:30" /></Field>
          {hasFeature('loyalty') && (
            <div className="rounded-xl border border-stone-200 p-3">
              <Toggle checked={s.loyaltyEnabled} onChange={(loyaltyEnabled) => setS({ ...s, loyaltyEnabled })} label="Loyalty points" />
              {s.loyaltyEnabled && <Field label="Points per 100 spent" className="mt-3 w-48"><Input type="number" min={0} value={s.loyaltyPointsPerUnit} onChange={(e) => setS({ ...s, loyaltyPointsPerUnit: Number(e.target.value) })} /></Field>}
            </div>
          )}
        </div>
      </Card>
      <Card title="POS & kitchen" actions={<Button onClick={() => save({ settings: s })} loading={busy}>Save</Button>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Delivery fee" hint="Added to delivery orders; taxed like the order"><Input type="number" min={0} step="0.01" value={toMajor(s.deliveryFee ?? 0, dec)} onChange={(e) => setS({ ...s, deliveryFee: toMinor(e.target.value, dec) })} /></Field>
          <Field label="Max manual discount (%)" hint="For admins, managers and anyone granted discounts. Owners are not capped."><Input type="number" min={0} max={100} value={s.maxManualDiscountPercent ?? 100} onChange={(e) => setS({ ...s, maxManualDiscountPercent: Number(e.target.value) })} /></Field>
          <Field label="Kitchen delay grace (minutes)" hint="A ticket is late when it takes longer than its dishes' prep time plus this"><Input type="number" min={0} max={240} value={s.kitchenDelayGraceMinutes ?? 5} onChange={(e) => setS({ ...s, kitchenDelayGraceMinutes: Number(e.target.value) })} /></Field>
          <Field label="Tax label on receipts" hint='e.g. "VAT"'><Input value={s.taxLabel ?? 'Tax'} maxLength={20} onChange={(e) => setS({ ...s, taxLabel: e.target.value })} /></Field>
          <Field label="Tax registration number" hint="Printed on receipts (e.g. VAT number)"><Input value={s.taxRegistrationNumber ?? ''} maxLength={40} onChange={(e) => setS({ ...s, taxRegistrationNumber: e.target.value })} /></Field>
          <Field label="Receipt footer"><Input value={s.receiptFooter ?? ''} maxLength={300} onChange={(e) => setS({ ...s, receiptFooter: e.target.value })} placeholder="Thank you for dining with us" /></Field>
          <div className="sm:col-span-2"><Toggle checked={!!s.requireOpenShiftForCash} onChange={(requireOpenShiftForCash) => setS({ ...s, requireOpenShiftForCash })} label="Cash can only be taken during an open cashier shift" /></div>
        </div>
      </Card>
    </div>
  );
}

function Payments() {
  const fb = useFeedback();
  const { data, loading, error, reload } = useApi<any>('/api/staff/tenant/payments');
  const [pk, setPk] = useState('');
  const [sk, setSk] = useState('');
  const [wh, setWh] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (data) setPk(data.providerPublicKey ?? '');
  }, [data]);
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      fb.ok(ok);
      setSk('');
      setWh('');
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Cash & card terminal">
        <Toggle checked={data.cashEnabled} onChange={(cashEnabled) => run('cash', () => api.patch('/api/staff/tenant/payments', { cashEnabled }), 'Saved')} label="Accept payment at the counter / to waiter" />
        <p className="mt-3 text-sm text-stone-500">Staff record cash or card-terminal payments against each order. Only money actually received should be recorded — partial payments and refunds are supported and audited.</p>
      </Card>
      <Card title="Online payments (Stripe)" actions={data.providerVerifiedAt ? <Badge tone="good"><CheckCircle2 className="h-3 w-3" /> Verified</Badge> : <Badge tone="warn">Not verified</Badge>}>
        {!data.onlinePaymentsInPlan ? (
          <p className="flex gap-2 text-sm text-stone-600"><ShieldAlert className="h-5 w-5 shrink-0 text-amber-500" /> Online payments are not included in your current plan. Ask the platform to upgrade you.</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-stone-500">Payments go directly to <strong>your own</strong> Stripe account. Customers see the “Pay online” option only after your keys are verified. Orders are marked paid only when Stripe's signed webhook confirms the charge.</p>
            <Field label="Publishable key"><Input value={pk} onChange={(e) => setPk(e.target.value.trim())} placeholder="pk_live_…" /></Field>
            <Field label="Secret key" hint={data.hasSecret ? 'A secret key is stored (encrypted). Enter a new one to replace it.' : 'Stored encrypted; never shown again.'}><Input type="password" value={sk} onChange={(e) => setSk(e.target.value.trim())} placeholder={data.hasSecret ? '••••••••••' : 'sk_live_… or rk_live_…'} autoComplete="off" /></Field>
            <Field label="Webhook signing secret" hint={<>In Stripe → Developers → Webhooks, add endpoint <code className="break-all rounded bg-stone-100 px-1">{data.webhookUrl}</code> with events <code>payment_intent.succeeded</code>, <code>payment_intent.payment_failed</code>, <code>refund.updated</code>.</>}><Input type="password" value={wh} onChange={(e) => setWh(e.target.value.trim())} placeholder={data.hasWebhookSecret ? '••••••••••' : 'whsec_…'} autoComplete="off" /></Field>
            <div className="flex flex-wrap gap-2">
              <Button loading={busy === 'save'} onClick={() => run('save', () => api.patch('/api/staff/tenant/payments', { provider: 'stripe', providerPublicKey: pk, ...(sk ? { providerSecret: sk } : {}), ...(wh ? { webhookSecret: wh } : {}) }), 'Credentials saved')}>Save credentials</Button>
              <Button variant="outline" loading={busy === 'verify'} disabled={!data.hasSecret} onClick={() => run('verify', () => api.post('/api/staff/tenant/payments/verify'), 'Stripe confirmed your credentials')}>Verify with Stripe</Button>
              {data.provider === 'stripe' && <Button variant="ghost" loading={busy === 'off'} onClick={() => run('off', () => api.patch('/api/staff/tenant/payments', { provider: 'none' }), 'Online payments disabled')}>Disable</Button>}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Account() {
  const fb = useFeedback();
  const { user } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const change = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/auth/change-password', { currentPassword: cur, newPassword: next });
      session.set(r.accessToken);
      setCur('');
      setNext('');
      fb.ok('Password changed — other sessions were signed out');
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="My account" className="max-w-lg">
      <p className="mb-4 text-sm text-stone-600">{user?.name} · {user?.email}</p>
      <div className="space-y-4">
        <Field label="Current password"><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint="At least 10 characters"><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
        <Button onClick={change} loading={busy} disabled={!cur || next.length < 10}>Change password</Button>
      </div>
    </Card>
  );
}
