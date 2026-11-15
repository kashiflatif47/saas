import { Schema, model } from 'mongoose';
import { tenantScopePlugin } from './tenantScope';

/**
 * One uploaded or linked image. Records store the STABLE address `/media/<assetId>`; this document says where the
 * binary actually is (provider + key + delivery URL). Moving an image to another provider updates this document
 * only, so branding, dishes and categories never need to change and old links keep working.
 */
const locationSchema = new Schema(
  {
    provider: { type: String, enum: ['local', 'cloudinary', 's3', 'external'], required: true },
    key: String, // local relative path · Cloudinary public_id · S3 object key · external URL
    bucket: String,
    url: String, // delivery URL at that location
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const assetSchema = new Schema(
  {
    provider: { type: String, enum: ['local', 'cloudinary', 's3', 'external'], required: true },
    key: { type: String, required: true },
    bucket: String,
    deliveryUrl: { type: String, required: true }, // public / CDN URL ('' for private buckets: presigned on demand)
    privateObject: { type: Boolean, default: false },
    resourceType: { type: String, default: 'image' },
    mime: String,
    size: Number,
    sha256: String, // of the bytes we stored (not available for external links)
    purpose: { type: String, enum: ['branding', 'product', 'category', 'other'], default: 'other' },
    label: String, // e.g. "logo", dish name
    status: { type: String, enum: ['active', 'replaced', 'removed'], default: 'active', index: true },
    replacedBy: { type: Schema.Types.ObjectId, ref: 'Asset' },
    sourceUrl: String, // original /uploads path (migration) or external URL (import)
    /** Every previous location after a migration or import. The source copies are never deleted automatically. */
    history: { type: [locationSchema], default: [] },
    lastVerifiedAt: Date,
    verifyStatus: { type: String, enum: ['ok', 'missing', 'mismatch', 'unverifiable', 'error'] },
    createdBy: { id: String, name: String },
  },
  { timestamps: true },
);
assetSchema.plugin(tenantScopePlugin);
assetSchema.index({ tenantId: 1, createdAt: -1 });
export const Asset = model('Asset', assetSchema);

/**
 * Platform-wide storage configuration (one document). Secrets are AES-256-GCM encrypted with ENCRYPTION_KEY and
 * never selected unless explicitly requested. Environment variables, when set, take precedence.
 */
const storageConfigSchema = new Schema(
  {
    _id: { type: String, default: 'storage' },
    defaultProvider: { type: String, enum: ['', 'cloudinary', 's3', 'local'], default: '' },
    cloudinary: {
      cloudName: String,
      apiKey: String,
      apiSecretEnc: { type: String, select: false },
      folder: String,
    },
    s3: {
      endpoint: String,
      region: String,
      bucket: String,
      accessKeyId: String,
      secretAccessKeyEnc: { type: String, select: false },
      publicBaseUrl: String,
      forcePathStyle: { type: Boolean, default: true },
      privateBucket: { type: Boolean, default: false },
    },
    updatedBy: String,
  },
  { timestamps: true },
);
export const StorageConfig = model('StorageConfig', storageConfigSchema);
