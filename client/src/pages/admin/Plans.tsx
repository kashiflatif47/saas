import { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { Badge, Button, Card, ErrorState, Field, Input, Loading, Modal, PageHeader, Toggle, useFeedback } from '../../components/ui';
import { formatMoney, toMajor, toMinor } from '../../lib/util';
import { CreditCard as HeaderIcon } from 'lucide-react';

const FEATURES = ['qr_ordering', 'kds', 'inventory', 'reservations', 'online_payments', 'loyalty', 'analytics_export', 'multi_language'];
const blank = { name: '', code: '', price: '0', currency: 'PKR', trialDays: 14, features: ['qr_ordering', 'kds'] as string[], maxStaff: 10, maxProducts: 200, maxTables: 30, isActive: true };

export default function AdminPlans() {
  const fb = useFeedback();
  const { data, loading, error, reload } = useApi<any[]>('/api/platform/plans');
  const [edit, setEdit] = useState<(typeof blank & { _id?: string }) | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const body = { name: edit.name, code: edit.code, priceMonthly: toMinor(edit.price), currency: edit.currency, trialDays: Number(edit.trialDays), features: edit.features, limits: { maxStaff: Number(edit.maxStaff), maxProducts: Number(edit.maxProducts), maxTables: Number(edit.maxTables) }, isActive: edit.isActive };
      if (edit._id) await api.patch(`/api/platform/plans/${edit._id}`, body);
      else await api.post('/api/platform/plans', body);
      fb.ok('Plan saved');
      setEdit(null);
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return (
    <>
      <PageHeader icon={HeaderIcon} accent="violet" title="Subscription plans" subtitle="Pricing, trial length, limits and feature entitlements" actions={<Button onClick={() => setEdit({ ...blank })}><Plus className="h-4 w-4" /> New plan</Button>} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data!.map((p) => (
          <Card key={p._id} className={!p.isActive ? 'opacity-60' : ''}>
            <div className="flex items-start justify-between">
              <div>
                <p className="font-display text-xl font-semibold">{p.name}</p>
                <p className="text-xs text-stone-400">{p.code}</p>
              </div>
              {!p.isActive && <Badge>inactive</Badge>}
            </div>
            <p className="mt-4 font-display text-3xl font-semibold">{formatMoney(p.priceMonthly, p.currency)}<span className="text-sm font-normal text-stone-400"> /month</span></p>
            <p className="mt-1 text-sm text-stone-500">{p.trialDays}-day trial · {p.limits?.maxStaff} staff · {p.limits?.maxProducts} products · {p.limits?.maxTables} tables</p>
            <div className="mt-4 flex flex-wrap gap-1.5">{p.features.map((f: string) => <Badge key={f} tone="brand">{f.replace(/_/g, ' ')}</Badge>)}</div>
            <Button variant="outline" size="sm" className="mt-5" onClick={() => setEdit({ _id: p._id, name: p.name, code: p.code, price: toMajor(p.priceMonthly), currency: p.currency, trialDays: p.trialDays, features: p.features, maxStaff: p.limits?.maxStaff, maxProducts: p.limits?.maxProducts, maxTables: p.limits?.maxTables, isActive: p.isActive })}>Edit</Button>
          </Card>
        ))}
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?._id ? 'Edit plan' : 'New plan'} size="lg" footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save} loading={busy}>Save</Button></>}>
        {edit && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Code" hint="lowercase, unique"><Input value={edit.code} disabled={!!edit._id} onChange={(e) => setEdit({ ...edit, code: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></Field>
            <Field label="Monthly price"><Input type="number" step="0.01" min={0} value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></Field>
            <Field label="Currency"><Input maxLength={3} value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} /></Field>
            <Field label="Trial days"><Input type="number" min={0} max={90} value={edit.trialDays} onChange={(e) => setEdit({ ...edit, trialDays: Number(e.target.value) })} /></Field>
            <Field label="Max staff"><Input type="number" min={1} value={edit.maxStaff} onChange={(e) => setEdit({ ...edit, maxStaff: Number(e.target.value) })} /></Field>
            <Field label="Max products"><Input type="number" min={1} value={edit.maxProducts} onChange={(e) => setEdit({ ...edit, maxProducts: Number(e.target.value) })} /></Field>
            <Field label="Max tables"><Input type="number" min={1} value={edit.maxTables} onChange={(e) => setEdit({ ...edit, maxTables: Number(e.target.value) })} /></Field>
            <div className="sm:col-span-2">
              <span className="label">Features</span>
              <div className="grid gap-2 sm:grid-cols-2">
                {FEATURES.map((f) => (
                  <Toggle key={f} checked={edit.features.includes(f)} onChange={(v) => setEdit({ ...edit, features: v ? [...edit.features, f] : edit.features.filter((x) => x !== f) })} label={f.replace(/_/g, ' ')} />
                ))}
              </div>
            </div>
            <Toggle checked={edit.isActive} onChange={(v) => setEdit({ ...edit, isActive: v })} label="Available for new restaurants" />
          </div>
        )}
      </Modal>
    </>
  );
}
