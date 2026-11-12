import { useState } from 'react';
import { AlertTriangle, PackagePlus, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { api, qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../store/auth';
import { Badge, Button, Card, DataTable, Empty, ErrorState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Tabs, Toggle, useFeedback } from '../../components/ui';
import { ResourcePage } from '../../components/ResourcePage';
import { formatMoney, toMajor, toMinor } from '../../lib/util';
import { Boxes as HeaderIcon } from 'lucide-react';

const UNITS = ['g', 'kg', 'ml', 'l', 'pcs', 'pack', 'box'];

export default function Inventory() {
  const [tab, setTab] = useState('items');
  return (
    <>
      <div className="mb-2"><Tabs value={tab} onChange={setTab} items={[{ value: 'items', label: 'Stock' }, { value: 'movements', label: 'Movement history' }, { value: 'po', label: 'Purchase orders' }, { value: 'suppliers', label: 'Suppliers' }]} /></div>
      <div className="mt-4">
        {tab === 'items' && <Items />}
        {tab === 'movements' && <Movements />}
        {tab === 'po' && <PurchaseOrders />}
        {tab === 'suppliers' && <Suppliers />}
      </div>
    </>
  );
}

function Items() {
  const fb = useFeedback();
  const { can, tenant } = useAuth();
  const manage = can('inventory:manage');
  const dec = tenant?.settings?.currencyDecimals ?? 2;
  const [low, setLow] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useApi<any>(`/api/staff/inventory/items${qs({ page, q, lowStock: low ? 'true' : undefined })}`);
  const suppliers = useApi<any>('/api/staff/inventory/suppliers?limit=200');
  const [edit, setEdit] = useState<any | null>(null);
  const [adjust, setAdjust] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const body: any = { name: edit.name, sku: edit.sku || undefined, unit: edit.unit, lowStockThreshold: Number(edit.lowStockThreshold) || 0, costPerUnit: toMinor(edit.cost || 0, dec), supplierId: edit.supplierId || null };
      if (edit._id) await api.patch(`/api/staff/inventory/items/${edit._id}`, body);
      else await api.post('/api/staff/inventory/items', { ...body, openingQuantity: Number(edit.opening) || 0 });
      fb.ok('Saved');
      setEdit(null);
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const doAdjust = async () => {
    setBusy(true);
    try {
      const qty = Number(adjust.quantity);
      await api.post(`/api/staff/inventory/items/${adjust.item._id}/adjust`, { type: adjust.type, quantity: adjust.type === 'adjustment' && adjust.direction === 'out' ? -qty : qty, reason: adjust.reason });
      fb.ok('Stock updated');
      setAdjust(null);
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="emerald" title="Inventory" subtitle="Ingredient stock, low-stock alerts and adjustments" actions={manage && <Button onClick={() => setEdit({ name: '', unit: 'kg', lowStockThreshold: '', cost: '', opening: '', supplierId: '' })}><Plus className="h-4 w-4" /> Item</Button>} />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-stone-100 p-4">
          <Input className="max-w-xs" placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <Toggle checked={low} onChange={(v) => { setLow(v); setPage(1); }} label="Low stock only" />
        </div>
        {loading && !data ? <Loading /> : error ? <ErrorState message={error} onRetry={reload} /> : (
          <>
            <DataTable
              rows={data.items}
              empty={<Empty title={low ? 'Nothing is low on stock' : 'No inventory items'} hint="Track ingredients, link them to dish recipes and stock is deducted automatically." />}
              columns={[
                { key: 'n', header: 'Item', render: (i: any) => <div><p className="font-medium">{i.name}</p>{i.sku && <p className="text-xs text-stone-400">{i.sku}</p>}</div> },
                { key: 'q', header: 'On hand', render: (i: any) => { const isLow = i.lowStockThreshold > 0 && i.quantity <= i.lowStockThreshold; return <span className={isLow ? 'font-semibold text-red-600' : ''}>{isLow && <AlertTriangle className="me-1 inline h-3.5 w-3.5" />}{+i.quantity.toFixed(3)} {i.unit}</span>; } },
                { key: 't', header: 'Alert at', render: (i: any) => (i.lowStockThreshold ? `${i.lowStockThreshold} ${i.unit}` : '—') },
                { key: 'c', header: 'Cost / unit', render: (i: any) => formatMoney(i.costPerUnit, tenant?.settings?.currency, dec) },
                { key: 'v', header: 'Stock value', render: (i: any) => formatMoney(Math.round(i.costPerUnit * Math.max(0, i.quantity)), tenant?.settings?.currency, dec) },
                { key: 's', header: 'Supplier', render: (i: any) => i.supplierId?.name ?? '—' },
                ...(manage ? [{ key: 'a', header: '', className: 'text-end whitespace-nowrap', render: (i: any) => (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setAdjust({ item: i, type: 'adjustment', direction: 'in', quantity: '', reason: '' })}><SlidersHorizontal className="h-4 w-4" /> Adjust</Button>
                    <Button size="sm" variant="ghost" onClick={() => setAdjust({ item: i, type: 'wastage', quantity: '', reason: '' })}><Trash2 className="h-4 w-4" /> Waste</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ ...i, cost: toMajor(i.costPerUnit, dec), supplierId: i.supplierId?._id ?? '' })}>Edit</Button>
                  </div>) }] : []),
              ]}
            />
            <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?._id ? 'Edit item' : 'New inventory item'} footer={<>
        {edit?._id && <Button variant="ghost" className="me-auto text-red-600" onClick={async () => { if (await fb.confirm({ title: 'Remove this item?', body: 'History is kept; it disappears from stock lists and recipes stop deducting it.', danger: true })) { await api.del(`/api/staff/inventory/items/${edit._id}`).catch(fb.fail); setEdit(null); reload(); } }}>Remove</Button>}
        <Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save} loading={busy} disabled={!edit?.name}>Save</Button></>}>
        {edit && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="SKU"><Input value={edit.sku ?? ''} onChange={(e) => setEdit({ ...edit, sku: e.target.value })} /></Field>
            <Field label="Unit"><Select value={edit.unit} onChange={(e) => setEdit({ ...edit, unit: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</Select></Field>
            <Field label="Low-stock alert at"><Input type="number" min={0} step="any" value={edit.lowStockThreshold} onChange={(e) => setEdit({ ...edit, lowStockThreshold: e.target.value })} /></Field>
            <Field label="Cost per unit"><Input type="number" min={0} step="0.01" value={edit.cost} onChange={(e) => setEdit({ ...edit, cost: e.target.value })} /></Field>
            <Field label="Supplier"><Select value={edit.supplierId} onChange={(e) => setEdit({ ...edit, supplierId: e.target.value })}><option value="">—</option>{suppliers.data?.items?.filter((s: any) => s.isActive).map((s: any) => <option key={s._id} value={s._id}>{s.name}</option>)}</Select></Field>
            {!edit._id && <Field label="Opening quantity"><Input type="number" min={0} step="any" value={edit.opening} onChange={(e) => setEdit({ ...edit, opening: e.target.value })} /></Field>}
          </div>
        )}
      </Modal>

      <Modal open={!!adjust} onClose={() => setAdjust(null)} title={adjust?.type === 'wastage' ? `Record wastage · ${adjust?.item.name}` : `Adjust stock · ${adjust?.item.name}`} size="sm" footer={<><Button variant="outline" onClick={() => setAdjust(null)}>Cancel</Button><Button onClick={doAdjust} loading={busy} disabled={!Number(adjust?.quantity) || (adjust?.reason ?? '').length < 2}>Save</Button></>}>
        {adjust && (
          <div className="space-y-4">
            <p className="text-sm text-stone-500">Currently {+adjust.item.quantity.toFixed(3)} {adjust.item.unit}</p>
            {adjust.type === 'adjustment' && <Tabs value={adjust.direction} onChange={(direction) => setAdjust({ ...adjust, direction })} items={[{ value: 'in', label: 'Add stock' }, { value: 'out', label: 'Remove stock' }]} />}
            <Field label={`Quantity (${adjust.item.unit})`}><Input type="number" min={0} step="any" value={adjust.quantity} onChange={(e) => setAdjust({ ...adjust, quantity: e.target.value })} /></Field>
            <Field label="Reason"><Input value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} placeholder={adjust.type === 'wastage' ? 'Spoiled, dropped, expired…' : 'Stock count correction…'} /></Field>
          </div>
        )}
      </Modal>
    </>
  );
}

function Movements() {
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const { data, loading, error, reload } = useApi<any>(`/api/staff/inventory/movements${qs({ page, type })}`);
  return (
    <>
      <PageHeader icon={HeaderIcon} accent="emerald" title="Stock movements" subtitle="Every change to stock with its source and resulting balance" />
      <Card pad={false}>
        <div className="border-b border-stone-100 p-4"><Select className="w-48" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}><option value="">All types</option>{['purchase', 'consumption', 'adjustment', 'wastage', 'return'].map((t) => <option key={t}>{t}</option>)}</Select></div>
        {loading && !data ? <Loading /> : error ? <ErrorState message={error} onRetry={reload} /> : (
          <>
            <DataTable rows={data.items} empty={<Empty title="No movements yet" />} columns={[
              { key: 'd', header: 'When', render: (m: any) => new Date(m.createdAt).toLocaleString() },
              { key: 'i', header: 'Item', render: (m: any) => m.inventoryItemId?.name ?? '—' },
              { key: 't', header: 'Type', render: (m: any) => <Badge tone={m.quantity > 0 ? 'good' : m.type === 'wastage' ? 'bad' : 'neutral'}>{m.type}</Badge> },
              { key: 'q', header: 'Change', render: (m: any) => <span className={m.quantity > 0 ? 'text-emerald-700' : 'text-red-600'}>{m.quantity > 0 ? '+' : ''}{+m.quantity.toFixed(3)} {m.inventoryItemId?.unit}</span> },
              { key: 'b', header: 'Balance', render: (m: any) => +Number(m.balanceAfter ?? 0).toFixed(3) },
              { key: 'r', header: 'Reason', render: (m: any) => <span className="text-xs text-stone-500">{m.reason}</span> },
            ]} />
            <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

function PurchaseOrders() {
  const fb = useFeedback();
  const { can, tenant } = useAuth();
  const dec = tenant?.settings?.currencyDecimals ?? 2;
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, dec);
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useApi<any>(`/api/staff/inventory/purchase-orders${qs({ page })}`);
  const suppliers = useApi<any>('/api/staff/inventory/suppliers?limit=200');
  const items = useApi<any>('/api/staff/inventory/items?limit=200');
  const [form, setForm] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      fb.ok(ok);
      reload();
    } catch (e) {
      fb.fail(e);
    }
  };
  const create = async () => {
    setBusy(true);
    try {
      await api.post('/api/staff/inventory/purchase-orders', { supplierId: form.supplierId, notes: form.notes || undefined, expectedAt: form.expectedAt ? new Date(form.expectedAt).toISOString() : undefined, lines: form.lines.filter((l: any) => l.inventoryItemId && Number(l.quantity) > 0).map((l: any) => ({ inventoryItemId: l.inventoryItemId, quantity: Number(l.quantity), unitCost: toMinor(l.unitCost || 0, dec) })) });
      fb.ok('Purchase order created');
      setForm(null);
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="emerald" title="Purchase orders" subtitle="Order from suppliers; receiving adds stock automatically" actions={can('inventory:manage') && <Button onClick={() => setForm({ supplierId: '', notes: '', expectedAt: '', lines: [{ inventoryItemId: '', quantity: '', unitCost: '' }] })}><PackagePlus className="h-4 w-4" /> New PO</Button>} />
      <Card pad={false}>
        {loading && !data ? <Loading /> : error ? <ErrorState message={error} onRetry={reload} /> : (
          <>
            <DataTable rows={data.items} empty={<Empty title="No purchase orders" />} columns={[
              { key: 'n', header: 'PO', render: (p: any) => <span className="font-semibold">#{p.poNumber}</span> },
              { key: 's', header: 'Supplier', render: (p: any) => p.supplierId?.name },
              { key: 'l', header: 'Lines', render: (p: any) => <span className="text-xs">{p.lines.map((l: any) => `${l.quantity} ${l.name}`).join(', ')}</span> },
              { key: 't', header: 'Total', render: (p: any) => money(p.total) },
              { key: 'st', header: 'Status', render: (p: any) => <StatusBadge status={p.status} /> },
              { key: 'a', header: '', className: 'text-end whitespace-nowrap', render: (p: any) => can('inventory:manage') && ['draft', 'ordered'].includes(p.status) ? (
                <div className="flex justify-end gap-1">
                  {p.status === 'draft' && <Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/api/staff/inventory/purchase-orders/${p._id}/status`, { status: 'ordered' }), 'Marked ordered')}>Mark ordered</Button>}
                  <Button size="sm" onClick={async () => { if (await fb.confirm({ title: `Receive PO #${p.poNumber}?`, body: 'All lines are added to stock and costs updated.' })) act(() => api.post(`/api/staff/inventory/purchase-orders/${p._id}/receive`), 'Stock received'); }}>Receive</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { if (await fb.confirm({ title: 'Cancel this PO?', danger: true })) act(() => api.post(`/api/staff/inventory/purchase-orders/${p._id}/status`, { status: 'cancelled' }), 'Cancelled'); }}>Cancel</Button>
                </div>) : null },
            ]} />
            <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <Modal open={!!form} onClose={() => setForm(null)} title="New purchase order" size="lg" footer={<><Button variant="outline" onClick={() => setForm(null)}>Cancel</Button><Button onClick={create} loading={busy} disabled={!form?.supplierId}>Create</Button></>}>
        {form && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Supplier"><Select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}><option value="">Choose…</option>{suppliers.data?.items?.map((s: any) => <option key={s._id} value={s._id}>{s.name}</option>)}</Select></Field>
              <Field label="Expected"><Input type="date" value={form.expectedAt} onChange={(e) => setForm({ ...form, expectedAt: e.target.value })} /></Field>
            </div>
            {form.lines.map((l: any, i: number) => (
              <div key={i} className="flex gap-2">
                <Select value={l.inventoryItemId} onChange={(e) => setForm({ ...form, lines: form.lines.map((x: any, j: number) => (j === i ? { ...x, inventoryItemId: e.target.value, unitCost: x.unitCost || toMajor(items.data?.items?.find((it: any) => it._id === e.target.value)?.costPerUnit ?? 0, dec) } : x)) })}><option value="">Item…</option>{items.data?.items?.map((it: any) => <option key={it._id} value={it._id}>{it.name} ({it.unit})</option>)}</Select>
                <Input className="w-28" type="number" min={0} step="any" placeholder="Qty" value={l.quantity} onChange={(e) => setForm({ ...form, lines: form.lines.map((x: any, j: number) => (j === i ? { ...x, quantity: e.target.value } : x)) })} />
                <Input className="w-32" type="number" min={0} step="0.01" placeholder="Unit cost" value={l.unitCost} onChange={(e) => setForm({ ...form, lines: form.lines.map((x: any, j: number) => (j === i ? { ...x, unitCost: e.target.value } : x)) })} />
                <Button size="icon" variant="ghost" onClick={() => setForm({ ...form, lines: form.lines.filter((_: any, j: number) => j !== i) })} aria-label="Remove line"><X className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, lines: [...form.lines, { inventoryItemId: '', quantity: '', unitCost: '' }] })}><Plus className="h-4 w-4" /> Line</Button>
            <Field label="Notes"><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </>
  );
}

function Suppliers() {
  const { can } = useAuth();
  return (
    <ResourcePage
      title="Suppliers"
      endpoint="/api/staff/inventory/suppliers"
      canEdit={can('inventory:manage')}
      deleteLabel="Deactivate"
      columns={[
        { key: 'n', header: 'Name', render: (s: any) => <span className="font-medium">{s.name}</span> },
        { key: 'c', header: 'Contact', render: (s: any) => s.contactName ?? '—' },
        { key: 'p', header: 'Phone', render: (s: any) => s.phone ?? '—' },
        { key: 'e', header: 'Email', render: (s: any) => s.email ?? '—' },
        { key: 'a', header: 'Status', render: (s: any) => <Badge tone={s.isActive ? 'good' : 'neutral'}>{s.isActive ? 'Active' : 'Inactive'}</Badge> },
      ]}
      fields={[
        { name: 'name', label: 'Name', required: true },
        { name: 'contactName', label: 'Contact person' },
        { name: 'phone', label: 'Phone' },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'address', label: 'Address', colSpan: 2 },
        { name: 'notes', label: 'Notes', type: 'textarea' },
        { name: 'isActive', label: 'Active', type: 'toggle' },
      ]}
    />
  );
}
