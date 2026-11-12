/**
 * Models for intelligence, marketing automation, delivery dispatch and the persistent job queue.
 * Every business record is tenant-scoped through tenantScopePlugin (queries without tenantId throw).
 * Job is the one exception: workers claim jobs across tenants, and each job carries its tenantId.
 */
import { Schema, model } from 'mongoose';
import { tenantScopePlugin } from './tenantScope';

/* ---------------- Persistent jobs ---------------- */
const jobSchema = new Schema(
  {
    type: { type: String, required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', index: true },
    key: String, // idempotency: one job per key, ever
    runAt: { type: Date, required: true },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed', 'cancelled'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lockedBy: String,
    lockedUntil: Date,
    lastError: String,
    payload: Schema.Types.Mixed,
    result: Schema.Types.Mixed,
    finishedAt: Date,
  },
  { timestamps: true },
);
jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
jobSchema.index({ tenantId: 1, createdAt: -1 });
export const Job = model('Job', jobSchema);

/* ---------------- Forecast snapshots ---------------- */
const forecastSchema = new Schema({ horizonDays: Number, generatedAt: Date, result: Schema.Types.Mixed }, { timestamps: false });
forecastSchema.plugin(tenantScopePlugin);
forecastSchema.index({ tenantId: 1, horizonDays: 1, generatedAt: -1 });
export const Forecast = model('Forecast', forecastSchema);

/* ---------------- Recommendations ---------------- */
const recommendationSchema = new Schema(
  {
    key: { type: String, required: true }, // rule:subject:week — the same advice is not repeated every day
    rule: { type: String, required: true },
    title: String,
    explanation: String,
    metrics: Schema.Types.Mixed,
    expectedBenefit: String,
    priority: { type: String, enum: ['high', 'medium', 'low'] },
    confidence: { type: String, enum: ['high', 'medium', 'low'] },
    action: String,
    status: { type: String, enum: ['open', 'accepted', 'rejected', 'dismissed'], default: 'open' },
    decidedBy: String,
    decidedAt: Date,
    decisionNote: String,
    baseline: Schema.Types.Mixed, // metric snapshot when generated (for outcome tracking)
    outcome: Schema.Types.Mixed, // { before, after, change, evaluatedAt }
  },
  { timestamps: true },
);
recommendationSchema.plugin(tenantScopePlugin);
recommendationSchema.index({ tenantId: 1, key: 1 }, { unique: true });
recommendationSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
export const Recommendation = model('Recommendation', recommendationSchema);

/* ---------------- AI usage ---------------- */
const aiUsageSchema = new Schema(
  { userId: String, provider: String, model: String, inputTokens: Number, outputTokens: Number, cacheReadTokens: Number, estimatedCostUsd: Number, ok: Boolean, error: String, purpose: String },
  { timestamps: { createdAt: true, updatedAt: false } },
);
aiUsageSchema.plugin(tenantScopePlugin);
aiUsageSchema.index({ tenantId: 1, createdAt: -1 });
export const AiUsage = model('AiUsage', aiUsageSchema);

/* ---------------- Marketing ---------------- */
const couponSpec = {
  type: { type: String, enum: ['percent', 'fixed'] },
  value: Number,
  maxDiscount: Number,
  minOrder: Number,
  validDays: Number,
  productIds: [String],
  categoryIds: [String],
};

const campaignSchema = new Schema(
  {
    name: { type: String, required: true },
    channel: { type: String, enum: ['sms', 'whatsapp', 'email'], required: true },
    segments: { type: [String], default: [] }, // empty = every consenting customer
    subject: String, // email
    body: { type: String, required: true }, // supports {{name}}, {{restaurant}}, {{coupon}}
    aiGenerated: { type: Boolean, default: false },
    status: { type: String, enum: ['draft', 'pending_approval', 'approved', 'scheduled', 'running', 'paused', 'completed', 'cancelled'], default: 'draft' },
    approvedBy: String,
    approvedAt: Date,
    scheduleAt: Date,
    endAt: Date,
    budget: { limit: Number, spent: { type: Number, default: 0 } }, // minor units, from configured per-message costs
    coupon: couponSpec,
    couponCode: String,
    pauseReason: String,
    startedAt: Date,
    completedAt: Date,
    createdBy: String,
  },
  { timestamps: true },
);
campaignSchema.plugin(tenantScopePlugin);
campaignSchema.index({ tenantId: 1, status: 1, scheduleAt: 1 });
export const Campaign = model('Campaign', campaignSchema);

const journeySchema = new Schema(
  {
    name: { type: String, required: true },
    trigger: { type: String, enum: ['joined', 'first_order', 'second_order', 'inactive', 'birthday', 'order_count', 'spend_threshold'], required: true },
    config: { days: Number, count: Number, amount: Number },
    channel: { type: String, enum: ['sms', 'whatsapp', 'email'], required: true },
    subject: String,
    body: { type: String, required: true },
    coupon: couponSpec,
    status: { type: String, enum: ['draft', 'active', 'paused'], default: 'draft' },
    aiGenerated: { type: Boolean, default: false },
    approvedBy: String,
    approvedAt: Date,
    createdBy: String,
  },
  { timestamps: true },
);
journeySchema.plugin(tenantScopePlugin);
export const Journey = model('Journey', journeySchema);

const messageLogSchema = new Schema(
  {
    dedupeKey: { type: String, required: true }, // prevents the same message being created twice
    source: { type: { type: String, enum: ['campaign', 'journey', 'test', 'transactional'] }, id: String },
    kind: { type: String, enum: ['marketing', 'transactional', 'test'], default: 'marketing' },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    channel: { type: String, enum: ['sms', 'whatsapp', 'email'] },
    to: String,
    subject: String,
    body: String,
    couponCode: String,
    status: { type: String, enum: ['queued', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'unknown'], default: 'queued' },
    skipReason: String,
    provider: String,
    providerMessageId: String,
    providerStatus: String,
    error: String,
    attempts: { type: Number, default: 0 },
    nextAttemptAt: Date,
    cost: Number,
    sentAt: Date,
    deliveredAt: Date,
    sendingSince: Date,
  },
  { timestamps: true },
);
messageLogSchema.plugin(tenantScopePlugin);
messageLogSchema.index({ tenantId: 1, dedupeKey: 1 }, { unique: true });
messageLogSchema.index({ tenantId: 1, status: 1, nextAttemptAt: 1 });
messageLogSchema.index({ tenantId: 1, customerId: 1, sentAt: -1 });
messageLogSchema.index({ tenantId: 1, providerMessageId: 1 });
messageLogSchema.index({ tenantId: 1, 'source.id': 1 });
export const MessageLog = model('MessageLog', messageLogSchema);

const suppressionSchema = new Schema(
  { channel: { type: String, enum: ['sms', 'whatsapp', 'email', 'all'] }, address: String, customerId: Schema.Types.ObjectId, reason: String, source: String },
  { timestamps: { createdAt: true, updatedAt: false } },
);
suppressionSchema.plugin(tenantScopePlugin);
suppressionSchema.index({ tenantId: 1, channel: 1, address: 1 }, { unique: true });
export const Suppression = model('Suppression', suppressionSchema);

/* ---------------- Delivery zones ---------------- */
const zoneSchema = new Schema(
  {
    name: { type: String, required: true },
    // Either a polygon ([lng, lat] pairs, GeoJSON order) or a circle. Coordinates are WGS84 degrees.
    polygon: { type: [[Number]], default: undefined },
    circle: { center: { lat: Number, lng: Number }, radiusKm: Number },
    fee: { type: Number, default: 0 },
    minOrder: { type: Number, default: 0 },
    etaMinutes: { type: Number, default: 30 },
    isActive: { type: Boolean, default: true },
    hours: { days: { type: [Number], default: [] }, from: String, to: String },
  },
  { timestamps: true },
);
zoneSchema.plugin(tenantScopePlugin);
zoneSchema.index({ tenantId: 1, name: 1 }, { unique: true });
export const DeliveryZone = model('DeliveryZone', zoneSchema);
