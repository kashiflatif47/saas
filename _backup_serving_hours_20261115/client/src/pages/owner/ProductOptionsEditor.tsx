import { useMemo, type ReactNode } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { Button, Field, Input, Select, Toggle } from '../../components/ui';
import { cn, toMajor, toMinor } from '../../lib/util';
import { int, optionsToBody } from './productForm';
import { optionEffectivePrice, productEffectivePrice, validateProductOptions, variantEffectivePrice, type MenuProduct } from '../../offline/menuPricing';

/*
 * Dish option configuration, in three plainly named types (the rules live in offline/menuPricing.ts, the same
 * code the server charges with):
 *  1. Complete Price Variants — sizes / portions / persons. The option's price REPLACES the base price.
 *     The base price itself stays orderable unless "customers must choose" is switched on.
 *  2. Paid Extras — ADDED to the price, per unit, up to a maximum quantity. Choice groups of type "Paid" too.
 *  3. Free / Included — choice groups of type "Free / Included" and removable ingredients: never charged.
 * Display order = list order (arrows). The "customer pays" figures use the exact checkout rules.
 */

export { optionsToBody, optionsToForm } from './productForm';

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

const move = <T,>(list: T[], i: number, d: -1 | 1) => {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

/** Up/down arrows: display order = list order. */
function Order({ i, count, onMove }: { i: number; count: number; onMove: (d: -1 | 1) => void }) {
  return (
    <span className="flex flex-col">
      <button type="button" className="rounded p-0.5 text-stone-400 hover:text-stone-800 disabled:opacity-30" disabled={i === 0} onClick={() => onMove(-1)} aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></button>
      <button type="button" className="rounded p-0.5 text-stone-400 hover:text-stone-800 disabled:opacity-30" disabled={i === count - 1} onClick={() => onMove(1)} aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></button>
    </span>
  );
}

function IngredientPicker({ inventory, value, onChange, label }: { inventory: any[] | null; value: any; onChange: (x: any) => void; label: string }) {
  if (!inventory) return null;
  return (
    <div className="flex gap-1.5">
      <Select className="h-9 w-40 py-0 text-xs" value={value?.inventoryItemId ?? ''} onChange={(e) => onChange(e.target.value ? { inventoryItemId: e.target.value, quantity: value?.quantity ?? '' } : null)} aria-label={`${label} ingredient`}>
        <option value="">No stock link</option>
        {inventory.map((it) => <option key={it._id} value={it._id}>{it.name} ({it.unit})</option>)}
      </Select>
      {value?.inventoryItemId && <Input className="h-9 w-20 text-xs" type="number" step="any" min="0" placeholder="Qty" value={value.quantity} onChange={(e) => onChange({ ...value, quantity: e.target.value })} aria-label={`${label} ingredient quantity`} />}
    </div>
  );
}

function Section({ n, title, rule, children, action }: { n: number; title: string; rule: string; children: ReactNode; action: ReactNode }) {
  return (
    <section className="rounded-xl border border-stone-200 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold"><span className="me-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-stone-900 text-[11px] text-white">{n}</span>{title}</p>
          <p className="mt-0.5 text-xs text-stone-500">{rule}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ProductOptionsEditor({ v, setV, dec, money, inventory }: { v: any; setV: (v: any) => void; dec: number; money: (n: number) => string; inventory: any[] | null }) {
  const replace = v.variantPricing === 'replace';
  const preview = useMemo(() => previewProduct(v, dec), [v, dec]);
  const problems = useMemo(() => validateProductOptions(preview), [preview]);
  const dishPrice = productEffectivePrice(preview);
  const edit = (key: string, i: number, patch: any) => setV({ ...v, [key]: v[key].map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
  const del = (key: string, i: number) => setV({ ...v, [key]: v[key].filter((_: any, j: number) => j !== i) });
  const reorder = (key: string, i: number, d: -1 | 1) => setV({ ...v, [key]: move(v[key], i, d) });
  const editGroup = (gi: number, patch: any) => edit('modifierGroups', gi, patch);
  const editOpt = (gi: number, oi: number, patch: any) => editGroup(gi, { options: v.modifierGroups[gi].options.map((o: any, j: number) => (j === oi ? { ...o, ...patch } : o)) });

  /** Legacy → full-price options, with an explicit choice of what the entered amounts meant. */
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

  return (
    <div className="space-y-6">
      {/* ---------------- 1. Complete Price Variants ---------------- */}
      <Section n={1} title="Complete Price Variants" rule="Half Plate, Small / Large, Single / Double, persons, packages. The customer picks one, and its price REPLACES the base price (never added to it)."
        action={<Button size="sm" variant="ghost" onClick={() => setV({ ...v, variants: [...v.variants, { name: '', description: '', price: '', salePrice: '', saleEndsAt: '', priceDelta: '0', isActive: true, recipeMultiplier: '' }] })}><Plus className="h-4 w-4" /> Add variant</Button>}>
        {v.variants.length > 0 && (
          <>
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <Field label="Heading shown to customers"><Input placeholder="e.g. Choose your portion" value={v.variantGroupName} maxLength={40} onChange={(e) => setV({ ...v, variantGroupName: e.target.value })} /></Field>
              <div className="self-end pb-2">
                <Toggle checked={!v.variantRequired} onChange={(allowBase) => setV({ ...v, variantRequired: !allowBase })} label={`Customers can order at the base price (${money(dishPrice)}) without choosing a variant`} />
              </div>
            </div>

            {!replace && (
              <div className="my-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="note">
                <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" /> Review needed: these variants were saved as amounts ADDED to the base price ({money(dishPrice)}).</p>
                <p className="mt-1 text-xs">Today a customer pays the base price plus the amount (see "Customer pays"). Nothing changes until you choose and save:</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => convert('full')}>The amounts are the full selling prices</Button>
                  <Button size="sm" variant="outline" onClick={() => convert('keep')}>Keep what customers pay now</Button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {!v.variantRequired && (
                <div className="flex flex-wrap items-end gap-2 rounded-lg bg-stone-50 p-2">
                  <Field label="Base price choice shown as" className="min-w-[160px] flex-1"><Input placeholder="Regular" value={v.baseOptionLabel} maxLength={40} onChange={(e) => setV({ ...v, baseOptionLabel: e.target.value })} /></Field>
                  <div className="pb-2 text-xs text-stone-500">Base price from the dish · Customer pays <span className="font-semibold tabular-nums text-stone-900">{money(dishPrice)}</span></div>
                </div>
              )}
              {v.variants.map((x: any, i: number) => {
                let pays: number | null = null;
                try {
                  pays = variantEffectivePrice(preview, preview.variants![i]);
                } catch {
                  /* incomplete row */
                }
                return (
                  <div key={i} className={cn('flex flex-wrap items-end gap-2 rounded-lg p-2', !x.isActive && 'bg-stone-50 opacity-70')}>
                    <Order i={i} count={v.variants.length} onMove={(d) => reorder('variants', i, d)} />
                    <Field label="Variant name" className="min-w-[140px] flex-1"><Input value={x.name} maxLength={60} placeholder="e.g. Half Plate" onChange={(e) => edit('variants', i, { name: e.target.value })} /></Field>
                    <Field label="Description" className="min-w-[140px] flex-1"><Input value={x.description} maxLength={200} placeholder="optional" onChange={(e) => edit('variants', i, { description: e.target.value })} /></Field>
                    {replace ? (
                      <>
                        <Field label="Selling price *" className="w-28"><Input type="number" step="0.01" min="0" value={x.price} onChange={(e) => edit('variants', i, { price: e.target.value })} /></Field>
                        <Field label="Sale price" className="w-28"><Input type="number" step="0.01" min="0" value={x.salePrice} onChange={(e) => edit('variants', i, { salePrice: e.target.value })} /></Field>
                        <Field label="Sale ends" className="w-44"><Input type="datetime-local" value={x.saleEndsAt} onChange={(e) => edit('variants', i, { saleEndsAt: e.target.value })} /></Field>
                      </>
                    ) : (
                      <Field label="Added amount (legacy)" className="w-36"><Input type="number" step="0.01" value={x.priceDelta} onChange={(e) => edit('variants', i, { priceDelta: e.target.value })} /></Field>
                    )}
                    {inventory && <Field label="× recipe" className="w-20"><Input type="number" step="any" min="0" placeholder="1" value={x.recipeMultiplier} onChange={(e) => edit('variants', i, { recipeMultiplier: e.target.value })} aria-label="Ingredient multiplier" /></Field>}
                    <div className="pb-2 text-xs text-stone-500">Customer pays <span className="font-semibold tabular-nums text-stone-900">{pays == null ? '—' : money(pays)}</span></div>
                    <div className="flex items-center gap-1 pb-1">
                      <Toggle checked={x.isActive} onChange={(isActive) => edit('variants', i, { isActive })} label="Active" />
                      <Button size="icon" variant="ghost" onClick={() => del('variants', i)} aria-label="Remove variant"><X className="h-4 w-4" /></Button>
                    </div>
                  </div>
                );
              })}
            </div>
            {replace && <p className="mt-2 text-xs text-stone-500">The dish's promo price does not apply to variants; give a variant its own sale price instead.</p>}
          </>
        )}
      </Section>

      {/* ---------------- 2. Paid Extras ---------------- */}
      <Section n={2} title="Paid Extras" rule="Extra cheese, extra egg, extra puri… The additional price is ADDED to the base price or chosen variant, per unit."
        action={<Button size="sm" variant="ghost" onClick={() => setV({ ...v, addons: [...v.addons, { name: '', description: '', price: '0', salePrice: '', isAvailable: true, maxQty: '1', ingredient: null }] })}><Plus className="h-4 w-4" /> Add extra</Button>}>
        {v.addons.map((x: any, i: number) => (
          <div key={i} className="mb-2 flex flex-wrap items-end gap-2">
            <Order i={i} count={v.addons.length} onMove={(d) => reorder('addons', i, d)} />
            <Field label="Extra name" className="min-w-[140px] flex-1"><Input value={x.name} maxLength={60} onChange={(e) => edit('addons', i, { name: e.target.value })} /></Field>
            <Field label="Description" className="min-w-[120px] flex-1"><Input value={x.description} maxLength={200} placeholder="optional" onChange={(e) => edit('addons', i, { description: e.target.value })} /></Field>
            <Field label="Additional price" className="w-28"><Input type="number" step="0.01" min="0" value={x.price} onChange={(e) => edit('addons', i, { price: e.target.value })} /></Field>
            <Field label="Sale price" className="w-24"><Input type="number" step="0.01" min="0" value={x.salePrice} onChange={(e) => edit('addons', i, { salePrice: e.target.value })} /></Field>
            <Field label="Max qty" className="w-20"><Input type="number" min="1" max="20" value={x.maxQty} onChange={(e) => edit('addons', i, { maxQty: e.target.value })} /></Field>
            <IngredientPicker inventory={inventory} label={x.name} value={x.ingredient} onChange={(ingredient) => edit('addons', i, { ingredient })} />
            <div className="pb-2 text-xs text-stone-500">Adds <span className="font-semibold tabular-nums text-stone-900">+{money(optionEffectivePrice((preview.addons ?? [])[i] ?? {}))}</span></div>
            <div className="flex items-center gap-1 pb-1">
              <Toggle checked={x.isAvailable} onChange={(isAvailable) => edit('addons', i, { isAvailable })} label="Available" />
              <Button size="icon" variant="ghost" onClick={() => del('addons', i)} aria-label="Remove extra"><X className="h-4 w-4" /></Button>
            </div>
          </div>
        ))}
      </Section>

      {/* ---------------- 3. Choice groups (paid or free / included) ---------------- */}
      <Section n={3} title="Choice groups · Free / Included or Paid" rule="Sauce, crust, preparation, toppings, meal upgrade. Free / Included groups never charge; in Paid groups each choice adds its price (0 = included)."
        action={<Button size="sm" variant="ghost" onClick={() => setV({ ...v, modifierGroups: [...v.modifierGroups, { name: '', kind: 'included', minSelect: '1', maxSelect: '1', freeQty: '0', isActive: true, options: [{ name: '', description: '', price: '0', salePrice: '', isAvailable: true, maxQty: '1' }] }] })}><Plus className="h-4 w-4" /> Add group</Button>}>
        {v.modifierGroups.map((g: any, gi: number) => {
          const free = g.kind === 'included';
          return (
            <div key={gi} className={cn('mb-3 rounded-lg bg-stone-50 p-3', !g.isActive && 'opacity-70')}>
              <div className="flex flex-wrap items-end gap-2">
                <Order i={gi} count={v.modifierGroups.length} onMove={(d) => reorder('modifierGroups', gi, d)} />
                <Field label="Group name" className="min-w-[140px] flex-1"><Input value={g.name} maxLength={60} placeholder="e.g. Sauce" onChange={(e) => editGroup(gi, { name: e.target.value })} /></Field>
                <Field label="Type" className="w-44">
                  <Select value={g.kind} onChange={(e) => editGroup(gi, { kind: e.target.value })}>
                    <option value="included">Free / Included</option>
                    <option value="paid">Paid extra (adds)</option>
                  </Select>
                </Field>
                <Field label="Min" className="w-16"><Input type="number" min="0" value={g.minSelect} onChange={(e) => editGroup(gi, { minSelect: e.target.value })} /></Field>
                <Field label="Max" className="w-16"><Input type="number" min="1" value={g.maxSelect} onChange={(e) => editGroup(gi, { maxSelect: e.target.value })} /></Field>
                {!free && <Field label="Included free" className="w-24"><Input type="number" min="0" value={g.freeQty} onChange={(e) => editGroup(gi, { freeQty: e.target.value })} /></Field>}
                <div className="flex items-center gap-1 pb-1">
                  <Toggle checked={g.isActive} onChange={(isActive) => editGroup(gi, { isActive })} label="Active" />
                  <Button size="icon" variant="ghost" onClick={() => del('modifierGroups', gi)} aria-label="Remove group"><X className="h-4 w-4" /></Button>
                </div>
              </div>
              <p className="mt-1 text-[11px] text-stone-500">{int(g.minSelect) > 0 ? `Required: at least ${int(g.minSelect)}` : 'Optional'} · at most {int(g.maxSelect, 1)} · {free ? 'never charged' : 'each choice adds its price; 0 = included'}</p>
              <div className="mt-2 space-y-1.5 ps-3">
                {g.options.map((o: any, oi: number) => (
                  <div key={oi} className="flex flex-wrap items-center gap-2">
                    <Input className="h-9 min-w-[120px] flex-1" placeholder="Choice" value={o.name} maxLength={60} onChange={(e) => editOpt(gi, oi, { name: e.target.value })} />
                    <Input className="h-9 min-w-[120px] flex-1" placeholder="Description (optional)" value={o.description} maxLength={200} onChange={(e) => editOpt(gi, oi, { description: e.target.value })} />
                    {free ? <span className="w-24 text-xs font-medium text-emerald-700">Included</span> : (
                      <>
                        <Input className="h-9 w-24" type="number" step="0.01" min="0" value={o.price} onChange={(e) => editOpt(gi, oi, { price: e.target.value })} aria-label="Additional price" title="Additional price (0 = included)" />
                        <Input className="h-9 w-20" type="number" step="0.01" min="0" placeholder="Sale" value={o.salePrice} onChange={(e) => editOpt(gi, oi, { salePrice: e.target.value })} aria-label="Sale price" />
                      </>
                    )}
                    <Input className="h-9 w-16" type="number" min="1" max="20" value={o.maxQty} onChange={(e) => editOpt(gi, oi, { maxQty: e.target.value })} aria-label="Max per choice" title="Max of this choice" />
                    <Toggle checked={o.isAvailable} onChange={(isAvailable) => editOpt(gi, oi, { isAvailable })} />
                    <Button size="icon" variant="ghost" disabled={oi === 0} onClick={() => editGroup(gi, { options: move(g.options, oi, -1) })} aria-label="Move choice up"><ArrowUp className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" onClick={() => editGroup(gi, { options: g.options.filter((_: any, j: number) => j !== oi) })} aria-label="Remove choice"><X className="h-4 w-4" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={() => editGroup(gi, { options: [...g.options, { name: '', description: '', price: '0', salePrice: '', isAvailable: true, maxQty: '1' }] })}><Plus className="h-4 w-4" /> Choice</Button>
              </div>
            </div>
          );
        })}
      </Section>

      {/* ---------------- Removable ingredients (free) ---------------- */}
      <Section n={4} title="Removable ingredients · free" rule={'Shown to the kitchen as "No onions". Never changes the price. Link an ingredient to give it back to stock.'}
        action={<Button size="sm" variant="ghost" onClick={() => setV({ ...v, removableIngredients: [...v.removableIngredients, { name: '', isAvailable: true, ingredient: null }] })}><Plus className="h-4 w-4" /> Add</Button>}>
        {v.removableIngredients.map((r: any, i: number) => (
          <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
            <Order i={i} count={v.removableIngredients.length} onMove={(d) => reorder('removableIngredients', i, d)} />
            <Input className="min-w-[140px] flex-1" placeholder="e.g. Onions" value={r.name} maxLength={60} onChange={(e) => edit('removableIngredients', i, { name: e.target.value })} />
            <IngredientPicker inventory={inventory} label={r.name} value={r.ingredient} onChange={(ingredient) => edit('removableIngredients', i, { ingredient })} />
            <Toggle checked={r.isAvailable} onChange={(isAvailable) => edit('removableIngredients', i, { isAvailable })} />
            <Button size="icon" variant="ghost" onClick={() => del('removableIngredients', i)} aria-label="Remove ingredient"><X className="h-4 w-4" /></Button>
          </div>
        ))}
      </Section>

      {problems.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {problems.map((p) => <li key={p}>• {p}</li>)}
        </ul>
      )}
    </div>
  );
}
