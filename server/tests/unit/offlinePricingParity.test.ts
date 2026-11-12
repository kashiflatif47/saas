import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as server from '../../src/lib/pricing';
import * as client from '../../../client/src/offline/pricing';
import { backoffDelay, BACKOFF_MAX_MS, uuid } from '../../../client/src/offline/engine';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('offline pricing is a verbatim copy of the server pricing module', () => {
  const s = fs.readFileSync(path.join(__dirname, '../../src/lib/pricing.ts'), 'utf8');
  const c = fs.readFileSync(path.join(__dirname, '../../../client/src/offline/pricing.ts'), 'utf8');
  const body = c.slice(c.indexOf('*/') + 3); // after the "VERBATIM COPY" header
  assert.equal(body.replace(/\r\n/g, '\n'), s.replace(/\r\n/g, '\n'), 'client/src/offline/pricing.ts must equal server/src/lib/pricing.ts');
});

test('offline and server pricing give identical results on randomised orders', () => {
  let seed = 42;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let k = 0; k < 500; k++) {
    const lines = Array.from({ length: 1 + rnd(5) }, (_, i) => ({
      productId: `p${i}`, name: `P${i}`, basePrice: rnd(50_000), variantDelta: rnd(3) ? 0 : rnd(5_000) - 1_000,
      addons: rnd(2) ? [{ name: 'a', price: rnd(2_000) }] : [], quantity: 1 + rnd(5),
      lineDiscount: rnd(4) ? null : rnd(2) ? { type: 'percent' as const, value: 1 + rnd(50) } : { type: 'fixed' as const, value: 1 + rnd(3_000) },
    }));
    const settings = { taxRatePercent: rnd(25), taxInclusive: !!rnd(2), serviceChargePercent: rnd(15) };
    const coupon = rnd(3) ? null : { code: 'C', type: rnd(2) ? ('percent' as const) : ('fixed' as const), value: 1 + rnd(40), maxDiscount: rnd(2) ? rnd(5_000) : undefined, minOrder: rnd(2) ? rnd(20_000) : undefined };
    const opts = { manualDiscount: rnd(3) ? null : { type: 'fixed' as const, value: 1 + rnd(2_000) }, deliveryFee: rnd(2) ? rnd(3_000) : 0 };
    assert.deepEqual(client.priceOrder(lines, settings, coupon, opts), server.priceOrder(lines, settings, coupon, opts));
  }
});

test('offline queue ids are UUID v4 and backoff grows exponentially with a cap', () => {
  const ids = new Set(Array.from({ length: 200 }, () => uuid()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, UUID);
  const fixed = () => 0.5; // no jitter
  assert.equal(backoffDelay(1, fixed), 2_000);
  assert.equal(backoffDelay(2, fixed), 4_000);
  assert.equal(backoffDelay(5, fixed), 32_000);
  assert.equal(backoffDelay(30, fixed), BACKOFF_MAX_MS);
  for (let i = 0; i < 50; i++) {
    const d = backoffDelay(3);
    assert.ok(d >= 6_400 && d <= 9_600, `jitter within ±20 %: ${d}`);
  }
});
