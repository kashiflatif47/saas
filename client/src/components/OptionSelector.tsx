import { useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from '../lib/util';
import { chooseVariant, setChoiceQuantity, setExtraQuantity, toggleRemoval } from '../lib/options';
import {
  activeVariants, normalizeSelection, optionEffectivePrice, productEffectivePrice, resolveSelection, variantEffectivePrice, variantIsRequired, variantListPrice, variantPricingMode,
  type ItemSelection, type ResolvedSelection,
} from '../offline/menuPricing';

/**
 * Dish option picker shared by the storefront, the POS and staff order entry. It only collects ids and
 * quantities; every price shown is computed by the same rules the server charges with (offline/menuPricing.ts,
 * a verbatim copy of the server module), and the server re-prices the order anyway.
 *
 * What customers see:
 *  - Portion / size options as radio buttons with their FULL price (no "+": choosing one replaces the price).
 *    When the dish can be ordered at its base price, that is the first, preselected choice ("Regular — Rs 700").
 *  - Paid extras with "+ price" and a quantity control.
 *  - Free / included choices marked "Included"; removable ingredients ("No onions") never change the price.
 */

export interface OptionLabels {
  chooseOption: string;
  extras: string;
  required: string;
  optional: string;
  chooseUpTo: string; // {n}
  chooseExactly: string; // {n}
  chooseRange: string; // {min} {max}
  includedN: string; // {n}
  without: string;
  noX: string; // {x}
  regular: string; // base-price choice when the dish has no own label
  included: string;
}
export const STAFF_LABELS: OptionLabels = {
  chooseOption: 'Choose an option', extras: 'Extras', required: 'Required', optional: 'Optional', chooseUpTo: 'Choose up to {n}',
  chooseExactly: 'Choose {n}', chooseRange: 'Choose {min}–{max}', includedN: '{n} included', without: 'Remove ingredients', noX: 'No {x}',
  regular: 'Regular', included: 'Included',
};

/** Start state: the base price when it is orderable; the only active option when a choice is required; else nothing. */
export function initialSelection(p: any): ItemSelection {
  const active = activeVariants(p);
  return active.length === 1 && variantIsRequired(p) ? { variantId: String(active[0]._id) } : {};
}

/** Selection state + live resolution (price or the reason it cannot be added yet). */
export function useItemSelection(p: any, initial?: ItemSelection) {
  const [selection, setSelection] = useState<ItemSelection>(() => initial ?? initialSelection(p));
  const result = useMemo<{ resolved: ResolvedSelection | null; error: string | null }>(() => {
    try {
      return { resolved: resolveSelection(p, selection), error: null };
    } catch (e: any) {
      return { resolved: null, error: e?.message ?? 'Invalid selection' };
    }
  }, [p, selection]);
  return { selection, setSelection, ...result };
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

type Cls = Record<'muted' | 'desc' | 'free', string>;

function Name({ name, description, cls }: { name: string; description?: string; cls: Cls }) {
  return (
    <span className="min-w-0">
      {name}
      {description && <span className={cls.desc}>{description}</span>}
    </span>
  );
}

/** Full price of a choice that REPLACES the price: no "+", sale shown against the original. */
function FullPrice({ eff, list, money, cls }: { eff: number; list: number; money: (n: number) => string; cls: Cls }) {
  return (
    <span className="tabular shrink-0 text-sm">
      {list > eff && <s className={cn('me-1.5', cls.muted)}>{money(list)}</s>}
      <span className={list > eff ? 'font-semibold text-brand' : 'font-medium'}>{money(eff)}</span>
    </span>
  );
}

/** Price ADDED by an extra or paid choice, or "Included" when free. */
function AddedPrice({ o, free, money, cls, includedLabel }: { o: any; free?: boolean; money: (n: number) => string; cls: Cls; includedLabel: string }) {
  const eff = free ? 0 : optionEffectivePrice(o);
  if (eff === 0) return <span className={cn('shrink-0', cls.free)}>{includedLabel}</span>;
  return (
    <span className={cn('tabular shrink-0 text-sm', cls.muted)}>
      {(o.price ?? 0) > eff && <s className="me-1">+{money(o.price)}</s>}+{money(eff)}
    </span>
  );
}

function Stepper({ q, max, onSet, label, store }: { q: number; max: number; onSet: (n: number) => void; label: string; store: boolean }) {
  const btn = cn('rounded-full p-1.5 transition disabled:opacity-30', store ? 'hover:bg-store-text/5' : 'hover:bg-stone-100');
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button type="button" className={btn} disabled={q <= 0} onClick={() => onSet(q - 1)} aria-label={`Fewer ${label}`}><Minus className="h-3.5 w-3.5" /></button>
      <span className="tabular w-5 text-center text-sm font-semibold" aria-live="polite">{q}</span>
      <button type="button" className={btn} disabled={q >= max} onClick={() => onSet(q + 1)} aria-label={`More ${label}`}><Plus className="h-3.5 w-3.5" /></button>
    </span>
  );
}

export function OptionSelector({ product: p, value, onChange, money, tone = 'staff', labels = STAFF_LABELS }: {
  product: any;
  value: ItemSelection;
  onChange: (s: ItemSelection) => void;
  money: (n: number) => string;
  tone?: 'store' | 'staff';
  labels?: OptionLabels;
}) {
  const sel = normalizeSelection(value);
  const store = tone === 'store';
  const cls = {
    legend: store ? 'mb-2.5 flex items-center justify-between gap-2 text-sm font-semibold' : 'label mb-2 flex items-center justify-between gap-2',
    row: store ? 'flex cursor-pointer items-center justify-between gap-3 rounded-brand-sm border px-4 py-3.5 transition' : 'flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-3 text-sm',
    on: store ? 'border-brand bg-brand/[0.06] ring-1 ring-brand' : 'border-brand bg-brand/5',
    off: store ? 'border-store-text/10 bg-store-surface hover:border-store-text/25' : 'border-stone-200 hover:border-stone-300',
    muted: store ? 'opacity-70' : 'text-stone-500',
    desc: store ? 'block text-xs font-normal opacity-60' : 'block text-xs font-normal text-stone-500',
    badge: store ? 'rounded-full bg-store-text/[0.06] px-2 py-0.5 text-[11px] font-medium opacity-80' : 'rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-600',
    free: store ? 'text-xs font-medium text-emerald-700' : 'text-xs font-medium text-emerald-700',
    accent: 'h-4 w-4 shrink-0 accent-[rgb(var(--brand))]',
  };

  const variants = activeVariants(p);
  const replace = variantPricingMode(p) === 'replace';
  const required = variantIsRequired(p);
  const extras = (p.addons ?? []).filter((a: any) => a.isAvailable !== false);
  const groups = (p.modifierGroups ?? []).filter((g: any) => g.isActive !== false);
  const removables = (p.removableIngredients ?? []).filter((r: any) => r.isAvailable !== false);

  return (
    <div className="space-y-6">
      {variants.length > 0 && (
        <fieldset>
          <legend className={cls.legend}>
            <span>{p.variantGroupName || labels.chooseOption}</span>
            {required && <span className={cls.badge}>{labels.required}</span>}
          </legend>
          <div className="space-y-2" role="radiogroup">
            {!required && (
              // Ordering at the base price is a normal choice, selected until another option is picked.
              <label className={cn(cls.row, !sel.variantId ? cls.on : cls.off)}>
                <span className="flex items-center gap-3">
                  <input type="radio" name={`variant-${p._id}`} checked={!sel.variantId} onChange={() => onChange(chooseVariant(value, null))} className={cls.accent} />
                  <Name name={p.baseOptionLabel || labels.regular} cls={cls} />
                </span>
                <FullPrice eff={productEffectivePrice(p)} list={p.price} money={money} cls={cls} />
              </label>
            )}
            {variants.map((v: any) => {
              const id = String(v._id);
              const on = sel.variantId === id;
              return (
                <label key={id} className={cn(cls.row, on ? cls.on : cls.off)}>
                  <span className="flex items-center gap-3">
                    <input type="radio" name={`variant-${p._id}`} checked={on} onChange={() => onChange(chooseVariant(value, id))} className={cls.accent} />
                    <Name name={v.name} description={v.description} cls={cls} />
                  </span>
                  {replace ? (
                    <FullPrice eff={variantEffectivePrice(p, v)} list={variantListPrice(p, v)} money={money} cls={cls} />
                  ) : (
                    // Legacy dishes: the option's amount is added to the dish price.
                    (v.priceDelta ?? 0) !== 0 && <span className={cn('tabular shrink-0 text-sm', cls.muted)}>{v.priceDelta > 0 ? '+' : '−'}{money(Math.abs(v.priceDelta))}</span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {groups.map((g: any) => {
        const gid = String(g._id);
        const min = g.minSelect ?? 0;
        const max = g.maxSelect ?? 1;
        const free = g.kind === 'included';
        const options = (g.options ?? []).filter((o: any) => o.isAvailable !== false);
        const single = max === 1 && options.every((o: any) => (o.maxQty ?? 1) <= 1);
        const count = sel.choices.filter((c) => c.groupId === gid).reduce((s, c) => s + c.quantity, 0);
        const qty = (oid: string) => sel.choices.find((c) => c.groupId === gid && c.optionId === oid)?.quantity ?? 0;
        const set = (oid: string, q: number) => onChange(setChoiceQuantity(value, gid, oid, q, single));
        const rule = min === max ? fill(labels.chooseExactly, { n: max }) : min === 0 ? fill(labels.chooseUpTo, { n: max }) : fill(labels.chooseRange, { min, max });
        return (
          <fieldset key={gid}>
            <legend className={cls.legend}>
              <span>{g.name}</span>
              <span className="flex flex-wrap justify-end gap-1">
                <span className={cls.badge}>{min > 0 ? labels.required : labels.optional}</span>
                <span className={cls.badge}>{rule}</span>
                {free ? <span className={cls.badge}>{labels.included}</span> : g.freeQty > 0 && <span className={cls.badge}>{fill(labels.includedN, { n: g.freeQty })}</span>}
              </span>
            </legend>
            <div className="space-y-2">
              {options.map((o: any) => {
                const oid = String(o._id);
                const q = qty(oid);
                const optMax = Math.min(o.maxQty ?? 1, max);
                if (single || optMax <= 1) {
                  return (
                    <label key={oid} className={cn(cls.row, q ? cls.on : cls.off)}>
                      <span className="flex items-center gap-3">
                        {single ? (
                          <input type="radio" name={`group-${p._id}-${gid}`} checked={q > 0} onChange={() => set(oid, 1)} onClick={() => q > 0 && min === 0 && set(oid, 0)} className={cls.accent} />
                        ) : (
                          <input type="checkbox" checked={q > 0} disabled={!q && count >= max} onChange={(e) => set(oid, e.target.checked ? 1 : 0)} className={cls.accent} />
                        )}
                        <Name name={o.name} description={o.description} cls={cls} />
                      </span>
                      <AddedPrice o={o} free={free} money={money} cls={cls} includedLabel={labels.included} />
                    </label>
                  );
                }
                return (
                  <div key={oid} className={cn(cls.row, 'cursor-default', q ? cls.on : cls.off)}>
                    <span className="flex items-center gap-2"><Name name={o.name} description={o.description} cls={cls} /> <AddedPrice o={o} free={free} money={money} cls={cls} includedLabel={labels.included} /></span>
                    <Stepper q={q} max={Math.min(optMax, q + (max - count))} onSet={(n) => set(oid, n)} label={o.name} store={store} />
                  </div>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      {extras.length > 0 && (
        <fieldset>
          <legend className={cls.legend}><span>{labels.extras}</span><span className={cls.badge}>{labels.optional}</span></legend>
          <div className="space-y-2">
            {extras.map((a: any) => {
              const id = String(a._id);
              const q = sel.addons.find((x) => x.id === id)?.quantity ?? 0;
              const max = a.maxQty ?? 1;
              if (max <= 1) {
                return (
                  <label key={id} className={cn(cls.row, q ? cls.on : cls.off)}>
                    <span className="flex items-center gap-3">
                      <input type="checkbox" checked={q > 0} onChange={(e) => onChange(setExtraQuantity(value, id, e.target.checked ? 1 : 0))} className={cls.accent} />
                      <Name name={a.name} description={a.description} cls={cls} />
                    </span>
                    <AddedPrice o={a} money={money} cls={cls} includedLabel={labels.included} />
                  </label>
                );
              }
              return (
                <div key={id} className={cn(cls.row, 'cursor-default', q ? cls.on : cls.off)}>
                  <span className="flex items-center gap-2"><Name name={a.name} description={a.description} cls={cls} /> <AddedPrice o={a} money={money} cls={cls} includedLabel={labels.included} /></span>
                  <Stepper q={q} max={max} onSet={(n) => onChange(setExtraQuantity(value, id, n))} label={a.name} store={store} />
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      {removables.length > 0 && (
        <fieldset>
          <legend className={cls.legend}><span>{labels.without}</span></legend>
          <div className="flex flex-wrap gap-2">
            {removables.map((r: any) => {
              const id = String(r._id);
              const on = sel.removeIds.includes(id);
              return (
                <label key={id} className={cn('flex cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-sm transition', on ? cls.on : cls.off)}>
                  <input type="checkbox" checked={on} onChange={(e) => onChange(toggleRemoval(value, id, e.target.checked))} className={cls.accent} />
                  {fill(labels.noX, { x: r.name })}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
    </div>
  );
}
