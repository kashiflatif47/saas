import { NetworkError, type LocalOrder, type OfflineOp, type OfflineStore, type OpError, type OpStatus, type OpType, type Transport, type WireOp } from './types';

/** RFC 4122 v4 UUID; works in browsers (also on plain-http LAN addresses) and in Node. */
export function uuid(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      /* insecure context: fall through */
    }
  }
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** After this many temporary failures (5xx/429) an operation is marked Failed and waits for a person. */
export const MAX_AUTO_RETRIES = 8;

/** Controlled exponential backoff with ±20 % jitter: 2 s, 4 s, 8 s … capped at 5 min. */
export function backoffDelay(retryCount: number, random = Math.random) {
  const raw = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, retryCount - 1));
  return Math.round(raw * (0.8 + random() * 0.4));
}

export interface EngineScope {
  tenantId: string;
  userId: string;
  userName: string;
  deviceId: string;
}

export interface SyncSummary {
  pending: number;
  syncing: number;
  synced: number;
  failed: number;
  conflict: number;
  pendingOrders: number;
  pendingKitchen: number;
  pendingPayments: number;
  pendingShift: number;
  quarantined: number;
  lastSyncAt?: string;
  lastAttemptAt?: string;
}

export type SyncStop = 'done' | 'offline' | 'auth' | 'server' | 'busy';

const OP_TYPES: OpType[] = ['order.create', 'payment.cash', 'kitchen.items', 'shift.movement', 'shift.close'];
const STATUSES: OpStatus[] = ['pending', 'syncing', 'synced', 'failed', 'conflict'];

/** Shape check for records read back from disk; anything else is quarantined, never executed. */
function isValidOp(o: any): o is OfflineOp {
  return (
    o && typeof o === 'object' && typeof o.id === 'string' && typeof o.tenantId === 'string' && typeof o.userId === 'string' &&
    OP_TYPES.includes(o.type) && STATUSES.includes(o.status) && typeof o.seq === 'number' && typeof o.createdAt === 'string' &&
    o.payload && typeof o.payload === 'object' && typeof o.retryCount === 'number'
  );
}

/**
 * Persistent offline operation queue and synchroniser.
 *
 * Guarantees:
 *  - an operation is written to the store BEFORE the caller is told it was saved;
 *  - it is marked Synced only after the server confirmed it;
 *  - every operation carries a UUID that is also its idempotency key, so retries (including after an
 *    interrupted sync or a browser restart mid-request) can never create a second order or payment;
 *  - dependent operations (a payment for an order created offline) wait for their parent;
 *  - business rejections become Conflicts and temporary problems are retried with backoff; nothing is
 *    discarded unless a person explicitly resolves it, and that resolution is recorded on the operation.
 */
export class OfflineEngine {
  private syncing = false;
  private listeners = new Set<() => void>();

  constructor(
    private store: OfflineStore,
    private scope: EngineScope,
    private transport: Transport,
    private now: () => number = () => Date.now(),
  ) {}

  onChange(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  /**
   * Startup recovery: operations left in "syncing" by a crash, refresh or closed tab go back to Pending
   * (the server deduplicates by id, so re-sending is safe). Unreadable records are moved to quarantine.
   */
  async init() {
    for (const raw of await this.store.all<any>('ops')) {
      if (!isValidOp(raw) || raw.tenantId !== this.scope.tenantId || raw.userId !== this.scope.userId) {
        const key = raw?.id ?? raw?.key ?? `bad-${uuid()}`;
        await this.store.put('quarantine', key, { at: new Date(this.now()).toISOString(), reason: !isValidOp(raw) ? 'unreadable or incomplete record' : 'belongs to another account', record: raw });
        if (raw?.id || raw?.key) await this.store.del('ops', raw.id ?? raw.key);
        continue;
      }
      if (raw.status === 'syncing') {
        raw.status = 'pending';
        raw.lastError = { code: 'INTERRUPTED', message: 'Synchronisation was interrupted; it will be retried safely', at: new Date(this.now()).toISOString() };
        await this.store.put('ops', raw.id, raw);
      }
    }
    this.emit();
  }

  /* ------------------------------------------------------------------ queue */

  private async nextSeq() {
    const m = (await this.store.get<{ v: number }>('meta', 'seq')) ?? { v: 0 };
    m.v += 1;
    await this.store.put('meta', 'seq', m);
    return m.v;
  }

  async enqueue(type: OpType, payload: any, extra: { dependsOn?: string; localOrderId?: string; id?: string } = {}): Promise<OfflineOp> {
    const id = extra.id ?? uuid();
    const op: OfflineOp = {
      id,
      idempotencyKey: id,
      seq: await this.nextSeq(),
      tenantId: this.scope.tenantId,
      userId: this.scope.userId,
      userName: this.scope.userName,
      deviceId: this.scope.deviceId,
      type,
      createdAt: new Date(this.now()).toISOString(),
      payload,
      status: 'pending',
      retryCount: 0,
      dependsOn: extra.dependsOn,
      localOrderId: extra.localOrderId,
    };
    await this.store.put('ops', id, op); // throws on quota errors: the caller must not report success
    this.emit();
    return op;
  }

  async ops(): Promise<OfflineOp[]> {
    return (await this.store.all<OfflineOp>('ops')).filter(isValidOp).sort((a, b) => a.seq - b.seq);
  }
  async op(id: string) {
    return this.store.get<OfflineOp>('ops', id);
  }
  async orders(): Promise<LocalOrder[]> {
    return (await this.store.all<LocalOrder>('orders')).filter((o: any) => o && typeof o.localId === 'string').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async order(localId: string) {
    return this.store.get<LocalOrder>('orders', localId);
  }
  async quarantined() {
    return this.store.all<any>('quarantine');
  }

  async summary(): Promise<SyncSummary> {
    const ops = await this.ops();
    const open = (t: OpType) => ops.filter((o) => o.type === t && (o.status === 'pending' || o.status === 'syncing')).length;
    const meta = (await this.store.get<any>('meta', 'sync')) ?? {};
    return {
      pending: ops.filter((o) => o.status === 'pending').length,
      syncing: ops.filter((o) => o.status === 'syncing').length,
      synced: ops.filter((o) => o.status === 'synced').length,
      failed: ops.filter((o) => o.status === 'failed').length,
      conflict: ops.filter((o) => o.status === 'conflict' && !o.resolution).length,
      pendingOrders: open('order.create'),
      pendingKitchen: open('kitchen.items'),
      pendingPayments: open('payment.cash'),
      pendingShift: open('shift.movement') + open('shift.close'),
      quarantined: (await this.store.all('quarantine')).length,
      lastSyncAt: meta.lastSyncAt,
      lastAttemptAt: meta.lastAttemptAt,
    };
  }

  /** Operations still waiting for the server (used before logout and on screens). */
  async unsyncedCount() {
    return (await this.ops()).filter((o) => o.status !== 'synced' && !o.resolution).length;
  }

  /* ------------------------------------------------------------------ local orders */

  /** `opId` (optional, a UUID): reuse the key of an online attempt that may have reached the server. */
  async saveLocalOrder(order: LocalOrder, opPayload: any, opId: string = uuid()) {
    const rec = { ...order, opId };
    await this.store.put('orders', order.localId, rec);
    try {
      await this.enqueue('order.create', { ...opPayload, idempotencyKey: opId }, { id: opId, localOrderId: order.localId });
    } catch (e) {
      await this.store.del('orders', order.localId); // never leave an order that has no queued operation
      throw e;
    }
    return rec;
  }

  async nextLocalNumber() {
    const m = (await this.store.get<{ v: number }>('meta', 'orderNo')) ?? { v: 0 };
    m.v += 1;
    await this.store.put('meta', 'orderNo', m);
    return `OFF-${this.scope.deviceId.slice(0, 4).toUpperCase()}-${String(m.v).padStart(4, '0')}`;
  }

  /** Cash recorded on this device for an order created offline (or a server order, when orderId is given). */
  async recordCash(target: { localOrderId?: string; orderId?: string }, amount: number, allocation?: { mode: 'equal'; parts: number; part: number }) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter a positive amount');
    let dependsOn: string | undefined;
    if (target.localOrderId) {
      const o = await this.order(target.localOrderId);
      if (!o) throw new Error('Local order not found');
      const paid = o.payments.reduce((s, p) => s + p.amount, 0);
      if (paid + amount > o.totals.total) throw new Error('Amount exceeds the outstanding balance of this order');
      dependsOn = o.serverOrderId ? undefined : o.opId;
    }
    const op = await this.enqueue('payment.cash', { orderId: target.orderId, amount, method: 'cash', allocation }, { dependsOn, localOrderId: target.localOrderId });
    if (target.localOrderId) {
      const o = (await this.order(target.localOrderId))!;
      o.payments.push({ opId: op.id, amount, method: 'cash', allocation, at: op.createdAt, by: this.scope.userName, status: 'local' });
      await this.store.put('orders', o.localId, o);
    }
    this.emit();
    return op;
  }

  /** Kitchen item changes. For orders created offline, items are referenced by position until synced. */
  async kitchen(target: { localOrderId?: string; orderId?: string }, items: { itemId?: string; index?: number }[], status: 'preparing' | 'ready') {
    let dependsOn: string | undefined;
    const at = new Date(this.now()).toISOString();
    if (target.localOrderId) {
      const o = await this.order(target.localOrderId);
      if (!o) throw new Error('Local order not found');
      dependsOn = o.serverOrderId ? undefined : o.opId;
      for (const ref of items) {
        const it = ref.index != null ? o.items[ref.index] : undefined;
        if (!it) continue;
        it.status = status;
        if (status === 'preparing') it.startedAt = it.startedAt ?? at;
        if (status === 'ready') {
          it.startedAt = it.startedAt ?? at;
          it.readyAt = at;
        }
      }
      await this.store.put('orders', o.localId, o);
    }
    return this.enqueue('kitchen.items', { orderId: target.orderId, items, status, at }, { dependsOn, localOrderId: target.localOrderId });
  }

  shiftMovement(shiftId: string, type: 'in' | 'out', amount: number, reason: string) {
    return this.enqueue('shift.movement', { shiftId, type, amount, reason });
  }

  async shiftClose(shiftId: string, countedCash: number, notes?: string) {
    const dup = (await this.ops()).find((o) => o.type === 'shift.close' && o.payload.shiftId === shiftId && !o.resolution && o.status !== 'conflict');
    if (dup) throw new Error('A close for this shift is already waiting to sync');
    return this.enqueue('shift.close', { shiftId, countedCash, notes });
  }

  /* ------------------------------------------------------------------ snapshots */

  async saveSnapshot(key: string, data: unknown) {
    await this.store.put('snapshots', key, { data, syncedAt: new Date(this.now()).toISOString() });
  }
  async snapshot<T = any>(key: string): Promise<{ data: T; syncedAt: string } | undefined> {
    return this.store.get('snapshots', key);
  }

  /* ------------------------------------------------------------------ resolution */

  async retry(id: string, by: string) {
    const op = await this.op(id);
    if (!op || op.status === 'synced' || op.status === 'syncing') return;
    op.status = 'pending';
    op.nextAttemptAt = undefined;
    op.resolution = undefined;
    op.lastError = { ...(op.lastError ?? { code: 'RETRY', message: '' }), message: `Retry requested by ${by}`, at: new Date(this.now()).toISOString() };
    await this.store.put('ops', id, op);
    this.emit();
  }

  /** Price changed while offline: the staff member accepts the server's price; the server re-prices anyway. */
  async acceptServerPrice(id: string, by: string) {
    const op = await this.op(id);
    if (!op || op.type !== 'order.create' || op.status !== 'conflict') throw new Error('Nothing to accept');
    op.payload = { ...op.payload, acceptPriceChange: true };
    op.status = 'pending';
    op.nextAttemptAt = undefined;
    op.resolution = { action: 'accepted_server_price', by, at: new Date(this.now()).toISOString() };
    await this.store.put('ops', id, op);
    this.emit();
  }

  /**
   * An authorised person decides an operation will never be sent (e.g. the dish no longer exists and the
   * guest was refunded at the counter). The record stays on the device with the decision for the audit trail;
   * operations depending on it become conflicts so nobody forgets the cash taken for it.
   */
  async discard(id: string, by: string, reason: string) {
    if (!reason || reason.trim().length < 3) throw new Error('A reason is required');
    const op = await this.op(id);
    if (!op || op.status === 'synced') throw new Error('Only unsynced operations can be discarded');
    op.resolution = { action: 'discarded', by, at: new Date(this.now()).toISOString(), reason };
    op.status = op.status === 'failed' ? 'failed' : 'conflict';
    await this.store.put('ops', id, op);
    for (const d of (await this.ops()).filter((x) => x.dependsOn === id && x.status !== 'synced')) {
      d.status = 'conflict';
      d.lastError = { code: 'PARENT_DISCARDED', message: `The operation it depends on was discarded by ${by}: ${reason}`, at: op.resolution.at };
      await this.store.put('ops', d.id, d);
    }
    this.emit();
  }

  /* ------------------------------------------------------------------ sync */

  private toWire(op: OfflineOp, payload: any): WireOp {
    return { id: op.id, type: op.type, tenantId: op.tenantId, userId: op.userId, deviceId: op.deviceId, createdAt: op.createdAt, payload };
  }

  /** Replaces local references (offline order, item positions) with the server ids from the parent's result. */
  private resolvePayload(op: OfflineOp, parent?: OfflineOp) {
    const p = { ...op.payload };
    if (!parent) {
      if (op.type === 'kitchen.items') {
        p.itemIds = (p.items ?? []).map((r: any) => r.itemId).filter(Boolean);
        delete p.items;
      }
      return p;
    }
    const serverOrder = parent.result?.order;
    if (!serverOrder?._id) throw new Error('Parent order has no server id');
    if (op.type === 'payment.cash' || op.type === 'kitchen.items') p.orderId = serverOrder._id;
    if (op.type === 'kitchen.items') {
      p.itemIds = (p.items ?? []).map((r: any) => r.itemId ?? serverOrder.items?.[r.index]?._id).filter(Boolean);
      delete p.items;
    }
    return p;
  }

  private async markLocalOrder(op: OfflineOp) {
    if (!op.localOrderId) return;
    const o = await this.order(op.localOrderId);
    if (!o) return;
    if (op.type === 'order.create') {
      if (op.status === 'synced') {
        const so = op.result.order;
        o.serverOrderId = so._id;
        o.serverOrderNumber = so.orderNumber;
        o.serverTotal = so.total;
        o.syncState = 'confirmed';
        o.items.forEach((it, i) => (it.serverItemId = so.items?.[i]?._id));
      } else if (op.status === 'conflict' || op.status === 'failed') o.syncState = 'attention';
    }
    if (op.type === 'payment.cash') {
      const p = o.payments.find((x) => x.opId === op.id);
      if (p) p.status = op.status === 'synced' ? 'confirmed' : op.status === 'conflict' || op.status === 'failed' ? 'attention' : 'local';
      if (op.status !== 'synced' && op.status !== 'pending') o.syncState = 'attention';
    }
    await this.store.put('orders', o.localId, o);
  }

  private err(code: string, message: string, extra: Partial<OpError> = {}): OpError {
    return { code, message, at: new Date(this.now()).toISOString(), ...extra };
  }

  /**
   * Sends every eligible operation in creation order. Stops at the first connectivity, authentication or
   * server-side outage; continues past business conflicts (they do not block unrelated operations).
   * `force` ignores backoff timers (the "Sync now" button).
   */
  async sync(opts: { force?: boolean } = {}): Promise<{ stop: SyncStop; sent: number }> {
    if (this.syncing) return { stop: 'busy', sent: 0 };
    this.syncing = true;
    let sent = 0;
    let stop: SyncStop = 'done';
    try {
      const meta = (await this.store.get<any>('meta', 'sync')) ?? {};
      meta.lastAttemptAt = new Date(this.now()).toISOString();
      await this.store.put('meta', 'sync', meta);
      for (const listed of await this.ops()) {
        const op = await this.op(listed.id); // re-read: another tab may have changed it
        if (!op || op.status !== 'pending' || op.resolution?.action === 'discarded') continue;
        if (!opts.force && op.nextAttemptAt && op.nextAttemptAt > this.now()) continue;

        let parent: OfflineOp | undefined;
        if (op.dependsOn) {
          parent = await this.op(op.dependsOn);
          if (!parent) {
            op.status = 'conflict';
            op.lastError = this.err('PARENT_MISSING', 'The order this belongs to is missing from this device');
            await this.store.put('ops', op.id, op);
            await this.markLocalOrder(op);
            continue;
          }
          if (parent.status !== 'synced') {
            const why = parent.resolution?.action === 'discarded' ? 'discarded' : parent.status;
            op.waitingFor = `Waiting for its order to sync (order is ${why})`;
            await this.store.put('ops', op.id, op);
            continue;
          }
        }

        let payload: any;
        try {
          payload = this.resolvePayload(op, parent);
        } catch (e: any) {
          op.status = 'conflict';
          op.lastError = this.err('UNRESOLVABLE', e.message);
          await this.store.put('ops', op.id, op);
          continue;
        }

        op.status = 'syncing';
        op.waitingFor = undefined;
        await this.store.put('ops', op.id, op);
        this.emit();

        let res;
        try {
          res = await this.transport(this.toWire(op, payload));
        } catch (e) {
          // Connection lost (possibly AFTER the server processed it: the id makes the retry safe).
          op.status = 'pending';
          op.retryCount += 1;
          op.nextAttemptAt = this.now() + backoffDelay(op.retryCount);
          op.lastError = this.err('NETWORK', e instanceof NetworkError ? e.message : 'Server unreachable');
          await this.store.put('ops', op.id, op);
          stop = 'offline';
          break;
        }
        sent++;
        if (res.ok) {
          op.status = 'synced';
          op.result = res.data;
          op.syncedAt = new Date(this.now()).toISOString();
          op.lastError = undefined;
          await this.store.put('ops', op.id, op);
          await this.markLocalOrder(op);
          const m = (await this.store.get<any>('meta', 'sync')) ?? {};
          m.lastSyncAt = op.syncedAt;
          await this.store.put('meta', 'sync', m);
          this.emit();
          continue;
        }
        const e = this.err(res.code, res.message, { httpStatus: res.httpStatus, details: res.details });
        op.lastError = e;
        if (res.httpStatus === 401) {
          op.status = 'pending'; // session expired: keep it, sign in again, it will be sent then
          stop = 'auth';
        } else if (res.httpStatus === 403 || res.httpStatus === 402) {
          op.status = 'failed'; // permissions/plan changed: a person must decide (retry after fixing, or discard)
        } else if (res.httpStatus >= 500 || res.httpStatus === 429 || res.httpStatus === 408) {
          op.retryCount += 1;
          op.status = op.retryCount >= MAX_AUTO_RETRIES ? 'failed' : 'pending';
          op.nextAttemptAt = this.now() + backoffDelay(op.retryCount);
          stop = 'server';
        } else {
          op.status = 'conflict'; // business rule (price changed, sold out, table gone, order changed elsewhere…)
        }
        await this.store.put('ops', op.id, op);
        await this.markLocalOrder(op);
        this.emit();
        if (stop !== 'done') break;
      }
    } finally {
      this.syncing = false;
      this.emit();
    }
    return { stop, sent };
  }

  /** Housekeeping: synced operations and orders older than `days` are removed (customer data minimisation). */
  async prune(days = 7) {
    const cutoff = this.now() - days * 86400_000;
    const ops = await this.ops();
    for (const o of ops) if (o.status === 'synced' && o.syncedAt && Date.parse(o.syncedAt) < cutoff) await this.store.del('ops', o.id);
    const remaining = new Set((await this.ops()).map((o) => o.localOrderId).filter(Boolean));
    for (const o of await this.orders()) if (o.syncState === 'confirmed' && Date.parse(o.createdAt) < cutoff && !remaining.has(o.localId)) await this.store.del('orders', o.localId);
  }
}
