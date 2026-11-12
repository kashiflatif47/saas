import { Schema, model, InferSchemaType, Types } from 'mongoose';
import { FEATURES, TENANT_ROLES } from '../config/permissions';

/* ---------------- Plan ---------------- */
const planSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, lowercase: true, trim: true },
    priceMonthly: { type: Number, required: true, min: 0 }, // minor units
    currency: { type: String, default: 'PKR' },
    trialDays: { type: Number, default: 14, min: 0 },
    features: [{ type: String, enum: FEATURES }],
    limits: {
      maxStaff: { type: Number, default: 10 },
      maxProducts: { type: Number, default: 200 },
      maxTables: { type: Number, default: 30 },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const Plan = model('Plan', planSchema);
export type PlanDoc = InferSchemaType<typeof planSchema> & { _id: Types.ObjectId };

/* ---------------- Tenant ---------------- */
const themeSchema = new Schema(
  {
    primary: { type: String, default: '#B4532A' },
    secondary: { type: String, default: '#1F2937' },
    accent: { type: String, default: '#E9B44C' },
    background: { type: String, default: '#FFFBF5' },
    surface: { type: String, default: '#FFFFFF' },
    text: { type: String, default: '#1C1917' },
    fontHeading: { type: String, default: 'Fraunces' },
    fontBody: { type: String, default: 'Inter' },
    radius: { type: Number, default: 14 },
  },
  { _id: false },
);

const tenantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    businessType: { type: String, enum: ['restaurant', 'cafe', 'hotel', 'bakery', 'food_truck', 'other'], default: 'restaurant' },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
    customDomain: { type: String, lowercase: true, trim: true, sparse: true, unique: true },
    contact: { email: String, phone: String, address: String, city: String, country: String },
    branding: {
      logoUrl: String,
      faviconUrl: String,
      coverUrl: String,
      heroUrl: String,
      heroTitle: { en: String, ur: String, ar: String },
      heroSubtitle: { en: String, ur: String, ar: String },
      about: { en: String, ur: String, ar: String },
      theme: { type: themeSchema, default: () => ({}) },
      socials: { instagram: String, facebook: String, tiktok: String, whatsapp: String },
    },
    settings: {
      currency: { type: String, default: 'PKR' },
      currencyDecimals: { type: Number, default: 2 },
      timezone: { type: String, default: 'Asia/Karachi' },
      defaultLanguage: { type: String, enum: ['en', 'ur', 'ar'], default: 'en' },
      languages: { type: [String], default: ['en'] },
      taxRatePercent: { type: Number, default: 0, min: 0, max: 100 },
      taxInclusive: { type: Boolean, default: false },
      serviceChargePercent: { type: Number, default: 0, min: 0, max: 100 },
      autoAcceptOrders: { type: Boolean, default: false },
      guestOrdering: { type: Boolean, default: true },
      requireTableForDineIn: { type: Boolean, default: true },
      orderTypes: { type: [String], default: ['dine_in', 'takeaway'] },
      openingHours: { type: String, default: '' },
      loyaltyEnabled: { type: Boolean, default: false },
      loyaltyPointsPerUnit: { type: Number, default: 1 }, // points per 100 major units spent
      /* POS & kitchen (all configurable per restaurant) */
      deliveryFee: { type: Number, default: 0 }, // minor units, added to delivery orders (taxable)
      maxManualDiscountPercent: { type: Number, default: 100, min: 0, max: 100 }, // cap for non-owner staff
      requireOpenShiftForCash: { type: Boolean, default: false }, // cash can only be taken inside an open shift
      kitchenDelayGraceMinutes: { type: Number, default: 5, min: 0, max: 240 }, // added to the dishes' prep time before "delayed"
      taxLabel: { type: String, default: 'Tax' }, // e.g. "VAT"
      taxRegistrationNumber: { type: String, default: '' }, // printed on receipts (e.g. Saudi VAT number)
      receiptFooter: { type: String, default: '' },
      marketing: {
        quietStart: { type: String, default: '21:00' },
        quietEnd: { type: String, default: '09:00' },
        maxPerWeek: { type: Number, default: 2 },
        minHoursBetween: { type: Number, default: 24 },
        attributionDays: { type: Number, default: 7 },
        countryCode: { type: String, default: '' }, // e.g. '+92': local numbers (03…) become international for SMS/WhatsApp
      },
      delivery: {
        autoAssign: { type: Boolean, default: true },
        acceptTimeoutSec: { type: Number, default: 120 },
        maxAttempts: { type: Number, default: 3 },
        maxConcurrentPerRider: { type: Number, default: 2 },
        delayGraceMinutes: { type: Number, default: 10 },
        requireCode: { type: Boolean, default: false },
        notifyCustomerSms: { type: Boolean, default: false },
      },
      intelligence: {
        foodCostTargetPercent: { type: Number, default: 35 },
        reorderLeadDays: { type: Number, default: 3 },
      },
      segmentRules: {
        newDays: { type: Number, default: 30 },
        loyalOrders: { type: Number, default: 5 },
        highValueTopPercent: { type: Number, default: 20 },
        atRiskDays: { type: Number, default: 30 },
        inactiveDays: { type: Number, default: 60 },
      },
    },
    subscription: {
      planId: { type: Schema.Types.ObjectId, ref: 'Plan' },
      status: { type: String, enum: ['trial', 'active', 'past_due', 'expired', 'suspended'], default: 'trial', index: true },
      trialEndsAt: Date,
      currentPeriodEnd: Date,
      featureOverrides: { grant: [String], revoke: [String] },
    },
    payments: {
      cashEnabled: { type: Boolean, default: true },
      provider: { type: String, enum: ['none', 'stripe'], default: 'none' },
      providerPublicKey: String,
      providerSecretEnc: { type: String, select: false },
      webhookSecretEnc: { type: String, select: false },
      providerVerifiedAt: Date,
    },
    // Messaging providers (credentials encrypted at rest, never returned by the API)
    messaging: {
      sms: { provider: { type: String, enum: ['none', 'twilio'], default: 'none' }, accountSid: String, authTokenEnc: { type: String, select: false }, from: String, verifiedAt: Date },
      whatsapp: { provider: { type: String, enum: ['none', 'twilio'], default: 'none' }, from: String, verifiedAt: Date }, // uses the SMS Twilio account
      email: { provider: { type: String, enum: ['none', 'sendgrid'], default: 'none' }, apiKeyEnc: { type: String, select: false }, from: String, verifiedAt: Date },
      costs: { sms: { type: Number, default: 0 }, whatsapp: { type: Number, default: 0 }, email: { type: Number, default: 0 } }, // owner-entered estimate per message (minor units)
    },
  },
  { timestamps: true },
);
tenantSchema.index({ name: 'text', slug: 'text' });
export const Tenant = model('Tenant', tenantSchema);
export type TenantDoc = InferSchemaType<typeof tenantSchema> & { _id: Types.ObjectId };

/* ---------------- User (staff + super admin) ---------------- */
const userSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', index: true }, // null for superadmin
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: String,
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['superadmin', ...TENANT_ROLES], required: true },
    permissionOverrides: { grant: [String], revoke: [String] },
    assignedTableIds: [{ type: Schema.Types.ObjectId, ref: 'Table' }],
    stationIds: [{ type: Schema.Types.ObjectId, ref: 'KitchenStation' }],
    isActive: { type: Boolean, default: true },
    lastLoginAt: Date,
    failedLogins: { type: Number, default: 0 },
    lockedUntil: Date,
    refreshTokens: { type: [{ hash: String, expiresAt: Date }], select: false, default: [] },
    tokenVersion: { type: Number, default: 0 },
    // Delivery riders only
    riderProfile: {
      phone: String,
      vehicle: String,
      available: { type: Boolean, default: false },
      zoneIds: [String], // empty = all zones
      locationSharing: { type: Boolean, default: false }, // rider's explicit choice
      location: { lat: Number, lng: Number, at: Date }, // latest only; cleared when unavailable or sharing off
      lastAssignedAt: Date,
    },
  },
  { timestamps: true },
);
// Email is unique per tenant; superadmin emails unique among superadmins (tenantId null).
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
export const User = model('User', userSchema);
export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };

/* ---------------- AuditLog (platform + tenant) ---------------- */
const auditSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', index: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorName: String,
    actorRole: String,
    action: { type: String, required: true },
    entity: String,
    entityId: String,
    meta: Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.index({ tenantId: 1, createdAt: -1 });
export const AuditLog = model('AuditLog', auditSchema);
