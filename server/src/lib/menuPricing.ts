/**
 * Menu option pricing: the ONE place where a dish plus the customer's selections becomes a priced line.
 * Pure and dependency-free. The server uses it for every order, quote and added item; the browser uses a
 * VERBATIM copy (client/src/offline/menuPricing.ts) for product pages, cart, POS and offline estimates, so a
 * preview can never be computed with different rules. The server always re-resolves from database records:
 * a price sent by a browser is never used.
 *
 * PRICING RULES (all integer minor units)
 *  1. Selected base price
 *     - No option chosen: the dish's effective price (promo price while the promotion runs, otherwise the
 *       regular price). Unless the dish says options are required (variantRequired === true, or legacy dishes
 *       that never stored the flag), ordering at this base price is always a valid choice, shown to customers as
 *       its own option (baseOptionLabel, e.g. "Regular" or "Full Plate").
 *     - variantPricing 'replace' (sizes, portions, persons, packages, meal deals): the chosen option's OWN
 *       price REPLACES the dish price. Its effective price is its sale price while that sale runs, otherwise
 *       its price. The dish price is never added, and the dish promo is never applied to an option
 *       (each option carries its own sale price), so no discount can be applied twice.
 *     - variantPricing 'add' (legacy: dishes saved before replacement pricing existed): the dish's
 *       effective price + the option's priceDelta. Kept so existing menus keep charging what they charged.
 *  2. Extras (add to the price): effective price × quantity, quantity 1..maxQty (default 1). An extra's
 *     effective price is its sale price when set and lower, otherwise its price.
 *  3. Choice groups (sauce, crust, meal upgrade, substitutions, toppings): each selected unit charges its
 *     option's effective price (0 = included). Groups of kind 'included' are always free.
 *     The total selected in a group must be within minSelect..maxSelect.
 *     The group's first `freeQty` CHARGEABLE units are free, the lowest-priced ones first.
 *  4. Removable ingredients ("no onions") never change the price.
 *  5. Unit price = 1 + 2 + 3 (clamped at 0). Line total = unit price × quantity.
 *     Line discounts, coupon, order discount, service charge, delivery fee and tax are then applied ONCE,
 *     in a fixed order, by priceOrder() in ./pricing.
 *
 * INVENTORY (per unit sold): the dish recipe × the option's recipeMultiplier (default 1), plus each extra's
 * and choice's ingredient × its quantity, minus removed ingredients (never below zero).
 */
import { computeUnitPrice } from './pricing';

type Id = string | { toString(): string };

export interface RecipeRef {
  inventoryItemId: Id;
  quantity: number;
}
export interface MenuVariant {
  _id?: Id;
  name: string;
  priceDelta?: number | null; // 'add' mode
  price?: number | null; // 'replace' mode: full price
  salePrice?: number | null; // 'replace' mode: discounted full price
  saleEndsAt?: string | Date | null;
  isActive?: boolean | null;
  recipeMultiplier?: number | null;
  description?: string | null;
}
export interface MenuOption {
  _id?: Id;
  name: string;
  description?: string | null;
  price?: number | null;
  salePrice?: number | null; // lower price while set
  isAvailable?: boolean | null;
  maxQty?: number | null;
  ingredient?: RecipeRef | null;
}
export interface MenuChoiceGroup {
  _id?: Id;
  name: string;
  minSelect?: number | null;
  maxSelect?: number | null;
  freeQty?: number | null;
  isActive?: boolean | null;
  /** 'paid' (default): choices may cost extra (0 = included). 'included': every choice is free. */
  kind?: 'paid' | 'included' | null;
  options: MenuOption[];
}
export interface MenuRemovable {
  _id?: Id;
  name: string;
  isAvailable?: boolean | null;
  ingredient?: RecipeRef | null;
}
export interface MenuProduct {
  _id?: Id;
  name: string | { en?: string };
  price: number;
  promoPrice?: number | null;
  promoEndsAt?: string | Date | null;
  variantPricing?: 'replace' | 'add' | null;
  variantRequired?: boolean | null;
  /** Name customers see for ordering at the base price when options are optional (e.g. "Regular", "Full Plate"). */
  baseOptionLabel?: string | null;
  variants?: MenuVariant[];
  addons?: MenuOption[];
  modifierGroups?: MenuChoiceGroup[];
  removableIngredients?: MenuRemovable[];
  recipe?: RecipeRef[];
}

/** What a customer or cashier chose. Prices are never part of a selection. */
export interface ItemSelection {
  variantId?: string;
  /** Legacy form: each extra once. Merged with `addons`. */
  addonIds?: string[];
  addons?: { id: string; quantity?: number }[];
  choices?: { groupId: string; optionId: string; quantity?: number }[];
  removeIds?: string[];
}

export interface ResolvedAddon {
  id: string;
  name: string;
  price: number; // charged per unit
  quantity: number;
  group?: string;
  included?: boolean; // free units of a choice group
}

export interface ResolvedSelection {
  pricingMode: 'none' | 'replace' | 'add';
  variantId?: string;
  variantName?: string;
  /** Selected base price (see rule 1). */
  basePrice: number;
  /** The same before any sale/promo, for "was" display. */
  listPrice: number;
  /** Legacy 'add' mode only. */
  variantDelta: number;
  addons: ResolvedAddon[];
  removed: string[];
  unitPrice: number;
  /** Ingredients used by ONE unit of this item. */
  consumption: { inventoryItemId: string; quantity: number }[];
}

export class SelectionError extends Error {}

const idOf = (x: { _id?: Id } | null | undefined) => (x?._id == null ? '' : String(x._id));
export const productName = (p: Pick<MenuProduct, 'name'>) => (typeof p.name === 'string' ? p.name : p.name?.en ?? '');
const dateOf = (d: string | Date | null | undefined) => (d == null || d === '' ? null : new Date(d));

function saleActive(price: number, sale: number | null | undefined, endsAt: string | Date | null | undefined, now: Date) {
  const end = dateOf(endsAt);
  return sale != null && sale < price && (!end || end > now);
}

/** Dish price considering a running promotion. */
export function productEffectivePrice(p: Pick<MenuProduct, 'price' | 'promoPrice' | 'promoEndsAt'>, now = new Date()): number {
  return saleActive(p.price, p.promoPrice, p.promoEndsAt, now) ? p.promoPrice! : p.price;
}

export const variantPricingMode = (p: Pick<MenuProduct, 'variantPricing'>): 'replace' | 'add' => (p.variantPricing === 'replace' ? 'replace' : 'add');
export const activeVariants = (p: Pick<MenuProduct, 'variants'>) => (p.variants ?? []).filter((v) => v.isActive !== false);
/**
 * Must the customer choose an option? Saved explicitly on every dish since base-price ordering exists; dishes
 * that never stored the flag keep their old behaviour (a choice was always required) until the owner reviews them.
 */
export const variantIsRequired = (p: Pick<MenuProduct, 'variantRequired'>) => p.variantRequired !== false;

/** Price of an extra or choice: its sale price when set and lower than the price. */
export function optionEffectivePrice(o: Pick<MenuOption, 'price' | 'salePrice'>): number {
  const price = o.price ?? 0;
  return o.salePrice != null && o.salePrice < price ? o.salePrice : price;
}

/** What a customer pays for this option before extras (rule 1). */
export function variantEffectivePrice(p: MenuProduct, v: MenuVariant, now = new Date()): number {
  if (variantPricingMode(p) === 'replace') {
    const price = v.price ?? 0;
    return saleActive(price, v.salePrice, v.saleEndsAt, now) ? v.salePrice! : price;
  }
  return Math.max(0, productEffectivePrice(p, now) + (v.priceDelta ?? 0));
}

/** The option's price before any sale/promo. */
export function variantListPrice(p: MenuProduct, v: MenuVariant): number {
  return variantPricingMode(p) === 'replace' ? v.price ?? 0 : Math.max(0, p.price + (v.priceDelta ?? 0));
}

/**
 * Price to show on menu cards: the cheapest purchasable configuration, flagged `from` when other options cost
 * more. `original` is the matching price before sale/promo (equal to `amount` when nothing is discounted).
 */
export function displayPrice(p: MenuProduct, now = new Date()): { amount: number; original: number; from: boolean } {
  const opts: { amount: number; original: number }[] = activeVariants(p).map((v) => ({ amount: variantEffectivePrice(p, v, now), original: variantListPrice(p, v) }));
  if (!opts.length || !variantIsRequired(p)) opts.push({ amount: productEffectivePrice(p, now), original: p.price });
  const min = opts.reduce((a, b) => (b.amount < a.amount ? b : a));
  return { amount: min.amount, original: Math.max(min.amount, min.original), from: opts.some((o) => o.amount !== min.amount) };
}

export interface NormalizedSelection {
  variantId?: string;
  addons: { id: string; quantity: number }[];
  choices: { groupId: string; optionId: string; quantity: number }[];
  removeIds: string[];
}

/** Canonical form of a selection: merged, sorted, without zero quantities. Equal configurations → equal keys. */
export function normalizeSelection(sel: ItemSelection = {}): NormalizedSelection {
  const addons = new Map<string, number>();
  for (const id of sel.addonIds ?? []) addons.set(id, (addons.get(id) ?? 0) + 1);
  for (const a of sel.addons ?? []) addons.set(a.id, (addons.get(a.id) ?? 0) + (a.quantity ?? 1));
  const choices = new Map<string, number>();
  for (const c of sel.choices ?? []) {
    const k = `${c.groupId}:${c.optionId}`;
    choices.set(k, (choices.get(k) ?? 0) + (c.quantity ?? 1));
  }
  return {
    ...(sel.variantId ? { variantId: sel.variantId } : {}),
    addons: [...addons].filter(([, q]) => q > 0).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, quantity]) => ({ id, quantity })),
    choices: [...choices].filter(([, q]) => q > 0).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, quantity]) => ({ groupId: k.split(':')[0], optionId: k.split(':')[1], quantity })),
    removeIds: [...new Set(sel.removeIds ?? [])].sort(),
  };
}

/** Stable key of a configuration (cart / POS lines merge only when it is identical). */
export function selectionKey(productId: string, sel: ItemSelection = {}): string {
  const n = normalizeSelection(sel);
  return [productId, n.variantId ?? '', n.addons.map((a) => `${a.id}x${a.quantity}`).join('+'), n.choices.map((c) => `${c.groupId}:${c.optionId}x${c.quantity}`).join('+'), n.removeIds.join('+')].join('|');
}

/**
 * Validates a selection against the dish and prices it with the rules above.
 * Throws SelectionError with a customer-readable message for anything missing, unknown, unavailable or out of range.
 */
export function resolveSelection(p: MenuProduct, selection: ItemSelection = {}, now = new Date()): ResolvedSelection {
  const name = productName(p);
  const sel = normalizeSelection(selection);
  const consumption = new Map<string, number>();
  const use = (r: RecipeRef | null | undefined, times: number) => {
    if (!r || !r.inventoryItemId || !(r.quantity > 0) || !(times > 0)) return;
    const k = String(r.inventoryItemId);
    consumption.set(k, (consumption.get(k) ?? 0) + r.quantity * times);
  };

  /* 1. Base price */
  const variants = p.variants ?? [];
  let variant: MenuVariant | undefined;
  if (sel.variantId) {
    variant = variants.find((v) => idOf(v) === sel.variantId);
    if (!variant) throw new SelectionError(`Invalid option for ${name}`);
    if (variant.isActive === false) throw new SelectionError(`“${variant.name}” is no longer available for ${name}`);
  } else if (variants.length && variantIsRequired(p)) {
    if (!activeVariants(p).length) throw new SelectionError(`${name} is currently unavailable`);
    throw new SelectionError(`Please choose an option for ${name}`);
  }
  const mode = variant ? variantPricingMode(p) : 'none';
  const basePrice = !variant ? productEffectivePrice(p, now) : mode === 'replace' ? variantEffectivePrice(p, variant, now) : productEffectivePrice(p, now);
  const listPrice = !variant ? p.price : variantListPrice(p, variant);
  const variantDelta = variant && mode === 'add' ? variant.priceDelta ?? 0 : 0;
  for (const r of p.recipe ?? []) use(r, variant?.recipeMultiplier && variant.recipeMultiplier > 0 ? variant.recipeMultiplier : 1);

  /* 2. Extras */
  const addons: ResolvedAddon[] = [];
  for (const s of sel.addons) {
    const a = (p.addons ?? []).find((x) => idOf(x) === s.id);
    if (!a || a.isAvailable === false) throw new SelectionError(`Invalid add-on for ${name}`);
    const max = a.maxQty && a.maxQty > 0 ? a.maxQty : 1;
    if (!Number.isInteger(s.quantity) || s.quantity < 1) throw new SelectionError(`Invalid quantity of ${a.name}`);
    if (s.quantity > max) throw new SelectionError(`${name}: at most ${max} × ${a.name}`);
    addons.push({ id: s.id, name: a.name, price: optionEffectivePrice(a), quantity: s.quantity });
    use(a.ingredient, s.quantity);
  }

  /* 3. Choice groups */
  const groups = p.modifierGroups ?? [];
  for (const c of sel.choices) {
    const g = groups.find((x) => idOf(x) === c.groupId);
    if (!g || g.isActive === false) throw new SelectionError(`Invalid choice for ${name}`);
    const o = g.options.find((x) => idOf(x) === c.optionId);
    if (!o || o.isAvailable === false) throw new SelectionError(`“${o?.name ?? 'This choice'}” is not available for ${name}`);
    const max = o.maxQty && o.maxQty > 0 ? o.maxQty : 1;
    if (!Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > max) throw new SelectionError(`${g.name}: at most ${max} × ${o.name}`);
  }
  for (const g of groups) {
    if (g.isActive === false) continue;
    const picked = sel.choices.filter((c) => c.groupId === idOf(g));
    const count = picked.reduce((s, c) => s + c.quantity, 0);
    const min = g.minSelect ?? 0;
    const max = g.maxSelect ?? Math.max(1, count);
    if (count < min) throw new SelectionError(min === 1 && max === 1 ? `Please choose ${g.name} for ${name}` : `Choose at least ${min} for ${g.name} (${name})`);
    if (count > max) throw new SelectionError(`Choose at most ${max} for ${g.name} (${name})`);
    // Free units go to the cheapest selected units first (stable for equal prices).
    const units = picked.flatMap((c) => {
      const o = g.options.find((x) => idOf(x) === c.optionId)!;
      const price = g.kind === 'included' ? 0 : optionEffectivePrice(o);
      return Array.from({ length: c.quantity }, () => ({ id: c.optionId, name: o.name, price }));
    });
    units.sort((a, b) => a.price - b.price);
    let free = Math.max(0, g.freeQty ?? 0);
    const tally = new Map<string, { name: string; price: number; free: number; paid: number }>();
    for (const u of units) {
      const t = tally.get(u.id) ?? { name: u.name, price: u.price, free: 0, paid: 0 };
      if (free > 0 && u.price > 0) {
        t.free++;
        free--;
      } else t.paid++;
      tally.set(u.id, t);
    }
    for (const [id, t] of tally) {
      if (t.free) addons.push({ id, name: t.name, price: 0, quantity: t.free, group: g.name, included: true });
      if (t.paid) addons.push({ id, name: t.name, price: t.price, quantity: t.paid, group: g.name });
      const o = g.options.find((x) => idOf(x) === id)!;
      use(o.ingredient, t.free + t.paid);
    }
  }

  /* 4. Removed ingredients (never priced) */
  const removed: string[] = [];
  for (const rid of sel.removeIds) {
    const r = (p.removableIngredients ?? []).find((x) => idOf(x) === rid);
    if (!r || r.isAvailable === false) throw new SelectionError(`Invalid ingredient for ${name}`);
    removed.push(r.name);
    if (r.ingredient?.inventoryItemId && r.ingredient.quantity > 0) {
      const k = String(r.ingredient.inventoryItemId);
      if (consumption.has(k)) consumption.set(k, Math.max(0, consumption.get(k)! - r.ingredient.quantity));
    }
  }

  const unitPrice = computeUnitPrice({ productId: idOf(p), name, basePrice, variantDelta, addons, quantity: 1 });
  return {
    pricingMode: mode,
    ...(variant ? { variantId: idOf(variant), variantName: variant.name } : {}),
    basePrice,
    listPrice: Math.max(basePrice, listPrice),
    variantDelta,
    addons,
    removed,
    unitPrice,
    consumption: [...consumption].filter(([, q]) => q > 0).map(([inventoryItemId, q]) => ({ inventoryItemId, quantity: Math.round(q * 1e6) / 1e6 })),
  };
}

/**
 * Configuration checks for a dish (used when it is saved, and by the editor to show problems early).
 * Returns readable problems; an empty list means the configuration is unambiguous and valid.
 */
export function validateProductOptions(p: MenuProduct): string[] {
  const errs: string[] = [];
  const int = (n: unknown) => typeof n === 'number' && Number.isInteger(n);
  const variants = p.variants ?? [];
  const mode = variantPricingMode(p);
  const names = new Set<string>();
  for (const v of variants) {
    const label = `Option “${v.name}”`;
    if (!v.name?.trim()) errs.push('Every option needs a name');
    if (names.has(v.name?.trim().toLowerCase())) errs.push(`${label} is listed twice`);
    names.add(v.name?.trim().toLowerCase());
    if (mode === 'replace') {
      if (!int(v.price) || v.price! < 0) errs.push(`${label} needs its full price`);
      if (v.salePrice != null && (!int(v.salePrice) || v.salePrice < 0 || (int(v.price) && v.salePrice >= v.price!))) errs.push(`${label}: the sale price must be lower than its price`);
    } else if (v.priceDelta != null && !int(v.priceDelta)) errs.push(`${label}: invalid amount`);
    if (v.recipeMultiplier != null && !(v.recipeMultiplier > 0 && v.recipeMultiplier <= 100)) errs.push(`${label}: ingredient multiplier must be between 0 and 100`);
  }
  for (const a of p.addons ?? []) {
    if (!a.name?.trim()) errs.push('Every extra needs a name');
    if (!int(a.price ?? 0) || (a.price ?? 0) < 0) errs.push(`Extra “${a.name}”: invalid price`);
    if (a.salePrice != null && (!int(a.salePrice) || a.salePrice < 0 || a.salePrice >= (a.price ?? 0))) errs.push(`Extra “${a.name}”: the sale price must be lower than its price`);
    if (a.maxQty != null && (!int(a.maxQty) || a.maxQty < 1 || a.maxQty > 20)) errs.push(`Extra “${a.name}”: maximum quantity must be 1–20`);
  }
  for (const g of p.modifierGroups ?? []) {
    const label = `Choice group “${g.name}”`;
    if (!g.name?.trim()) errs.push('Every choice group needs a name');
    if (!g.options?.length) errs.push(`${label} has no choices`);
    const min = g.minSelect ?? 0;
    const max = g.maxSelect ?? 1;
    if (!int(min) || min < 0) errs.push(`${label}: invalid minimum`);
    if (!int(max) || max < 1) errs.push(`${label}: maximum must be at least 1`);
    if (min > max) errs.push(`${label}: minimum is above maximum`);
    if (g.freeQty != null && (!int(g.freeQty) || g.freeQty < 0 || g.freeQty > max)) errs.push(`${label}: included (free) quantity must be between 0 and the maximum`);
    const capacity = (g.options ?? []).filter((o) => o.isAvailable !== false).reduce((s, o) => s + (o.maxQty && o.maxQty > 0 ? o.maxQty : 1), 0);
    if (g.isActive !== false && min > capacity) errs.push(`${label}: requires ${min} choices but only ${capacity} can be chosen`);
    for (const o of g.options ?? []) {
      if (!o.name?.trim()) errs.push(`${label}: every choice needs a name`);
      if (!int(o.price ?? 0) || (o.price ?? 0) < 0) errs.push(`${label}: invalid price for “${o.name}”`);
      if (g.kind === 'included' && ((o.price ?? 0) !== 0 || o.salePrice != null)) errs.push(`${label} is free/included, so “${o.name}” cannot have a price`);
      if (o.salePrice != null && (!int(o.salePrice) || o.salePrice < 0 || o.salePrice >= (o.price ?? 0))) errs.push(`${label}: the sale price of “${o.name}” must be lower than its price`);
      if (o.maxQty != null && (!int(o.maxQty) || o.maxQty < 1 || o.maxQty > 20)) errs.push(`${label}: maximum per choice must be 1–20`);
    }
  }
  for (const r of p.removableIngredients ?? []) if (!r.name?.trim()) errs.push('Every removable ingredient needs a name');
  return errs;
}
