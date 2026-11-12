import { useState } from 'react';
import { api } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { Badge, Button, Card, ErrorState, Field, Input, Loading, Select, useFeedback } from '../../components/ui';

const BUSINESS_TYPES = ['restaurant', 'cafe', 'hotel', 'bakery', 'food_truck', 'other'];

/** Editable restaurant profile for platform administrators (name, type, contact, regional settings). */
export function TenantDetailsCard({ tenant, onSaved }: { tenant: any; onSaved: () => void }) {
  const fb = useFeedback();
  const init = () => ({
    name: tenant.name ?? '',
    businessType: tenant.businessType ?? 'restaurant',
    email: tenant.contact?.email ?? '',
    phone: tenant.contact?.phone ?? '',
    address: tenant.contact?.address ?? '',
    city: tenant.contact?.city ?? '',
    country: tenant.contact?.country ?? '',
    currency: tenant.settings?.currency ?? 'PKR',
    timezone: tenant.settings?.timezone ?? 'Asia/Karachi',
    defaultLanguage: tenant.settings?.defaultLanguage ?? 'en',
  });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof ReturnType<typeof init>, v: string) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      // Empty optional contact fields are omitted so validation (e.g. email format) only checks real values.
      const contact = Object.fromEntries(
        Object.entries({ email: f.email, phone: f.phone, address: f.address, city: f.city, country: f.country }).filter(([, v]) => v.trim() !== ''),
      );
      await api.patch(`/api/platform/tenants/${tenant._id}`, {
        name: f.name.trim(),
        businessType: f.businessType,
        contact,
        settings: { currency: f.currency.trim(), timezone: f.timezone.trim(), defaultLanguage: f.defaultLanguage },
      });
      fb.ok('Restaurant details saved');
      onSaved();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Restaurant details" className="lg:col-span-2">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Business name *"><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Business type">
          <Select value={f.businessType} onChange={(e) => set('businessType', e.target.value)}>
            {BUSINESS_TYPES.map((b) => <option key={b} value={b}>{b.replace('_', ' ')}</option>)}
          </Select>
        </Field>
        <Field label="Restaurant URL name" hint="Fixed after provisioning (it is encoded in printed QR codes)"><Input value={tenant.slug} disabled /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Address"><Input value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
        <Field label="City"><Input value={f.city} onChange={(e) => set('city', e.target.value)} /></Field>
        <Field label="Country"><Input value={f.country} onChange={(e) => set('country', e.target.value)} /></Field>
        <Field label="Currency" hint="ISO code, e.g. PKR, USD, AED"><Input maxLength={3} value={f.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} /></Field>
        <Field label="Time zone" hint="IANA name, e.g. Asia/Karachi"><Input value={f.timezone} onChange={(e) => set('timezone', e.target.value)} /></Field>
        <Field label="Default language">
          <Select value={f.defaultLanguage} onChange={(e) => set('defaultLanguage', e.target.value)}>
            <option value="en">English</option>
            <option value="ur">Urdu</option>
            <option value="ar">Arabic</option>
          </Select>
        </Field>
      </div>
      <div className="mt-5 flex gap-2">
        <Button onClick={save} loading={busy} disabled={f.name.trim().length < 2 || f.currency.length !== 3}>Save details</Button>
        <Button variant="ghost" onClick={() => setF(init())} disabled={busy}>Reset</Button>
      </div>
    </Card>
  );
}

/** Lists a tenant's accounts; the platform admin can activate/deactivate, unlock or reset passwords. */
export function TenantAccountsCard({ tenantId }: { tenantId: string }) {
  const fb = useFeedback();
  const { data, loading, error, reload } = useApi<{ items: any[] }>(`/api/platform/tenants/${tenantId}/users`);
  const [busy, setBusy] = useState<string | null>(null);

  const patch = async (u: any, body: Record<string, unknown>, msg: string) => {
    setBusy(u._id);
    try {
      await api.patch(`/api/platform/tenants/${tenantId}/users/${u._id}`, body);
      fb.ok(msg);
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };
  const resetPw = async (u: any) => {
    const pw = await fb.confirm({
      title: `Reset password for ${u.name}`,
      body: `Sets a new password for ${u.email} and signs them out everywhere. Share it securely.`,
      input: { label: 'New password (min 10 chars)', required: true },
      confirmLabel: 'Reset password',
    });
    if (typeof pw !== 'string') return;
    if (pw.length < 10) return fb.fail('Password must be at least 10 characters');
    patch(u, { password: pw }, 'Password reset');
  };
  const toggle = async (u: any) => {
    if (u.isActive && !(await fb.confirm({ title: `Deactivate ${u.name}?`, body: 'They are signed out immediately and cannot sign in until reactivated.', danger: true, confirmLabel: 'Deactivate' }))) return;
    patch(u, { isActive: !u.isActive }, u.isActive ? 'Account deactivated' : 'Account reactivated');
  };

  return (
    <Card title="Accounts" pad={false} className="lg:col-span-2">
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-stone-100 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-4 py-3 text-start font-medium">Name</th>
                <th className="px-4 py-3 text-start font-medium">Role</th>
                <th className="px-4 py-3 text-start font-medium">Status</th>
                <th className="px-4 py-3 text-start font-medium">Last sign-in</th>
                <th className="px-4 py-3 text-end font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data!.items.map((u) => {
                const locked = !!u.lockedUntil && new Date(u.lockedUntil) > new Date();
                return (
                  <tr key={u._id}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-stone-900">{u.name}</p>
                      <p className="break-all text-xs text-stone-400">{u.email}</p>
                    </td>
                    <td className="px-4 py-3 capitalize">{u.role.replace('_', ' ')}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={u.isActive ? 'good' : 'bad'}>{u.isActive ? 'active' : 'inactive'}</Badge>
                        {locked && <Badge tone="warn">locked</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-stone-500">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-1">
                        {locked && (
                          <Button size="sm" variant="ghost" loading={busy === u._id} onClick={() => patch(u, { unlock: true }, 'Account unlocked')}>Unlock</Button>
                        )}
                        <Button size="sm" variant="outline" disabled={busy === u._id} onClick={() => resetPw(u)}>Reset password</Button>
                        {u.role !== 'owner' && (
                          <Button size="sm" variant={u.isActive ? 'ghost' : 'primary'} disabled={busy === u._id} onClick={() => toggle(u)}>
                            {u.isActive ? 'Deactivate' : 'Reactivate'}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data!.items.length === 0 && <p className="px-4 py-8 text-center text-sm text-stone-400">No accounts</p>}
        </div>
      )}
    </Card>
  );
}
