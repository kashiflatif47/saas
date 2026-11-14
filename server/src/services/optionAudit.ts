import { productEffectivePrice, productName, variantEffectivePrice, variantIsRequired, validateProductOptions, type MenuProduct } from '../lib/menuPricing';

/**
 * Finds dishes whose option configuration needs an owner's decision. Pure (no database access): the CLI
 * (scripts/auditOptionPricing.ts) feeds it products read-only, and nothing is ever changed automatically,
 * because only the owner knows what an old amount was meant to be.
 *
 * Flags:
 *  - LEGACY_ADDITIVE: options saved as amounts ADDED to the base price (before full-price variants existed).
 *    A "+300" Half Plate on a 700 dish is charged 1,000 today; the owner decides whether 300 was the full price.
 *  - BASE_NOT_ORDERABLE: the dish has options and customers cannot order it at the base price. Fine when
 *    intended (e.g. persons), but dishes saved before this setting existed got it implicitly.
 *  - INVALID: the configuration fails the same checks the editor and API apply on save.
 */
export type AuditFlag = 'LEGACY_ADDITIVE' | 'BASE_NOT_ORDERABLE' | 'INVALID';

export interface AuditRow {
  id: string;
  name: string;
  flags: AuditFlag[];
  basePrice: number;
  /** What a customer pays for each option today (exactly as checkout computes it). */
  options: { name: string; storedAmount: number | null; customerPays: number }[];
  problems: string[];
  implicitRequired: boolean; // variantRequired was never saved (old dish)
}

export function auditProducts(products: (MenuProduct & { _id?: unknown; variantRequired?: boolean | null })[], now = new Date()): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const p of products) {
    const variants = p.variants ?? [];
    const flags: AuditFlag[] = [];
    if (variants.length && p.variantPricing !== 'replace') flags.push('LEGACY_ADDITIVE');
    if (variants.length && variantIsRequired(p)) flags.push('BASE_NOT_ORDERABLE');
    const problems = validateProductOptions(p);
    if (problems.length) flags.push('INVALID');
    if (!flags.length) continue;
    rows.push({
      id: String(p._id ?? ''),
      name: productName(p),
      flags,
      basePrice: productEffectivePrice(p, now),
      options: variants.map((v) => ({
        name: v.name,
        storedAmount: p.variantPricing === 'replace' ? v.price ?? null : v.priceDelta ?? 0,
        customerPays: variantEffectivePrice(p, v, now),
      })),
      problems,
      implicitRequired: variants.length > 0 && p.variantRequired == null,
    });
  }
  return rows;
}
