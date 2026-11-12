import { useEffect, useState } from 'react';
import { Download, Plus, Printer, RefreshCw, Trash2, Copy, Pencil } from 'lucide-react';
import { api } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../store/auth';
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, Tabs, useFeedback } from '../../components/ui';
import { cn, formatMoney } from '../../lib/util';
import { QrCode as HeaderIcon } from 'lucide-react';

const STATUS_STYLE: Record<string, string> = {
  available: 'border-emerald-200 bg-emerald-50/50',
  occupied: 'border-brand/40 bg-brand/5',
  reserved: 'border-sky-200 bg-sky-50/50',
  cleaning: 'border-amber-200 bg-amber-50/60',
};

function QrImage({ id, version }: { id: string; version: number }) {
  const [src, setSrc] = useState<string>('');
  useEffect(() => {
    let url = '';
    api.blobUrl(`/api/staff/tables/${id}/qr`).then((u) => { url = u; setSrc(u); }).catch(() => setSrc(''));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [id, version]);
  return src ? <img src={src} alt="Table QR code" className="h-full w-full" /> : <div className="h-full w-full animate-pulse2 rounded bg-stone-100" />;
}

export default function TablesPage() {
  const fb = useFeedback();
  const { can, tenant } = useAuth();
  const manage = can('tables:manage');
  const { data, loading, error, reload } = useApi<{ items: any[] }>('/api/staff/tables');
  const [area, setArea] = useState('all');
  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const [form, setForm] = useState({ mode: 'single', label: '', count: 5, prefix: 'T', area: 'Main hall', capacity: 4 });
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) fb.ok(ok);
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const tables = data!.items;
  const areas = ['all', ...new Set(tables.map((t) => t.area))];
  const shown = tables.filter((t) => area === 'all' || t.area === area);

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="brand"
        title="Tables & QR codes"
        subtitle="Each table has a unique, regenerable QR code that opens your menu with the table pre-selected"
        actions={
          <>
            <Button variant="outline" loading={busy === 'print'} onClick={() => run('print', () => api.download('/api/staff/tables/qr/print', 'table-qr-codes.pdf'))} disabled={!tables.length}><Printer className="h-4 w-4" /> Print all (PDF)</Button>
            {manage && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add tables</Button>}
          </>
        }
      />
      {areas.length > 2 && <div className="mb-4"><Tabs value={area} onChange={setArea} items={areas.map((a) => ({ value: a, label: a === 'all' ? 'All areas' : a }))} /></div>}
      {!shown.length ? (
        <Card><Empty title="No tables yet" hint="Add tables to generate QR codes customers can scan to order." action={manage && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add tables</Button>} /></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {shown.map((t) => (
            <article key={t._id} className={cn('rounded-2xl border p-4 transition', STATUS_STYLE[t.status], !t.isActive && 'opacity-50')}>
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-display text-2xl font-semibold">{t.label}</p>
                  <p className="text-xs text-stone-500">{t.area} · {t.capacity} seats</p>
                </div>
                <Select className="h-8 w-auto py-0 text-xs capitalize" value={t.status} onChange={(e) => run(`s${t._id}`, () => api.patch(`/api/staff/tables/${t._id}`, { status: e.target.value }), 'Status updated')} aria-label="Table status">
                  {['available', 'occupied', 'reserved', 'cleaning'].map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </div>
              {t.openOrders > 0 && <p className="mt-2 text-xs"><Badge tone="brand">{t.openOrders} open order{t.openOrders > 1 ? 's' : ''}</Badge> <span className="ms-1 text-stone-600">due {formatMoney(t.amountDue, tenant?.settings?.currency, tenant?.settings?.currencyDecimals)}</span></p>}
              {t.openOrders > 0 && can('orders:transfer') && (
                <Select className="mt-2 h-8 w-full py-0 text-xs" value="" onChange={(e) => e.target.value && run(`m${t._id}`, () => api.post(`/api/staff/tables/${t._id}/merge`, { intoTableId: e.target.value }), 'Tables merged')} aria-label={`Merge table ${t.label} into another table`}>
                  <option value="">Merge into table…</option>
                  {(data?.items ?? []).filter((x: any) => x._id !== t._id && x.isActive).map((x: any) => <option key={x._id} value={x._id}>{x.label}</option>)}
                </Select>
              )}
              <div className="mx-auto my-4 aspect-square w-40 rounded-xl bg-white p-2 shadow-card"><QrImage id={t._id} version={t.qrVersion} /></div>
              <div className="flex flex-wrap justify-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => api.download(`/api/staff/tables/${t._id}/qr?download=1`, `table-${t.label}.png`).catch(fb.fail)}><Download className="h-3.5 w-3.5" /> PNG</Button>
                <Button size="sm" variant="ghost" onClick={() => api.download(`/api/staff/tables/${t._id}/qr?format=svg&download=1`, `table-${t.label}.svg`).catch(fb.fail)}><Download className="h-3.5 w-3.5" /> SVG</Button>
                <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(t.qrUrl); fb.ok('Link copied'); }}><Copy className="h-3.5 w-3.5" /> Link</Button>
                {manage && (
                  <>
                    <Button size="sm" variant="ghost" loading={busy === `r${t._id}`} onClick={async () => { if (await fb.confirm({ title: `Regenerate QR for ${t.label}?`, body: 'The old printed code stops working immediately. Print and replace it on the table.', confirmLabel: 'Regenerate' })) run(`r${t._id}`, () => api.post(`/api/staff/tables/${t._id}/regenerate`), 'New QR generated'); }}><RefreshCw className="h-3.5 w-3.5" /> New QR</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ ...t })} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" onClick={async () => { if (await fb.confirm({ title: `Delete table ${t.label}?`, danger: true, confirmLabel: 'Delete' })) run(`d${t._id}`, () => api.del(`/api/staff/tables/${t._id}`), 'Table deleted'); }} aria-label="Delete"><Trash2 className="h-3.5 w-3.5 text-red-500" /></Button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Add tables" footer={<><Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button><Button loading={busy === 'create'} onClick={() => run('create', async () => { await api.post('/api/staff/tables', form.mode === 'single' ? { label: form.label, area: form.area, capacity: Number(form.capacity) } : { count: Number(form.count), prefix: form.prefix, area: form.area, capacity: Number(form.capacity) }); setCreating(false); }, 'Tables created')} disabled={form.mode === 'single' && !form.label}>Create</Button></>}>
        <div className="space-y-4">
          <Tabs value={form.mode} onChange={(mode) => setForm({ ...form, mode })} items={[{ value: 'single', label: 'One table' }, { value: 'bulk', label: 'Several at once' }]} />
          {form.mode === 'single' ? <Field label="Label"><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="T1, Patio 3, Room 204…" /></Field> : (
            <div className="grid grid-cols-2 gap-3"><Field label="How many"><Input type="number" min={1} max={100} value={form.count} onChange={(e) => setForm({ ...form, count: Number(e.target.value) })} /></Field><Field label="Label prefix"><Input value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} /></Field></div>
          )}
          <div className="grid grid-cols-2 gap-3"><Field label="Area"><Input value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} /></Field><Field label="Seats"><Input type="number" min={1} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })} /></Field></div>
        </div>
      </Modal>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={`Edit ${edit?.label}`} footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy === 'edit'} onClick={() => run('edit', async () => { await api.patch(`/api/staff/tables/${edit._id}`, { label: edit.label, area: edit.area, capacity: Number(edit.capacity), isActive: edit.isActive }); setEdit(null); }, 'Saved')}>Save</Button></>}>
        {edit && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label"><Input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} /></Field>
            <Field label="Area"><Input value={edit.area} onChange={(e) => setEdit({ ...edit, area: e.target.value })} /></Field>
            <Field label="Seats"><Input type="number" min={1} value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} /></Field>
            <Field label="Active"><Select value={edit.isActive ? '1' : '0'} onChange={(e) => setEdit({ ...edit, isActive: e.target.value === '1' })}><option value="1">Active</option><option value="0">Disabled (QR stops working)</option></Select></Field>
          </div>
        )}
      </Modal>
    </>
  );
}
