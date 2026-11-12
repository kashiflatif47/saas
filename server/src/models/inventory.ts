import { Schema, model } from 'mongoose';
import { tenantScopePlugin } from './tenantScope';

const supplierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    contactName: String,
    phone: String,
    email: String,
    address: String,
    notes: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
supplierSchema.plugin(tenantScopePlugin);
supplierSchema.index({ tenantId: 1, name: 1 }, { unique: true });
export const Supplier = model('Supplier', supplierSchema);

const inventoryItemSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, trim: true },
    unit: { type: String, enum: ['g', 'kg', 'ml', 'l', 'pcs', 'pack', 'box'], default: 'pcs' },
    quantity: { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: 0 },
    costPerUnit: { type: Number, default: 0 }, // minor units
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
    isActive: { type: Boolean, default: true },
    lowStockNotifiedAt: Date,
  },
  { timestamps: true },
);
inventoryItemSchema.plugin(tenantScopePlugin);
inventoryItemSchema.index({ tenantId: 1, name: 1 }, { unique: true });
export const InventoryItem = model('InventoryItem', inventoryItemSchema);

const poLineSchema = new Schema(
  {
    inventoryItemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    name: String,
    quantity: { type: Number, required: true, min: 0.0001 },
    unitCost: { type: Number, required: true, min: 0 },
    receivedQty: { type: Number, default: 0 },
  },
  { _id: false },
);

const purchaseOrderSchema = new Schema(
  {
    poNumber: { type: Number, required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    lines: { type: [poLineSchema], validate: [(v: unknown[]) => v.length > 0, 'PO needs lines'] },
    status: { type: String, enum: ['draft', 'ordered', 'received', 'cancelled'], default: 'draft' },
    total: { type: Number, default: 0 },
    expectedAt: Date,
    receivedAt: Date,
    notes: String,
  },
  { timestamps: true },
);
purchaseOrderSchema.plugin(tenantScopePlugin);
purchaseOrderSchema.index({ tenantId: 1, poNumber: 1 }, { unique: true });
export const PurchaseOrder = model('PurchaseOrder', purchaseOrderSchema);

const stockMovementSchema = new Schema(
  {
    inventoryItemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    type: { type: String, enum: ['purchase', 'consumption', 'adjustment', 'wastage', 'return'], required: true },
    quantity: { type: Number, required: true }, // signed delta
    balanceAfter: Number,
    reason: String,
    refType: String, // Order | PurchaseOrder
    refId: Schema.Types.ObjectId,
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
stockMovementSchema.plugin(tenantScopePlugin);
stockMovementSchema.index({ tenantId: 1, inventoryItemId: 1, createdAt: -1 });
export const StockMovement = model('StockMovement', stockMovementSchema);
