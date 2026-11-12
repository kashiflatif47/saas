import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../lib/errors';
import { TenantScopeError } from '../models/tenantScope';
import { isProd } from '../config/env';
import { PricingError } from '../lib/pricing';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof PricingError) {
    return void res.status(400).json({ error: { code: 'PRICING_ERROR', message: err.message } });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return void res.status(400).json({ error: { code: 'VALIDATION', message: 'Validation failed', details: Object.fromEntries(Object.entries(err.errors).map(([k, v]: [string, any]) => [k, v.message])) } });
  }
  if (err instanceof mongoose.Error.VersionError) {
    return void res.status(409).json({ error: { code: 'CONFLICT', message: 'This record was just changed by someone else. Refresh and try again.' } });
  }
  if (err instanceof mongoose.Error.CastError) {
    return void res.status(400).json({ error: { code: 'BAD_ID', message: `Invalid ${err.path}` } });
  }
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {}).filter((k) => k !== 'tenantId').join(', ');
    return void res.status(409).json({ error: { code: 'DUPLICATE', message: `A record with this ${field || 'value'} already exists` } });
  }
  if (err?.type === 'entity.too.large') {
    return void res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Payload too large' } });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return void res.status(413).json({ error: { code: 'TOO_LARGE', message: 'File too large' } });
  }
  if (err instanceof TenantScopeError) {
    // Programming error — log loudly, never leak details.
    console.error('[SECURITY]', err.message, req.method, req.originalUrl);
    return void res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
  }
  console.error('[ERROR]', req.method, req.originalUrl, err);
  res.status(500).json({ error: { code: 'INTERNAL', message: isProd ? 'Internal error' : String(err?.message ?? err) } });
}
