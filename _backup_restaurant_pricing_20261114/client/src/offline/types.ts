/**
 * Offline-first POS & kitchen: shared types. This folder is framework-free (no React, no DOM types) so the
 * same engine runs in the browser and in the server's automated tests against the real API.
 */

export type OpType = 'order.create' | 'payment.cash' | 'kitchen.items' | 'shift.movement' | 'shift.close';
export type OpStatus = 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict';

export interface OpError {
  code: string;
  message: string;
  httpStatus?: number;
  details?: unknown;
  at: string;
}

export interface OfflineOp {
  id: string; // UUID; also the idempotency key the server deduplicates on
  idempotencyKey: string;
  seq: number; // local creation order (preserved when syncing)
  tenantId: string;
  userId: string;
  userName: string;
  deviceId: string;
  type: OpType;
  createdAt: string; // local clock, ISO
  payload: any;
  status: OpStatus;
  retryCount: number;
  nextAttemptAt?: number; // epoch ms (exponential backoff)
  lastError?: OpError;
  dependsOn?: string; // op that must be synced first (e.g. the order a payment belongs to)
  localOrderId?: string;
  result?: any; // server response once synced
  syncedAt?: string;
  waitingFor?: string; // human-readable reason while blocked by a dependency
  resolution?: { action: 'discarded' | 'accepted_server_price' | 'retried'; by: string; at: string; reason?: string };
}

export interface LocalItem {
  productId: string;
  name: string;
  variantId?: string;
  variantName?: string;
  addonIds: string[];
  addons: { name: string; price: number }[];
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  discount: number;
  notes?: string;
  stationId?: string | null;
  prepMinutes?: number;
  status: 'queued' | 'preparing' | 'ready' | 'served' | 'cancelled';
  startedAt?: string;
  readyAt?: string;
  serverItemId?: string;
}

export interface LocalPayment {
  opId: string;
  amount: number;
  method: 'cash';
  allocation?: { mode: 'equal'; parts: number; part: number };
  at: string;
  by: string;
  status: 'local' | 'confirmed' | 'attention';
}

export interface LocalOrder {
  localId: string;
  localNumber: string; // e.g. "OFF-3F2A-0007" (device prefix + per-device sequence)
  opId: string;
  tenantId: string;
  createdAt: string;
  createdBy: string;
  type: 'dine_in' | 'takeaway' | 'pickup' | 'delivery';
  tableId?: string;
  tableLabel?: string;
  customer?: { name?: string; phone?: string };
  delivery?: { address?: string };
  notes?: string;
  items: LocalItem[];
  totals: { subtotal: number; discount: number; lineDiscount: number; manualDiscount: number; serviceCharge: number; deliveryFee: number; tax: number; total: number };
  manualDiscount?: { type: 'percent' | 'fixed'; value: number; reason?: string };
  currency: string;
  pricesAsOf: string; // when the price snapshot used for this estimate was synchronised
  payments: LocalPayment[];
  syncState: 'saved_local' | 'confirmed' | 'attention';
  serverOrderId?: string;
  serverOrderNumber?: number;
  serverTotal?: number;
}

/** Wire format sent to POST /api/staff/sync. */
export interface WireOp {
  id: string;
  type: OpType;
  tenantId: string;
  userId: string;
  deviceId: string;
  createdAt: string;
  payload: any;
}

export type TransportResult =
  | { ok: true; data: any }
  | { ok: false; httpStatus: number; code: string; message: string; details?: unknown };

/** Thrown by a transport when the server could not be reached at all (offline, DNS, refused, timeout). */
export class NetworkError extends Error {
  constructor(message = 'Network unavailable') {
    super(message);
    this.name = 'NetworkError';
  }
}

export type Transport = (op: WireOp) => Promise<TransportResult>;

/** Minimal key/value store with collections (IndexedDB in browsers, memory in tests). */
export interface OfflineStore {
  get<T = any>(collection: Collection, key: string): Promise<T | undefined>;
  put(collection: Collection, key: string, value: unknown): Promise<void>;
  del(collection: Collection, key: string): Promise<void>;
  all<T = any>(collection: Collection): Promise<T[]>;
  clear(): Promise<void>;
}
export type Collection = 'ops' | 'orders' | 'snapshots' | 'meta' | 'quarantine';
