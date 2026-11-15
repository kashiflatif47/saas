import { Schema, model } from 'mongoose';
import { tenantScopePlugin } from './tenantScope';

const i18n = { en: { type: String, trim: true }, ur: { type: String, trim: true }, ar: { type: String, trim: true } };

/* ---------------- Kitchen station ---------------- */
const stationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    color: { type: String, default: '#B4532A' },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
stationSchema.plugin(tenantScopePlugin);
stationSchema.index({ tenantId: 1, name: 1 }, { unique: true });
export const KitchenStation = model('KitchenStation', stationSchema);

/* ---------------- Category ---------------- */
const categorySchema = new Schema(
  {
    name: { ...i18n, en: { type: String, required: true, trim: true } },
    description: i18n,
    parentId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    imageUrl: String,
    sortOrder: { type: Number, default: 0 },
    stationId: { type: Schema.Types.ObjectId, ref: 'KitchenStation' },
    isActive: { type: Boolean, default: true },
    // Scheduling: visible only between these local times on these days (0=Sun). Empty = always.
    schedule: {
      days: { type: [Number], default: [] },
      from: String, // "HH:mm"
      to: String,
    },
  },
  { timestamps: true },
);
categorySchema.plugin(tenantScopePlugin);
categorySchema.index({ tenantId: 1, parentId: 1, sortOrder: 1 });
export const Category = model('Category', categorySchema);

/* ---------------- Product ---------------- */
/*
 * Option pricing (see lib/menuPricing.ts for the exact rules). All new fields are optional so existing
 * products keep working unchanged: a product without `variantPricing` is a legacy 'add' product.
 */
const ingredientRefSchema = new Schema(
  { inventoryItemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true }, quantity: { type: Number, required: true, min: 0 } },
  { _id: false },
);
const variantSchema = new Schema({
  name: { type: String, required: true },
  priceDelta: { type: Number, default: 0 }, // 'add' mode (legacy): added to the dish price
  price: { type: Number, min: 0 }, // 'replace' mode: the option's full price (replaces the dish price)
  salePrice: { type: Number, min: 0 }, // 'replace' mode: discounted full price
  saleEndsAt: Date,
  isActive: { type: Boolean, default: true },
  recipeMultiplier: { type: Number, min: 0 }, // dish recipe × this per unit (e.g. 3 for "Three Persons")
  description: { type: String, trim: true, maxlength: 200 },
});
/** Extras: always ADDED to the price, per unit, up to maxQty. */
const addonSchema = new Schema({
  name: { type: String, required: true },
  description: { type: String, trim: true, maxlength: 200 },
  price: { type: Number, default: 0, min: 0 },
  salePrice: { type: Number, min: 0 }, // lower price while set
  isAvailable: { type: Boolean, default: true },
  maxQty: { type: Number, default: 1, min: 1, max: 20 },
  ingredient: { type: ingredientRefSchema, default: undefined },
});
/** Choice groups: sauce, crust, meal upgrade, substitution, toppings (option price 0 = included). */
const choiceOptionSchema = new Schema({
  name: { type: String, required: true },
  description: { type: String, trim: true, maxlength: 200 },
  price: { type: Number, default: 0, min: 0 },
  salePrice: { type: Number, min: 0 },
  isAvailable: { type: Boolean, default: true },
  maxQty: { type: Number, default: 1, min: 1, max: 20 },
  ingredient: { type: ingredientRefSchema, default: undefined },
});
const modifierGroupSchema = new Schema({
  name: { type: String, required: true },
  minSelect: { type: Number, default: 0, min: 0 },
  maxSelect: { type: Number, default: 1, min: 1 },
  freeQty: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
  kind: { type: String, enum: ['paid', 'included'], default: 'paid' }, // 'included' = every choice is free
  options: { type: [choiceOptionSchema], default: [] },
});
/** "No onions": removing never changes the price; may return an ingredient to stock. */
const removableSchema = new Schema({
  name: { type: String, required: true },
  isAvailable: { type: Boolean, default: true },
  ingredient: { type: ingredientRefSchema, default: undefined },
});
const recipeSchema = new Schema(
  { inventoryItemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true }, quantity: { type: Number, required: true, min: 0 } },
  { _id: false },
);

const productSchema = new Schema(
  {
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    name: { ...i18n, en: { type: String, required: true, trim: true } },
    description: i18n,
    images: { type: [String], default: [] },
    price: { type: Number, required: true, min: 0 }, // minor units
    promoPrice: { type: Number, min: 0 },
    promoEndsAt: Date,
    /** How option prices work: 'replace' = an option's price IS the item price; missing/'add' = legacy delta. */
    variantPricing: { type: String, enum: ['replace', 'add'] },
    variantGroupName: { type: String, trim: true, maxlength: 40 }, // e.g. "Serving size", "Persons"
    // No default on purpose: new dishes always store it (the API sets false = base price is orderable); dishes
    // saved before this existed keep their stored value, and a missing value keeps the old "required" behaviour.
    variantRequired: Boolean,
    baseOptionLabel: { type: String, trim: true, maxlength: 40 }, // e.g. "Regular", "Full Plate"
    variants: { type: [variantSchema], default: [] },
    addons: { type: [addonSchema], default: [] },
    modifierGroups: { type: [modifierGroupSchema], default: [] },
    removableIngredients: { type: [removableSchema], default: [] },
    tags: { type: [String], default: [] }, // e.g. spicy, vegan
    isFeatured: { type: Boolean, default: false, index: true },
    isAvailable: { type: Boolean, default: true },
    isArchived: { type: Boolean, default: false, index: true },
    trackStock: { type: Boolean, default: false },
    stockQty: { type: Number, default: 0 },
    recipe: { type: [recipeSchema], default: [] },
    prepMinutes: { type: Number, default: 10 },
    // Serving hours (ordering only — never visibility). Off = the category's hours apply (lib/schedule.ts);
    // on with an empty schedule = this dish can be ordered 24/7 even when its category has hours.
    scheduleOverride: { type: Boolean, default: false },
    schedule: { days: { type: [Number], default: undefined }, from: String, to: String },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
productSchema.plugin(tenantScopePlugin);
productSchema.index({ tenantId: 1, isArchived: 1, categoryId: 1, sortOrder: 1 });
productSchema.index({ 'name.en': 'text', 'name.ur': 'text', 'name.ar': 'text', 'description.en': 'text' });
export const Product = model('Product', productSchema);

/** Effective dish price considering an active promotion (options: see lib/menuPricing.ts). */
export { productEffectivePrice as effectivePrice } from '../lib/menuPricing';
