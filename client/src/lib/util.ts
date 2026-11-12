import { clsx, type ClassValue } from 'clsx';

export const cn = (...v: ClassValue[]) => clsx(v);

export const ROOT_DOMAIN = (import.meta.env.VITE_ROOT_DOMAIN as string | undefined) || 'localhost';
// Must match server/src/lib/subdomain.ts RESERVED_SLUGS.
const RESERVED = new Set([
  'www', 'api', 'admin', 'app', 'static', 'cdn', 'assets', 'mail', 'smtp', 'ftp',
  'dashboard', 'superadmin', 'status', 'docs', 'help', 'support', 'billing', 'ws', 'socket',
]);

/** Returns the tenant slug for the current hostname, or null for the platform (root/admin) site. */
export function currentTenantSlug(hostname = window.location.hostname): string | null {
  const host = hostname.toLowerCase();
  const root = ROOT_DOMAIN.toLowerCase();
  if (host === root || !host.endsWith(`.${root}`)) return null;
  const sub = host.slice(0, -(root.length + 1));
  if (!sub || sub.includes('.') || RESERVED.has(sub)) return null;
  return sub;
}

/**
 * True when the page is served from a tenant's own custom domain (e.g. menu.restaurant.com):
 * any host that is neither the platform root nor one of its subdomains, nor a local address.
 * Custom domains serve the customer storefront only; staff sign in on <slug>.ROOT_DOMAIN.
 */
export function isCustomDomainHost(hostname = window.location.hostname): boolean {
  const host = hostname.toLowerCase();
  const root = ROOT_DOMAIN.toLowerCase();
  if (host === root || host.endsWith(`.${root}`)) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return true;
}

export function tenantUrl(slug: string, path = '/') {
  const { protocol, port } = window.location;
  return `${protocol}//${slug}.${ROOT_DOMAIN}${port ? `:${port}` : ''}${path}`;
}

export function platformUrl(path = '/') {
  const { protocol, port } = window.location;
  return `${protocol}//${ROOT_DOMAIN}${port ? `:${port}` : ''}${path}`;
}

/** Money is stored in minor units. */
export function formatMoney(minor: number | undefined | null, currency = 'PKR', decimals = 2, locale = 'en') {
  const v = (minor ?? 0) / 10 ** decimals;
  try {
    return new Intl.NumberFormat(locale === 'en' ? 'en-PK' : locale, { style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v);
  } catch {
    return `${currency} ${v.toFixed(decimals)}`;
  }
}

export const toMinor = (major: string | number, decimals = 2) => Math.round(Number(major || 0) * 10 ** decimals);
export const toMajor = (minor: number | undefined | null, decimals = 2) => ((minor ?? 0) / 10 ** decimals).toFixed(decimals);

export function hexToRgbTriplet(hex: string): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** Picks black or white text for a background for WCAG-friendly contrast. */
export function inkFor(hex: string): string {
  const [r, g, b] = hexToRgbTriplet(hex).split(' ').map((x) => Number(x) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.45 ? '28 25 23' : '255 255 255';
}

/** WCAG relative luminance contrast ratio between two #RRGGBB colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) =>
    hexToRgbTriplet(hex)
      .split(' ')
      .map((x) => Number(x) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * Fonts a restaurant may choose (same whitelist the API validates in tenantAdmin brandingSchema).
 * Values are Google Fonts family specs. Fraunces and Inter are preloaded in index.html.
 */
const FONT_SPECS: Record<string, string> = {
  Fraunces: '',
  Inter: '',
  'Playfair Display': 'Playfair+Display:wght@500;600;700',
  Poppins: 'Poppins:wght@400;500;600;700',
  'DM Serif Display': 'DM+Serif+Display',
  'Cormorant Garamond': 'Cormorant+Garamond:wght@500;600;700',
  'DM Sans': 'DM+Sans:wght@400;500;600;700',
  Nunito: 'Nunito:wght@400;500;600;700',
  Lato: 'Lato:wght@400;700',
};

/** Loads a whitelisted Google font once. Unknown names are ignored (no arbitrary URLs). */
export function ensureFontLoaded(name?: string) {
  if (!name || typeof document === 'undefined') return;
  const spec = FONT_SPECS[name];
  if (!spec) return;
  const id = `font-${name.replace(/\s+/g, '-').toLowerCase()}`;
  if (document.getElementById(id)) return;
  const link = Object.assign(document.createElement('link'), { id, rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?family=${spec}&display=swap` });
  document.head.appendChild(link);
}

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/**
 * Applies a tenant theme as CSS variables. Only the variables change, never the layout, so every
 * restaurant keeps the same central design. Readability is enforced: if the chosen text colour has
 * too little contrast with the page or card colour, an automatic dark/light ink is used instead
 * (the saved theme itself is not modified).
 */
export function applyTheme(theme: Record<string, any> | undefined, target: HTMLElement = document.documentElement) {
  if (!theme) return;
  const set = (k: string, v?: string) => v && target.style.setProperty(k, v);
  if (isHex(theme.primary)) {
    set('--brand', hexToRgbTriplet(theme.primary));
    set('--brand-ink', inkFor(theme.primary));
  }
  if (isHex(theme.accent)) set('--accent', hexToRgbTriplet(theme.accent));
  const bg = isHex(theme.background) ? theme.background : undefined;
  const surface = isHex(theme.surface) ? theme.surface : undefined;
  if (bg) set('--store-bg', hexToRgbTriplet(bg));
  if (surface) set('--store-surface', hexToRgbTriplet(surface));
  if (isHex(theme.text)) {
    const readable = (!bg || contrastRatio(theme.text, bg) >= 4.5) && (!surface || contrastRatio(theme.text, surface) >= 4.5);
    set('--store-text', readable ? hexToRgbTriplet(theme.text) : inkFor(bg ?? surface ?? '#FFFFFF'));
  }
  if (isHex(theme.secondary)) {
    set('--store-secondary', hexToRgbTriplet(theme.secondary));
    set('--store-secondary-ink', inkFor(theme.secondary));
  }
  if (typeof theme.radius === 'number') set('--radius', `${Math.min(32, Math.max(0, theme.radius))}px`);
  if (theme.fontHeading && theme.fontHeading in FONT_SPECS) {
    ensureFontLoaded(theme.fontHeading);
    set('--font-display', `'${theme.fontHeading}'`);
  }
  if (theme.fontBody && theme.fontBody in FONT_SPECS) {
    ensureFontLoaded(theme.fontBody);
    set('--font-body', `'${theme.fontBody}'`);
  }
}

export function timeAgo(date: string | Date) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const STATUS_LABEL: Record<string, string> = {
  pending: 'New', accepted: 'Accepted', rejected: 'Rejected', preparing: 'Preparing', partially_ready: 'Partly ready',
  ready: 'Ready', delivered: 'Served', completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded',
  unpaid: 'Unpaid', partially_paid: 'Part paid', paid: 'Paid', partially_refunded: 'Part refunded',
  queued: 'Queued', served: 'Served',
};

export const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warn' | 'good' | 'bad' | 'brand'> = {
  pending: 'brand', accepted: 'info', preparing: 'warn', partially_ready: 'warn', ready: 'good', delivered: 'neutral',
  completed: 'neutral', rejected: 'bad', cancelled: 'bad', refunded: 'bad', unpaid: 'warn', partially_paid: 'info',
  paid: 'good', partially_refunded: 'bad', queued: 'neutral', served: 'neutral', verified: 'good', failed: 'bad',
  trial: 'info', active: 'good', past_due: 'warn', expired: 'bad', suspended: 'bad',
};

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Formats a Date for an <input type="datetime-local"> in the browser's LOCAL time zone. */
export function toLocalInputValue(d: string | Date | null | undefined): string {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const ORDER_TYPE_LABEL: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', pickup: 'Pickup', delivery: 'Delivery' };

/** The "delivered" order status means different things per order type. */
export function fulfilmentLabel(type: string) {
  return type === 'delivery' ? 'Dispatched' : type === 'dine_in' ? 'Served' : 'Picked up';
}

/** Order status label that reads correctly for the order type ("Dispatched" for delivery, etc.). */
export function orderStatusLabel(status: string, type?: string) {
  if (status === 'delivered' && type) return fulfilmentLabel(type);
  if (status === 'accepted') return 'Confirmed';
  return STATUS_LABEL[status] ?? status;
}

/** Random key for idempotent POS/payment requests (works on plain-http LAN addresses too). */
export function newRequestKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
