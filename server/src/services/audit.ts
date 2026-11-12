import type { Request } from 'express';
import { AuditLog } from '../models/platform';

/** Writes an audit entry. Failures are logged but never block the business operation. */
export async function audit(
  req: Request,
  action: string,
  entity?: string,
  entityId?: unknown,
  meta?: Record<string, unknown>,
  tenantIdOverride?: string | null,
) {
  try {
    await AuditLog.create({
      tenantId: tenantIdOverride !== undefined ? tenantIdOverride : req.tenantId ?? req.user?.tenantId ?? null,
      actorId: req.user?.id,
      actorName: req.user?.name,
      actorRole: req.user?.role,
      action,
      entity,
      entityId: entityId != null ? String(entityId) : undefined,
      meta,
      ip: req.ip,
    });
  } catch (e) {
    console.error('[AUDIT] failed to write audit log', action, e);
  }
}
