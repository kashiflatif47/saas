/**
 * The Halwa Puri scenario through the BROWSER code paths: product page / POS preview (client copy of
 * menuPricing), cart → checkout payload (lib/options), offline POS estimate (offline/estimate) — and the
 * server resolver on the same data. All must agree: Three Persons = 2,000, + Extra Cheese = 2,100.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as clientMenu from '../../../client/src/offline/menuPricing';
import * as serverMenu from '../../src/lib/menuPricing';
import { estimateOffline } from '../../../client/src/offline/estimate';
import { selectionPayload, selectionSummary, itemOptionLabels, hasOptions } from '../../../client/src/lib/options';
import { placeOrderSchema } from '../../src/routes/orders';

const R = (rupees: number) => rupees * 100;
const oid = (n: number) => n.toString(16).padStart(24, 'a');

// The product exactly as the public / staff menu API returns it (JSON: string ids).
const product = {
  _id: oid(1), categoryId: oid(2), name: { en: 'Halwa Puri' }, price: R(1000), promoPrice: R(850), isAvailable: true, isArchived: false, images: [],
  variantPricing: 'replace', variantGroupName: 'Persons',
  variants: [{ _id: oid(11), name: 'Single Person', price: R(500) }, { _id: oid(12), name: 'Two Persons', price: R(1000) }, { _id: oid(13), name: 'Three Persons', price: R(2000) }],
  addons: [{ _id: oid(21), name: 'Extra Cheese', price: R(100), maxQty: 2, isAvailable: true }],
  modifierGroups: [], removableIngredients: [{ _id: oid(31), name: 'Onions' }],
};
const menu = { products: [product], categories: [{ _id: oid(2), isActive: true }], stations: [] };
const cfg = { currency: 'PKR', taxRatePercent: 0, taxInclusive: false, serviceChargePercent: 0 };
const actor = { name: 'Cashier', role: 'cashier', canDiscount: false };

test('product page / POS preview and the server resolver give the same price', () => {
  const cases: [any, number][] = [
    [{ variantId: oid(11) }, R(500)],
    [{ variantId: oid(12) }, R(1000)],
    [{ variantId: oid(13) }, R(2000)],
    [{ variantId: oid(13), addons: [{ id: oid(21), quantity: 1 }] }, R(2100)],
    [{ variantId: oid(13), addons: [{ id: oid(21), quantity: 2 }], removeIds: [oid(31)] }, R(2200)],
  ];
  for (const [sel, expected] of cases) {
    assert.equal(clientMenu.resolveSelection(product as any, sel).unitPrice, expected, JSON.stringify(sel));
    assert.equal(serverMenu.resolveSelection(product as any, sel).unitPrice, expected);
  }
  assert.equal(hasOptions(product), true);
});

test('cart → checkout payload carries ids and quantities only, and the server schema accepts it', () => {
  const sel = { variantId: oid(13), addonIds: [oid(21)], addons: [{ id: oid(21), quantity: 1 }], removeIds: [oid(31)] };
  const payload = selectionPayload(sel);
  assert.deepEqual(payload, { variantId: oid(13), addons: [{ id: oid(21), quantity: 2 }], choices: undefined, removeIds: [oid(31)] });
  const body = placeOrderSchema.parse({ type: 'takeaway', items: [{ productId: oid(1), quantity: 1, ...payload, unitPrice: 1 }] });
  assert.equal((body.items[0] as any).unitPrice, undefined, 'a client price never reaches the server logic');
  assert.deepEqual(body.items[0].addons, [{ id: oid(21), quantity: 2 }]);
  const r = clientMenu.resolveSelection(product as any, sel);
  assert.deepEqual(selectionSummary(r), ['Three Persons', '2× Extra Cheese', 'No Onions']);
});

test('offline POS estimate (no connection) charges the same as the server: 2 × Three Persons = 4,000', () => {
  const est = estimateOffline(menu, cfg, { type: 'takeaway', items: [{ productId: oid(1), variantId: oid(13), quantity: 2 }] }, actor);
  assert.equal(est.items[0].unitPrice, R(2000));
  assert.equal(est.totals.total, R(4000));
  const withCheese = estimateOffline(menu, cfg, { type: 'takeaway', items: [{ productId: oid(1), variantId: oid(13), addons: [{ id: oid(21), quantity: 1 }], quantity: 1 }] }, actor);
  assert.equal(withCheese.totals.total, R(2100));
  assert.deepEqual(withCheese.payload.items[0].addons, [{ id: oid(21), quantity: 1 }], 'synced order sends the full selection');
  assert.throws(() => estimateOffline(menu, cfg, { type: 'takeaway', items: [{ productId: oid(1), quantity: 1 }] }, actor), /Please choose an option for Halwa Puri/);
});

test('stored order items are labelled with quantities, included choices and removals', () => {
  assert.deepEqual(itemOptionLabels({ addons: [{ name: 'Extra Cheese', quantity: 2 }, { name: 'Olives', quantity: 1, included: true }], removed: ['Onions'] }), ['2× Extra Cheese', 'Olives (included)', 'No Onions']);
  assert.deepEqual(itemOptionLabels({ addons: [{ name: 'Raita' }] }), ['Raita'], 'orders saved before quantities existed');
});
