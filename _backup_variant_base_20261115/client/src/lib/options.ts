import { normalizeSelection, type ItemSelection, type ResolvedSelection } from '../offline/menuPricing';

/** "2× Extra Cheese", "Olives (included)": one chosen extra or choice, as charged. */
export function optionLabel(a: { name: string; quantity?: number; included?: boolean }, includedWord = 'included') {
  return `${(a.quantity ?? 1) > 1 ? `${a.quantity}× ` : ''}${a.name}${a.included ? ` (${includedWord})` : ''}`;
}

/**
 * Readable lines for a STORED order item (orders, kitchen, receipts, tracking): extras and choices with their
 * quantities, then removed ingredients ("No Onions"). The option (size/portion) is shown separately as variantName.
 */
export function itemOptionLabels(item: { addons?: { name: string; quantity?: number; included?: boolean }[]; removed?: string[] | null }, noWord = 'No') {
  return [...(item.addons ?? []).map((a) => optionLabel(a)), ...(item.removed ?? []).map((r) => `${noWord} ${r}`)];
}

/** Summary of a resolved selection for cart / POS lines (variant name first). */
export function selectionSummary(r: ResolvedSelection, words: { included?: string; no?: (x: string) => string } = {}) {
  return [r.variantName, ...r.addons.map((a) => optionLabel(a, words.included)), ...r.removed.map((x) => (words.no ? words.no(x) : `No ${x}`))].filter(Boolean) as string[];
}

/** The order-request form of a selection: ids and quantities only (the server prices everything). */
export function selectionPayload(sel: ItemSelection | undefined) {
  const n = normalizeSelection(sel ?? {});
  return {
    variantId: n.variantId,
    addons: n.addons.length ? n.addons : undefined,
    choices: n.choices.length ? n.choices : undefined,
    removeIds: n.removeIds.length ? n.removeIds : undefined,
  };
}

/** True when the dish has anything to choose (options, extras, choices or removable ingredients). */
export function hasOptions(p: any) {
  return (
    (p.variants ?? []).some((v: any) => v.isActive !== false) ||
    (p.addons ?? []).some((a: any) => a.isAvailable !== false) ||
    (p.modifierGroups ?? []).some((g: any) => g.isActive !== false) ||
    (p.removableIngredients ?? []).some((r: any) => r.isAvailable !== false)
  );
}
