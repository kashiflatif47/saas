import type { Collection, OfflineStore } from './types';

const COLLECTIONS: Collection[] = ['ops', 'orders', 'snapshots', 'meta', 'quarantine'];
const VERSION = 1;

/**
 * IndexedDB store. One database per restaurant AND staff member:
 *  - each restaurant runs on its own origin (brost.example.com), and browsers never share IndexedDB between
 *    origins, so restaurant A's data cannot appear on restaurant B;
 *  - within an origin the database name includes the user id, so another employee signing in on the same
 *    device never sees the previous person's queue.
 * Records are stored as plain objects; nothing in here is a credential (access tokens are never stored).
 */
export function dbName(tenantId: string, userId: string) {
  return `tablesaas-offline-${tenantId}-${userId}`;
}

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available in this browser'));
    const req = indexedDB.open(name, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const c of COLLECTIONS) if (!db.objectStoreNames.contains(c)) db.createObjectStore(c);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open local storage'));
    req.onblocked = () => reject(new Error('Local storage is blocked by another tab; close other TableSaaS tabs and retry'));
  });
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbStore implements OfflineStore {
  private constructor(private db: IDBDatabase) {}

  static async open(tenantId: string, userId: string) {
    const db = await open(dbName(tenantId, userId));
    // Ask the browser not to evict this data under storage pressure (best effort; may be refused).
    try {
      await (navigator as any).storage?.persist?.();
    } catch {
      /* not supported */
    }
    return new IdbStore(db);
  }

  private tx(c: Collection, mode: IDBTransactionMode) {
    return this.db.transaction(c, mode).objectStore(c);
  }

  get<T>(c: Collection, key: string) {
    return wrap(this.tx(c, 'readonly').get(key)) as Promise<T | undefined>;
  }

  /** Resolves only after the transaction COMMITS, so "saved" means durably on disk. Quota errors reject. */
  put(c: Collection, key: string, value: unknown) {
    return new Promise<void>((resolve, reject) => {
      const t = this.db.transaction(c, 'readwrite');
      t.objectStore(c).put(value, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('Write failed'));
      t.onabort = () => reject(t.error ?? new Error('Write aborted (device storage may be full)'));
    });
  }

  del(c: Collection, key: string) {
    return new Promise<void>((resolve, reject) => {
      const t = this.db.transaction(c, 'readwrite');
      t.objectStore(c).delete(key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  all<T>(c: Collection) {
    return wrap(this.tx(c, 'readonly').getAll()) as Promise<T[]>;
  }

  async clear() {
    for (const c of COLLECTIONS) {
      await new Promise<void>((resolve, reject) => {
        const t = this.db.transaction(c, 'readwrite');
        t.objectStore(c).clear();
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    }
  }

  close() {
    this.db.close();
  }

  /** Deletes a user's whole offline database (logout cleanup once nothing is waiting to sync). */
  static destroy(tenantId: string, userId: string) {
    return new Promise<void>((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve();
      const req = indexedDB.deleteDatabase(dbName(tenantId, userId));
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
}

/** True when an error means "the device has no space left" (so the UI never claims the order was saved). */
export function isQuotaError(e: unknown) {
  const n = (e as any)?.name ?? '';
  return n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota|storage.*full/i.test(String((e as any)?.message ?? ''));
}
