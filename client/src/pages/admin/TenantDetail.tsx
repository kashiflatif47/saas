import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { api } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { Badge, Button, Card, ErrorState, Field, Input, Loading, PageHeader, Select, Stat, StatusBadge, useFeedback } from '../../components/ui';
import { formatMoney } from '../../lib/util';
import { TenantAccountsCard, TenantDetailsCard } from './TenantAccounts';

const FEATURES = ['qr_ordering', 'kds', 'inventory', 'reservations', 'online_payments', 'loyalty', 'analytics_export', 'multi_language'];

export default function AdminTenantDetail() {
  const { id } = useParams();
  const fb = useFeedback();
  const { data, loading, error, reload } = useApi<any>(`/api/platform/tenants/${id}`);
  const plans = useApi<any[]>('/api/platform/plans');
  const [planId, setPlanId] = useState('');
  const [months, setMonths] = useState(1);
  const [days, setDays] = useState(7);
  const [domain, setDomain] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const { tenant: t, usage, owner, url } = data;
  const sub = t.subscription ?? {};
  const overrides = sub.featureOverrides ?? { grant: [], revoke: [] };
  const planFeatures: string[] = sub.planId?.features ?? [];

  const act = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      fb.ok(msg);
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };

  const toggleStatus = async () => {
    const next = t.status === 'active' ? 'suspended' : 'active';
    const reason = await fb.confirm({ title: next === 'suspended' ? `Suspend ${t.name}?` : `Reactivate ${t.name}?`, body: next === 'suspended' ? 'Staff will be signed out and the storefront will go offline immediately.' : 'Staff can sign in again and the storefront comes back online.', danger: next === 'suspended', confirmLabel: next === 'suspended' ? 'Suspend' : 'Reactivate', input: next === 'suspended' ? { label: 'Reason', required: true } : undefined });
    if (!reason) return;
    act('status', () => api.post(`/api/platform/tenants/${id}/status`, { status: next, reason: typeof reason === 'string' ? reason : undefined }), next === 'suspended' ? 'Suspended' : 'Reactivated');
  };

  const resetPw = async () => {
    const pw = await fb.confirm({ title: 'Reset owner password', body: `Sets a new password for ${owner?.email} and signs them out everywhere.`, input: { label: 'New password (min 10 chars)', required: true }, confirmLabel: 'Reset' });
    if (typeof pw !== 'string') return;
    if (pw.length < 10) return fb.fail('Password must be at least 10 characters');
    act('pw', () => api.post(`/api/platform/tenants/${id}/owner-password`, { password: pw }), 'Password reset');
  };

  const featureState = (f: string) => (overrides.revoke?.includes(f) ? 'revoked' : overrides.grant?.includes(f) ? 'granted' : planFeatures.includes(f) ? 'plan' : 'off');
  const cycleFeature = (f: string) => {
    const s = featureState(f);
    const grant = new Set<string>(overrides.grant ?? []);
    const revoke = new Set<string>(overrides.revoke ?? []);
    grant.delete(f);
    revoke.delete(f);
    if (s === 'plan') revoke.add(f);
    else if (s === 'off') grant.add(f);
    act(`f-${f}`, () => api.post(`/api/platform/tenants/${id}/subscription`, { action: 'set_overrides', grant: [...grant], revoke: [...revoke] }), 'Entitlements updated');
  };

  return (
    <>
      <Link to="/admin/tenants" className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> Restaurants
      </Link>
      <PageHeader
        title={t.name}
        subtitle={
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all hover:text-brand">
            {url} <ExternalLink className="h-3 w-3" />
          </a>
        }
        actions={
          <>
            <StatusBadge status={t.status} />
            <Button variant={t.status === 'active' ? 'danger' : 'primary'} onClick={toggleStatus} loading={busy === 'status'}>
              {t.status === 'active' ? 'Suspend' : 'Reactivate'}
            </Button>
          </>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Orders (30d)" value={usage.orders30} />
        <Stat label="GMV (30d)" value={formatMoney(usage.gmv30, t.settings?.currency)} />
        <Stat label="Staff" value={`${usage.staff} / ${sub.planId?.limits?.maxStaff ?? '∞'}`} />
        <Stat label="Products" value={`${usage.products} / ${sub.planId?.limits?.maxProducts ?? '∞'}`} />
        <Stat label="Tables" value={`${usage.tables} / ${sub.planId?.limits?.maxTables ?? '∞'}`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Subscription">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <dt className="text-stone-500">Plan</dt><dd className="font-medium">{sub.planId?.name ?? '—'}</dd>
            <dt className="text-stone-500">Status</dt><dd><StatusBadge status={sub.status ?? 'none'} /></dd>
            <dt className="text-stone-500">Trial ends</dt><dd>{sub.trialEndsAt ? new Date(sub.trialEndsAt).toLocaleDateString() : '—'}</dd>
            <dt className="text-stone-500">Paid through</dt><dd>{sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : '—'}</dd>
          </dl>
          <div className="mt-5 space-y-4 border-t border-stone-100 pt-5">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Change plan" className="min-w-[180px] flex-1">
                <Select value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  <option value="">Keep current</option>
                  {plans.data?.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
                </Select>
              </Field>
              <Field label="Months" className="w-24"><Input type="number" min={1} max={36} value={months} onChange={(e) => setMonths(Number(e.target.value))} /></Field>
              <Button loading={busy === 'renew'} onClick={() => act('renew', () => api.post(`/api/platform/tenants/${id}/subscription`, { action: 'renew', months, planId: planId || undefined }), 'Subscription renewed')}>Renew</Button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Extend trial (days)" className="w-40"><Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
              <Button variant="outline" loading={busy === 'trial'} onClick={() => act('trial', () => api.post(`/api/platform/tenants/${id}/subscription`, { action: 'extend_trial', days }), 'Trial extended')}>Extend trial</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {['past_due', 'expired'].map((s) => (
                <Button key={s} variant="ghost" size="sm" loading={busy === s} onClick={() => act(s, () => api.post(`/api/platform/tenants/${id}/subscription`, { action: 'set_status', status: s }), `Marked ${s.replace('_', ' ')}`)}>
                  Mark {s.replace('_', ' ')}
                </Button>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Feature entitlements">
          <p className="mb-4 text-sm text-stone-500">Click to cycle: plan default → override. Overrides apply on top of the plan.</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {FEATURES.map((f) => {
              const s = featureState(f);
              return (
                <li key={f}>
                  <button onClick={() => cycleFeature(f)} disabled={busy === `f-${f}`} className="flex w-full items-center justify-between rounded-lg border border-stone-200 px-3 py-2 text-sm hover:bg-stone-50">
                    <span>{f.replace(/_/g, ' ')}</span>
                    <Badge tone={s === 'plan' ? 'good' : s === 'granted' ? 'brand' : s === 'revoked' ? 'bad' : 'neutral'}>{s === 'plan' ? 'in plan' : s}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Owner account">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <dt className="text-stone-500">Name</dt><dd>{owner?.name}</dd>
            <dt className="text-stone-500">Email</dt><dd className="break-all">{owner?.email}</dd>
            <dt className="text-stone-500">Last login</dt><dd>{owner?.lastLoginAt ? new Date(owner.lastLoginAt).toLocaleString() : 'Never'}</dd>
          </dl>
          <Button variant="outline" className="mt-4" onClick={resetPw} loading={busy === 'pw'}>Reset owner password</Button>
        </Card>

        <TenantDetailsCard key={t.updatedAt} tenant={t} onSaved={reload} />
        <TenantAccountsCard tenantId={t._id} />

        <Card title="Custom domain">
          <p className="mb-3 text-sm text-stone-500">Optional. Point the domain's DNS (CNAME) to the platform and issue a certificate first — see docs/DNS_SSL.md.</p>
          <div className="flex gap-2">
            <Input placeholder="menu.example.com" value={domain ?? t.customDomain ?? ''} onChange={(e) => setDomain(e.target.value.toLowerCase())} />
            <Button loading={busy === 'domain'} onClick={() => act('domain', () => api.patch(`/api/platform/tenants/${id}`, { customDomain: (domain ?? t.customDomain ?? '') || null }), 'Domain saved')}>Save</Button>
          </div>
        </Card>
      </div>
    </>
  );
}
