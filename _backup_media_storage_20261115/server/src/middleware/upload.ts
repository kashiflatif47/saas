import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { sniffImageType } from '../lib/crypto';
import { badRequest } from '../lib/errors';

export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 8 },
});

/**
 * Stores an image under UPLOAD_DIR/<tenantId>/<folder>/<random>.<ext> after verifying magic bytes.
 * Files are namespaced by tenant so one tenant can never overwrite or enumerate another's uploads.
 * For object storage (S3/R2), replace this function — the public URL contract stays the same.
 */
export async function storeTenantImage(tenantId: string, folder: string, file: Express.Multer.File): Promise<string> {
  const kind = sniffImageType(file.buffer);
  if (!kind) throw badRequest('Only PNG, JPEG, WEBP or ICO images are allowed');
  if (!/^[a-z-]+$/.test(folder)) throw badRequest('Invalid folder');
  const name = `${crypto.randomBytes(16).toString('hex')}.${kind}`;
  const dir = path.resolve(env.UPLOAD_DIR, tenantId, folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), file.buffer, { flag: 'wx' });
  return `/uploads/${tenantId}/${folder}/${name}`;
}

/** Deletes a tenant-owned upload; refuses paths that are not inside that tenant's directory. */
export async function deleteTenantImage(tenantId: string, url: string): Promise<void> {
  const prefix = `/uploads/${tenantId}/`;
  if (!url.startsWith(prefix)) return;
  const abs = path.resolve(env.UPLOAD_DIR, url.slice('/uploads/'.length));
  const root = path.resolve(env.UPLOAD_DIR, tenantId) + path.sep;
  if (!abs.startsWith(root)) return;
  await fs.unlink(abs).catch(() => undefined);
}
