/**
 * Chicken Biryani: base price 700 must stay orderable, a complete-price variant REPLACES it, paid extras ADD.
 * Engine (server + browser copy), the picker's selection changes, cart line keys, included / sale choices,
 * and the read-only review audit for old dishes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../../src/lib/menuPricing';
import * as client from '../../../client/src/offline/menuPricing';
import { chooseVariant, setChoiceQuantity, setExtraQuantity, toggleRemoval, selectionSummary } from '../../../client/src/lib/options';
import { priceOrder } from '../../src/lib/pricing';
import { auditProducts } from '../../src/services/optionAudit';

const R = (rupees: number) => rupees * 100;

const biryani = () => ({
  _id: 'b1',
  name: { en: 'Chicken Biryani' },
  price: R(700),
  variantPricing: 'replace' as const,
  variantRequired: false,
  baseOptionLabel: 'Full Plate',
  variantGroupName: 'Choose your portion',
  variants: [
    { _id: 'half', name: 'Half Plate', price: R(300) },
    { _id: 'double', name: 'Double Chicken', price: R(600) },
    { _id: 'family', name: 'Family Pack', price: R(2000), isActive: false },
  ],
  addons: [
    { _id: 'cheese', name: 'Extra Cheese', price: R(100), maxQty: 3 },
    { _id: 'egg', name: 'Extra Egg', price: R(80) },
    { _id: 'raita', name: 'Raita', price: R(60), isAvailable: false },
  ],
  modifierGroups: [
    { _id: 'spice', name: 'Spice level', kind: 'included' as const, minSelect: 0, maxSelect: 1, options: [{ _id: 'mild', name: 'Mild' }, { _id: 'hot', name: 'Hot' }] },
  ],
  removableIngredients: [{ _id: 'onion', name: 'Fried onions' }],
});

const unit = (sel: server.ItemSelection, p: any = biryani()) => {
  const s = server.resolveSelection(p, sel).unitPrice;
  assert.equal(client.resolveSelection(p, sel).unitPrice, s, 'browser preview and server must agree');
  return s;
};
const cheese = (quantity: number) => ({ addons: [{ id: 'cheese', quantity }] });

test('the required price table: base orderable, variants replace, extras add', () => {
  const table: [string, server.ItemSelection, number][] = [
    ['Base price, no selection', {}, R(700)],
    ['Half Plate', { variantId: 'half' }, R(300)],
    ['Double Chicken', { variantId: 'double' }, R(600)],
    ['Base + Extra Cheese', cheese(1), R(800)],
    ['Half Plate + Extra Cheese', { variantId: 'half', ...cheese(1) }, R(400)],
    ['Double Chicken + Extra Cheese', { variantId: 'double', ...cheese(1) }, R(700)],
    ['Half Plate + 2 Extra Cheese', { variantId: 'half', ...cheese(2) }, R(500)],
    ['Double Chicken + 2 Extra Cheese', { variantId: 'double', ...cheese(2) }, R(800)],
  ];
  for (const [label, sel, expected] of table) assert.equal(unit(sel), expected, label);
  // Never 700 + 300 or 700 + 600.
  assert.notEqual(unit({ variantId: 'half' }), R(1000));
  assert.notEqual(unit({ variantId: 'double' }), R(1300));
});

test('product quantity multiplies the selected price: two Half Plates = 600, two Double Chicken = 1,200', () => {
  const p = biryani();
  const line = (variantId: string) => {
    const r = server.resolveSelection(p, { variantId });
    return priceOrder([{ productId: 'b1', name: 'Chicken Biryani', basePrice: r.basePrice, variantDelta: r.variantDelta, addons: r.addons, quantity: 2 }], { taxRatePercent: 0, taxInclusive: false, serviceChargePercent: 0 }).total;
  };
  assert.equal(line('half'), R(600));
  assert.equal(line('double'), R(1200));
});

test('changing selections in the picker updates the price: Half → Double → back to base; removing extras removes the charge', () => {
  let sel: server.ItemSelection = {};
  assert.equal(unit(sel), R(700), 'starts at the base price, nothing selected');
  sel = chooseVariant(sel, 'half');
  assert.equal(unit(sel), R(300));
  sel = chooseVariant(sel, 'double');
  assert.equal(unit(sel), R(600), 'radio behaviour: only one variant at a time');
  sel = setExtraQuantity(sel, 'cheese', 2);
  assert.equal(unit(sel), R(800));
  sel = setExtraQuantity(sel, 'cheese', 1);
  assert.equal(unit(sel), R(700));
  sel = setExtraQuantity(sel, 'cheese', 0);
  assert.equal(unit(sel), R(600), 'removed extra no longer charged');
  sel = chooseVariant(sel, null);
  assert.equal(unit(sel), R(700), 'back to the base price');
  assert.equal(sel.variantId, undefined);
});

test('free / included choices and removals never charge; summary shows what was chosen', () => {
  let sel = setChoiceQuantity({ variantId: 'half' }, 'spice', 'hot', 1, true);
  sel = toggleRemoval(sel, 'onion', true);
  assert.equal(unit(sel), R(300));
  sel = setChoiceQuantity(sel, 'spice', 'mild', 1, true);
  const r = server.resolveSelection(biryani() as any, sel);
  assert.deepEqual(r.addons.map((a) => [a.name, a.price]), [['Mild', 0]], 'single choice replaced, still free');
  assert.deepEqual(selectionSummary(r), ['Half Plate', 'Mild', 'No Fried onions']);
  assert.equal(unit(toggleRemoval(sel, 'onion', false)), R(300));
});

test('an "included" group stays free even if a price was stored; the editor/API refuse such a price', () => {
  const p: any = biryani();
  p.modifierGroups[0].options[1].price = R(50);
  assert.equal(unit(setChoiceQuantity({}, 'spice', 'hot', 1, true), p), R(700));
  assert.match(server.validateProductOptions(p).join(), /free\/included, so “Hot” cannot have a price/);
});

test('extra sale price: charged once at the sale price; never below zero; must be lower than the price', () => {
  const p: any = biryani();
  p.addons[0].salePrice = R(70);
  assert.equal(unit({ variantId: 'half', ...cheese(2) }, p), R(300 + 140));
  p.addons[0].salePrice = R(150);
  assert.match(server.validateProductOptions(p).join(), /Extra “Extra Cheese”: the sale price must be lower/);
});

test('invalid, inactive and unavailable options are rejected', () => {
  const p = biryani();
  assert.throws(() => server.resolveSelection(p, { variantId: 'nope' }), /Invalid option/);
  assert.throws(() => server.resolveSelection(p, { variantId: 'family' }), /no longer available/);
  assert.throws(() => server.resolveSelection(p, { addonIds: ['raita'] }), /Invalid add-on/);
  assert.throws(() => server.resolveSelection(p, cheese(4)), /at most 3 × Extra Cheese/);
});

test('different configurations stay separate cart lines; the same one merges', () => {
  const k = (sel: server.ItemSelection) => server.selectionKey('b1', sel);
  assert.notEqual(k({}), k({ variantId: 'half' }));
  assert.notEqual(k({ variantId: 'half' }), k({ variantId: 'double' }));
  assert.notEqual(k({ variantId: 'half', ...cheese(1) }), k({ variantId: 'half', ...cheese(2) }));
  assert.equal(k(setExtraQuantity(chooseVariant({}, 'half'), 'cheese', 1)), k({ variantId: 'half', addonIds: ['cheese'] }));
});

test('menu card shows the cheapest real price ("from 300") and the base stays a choice', () => {
  assert.deepEqual(server.displayPrice(biryani() as any), { amount: R(300), original: R(300), from: true });
});

test('review audit flags old additive / implicitly-required dishes and changes nothing', () => {
  const legacy: any = { _id: 'old', name: { en: 'Old Biryani' }, price: R(700), variants: [{ _id: 'h', name: 'Half Plate', priceDelta: R(300) }] };
  const rows = auditProducts([biryani() as any, legacy]);
  assert.equal(rows.length, 1, 'the correctly configured dish is not flagged');
  assert.deepEqual(rows[0].flags, ['LEGACY_ADDITIVE', 'BASE_NOT_ORDERABLE']);
  assert.equal(rows[0].implicitRequired, true);
  assert.deepEqual(rows[0].options, [{ name: 'Half Plate', storedAmount: R(300), customerPays: R(1000) }], 'shows today\'s charge so the owner can decide');
  assert.equal(legacy.variantPricing, undefined, 'input untouched');
});
