/** Role-based permissions. Super admin is a platform role and never belongs to a tenant. */

export const TENANT_ROLES = ['owner', 'admin', 'manager', 'waiter', 'cashier', 'kitchen', 'inventory_manager', 'rider'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];
export type Role = TenantRole | 'superadmin';

export const PERMISSIONS = [
  'settings:manage', 'branding:manage', 'staff:manage', 'staff:view',
  'menu:manage', 'menu:view', 'tables:manage', 'tables:view',
  'orders:view', 'orders:manage', 'orders:accept', 'orders:deliver',
  'kitchen:operate', 'payments:collect', 'payments:refund', 'payments:configure',
  'analytics:view', 'inventory:manage', 'inventory:view', 'reservations:manage',
  'customers:manage', 'feedback:view', 'coupons:manage', 'audit:view', 'notifications:view',
  // POS & service operations
  'orders:create', // take orders at the POS / table
  'orders:modify', // add, remove or change items before preparation
  'orders:discount', // manual item- and order-level discounts (bounded by settings.maxManualDiscountPercent)
  'orders:transfer', // move orders between tables, merge tables
  'shifts:operate', // open/close own cash shift, cash in/out
  'shifts:manage', // see and close every cashier's shift
  // Intelligence, marketing, delivery
  'intelligence:view', // business intelligence, forecasts, recommendations, AI assistant
  'marketing:manage', // segments, campaigns, automations (drafts, previews, test sends)
  'marketing:approve', // approve and launch campaigns / automations
  'delivery:dispatch', // dispatcher screen: assign, reassign, mark failed
  'delivery:manage', // zones, riders, delivery settings
  'delivery:ride', // rider: own assigned deliveries only
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// The owner and admins hold everything except the rider's own-delivery permission (riders are separate accounts).
const ALL = PERMISSIONS.filter((p) => p !== 'delivery:ride') as Permission[];

export const ROLE_PERMISSIONS: Record<TenantRole, Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== 'payments:configure'),
  manager: [
    'staff:view', 'menu:manage', 'menu:view', 'tables:manage', 'tables:view', 'orders:view', 'orders:manage',
    'orders:accept', 'orders:deliver', 'kitchen:operate', 'payments:collect', 'payments:refund', 'analytics:view',
    'inventory:view', 'reservations:manage', 'customers:manage', 'feedback:view', 'coupons:manage',
    'notifications:view', 'orders:create', 'orders:modify', 'orders:discount', 'orders:transfer', 'shifts:operate', 'shifts:manage',
    'intelligence:view', 'marketing:manage', 'delivery:dispatch', 'delivery:manage',
  ],
  waiter: ['menu:view', 'tables:view', 'orders:view', 'orders:accept', 'orders:deliver', 'reservations:manage', 'notifications:view', 'orders:create', 'orders:modify', 'orders:transfer'],
  cashier: ['menu:view', 'tables:view', 'orders:view', 'payments:collect', 'customers:manage', 'notifications:view', 'orders:create', 'orders:modify', 'shifts:operate'],
  kitchen: ['menu:view', 'orders:view', 'kitchen:operate', 'notifications:view'],
  inventory_manager: ['menu:view', 'inventory:manage', 'inventory:view', 'notifications:view'],
  rider: ['delivery:ride', 'notifications:view'],
};

export function roleHas(role: Role, perm: Permission, overrides?: { grant?: string[]; revoke?: string[] }): boolean {
  if (role === 'superadmin') return false; // super admins use platform routes, not tenant routes
  if (overrides?.revoke?.includes(perm)) return false;
  if (overrides?.grant?.includes(perm)) return true;
  return ROLE_PERMISSIONS[role].includes(perm);
}

/** Subscription feature flags checked per tenant. */
export const FEATURES = ['qr_ordering', 'kds', 'inventory', 'reservations', 'online_payments', 'loyalty', 'analytics_export', 'multi_language'] as const;
export type Feature = (typeof FEATURES)[number];
