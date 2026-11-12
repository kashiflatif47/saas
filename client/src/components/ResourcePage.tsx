import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Plus, Search, Pencil, Trash2 } from 'lucide-react';
import { api, qs } from '../api/client';
import { useApi } from '../hooks/useApi';
import { Button, Card, DataTable, ErrorState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, Textarea, Toggle, useFeedback, Empty, type Column } from './ui';
import { toLocalInputValue, toMajor, toMinor } from '../lib/util';
import { useAuth } from '../store/auth';

export type FieldDef = {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'number' | 'money' | 'textarea' | 'select' | 'toggle' | 'datetime' | 'date' | 'tags' | 'color';
  options?: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
  placeholder?: string;
  colSpan?: 2;
  showIf?: (v: Record<string, any>) => boolean;
};

interface Props<T> {
  title: string;
  subtitle?: string;
  endpoint: string; // e.g. /api/staff/customers
  columns: Column<T>[];
  fields: FieldDef[];
  canEdit?: boolean;
  filters?: { name: string; options: { value: string; label: string }[] }[];
  deleteLabel?: string;
  emptyHint?: string;
  extraActions?: (row: T, reload: () => void) => ReactNode;
  defaults?: Record<string, any>;
}

/** Generic list + create/edit/delete page wired to a tenant-scoped CRUD endpoint. */
export function ResourcePage<T extends { _id: string }>({ title, subtitle, endpoint, columns, fields, canEdit = true, filters = [], deleteLabel = 'Delete', emptyHint, extraActions, defaults = {} }: Props<T>) {
  const fb = useFeedback();
  const { tenant } = useAuth();
  const dec = tenant?.settings?.currencyDecimals ?? 2;
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filterVals, setFilterVals] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data, loading, error, reload } = useApi<{ items: T[]; total: number; limit: number }>(`${endpoint}${qs({ page, q: debounced, ...filterVals })}`);

  const toForm = (row?: any) => {
    const v: Record<string, any> = { ...defaults };
    for (const f of fields) {
      if (f.showIf && !f.showIf({ ...defaults, ...(row ?? {}) })) continue;
      const raw = row?.[f.name];
      if (f.type === 'money') v[f.name] = raw != null ? toMajor(raw, dec) : '';
      else if (f.type === 'datetime') v[f.name] = toLocalInputValue(raw); // local time, as the input is parsed back
      else if (f.type === 'date') v[f.name] = raw ? new Date(raw).toISOString().slice(0, 10) : ''; // date-only values round-trip as UTC midnight
      else if (f.type === 'tags') v[f.name] = (raw ?? []).join(', ');
      else if (f.type === 'toggle') v[f.name] = raw ?? defaults[f.name] ?? true;
      else v[f.name] = raw ?? defaults[f.name] ?? '';
    }
    if (row?._id) v._id = row._id;
    return v;
  };

  const toPayload = (v: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const f of fields) {
      if (f.showIf && !f.showIf(v)) continue;
      const x = v[f.name];
      if (f.type === 'money') out[f.name] = x === '' ? null : toMinor(x, dec);
      else if (f.type === 'number') out[f.name] = x === '' || x == null ? undefined : Number(x);
      else if (f.type === 'datetime' || f.type === 'date') out[f.name] = x ? new Date(x).toISOString() : null;
      else if (f.type === 'tags') out[f.name] = String(x).split(',').map((s) => s.trim()).filter(Boolean);
      else if (f.type === 'toggle') out[f.name] = !!x;
      else if (x !== '' || !f.required) out[f.name] = x === '' ? undefined : x;
    }
    return out;
  };

  const save = async () => {
    if (!editing) return;
    for (const f of fields) if (f.required && (editing[f.name] === '' || editing[f.name] == null) && (!f.showIf || f.showIf(editing))) return fb.fail(`${f.label} is required`);
    setSaving(true);
    try {
      const body = toPayload(editing);
      if (editing._id) await api.patch(`${endpoint}/${editing._id}`, body);
      else await api.post(endpoint, body);
      fb.ok(editing._id ? 'Saved' : 'Created');
      setEditing(null);
      reload();
    } catch (e) {
      fb.fail(e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: T) => {
    if (!(await fb.confirm({ title: `${deleteLabel}?`, body: 'This action is recorded in the audit log.', danger: true, confirmLabel: deleteLabel }))) return;
    try {
      await api.del(`${endpoint}/${row._id}`);
      fb.ok('Done');
      reload();
    } catch (e) {
      fb.fail(e);
    }
  };

  const allColumns = useMemo<Column<T>[]>(
    () => [
      ...columns,
      ...(canEdit || extraActions
        ? [
            {
              key: '_actions',
              header: '',
              className: 'w-px whitespace-nowrap text-end',
              render: (r: T) => (
                <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                  {extraActions?.(r, reload)}
                  {canEdit && (
                    <>
                      <Button variant="ghost" size="icon" onClick={() => setEditing(toForm(r))} aria-label="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => remove(r)} aria-label={deleteLabel}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </>
                  )}
                </div>
              ),
            },
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, canEdit, extraActions, reload],
  );

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          canEdit && (
            <Button onClick={() => setEditing(toForm())}>
              <Plus className="h-4 w-4" /> New
            </Button>
          )
        }
      />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-stone-100 p-4">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="ps-9" aria-label="Search" />
          </div>
          {filters.map((f) => (
            <Select key={f.name} value={filterVals[f.name] ?? ''} onChange={(e) => { setFilterVals((p) => ({ ...p, [f.name]: e.target.value })); setPage(1); }} className="w-auto" aria-label={f.name}>
              <option value="">All {f.name}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ))}
        </div>
        {loading && !data ? (
          <Loading />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : (
          <>
            <DataTable rows={data?.items ?? []} columns={allColumns} onRowClick={canEdit ? (r) => setEditing(toForm(r)) : undefined} empty={<Empty title={`No ${title.toLowerCase()} yet`} hint={emptyHint} />} />
            <Pagination page={page} limit={data?.limit ?? 25} total={data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?._id ? `Edit ${title.replace(/s$/, '').toLowerCase()}` : `New ${title.replace(/s$/, '').toLowerCase()}`}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              Save
            </Button>
          </>
        }
      >
        {editing && (
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
            {fields.filter((f) => !f.showIf || f.showIf(editing)).map((f) => (
              <Field key={f.name} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.hint} className={f.colSpan === 2 || f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                <FieldInput f={f} value={editing[f.name]} onChange={(v) => setEditing((p) => ({ ...p!, [f.name]: v }))} />
              </Field>
            ))}
            <button type="submit" className="hidden" />
          </form>
        )}
      </Modal>
    </>
  );
}

function FieldInput({ f, value, onChange }: { f: FieldDef; value: any; onChange: (v: any) => void }) {
  switch (f.type) {
    case 'textarea':
      return <Textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} />;
    case 'select':
      return (
        <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    case 'toggle':
      return <Toggle checked={!!value} onChange={onChange} label={value ? 'Yes' : 'No'} />;
    case 'money':
    case 'number':
      return <Input type="number" step={f.type === 'money' ? '0.01' : 'any'} min={0} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} />;
    case 'datetime':
      return <Input type="datetime-local" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <Input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'color':
      return <Input type="color" value={value || '#B4532A'} onChange={(e) => onChange(e.target.value)} className="h-10 p-1" />;
    default:
      return <Input type={f.type === 'email' ? 'email' : 'text'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} />;
  }
}
