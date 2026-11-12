import { lazy, Suspense, type ReactNode } from 'react';
import { OfflineProvider } from './offline/OfflineProvider';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Building2, CreditCard, ScrollText, ClipboardList, UtensilsCrossed, QrCode, Palette, Settings, Users, Boxes, CalendarClock,
  Contact, MessageSquareHeart, TicketPercent, BarChart3, ChefHat, Wallet, ShieldCheck, ConciergeBell, MonitorSmartphone, Banknote, Sparkles, Megaphone, Bike,
} from 'lucide-react';
import { AuthProvider, useAuth } from './store/auth';
import { FeedbackProvider, Loading } from './components/ui';
import { DashboardLayout, type NavItem } from './components/DashboardLayout';
import { currentTenantSlug, isCustomDomainHost } from './lib/util';
import { assetUrl } from './api/client';
import LoginPage from './pages/auth/Login';

const AdminOverview = lazy(() => import('./pages/admin/Overview'));
const AdminTenants = lazy(() => import('./pages/admin/Tenants'));
const AdminTenantDetail = lazy(() => import('./pages/admin/TenantDetail'));
const AdminPlans = lazy(() => import('./pages/admin/Plans'));
const AdminAudit = lazy(() => import('./pages/admin/Audit'));

const OwnerDashboard = lazy(() => import('./pages/owner/Dashboard'));
const Orders = lazy(() => import('./pages/owner/Orders'));
const MenuPage = lazy(() => import('./pages/owner/Menu'));
const TablesPage = lazy(() => import('./pages/owner/Tables'));
const Branding = lazy(() => import('./pages/owner/Branding'));
const SettingsPage = lazy(() => import('./pages/owner/Settings'));
const Staff = lazy(() => import('./pages/owner/Staff'));
const Inventory = lazy(() => import('./pages/owner/Inventory'));
const Business = lazy(() => import('./pages/owner/Business'));
const Analytics = lazy(() => import('./pages/owner/Analytics'));
const Payments = lazy(() => import('./pages/owner/Payments'));
const Kitchen = lazy(() => import('./pages/staff/Kitchen'));
const Pos = lazy(() => import('./pages/staff/Pos'));
const Shifts = lazy(() => import('./pages/staff/Shifts'));
const Waiter = lazy(() => import('./pages/staff/Waiter'));
const Rider = lazy(() => import('./pages/staff/Rider'));
const Intelligence = lazy(() => import('./pages/owner/Intelligence'));
const Marketing = lazy(() => import('./pages/owner/Marketing'));
const DeliveryPage = lazy(() => import('./pages/owner/Delivery'));

const Storefront = lazy(() => import('./pages/store/Storefront'));

const PLATFORM_NAV: { group?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/admin/tenants', label: 'Restaurants', icon: Building2 },
      { to: '/admin/plans', label: 'Plans', icon: CreditCard },
      { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
    ],
  },
];

const TENANT_NAV: { group?: string; items: NavItem[] }[] = [
  {
    group: 'Operate',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true, perm: ['orders:view'] },
      { to: '/dashboard/orders', label: 'Orders', icon: ClipboardList, perm: ['orders:view'] },
      { to: '/dashboard/pos', label: 'Point of sale', icon: MonitorSmartphone, perm: ['orders:create'] },
      { to: '/dashboard/kitchen', label: 'Kitchen display', icon: ChefHat, perm: ['kitchen:operate'], feature: 'kds' },
      { to: '/dashboard/waiter', label: 'Waiter view', icon: ConciergeBell, perm: ['orders:deliver'] },
      { to: '/dashboard/payments', label: 'Payments', icon: Wallet, perm: ['payments:collect', 'analytics:view'] },
      { to: '/dashboard/delivery', label: 'Delivery', icon: Bike, perm: ['delivery:dispatch', 'delivery:manage'] },
      { to: '/dashboard/rider', label: 'My deliveries', icon: Bike, perm: ['delivery:ride'] },
      { to: '/dashboard/shifts', label: 'Cash shifts', icon: Banknote, perm: ['shifts:operate', 'shifts:manage'] },
      { to: '/dashboard/reservations', label: 'Reservations', icon: CalendarClock, perm: ['reservations:manage'], feature: 'reservations' },
    ],
  },
  {
    group: 'Manage',
    items: [
      { to: '/dashboard/menu', label: 'Menu', icon: UtensilsCrossed, perm: ['menu:manage'] },
      { to: '/dashboard/tables', label: 'Tables & QR', icon: QrCode, perm: ['tables:view'] },
      { to: '/dashboard/inventory', label: 'Inventory', icon: Boxes, perm: ['inventory:view'], feature: 'inventory' },
      { to: '/dashboard/customers', label: 'Customers', icon: Contact, perm: ['customers:manage'] },
      { to: '/dashboard/feedback', label: 'Feedback', icon: MessageSquareHeart, perm: ['feedback:view'] },
      { to: '/dashboard/coupons', label: 'Coupons', icon: TicketPercent, perm: ['coupons:manage'] },
      { to: '/dashboard/analytics', label: 'Analytics', icon: BarChart3, perm: ['analytics:view'] },
      { to: '/dashboard/intelligence', label: 'Intelligence', icon: Sparkles, perm: ['intelligence:view'] },
      { to: '/dashboard/marketing', label: 'Marketing', icon: Megaphone, perm: ['marketing:manage'] },
    ],
  },
  {
    group: 'Business',
    items: [
      { to: '/dashboard/staff', label: 'Staff & roles', icon: Users, perm: ['staff:view', 'staff:manage'] },
      { to: '/dashboard/branding', label: 'Branding', icon: Palette, perm: ['branding:manage'] },
      { to: '/dashboard/settings', label: 'Settings', icon: Settings, perm: ['settings:manage', 'payments:configure'] },
      { to: '/dashboard/audit', label: 'Audit log', icon: ShieldCheck, perm: ['audit:view'] },
    ],
  },
];

/** Picks the first page a staff role can open (e.g. kitchen staff land on the KDS). */
function homeFor(role: string) {
  return { kitchen: '/dashboard/kitchen', waiter: '/dashboard/waiter', inventory_manager: '/dashboard/inventory', cashier: '/dashboard/pos', rider: '/dashboard/rider' }[role] ?? '/dashboard';
}

function RequireAuth({ children, superadmin = false }: { children: ReactNode; superadmin?: boolean }) {
  const { ready, user } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading label="Checking session…" />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (superadmin !== (user.role === 'superadmin')) return <Navigate to={user.role === 'superadmin' ? '/admin' : homeFor(user.role)} replace />;
  return <>{children}</>;
}

function TenantHome() {
  const { user } = useAuth();
  return <Navigate to={homeFor(user?.role ?? '')} replace />;
}

export default function App() {
  const slug = currentTenantSlug();
  if (!slug && isCustomDomainHost()) {
    // A tenant's own domain: storefront only (the API resolves the tenant from the Host header).
    return (
      <FeedbackProvider>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/*" element={<Storefront slug={window.location.hostname.toLowerCase()} />} />
          </Routes>
        </Suspense>
      </FeedbackProvider>
    );
  }
  return (
    <FeedbackProvider>
      <AuthProvider>
        <Suspense fallback={<Loading />}>
          {slug ? (
            <Routes>
              <Route path="/login" element={<LoginPage tenantSlug={slug} />} />
              <Route
                path="/dashboard"
                element={
                  <RequireAuth>
                    <OfflineProvider>
                      <TenantShell />
                    </OfflineProvider>
                  </RequireAuth>
                }
              >
                <Route index element={<OwnerDashboardGate />} />
                <Route path="orders" element={<Orders />} />
                <Route path="orders/:id" element={<Orders />} />
                <Route path="kitchen" element={<Kitchen />} />
                <Route path="pos" element={<Pos />} />
                <Route path="shifts" element={<Shifts />} />
                <Route path="waiter" element={<Waiter />} />
                <Route path="rider" element={<Rider />} />
                <Route path="delivery" element={<DeliveryPage />} />
                <Route path="intelligence" element={<Intelligence />} />
                <Route path="marketing" element={<Marketing />} />
                <Route path="menu" element={<MenuPage />} />
                <Route path="tables" element={<TablesPage />} />
                <Route path="branding" element={<Branding />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="staff" element={<Staff />} />
                <Route path="inventory" element={<Inventory />} />
                <Route path="payments" element={<Payments />} />
                <Route path="analytics" element={<Analytics />} />
                <Route path="reservations" element={<Business kind="reservations" />} />
                <Route path="customers" element={<Business kind="customers" />} />
                <Route path="feedback" element={<Business kind="feedback" />} />
                <Route path="coupons" element={<Business kind="coupons" />} />
                <Route path="audit" element={<Business kind="audit" />} />
                <Route path="*" element={<TenantHome />} />
              </Route>
              <Route path="/*" element={<Storefront slug={slug} />} />
            </Routes>
          ) : (
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/admin"
                element={
                  <RequireAuth superadmin>
                    <DashboardLayout nav={PLATFORM_NAV} platform brand={<PlatformBrand />} />
                  </RequireAuth>
                }
              >
                <Route index element={<AdminOverview />} />
                <Route path="tenants" element={<AdminTenants />} />
                <Route path="tenants/:id" element={<AdminTenantDetail />} />
                <Route path="plans" element={<AdminPlans />} />
                <Route path="audit" element={<AdminAudit />} />
              </Route>
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Routes>
          )}
        </Suspense>
      </AuthProvider>
    </FeedbackProvider>
  );
}

function OwnerDashboardGate() {
  const { can, user } = useAuth();
  if (!can('orders:view') || ['kitchen', 'inventory_manager'].includes(user?.role ?? '')) return <TenantHome />;
  return <OwnerDashboard />;
}

function TenantShell() {
  const { tenant } = useAuth();
  return (
    <DashboardLayout
      nav={TENANT_NAV}
      brand={
        <>
          {tenant?.branding?.logoUrl ? (
            <img src={assetUrl(tenant.branding.logoUrl)} alt="" className="h-8 w-8 rounded-lg bg-white object-contain" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand font-display text-sm font-bold text-brand-ink">{tenant?.name?.[0]}</div>
          )}
          <div className="min-w-0">
            <p className="truncate font-display text-[15px] font-semibold text-white">{tenant?.name}</p>
            <p className="truncate text-[11px] text-stone-400">{tenant?.slug}</p>
          </div>
        </>
      }
    />
  );
}

function PlatformBrand() {
  return (
    <>
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-orange-600 font-display text-sm font-bold text-white">T</div>
      <div>
        <p className="font-display text-[15px] font-semibold text-white">TableSaaS</p>
        <p className="text-[11px] text-stone-400">Platform console</p>
      </div>
    </>
  );
}
