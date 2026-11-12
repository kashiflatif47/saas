import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceOrder, PricingError, toMinor, computeUnitPrice } from '../../src/lib/pricing';

const exclusive = { taxRatePercent: 16, taxInclusive: false, serviceChargePercent: 0 };

test('computes subtotal, tax and total in minor units (tax exclusive)', () => {
  const r = priceOrder([{ productId: 'a', name: 'Tikka', basePrice: 1000_00, quantity: 2 }], exclusive);
  assert.equal(r.subtotal, 2000_00);
  assert.equal(r.tax, 320_00);
  assert.equal(r.total, 2320_00);
});

test('variants and add-ons change the unit price', () => {
  const line = { productId: 'a', name: 'X', basePrice: 500_00, variantDelta: 100_00, addons: [{ name: 'naan', price: 80_00 }], quantity: 3 };
  assert.equal(computeUnitPrice(line), 680_00);
  const r = priceOrder([line], { taxRatePercent: 0, taxInclusive: false, serviceChargePercent: 0 });
  assert.equal(r.total, 2040_00);
});

test('percent coupon is capped by maxDiscount and applied before service charge and tax', () => {
  const r = priceOrder(
    [{ productId: 'a', name: 'A', basePrice: 10000_00, quantity: 1 }],
    { taxRatePercent: 10, taxInclusive: false, serviceChargePercent: 5 },
    { code: 'BIG', type: 'percent', value: 50, maxDiscount: 1000_00 },
  );
  assert.equal(r.discount, 1000_00);
  assert.equal(r.serviceCharge, 450_00); // 5% of 9000
  assert.equal(r.tax, 945_00); // 10% of 9450
  assert.equal(r.total, 10395_00);
  assert.equal(r.couponApplied, 'BIG');
});

test('fixed coupon never exceeds subtotal', () => {
  const r = priceOrder([{ productId: 'a', name: 'A', basePrice: 300_00, quantity: 1 }], exclusive, { code: 'F', type: 'fixed', value: 999_00 });
  assert.equal(r.discount, 300_00);
  assert.equal(r.total, 0);
});

test('coupon below minimum order is rejected with a reason', () => {
  const r = priceOrder([{ productId: 'a', name: 'A', basePrice: 300_00, quantity: 1 }], exclusive, { code: 'MIN', type: 'fixed', value: 50_00, minOrder: 1000_00 });
  assert.equal(r.discount, 0);
  assert.equal(r.couponRejectedReason, 'Minimum order not met');
});

test('tax-inclusive pricing extracts tax without changing the total', () => {
  const r = priceOrder([{ productId: 'a', name: 'A', basePrice: 1160_00, quantity: 1 }], { taxRatePercent: 16, taxInclusive: true, serviceChargePercent: 0 });
  assert.equal(r.total, 1160_00);
  assert.equal(r.tax, 160_00);
});

test('rejects invalid quantities, empty orders and fractional prices', () => {
  assert.throws(() => priceOrder([], exclusive), PricingError);
  assert.throws(() => priceOrder([{ productId: 'a', name: 'A', basePrice: 100, quantity: 0 }], exclusive), PricingError);
  assert.throws(() => priceOrder([{ productId: 'a', name: 'A', basePrice: 100, quantity: 1.5 }], exclusive), PricingError);
  assert.throws(() => priceOrder([{ productId: 'a', name: 'A', basePrice: 10.5, quantity: 1 }], exclusive), PricingError);
});

test('negative variant delta cannot produce a negative unit price', () => {
  assert.equal(computeUnitPrice({ productId: 'a', name: 'A', basePrice: 100, variantDelta: -500, quantity: 1 }), 0);
});

test('no floating point drift across many lines', () => {
  const lines = Array.from({ length: 100 }, (_, i) => ({ productId: String(i), name: 'x', basePrice: 333, quantity: 3 }));
  const r = priceOrder(lines, { taxRatePercent: 17, taxInclusive: false, serviceChargePercent: 7.5 });
  assert.ok(Number.isInteger(r.subtotal) && Number.isInteger(r.tax) && Number.isInteger(r.total) && Number.isInteger(r.serviceCharge));
  assert.equal(r.total, r.subtotal - r.discount + r.serviceCharge + r.tax);
});

test('toMinor converts decimals correctly', () => {
  assert.equal(toMinor(12.5), 1250);
  assert.equal(toMinor(0.1 + 0.2), 30);
});
