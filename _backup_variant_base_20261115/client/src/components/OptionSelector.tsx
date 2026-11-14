import { useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from '../lib/util';
import {
  activeVariants, normalizeSelection, resolveSelection, variantEffectivePrice, variantIsRequired, variantListPrice, variantPricingMode,
  type ItemSelection, type ResolvedSelection,
} from '../offline/menuPricing';

/**
 * Dish option picker shared by the storefront, the POS and staff order entry. It only collects ids and
 * quantities; every price shown is computed by the same rules the server charges with (offline/menuPricing.ts,
 * a verbatim copy of the server module), and the server re-prices the order anyway.
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
}
export const STAFF_LABELS: OptionLabels = {
  chooseOption: 'Choose an option', extras: 'Extras', required: 'Required', optional: 'Optional', chooseUpTo: 'Choose up to {n}',
  chooseExactly: 'Choose {n}', chooseRange: 'Choose {min}–{max}', includedN: '{n} included', without: 'Remove ingredients', noX: 'No {x}',
};

/** Start state: the only active option is preselected; otherwise nothing is (a required choice must be made). */
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
    badge: store ? 'rounded-full bg-store-text/[0.06] px-2 py-0.5 text-[11px] font-medium opacity-80' : 'rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-600',
    accent: 'h-4 w-4 accent-[rgb(var(--brand))]',
  };
  const set = (patch: Partial<ItemSelection>) => onChange({ variantId: sel.variantId, addons: sel.addons, choices: sel.choices, removeIds: sel.removeIds, ...patch });

  const variants = activeVariants(p);
  const replace = variantPricingMode(p) === 'replace';
  const required = variantIsRequired(p);
  const extras = (p.addons ?? []).filter((a: any) => a.isAvailable !== false);
  const groups = (p.modifierGroups ?? []).filter((g: any) => g.isActive !== false);
  const removables = (p.removableIngredients ?? []).filter((r: any) => r.isAvailable !== false);

  const addonQty = (id: string) => sel.addons.find((a) => a.id === id)?.quantity ?? 0;
  const setAddon = (id: string, q: number) => set({ addons: [...sel.addons.filter((a) => a.id !== id), ...(q > 0 ? [{ id, quantity: q }] : [])] });
  const choiceQty = (gid: string, oid: string) => sel.choices.find((c) => c.groupId === gid && c.optionId === oid)?.quantity ?? 0;
  const groupCount = (gid: string) => sel.choices.filter((c) => c.groupId === gid).reduce((s, c) => s + c.quantity, 0);
  const setChoice = (gid: string, oid: string, q: number, single: boolean) => {
    const rest = sel.choices.filter((c) => (single ? c.groupId !== gid : !(c.groupId === gid && c.optionId === oid)));
    set({ choices: [...rest, ...(q > 0 ? [{ groupId: gid, optionId: oid, quantity: q }] : [])] });
  };

  const Stepper = ({ q, max, onSet, label }: { q: number; max: number; onSet: (n: number) => void; label: string }) => (
    <span className="flex items-center gap-1">
      <button type="button" className={cn('rounded-full p-1.5 transition disabled:opacity-30', store ? 'hover:bg-store-text/5' : 'hover:bg-stone-100')} disabled={q <= 0} onClick={() => onSet(q - 1)} aria-label={`Fewer ${label}`}><Minus className="h-3.5 w-3.5" /></button>
      <span className="tabular w-5 text-center text-sm font-semibold" aria-live="polite">{q}</span>
      <button type="button" className={cn('rounded-full p-1.5 transition disabled:opacity-30', store ? 'hover:bg-store-text/5' : 'hover:bg-stone-100')} disabled={q >= max} onClick={() => onSet(q + 1)} aria-label={`More ${label}`}><Plus className="h-3.5 w-3.5" /></button>
    </span>
  );

  return (
    <div className="space-y-6">
      {variants.length > 0 && (
        <fieldset>
          <legend className={cls.legend}>
            <span>{p.variantGroupName || labels.chooseOption}</span>
            <span className={cls.badge}>{required ? labels.required : labels.optional}</span>
          </legend>
          <div className="space-y-2" role="radiogroup">
            {variants.map((v: any) => {
              const id = String(v._id);
              const on = sel.variantId === id;
              const eff = variantEffectivePrice(p, v);
              const list = variantListPrice(p, v);
              return (
                <label key={id} className={cn(cls.row, on ? cls.on : cls.off)}>
                  <span className="flex items-center gap-3">
                    <input type="radio" name={`variant-${p._id}`} checked={on} onChange={() => set({ variantId: id })} onClick={() => on && !required && set({ variantId: undefined })} className={cls.accent} />
                    {v.name}
                  </span>
                  {replace ? (
                    // Replacement pricing: the option's own full price (what the customer pays for it).
                    <span className="tabular text-sm">
                      {list > eff && <s className={cn('me-1.5', cls.muted)}>{money(list)}</s>}
                      <span className={list > eff ? 'font-semibold text-brand' : cls.muted}>{money(eff)}</span>
                    </span>
                  ) : (
                    (v.priceDelta ?? 0) !== 0 && <span className={cn('tabular text-sm', cls.muted)}>{v.priceDelta > 0 ? '+' : '−'}{money(Math.abs(v.priceDelta))}</span>
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
        const options = (g.options ?? []).filter((o: any) => o.isAvailable !== false);
        const single = max === 1 && options.every((o: any) => (o.maxQty ?? 1) <= 1);
        const count = groupCount(gid);
        const rule = min === max ? fill(labels.chooseExactly, { n: max }) : min === 0 ? fill(labels.chooseUpTo, { n: max }) : fill(labels.chooseRange, { min, max });
        return (
          <fieldset key={gid}>
            <legend className={cls.legend}>
              <span>{g.name}</span>
              <span className="flex flex-wrap justify-end gap-1">
                <span className={cls.badge}>{min > 0 ? labels.required : labels.optional}</span>
                <span className={cls.badge}>{rule}</span>
                {g.freeQty > 0 && <span className={cls.badge}>{fill(labels.includedN, { n: g.freeQty })}</span>}
              </span>
            </legend>
            <div className="space-y-2">
              {options.map((o: any) => {
                const oid = String(o._id);
                const q = choiceQty(gid, oid);
                const optMax = Math.min(o.maxQty ?? 1, max);
                const price = o.price ? <span className={cn('tabular text-sm', cls.muted)}>+{money(o.price)}</span> : null;
                if (single) {
                  return (
                    <label key={oid} className={cn(cls.row, q ? cls.on : cls.off)}>
                      <span className="flex items-center gap-3">
                        <input type="radio" name={`group-${p._id}-${gid}`} checked={q > 0} onChange={() => setChoice(gid, oid, 1, true)} onClick={() => q > 0 && min === 0 && setChoice(gid, oid, 0, true)} className={cls.accent} />
                        {o.name}
                      </span>
                      {price}
                    </label>
                  );
                }
                if (optMax <= 1) {
                  return (
                    <label key={oid} className={cn(cls.row, q ? cls.on : cls.off)}>
                      <span className="flex items-center gap-3">
                        <input type="checkbox" checked={q > 0} disabled={!q && count >= max} onChange={(e) => setChoice(gid, oid, e.target.checked ? 1 : 0, false)} className={cls.accent} />
                        {o.name}
                      </span>
                      {price}
                    </label>
                  );
                }
                return (
                  <div key={oid} className={cn(cls.row, 'cursor-default', q ? cls.on : cls.off)}>
                    <span>{o.name} {price}</span>
                    <Stepper q={q} max={Math.min(optMax, q + (max - count))} onSet={(n) => setChoice(gid, oid, n, false)} label={o.name} />
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
              const q = addonQty(id);
              const max = a.maxQty ?? 1;
              if (max <= 1) {
                return (
                  <label key={id} className={cn(cls.row, q ? cls.on : cls.off)}>
                    <span className="flex items-center gap-3">
                      <input type="checkbox" checked={q > 0} onChange={(e) => setAddon(id, e.target.checked ? 1 : 0)} className={cls.accent} />
                      {a.name}
                    </span>
                    <span className={cn('tabular text-sm', cls.muted)}>+{money(a.price)}</span>
                  </label>
                );
              }
              return (
                <div key={id} className={cn(cls.row, 'cursor-default', q ? cls.on : cls.off)}>
                  <span>{a.name} <span className={cn('tabular text-sm', cls.muted)}>+{money(a.price)}</span></span>
                  <Stepper q={q} max={max} onSet={(n) => setAddon(id, n)} label={a.name} />
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
                  <input type="checkbox" checked={on} onChange={(e) => set({ removeIds: e.target.checked ? [...sel.removeIds, id] : sel.removeIds.filter((x) => x !== id) })} className={cls.accent} />
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
