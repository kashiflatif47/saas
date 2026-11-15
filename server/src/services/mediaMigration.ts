import fs from 'node:fs/promises';
import type { Types } from 'mongoose';
import { Tenant } from '../models/platform';
import { Category, Product } from '../models/menu';
import { Asset } from '../models/storage';
import type { ProviderName } from '../lib/storage/providers';
import { uploadPathOf } from './assetCheck';
import { mediaUrl, migrateAsset, migrateLegacyUpload, type Purpose } from './media';

/**
 * Safe migration to permanent storage.
 *  1. Legacy `/uploads/...` references → copy the file to the target provider, download it back and compare the
 *     checksum, then swap the record's reference ONLY if it still points at the old file.
 *  2. Existing `/media/...` assets on another provider → copied in place (same address).
 * Nothing is ever deleted: originals stay on disk / at the old provider. Missing originals are reported, never
 * replaced with anything else.
 */

export interface MigrationEntry {
  record: string; // e.g. "branding.logoUrl", "product:Halwa Puri", "asset:<id>"
  from: string;
  to?: string;
  status: 'migrated' | 'would-migrate' | 'missing' | 'failed' | 'skipped';
  reason?: string;
}

interface Ref {
  record: string;
  url: string;
  purpose: Purpose;
  label?: string;
  swap: (newUrl: string) => Promise<boolean>; // conditional update; false when the record changed meanwhile
}

async function legacyRefs(tenantId: Types.ObjectId | string): Promise<Ref[]> {
  const tid = String(tenantId);
  const refs: Ref[] = [];
  const t: any = await Tenant.findById(tid).select('branding').lean();
  for (const [k, v] of Object.entries(t?.branding ?? {})) {
    if (typeof v !== 'string' || !v.startsWith('/uploads/')) continue;
    refs.push({ record: `branding.${k}`, url: v, purpose: 'branding', label: k, swap: async (n) => (await Tenant.updateOne({ _id: tid, [`branding.${k}`]: v }, { $set: { [`branding.${k}`]: n } })).modifiedCount === 1 });
  }
  for (const c of await Category.find({ tenantId: tid, imageUrl: { $regex: '^/uploads/' } }).select('name imageUrl').lean()) {
    const old = c.imageUrl!;
    refs.push({ record: `category:${c.name?.en}`, url: old, purpose: 'category', label: c.name?.en, swap: async (n) => (await Category.updateOne({ tenantId: tid, _id: c._id, imageUrl: old }, { $set: { imageUrl: n } })).modifiedCount === 1 });
  }
  for (const p of await Product.find({ tenantId: tid, images: { $elemMatch: { $regex: '^/uploads/' } } }).select('name images').lean()) {
    for (const old of p.images.filter((u: string) => u.startsWith('/uploads/'))) {
      refs.push({ record: `product:${p.name?.en}`, url: old, purpose: 'product', label: p.name?.en, swap: async (n) => (await Product.updateOne({ tenantId: tid, _id: p._id, images: old }, { $set: { 'images.$': n } })).modifiedCount === 1 });
    }
  }
  return refs;
}

export async function migrateTenantMedia(o: { tenantId: Types.ObjectId | string; to: ProviderName; dryRun?: boolean; includeAssets?: boolean }): Promise<MigrationEntry[]> {
  const tid = String(o.tenantId);
  const out: MigrationEntry[] = [];
  for (const r of await legacyRefs(tid)) {
    const file = uploadPathOf(tid, r.url);
    const present = !!file && (await fs.access(file).then(() => true, () => false));
    if (!present) {
      out.push({ record: r.record, from: r.url, status: 'missing', reason: 'The original file is not in server storage (restore it from a backup, or re-upload the image)' });
      continue;
    }
    if (o.dryRun) {
      out.push({ record: r.record, from: r.url, status: 'would-migrate' });
      continue;
    }
    try {
      const a = await migrateLegacyUpload({ tenantId: tid, legacyUrl: r.url, to: o.to, purpose: r.purpose, label: r.label });
      const url = mediaUrl(a._id);
      if (await r.swap(url)) out.push({ record: r.record, from: r.url, to: url, status: 'migrated' });
      else {
        await Asset.updateOne({ tenantId: tid, _id: a._id }, { $set: { status: 'replaced' } }); // copy kept, unused
        out.push({ record: r.record, from: r.url, status: 'skipped', reason: 'The record changed during migration; it was left as it is' });
      }
    } catch (e) {
      out.push({ record: r.record, from: r.url, status: 'failed', reason: (e as Error).message });
    }
  }
  if (o.includeAssets) {
    for (const a of await Asset.find({ tenantId: tid, status: { $ne: 'removed' }, provider: { $nin: [o.to, 'external'] } }).select('_id provider').lean()) {
      if (o.dryRun) {
        out.push({ record: `asset:${a._id}`, from: a.provider, to: o.to, status: 'would-migrate' });
        continue;
      }
      try {
        await migrateAsset(tid, String(a._id), o.to);
        out.push({ record: `asset:${a._id}`, from: a.provider, to: o.to, status: 'migrated' });
      } catch (e) {
        out.push({ record: `asset:${a._id}`, from: a.provider, status: 'failed', reason: (e as Error).message });
      }
    }
  }
  return out;
}
