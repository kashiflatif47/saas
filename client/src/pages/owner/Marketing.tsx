import { useState } from 'react';
import { Plus, RefreshCw, Sparkles } from 'lucide-react';
import { api, qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../store/auth';
import { Badge, Button, Card, DataTable, Drawer, Empty, ErrorState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, Stat, Tabs, Textarea, Toggle, useFeedback } from '../../components/ui';
import { formatMoney, toMajor, toMinor, timeAgo } from '../../lib/util';
import { Megaphone as HeaderIcon } from 'lucide-react';

type Tab = 'campaigns' | 'automations' | 'customers' | 'channels' | 'optouts';
const STATUS_TONE: Record<string, any> = { draft: 'neutral', pending_approval: 'warn', approved: 'info', scheduled: 'info', running: 'brand', paused: 'warn', completed: 'good', cancelled: 'neutral', active: 'good' };
const TRIGGERS: Record<string, string> = { joined: 'New customer joined', first_order: 'After first order', second_order: 'After second order', inactive: 'Inactive for N days', birthday: 'Birthday', order_count: 'Reached N orders', spend_threshold: 'Spent at least an amount' };

export default function Marketing() {
  const [tab, setTab] = useState<Tab>('campaigns');
  return (
    <>
      <PageHeader icon={HeaderIcon} accent="rose" eyebrow="Growth" title="Marketing" subtitle="Messages go only to customers who agreed to receive them, after an owner approves them, through providers you configure. Nothing is sent from this page automatically." />
      <div className="mb-4 overflow-x-auto">
        <Tabs value={tab} onChange={setTab} items={[{ value: 'campaigns', label: 'Campaigns' }, { value: 'automations', label: 'Automations' }, { value: 'customers', label: 'Segments & customers' }, { value: 'channels', label: 'Channels' }, { value: 'optouts', label: 'Opt-outs & rules' }]} />
      </div>
      {tab === 'campaigns' && <Campaigns />}
      {tab === 'automations' && <Automations />}
      {tab === 'customers' && <Customers />}
      {tab === 'channels' && <Channels />}
      {tab === 'optouts' && <OptOuts />}
    </>
  );
}

function useMoney() {
  const { tenant } = useAuth();
  const dec = tenant?.settings?.currencyDecimals ?? 2;
  return { money: (n?: number | null) => (n == null ? '—' : formatMoney(n, tenant?.settings?.currency, dec)), dec };
}

/* ------------------------------- message editor (shared) ------------------------------- */
function MessageFields({ v, set, segments }: { v: any; set: (p: any) => void; segments?: Record<string, string> }) {
  const fb = useFeedback();
  const { dec } = useMoney();
  const [drafting, setDrafting] = useState(false);
  const draft = async () => {
    const goal = await fb.confirm({ title: 'Draft with AI', body: 'Describe the goal. No customer data is sent. You must review the draft; it is only sent after approval.', input: { label: 'Goal (e.g. bring back customers who have not ordered in a month)', required: true }, confirmLabel: 'Draft' });
    if (typeof goal !== 'string') return;
    setDrafting(true);
    try {
      const r = await api.post('/api/staff/marketing/copy', { goal, channel: v.channel, offer: v.coupon?.value ? `${v.coupon.value}${v.coupon.type === 'percent' ? '%' : ''} off` : undefined });
      if (!r.available || !r.text) fb.push('info', r.reason ?? 'No draft produced');
      else set({ body: r.text, aiGenerated: true });
    } catch (e: any) { fb.push('error', e.message); } finally { setDrafting(false); }
  };
  const limit = v.channel === 'email' ? 1600 : 600;
  return (
    <div className="space-y-3">
      <Field label="Channel"><Select value={v.channel} onChange={(e) => set({ channel: e.target.value })}><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option></Select></Field>
      {segments && (
        <Field label="Audience" hint="No segment selected = every customer who agreed to this channel.">
          <div className="flex flex-wrap gap-2">
            {Object.entries(segments).map(([k, d]) => (
              <label key={k} title={d} className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${v.segments?.includes(k) ? 'border-brand bg-brand/10' : 'border-stone-200'}`}>
                <input type="checkbox" className="sr-only" checked={v.segments?.includes(k) ?? false} onChange={(e) => set({ segments: e.target.checked ? [...(v.segments ?? []), k] : v.segments.filter((x: string) => x !== k) })} />
                {k.replace(/_/g, ' ')}
              </label>
            ))}
          </div>
        </Field>
      )}
      {v.channel === 'email' && <Field label="Subject"><Input value={v.subject ?? ''} maxLength={150} onChange={(e) => set({ subject: e.target.value })} /></Field>}
      <Field label={<span className="flex items-center justify-between gap-2">Message {v.aiGenerated && <Badge tone="brand">AI draft – review it</Badge>}</span>} hint={`Placeholders: {{name}}, {{restaurant}}, {{coupon}}. An opt-out link is added automatically. ${(v.body ?? '').length}/${limit}`}>
        <Textarea value={v.body ?? ''} maxLength={limit} onChange={(e) => set({ body: e.target.value })} rows={5} />
      </Field>
      <Button type="button" variant="ghost" size="sm" onClick={draft} loading={drafting}><Sparkles className="h-4 w-4" /> Draft with AI</Button>
      <Card title="Offer (optional)">
        <Toggle checked={!!v.coupon} onChange={(on) => set({ coupon: on ? { type: 'percent', value: 10, validDays: 7 } : null })} label="Include a personal coupon (one code, only valid for the people messaged)" />
        {v.coupon && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Type"><Select value={v.coupon.type} onChange={(e) => set({ coupon: { ...v.coupon, type: e.target.value } })}><option value="percent">Percent</option><option value="fixed">Fixed amount</option></Select></Field>
            <Field label={v.coupon.type === 'percent' ? 'Percent off' : 'Amount off'}><Input type="number" min={1} value={v.coupon.type === 'percent' ? v.coupon.value : toMajor(v.coupon.value, dec)} onChange={(e) => set({ coupon: { ...v.coupon, value: v.coupon.type === 'percent' ? Number(e.target.value) : toMinor(e.target.value, dec) } })} /></Field>
            <Field label="Minimum order"><Input type="number" min={0} value={toMajor(v.coupon.minOrder ?? 0, dec)} onChange={(e) => set({ coupon: { ...v.coupon, minOrder: toMinor(e.target.value, dec) || undefined } })} /></Field>
            <Field label="Valid for (days)"><Input type="number" min={1} max={365} value={v.coupon.validDays ?? 7} onChange={(e) => set({ coupon: { ...v.coupon, validDays: Number(e.target.value) } })} /></Field>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------- campaigns ------------------------------- */
function Campaigns() {
  const fb = useFeedback();
  const { can } = useAuth();
  const { money } = useMoney();
  const list = useApi<any>('/api/staff/marketing/campaigns');
  const seg = useApi<any>('/api/staff/marketing/segments');
  const [edit, setEdit] = useState<any>(null);
  const [open, setOpen] = useState<any>(null);
  const save = async () => {
    try {
      const body = { name: edit.name, channel: edit.channel, segments: edit.segments ?? [], subject: edit.subject || undefined, body: edit.body, aiGenerated: !!edit.aiGenerated, coupon: edit.coupon ?? null, budget: { limit: edit.budgetLimit ?? null }, endAt: edit.endAt || null };
      if (edit._id) await api.patch(`/api/staff/marketing/campaigns/${edit._id}`, body);
      else await api.post('/api/staff/marketing/campaigns', body);
      fb.push('success', 'Saved as draft. Submit it for approval when ready.');
      setEdit(null);
      list.reload();
    } catch (e: any) { fb.push('error', e.message); }
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button onClick={() => setEdit({ name: '', channel: 'sms', segments: [], body: '' })}><Plus className="h-4 w-4" /> New campaign</Button></div>
      <Card pad={false}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : (
          <DataTable rows={list.data.items} onRowClick={setOpen} empty={<Empty title="No campaigns yet" hint="Create a draft, preview the audience, send yourself a test, then ask the owner to approve it." />} columns={[
            { key: 'n', header: 'Campaign', render: (c: any) => <span className="font-medium">{c.name}{c.aiGenerated && <Badge tone="brand" className="ms-2">AI copy</Badge>}</span> },
            { key: 'c', header: 'Channel', render: (c: any) => c.channel },
            { key: 's', header: 'Status', render: (c: any) => <Badge tone={STATUS_TONE[c.status]}>{c.status.replace('_', ' ')}</Badge> },
            { key: 'w', header: 'When', render: (c: any) => (c.scheduleAt ? new Date(c.scheduleAt).toLocaleString() : '—') },
            { key: 'b', header: 'Spent', className: 'text-end', render: (c: any) => (c.budget?.limit ? `${money(c.budget.spent ?? 0)} / ${money(c.budget.limit)}` : money(c.budget?.spent ?? 0)) },
          ]} />
        )}
      </Card>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?._id ? 'Edit campaign' : 'New campaign'} footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save draft</Button></div>}>
        {edit && (
          <div className="space-y-3">
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <MessageFields v={edit} set={(p) => setEdit({ ...edit, ...p })} segments={seg.data?.definitions} />
            <Field label="Budget limit (optional)" hint="Uses the per-message cost you enter under Channels. The campaign pauses when the next message would exceed it.">
              <Input type="number" min={0} value={edit.budgetLimit != null ? toMajor(edit.budgetLimit) : ''} onChange={(e) => setEdit({ ...edit, budgetLimit: e.target.value ? toMinor(e.target.value) : null })} />
            </Field>
          </div>
        )}
      </Drawer>
      {open && <CampaignDetail id={open._id} onClose={() => { setOpen(null); list.reload(); }} onEdit={(c) => { setOpen(null); setEdit({ ...c, budgetLimit: c.budget?.limit ?? null }); }} canApprove={can('marketing:approve')} />}
    </div>
  );
}

function CampaignDetail({ id, onClose, onEdit, canApprove }: { id: string; onClose: () => void; onEdit: (c: any) => void; canApprove: boolean }) {
  const fb = useFeedback();
  const { money } = useMoney();
  const c = useApi<any>(`/api/staff/marketing/campaigns/${id}`);
  const preview = useApi<any>(`/api/staff/marketing/campaigns/${id}/preview`);
  const report = useApi<any>(['running', 'paused', 'completed', 'cancelled'].includes(c.data?.status) ? `/api/staff/marketing/campaigns/${id}/report` : null, [c.data?.status]);
  const [when, setWhen] = useState('');
  const act = async (action: string, body: any = {}) => {
    if (['approve', 'schedule', 'cancel'].includes(action)) {
      const ok = await fb.confirm({ title: action === 'approve' ? 'Approve this message?' : action === 'schedule' ? `Send to ${preview.data?.recipients ?? 0} customers?` : 'Cancel this campaign?', body: action === 'schedule' ? `Estimated cost ${money(preview.data?.estimatedCost)}. Messages are sent through your own provider account.` : undefined, danger: action === 'cancel' });
      if (!ok) return;
    }
    try {
      await api.post(`/api/staff/marketing/campaigns/${id}/${action}`, body);
      c.reload();
      preview.reload();
    } catch (e: any) { fb.push('error', e.message); }
  };
  const test = async () => {
    const to = await fb.confirm({ title: 'Send a test', body: 'Sends one message marked [TEST] through your provider.', input: { label: c.data.channel === 'email' ? 'Email address' : 'Phone (+country code)', required: true }, confirmLabel: 'Send test' });
    if (typeof to !== 'string') return;
    try { const r = await api.post(`/api/staff/marketing/campaigns/${id}/test`, { to }); fb.push('success', r.note); } catch (e: any) { fb.push('error', e.message); }
  };
  const x = c.data;
  return (
    <Drawer open onClose={onClose} title={x?.name ?? 'Campaign'} width="max-w-2xl">
      {!x ? <Loading /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={STATUS_TONE[x.status]}>{x.status.replace('_', ' ')}</Badge><Badge>{x.channel}</Badge>{x.approvedBy && <span className="text-xs text-stone-500">Approved by {x.approvedBy} {timeAgo(x.approvedAt)}</span>}{x.pauseReason && <Badge tone="warn">{x.pauseReason}</Badge>}</div>
          {preview.data && (
            <Card title="Preview">
              <div className="mb-2 text-sm">{preview.data.recipients} recipients · excluded {preview.data.excluded.noValidAddress} without a valid address and {preview.data.excluded.suppressed} opted out · estimated cost {money(preview.data.estimatedCost)}</div>
              {preview.data.excluded.noValidAddress > 0 && x.channel !== 'email' && <p className="mb-2 text-xs text-stone-500">Local numbers (e.g. 0300…) need your country code: set it under Opt-outs &amp; rules.</p>}
              {!preview.data.providerConfigured &&<p className="mb-2 text-sm text-amber-700">No {x.channel} provider is configured. Set one up under Channels before scheduling.</p>}
              {preview.data.renderedSample ? <pre className="whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-sm">{preview.data.renderedSample}</pre> : <p className="text-sm text-stone-500">No consenting customer matches this audience.</p>}
            </Card>
          )}
          <div className="flex flex-wrap gap-2">
            {['draft', 'pending_approval', 'approved'].includes(x.status) && <Button variant="ghost" onClick={() => onEdit(x)}>Edit</Button>}
            <Button variant="ghost" onClick={test}>Send test</Button>
            {x.status === 'draft' && <Button onClick={() => act('submit')}>Submit for approval</Button>}
            {x.status === 'pending_approval' && canApprove && <Button onClick={() => act('approve')}>Approve</Button>}
            {x.status === 'approved' && canApprove && (
              <div className="flex flex-wrap items-center gap-2">
                <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="w-56" />
                <Button onClick={() => act('schedule', when ? { scheduleAt: new Date(when).toISOString() } : {})}>{when ? 'Schedule' : 'Send now'}</Button>
              </div>
            )}
            {['scheduled', 'running'].includes(x.status) && <Button variant="ghost" onClick={() => act('pause')}>Pause</Button>}
            {x.status === 'paused' && canApprove && <Button onClick={() => act('resume')}>Resume</Button>}
            {!['completed', 'cancelled'].includes(x.status) && <Button variant="danger" onClick={() => act('cancel')}>Cancel</Button>}
          </div>
          {!canApprove && ['pending_approval', 'approved'].includes(x.status) && <p className="text-sm text-stone-500">Waiting for the owner or an admin to approve and launch.</p>}
          {report.data && (
            <Card title="Results">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Accepted by provider" value={report.data.messages.sentAcceptedByProvider} sub={`${report.data.messages.deliveredConfirmed} delivery confirmed`} />
                <Stat label="Failed / skipped" value={`${report.data.messages.failed} / ${report.data.messages.skipped}`} sub={report.data.messages.unknown ? `${report.data.messages.unknown} unknown` : undefined} />
                <Stat label="Cost (estimate)" value={money(report.data.estimatedCost)} />
                <Stat label="Coupon orders (verified)" value={report.data.verified.couponRedemptions} sub={money(report.data.verified.revenue)} tone="brand" />
                <Stat label="Conversion (verified)" value={report.data.verified.conversionRatePercent != null ? `${report.data.verified.conversionRatePercent}%` : '—'} />
                <Stat label="Other orders (estimate)" value={report.data.estimated.influencedOrders} sub={money(report.data.estimated.influencedRevenue)} />
              </div>
              <p className="mt-2 text-xs text-stone-500">Verified: {report.data.verified.basis} Estimate: {report.data.estimated.basis} {report.data.clicks.note}</p>
            </Card>
          )}
          <MessageLogTable sourceId={id} />
        </div>
      )}
    </Drawer>
  );
}

function MessageLogTable({ sourceId }: { sourceId?: string }) {
  const [page, setPage] = useState(1);
  const m = useApi<any>(`/api/staff/marketing/messages${qs({ sourceId, page, limit: 20 })}`, [page, sourceId]);
  const tone: Record<string, any> = { sent: 'info', delivered: 'good', failed: 'bad', skipped: 'neutral', queued: 'neutral', sending: 'info', unknown: 'warn' };
  if (!m.data) return null;
  return (
    <Card title="Message log" pad={false}>
      <DataTable rows={m.data.items} empty={<Empty title="No messages yet" />} columns={[
        { key: 't', header: 'To', render: (x: any) => x.to },
        { key: 's', header: 'Status', render: (x: any) => <Badge tone={tone[x.status]}>{x.status}</Badge> },
        { key: 'r', header: 'Detail', render: (x: any) => <span className="text-xs">{x.skipReason ?? x.error ?? x.providerStatus ?? ''}</span> },
        { key: 'w', header: 'When', render: (x: any) => timeAgo(x.sentAt ?? x.createdAt) },
      ]} />
      <div className="p-3"><Pagination page={page} limit={20} total={m.data.total} onPage={setPage} /></div>
    </Card>
  );
}

/* ------------------------------- automations ------------------------------- */
function Automations() {
  const fb = useFeedback();
  const { can } = useAuth();
  const list = useApi<any>('/api/staff/marketing/journeys');
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    try {
      const body = { name: edit.name, trigger: edit.trigger, config: edit.config ?? {}, channel: edit.channel, subject: edit.subject || undefined, body: edit.body, coupon: edit.coupon ?? null, aiGenerated: !!edit.aiGenerated };
      if (edit._id) await api.patch(`/api/staff/marketing/journeys/${edit._id}`, body);
      else await api.post('/api/staff/marketing/journeys', body);
      setEdit(null);
      list.reload();
    } catch (e: any) { fb.push('error', e.message); }
  };
  const act = async (id: string, action: string) => {
    try { await api.post(`/api/staff/marketing/journeys/${id}/${action}`); list.reload(); } catch (e: any) { fb.push('error', e.message); }
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button onClick={() => setEdit({ name: '', trigger: 'inactive', config: { days: 30 }, channel: 'sms', body: '' })}><Plus className="h-4 w-4" /> New automation</Button></div>
      <p className="text-sm text-stone-500">Automations are checked every hour. Each customer receives a given automation once per occasion (e.g. once per inactive spell, once per birthday), and the same consent, opt-out, quiet-hour and frequency rules apply.</p>
      <Card pad={false}>
        {list.loading && !list.data ? <Loading /> : (
          <DataTable rows={list.data?.items ?? []} empty={<Empty title="No automations" />} columns={[
            { key: 'n', header: 'Automation', render: (j: any) => j.name },
            { key: 't', header: 'Trigger', render: (j: any) => `${TRIGGERS[j.trigger]}${j.config?.days ? ` (${j.config.days} d)` : j.config?.count ? ` (${j.config.count})` : ''}` },
            { key: 'c', header: 'Channel', render: (j: any) => j.channel },
            { key: 's', header: 'Status', render: (j: any) => <Badge tone={STATUS_TONE[j.status]}>{j.status}</Badge> },
            { key: 'a', header: '', className: 'text-end', render: (j: any) => (
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEdit(j)}>Edit</Button>
                {j.status !== 'active' && can('marketing:approve') && <Button size="sm" onClick={() => act(j._id, 'activate')}>Approve & activate</Button>}
                {j.status === 'active' && <Button size="sm" variant="ghost" onClick={() => act(j._id, 'pause')}>Pause</Button>}
              </div>
            ) },
          ]} />
        )}
      </Card>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?._id ? 'Edit automation (needs approval again)' : 'New automation'} footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save draft</Button></div>}>
        {edit && (
          <div className="space-y-3">
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Trigger"><Select value={edit.trigger} onChange={(e) => setEdit({ ...edit, trigger: e.target.value })}>{Object.entries(TRIGGERS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
            {edit.trigger === 'inactive' && <Field label="Days without an order"><Input type="number" min={7} value={edit.config?.days ?? 30} onChange={(e) => setEdit({ ...edit, config: { days: Number(e.target.value) } })} /></Field>}
            {edit.trigger === 'order_count' && <Field label="Number of orders"><Input type="number" min={2} value={edit.config?.count ?? 10} onChange={(e) => setEdit({ ...edit, config: { count: Number(e.target.value) } })} /></Field>}
            {edit.trigger === 'spend_threshold' && <Field label="Total spend"><Input type="number" min={0} value={toMajor(edit.config?.amount ?? 0)} onChange={(e) => setEdit({ ...edit, config: { amount: toMinor(e.target.value) } })} /></Field>}
            {edit.trigger === 'birthday' && <p className="text-sm text-stone-500">Uses birthdays entered by staff on the customer record (Segments & customers).</p>}
            <MessageFields v={edit} set={(p) => setEdit({ ...edit, ...p })} />
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ------------------------------- segments & customers ------------------------------- */
function Customers() {
  const fb = useFeedback();
  const [segment, setSegment] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const seg = useApi<any>('/api/staff/marketing/segments');
  const list = useApi<any>(`/api/staff/marketing/customers${qs({ segment, q, page, limit: 25 })}`, [segment, q, page]);
  const [open, setOpen] = useState<string | null>(null);
  const recalc = async () => {
    try { await api.post('/api/staff/marketing/segments/recalculate'); seg.reload(); list.reload(); fb.push('success', 'Segments updated'); } catch (e: any) { fb.push('error', e.message); }
  };
  return (
    <div className="space-y-3">
      {seg.data && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {Object.entries(seg.data.definitions as Record<string, string>).map(([k, d]) => (
            <button key={k} title={d} onClick={() => { setSegment(segment === k ? '' : k); setPage(1); }} className={`rounded-xl border p-3 text-start ${segment === k ? 'border-brand bg-brand/10' : 'border-stone-200 bg-white'}`}>
              <div className="text-xs capitalize text-stone-500">{k.replace(/_/g, ' ')}</div>
              <div className="text-xl font-semibold">{seg.data.counts?.[k] ?? 0}</div>
              <div className="line-clamp-2 text-[11px] text-stone-400">{d}</div>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search name or phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="w-60" />
        <Button variant="ghost" size="sm" onClick={recalc}><RefreshCw className="h-4 w-4" /> Recalculate now</Button>
        <span className="text-xs text-stone-500">{seg.data?.totalCustomers ?? 0} customers. Segments refresh nightly.</span>
      </div>
      <Card pad={false}>
        {list.loading && !list.data ? <Loading /> : (
          <>
            <DataTable rows={list.data?.items ?? []} onRowClick={(c: any) => setOpen(c._id)} empty={<Empty title="No customers" hint="Customers are created from orders that include a phone number." />} columns={[
              { key: 'n', header: 'Customer', render: (c: any) => c.name ?? '—' },
              { key: 'p', header: 'Phone', render: (c: any) => c.phone },
              { key: 'o', header: 'Orders', render: (c: any) => c.stats?.orders ?? 0 },
              { key: 'g', header: 'Segments', render: (c: any) => <div className="flex flex-wrap gap-1">{(c.segments ?? []).map((s: string) => <Badge key={s}>{s.replace(/_/g, ' ')}</Badge>)}</div> },
              { key: 'c', header: 'Consent', render: (c: any) => ['sms', 'whatsapp', 'email'].filter((ch) => c.consent?.[ch]?.granted).join(', ') || 'none' },
            ]} />
            <div className="p-3"><Pagination page={page} limit={25} total={list.data?.total ?? 0} onPage={setPage} /></div>
          </>
        )}
      </Card>
      {open && <CustomerDetail id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    </div>
  );
}

function CustomerDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const fb = useFeedback();
  const { money } = useMoney();
  const d = useApi<any>(`/api/staff/marketing/customers/${id}`);
  const [bday, setBday] = useState('');
  const consent = async (ch: string, granted: boolean) => {
    if (granted) {
      const ok = await fb.confirm({ title: `Record ${ch} consent?`, body: 'Only record consent the customer actually gave you (for example verbally at the counter or on a signed form). This is logged with your name.' });
      if (!ok) return;
    }
    try { await api.patch(`/api/staff/marketing/customers/${id}/consent`, { channels: [ch], granted }); d.reload(); } catch (e: any) { fb.push('error', e.message); }
  };
  const saveBirthday = async () => {
    try { await api.patch(`/api/staff/marketing/customers/${id}/consent`, { channels: ['sms'], granted: !!d.data.customer.consent?.sms?.granted, birthday: bday || null }); d.reload(); } catch (e: any) { fb.push('error', e.message); }
  };
  const c = d.data?.customer;
  return (
    <Drawer open onClose={onClose} title={c?.name ?? 'Customer'}>
      {!c ? <Loading /> : (
        <div className="space-y-4">
          <div className="text-sm">{c.phone} {c.email && `· ${c.email}`}</div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Orders" value={c.stats?.orders ?? 0} />
            <Stat label="Spend" value={money(c.stats?.spend)} />
            <Stat label="Last order" value={c.stats?.lastOrderAt ? timeAgo(c.stats.lastOrderAt) : '—'} />
          </div>
          <Card title="Marketing consent">
            {['sms', 'whatsapp', 'email'].map((ch) => (
              <div key={ch} className="flex items-center justify-between py-1 text-sm">
                <span className="capitalize">{ch}{c.consent?.[ch]?.at && <span className="ms-2 text-xs text-stone-400">{c.consent[ch].granted ? 'given' : 'withdrawn'} {timeAgo(c.consent[ch].revokedAt ?? c.consent[ch].at)} ({c.consent[ch].source})</span>}</span>
                <Toggle checked={!!c.consent?.[ch]?.granted} onChange={(v) => consent(ch, v)} />
              </div>
            ))}
          </Card>
          <Field label="Birthday (MM-DD)"><div className="flex gap-2"><Input placeholder={c.birthday ?? '04-23'} value={bday} onChange={(e) => setBday(e.target.value)} pattern="\d{2}-\d{2}" /><Button variant="ghost" onClick={saveBirthday}>Save</Button></div></Field>
          <Card title="Recent orders" pad={false}>
            <DataTable rows={d.data.orders} empty={<Empty title="No orders" />} columns={[
              { key: 'n', header: '#', render: (o: any) => o.orderNumber },
              { key: 'd', header: 'Date', render: (o: any) => new Date(o.createdAt).toLocaleDateString() },
              { key: 's', header: 'Status', render: (o: any) => o.status },
              { key: 't', header: 'Total', className: 'text-end', render: (o: any) => money(o.total) },
            ]} />
          </Card>
          <Card title="Messages" pad={false}>
            <DataTable rows={d.data.messages} empty={<Empty title="No messages sent" />} columns={[
              { key: 'c', header: 'Channel', render: (m: any) => m.channel },
              { key: 's', header: 'Status', render: (m: any) => `${m.status}${m.skipReason ? ` (${m.skipReason})` : ''}` },
              { key: 'w', header: 'When', render: (m: any) => timeAgo(m.sentAt ?? m.createdAt) },
            ]} />
          </Card>
        </div>
      )}
    </Drawer>
  );
}

/* ------------------------------- channels ------------------------------- */
function Channels() {
  const fb = useFeedback();
  const { can } = useAuth();
  const { money, dec } = useMoney();
  const ch = useApi<any>('/api/staff/marketing/channels');
  const [form, setForm] = useState<any>(null);
  if (ch.loading && !ch.data) return <Loading />;
  if (ch.error) return <ErrorState message={ch.error} onRetry={ch.reload} />;
  const d = ch.data;
  const manage = can('settings:manage');
  const verify = async (c: string) => {
    try { await api.post(`/api/staff/marketing/channels/${c}/verify`); fb.push('success', 'Provider credentials verified'); ch.reload(); } catch (e: any) { fb.push('error', e.message); }
  };
  const save = async () => {
    try { await api.patch('/api/staff/marketing/channels', form.body); fb.push('success', 'Saved. Verify the credentials before use.'); setForm(null); ch.reload(); } catch (e: any) { fb.push('error', e.message); }
  };
  const status = (x: any) => (x.provider === 'none' ? <Badge>Not configured</Badge> : x.verifiedAt ? <Badge tone="good">Verified {timeAgo(x.verifiedAt)}</Badge> : <Badge tone="warn">Not verified</Badge>);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="SMS (Twilio)" actions={status(d.sms)}>
        <div className="space-y-1 text-sm"><div>Account: {d.sms.accountSid ?? '—'}</div><div>From: {d.sms.from ?? '—'}</div><div>Auth token: {d.sms.hasAuthToken ? 'stored (encrypted)' : 'not set'}</div>
          <div className="break-all text-xs text-stone-500">Delivery receipts: Twilio calls {d.sms.statusCallbackUrl} (signature-checked). Without it, messages show as "sent" (accepted), never "delivered".</div></div>
        {manage && <div className="mt-3 flex gap-2"><Button size="sm" variant="ghost" onClick={() => setForm({ title: 'Twilio SMS', body: { sms: { provider: 'twilio', accountSid: d.sms.accountSid ?? '', from: d.sms.from ?? '' } } })}>Configure</Button>{d.sms.provider !== 'none' && <Button size="sm" variant="ghost" onClick={() => verify('sms')}>Verify</Button>}</div>}
      </Card>
      <Card title="WhatsApp (Twilio)" actions={status(d.whatsapp)}>
        <div className="space-y-1 text-sm"><div>From: {d.whatsapp.from ?? '—'}</div><div className="text-xs text-stone-500">{d.whatsapp.note}</div></div>
        {manage && <div className="mt-3 flex gap-2"><Button size="sm" variant="ghost" onClick={() => setForm({ title: 'WhatsApp sender', body: { whatsapp: { provider: 'twilio', from: d.whatsapp.from ?? '' } } })}>Configure</Button>{d.whatsapp.provider !== 'none' && <Button size="sm" variant="ghost" onClick={() => verify('whatsapp')}>Verify</Button>}</div>}
      </Card>
      <Card title="Email (SendGrid)" actions={status(d.email)}>
        <div className="space-y-1 text-sm"><div>From: {d.email.from ?? '—'}</div><div>API key: {d.email.hasApiKey ? 'stored (encrypted)' : 'not set'}</div><div className="text-xs text-stone-500">{d.email.note}</div></div>
        {manage && <div className="mt-3 flex gap-2"><Button size="sm" variant="ghost" onClick={() => setForm({ title: 'SendGrid email', body: { email: { provider: 'sendgrid', from: d.email.from ?? '' } } })}>Configure</Button>{d.email.provider !== 'none' && <Button size="sm" variant="ghost" onClick={() => verify('email')}>Verify</Button>}</div>}
      </Card>
      <Card title="Push notifications"><p className="text-sm text-stone-500">{d.push.note}</p></Card>
      <Card title="Cost per message (for budgets and estimates)">
        <p className="mb-2 text-xs text-stone-500">Enter your provider's price. These are estimates; your provider's invoice is authoritative.</p>
        <div className="grid grid-cols-3 gap-2">
          {['sms', 'whatsapp', 'email'].map((k) => <Field key={k} label={k}><Input type="number" min={0} step="0.01" defaultValue={toMajor(d.costs?.[k] ?? 0, dec)} disabled={!manage} onBlur={async (e) => { try { await api.patch('/api/staff/marketing/channels', { costs: { [k]: toMinor(e.target.value, dec) } }); ch.reload(); } catch (er: any) { fb.push('error', er.message); } }} /></Field>)}
        </div>
        <div className="mt-1 text-xs text-stone-400">SMS {money(d.costs?.sms ?? 0)} · WhatsApp {money(d.costs?.whatsapp ?? 0)} · Email {money(d.costs?.email ?? 0)}</div>
      </Card>
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.title} footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button><Button onClick={save}>Save</Button></div>}>
        {form?.body.sms && (
          <div className="space-y-3">
            <Field label="Account SID"><Input value={form.body.sms.accountSid} onChange={(e) => setForm({ ...form, body: { sms: { ...form.body.sms, accountSid: e.target.value.trim() } } })} /></Field>
            <Field label="Auth token" hint="Leave empty to keep the stored token. Stored encrypted; never shown again."><Input type="password" autoComplete="off" onChange={(e) => setForm({ ...form, body: { sms: { ...form.body.sms, authToken: e.target.value.trim() || undefined } } })} /></Field>
            <Field label="From number (+E.164)"><Input value={form.body.sms.from} onChange={(e) => setForm({ ...form, body: { sms: { ...form.body.sms, from: e.target.value.trim() } } })} /></Field>
          </div>
        )}
        {form?.body.whatsapp && <Field label="WhatsApp-enabled number (+E.164)"><Input value={form.body.whatsapp.from} onChange={(e) => setForm({ ...form, body: { whatsapp: { ...form.body.whatsapp, from: e.target.value.trim() } } })} /></Field>}
        {form?.body.email && (
          <div className="space-y-3">
            <Field label="API key" hint="Leave empty to keep the stored key."><Input type="password" autoComplete="off" onChange={(e) => setForm({ ...form, body: { email: { ...form.body.email, apiKey: e.target.value.trim() || undefined } } })} /></Field>
            <Field label="From address (verified sender)"><Input type="email" value={form.body.email.from} onChange={(e) => setForm({ ...form, body: { email: { ...form.body.email, from: e.target.value.trim() } } })} /></Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ------------------------------- opt-outs & rules ------------------------------- */
function OptOuts() {
  const fb = useFeedback();
  const { tenant, can } = useAuth();
  const sup = useApi<any>('/api/staff/marketing/suppressions');
  const m: any = tenant?.settings?.marketing ?? {};
  const [rules, setRules] = useState<any>({ quietStart: m.quietStart ?? '21:00', quietEnd: m.quietEnd ?? '09:00', maxPerWeek: m.maxPerWeek ?? 2, minHoursBetween: m.minHoursBetween ?? 24, attributionDays: m.attributionDays ?? 7, countryCode: m.countryCode ?? '' });
  const add = async () => {
    const address = await fb.confirm({ title: 'Block an address', body: 'This phone number or email will never receive marketing messages.', input: { label: 'Phone (+country code) or email', required: true }, confirmLabel: 'Block' });
    if (typeof address !== 'string') return;
    try { await api.post('/api/staff/marketing/suppressions', { channel: 'all', address }); sup.reload(); } catch (e: any) { fb.push('error', e.message); }
  };
  const remove = async (id: string) => {
    if (!(await fb.confirm({ title: 'Remove this block?', body: 'Removing it does not restore consent: the customer must opt in again.' }))) return;
    try { await api.del(`/api/staff/marketing/suppressions/${id}`); sup.reload(); } catch (e: any) { fb.push('error', e.message); }
  };
  const saveRules = async () => {
    try { await api.patch('/api/staff/marketing/settings', rules); fb.push('success', 'Rules saved'); } catch (e: any) { fb.push('error', e.message); }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Sending rules">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quiet hours start"><Input type="time" value={rules.quietStart} onChange={(e) => setRules({ ...rules, quietStart: e.target.value })} /></Field>
          <Field label="Quiet hours end"><Input type="time" value={rules.quietEnd} onChange={(e) => setRules({ ...rules, quietEnd: e.target.value })} /></Field>
          <Field label="Max messages per customer per week"><Input type="number" min={1} max={14} value={rules.maxPerWeek} onChange={(e) => setRules({ ...rules, maxPerWeek: Number(e.target.value) })} /></Field>
          <Field label="Min hours between messages"><Input type="number" min={1} value={rules.minHoursBetween} onChange={(e) => setRules({ ...rules, minHoursBetween: Number(e.target.value) })} /></Field>
          <Field label="Attribution window (days)"><Input type="number" min={1} max={30} value={rules.attributionDays} onChange={(e) => setRules({ ...rules, attributionDays: Number(e.target.value) })} /></Field>
          <Field label="Country code for local numbers" hint="e.g. +92"><Input value={rules.countryCode} onChange={(e) => setRules({ ...rules, countryCode: e.target.value.trim() })} /></Field>
        </div>
        {can('marketing:approve') && <Button className="mt-3" onClick={saveRules}>Save rules</Button>}
      </Card>
      <Card title="Opted out & blocked" actions={<Button size="sm" variant="ghost" onClick={add}><Plus className="h-4 w-4" /> Block</Button>} pad={false}>
        <DataTable rows={sup.data?.items ?? []} empty={<Empty title="Nobody has opted out" />} columns={[
          { key: 'a', header: 'Address', render: (x: any) => x.address },
          { key: 'r', header: 'Reason', render: (x: any) => x.reason },
          { key: 'w', header: 'When', render: (x: any) => timeAgo(x.createdAt) },
          { key: 'x', header: '', className: 'text-end', render: (x: any) => can('marketing:approve') && <Button size="sm" variant="ghost" onClick={() => remove(x._id)}>Remove</Button> },
        ]} />
      </Card>
      <div className="lg:col-span-2"><MessageLogTable /></div>
    </div>
  );
}
