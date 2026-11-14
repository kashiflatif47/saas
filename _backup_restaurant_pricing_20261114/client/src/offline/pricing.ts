/**
 * VERBATIM COPY of server/src/lib/pricing.ts used for OFFLINE ESTIMATES only. The server re-prices every order
 * when it synchronises; server/tests/unit/offlinePricingParity.test.ts fails if the two files ever diverge.
 */
/**
 * Pure, dependency-free order pricing.
 * All money is integer MINOR units (e.g. paisa / cents / fils) to avoid floating-point drift.
 * The client never supplies prices: callers pass DB-sourced unit prices into this function.
 */

export interface PricedAddon {
  name: string;
  price: number; // minor units
}

export interface PricingLineInput {
  productId: string;
  name: string;
  basePrice: number; // effective unit base price (promo applied) in minor units
  variantName?: string;
  variantDelta?: number; // minor units, may be negative but final unit price is clamped >= 0
  addons?: PricedAddon[];
  quantity: number;
  /** Authorised item-level discount for the whole line (percent of the line, or fixed minor units). */
  lineDiscount?: ManualDiscountInput | null;
}

export interface ManualDiscountInput {
  type: 'percent' | 'fixed';
  value: number; // percent (0-100] or minor units
}

export interface PricingOptions {
  /** Authorised order-level discount, applied after line discounts and the coupon. */
  manualDiscount?: ManualDiscountInput | null;
  /** Delivery fee in minor units; taxable, not subject to service charge. */
  deliveryFee?: number;
}

export interface CouponInput {
  code: string;
  type: 'percent' | 'fixed';
  value: number; // percent (0-100) or minor units
  maxDiscount?: number; // minor units cap for percent coupons
  minOrder?: number; // minor units
  /** When set, the coupon discounts only these lines (dish / category restricted coupons). */
  eligibleProductIds?: string[];
}

export interface PricingSettings {
  taxRatePercent: number; // e.g. 16 for 16%
  taxInclusive: boolean; // prices already include tax
  serviceChargePercent: number; // applied to discounted subtotal
}

export interface PricedLine extends PricingLineInput {
  unitPrice: number;
  lineTotal: number; // unitPrice × quantity (gross)
  lineDiscountAmount: number;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotal: number;
  discount: number; // all discounts: lines + coupon + manual
  lineDiscount: number;
  couponDiscount: number;
  manualDiscount: number;
  deliveryFee: number;
  serviceCharge: number;
  tax: number;
  total: number;
  couponApplied?: string;
  couponRejectedReason?: string;
}

export class PricingError extends Error {}

/** Round half away from zero to an integer minor unit. */
export function roundMinor(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function computeUnitPrice(line: PricingLineInput): number {
  const addons = (line.addons ?? []).reduce((s, a) => s + a.price, 0);
  return Math.max(0, line.basePrice + (line.variantDelta ?? 0) + addons);
}

/** Amount of a manual discount applied to `base` (never more than base, never negative). */
export function manualDiscountAmount(d: ManualDiscountInput | null | undefined, base: number): number {
  if (!d || base <= 0) return 0;
  if (d.type === 'percent') {
    if (!(d.value > 0 && d.value <= 100)) throw new PricingError('Discount percent must be between 0 and 100');
    return Math.min(base, roundMinor((base * d.value) / 100));
  }
  if (!Number.isInteger(d.value) || d.value <= 0) throw new PricingError('Fixed discounts must be a positive amount in minor units');
  return Math.min(base, d.value);
}

/**
 * Order of operations (all integer minor units):
 *   line totals → − line discounts → − coupon (on the discounted subtotal) → − manual order discount
 *   → + service charge (on the discounted amount) → + delivery fee → tax (exclusive: added; inclusive: extracted).
 */
export function priceOrder(
  inputs: PricingLineInput[],
  settings: PricingSettings,
  coupon?: CouponInput | null,
  options: PricingOptions = {},
): PricingResult {
  if (inputs.length === 0) throw new PricingError('Order must contain at least one item');
  if (settings.taxRatePercent < 0 || settings.taxRatePercent > 100) throw new PricingError('Invalid tax rate');
  if (settings.serviceChargePercent < 0 || settings.serviceChargePercent > 100)
    throw new PricingError('Invalid service charge');
  const deliveryFee = options.deliveryFee ?? 0;
  if (!Number.isInteger(deliveryFee) || deliveryFee < 0) throw new PricingError('Invalid delivery fee');

  const lines: PricedLine[] = inputs.map((l) => {
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 999)
      throw new PricingError(`Invalid quantity for ${l.name}`);
    for (const p of [l.basePrice, l.variantDelta ?? 0, ...(l.addons ?? []).map((a) => a.price)]) {
      if (!Number.isInteger(p)) throw new PricingError('Prices must be integer minor units');
    }
    const unitPrice = computeUnitPrice(l);
    const lineTotal = unitPrice * l.quantity;
    return { ...l, unitPrice, lineTotal, lineDiscountAmount: manualDiscountAmount(l.lineDiscount, lineTotal) };
  });

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const lineDiscount = lines.reduce((s, l) => s + l.lineDiscountAmount, 0);
  const afterLines = subtotal - lineDiscount;

  let couponDiscount = 0;
  let couponApplied: string | undefined;
  let couponRejectedReason: string | undefined;
  // Restricted coupons discount only their eligible lines; the minimum order applies to the whole order.
  const couponBase = coupon?.eligibleProductIds
    ? lines.filter((l) => coupon.eligibleProductIds!.includes(l.productId)).reduce((s, l) => s + l.lineTotal - l.lineDiscountAmount, 0)
    : afterLines;
  if (coupon) {
    if (coupon.minOrder && afterLines < coupon.minOrder) {
      couponRejectedReason = 'Minimum order not met';
    } else if (coupon.type === 'percent') {
      if (coupon.value <= 0 || coupon.value > 100) throw new PricingError('Invalid coupon percent');
      couponDiscount = roundMinor((couponBase * coupon.value) / 100);
      if (coupon.maxDiscount != null) couponDiscount = Math.min(couponDiscount, coupon.maxDiscount);
      couponApplied = coupon.code;
    } else {
      couponDiscount = Math.min(coupon.value, couponBase);
      couponApplied = coupon.code;
    }
  }
  couponDiscount = Math.max(0, Math.min(couponDiscount, couponBase));
  const manualDiscount = manualDiscountAmount(options.manualDiscount, afterLines - couponDiscount);
  const discount = lineDiscount + couponDiscount + manualDiscount;

  const afterDiscount = subtotal - discount;
  const serviceCharge = roundMinor((afterDiscount * settings.serviceChargePercent) / 100);

  let tax: number;
  let total: number;
  if (settings.taxInclusive) {
    // Tax is already embedded in item prices (and the delivery fee); extract it for reporting.
    const taxableGross = afterDiscount + serviceCharge + deliveryFee;
    tax = roundMinor(taxableGross - taxableGross / (1 + settings.taxRatePercent / 100));
    total = taxableGross;
  } else {
    tax = roundMinor(((afterDiscount + serviceCharge + deliveryFee) * settings.taxRatePercent) / 100);
    total = afterDiscount + serviceCharge + deliveryFee + tax;
  }

  return { lines, subtotal, discount, lineDiscount, couponDiscount, manualDiscount, deliveryFee, serviceCharge, tax, total, couponApplied, couponRejectedReason };
}

/** Converts a major-unit decimal entered in a form (e.g. "12.50") into minor units. */
export function toMinor(major: number, decimals = 2): number {
  return Math.round(major * 10 ** decimals);
}
