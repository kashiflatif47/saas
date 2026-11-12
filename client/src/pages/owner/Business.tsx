import { useState } from 'react';
import { Star, Eye, EyeOff, MessageSquareReply } from 'lucide-react';
import { api, qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../store/auth';
import { ResourcePage } from '../../components/ResourcePage';
import { Badge, Button, Card, Empty, ErrorState, Loading, PageHeader, Pagination, useFeedback } from '../../components/ui';
import { AuditView } from '../admin/Audit';
import { formatMoney } from '../../lib/util';
import { MessageSquareHeart as HeaderIcon } from 'lucide-react';

export default function Business({ kind }: { kind: 'reservations' | 'customers' | 'feedback' | 'coupons' | 'audit' }) {
  if (kind === 'reservations') return <Reservations />;
  if (kind === 'customers') return <Customers />;
  if (kind === 'feedback') return <Feedback />;
  if (kind === 'coupons') return <Coupons />;
  return <AuditView endpoint="/api/staff/audit" title="Audit log" />;
}

function Reservations() {
  const tables = useApi<{ items: any[] }>('/api/staff/tables');
  return (
    <ResourcePage
      title="Reservations"
      subtitle="Bookings from your website and phone. Confirmed bookings are protected against double-booking."
      endpoint="/api/staff/reservations"
      deleteLabel="Delete"
      filters={[{ name: 'status', options: ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'].map((s) => ({ value: s, label: s.replace('_', ' ') })) }]}
      defaults={{ status: 'confirmed', partySize: 2, durationMinutes: 90 }}
      columns={[
        { key: 'w', header: 'When', render: (r: any) => <span className="whitespace-nowrap font-medium">{new Date(r.reservedFor).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> },
        { key: 'n', header: 'Guest', render: (r: any) => <div><p>{r.name}</p><a className="text-xs text-brand" href={`tel:${r.phone}`}>{r.phone}</a></div> },
        { key: 'p', header: 'Party', render: (r: any) => r.partySize },
        { key: 't', header: 'Table', render: (r: any) => tables.data?.items.find((t) => t._id === r.tableId)?.label ?? '—' },
        { key: 's', header: 'Status', render: (r: any) => <Badge tone={r.status === 'confirmed' ? 'good' : r.status === 'pending' ? 'brand' : r.status === 'seated' ? 'info' : r.status === 'cancelled' || r.status === 'no_show' ? 'bad' : 'neutral'}>{r.status.replace('_', ' ')}</Badge> },
      ]}
      fields={[
        { name: 'name', label: 'Guest name', required: true },
        { name: 'phone', label: 'Phone', required: true },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'partySize', label: 'Party size', type: 'number', required: true },
        { name: 'reservedFor', label: 'Date & time', type: 'datetime', required: true },
        { name: 'durationMinutes', label: 'Duration (min)', type: 'number' },
        { name: 'tableId', label: 'Table', type: 'select', options: (tables.data?.items ?? []).map((t) => ({ value: t._id, label: `${t.label} · ${t.capacity} seats` })) },
        { name: 'status', label: 'Status', type: 'select', required: true, options: ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'].map((s) => ({ value: s, label: s.replace('_', ' ') })) },
        { name: 'notes', label: 'Notes', type: 'textarea' },
      ]}
    />
  );
}

function Customers() {
  const { tenant } = useAuth();
  return (
    <ResourcePage
      title="Customers"
      subtitle="Built automatically from orders with a phone number. Loyalty points are awarded on completed orders."
      endpoint="/api/staff/customers"
      columns={[
        { key: 'n', header: 'Customer', render: (c: any) => <div><p className="font-medium">{c.name || 'Guest'}</p><p className="text-xs text-stone-400">{c.phone}</p></div> },
        { key: 'o', header: 'Orders', render: (c: any) => c.totalOrders },
        { key: 's', header: 'Lifetime spend', render: (c: any) => formatMoney(c.totalSpent, tenant?.settings?.currency, tenant?.settings?.currencyDecimals) },
        { key: 'l', header: 'Points', render: (c: any) => c.loyaltyPoints },
        { key: 'd', header: 'Last order', render: (c: any) => (c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString() : '—') },
        { key: 't', header: 'Tags', render: (c: any) => <div className="flex flex-wrap gap-1">{c.tags?.map((t: string) => <Badge key={t}>{t}</Badge>)}</div> },
      ]}
      fields={[
        { name: 'name', label: 'Name' },
        { name: 'phone', label: 'Phone', required: true },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'loyaltyPoints', label: 'Loyalty points', type: 'number' },
        { name: 'tags', label: 'Tags', type: 'tags', hint: 'comma separated, e.g. VIP, regular' },
        { name: 'notes', label: 'Notes', type: 'textarea' },
      ]}
    />
  );
}

function Coupons() {
  const { tenant } = useAuth();
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals);
  return (
    <ResourcePage
      title="Coupons"
      subtitle="Promo codes customers enter at checkout. Discounts are validated and applied by the server."
      endpoint="/api/staff/coupons"
      defaults={{ type: 'percent', isActive: true }}
      columns={[
        { key: 'c', header: 'Code', render: (c: any) => <span className="font-mono font-semibold">{c.code}</span> },
        { key: 'v', header: 'Discount', render: (c: any) => (c.type === 'percent' ? `${c.value}%${c.maxDiscount ? ` (max ${money(c.maxDiscount)})` : ''}` : money(c.value)) },
        { key: 'm', header: 'Min. order', render: (c: any) => (c.minOrder ? money(c.minOrder) : '—') },
        { key: 'u', header: 'Used', render: (c: any) => `${c.usedCount}${c.usageLimit ? ` / ${c.usageLimit}` : ''}` },
        { key: 'e', header: 'Valid until', render: (c: any) => (c.endsAt ? new Date(c.endsAt).toLocaleDateString() : 'No expiry') },
        { key: 's', header: 'Status', render: (c: any) => <Badge tone={c.isActive ? 'good' : 'neutral'}>{c.isActive ? 'Active' : 'Off'}</Badge> },
      ]}
      fields={[
        { name: 'code', label: 'Code', required: true, placeholder: 'WELCOME10' },
        { name: 'type', label: 'Type', type: 'select', required: true, options: [{ value: 'percent', label: 'Percent off' }, { value: 'fixed', label: 'Fixed amount off' }] },
        { name: 'value', label: 'Percent (1–100)', type: 'number', required: true, showIf: (v) => v.type === 'percent' },
        { name: 'value', label: 'Amount off', type: 'money', required: true, showIf: (v) => v.type === 'fixed' },
        { name: 'maxDiscount', label: 'Max discount', type: 'money', showIf: (v) => v.type === 'percent' },
        { name: 'minOrder', label: 'Minimum order', type: 'money' },
        { name: 'usageLimit', label: 'Total uses allowed', type: 'number' },
        { name: 'startsAt', label: 'Starts', type: 'datetime' },
        { name: 'endsAt', label: 'Ends', type: 'datetime' },
        { name: 'description', label: 'Description', colSpan: 2 },
        { name: 'isActive', label: 'Active', type: 'toggle' },
      ]}
    />
  );
}

function Feedback() {
  const fb = useFeedback();
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useApi<any>(`/api/staff/feedback${qs({ page })}`);
  const patch = async (id: string, body: any, ok: string) => {
    try {
      await api.patch(`/api/staff/feedback/${id}`, body);
      fb.ok(ok);
      reload();
    } catch (e) {
      fb.fail(e);
    }
  };
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return (
    <>
      <PageHeader icon={HeaderIcon} accent="rose" title="Customer feedback" subtitle={data.average ? `Average rating ${data.average.toFixed(2)} ★ from ${data.total} reviews` : 'Guests can rate their order once it is served'} />
      {data.items.length === 0 ? <Card><Empty title="No feedback yet" /></Card> : (
        <div className="space-y-3">
          {data.items.map((f: any) => (
            <Card key={f._id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex gap-0.5 text-amber-500">{Array.from({ length: 5 }, (_, i) => <Star key={i} className={i < f.rating ? 'h-4 w-4 fill-current' : 'h-4 w-4 text-stone-200'} />)}</div>
                  <p className="mt-2 text-sm text-stone-700">{f.comment || <span className="italic text-stone-400">No comment</span>}</p>
                  <p className="mt-1 text-xs text-stone-400">{f.name || 'Guest'} · {new Date(f.createdAt).toLocaleString()}</p>
                  {f.response && <p className="mt-2 rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-600">↳ {f.response}</p>}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={async () => { const r = await fb.confirm({ title: 'Reply publicly', input: { label: 'Your response', required: true }, confirmLabel: 'Save reply' }); if (typeof r === 'string') patch(f._id, { response: r }, 'Reply saved'); }}><MessageSquareReply className="h-4 w-4" /> Reply</Button>
                  <Button size="sm" variant={f.isPublished ? 'outline' : 'ghost'} onClick={() => patch(f._id, { isPublished: !f.isPublished }, f.isPublished ? 'Hidden from website' : 'Shown on website')}>{f.isPublished ? <><EyeOff className="h-4 w-4" /> Unpublish</> : <><Eye className="h-4 w-4" /> Publish</>}</Button>
                </div>
              </div>
              {f.isPublished && <Badge tone="good" className="mt-2">Published on website</Badge>}
            </Card>
          ))}
          <Card pad={false}><Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} /></Card>
        </div>
      )}
    </>
  );
}
