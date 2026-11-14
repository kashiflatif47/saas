import { useMemo } from 'react';
import { AlertTriangle, Plus, X } from 'lucide-react';
import { Button, Field, Input, Select, Toggle } from '../../components/ui';
import { cn, toLocalInputValue, toMajor, toMinor } from '../../lib/util';
import { productEffectivePrice, validateProductOptions, variantEffectivePrice, type MenuProduct } from '../../offline/menuPricing';

/*
 * Dish option configuration. Each section states plainly how it affects the price:
 *  - Options (sizes / portions / persons): "own full price" (REPLACES the dish price), or legacy "adds to dish price";
 *  - Extras: always ADDED, per unit, up to a maximum quantity;
 *  - Choice groups: pick within min..max, optional extra price per choice, some units included free;
 *  - Removable ingredients: never change the price.
 * The "customer pays" figures use the exact rules the server charges with (offline/menuPricing.ts).
 */

const str = (n: unknown) => (n == null ? '' : String(n));
const ing = (x: any) => (x?.inventoryItemId ? { inventoryItemId: x.inventoryItemId, quantity: str(x.quantity) } : null);

/** Product (minor units) → editable form strings (major units). */
export function optionsToForm(p: any, dec: number) {
  const m = (n: any) => (n == null ? '' : toMajor(n, dec));
  return {
    variantPricing: p._id ? (p.variantPricing === 'replace' ? 'replace' : 'add') : 'replace',
    variantGroupName: p.variantGroupName ?? '',
    variantRequired: p.variantRequired !== false,
    variants: (p.variants ?? []).map((v: any) => ({ _id: v._id, name: v.name, price: m(v.price), salePrice: m(v.salePrice), saleEndsAt: toLocalInputValue(v.saleEndsAt), priceDelta: m(v.priceDelta ?? 0), isActive: v.isActive !== false, recipeMultiplier: str(v.recipeMultiplier) })),
    addons: (p.addons ?? []).map((a: any) => ({ _id: a._id, name: a.name, price: m(a.price ?? 0), isAvailable: a.isAvailable !== false, maxQty: str(a.maxQty ?? 1), ingredient: ing(a.ingredient) })),
    modifierGroups: (p.modifierGroups ?? []).map((g: any) => ({
      _id: g._id, name: g.name, minSelect: str(g.minSelect ?? 0), maxSelect: str(g.maxSelect ?? 1), freeQty: str(g.freeQty ?? 0), isActive: g.isActive !== false,
      options: (g.options ?? []).map((o: any) => ({ _id: o._id, name: o.name, price: m(o.price ?? 0), isAvailable: o.isAvailable !== false, maxQty: str(o.maxQty ?? 1), ingredient: ing(o.ingredient) })),
    })),
    removableIngredients: (p.removableIngredients ?? []).map((r: any) => ({ _id: r._id, name: r.name, isAvailable: r.isAvailable !== false, ingredient: ing(r.ingredient) })),
  };
}

const int = (s: any, d = 0) => (s === '' || s == null || Number.isNaN(Number(s)) ? d : Math.trunc(Number(s)));
const idPart = (x: any) => (x._id ? { _id: x._id } : {});
const ingBody = (x: any) => (x?.inventoryItemId && Number(x.quantity) > 0 ? { inventoryItemId: x.inventoryItemId, quantity: Number(x.quantity) } : null);

/** Form → request body (minor units). Only the fields that matter for the chosen pricing mode are sent. */
export function optionsToBody(v: any, dec: number) {
  const replace = v.variantPricing === 'replace';
  return {
    variantPricing: v.variantPricing,
    variantGroupName: v.variantGroupName.trim(),
    variantRequired: !!v.variantRequired,
    variants: v.variants.map((x: any) => ({
      ...idPart(x), name: x.name.trim(), isActive: !!x.isActive,
      ...(replace
        ? { price: x.price === '' ? null : toMinor(x.price, dec), salePrice: x.salePrice === '' ? null : toMinor(x.salePrice, dec), saleEndsAt: x.saleEndsAt ? new Date(x.saleEndsAt).toISOString() : null, priceDelta: 0 }
        : { priceDelta: toMinor(x.priceDelta || 0, dec) }),
      recipeMultiplier: x.recipeMultiplier === '' ? null : Number(x.recipeMultiplier),
    })),
    addons: v.addons.map((x: any) => ({ ...idPart(x), name: x.name.trim(), price: toMinor(x.price || 0, dec), isAvailable: !!x.isAvailable, maxQty: Math.max(1, int(x.maxQty, 1)), ingredient: ingBody(x.ingredient) })),
    modifierGroups: v.modifierGroups.map((g: any) => ({
      ...idPart(g), name: g.name.trim(), minSelect: int(g.minSelect), maxSelect: Math.max(1, int(g.maxSelect, 1)), freeQty: int(g.freeQty), isActive: !!g.isActive,
      options: g.options.map((o: any) => ({ ...idPart(o), name: o.name.trim(), price: toMinor(o.price || 0, dec), isAvailable: !!o.isAvailable, maxQty: Math.max(1, int(o.maxQty, 1)), ingredient: ingBody(o.ingredient) })),
    })),
    removableIngredients: v.removableIngredients.map((r: any) => ({ ...idPart(r), name: r.name.trim(), isAvailable: !!r.isAvailable, ingredient: ingBody(r.ingredient) })),
  };
}

/** The form as a priced product, for live "customer pays" figures and configuration checks. */
function previewProduct(v: any, dec: number): MenuProduct {
  return {
    name: v.name?.en || 'This dish',
    price: v.price === '' ? 0 : toMinor(v.price, dec),
    promoPrice: v.promoPrice === '' ? null : toMinor(v.promoPrice, dec),
    promoEndsAt: v.promoEndsAt || null,
    ...optionsToBody(v, dec),
  } as any;
}

export function ProductOptionsEditor({ v, setV, dec, money, inventory }: { v: any; setV: (v: any) => void; dec: number; money: (n: number) => string; inventory: any[] | null }) {
  const replace = v.variantPricing === 'replace';
  const preview = useMemo(() => previewProduct(v, dec), [v, dec]);
  const problems = useMemo(() => validateProductOptions(preview), [preview]);
  const dishPrice = productEffectivePrice(preview);
  const edit = (key: string, i: number, patch: any) => setV({ ...v, [key]: v[key].map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
  const del = (key: string, i: number) => setV({ ...v, [key]: v[key].filter((_: any, j: number) => j !== i) });
  const editGroup = (gi: number, patch: any) => edit('modifierGroups', gi, patch);
  const editOpt = (gi: number, oi: number, patch: any) => editGroup(gi, { options: v.modifierGroups[gi].options.map((o: any, j: number) => (j === oi ? { ...o, ...patch } : o)) });

  /** Legacy → replacement pricing, with an explicit choice of what the entered amounts meant. */
  const convert = (meaning: 'full' | 'keep') => {
    const regular = v.price === '' ? 0 : toMinor(v.price, dec);
    const promo = v.promoPrice === '' ? null : toMinor(v.promoPrice, dec);
    setV({
      ...v,
      variantPricing: 'replace',
      variants: v.variants.map((x: any) => {
        const delta = toMinor(x.priceDelta || 0, dec);
        if (meaning === 'full') return { ...x, price: toMajor(Math.max(0, delta), dec), salePrice: '', saleEndsAt: '' };
        // Keep exactly what customers pay today: regular + delta, and the running promo + delta as the option's sale.
        return { ...x, price: toMajor(regular + delta, dec), salePrice: promo != null && promo < regular ? toMajor(promo + delta, dec) : '', saleEndsAt: promo != null ? v.promoEndsAt : '' };
      }),
    });
  };

  const IngredientPicker = ({ value, onChange, label }: { value: any; onChange: (x: any) => void; label: string }) =>
    inventory ? (
      <div className="flex gap-1.5">
        <Select className="h-9 w-40 py-0 text-xs" value={value?.inventoryItemId ?? ''} onChange={(e) => onChange(e.target.value ? { inventoryItemId: e.target.value, quantity: value?.quantity ?? '' } : null)} aria-label={`${label} ingredient`}>
          <option value="">No stock link</option>
          {inventory.map((it) => <option key={it._id} value={it._id}>{it.name} ({it.unit})</option>)}
        </Select>
        {value?.inventoryItemId && <Input className="h-9 w-20 text-xs" type="number" step="any" min="0" placeholder="Qty" value={value.quantity} onChange={(e) => onChange({ ...value, quantity: e.target.value })} aria-label={`${label} ingredient quantity`} />}
      </div>
    ) : null;

  return (
    <div className="space-y-6">
      {/* ---------------- Options (sizes / portions) ---------------- */}
      <section className="rounded-xl border border-stone-200 p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Options · sizes, portions, persons, packages</p>
            <p className="text-xs text-stone-500">The customer picks one. Example: Single Person / Two Persons / Three Persons.</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setV({ ...v, variants: [...v.variants, { name: '', price: '', salePrice: '', saleEndsAt: '', priceDelta: '0', isActive: true, recipeMultiplier: '' }] })}><Plus className="h-4 w-4" /> Add option</Button>
        </div>
        {v.variants.length > 0 && (
          <>
            <div className="mb-3 grid gap-3 sm:grid-cols-3">
              <Field label="Heading shown to customers"><Input placeholder="e.g. Persons, Size" value={v.variantGroupName} maxLength={40} onChange={(e) => setV({ ...v, variantGroupName: e.target.value })} /></Field>
              <Field label="How option prices work" className="sm:col-span-2">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-stone-100 p-1 text-sm" role="radiogroup">
                  {[['replace', 'Own full price', 'The option price IS the price'], ['add', 'Adds to dish price', 'Legacy: dish price + amount']].map(([k, title, hint]) => (
                    <button key={k} type="button" role="radio" aria-checked={v.variantPricing === k} onClick={() => setV({ ...v, variantPricing: k })} className={cn('rounded-lg px-3 py-1.5 text-start transition', v.variantPricing === k ? 'bg-white font-medium shadow-sm' : 'text-stone-500 hover:text-stone-800')}>
                      <span className="block">{title}</span><span className="block text-[11px] text-stone-500">{hint}</span>
                    </button>
                  ))}
                </div>
              </Field>
            </div>
            <Toggle checked={v.variantRequired} onChange={(variantRequired) => setV({ ...v, variantRequired })} label="Customers must choose an option" />

            {!replace && (
              <div className="my-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="note">
                <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" /> These amounts are ADDED to the dish price ({money(dishPrice)}).</p>
                <p className="mt-1 text-xs">If you entered each option's full price (e.g. Three Persons = 2,000), customers are being charged the dish price on top. Choose what the amounts mean:</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => convert('full')}>They are full prices</Button>
                  <Button size="sm" variant="outline" onClick={() => convert('keep')}>Keep what customers pay now</Button>
                </div>
              </div>
            )}

            <div className="mt-3 space-y-2">
              {v.variants.map((x: any, i: number) => {
                let pays: number | null = null;
                try {
                  pays = variantEffectivePrice(preview, preview.variants![i]);
                } catch {
                  /* incomplete row */
                }
                return (
                  <div key={i} className={cn('flex flex-wrap items-end gap-2 rounded-lg p-2', !x.isActive && 'bg-stone-50 opacity-70')}>
                    <Field label="Name" className="min-w-[140px] flex-1"><Input value={x.name} maxLength={60} onChange={(e) => edit('variants', i, { name: e.target.value })} /></Field>
                    {replace ? (
                      <>
                        <Field label="Price *" className="w-28"><Input type="number" step="0.01" min="0" value={x.price} onChange={(e) => edit('variants', i, { price: e.target.value })} /></Field>
                        <Field label="Sale price" className="w-28"><Input type="number" step="0.01" min="0" value={x.salePrice} onChange={(e) => edit('variants', i, { salePrice: e.target.value })} /></Field>
                        <Field label="Sale ends" className="w-44"><Input type="datetime-local" value={x.saleEndsAt} onChange={(e) => edit('variants', i, { saleEndsAt: e.target.value })} /></Field>
                      </>
                    ) : (
                      <Field label="+ Amount" className="w-28"><Input type="number" step="0.01" value={x.priceDelta} onChange={(e) => edit('variants', i, { priceDelta: e.target.value })} /></Field>
                    )}
                    {inventory && <Field label="× recipe" className="w-20"><Input type="number" step="any" min="0" placeholder="1" value={x.recipeMultiplier} onChange={(e) => edit('variants', i, { recipeMultiplier: e.target.value })} aria-label="Ingredient multiplier" /></Field>}
                    <div className="pb-2 text-xs text-stone-500">Customer pays <span className="font-semibold tabular-nums text-stone-900">{pays == null ? '—' : money(pays)}</span></div>
                    <div className="flex items-center gap-1 pb-1">
                      <Toggle checked={x.isActive} onChange={(isActive) => edit('variants', i, { isActive })} label="Active" />
                      <Button size="icon" variant="ghost" onClick={() => del('variants', i)} aria-label="Remove option"><X className="h-4 w-4" /></Button>
                    </div>
                  </div>
                );
              })}
            </div>
            {replace && <p className="mt-2 text-xs text-stone-500">Each option's price replaces the dish price; the dish promo price does not apply to options (give an option its own sale price instead).</p>}
          </>
        )}
      </section>

      {/* ---------------- Extras ---------------- */}
      <section className="rounded-xl border border-stone-200 p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Extras · added to the price</p>
            <p className="text-xs text-stone-500">Extra cheese, extra puri… Charged per unit, on top of the chosen option.</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setV({ ...v, addons: [...v.addons, { name: '', price: '0', isAvailable: true, maxQty: '1', ingredient: null }] })}><Plus className="h-4 w-4" /> Add extra</Button>
        </div>
        {v.addons.map((x: any, i: number) => (
          <div key={i} className="mb-2 flex flex-wrap items-end gap-2">
            <Field label="Name" className="min-w-[140px] flex-1"><Input value={x.name} maxLength={60} onChange={(e) => edit('addons', i, { name: e.target.value })} /></Field>
            <Field label="+ Price each" className="w-28"><Input type="number" step="0.01" min="0" value={x.price} onChange={(e) => edit('addons', i, { price: e.target.value })} /></Field>
            <Field label="Max qty" className="w-20"><Input type="number" min="1" max="20" value={x.maxQty} onChange={(e) => edit('addons', i, { maxQty: e.target.value })} /></Field>
            <IngredientPicker label={x.name} value={x.ingredient} onChange={(ingredient) => edit('addons', i, { ingredient })} />
            <div className="flex items-center gap-1 pb-1">
              <Toggle checked={x.isAvailable} onChange={(isAvailable) => edit('addons', i, { isAvailable })} label="Available" />
              <Button size="icon" variant="ghost" onClick={() => del('addons', i)} aria-label="Remove extra"><X className="h-4 w-4" /></Button>
            </div>
          </div>
        ))}
      </section>

      {/* ---------------- Choice groups ---------------- */}
      <section className="rounded-xl border border-stone-200 p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Choice groups · sauce, crust, toppings, meal upgrade, substitutions</p>
            <p className="text-xs text-stone-500">Price 0 = included. "Included free" makes that many paid choices free (cheapest first).</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setV({ ...v, modifierGroups: [...v.modifierGroups, { name: '', minSelect: '1', maxSelect: '1', freeQty: '0', isActive: true, options: [{ name: '', price: '0', isAvailable: true, maxQty: '1' }] }] })}><Plus className="h-4 w-4" /> Add group</Button>
        </div>
        {v.modifierGroups.map((g: any, gi: number) => (
          <div key={gi} className={cn('mb-3 rounded-lg bg-stone-50 p-3', !g.isActive && 'opacity-70')}>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Group name" className="min-w-[140px] flex-1"><Input value={g.name} maxLength={60} placeholder="e.g. Sauce" onChange={(e) => editGroup(gi, { name: e.target.value })} /></Field>
              <Field label="Min" className="w-16"><Input type="number" min="0" value={g.minSelect} onChange={(e) => editGroup(gi, { minSelect: e.target.value })} /></Field>
              <Field label="Max" className="w-16"><Input type="number" min="1" value={g.maxSelect} onChange={(e) => editGroup(gi, { maxSelect: e.target.value })} /></Field>
              <Field label="Included free" className="w-24"><Input type="number" min="0" value={g.freeQty} onChange={(e) => editGroup(gi, { freeQty: e.target.value })} /></Field>
              <div className="flex items-center gap-1 pb-1">
                <Toggle checked={g.isActive} onChange={(isActive) => editGroup(gi, { isActive })} label="Active" />
                <Button size="icon" variant="ghost" onClick={() => del('modifierGroups', gi)} aria-label="Remove group"><X className="h-4 w-4" /></Button>
              </div>
            </div>
            <p className="mt-1 text-[11px] text-stone-500">{int(g.minSelect) > 0 ? `Required: at least ${int(g.minSelect)}` : 'Optional'} · at most {int(g.maxSelect, 1)}</p>
            <div className="mt-2 space-y-1.5 ps-3">
              {g.options.map((o: any, oi: number) => (
                <div key={oi} className="flex flex-wrap items-center gap-2">
                  <Input className="h-9 min-w-[120px] flex-1" placeholder="Choice" value={o.name} maxLength={60} onChange={(e) => editOpt(gi, oi, { name: e.target.value })} />
                  <Input className="h-9 w-24" type="number" step="0.01" min="0" value={o.price} onChange={(e) => editOpt(gi, oi, { price: e.target.value })} aria-label="Extra price" title="Extra price (0 = included)" />
                  <Input className="h-9 w-16" type="number" min="1" max="20" value={o.maxQty} onChange={(e) => editOpt(gi, oi, { maxQty: e.target.value })} aria-label="Max per choice" title="Max of this choice" />
                  <Toggle checked={o.isAvailable} onChange={(isAvailable) => editOpt(gi, oi, { isAvailable })} />
                  <Button size="icon" variant="ghost" onClick={() => editGroup(gi, { options: g.options.filter((_: any, j: number) => j !== oi) })} aria-label="Remove choice"><X className="h-4 w-4" /></Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => editGroup(gi, { options: [...g.options, { name: '', price: '0', isAvailable: true, maxQty: '1' }] })}><Plus className="h-4 w-4" /> Choice</Button>
            </div>
          </div>
        ))}
      </section>

      {/* ---------------- Removable ingredients ---------------- */}
      <section className="rounded-xl border border-stone-200 p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Removable ingredients · never change the price</p>
            <p className="text-xs text-stone-500">Shown to the kitchen as "No onions". Link an ingredient to give it back to stock.</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setV({ ...v, removableIngredients: [...v.removableIngredients, { name: '', isAvailable: true, ingredient: null }] })}><Plus className="h-4 w-4" /> Add</Button>
        </div>
        {v.removableIngredients.map((r: any, i: number) => (
          <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
            <Input className="min-w-[140px] flex-1" placeholder="e.g. Onions" value={r.name} maxLength={60} onChange={(e) => edit('removableIngredients', i, { name: e.target.value })} />
            <IngredientPicker label={r.name} value={r.ingredient} onChange={(ingredient) => edit('removableIngredients', i, { ingredient })} />
            <Toggle checked={r.isAvailable} onChange={(isAvailable) => edit('removableIngredients', i, { isAvailable })} />
            <Button size="icon" variant="ghost" onClick={() => del('removableIngredients', i)} aria-label="Remove ingredient"><X className="h-4 w-4" /></Button>
          </div>
        ))}
      </section>

      {problems.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {problems.map((p) => <li key={p}>• {p}</li>)}
        </ul>
      )}
    </div>
  );
}
