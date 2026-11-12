import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { api, qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { Button, Card, DataTable, ErrorState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, useFeedback } from '../../components/ui';
import { slugify } from './slug';
import { tenantAddressPreview } from '../../lib/util';
import { Building2 as HeaderIcon } from 'lucide-react';

export default function AdminTenants() {
  const nav = useNavigate();
  const fb = useFeedback();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [status, setStatus] = useState('');
  const [sub, setSub] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => { setDq(q); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const { data, loading, error, reload } = useApi<any>(`/api/platform/tenants${qs({ page, q: dq, status, subscription: sub })}`);
  const plans = useApi<any[]>('/api/platform/plans');

  const [form, setForm] = useState({ name: '', slug: '', businessType: 'restaurant', planId: '', currency: 'PKR', ownerName: '', ownerEmail: '', ownerPassword: '', email: '', phone: '', city: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((p) => ({ ...p, [k]: v, ...(k === 'name' && !slugTouched ? { slug: slugify(v) } : {}) }));

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/platform/tenants', {
        name: form.name, slug: form.slug, businessType: form.businessType, planId: form.planId, currency: form.currency,
        contact: { email: form.email || undefined, phone: form.phone || undefined, city: form.city || undefined },
        owner: { name: form.ownerName, email: form.ownerEmail, password: form.ownerPassword },
      });
      fb.ok(`Provisioned at ${r.url}`);
      setCreating(false);
      nav(`/admin/tenants/${r.tenant._id}`);
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="brand"
        title="Restaurants"
        subtitle="Every tenant on the platform"
        actions={
          <Button onClick={() => { setCreating(true); setSlugTouched(false); setForm((p) => ({ ...p, planId: plans.data?.find((x) => x.isActive)?._id ?? '' })); }}>
            <Plus className="h-4 w-4" /> New restaurant
          </Button>
        }
      />
      <Card pad={false}>
        <div className="flex flex-wrap gap-3 border-b border-stone-100 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <Input className="ps-9" placeholder="Search name or URL" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select className="w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </Select>
          <Select className="w-auto" value={sub} onChange={(e) => { setSub(e.target.value); setPage(1); }} aria-label="Subscription">
            <option value="">All subscriptions</option>
            {['trial', 'active', 'past_due', 'expired', 'suspended'].map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </Select>
        </div>
        {loading && !data ? (
          <Loading />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : (
          <>
            <DataTable
              rows={data.items}
              onRowClick={(r: any) => nav(`/admin/tenants/${r._id}`)}
              columns={[
                { key: 'name', header: 'Restaurant', render: (r: any) => <div><p className="font-medium text-stone-900">{r.name}</p><p className="text-xs text-stone-400">{r.url ?? r.slug} · {r.businessType}</p></div> },
                { key: 'plan', header: 'Plan', render: (r: any) => r.subscription?.planId?.name ?? '—' },
                { key: 'sub', header: 'Subscription', render: (r: any) => <StatusBadge status={r.subscription?.status ?? 'none'} /> },
                { key: 'status', header: 'Account', render: (r: any) => <StatusBadge status={r.status} /> },
                { key: 'created', header: 'Created', render: (r: any) => new Date(r.createdAt).toLocaleDateString() },
              ]}
            />
            <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Provision a restaurant"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={create} loading={busy} disabled={!form.name || !form.slug || !form.planId || !form.ownerEmail || form.ownerPassword.length < 10}>
              Create restaurant
            </Button>
          </>
        }
      >
        {plans.data && plans.data.filter((p) => p.isActive).length === 0 && (
          <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
            There is no active subscription plan yet. Create one under <Link className="font-medium underline" to="/admin/plans">Plans</Link> first.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name *"><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Restaurant URL *" hint={form.slug ? tenantAddressPreview(form.slug) : 'Lowercase letters, numbers, hyphens'}>
            <Input value={form.slug} onChange={(e) => { setSlugTouched(true); set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); }} />
          </Field>
          <Field label="Business type">
            <Select value={form.businessType} onChange={(e) => set('businessType', e.target.value)}>
              {['restaurant', 'cafe', 'hotel', 'bakery', 'food_truck', 'other'].map((b) => <option key={b} value={b}>{b.replace('_', ' ')}</option>)}
            </Select>
          </Field>
          <Field label="Plan *">
            <Select value={form.planId} onChange={(e) => set('planId', e.target.value)}>
              <option value="">Choose a plan</option>
              {plans.data?.filter((p) => p.isActive).map((p) => <option key={p._id} value={p._id}>{p.name} · {p.trialDays}-day trial</option>)}
            </Select>
          </Field>
          <Field label="Currency"><Input value={form.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} /></Field>
          <Field label="City"><Input value={form.city} onChange={(e) => set('city', e.target.value)} /></Field>
          <Field label="Business email"><Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="Business phone"><Input value={form.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
          <div className="sm:col-span-2 mt-2 border-t border-stone-100 pt-4"><p className="text-sm font-semibold">Owner account</p></div>
          <Field label="Owner name *"><Input value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} /></Field>
          <Field label="Owner email *"><Input type="email" value={form.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)} /></Field>
          <Field label="Temporary password *" hint="At least 10 characters. Share it securely; the owner should change it." className="sm:col-span-2">
            <Input type="text" value={form.ownerPassword} onChange={(e) => set('ownerPassword', e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
      </Modal>
    </>
  );
}
