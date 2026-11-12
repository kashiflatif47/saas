import { useState } from 'react';
import { qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { Card, DataTable, ErrorState, Input, Loading, PageHeader, Pagination, Badge } from '../../components/ui';
import { ScrollText as HeaderIcon } from 'lucide-react';

/** Shared audit table for platform (all tenants) and tenant scope. */
export function AuditView({ endpoint, title, showTenant }: { endpoint: string; title: string; showTenant?: boolean }) {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const { data, loading, error, reload } = useApi<any>(`${endpoint}${qs({ page, action })}`);
  return (
    <>
      <PageHeader icon={HeaderIcon} accent="neutral" title={title} subtitle="Every sensitive action, who performed it and when" />
      <Card pad={false}>
        <div className="border-b border-stone-100 p-4">
          <Input placeholder="Filter by action prefix, e.g. order. or tenant.suspend" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} className="max-w-sm" />
        </div>
        {loading && !data ? <Loading /> : error ? <ErrorState message={error} onRetry={reload} /> : (
          <>
            <DataTable
              rows={data.items}
              columns={[
                { key: 'at', header: 'When', render: (r: any) => <span className="whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</span> },
                { key: 'actor', header: 'Who', render: (r: any) => <div><p className="font-medium">{r.actorName ?? 'system'}</p><p className="text-xs capitalize text-stone-400">{r.actorRole?.replace('_', ' ')}</p></div> },
                { key: 'action', header: 'Action', render: (r: any) => <Badge tone="info">{r.action}</Badge> },
                { key: 'entity', header: 'Record', render: (r: any) => <span className="text-xs text-stone-500">{r.entity} {r.entityId?.slice(-6)}</span> },
                ...(showTenant ? [{ key: 't', header: 'Tenant', render: (r: any) => <span className="text-xs text-stone-500">{r.tenantId ? String(r.tenantId).slice(-6) : 'platform'}</span> }] : []),
                { key: 'ip', header: 'IP', render: (r: any) => <span className="text-xs text-stone-400">{r.ip}</span> },
              ]}
            />
            <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

export default function AdminAudit() {
  return <AuditView endpoint="/api/platform/audit" title="Platform audit log" showTenant />;
}
