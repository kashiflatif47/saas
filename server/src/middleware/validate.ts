import type { NextFunction, Request, Response } from 'express';
import { ZodSchema, z } from 'zod';
import { badRequest } from '../lib/errors';
import { isOid } from '../models/tenantScope';

export const validateBody = (schema: ZodSchema) => (req: Request, _res: Response, next: NextFunction) => {
  const r = schema.safeParse(req.body);
  if (!r.success) return next(badRequest('Validation failed', r.error.flatten()));
  req.body = r.data;
  next();
};

export const validateQuery = (schema: ZodSchema) => (req: Request, _res: Response, next: NextFunction) => {
  const r = schema.safeParse(req.query);
  if (!r.success) return next(badRequest('Invalid query', r.error.flatten()));
  (req as any).validQuery = r.data;
  next();
};

/** Rejects any route param named *id that is not a valid ObjectId (prevents CastErrors & injection). */
export function checkIdParams(req: Request, _res: Response, next: NextFunction) {
  for (const [k, v] of Object.entries(req.params)) {
    if (/id$/i.test(k) && !isOid(v)) return next(badRequest(`Invalid ${k}`));
  }
  next();
}

/** Strips Mongo operator keys ($…) and dotted keys from body/query to block NoSQL injection. */
export function sanitizeInput(req: Request, _res: Response, next: NextFunction) {
  const clean = (o: any, depth = 0): any => {
    if (depth > 20 || o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map((x) => clean(x, depth + 1));
    const out: any = {};
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  };
  if (req.body) req.body = clean(req.body);
  if (req.query) {
    const q = clean(req.query);
    for (const k of Object.keys(req.query)) delete (req.query as any)[k];
    Object.assign(req.query, q);
  }
  next();
}

/* Shared zod primitives */
export const zId = z.string().refine(isOid, 'Invalid id');
export const zHex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a #RRGGBB hex color');
export const zI18n = z.object({ en: z.string().max(2000).optional(), ur: z.string().max(2000).optional(), ar: z.string().max(2000).optional() });
export const zI18nRequired = zI18n.extend({ en: z.string().min(1).max(200) });
export const zMoney = z.number().int().min(0).max(1_000_000_000);
export const zPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().max(100).optional(),
});
