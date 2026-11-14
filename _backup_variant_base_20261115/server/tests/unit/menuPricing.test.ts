/**
 * Option pricing rules (lib/menuPricing.ts) — regression tests for the Halwa Puri bug (Three Persons was
 * charged 850 + 2,000 = 2,850) and for every option type a real menu uses.
 * Amounts are written in rupees and converted to minor units (paisa) with R().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayPrice, normalizeSelection, resolveSelection, selectionKey, SelectionError, validateProductOptions, type MenuProduct } from '../../src/lib/menuPricing';
import { priceOrder } from '../../src/lib/pricing';

const R = (rupees: number) => rupees * 100;
const NOW = new Date('2026-11-14T12:00:00Z');
const LATER = new Date('2026-12-31T00:00:00Z');
const EARLIER = new Date('2026-11-01T00:00:00Z');

const halwaPuri = (): MenuProduct => ({
  _id: 'p1',
  name: { en: 'Halwa Puri' },
  price: R(1000),
  promoPrice: R(850),
  variantPricing: 'replace',
  variantGroupName: 'Persons',
  variants: [
    { _id: 'single', name: 'Single Person', price: R(500) },
    { _id: 'two', name: 'Two Persons', price: R(1000) },
    { _id: 'three', name: 'Three Persons', price: R(2000) },
    { _id: 'old', name: 'Family (retired)', price: R(3000), isActive: false },
  ],
  addons: [
    { _id: 'cheese', name: 'Extra Cheese', price: R(100), maxQty: 2 },
    { _id: 'puri', name: 'Extra Puri', price: R(60), maxQty: 4, ingredient: { inventoryItemId: 'inv-puri', quantity: 1 } },
    { _id: 'gone', name: 'Extra Halwa', price: R(80), isAvailable: false },
  ],
  recipe: [{ inventoryItemId: 'inv-puri', quantity: 2 }, { inventoryItemId: 'inv-halwa', quantity: 0.1 }],
} as any);

const unit = (p: MenuProduct, sel: any) => resolveSelection(p, sel, NOW).unitPrice;
const err = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: any) => e instanceof SelectionError && re.test(e.message));

/* ---------------------------------------------------------------- the reported bug */

test('Halwa Puri: a person option REPLACES the dish price (Three Persons = 2,000, never 2,850)', () => {
  const p = halwaPuri();
  assert.equal(unit({ ...p, variants: [] }, {}), R(850), 'no options: discounted dish price');
  assert.equal(unit(p, { variantId: 'single' }), R(500));
  assert.equal(unit(p, { variantId: 'two' }), R(1000));
  assert.equal(unit(p, { variantId: 'three' }), R(2000));
  assert.notEqual(unit(p, { variantId: 'three' }), R(2850));
  const r = resolveSelection(p, { variantId: 'three' }, NOW);
  assert.equal(r.pricingMode, 'replace');
  assert.equal(r.basePrice, R(2000));
  assert.equal(r.variantDelta, 0);
  assert.equal(r.variantName, 'Three Persons');
});

test('extras are ADDED per unit: Three Persons + Extra Cheese = 2,100; + two = 2,200; two such orders = 4,000', () => {
  const p = halwaPuri();
  assert.equal(unit(p, { variantId: 'three', addons: [{ id: 'cheese', quantity: 1 }] }), R(2100));
  assert.equal(unit(p, { variantId: 'three', addons: [{ id: 'cheese', quantity: 2 }] }), R(2200));
  assert.equal(unit(p, { variantId: 'three', addonIds: ['cheese', 'cheese'] }), R(2200), 'legacy addonIds form merges the same way');
  const r = resolveSelection(p, { variantId: 'three' }, NOW);
  const priced = priceOrder([{ productId: 'p1', name: 'Halwa Puri', basePrice: r.basePrice, variantDelta: r.variantDelta, addons: r.addons, quantity: 2 }], { taxRatePercent: 0, taxInclusive: false, serviceChargePercent: 0 });
  assert.equal(priced.lines[0].unitPrice, R(2000));
  assert.equal(priced.total, R(4000));
});

test('required option missing, unknown or inactive is rejected', () => {
  const p = halwaPuri();
  err(() => resolveSelection(p, {}, NOW), /Please choose an option for Halwa Puri/);
  err(() => resolveSelection(p, { variantId: 'nope' }, NOW), /Invalid option/);
  err(() => resolveSelection(p, { variantId: 'old' }, NOW), /no longer available/);
  err(() => resolveSelection(p, { variantId: 'three', addons: [{ id: 'cheese', quantity: 3 }] }, NOW), /at most 2 × Extra Cheese/);
  err(() => resolveSelection(p, { variantId: 'three', addonIds: ['gone'] }, NOW), /Invalid add-on/);
  err(() => resolveSelection(p, { variantId: 'three', addonIds: ['missing'] }, NOW), /Invalid add-on/);
  err(() => resolveSelection({ ...p, variants: p.variants!.map((v) => ({ ...v, isActive: false })) }, {}, NOW), /currently unavailable/);
});

test('optional options: no choice = dish price; a choice still replaces it', () => {
  const p = { ...halwaPuri(), variantRequired: false };
  assert.equal(unit(p, {}), R(850));
  assert.equal(unit(p, { variantId: 'single' }), R(500));
});

/* ---------------------------------------------------------------- discounts */

test('option sale prices: own sale applies while it runs; the dish promo is never stacked on an option', () => {
  const p = halwaPuri();
  p.variants![2] = { _id: 'three', name: 'Three Persons', price: R(2000), salePrice: R(1800), saleEndsAt: LATER };
  const r = resolveSelection(p, { variantId: 'three' }, NOW);
  assert.equal(r.basePrice, R(1800));
  assert.equal(r.listPrice, R(2000), 'original shown as "was"');
  // Expired sale → regular option price; and the dish promo (850 of 1000) is NOT applied to the option.
  p.variants![2].saleEndsAt = EARLIER;
  assert.equal(unit(p, { variantId: 'three' }), R(2000));
  // No 15% "inherited" promo either: 2,000 stays 2,000 (not 1,700).
  assert.notEqual(unit(p, { variantId: 'three' }), R(1700));
});

test('a discount is applied exactly once through the whole order pipeline', () => {
  const p = halwaPuri();
  p.variants![2] = { _id: 'three', name: 'Three Persons', price: R(2000), salePrice: R(1800) };
  const r = resolveSelection(p, { variantId: 'three' }, NOW);
  const res = priceOrder(
    [{ productId: 'p1', name: 'x', basePrice: r.basePrice, variantDelta: r.variantDelta, addons: r.addons, quantity: 1, lineDiscount: { type: 'percent', value: 10 } }],
    { taxRatePercent: 0, taxInclusive: false, serviceChargePercent: 0 },
    { code: 'TEN', type: 'fixed', value: R(100) },
  );
  // 1,800 (option sale) − 180 (10% line) − 100 (coupon) = 1,520. No step is repeated.
  assert.equal(res.subtotal, R(1800));
  assert.equal(res.lineDiscount, R(180));
  assert.equal(res.couponDiscount, R(100));
  assert.equal(res.total, R(1520));
});

test('legacy additive products keep charging exactly what they charged before', () => {
  const tikka: MenuProduct = { _id: 't', name: 'Chicken Tikka', price: R(1150), promoPrice: R(990), variants: [{ _id: 'leg', name: 'Leg', priceDelta: 0 }, { _id: 'breast', name: 'Breast', priceDelta: R(100) }] } as any;
  assert.equal(unit(tikka, { variantId: 'leg' }), R(990));
  assert.equal(unit(tikka, { variantId: 'breast' }), R(1090));
  assert.equal(resolveSelection(tikka, { variantId: 'breast' }, NOW).pricingMode, 'add');
});

/* ---------------------------------------------------------------- choice groups & removals */

const pizza = (): MenuProduct => ({
  _id: 'pz',
  name: 'Pizza',
  price: R(900),
  variantPricing: 'replace',
  variants: [{ _id: 's', name: 'Small', price: R(900) }, { _id: 'm', name: 'Medium', price: R(1400) }, { _id: 'l', name: 'Large', price: R(1900) }],
  addons: [{ _id: 'xc', name: 'Extra cheese', price: R(150), maxQty: 2 }],
  modifierGroups: [
    { _id: 'crust', name: 'Crust', minSelect: 1, maxSelect: 1, options: [{ _id: 'thin', name: 'Thin', price: 0 }, { _id: 'stuffed', name: 'Stuffed crust', price: R(250) }] },
    { _id: 'top', name: 'Toppings', minSelect: 0, maxSelect: 4, freeQty: 2, options: [{ _id: 'olive', name: 'Olives', price: R(80) }, { _id: 'mush', name: 'Mushrooms', price: R(100) }, { _id: 'jal', name: 'Jalapeños', price: R(120), maxQty: 2 }] },
    { _id: 'old', name: 'Retired', minSelect: 1, maxSelect: 1, isActive: false, options: [{ _id: 'x', name: 'X', price: R(1) }] },
  ],
  removableIngredients: [{ _id: 'onion', name: 'Onions' }, { _id: 'tom', name: 'Tomato', ingredient: { inventoryItemId: 'inv-tom', quantity: 0.05 } }],
  recipe: [{ inventoryItemId: 'inv-tom', quantity: 0.1 }],
} as any);

test('pizza: size replaces the price, crust choice may cost extra, extras add on top', () => {
  const p = pizza();
  const crust = (id: string) => ({ groupId: 'crust', optionId: id });
  assert.equal(unit(p, { variantId: 'm', choices: [crust('thin')] }), R(1400));
  assert.equal(unit(p, { variantId: 'l', choices: [crust('stuffed')] }), R(2150));
  assert.equal(unit(p, { variantId: 'l', choices: [crust('stuffed')], addons: [{ id: 'xc', quantity: 2 }] }), R(2450));
  err(() => resolveSelection(p, { variantId: 'm' }, NOW), /Please choose Crust/);
  err(() => resolveSelection(p, { variantId: 'm', choices: [crust('thin'), crust('stuffed')] }, NOW), /at most 1 for Crust/);
  err(() => resolveSelection(p, { variantId: 'm', choices: [crust('thin'), { groupId: 'old', optionId: 'x' }] }, NOW), /Invalid choice/);
  err(() => resolveSelection(p, { variantId: 'm', choices: [crust('nope')] }, NOW), /not available/);
});

test('included toppings: the first 2 chargeable units are free, cheapest first; the rest are charged', () => {
  const p = pizza();
  const base = { variantId: 's', choices: [{ groupId: 'crust', optionId: 'thin' }] };
  const tops = (...c: any[]) => ({ ...base, choices: [...base.choices, ...c.map(([optionId, quantity]: any) => ({ groupId: 'top', optionId, quantity }))] });
  assert.equal(unit(p, tops(['olive', 1], ['mush', 1])), R(900), 'two included toppings');
  // 4 units: olive 80, mush 100, jal 120 ×2 → olives+mushrooms free, 2 × jalapeños charged = 240
  const r = resolveSelection(p, tops(['olive', 1], ['mush', 1], ['jal', 2]), NOW);
  assert.equal(r.unitPrice, R(900 + 240));
  assert.deepEqual(r.addons.filter((a) => a.included).map((a) => a.name).sort(), ['Mushrooms', 'Olives']);
  err(() => resolveSelection(p, tops(['olive', 1], ['mush', 1], ['jal', 2], ['olive', 1]), NOW), /at most 1 × Olives|at most 4 for Toppings/);
});

test('removing an ingredient never changes the price and is recorded for the kitchen', () => {
  const p = pizza();
  const sel = { variantId: 'm', choices: [{ groupId: 'crust', optionId: 'thin' }] };
  const r = resolveSelection(p, { ...sel, removeIds: ['onion', 'tom'] }, NOW);
  assert.equal(r.unitPrice, R(1400));
  assert.deepEqual(r.removed, ['Onions', 'Tomato']);
  err(() => resolveSelection(p, { ...sel, removeIds: ['cheese'] }, NOW), /Invalid ingredient/);
});

/* ---------------------------------------------------------------- inventory per unit */

test('ingredient use follows the selection: option multiplier, extras, removals', () => {
  const p = halwaPuri();
  p.variants![2].recipeMultiplier = 3;
  const r = resolveSelection(p, { variantId: 'three', addons: [{ id: 'puri', quantity: 2 }] }, NOW);
  const use = Object.fromEntries(r.consumption.map((c) => [c.inventoryItemId, c.quantity]));
  assert.equal(use['inv-puri'], 2 * 3 + 2, '3 portions of 2 puris + 2 extra');
  assert.equal(use['inv-halwa'], 0.3);
  const pz = resolveSelection(pizza(), { variantId: 's', choices: [{ groupId: 'crust', optionId: 'thin' }], removeIds: ['tom'] }, NOW);
  assert.equal(pz.consumption.find((c) => c.inventoryItemId === 'inv-tom')?.quantity, 0.05, 'removed tomato is not used');
});

/* ---------------------------------------------------------------- display, keys, validation */

test('menu cards show the cheapest real price ("from") and the matching original', () => {
  assert.deepEqual(displayPrice(halwaPuri(), NOW), { amount: R(500), original: R(500), from: true });
  assert.deepEqual(displayPrice({ ...halwaPuri(), variants: [] }, NOW), { amount: R(850), original: R(1000), from: false });
  assert.deepEqual(displayPrice({ ...halwaPuri(), variantRequired: false }, NOW).amount, R(500));
});

test('different configurations never merge into one cart line; identical ones always do', () => {
  const a = selectionKey('p1', { variantId: 'three', addonIds: ['cheese'] });
  assert.equal(a, selectionKey('p1', { variantId: 'three', addons: [{ id: 'cheese', quantity: 1 }] }));
  assert.notEqual(a, selectionKey('p1', { variantId: 'three', addons: [{ id: 'cheese', quantity: 2 }] }));
  assert.notEqual(a, selectionKey('p1', { variantId: 'two', addonIds: ['cheese'] }));
  assert.notEqual(selectionKey('p1', {}), selectionKey('p1', { removeIds: ['onion'] }));
  assert.deepEqual(normalizeSelection({ removeIds: ['b', 'a', 'a'] }).removeIds, ['a', 'b']);
});

test('ambiguous or invalid option configuration is reported before it can be saved', () => {
  assert.deepEqual(validateProductOptions(halwaPuri()), []);
  const bad = halwaPuri();
  bad.variants = [{ _id: 'a', name: 'Three Persons', priceDelta: R(2000) } as any];
  assert.match(validateProductOptions(bad).join(), /needs its full price/);
  bad.variants = [{ _id: 'a', name: 'Single', price: R(500), salePrice: R(600) }];
  assert.match(validateProductOptions(bad).join(), /sale price must be lower/);
  bad.variants = [{ _id: 'a', name: 'Single', price: R(500) }, { _id: 'b', name: 'single', price: R(600) }];
  assert.match(validateProductOptions(bad).join(), /listed twice/);
  const pz = pizza();
  pz.modifierGroups![0].minSelect = 3;
  assert.match(validateProductOptions(pz).join(), /requires 3 choices but only 2/);
  pz.modifierGroups![0] = { ...pz.modifierGroups![0], minSelect: 2, maxSelect: 1 };
  assert.match(validateProductOptions(pz).join(), /minimum is above maximum/);
});
