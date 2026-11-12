import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowUpRight, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, X, XCircle, Inbox, type LucideIcon } from 'lucide-react';
import { cn, orderStatusLabel, STATUS_LABEL, STATUS_TONE } from '../lib/util';

/* =============================================================================
 * TableSaaS design system — shared components for the platform console and the
 * restaurant dashboard. Brand colour comes from the --brand CSS variable.
 * ===========================================================================*/

/* ----------------------------- Accent palette ----------------------------- */
/**
 * The only colours used to categorise information: soft tints on white cards, never saturated fills.
 * brand = the restaurant's own colour; blue = information / volume; emerald = money in, success;
 * amber = pending, attention; rose = errors, critical; violet = AI and intelligence.
 */
export const ACCENTS = {
  brand: { tile: 'bg-brand/10 text-brand ring-brand/15', rule: 'from-brand/0 via-brand to-brand/0', text: 'text-brand', bar: 'bg-brand' },
  blue: { tile: 'bg-blue-50 text-blue-600 ring-blue-100', rule: 'from-blue-400/0 via-blue-500 to-blue-400/0', text: 'text-blue-700', bar: 'bg-blue-500' },
  emerald: { tile: 'bg-emerald-50 text-emerald-600 ring-emerald-100', rule: 'from-emerald-400/0 via-emerald-500 to-emerald-400/0', text: 'text-emerald-700', bar: 'bg-emerald-500' },
  amber: { tile: 'bg-amber-50 text-amber-600 ring-amber-100', rule: 'from-amber-400/0 via-amber-500 to-amber-400/0', text: 'text-amber-700', bar: 'bg-amber-500' },
  rose: { tile: 'bg-rose-50 text-rose-600 ring-rose-100', rule: 'from-rose-400/0 via-rose-500 to-rose-400/0', text: 'text-rose-700', bar: 'bg-rose-500' },
  violet: { tile: 'bg-violet-50 text-violet-600 ring-violet-100', rule: 'from-violet-400/0 via-violet-500 to-violet-400/0', text: 'text-violet-700', bar: 'bg-violet-500' },
  neutral: { tile: 'bg-stone-100 text-stone-500 ring-stone-200/70', rule: 'from-stone-300/0 via-stone-400 to-stone-300/0', text: 'text-stone-700', bar: 'bg-stone-400' },
} as const;
export type Accent = keyof typeof ACCENTS;

/** Rounded tinted square holding an icon (dashboards, module cards, page and card headers). */
export function IconTile({ icon: Icon, accent = 'neutral', size = 'md', className }: { icon: LucideIcon; accent?: Accent; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const sz = { sm: 'h-9 w-9 rounded-lg', md: 'h-11 w-11 rounded-xl', lg: 'h-14 w-14 rounded-2xl' }[size];
  const ic = { sm: 'h-[18px] w-[18px]', md: 'h-5 w-5', lg: 'h-6 w-6' }[size];
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center ring-1 ring-inset', ACCENTS[accent].tile, sz, className)} aria-hidden>
      <Icon className={ic} />
    </span>
  );
}

/* ----------------------------- Button ----------------------------- */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-brand-ink shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.12)] hover:brightness-[1.07]',
  secondary: 'bg-ink-900 text-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] hover:bg-ink-800',
  outline: 'border border-stone-200 bg-white text-stone-800 shadow-[0_1px_1px_rgb(28_25_23/0.04)] hover:border-stone-300 hover:bg-stone-50',
  ghost: 'text-stone-600 hover:bg-stone-100 hover:text-stone-900',
  danger: 'bg-red-600 text-white shadow-[0_1px_2px_rgb(0_0_0/0.12)] hover:bg-red-700',
};
const SIZES = { sm: 'h-9 px-3.5 text-[13px] gap-1.5', md: 'h-11 px-4 text-sm gap-2', lg: 'h-12 px-6 text-[15px] gap-2', icon: 'h-10 w-10 justify-center' };

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof SIZES; loading?: boolean }>(
  ({ variant = 'primary', size = 'md', loading, className, children, disabled, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'focus-ring inline-flex shrink-0 items-center rounded-xl font-medium transition duration-150 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

/* ----------------------------- Form fields ----------------------------- */
export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {label && <span className="label">{label}</span>}
      {children}
      {error ? (
        <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-red-600" role="alert">
          <AlertTriangle className="h-3 w-3" aria-hidden /> {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-xs leading-relaxed text-stone-500">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cn('input', className)} {...p} />);
Input.displayName = 'Input';
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => <textarea ref={ref} className={cn('input min-h-[88px] leading-relaxed', className)} {...p} />);
Textarea.displayName = 'Textarea';
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...p }, ref) => (
  <select ref={ref} className={cn('input', className)} {...p}>
    {children}
  </select>
));
Select.displayName = 'Select';

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn('inline-flex cursor-pointer select-none items-center gap-3 text-sm', disabled && 'cursor-not-allowed opacity-60')}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200', checked ? 'bg-brand' : 'bg-stone-300 hover:bg-stone-400/70')}
      >
        <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-all duration-200 ease-out', checked ? 'start-[22px]' : 'start-0.5')} />
      </button>
      {label && <span className="text-stone-700">{label}</span>}
    </label>
  );
}

/* ----------------------------- Display ----------------------------- */
export function Card({ children, className, title, subtitle, icon, accent = 'neutral', actions, pad = true }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; icon?: LucideIcon; accent?: Accent; actions?: ReactNode; pad?: boolean }) {
  return (
    <section className={cn('card', className)}>
      {(title || actions) && (
        <header className="flex min-h-[64px] flex-wrap items-center justify-between gap-3 border-b border-stone-100 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            {icon && <IconTile icon={icon} accent={accent} size="sm" />}
            <div className="min-w-0">
              <h2 className="text-card-title font-semibold tracking-tight text-stone-900">{title}</h2>
              {subtitle && <p className="mt-0.5 text-[13px] text-stone-500">{subtitle}</p>}
            </div>
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={pad ? 'p-card-pad' : ''}>{children}</div>
    </section>
  );
}

/** Large navigation / module card: icon, title, description and an optional live figure. The whole card is the link. */
export function NavCard({ to, icon, title, description, accent = 'brand', meta }: { to: string; icon: LucideIcon; title: string; description?: ReactNode; accent?: Accent; meta?: ReactNode }) {
  return (
    <Link to={to} className="card card-hover focus-ring group flex min-h-[196px] flex-col p-6 text-start">
      <div className="flex items-start justify-between gap-3">
        <IconTile icon={icon} accent={accent} size="lg" />
        <ArrowUpRight className="h-5 w-5 text-stone-300 transition duration-200 group-hover:text-stone-500 rtl:-scale-x-100" aria-hidden />
      </div>
      <h3 className="mt-5 text-base font-semibold text-stone-900">{title}</h3>
      {description && <p className="mt-1.5 text-sm leading-relaxed text-stone-500">{description}</p>}
      {meta != null && <div className={cn('mt-auto pt-4 text-sm font-medium', ACCENTS[accent].text)}>{meta}</div>}
    </Link>
  );
}

/** Heading for a group of content inside a page, with optional description and actions. */
export function SectionHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="section-title">{title}</h2>
        {description && <p className="mt-1 text-sm text-stone-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Groups related form fields under a heading (long forms, modals and drawers). */
export function FormSection({ title, description, children, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('border-t border-stone-100 pt-5 first:border-t-0 first:pt-0', className)}>
      <h3 className="text-sm font-semibold text-stone-900">{title}</h3>
      {description && <p className="mt-0.5 text-[13px] text-stone-500">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

const TONES = {
  neutral: 'bg-stone-100 text-stone-700 ring-stone-200/80',
  info: 'bg-blue-50 text-blue-700 ring-blue-200/80',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200/80',
  good: 'bg-emerald-50 text-emerald-700 ring-emerald-200/80',
  bad: 'bg-red-50 text-red-700 ring-red-200/80',
  brand: 'bg-brand/10 text-brand ring-brand/25',
  ai: 'bg-violet-50 text-violet-700 ring-violet-200/80',
};
const DOTS = { neutral: 'bg-stone-400', info: 'bg-blue-500', warn: 'bg-amber-500', good: 'bg-emerald-500', bad: 'bg-red-500', brand: 'bg-brand', ai: 'bg-violet-500' };
export function Badge({ children, tone = 'neutral', className, dot }: { children: ReactNode; tone?: keyof typeof TONES; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', TONES[tone], className)}>
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', DOTS[tone])} aria-hidden />}
      {children}
    </span>
  );
}
/** Pass the order `type` for order statuses so 'delivered' reads Served / Picked up / Dispatched. */
export const StatusBadge = ({ status, type }: { status: string; type?: string }) => (
  <Badge dot tone={STATUS_TONE[status] ?? 'neutral'}>
    {type ? orderStatusLabel(status, type) : STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}
  </Badge>
);

/** Metric card. `accent` colours the icon tile and a thin top rule; `tone="brand"` is kept for older call sites. */
export function Stat({ label, value, sub, icon, tone, accent }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: 'brand' | 'neutral'; accent?: Accent }) {
  const a: Accent = accent ?? (tone === 'brand' ? 'brand' : 'neutral');
  return (
    <div className="card card-hover relative flex min-h-[148px] flex-col overflow-hidden p-6">
      {a !== 'neutral' && <span className={cn('absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r', ACCENTS[a].rule)} aria-hidden />}
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-stone-500">{label}</p>
        {icon && <span className={cn('inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset [&>svg]:h-5 [&>svg]:w-5', ACCENTS[a].tile)}>{icon}</span>}
      </div>
      <div className="tabular mt-auto pt-3 font-display text-[26px] font-semibold leading-tight tracking-tight text-stone-900 sm:text-metric">{value}</div>
      {sub && <p className="mt-1.5 text-[13px] leading-relaxed text-stone-500">{sub}</p>}
    </div>
  );
}

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn('h-5 w-5 animate-spin text-stone-400', className)} aria-label="Loading" />;

/** Shimmering placeholder block for loading layouts. */
export const Skeleton = ({ className }: { className?: string }) => <div className={cn('skeleton', className)} aria-hidden />;

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="animate-fade-in space-y-4 py-6" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="flex items-center gap-2 text-sm text-stone-500">
        <Spinner className="h-4 w-4" /> {label}
      </div>
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
}

export function Empty({ title, hint, action, icon }: { title: string; hint?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex animate-fade-up flex-col items-center justify-center px-6 py-16 text-center">
      <div className="relative mb-4">
        <div className="absolute inset-0 -z-10 scale-150 rounded-full bg-brand/5 blur-xl" aria-hidden />
        <div className="rounded-2xl border border-stone-200/80 bg-white p-3.5 text-stone-400 shadow-soft">{icon ?? <Inbox className="h-6 w-6" />}</div>
      </div>
      <p className="font-display text-lg font-semibold text-stone-900">{title}</p>
      {hint && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-stone-500">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex animate-fade-up flex-col items-center justify-center gap-3 py-14 text-center" role="alert">
      <div className="rounded-2xl bg-red-50 p-3 text-red-500">
        <XCircle className="h-6 w-6" />
      </div>
      <p className="font-medium text-stone-900">Something went wrong</p>
      <p className="max-w-md text-sm text-stone-500">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow, icon, accent = 'brand' }: { title: string; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode; icon?: LucideIcon; accent?: Accent }) {
  return (
    <div className="mb-8 flex animate-fade-up flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 items-start gap-4">
        {icon && <IconTile icon={icon} accent={accent} size="lg" className="hidden sm:inline-flex" />}
        <div className="min-w-0">
          {eyebrow && <p className={cn('eyebrow mb-1.5', ACCENTS[accent].text)}>{eyebrow}</p>}
          <h1 className="font-display text-[26px] font-semibold leading-tight tracking-tight text-stone-900 sm:text-page-title">{title}</h1>
          {subtitle && <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-stone-500">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="scrollbar-none -mx-1 max-w-full overflow-x-auto px-1">
      <div className="inline-flex gap-0.5 rounded-xl border border-stone-200/70 bg-stone-100/70 p-1" role="tablist">
        {items.map((i) => (
          <button
            key={i.value}
            role="tab"
            aria-selected={value === i.value}
            onClick={() => onChange(i.value)}
            className={cn(
              'focus-ring whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition duration-150',
              value === i.value ? 'bg-white text-stone-900 shadow-[0_1px_2px_rgb(28_25_23/0.08),0_0_0_1px_rgb(28_25_23/0.04)]' : 'text-stone-500 hover:text-stone-900',
            )}
          >
            {i.label}
            {i.count != null && <span className={cn('tabular ms-1.5 rounded-full px-1.5 text-[11px]', value === i.value ? 'bg-brand/10 text-brand' : 'bg-stone-200/80')}>{i.count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Pagination({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-between gap-3 border-t border-stone-100 px-4 py-3 text-sm text-stone-500" aria-label="Pagination">
      <span className="tabular">
        {(page - 1) * limit + 1}–{Math.min(total, page * limit)} of {total}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
        </Button>
        <span className="tabular px-2 text-xs">
          {page} / {pages}
        </span>
        <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight className="h-4 w-4 rtl:rotate-180" />
        </Button>
      </div>
    </nav>
  );
}

/* ----------------------------- Overlays ----------------------------- */
/** Escape closes, body scroll locks, and focus returns to the element that opened the overlay. */
function useOverlay(open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', h);
      document.body.style.overflow = prev;
      opener?.focus?.();
    };
  }, [open]);
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useOverlay(open, onClose);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (open) setTimeout(() => panel.current?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea,button:not([aria-label="Close"])')?.focus(), 40);
  }, [open]);
  if (!open) return null;
  const w = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="absolute inset-0 animate-fade-in bg-ink-950/45 backdrop-blur-[3px]" onClick={onClose} />
      <div ref={panel} className={cn('relative flex max-h-[92vh] w-full animate-sheet-up flex-col overflow-hidden rounded-t-3xl bg-white shadow-float sm:animate-scale-in sm:rounded-2xl', w)}>
        <span className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-stone-200 sm:hidden" aria-hidden />
        <header className="flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-4 sm:px-7 sm:py-5">
          <h2 id={titleId} className="font-display text-xl font-semibold tracking-tight text-stone-900">
            {title}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" className="-me-2 rounded-full">
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-stone-100 bg-stone-50/60 px-5 py-4 sm:px-7">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children, footer, width = 'max-w-xl' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  useOverlay(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="absolute inset-0 animate-fade-in bg-ink-950/45 backdrop-blur-[3px]" onClick={onClose} />
      <aside className={cn('absolute inset-y-0 end-0 flex w-full animate-slide-in flex-col bg-white shadow-float rtl:animate-none', width)}>
        <header className="flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-4 sm:px-7 sm:py-5">
          <h2 id={titleId} className="font-display text-xl font-semibold tracking-tight">
            {title}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" className="-me-2 rounded-full">
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="scrollbar-thin flex-1 overflow-y-auto p-5 sm:p-7">{children}</div>
        {footer && <footer className="border-t border-stone-100 bg-stone-50/60 px-5 py-4 sm:px-7">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

/* ----------------------------- Toasts & confirm ----------------------------- */
type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<{ push: (kind: Toast['kind'], text: string) => void; confirm: (o: ConfirmOpts) => Promise<boolean | string> } | null>(null);
type ConfirmOpts = { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; input?: { label: string; required?: boolean } };

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dlg, setDlg] = useState<(ConfirmOpts & { resolve: (v: boolean | string) => void }) | null>(null);
  const [inputVal, setInputVal] = useState('');
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean | string>((resolve) => { setInputVal(''); setDlg({ ...o, resolve }); }), []);
  const close = (v: boolean | string) => {
    dlg?.resolve(v);
    setDlg(null);
  };
  return (
    <ToastCtx.Provider value={{ push, confirm }}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="pointer-events-auto flex w-full max-w-md animate-scale-in items-start gap-3 rounded-2xl bg-ink-900/95 px-4 py-3 text-sm text-white shadow-float ring-1 ring-white/10 backdrop-blur" role={t.kind === 'error' ? 'alert' : 'status'}>
              {t.kind === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : t.kind === 'error' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />}
              <span className="leading-relaxed">{t.text}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
      <Modal
        open={!!dlg}
        onClose={() => close(false)}
        title={dlg?.title}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant={dlg?.danger ? 'danger' : 'primary'} disabled={!!dlg?.input?.required && !inputVal.trim()} onClick={() => close(dlg?.input ? inputVal.trim() || true : true)}>
              {dlg?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {dlg?.body && <div className="text-sm leading-relaxed text-stone-600">{dlg.body}</div>}
        {dlg?.input && (
          <Field label={dlg.input.label} className="mt-4">
            <Input value={inputVal} onChange={(e) => setInputVal(e.target.value)} autoFocus />
          </Field>
        )}
      </Modal>
    </ToastCtx.Provider>
  );
}

export function useFeedback() {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('useFeedback outside provider');
  return {
    ...c,
    ok: (t: string) => c.push('success', t),
    fail: (e: unknown) => c.push('error', e instanceof Error ? e.message : String(e)),
    info: (t: string) => c.push('info', t),
  };
}

/* ----------------------------- Data table ----------------------------- */
export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
}
export function DataTable<T extends { _id?: string }>({ rows, columns, onRowClick, empty }: { rows: T[]; columns: Column<T>[]; onRowClick?: (r: T) => void; empty?: ReactNode }) {
  if (!rows.length) return <>{empty ?? <Empty title="Nothing here yet" />}</>;
  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <thead className="border-b border-stone-200/70 bg-stone-50/80">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cn('th', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {rows.map((r, i) => (
            <tr
              key={r._id ?? i}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              // Clickable rows are reachable and operable from the keyboard too.
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRowClick(r)) : undefined}
              className={cn('transition-colors duration-150 hover:bg-stone-50/60', onRowClick && 'cursor-pointer outline-none hover:bg-stone-50/80 focus-visible:bg-brand/5 focus-visible:shadow-[inset_3px_0_0_rgb(var(--brand))]')}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn('td', c.className)}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
