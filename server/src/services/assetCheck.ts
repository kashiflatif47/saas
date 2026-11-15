import fs from 'node:fs/promises';
import path from 'node:path';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { Tenant } from '../models/platform';
import { Category, Product } from '../models/menu';
import { Asset } from '../models/storage';
import { assetIdFromUrl } from './media';

/**
 * READ-ONLY check: which uploaded files referenced by this restaurant's records are missing from the server's
 * upload storage (UPLOAD_DIR). Records are never changed: a missing file is reported so the owner can
 * re-upload it (or restore it from a backup). Nothing is replaced or invented.
 *
 * Typical cause: UPLOAD_DIR is inside the application folder and a redeploy replaced that folder.
 */
export interface AssetRef {
  kind: 'branding' | 'category' | 'product';
  label: string; // e.g. "logoUrl", category or dish name
  url: string;
}

export function uploadPathOf(tenantId: string, url: string): string | null {
  const prefix = `/uploads/${tenantId}/`;
  if (!url.startsWith(prefix)) return null;
  const abs = path.resolve(env.UPLOAD_DIR, url.slice('/uploads/'.length));
  const root = path.resolve(env.UPLOAD_DIR, tenantId) + path.sep;
  return abs.startsWith(root) ? abs : null; // never look outside this restaurant's folder
}

const isRef = (u: string) => u.startsWith('/uploads/') || u.startsWith('/media/');
const exists = (p: string) => fs.access(p).then(() => true, () => false);

export async function checkTenantAssets(tenantId: Types.ObjectId | string) {
  const tid = String(tenantId);
  const refs: AssetRef[] = [];
  const t = await Tenant.findById(tid).select('branding').lean();
  for (const [k, v] of Object.entries((t?.branding ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string' && isRef(v)) refs.push({ kind: 'branding', label: k, url: v });
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === 'string' && isRef(x) && refs.push({ kind: 'branding', label: `${k}[${i + 1}]`, url: x }));
  }
  for (const c of await Category.find({ tenantId: tid, imageUrl: { $regex: '^/(uploads|media)/' } }).select('name imageUrl').lean()) refs.push({ kind: 'category', label: c.name?.en ?? '', url: c.imageUrl! });
  for (const p of await Product.find({ tenantId: tid, isArchived: false, 'images.0': { $exists: true } }).select('name images').lean()) {
    for (const u of p.images ?? []) if (isRef(u)) refs.push({ kind: 'product', label: p.name?.en ?? '', url: u });
  }
  const missing: AssetRef[] = [];
  const mediaIds = refs.map((r) => assetIdFromUrl(r.url)).filter(Boolean) as string[];
  const assets = new Map((await Asset.find({ tenantId: tid, _id: { $in: mediaIds } }).select('provider key status verifyStatus').lean()).map((a: any) => [String(a._id), a]));
  for (const r of refs) {
    const mid = assetIdFromUrl(r.url);
    if (mid) {
      // Permanent storage: missing when the asset record is gone, removed, or its last integrity check failed.
      const a: any = assets.get(mid);
      const local = a?.provider === 'local' ? path.resolve(env.UPLOAD_DIR, a.key) : null;
      if (!a || a.status === 'removed' || a.verifyStatus === 'missing' || a.verifyStatus === 'mismatch' || (local && !(await exists(local)))) missing.push(r);
      continue;
    }
    const p = uploadPathOf(tid, r.url);
    if (!p || !(await exists(p))) missing.push(r);
  }
  return { checked: refs.length, missing };
}
