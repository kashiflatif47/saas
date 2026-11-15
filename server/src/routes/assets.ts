import { Router } from 'express';
import { z } from 'zod';
import { ah, badRequest } from '../lib/errors';
import { can } from '../middleware/auth';
import { checkIdParams, validateBody, validateQuery } from '../middleware/validate';
import { uploadMemory } from '../middleware/upload';
import { audit } from '../services/audit';
import { Asset } from '../models/storage';
import {
  createExternalAsset, deleteAsset, importExternalAsset, inspectAsset, mediaUrl, migrateAsset, storageStatus, uploadAsset, verifyAsset,
} from '../services/media';

/**
 * Image library of ONE restaurant (tenant from the JWT; every query is tenant-scoped). Three ways to add an image:
 * upload to Cloudinary, upload to S3-compatible storage, or link an existing https image. Records then point at
 * the returned `/media/<id>` address.
 */
export const assetsRouter = Router();
const manage = can('branding:manage', 'menu:manage');
const zPurpose = z.enum(['branding', 'product', 'category', 'other']).default('other');
const zProvider = z.enum(['cloudinary', 's3', 'local']);
const view = (a: any) => ({ ...a, url: mediaUrl(a._id), key: a.provider === 'external' ? a.key : undefined, history: (a.history ?? []).map((h: any) => ({ provider: h.provider, at: h.at })) });

/** Which upload choices are available (and why not). Never contains credentials. */
assetsRouter.get('/storage', manage, ah(async (_req, res) => res.json(await storageStatus())));

assetsRouter.get('/', manage, validateQuery(z.object({ purpose: z.string().optional(), status: z.enum(['active', 'replaced', 'removed', 'all']).default('active') })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId };
  if (q.status !== 'all') filter.status = q.status;
  if (q.purpose) filter.purpose = q.purpose;
  res.json({ items: (await Asset.find(filter).sort({ createdAt: -1 }).limit(200).lean()).map(view) });
}));

assetsRouter.get('/:id', manage, checkIdParams, ah(async (req, res) => res.json(view(await inspectAsset(req.tenantId!, req.params.id)))));

/** Option A / B: upload from the computer to the chosen provider (default when omitted). */
assetsRouter.post('/', manage, uploadMemory.single('file'), ah(async (req, res) => {
  if (!req.file) throw badRequest('Choose an image file');
  const body = z.object({ provider: zProvider.optional(), purpose: zPurpose, label: z.string().max(80).optional() }).safeParse(req.body ?? {});
  if (!body.success) throw badRequest('Invalid upload options');
  const a = await uploadAsset({ tenantId: req.tenantId!, buffer: req.file.buffer, provider: body.data.provider, purpose: body.data.purpose, label: body.data.label, actor: { id: req.user!.id, name: req.user!.name } });
  await audit(req, 'asset.upload', 'Asset', a._id, { provider: a.provider, purpose: a.purpose, size: a.size });
  res.status(201).json(view(a.toObject()));
}));

/** Option C: link an existing https image (not fetched by the server). */
assetsRouter.post('/external', manage, validateBody(z.object({ url: z.string().max(2000), purpose: zPurpose, label: z.string().max(80).optional() })), ah(async (req, res) => {
  const a = await createExternalAsset({ tenantId: req.tenantId!, url: req.body.url, purpose: req.body.purpose, label: req.body.label, actor: { id: req.user!.id, name: req.user!.name } });
  await audit(req, 'asset.link', 'Asset', a._id, { host: new URL(a.key).host });
  res.status(201).json(view(a.toObject()));
}));

/** Copy a linked image into Cloudinary / cloud storage (same /media address; the link is kept in history). */
assetsRouter.post('/:id/import', manage, checkIdParams, validateBody(z.object({ provider: zProvider })), ah(async (req, res) => {
  const a = await importExternalAsset(req.tenantId!, req.params.id, req.body.provider);
  await audit(req, 'asset.import', 'Asset', req.params.id, { provider: req.body.provider });
  res.json(view(a));
}));

/** Copy an image to another provider (the original stays where it was). */
assetsRouter.post('/:id/migrate', manage, checkIdParams, validateBody(z.object({ provider: zProvider })), ah(async (req, res) => {
  const r = await migrateAsset(req.tenantId!, req.params.id, req.body.provider);
  await audit(req, 'asset.migrate', 'Asset', req.params.id, { provider: req.body.provider, skipped: (r as any).skipped });
  res.json(view(r.asset));
}));

assetsRouter.post('/:id/verify', manage, checkIdParams, ah(async (req, res) => res.json({ status: await verifyAsset(req.tenantId!, req.params.id) })));

/** Soft remove by default; permanent deletion is restricted (see services/media.ts deleteAsset). */
assetsRouter.delete('/:id', manage, checkIdParams, validateBody(z.object({ permanent: z.boolean().optional(), confirm: z.string().max(20).optional() }).default({})), ah(async (req, res) => {
  const r = await deleteAsset(req.tenantId!, req.params.id, { permanent: req.body?.permanent, confirm: req.body?.confirm, role: req.user!.role });
  await audit(req, r.permanent ? 'asset.delete_permanent' : 'asset.remove', 'Asset', req.params.id);
  res.json(r);
}));
