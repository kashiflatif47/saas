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
const variantSchema = new Schema({ name: { type: String, required: true }, priceDelta: { type: Number, default: 0 } });
const addonSchema = new Schema({
  name: { type: String, required: true },
  price: { type: Number, default: 0, min: 0 },
  isAvailable: { type: Boolean, default: true },
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
    variants: { type: [variantSchema], default: [] },
    addons: { type: [addonSchema], default: [] },
    tags: { type: [String], default: [] }, // e.g. spicy, vegan
    isFeatured: { type: Boolean, default: false, index: true },
    isAvailable: { type: Boolean, default: true },
    isArchived: { type: Boolean, default: false, index: true },
    trackStock: { type: Boolean, default: false },
    stockQty: { type: Number, default: 0 },
    recipe: { type: [recipeSchema], default: [] },
    prepMinutes: { type: Number, default: 10 },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
productSchema.plugin(tenantScopePlugin);
productSchema.index({ tenantId: 1, isArchived: 1, categoryId: 1, sortOrder: 1 });
productSchema.index({ 'name.en': 'text', 'name.ur': 'text', 'name.ar': 'text', 'description.en': 'text' });
export const Product = model('Product', productSchema);

/** Effective base price considering an active promotion. */
export function effectivePrice(p: { price: number; promoPrice?: number | null; promoEndsAt?: Date | null }, now = new Date()): number {
  if (p.promoPrice != null && p.promoPrice < p.price && (!p.promoEndsAt || p.promoEndsAt > now)) return p.promoPrice;
  return p.price;
}
