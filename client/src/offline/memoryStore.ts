import type { Collection, OfflineStore } from './types';

/**
 * In-memory store with the same semantics as the IndexedDB store: values are deep-copied on write and read
 * (structured-clone behaviour), so tests cannot accidentally share object references. `persistAcross` lets
 * a test reopen the "same database" to simulate a browser restart.
 */
export class MemoryStore implements OfflineStore {
  constructor(private data: Map<string, Map<string, string>> = new Map(), public failWrites: (() => Error | null) | null = null) {}
  private col(c: Collection) {
    if (!this.data.has(c)) this.data.set(c, new Map());
    return this.data.get(c)!;
  }
  async get<T>(c: Collection, key: string) {
    const v = this.col(c).get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  async put(c: Collection, key: string, value: unknown) {
    const err = this.failWrites?.();
    if (err) throw err;
    this.col(c).set(key, JSON.stringify(value));
  }
  async del(c: Collection, key: string) {
    this.col(c).delete(key);
  }
  async all<T>(c: Collection) {
    return [...this.col(c).entries()].map(([key, v]) => {
      try {
        return JSON.parse(v) as T;
      } catch {
        return { __corrupt: true, key, raw: v } as unknown as T; // unreadable record: surfaced, never silently dropped
      }
    });
  }
  async clear() {
    this.data.clear();
  }
  /** Raw write that bypasses serialisation: used by tests to plant corrupted records. */
  rawPut(c: Collection, key: string, raw: string) {
    this.col(c).set(key, raw);
  }
  /** A second store instance over the same data (= reopening the database after a restart). */
  reopen() {
    return new MemoryStore(this.data);
  }
}
