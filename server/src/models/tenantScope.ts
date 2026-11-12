import { AsyncLocalStorage } from 'node:async_hooks';
import { Schema, Types } from 'mongoose';

const scope = new AsyncLocalStorage<{ crossTenant: boolean }>();

/**
 * Runs `fn` with tenant-scope checks disabled. ONLY for platform (super admin) code paths and
 * token-verified lookups where the tenant is derived from the record itself.
 */
export function runCrossTenant<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({ crossTenant: true }, fn);
}
const isCrossTenant = () => scope.getStore()?.crossTenant === true;

/**
 * Defense-in-depth tenant isolation.
 * Any query/update/delete/aggregate on a tenant-scoped model MUST include `tenantId` in its filter
 * (or first $match stage). Otherwise the operation throws before it reaches MongoDB.
 * Platform-level code that legitimately spans tenants (super admin analytics) must opt out
 * explicitly by wrapping the call in `runCrossTenant(() => ...)`.
 */
const QUERY_OPS = [
  'find', 'findOne', 'countDocuments', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'replaceOne', 'distinct',
] as const;

export class TenantScopeError extends Error {
  constructor(model: string, op: string) {
    super(`Tenant isolation violation: ${model}.${op} executed without tenantId filter`);
  }
}

export function tenantScopePlugin(schema: Schema) {
  schema.add({ tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true, immutable: true } });

  for (const op of QUERY_OPS) {
    schema.pre(op as any, function (this: any, next: (err?: Error) => void) {
      if (isCrossTenant()) return next();
      const filter = this.getFilter?.() ?? {};
      if (!filter.tenantId) return next(new TenantScopeError(this.model?.modelName ?? 'Model', op));
      const update = this.getUpdate?.();
      if (update && (update.tenantId || update.$set?.tenantId)) {
        return next(new Error('tenantId is immutable'));
      }
      next();
    });
  }

  schema.pre('aggregate', function (this: any, next: (err?: Error) => void) {
    if (isCrossTenant()) return next();
    const first = this.pipeline()[0];
    if (!first?.$match?.tenantId) return next(new TenantScopeError('Aggregate', 'aggregate'));
    next();
  });
}

export const oid = (id: string | Types.ObjectId) => (typeof id === 'string' ? new Types.ObjectId(id) : id);
export const isOid = (id: unknown): id is string => typeof id === 'string' && Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(id);
