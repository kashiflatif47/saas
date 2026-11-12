import { Schema, model } from 'mongoose';
import { tenantScopePlugin } from './tenantScope';
import { ITEM_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES } from '../lib/orderState';

/* ---------------- Table ---------------- */
const tableSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    area: { type: String, default: 'Main hall' },
    capacity: { type: Number, default: 4, min: 1 },
    qrToken: { type: String, required: true },
    qrVersion: { type: Number, default: 1 },
    status: { type: String, enum: ['available', 'occupied', 'reserved', 'cleaning'], default: 'available' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
tableSchema.plugin(tenantScopePlugin);
tableSchema.index({ tenantId: 1, label: 1 }, { unique: true });
tableSchema.index({ tenantId: 1, qrToken: 1 }, { unique: true });
export const Table = model('Table', tableSchema);

/* ---------------- Order ---------------- */
const orderItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
  stationId: { type: Schema.Types.ObjectId, ref: 'KitchenStation' },
  name: { type: String, required: true },
  variantName: String,
  addons: [{ name: String, price: Number, _id: false }],
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true },
  lineTotal: { type: Number, required: true }, // unitPrice × quantity, before any line discount
  discount: { type: Number, default: 0 }, // authorised item-level discount (minor units, whole line)
  discountReason: String,
  notes: { type: String, maxlength: 300 },
  status: { type: String, enum: ITEM_STATUSES, default: 'queued' },
  prepMinutes: Number, // product's configured preparation time when ordered (drives KDS delay alerts)
  startedAt: Date,
  startedBy: String,
  readyAt: Date,
  readyBy: String,
  servedAt: Date,
  addedAt: Date, // set when an item is added to an existing order
  cancelReason: String,
  cancelledBy: String,
});

const orderSchema = new Schema(
  {
    orderNumber: { type: Number, required: true },
    type: { type: String, enum: ['dine_in', 'takeaway', 'pickup', 'delivery'], default: 'dine_in' },
    delivery: {
      address: String,
      notes: String,
      zoneId: { type: Schema.Types.ObjectId, ref: 'DeliveryZone' },
      zoneName: String,
      location: { lat: Number, lng: Number, source: String }, // shared by the customer (permission) or entered by staff
      status: { type: String, enum: ['awaiting_assignment', 'assigned', 'rider_accepted', 'picked_up', 'on_the_way', 'delivered', 'failed', 'returned', 'cancelled'] },
      riderId: { type: Schema.Types.ObjectId, ref: 'User' },
      riderName: String,
      assignedAt: Date,
      acceptedAt: Date,
      pickedUpAt: Date,
      onTheWayAt: Date,
      deliveredAt: Date,
      failedAt: Date,
      returnedAt: Date,
      cancelledAt: Date,
      failureReason: String,
      etaAt: Date,
      code: { type: String, select: false }, // shown to the customer; the rider asks for it at the door
      proof: { note: String, codeConfirmed: Boolean, by: String, at: Date },
      attempts: [{ riderId: String, riderName: String, at: Date, by: String, outcome: String, reason: String, explanation: String, _id: false }],
      delayedNotifiedAt: Date,
    },
    deliveryFee: { type: Number, default: 0 },
    // Authorised manual order-level discount (POS). Coupon discounts are recorded via couponCode.
    manualDiscount: { type: { type: String, enum: ['percent', 'fixed'] }, value: Number, amount: Number, reason: String, by: String, byId: String },
    lineDiscountTotal: { type: Number, default: 0 },
    couponDiscount: { type: Number, default: 0 },
    couponSnapshot: { type: { type: String }, value: Number, maxDiscount: Number, minOrder: Number },
    createdBy: { id: String, name: String },
    estimatedReadyAt: Date,
    billRequestedAt: Date,
    // Set when the order was taken on a device without connection and synchronised later.
    offline: { deviceId: String, createdAt: Date, syncedAt: Date },
    modifications: [{ at: { type: Date, default: Date.now }, by: String, byId: String, action: String, detail: Schema.Types.Mixed, _id: false }],
    source: { type: String, enum: ['qr', 'website', 'staff'], default: 'qr' },
    tableId: { type: Schema.Types.ObjectId, ref: 'Table' },
    tableLabel: String,
    customer: { name: String, phone: String, email: String },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    items: { type: [orderItemSchema], validate: [(v: unknown[]) => v.length > 0, 'Order needs items'] },
    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    serviceCharge: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },
    couponCode: String,
    currency: { type: String, required: true },
    status: { type: String, enum: ORDER_STATUSES, default: 'pending', index: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid', index: true },
    amountPaid: { type: Number, default: 0 },
    amountRefunded: { type: Number, default: 0 },
    trackingToken: { type: String, required: true, select: false },
    notes: { type: String, maxlength: 500 },
    rejectionReason: String,
    assignedWaiterId: { type: Schema.Types.ObjectId, ref: 'User' },
    statusHistory: [{ status: String, at: { type: Date, default: Date.now }, by: String, _id: false }],
    acceptedAt: Date,
    readyAt: Date,
    deliveredAt: Date,
    completedAt: Date,
    inventoryDeducted: { type: Boolean, default: false },
    loyaltyAwarded: { type: Number, default: 0 },
    // Client-generated per checkout attempt; a retried or double-submitted checkout returns the same order.
    idempotencyKey: { type: String, select: false },
  },
  // Concurrent save()s of the same order (two staff accepting, a webhook and a cashier) must not
  // silently overwrite each other: the second save fails with a VersionError and is retried or refused.
  { timestamps: true, optimisticConcurrency: true },
);
orderSchema.plugin(tenantScopePlugin);
orderSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
orderSchema.index({ tenantId: 1, orderNumber: 1 }, { unique: true });
orderSchema.index({ tenantId: 1, createdAt: -1 });
orderSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
orderSchema.index({ tenantId: 1, 'items.stationId': 1, status: 1 });
export const Order = model('Order', orderSchema);

/* ---------------- Counter (per-tenant order numbers) ---------------- */
const counterSchema = new Schema({ key: { type: String, required: true }, seq: { type: Number, default: 0 } });
counterSchema.plugin(tenantScopePlugin);
counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });
export const Counter = model('Counter', counterSchema);

/* ---------------- Payment / transaction ---------------- */
const paymentSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    kind: { type: String, enum: ['charge', 'refund'], default: 'charge' },
    method: { type: String, enum: ['cash', 'card_terminal', 'online'], required: true },
    provider: { type: String, enum: ['cash', 'manual', 'stripe'], required: true },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },
    status: { type: String, enum: ['pending', 'verified', 'failed', 'cancelled'], default: 'pending', index: true },
    providerRef: { type: String, index: true },
    clientSecret: { type: String, select: false },
    verifiedAt: Date,
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: String,
    raw: { type: Schema.Types.Mixed, select: false },
    shiftId: { type: Schema.Types.ObjectId, ref: 'CashShift' }, // cash collected/refunded during this cashier shift
    // Split bill: what this payment covers (equal share or specific items).
    allocation: { mode: { type: String, enum: ['equal', 'items', 'amount'] }, part: Number, parts: Number, label: String, items: [{ itemId: String, quantity: Number, _id: false }] },
    idempotencyKey: { type: String, select: false },
  },
  { timestamps: true },
);
paymentSchema.plugin(tenantScopePlugin);
paymentSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
paymentSchema.index({ tenantId: 1, shiftId: 1 });
paymentSchema.index({ tenantId: 1, createdAt: -1 });
paymentSchema.index({ tenantId: 1, provider: 1, providerRef: 1 });
export const Payment = model('Payment', paymentSchema);

/* ---------------- Reservation ---------------- */
const reservationSchema = new Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: String,
    partySize: { type: Number, required: true, min: 1 },
    reservedFor: { type: Date, required: true },
    durationMinutes: { type: Number, default: 90 },
    tableId: { type: Schema.Types.ObjectId, ref: 'Table' },
    status: { type: String, enum: ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'], default: 'pending' },
    notes: String,
  },
  { timestamps: true },
);
reservationSchema.plugin(tenantScopePlugin);
reservationSchema.index({ tenantId: 1, reservedFor: 1 });
export const Reservation = model('Reservation', reservationSchema);

/* ---------------- Customer ---------------- */
const customerSchema = new Schema(
  {
    name: String,
    phone: { type: String, required: true },
    email: String,
    totalOrders: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    loyaltyPoints: { type: Number, default: 0 },
    lastOrderAt: Date,
    notes: String,
    tags: [String],
    birthday: String, // 'MM-DD', only when the customer provided it
    // Communication consent per channel (explicit opt-in only; revocation is permanent until re-granted)
    consent: {
      sms: { granted: Boolean, at: Date, source: String, revokedAt: Date },
      whatsapp: { granted: Boolean, at: Date, source: String, revokedAt: Date },
      email: { granted: Boolean, at: Date, source: String, revokedAt: Date },
    },
    segments: { type: [String], default: [] },
    stats: { orders: Number, spend: Number, aov: Number, firstOrderAt: Date, lastOrderAt: Date, channel: String, deliveryOrders: Number, dineInOrders: Number, couponOrders: Number, last60: Number, prior60: Number },
    segmentsAt: Date,
  },
  { timestamps: true },
);
customerSchema.plugin(tenantScopePlugin);
customerSchema.index({ tenantId: 1, phone: 1 }, { unique: true });
export const Customer = model('Customer', customerSchema);

/* ---------------- Feedback ---------------- */
const feedbackSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, maxlength: 1000 },
    name: String,
    isPublished: { type: Boolean, default: false },
    response: String,
  },
  { timestamps: true },
);
feedbackSchema.plugin(tenantScopePlugin);
feedbackSchema.index({ tenantId: 1, createdAt: -1 });
feedbackSchema.index({ tenantId: 1, orderId: 1 }, { unique: true, partialFilterExpression: { orderId: { $exists: true } } });
export const Feedback = model('Feedback', feedbackSchema);

/* ---------------- Coupon ---------------- */
const couponSchema = new Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true },
    description: String,
    type: { type: String, enum: ['percent', 'fixed'], required: true },
    value: { type: Number, required: true, min: 0 },
    maxDiscount: Number,
    minOrder: Number,
    startsAt: Date,
    endsAt: Date,
    usageLimit: Number,
    usedCount: { type: Number, default: 0 },
    // Optional restrictions (all validated on the server when an order is priced)
    productIds: [String], // discount applies only to these dishes
    categoryIds: [String], // … or to dishes of these categories
    customerIds: [String], // only these customers (matched by the order's phone number) may use it
    campaignId: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
couponSchema.plugin(tenantScopePlugin);
couponSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export const Coupon = model('Coupon', couponSchema);

/* ---------------- Notification ---------------- */
const notificationSchema = new Schema(
  {
    type: { type: String, required: true }, // order.new, stock.low, reservation.new, payment.verified …
    title: { type: String, required: true },
    body: String,
    link: String,
    roles: { type: [String], default: [] }, // empty = all staff
    readBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true },
);
notificationSchema.plugin(tenantScopePlugin);
notificationSchema.index({ tenantId: 1, createdAt: -1 });
export const Notification = model('Notification', notificationSchema);

/* ---------------- Cash shift (cash drawer session per cashier) ---------------- */
const cashMovementSchema = new Schema(
  { key: String, type: { type: String, enum: ['in', 'out'], required: true }, amount: { type: Number, required: true, min: 1 }, reason: { type: String, required: true }, by: String, byId: String, at: { type: Date, default: Date.now } },
  { _id: true },
);
const cashShiftSchema = new Schema(
  {
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    cashierName: String,
    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    openedAt: { type: Date, default: Date.now },
    openingFloat: { type: Number, required: true, min: 0 },
    openingNotes: String,
    movements: { type: [cashMovementSchema], default: [] },
    closedAt: Date,
    closedBy: String,
    countedCash: Number,
    expectedCash: Number, // frozen at close: opening + cash sales − cash refunds + cash in − cash out
    discrepancy: Number, // counted − expected
    totals: { cashSales: Number, cashRefunds: Number, cashIn: Number, cashOut: Number, cardTerminal: Number, online: Number },
    closingNotes: String,
  },
  { timestamps: true },
);
cashShiftSchema.plugin(tenantScopePlugin);
// One open drawer per cashier at a time.
cashShiftSchema.index({ tenantId: 1, cashierId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
cashShiftSchema.index({ tenantId: 1, openedAt: -1 });
export const CashShift = model('CashShift', cashShiftSchema);

/* ---------------- Offline sync receipts ----------------
 * One record per offline operation the server ACCEPTED (keyed by the client's operation UUID, tenant-scoped).
 * A repeated or replayed operation returns the stored result instead of being executed again. */
const syncReceiptSchema = new Schema(
  {
    key: { type: String, required: true },
    type: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: String,
    offlineCreatedAt: Date,
    response: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
syncReceiptSchema.plugin(tenantScopePlugin);
syncReceiptSchema.index({ tenantId: 1, key: 1 }, { unique: true });
export const SyncReceipt = model('SyncReceipt', syncReceiptSchema);
