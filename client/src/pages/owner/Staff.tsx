import { useState } from 'react';
import { Activity, Plus } from 'lucide-react';
import { api } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../store/auth';
import { Badge, Button, Card, DataTable, Drawer, ErrorState, Field, Input, Loading, Modal, PageHeader, Toggle, useFeedback } from '../../components/ui';
import { cn, timeAgo } from '../../lib/util';
import { Users as HeaderIcon } from 'lucide-react';

const ROLES = [
  { v: 'admin', d: 'Everything except payment provider keys' },
  { v: 'manager', d: 'Menu, tables, orders, refunds, analytics' },
  { v: 'waiter', d: 'Take & serve orders on assigned tables' },
  { v: 'cashier', d: 'Collect payments, customers' },
  { v: 'kitchen', d: 'Kitchen display only' },
  { v: 'inventory_manager', d: 'Stock, suppliers, purchase orders' },
  { v: 'rider', d: 'Delivery app: only their own assigned deliveries' },
];
const PERMS = ['menu:manage', 'tables:manage', 'orders:manage', 'orders:accept', 'orders:deliver', 'kitchen:operate', 'payments:collect', 'payments:refund', 'analytics:view', 'inventory:manage', 'reservations:manage', 'customers:manage', 'coupons:manage', 'feedback:view', 'audit:view', 'intelligence:view', 'marketing:manage', 'marketing:approve', 'delivery:dispatch', 'delivery:manage'];

export default function Staff() {
  const fb = useFeedback();
  const { can, user: me } = useAuth();
  const manage = can('staff:manage');
  const { data, loading, error, reload } = useApi<{ items: any[] }>('/api/staff/staff');
  const roles = useApi<Record<string, string[]>>('/api/auth/roles');
  const tables = useApi<{ items: any[] }>('/api/staff/tables');
  const stations = useApi<{ items: any[] }>('/api/staff/menu/stations?limit=100');
  const [edit, setEdit] = useState<any | null>(null);
  const [activity, setActivity] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const body: any = { name: edit.name, email: edit.email, phone: edit.phone || undefined, assignedTableIds: edit.assignedTableIds, stationIds: edit.stationIds, permissionOverrides: edit.permissionOverrides, isActive: edit.isActive };
      if (edit.role !== 'owner') body.role = edit.role;
      if (edit.password) body.password = edit.password;
      if (edit._id) await api.patch(`/api/staff/staff/${edit._id}`, body);
      else await api.post('/api/staff/staff', body);
      fb.ok('Staff saved');
      setEdit(null);
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const openActivity = async (u: any) => {
    try {
      const r = await api.get(`/api/staff/staff/${u._id}/activity`);
      setActivity({ user: u, items: r.items });
    } catch (e) {
      fb.fail(e);
    }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const blank = { name: '', email: '', phone: '', password: '', role: 'waiter', assignedTableIds: [], stationIds: [], permissionOverrides: { grant: [], revoke: [] }, isActive: true };
  const effective = (role: string, o: any, p: string) => (o?.revoke?.includes(p) ? false : o?.grant?.includes(p) ? true : roles.data?.[role]?.includes(p) ?? false);

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="blue" title="Staff & roles" subtitle="Accounts, role permissions, table and station assignments" actions={manage && <Button onClick={() => setEdit({ ...blank })}><Plus className="h-4 w-4" /> Add staff</Button>} />
      <Card pad={false}>
        <DataTable
          rows={data!.items}
          onRowClick={manage ? (u: any) => setEdit({ ...blank, ...u, password: '', permissionOverrides: u.permissionOverrides ?? { grant: [], revoke: [] } }) : undefined}
          columns={[
            { key: 'n', header: 'Name', render: (u: any) => <div><p className="font-medium">{u.name}</p><p className="text-xs text-stone-400">{u.email}</p></div> },
            { key: 'r', header: 'Role', render: (u: any) => <Badge tone={u.role === 'owner' ? 'brand' : 'neutral'}>{u.role.replace('_', ' ')}</Badge> },
            { key: 't', header: 'Assigned', render: (u: any) => <span className="text-xs text-stone-500">{u.assignedTableIds?.length ? `${u.assignedTableIds.length} tables` : ''}{u.stationIds?.length ? ` ${u.stationIds.length} stations` : ''}</span> },
            { key: 'l', header: 'Last login', render: (u: any) => (u.lastLoginAt ? `${timeAgo(u.lastLoginAt)} ago` : 'Never') },
            { key: 's', header: 'Status', render: (u: any) => <Badge tone={u.isActive ? 'good' : 'bad'}>{u.isActive ? 'Active' : 'Deactivated'}</Badge> },
            { key: 'a', header: '', className: 'text-end', render: (u: any) => (can('audit:view', 'staff:manage') ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); openActivity(u); }}><Activity className="h-4 w-4" /> Activity</Button> : null) },
          ]}
        />
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?._id ? `Edit ${edit.name}` : 'Add staff member'} size="xl" footer={<>
        {edit?._id && edit.role !== 'owner' && edit._id !== me?.id && <Button variant="ghost" className="me-auto text-red-600" onClick={async () => { if (await fb.confirm({ title: `Deactivate ${edit.name}?`, body: 'They are signed out immediately and cannot log in.', danger: true, confirmLabel: 'Deactivate' })) { try { await api.del(`/api/staff/staff/${edit._id}`); setEdit(null); reload(); fb.ok('Deactivated'); } catch (e) { fb.fail(e); } } }}>Deactivate</Button>}
        <Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save} loading={busy}>Save</Button></>}>
        {edit && (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4">
              <Field label="Full name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Email (login)"><Input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
              <Field label="Phone"><Input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
              <Field label={edit._id ? 'New password (leave blank to keep)' : 'Password'} hint="At least 10 characters"><Input type="text" autoComplete="new-password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
              {edit.role !== 'owner' && (
                <Field label="Role">
                  <div className="grid gap-2">
                    {ROLES.map((r) => (
                      <label key={r.v} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2', edit.role === r.v ? 'border-brand bg-brand/5' : 'border-stone-200')}>
                        <input type="radio" className="mt-1" checked={edit.role === r.v} onChange={() => setEdit({ ...edit, role: r.v })} />
                        <span><span className="text-sm font-medium capitalize">{r.v.replace('_', ' ')}</span><span className="block text-xs text-stone-500">{r.d}</span></span>
                      </label>
                    ))}
                  </div>
                </Field>
              )}
              <Toggle checked={edit.isActive} onChange={(isActive) => setEdit({ ...edit, isActive })} label="Active" />
            </div>
            <div className="space-y-5">
              {edit.role === 'waiter' && (
                <Field label="Assigned tables">
                  <div className="flex flex-wrap gap-1.5">{tables.data?.items.map((t) => { const on = edit.assignedTableIds.includes(t._id); return <button key={t._id} type="button" onClick={() => setEdit({ ...edit, assignedTableIds: on ? edit.assignedTableIds.filter((x: string) => x !== t._id) : [...edit.assignedTableIds, t._id] })} className={cn('rounded-lg border px-2.5 py-1 text-xs', on ? 'border-brand bg-brand text-brand-ink' : 'border-stone-200')}>{t.label}</button>; })}</div>
                </Field>
              )}
              {edit.role === 'kitchen' && (
                <Field label="Kitchen stations" hint="Leave empty to see all stations">
                  <div className="flex flex-wrap gap-1.5">{stations.data?.items.map((s) => { const on = edit.stationIds.includes(s._id); return <button key={s._id} type="button" onClick={() => setEdit({ ...edit, stationIds: on ? edit.stationIds.filter((x: string) => x !== s._id) : [...edit.stationIds, s._id] })} className={cn('rounded-lg border px-2.5 py-1 text-xs', on ? 'border-brand bg-brand text-brand-ink' : 'border-stone-200')}>{s.name}</button>; })}</div>
                </Field>
              )}
              {edit.role !== 'owner' && roles.data && (
                <div>
                  <span className="label">Permissions (click to override the role default)</span>
                  <ul className="grid gap-1 sm:grid-cols-2">
                    {PERMS.map((p) => {
                      const o = edit.permissionOverrides;
                      const on = effective(edit.role, o, p);
                      const overridden = o.grant.includes(p) || o.revoke.includes(p);
                      return (
                        <li key={p}>
                          <button type="button" onClick={() => {
                            const grant = o.grant.filter((x: string) => x !== p);
                            const revoke = o.revoke.filter((x: string) => x !== p);
                            const def = roles.data![edit.role]?.includes(p);
                            if (!overridden) (def ? revoke : grant).push(p);
                            setEdit({ ...edit, permissionOverrides: { grant, revoke } });
                          }} className={cn('flex w-full items-center justify-between rounded-md px-2 py-1 text-xs', overridden && 'bg-amber-50')}>
                            <span>{p}</span>
                            <span className={on ? 'text-emerald-600' : 'text-stone-300'}>{on ? '✓' : '—'}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Drawer open={!!activity} onClose={() => setActivity(null)} title={`Activity · ${activity?.user?.name}`}>
        {activity?.items?.length ? (
          <ol className="space-y-3">
            {activity.items.map((a: any) => (
              <li key={a._id} className="text-sm"><Badge tone="info">{a.action}</Badge> <span className="ms-1 text-xs text-stone-400">{new Date(a.createdAt).toLocaleString()}</span>{a.entityId && <span className="ms-1 text-xs text-stone-400">· {a.entity} …{a.entityId.slice(-6)}</span>}</li>
            ))}
          </ol>
        ) : <p className="text-sm text-stone-500">No recorded activity yet.</p>}
      </Drawer>
    </>
  );
}

