import type { Types } from 'mongoose';
import { Notification } from '../models/operations';
import { emit } from '../sockets';

/** Persists a tenant notification and pushes it to connected staff in real time. */
export async function notify(
  tenantId: Types.ObjectId | string,
  n: { type: string; title: string; body?: string; link?: string; roles?: string[] },
) {
  try {
    const doc = await Notification.create({ tenantId, ...n });
    emit.staff(String(tenantId), 'notification', doc.toObject());
    return doc;
  } catch (e) {
    console.error('[NOTIFY] failed', n.type, e);
    return null;
  }
}
