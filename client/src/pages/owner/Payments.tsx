import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { qs } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { useSocket } from '../../hooks/useSocket';
import { useAuth } from '../../store/auth';
import { Badge, Card, DataTable, Empty, ErrorState, Loading, PageHeader, Pagination, Select, StatusBadge, Tabs } from '../../components/ui';
import { formatMoney } from '../../lib/util';
import { Wallet as HeaderIcon } from 'lucide-react';

export default function Payments() {
  const nav = useNavigate();
  const { tenant } = useAuth();
  const money = (n: number) => formatMoney(n, tenant?.settings?.currency, tenant?.settings?.currencyDecimals);
  const [tab, setTab] = useState('due');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const due = useApi<any>(tab === 'due' ? `/api/staff/orders${qs({ paymentStatus: 'unpaid', status: 'accepted,preparing,partially_ready,ready,delivered,completed', limit: 100 })}` : null, [tab]);
  const due2 = useApi<any>(tab === 'due' ? `/api/staff/orders${qs({ paymentStatus: 'partially_paid', limit: 100 })}` : null, [tab]);
  const tx = useApi<any>(tab === 'tx' ? `/api/staff/payments${qs({ page, status, method })}` : null, [tab]);
  useSocket({ 'order:updated': () => { if (tab === 'due') { due.reload(); due2.reload(); } else tx.reload(); } });

  const openOrders = [...(due.data?.items ?? []), ...(due2.data?.items ?? [])].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));

  return (
    <>
      <PageHeader icon={HeaderIcon} accent="emerald" title="Payments" subtitle="Collect balances and review every transaction. Payment status is tracked separately from order status." />
      <div className="mb-4"><Tabs value={tab} onChange={setTab} items={[{ value: 'due', label: 'Awaiting payment', count: openOrders.length }, { value: 'tx', label: 'Transaction history' }]} /></div>
      {tab === 'due' ? (
        <Card pad={false}>
          {due.loading && !due.data ? <Loading /> : due.error ? <ErrorState message={due.error} onRetry={due.reload} /> : (
            <DataTable rows={openOrders} onRowClick={(o: any) => nav(`/dashboard/orders/${o._id}`)} empty={<Empty title="All settled" hint="No orders with an outstanding balance." />} columns={[
              { key: 'n', header: 'Order', render: (o: any) => <span className="font-semibold">#{o.orderNumber}</span> },
              { key: 't', header: 'Table / type', render: (o: any) => o.tableLabel ?? o.type.replace('_', ' ') },
              { key: 's', header: 'Order status', render: (o: any) => <StatusBadge status={o.status} /> },
              { key: 'p', header: 'Payment', render: (o: any) => <StatusBadge status={o.paymentStatus} /> },
              { key: 'tot', header: 'Total', render: (o: any) => money(o.total) },
              { key: 'd', header: 'Balance due', className: 'text-end', render: (o: any) => <span className="font-semibold tabular-nums">{money(o.total - o.amountPaid)}</span> },
            ]} />
          )}
        </Card>
      ) : (
        <Card pad={false}>
          <div className="flex flex-wrap gap-3 border-b border-stone-100 p-4">
            <Select className="w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status"><option value="">All statuses</option><option value="verified">Verified</option><option value="pending">Pending</option><option value="failed">Failed</option></Select>
            <Select className="w-auto" value={method} onChange={(e) => { setMethod(e.target.value); setPage(1); }} aria-label="Method"><option value="">All methods</option><option value="cash">Cash</option><option value="card_terminal">Card terminal</option><option value="online">Online</option></Select>
          </div>
          {tx.loading && !tx.data ? <Loading /> : tx.error ? <ErrorState message={tx.error} onRetry={tx.reload} /> : (
            <>
              <DataTable rows={tx.data.items} onRowClick={(p: any) => p.orderId?._id && nav(`/dashboard/orders/${p.orderId._id}`)} empty={<Empty title="No transactions" />} columns={[
                { key: 'd', header: 'When', render: (p: any) => new Date(p.createdAt).toLocaleString() },
                { key: 'o', header: 'Order', render: (p: any) => (p.orderId ? `#${p.orderId.orderNumber}` : '—') },
                { key: 'k', header: 'Kind', render: (p: any) => <Badge tone={p.kind === 'refund' ? 'bad' : 'neutral'}>{p.kind}</Badge> },
                { key: 'm', header: 'Method', render: (p: any) => p.method.replace('_', ' ') },
                { key: 's', header: 'Status', render: (p: any) => <StatusBadge status={p.status} /> },
                { key: 'v', header: 'Verified by', render: (p: any) => p.verifiedBy?.name ?? (p.provider === 'stripe' && p.status === 'verified' ? 'Stripe webhook' : '—') },
                { key: 'a', header: 'Amount', className: 'text-end', render: (p: any) => <span className={p.kind === 'refund' ? 'tabular-nums text-red-600' : 'tabular-nums'}>{p.kind === 'refund' ? '− ' : ''}{money(p.amount)}</span> },
              ]} />
              <Pagination page={page} limit={tx.data.limit} total={tx.data.total} onPage={setPage} />
            </>
          )}
        </Card>
      )}
    </>
  );
}
