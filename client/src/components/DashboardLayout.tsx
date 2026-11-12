import { useEffect, useState, type ReactNode } from 'react';
import { OfflineBanner, OfflineIndicator } from './SyncCenter';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Bell, KeyRound, LogOut, Menu as MenuIcon, X, ExternalLink, type LucideIcon } from 'lucide-react';
import { useAuth } from '../store/auth';
import { api } from '../api/client';
import { useSocket, beep } from '../hooks/useSocket';
import { Button, useFeedback } from './ui';
import { ChangePasswordModal } from './ChangePasswordModal';
import { cn, timeAgo, tenantUrl } from '../lib/util';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  perm?: string[];
  feature?: string;
  end?: boolean;
}

export function DashboardLayout({ nav, brand, platform = false }: { nav: { group?: string; items: NavItem[] }[]; brand: ReactNode; platform?: boolean }) {
  const { user, tenant, can, hasFeature, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [loc.pathname]);

  const visible = nav
    .map((g) => ({ ...g, items: g.items.filter((i) => (platform || !i.perm || can(...i.perm)) && (!i.feature || hasFeature(i.feature))) }))
    .filter((g) => g.items.length);

  const sub = tenant?.subscription;
  const banner =
    !platform && sub && ['expired', 'past_due', 'suspended'].includes(sub.status)
      ? sub.status === 'past_due'
        ? 'Your subscription payment is overdue. Please renew to avoid interruption.'
        : 'Your subscription is inactive — the dashboard is read-only and your storefront is offline. Contact the platform to renew.'
      : !platform && sub?.status === 'trial' && sub.trialEndsAt
        ? `Free trial — ends ${new Date(sub.trialEndsAt).toLocaleDateString()}`
        : null;

  // Current section title for the top bar (longest matching nav path wins).
  const current = visible
    .flatMap((g) => g.items)
    .filter((i) => (i.end ? loc.pathname === i.to : loc.pathname === i.to || loc.pathname.startsWith(`${i.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0];

  const Sidebar = (
    <nav className="flex h-full flex-col bg-ink-950 bg-[radial-gradient(120%_60%_at_0%_0%,rgb(var(--brand)/0.14),transparent_60%)]" aria-label="Main navigation">
      <div className="flex h-[72px] items-center gap-3 border-b border-white/[0.06] px-6">{brand}</div>
      <div className="scrollbar-thin flex-1 overflow-y-auto px-4 py-5">
        {visible.map((g, gi) => (
          <div key={gi} className={cn(gi > 0 && 'mt-5 border-t border-white/[0.06] pt-5')}>
            {g.group && <p className="eyebrow mb-2 px-3 text-[11px] text-stone-500">{g.group}</p>}
            <ul className="space-y-1">
              {g.items.map((i) => (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    end={i.end}
                    className={({ isActive }) =>
                      cn(
                        'focus-ring group relative flex min-h-[44px] items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition duration-150 focus-visible:ring-offset-ink-950',
                        isActive ? 'bg-brand/[0.16] font-medium text-white ring-1 ring-inset ring-brand/25' : 'text-stone-400 hover:bg-white/[0.05] hover:text-stone-100',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className={cn('absolute inset-y-2 start-0 w-[3px] rounded-full bg-brand transition-opacity', isActive ? 'opacity-100' : 'opacity-0')} aria-hidden />
                        <i.icon className={cn('h-5 w-5 shrink-0 transition-colors', isActive ? 'text-brand' : 'text-stone-500 group-hover:text-stone-300')} />
                        <span className="truncate">{i.label}</span>
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-white/[0.06] p-4">
        <div className="flex items-center gap-3 rounded-2xl bg-white/[0.04] px-3 py-3 ring-1 ring-inset ring-white/[0.05]">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand/70 text-sm font-semibold text-brand-ink ring-2 ring-white/10">{user?.name?.slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{user?.name}</p>
            <p className="truncate text-xs capitalize text-stone-400">{user?.role.replace('_', ' ')}</p>
          </div>
          <button onClick={() => setPwOpen(true)} className="focus-ring rounded-lg p-2 text-stone-400 transition hover:bg-white/10 hover:text-white focus-visible:ring-offset-ink-950" aria-label="Change password" title="Change password">
            <KeyRound className="h-4 w-4" />
          </button>
          <button onClick={() => logout()} className="focus-ring rounded-lg p-2 text-stone-400 transition hover:bg-white/10 hover:text-white focus-visible:ring-offset-ink-950" aria-label="Sign out" title="Sign out">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:ps-[280px]">
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-[280px] lg:block">{Sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-ink-950/50 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 start-0 w-[296px] max-w-[86vw] animate-fade-up shadow-float">{Sidebar}</aside>
        </div>
      )}
      <header className="no-print sticky top-0 z-20 flex h-[72px] items-center gap-3 border-b border-stone-200/60 bg-stone-50/85 px-4 backdrop-blur-xl sm:px-6 lg:px-10">
        <Button variant="ghost" size="icon" className="-ms-1 lg:hidden" onClick={() => setOpen((v) => !v)} aria-label="Open navigation" aria-expanded={open}>
          {open ? <X className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
        </Button>
        <div className="min-w-0 flex-1">
          <p className="eyebrow truncate text-[11px] text-stone-400">{platform ? 'Platform console' : tenant?.name}</p>
          <p className="truncate text-base font-semibold text-stone-900">{current?.label ?? (platform ? 'Overview' : 'Dashboard')}</p>
        </div>
        {!platform && tenant && (
          <a href={tenantUrl(tenant.slug)} target="_blank" rel="noreferrer" className="focus-ring hidden items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3.5 py-1.5 text-sm font-medium text-stone-700 shadow-[0_1px_1px_rgb(28_25_23/0.04)] transition hover:border-stone-300 hover:text-stone-900 sm:flex">
            View storefront <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        {!platform && <OfflineIndicator />}
        {!platform && <Notifications />}
      </header>
      {!platform && <OfflineBanner />}
      {banner && (
        <div className={cn('flex items-center justify-center gap-2 px-6 py-2 text-center text-sm', sub?.status === 'trial' ? 'bg-sky-50 text-sky-800' : 'bg-amber-50 text-amber-900')} role="status">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', sub?.status === 'trial' ? 'bg-sky-500' : 'bg-amber-500')} aria-hidden />
          {banner}
        </div>
      )}
      <main className="mx-auto max-w-[1520px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10">
        {/* Keyed by path: each page enters with a short fade so navigation feels continuous. */}
        <div key={loc.pathname} className="animate-fade-up">
          <Outlet />
        </div>
      </main>
      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

function Notifications() {
  const [items, setItems] = useState<any[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const fb = useFeedback();
  const load = () =>
    api
      .get('/api/staff/notifications')
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
      })
      .catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  useSocket({
    notification: (n) => {
      setItems((p) => [{ ...n, read: false }, ...p].slice(0, 50));
      setUnread((u) => u + 1);
      if (n.type === 'order.new') beep();
      fb.info(n.title);
    },
    reconnect: () => load(),
  });
  const markAll = async () => {
    await api.post('/api/staff/notifications/read', {});
    setItems((p) => p.map((x) => ({ ...x, read: true })));
    setUnread(0);
  };
  return (
    <div className="relative">
      <Button variant="ghost" size="icon" onClick={() => setOpen((v) => !v)} aria-label={`Notifications (${unread} unread)`}>
        <Bell className="h-5 w-5" />
        {unread > 0 && <span className="absolute end-1 top-1 flex h-4 min-w-4 animate-pop items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-brand-ink ring-2 ring-stone-50">{unread > 9 ? '9+' : unread}</span>}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute end-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] animate-scale-in overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-float">
            <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
              <p className="text-sm font-semibold">Notifications</p>
              {unread > 0 && (
                <button className="text-xs font-medium text-brand hover:underline" onClick={markAll}>
                  Mark all read
                </button>
              )}
            </div>
            <ul className="max-h-96 divide-y divide-stone-100 overflow-y-auto">
              {items.length === 0 && <li className="px-4 py-8 text-center text-sm text-stone-400">You're all caught up</li>}
              {items.map((n) => (
                <li key={n._id}>
                  <button
                    className={cn('w-full px-4 py-3 text-start hover:bg-stone-50', !n.read && 'bg-brand/5')}
                    onClick={() => {
                      setOpen(false);
                      if (n.link) nav(n.link);
                    }}
                  >
                    <p className="text-sm font-medium text-stone-800">{n.title}</p>
                    {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-stone-500">{n.body}</p>}
                    <p className="mt-1 text-[11px] text-stone-400">{timeAgo(n.createdAt)} ago</p>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
