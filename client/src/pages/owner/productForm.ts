/**
 * The dish editor's form <-> API request conversion, as pure functions (no React, no browser globals), so the
 * exact payload the admin sends is covered by tests (server/tests/integration/dishSave.test.ts).
 * Money in the form is in major units (strings, e.g. "700"); in the API it is integer minor units.
 */
import { toLocalInputValue, toMajor, toMinor } from '../../lib/money';

const str = (n: unknown) => (n == null ? '' : String(n));
const ing = (x: any) => (x?.inventoryItemId ? { inventoryItemId: x.inventoryItemId, quantity: str(x.quantity) } : null);

/** Product (minor units) → editable form strings (major units). */
export function optionsToForm(p: any, dec: number) {
  const m = (n: any) => (n == null ? '' : toMajor(n, dec));
  return {
    variantPricing: p._id ? (p.variantPricing === 'replace' ? 'replace' : 'add') : 'replace',
    variantGroupName: p.variantGroupName ?? '',
    // New dishes: the base price is orderable. Existing dishes: their saved setting (missing = required, as before).
    variantRequired: p._id ? p.variantRequired !== false : false,
    baseOptionLabel: p.baseOptionLabel ?? '',
    variants: (p.variants ?? []).map((v: any) => ({ _id: v._id, name: v.name, description: v.description ?? '', price: m(v.price), salePrice: m(v.salePrice), saleEndsAt: toLocalInputValue(v.saleEndsAt), priceDelta: m(v.priceDelta ?? 0), isActive: v.isActive !== false, recipeMultiplier: str(v.recipeMultiplier) })),
    addons: (p.addons ?? []).map((a: any) => ({ _id: a._id, name: a.name, description: a.description ?? '', price: m(a.price ?? 0), salePrice: m(a.salePrice), isAvailable: a.isAvailable !== false, maxQty: str(a.maxQty ?? 1), ingredient: ing(a.ingredient) })),
    modifierGroups: (p.modifierGroups ?? []).map((g: any) => ({
      _id: g._id, name: g.name, kind: g.kind === 'included' ? 'included' : 'paid', minSelect: str(g.minSelect ?? 0), maxSelect: str(g.maxSelect ?? 1), freeQty: str(g.freeQty ?? 0), isActive: g.isActive !== false,
      options: (g.options ?? []).map((o: any) => ({ _id: o._id, name: o.name, description: o.description ?? '', price: m(o.price ?? 0), salePrice: m(o.salePrice), isAvailable: o.isAvailable !== false, maxQty: str(o.maxQty ?? 1), ingredient: ing(o.ingredient) })),
    })),
    removableIngredients: (p.removableIngredients ?? []).map((r: any) => ({ _id: r._id, name: r.name, isAvailable: r.isAvailable !== false, ingredient: ing(r.ingredient) })),
  };
}

export const int = (s: any, d = 0) => (s === '' || s == null || Number.isNaN(Number(s)) ? d : Math.trunc(Number(s)));
const idPart = (x: any) => (x._id ? { _id: x._id } : {});
const ingBody = (x: any) => (x?.inventoryItemId && Number(x.quantity) > 0 ? { inventoryItemId: x.inventoryItemId, quantity: Number(x.quantity) } : null);
const money0 = (s: any, dec: number) => (s === '' || s == null ? null : toMinor(s, dec));

/** Form → request body (minor units). Only the fields that matter for the chosen pricing mode are sent. */
export function optionsToBody(v: any, dec: number) {
  const replace = v.variantPricing === 'replace';
  return {
    variantPricing: v.variantPricing,
    variantGroupName: v.variantGroupName.trim(),
    variantRequired: !!v.variantRequired,
    baseOptionLabel: v.baseOptionLabel.trim(),
    variants: v.variants.map((x: any) => ({
      ...idPart(x), name: x.name.trim(), description: x.description.trim(), isActive: !!x.isActive,
      ...(replace
        ? { price: money0(x.price, dec), salePrice: money0(x.salePrice, dec), saleEndsAt: x.saleEndsAt ? new Date(x.saleEndsAt).toISOString() : null, priceDelta: 0 }
        : { priceDelta: toMinor(x.priceDelta || 0, dec) }),
      recipeMultiplier: x.recipeMultiplier === '' ? null : Number(x.recipeMultiplier),
    })),
    addons: v.addons.map((x: any) => ({ ...idPart(x), name: x.name.trim(), description: x.description.trim(), price: toMinor(x.price || 0, dec), salePrice: money0(x.salePrice, dec), isAvailable: !!x.isAvailable, maxQty: Math.max(1, int(x.maxQty, 1)), ingredient: ingBody(x.ingredient) })),
    modifierGroups: v.modifierGroups.map((g: any) => {
      const free = g.kind === 'included';
      return {
        ...idPart(g), name: g.name.trim(), kind: g.kind, minSelect: int(g.minSelect), maxSelect: Math.max(1, int(g.maxSelect, 1)), freeQty: free ? 0 : int(g.freeQty), isActive: !!g.isActive,
        options: g.options.map((o: any) => ({ ...idPart(o), name: o.name.trim(), description: o.description.trim(), price: free ? 0 : toMinor(o.price || 0, dec), salePrice: free ? null : money0(o.salePrice, dec), isAvailable: !!o.isAvailable, maxQty: Math.max(1, int(o.maxQty, 1)), ingredient: ingBody(o.ingredient) })),
      };
    }),
    removableIngredients: v.removableIngredients.map((r: any) => ({ ...idPart(r), name: r.name.trim(), isAvailable: !!r.isAvailable, ingredient: ingBody(r.ingredient) })),
  };
}


export function blankProduct(categoryId?: string) {
  return { categoryId: categoryId ?? '', name: { en: '' }, description: {}, price: '', promoPrice: '', promoEndsAt: '', ...optionsToForm({}, 2), tags: '', isFeatured: false, isAvailable: true, trackStock: false, stockQty: 0, recipe: [], prepMinutes: 10, images: [] };
}
export function productToForm(p: any, dec: number) {
  return {
    ...p,
    price: toMajor(p.price, dec),
    promoPrice: p.promoPrice != null ? toMajor(p.promoPrice, dec) : '',
    promoEndsAt: toLocalInputValue(p.promoEndsAt), // local time, matching how the input value is parsed back
    ...optionsToForm(p, dec),
    tags: (p.tags ?? []).join(', '),
  };
}


/** The request body the dish editor sends (POST to create, PATCH to update). */
export function productFormToBody(v: any, dec: number) {
  return {
    categoryId: v.categoryId,
    name: v.name,
    description: v.description,
    price: toMinor(v.price, dec),
    promoPrice: v.promoPrice === '' ? null : toMinor(v.promoPrice, dec),
    promoEndsAt: v.promoEndsAt ? new Date(v.promoEndsAt).toISOString() : null,
    ...optionsToBody(v, dec), // options, extras, choice groups, removable ingredients (explicit pricing mode)
    tags: String(v.tags).split(',').map((s) => s.trim()).filter(Boolean),
    isFeatured: v.isFeatured,
    isAvailable: v.isAvailable,
    trackStock: v.trackStock,
    stockQty: Number(v.stockQty) || 0,
    recipe: v.recipe.filter((r: any) => r.inventoryItemId && Number(r.quantity) > 0).map((r: any) => ({ inventoryItemId: r.inventoryItemId, quantity: Number(r.quantity) })),
    prepMinutes: Number(v.prepMinutes) || 0,
  };
}
