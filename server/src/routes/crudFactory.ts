import { Router } from 'express';
import type { Model } from 'mongoose';
import { z, type ZodObject, type ZodRawShape } from 'zod';
import { ah, notFound } from '../lib/errors';
import { can } from '../middleware/auth';
import { checkIdParams, validateBody, validateQuery, zPage } from '../middleware/validate';
import { audit } from '../services/audit';
import type { Permission } from '../config/permissions';

interface CrudOptions {
  model: Model<any>;
  entity: string;
  create: ZodObject<ZodRawShape>;
  viewPerm: Permission;
  managePerm: Permission;
  searchFields?: string[];
  defaultSort?: Record<string, 1 | -1>;
  filterKeys?: string[]; // whitelisted exact-match query filters
  populate?: string;
  /** Hook to adjust/validate a doc payload before create/update (may throw AppError). */
  beforeSave?: (data: any, req: any, existing?: any) => Promise<any> | any;
  softDeleteField?: string; // if set, DELETE sets this field to true/false instead of removing
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds list/get/create/update/delete endpoints. Every query is constrained by req.tenantId,
 * which comes from the authenticated user's token (see requireStaffTenant).
 */
export function crudRouter(o: CrudOptions): Router {
  const r = Router();
  const listQuery = zPage.extend(Object.fromEntries((o.filterKeys ?? []).map((k) => [k, z.string().max(100).optional()])));

  r.get(
    '/',
    can(o.viewPerm),
    validateQuery(listQuery),
    ah(async (req, res) => {
      const q = (req as any).validQuery;
      const filter: any = { tenantId: req.tenantId };
      for (const k of o.filterKeys ?? []) {
        if (q[k] != null && q[k] !== '') filter[k] = q[k] === 'true' ? true : q[k] === 'false' ? false : q[k];
      }
      if (q.q && o.searchFields?.length) {
        const rx = new RegExp(escapeRegex(q.q), 'i');
        filter.$or = o.searchFields.map((f) => ({ [f]: rx }));
      }
      let query = o.model.find(filter).sort(o.defaultSort ?? { createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit);
      if (o.populate) query = query.populate(o.populate);
      const [items, total] = await Promise.all([query.lean(), o.model.countDocuments(filter)]);
      res.json({ items, total, page: q.page, limit: q.limit });
    }),
  );

  r.get(
    '/:id',
    can(o.viewPerm),
    checkIdParams,
    ah(async (req, res) => {
      const doc = await o.model.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
      if (!doc) throw notFound(`${o.entity} not found`);
      res.json(doc);
    }),
  );

  r.post(
    '/',
    can(o.managePerm),
    validateBody(o.create),
    ah(async (req, res) => {
      let data = { ...req.body };
      if (o.beforeSave) data = await o.beforeSave(data, req);
      const doc = await o.model.create({ ...data, tenantId: req.tenantId });
      await audit(req, `${o.entity}.create`, o.entity, doc._id);
      res.status(201).json(doc.toObject());
    }),
  );

  r.patch(
    '/:id',
    can(o.managePerm),
    checkIdParams,
    validateBody(o.create.partial()),
    ah(async (req, res) => {
      const existing = await o.model.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
      if (!existing) throw notFound(`${o.entity} not found`);
      let data = { ...req.body };
      if (o.beforeSave) data = await o.beforeSave(data, req, existing);
      delete data.tenantId;
      const doc = await o.model.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: data }, { new: true, runValidators: true }).lean();
      await audit(req, `${o.entity}.update`, o.entity, req.params.id, { fields: Object.keys(data) });
      res.json(doc);
    }),
  );

  r.delete(
    '/:id',
    can(o.managePerm),
    checkIdParams,
    ah(async (req, res) => {
      const filter = { tenantId: req.tenantId, _id: req.params.id };
      const result = o.softDeleteField
        ? await o.model.findOneAndUpdate(filter, { $set: { [o.softDeleteField]: o.softDeleteField === 'isActive' ? false : true } }, { new: true })
        : await o.model.findOneAndDelete(filter);
      if (!result) throw notFound(`${o.entity} not found`);
      await audit(req, `${o.entity}.delete`, o.entity, req.params.id);
      res.json({ ok: true });
    }),
  );

  return r;
}
