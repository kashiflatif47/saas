import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { API_URL, session } from '../api/client';
import { addLogoutHook, useAuth } from '../store/auth';
import { OfflineEngine, type SyncSummary } from './engine';
import { IdbStore } from './idbStore';
import { browserTransport, deviceId } from './browser';

interface OfflineState {
  /** null while the device storage is opening, or when this browser cannot store data offline. */
  engine: OfflineEngine | null;
  storageError: string | null;
  online: boolean;
  syncing: boolean;
  summary: SyncSummary | null;
  /** Increments whenever local data changes (this tab or another tab): re-read local data when it changes. */
  version: number;
  lastError: string | null;
  syncNow: () => Promise<void>;
  /** Pages call this when a request failed for network reasons, to switch to offline mode at once. */
  reportOffline: () => void;
}

const Ctx = createContext<OfflineState | null>(null);
const PROBE_ONLINE_MS = 30_000;
const PROBE_OFFLINE_MS = 5_000;
const AUTO_SYNC_MS = 15_000;

async function probe(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    const r = await fetch(`${API_URL}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(4_000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Offline layer for restaurant staff screens: opens this user's local queue, tracks connectivity, keeps the
 * queue synchronised and tells every open tab when local data changed.
 */
export function OfflineProvider({ children }: { children: ReactNode }) {
  const { user, tenant, offlineSession, resumeOnline } = useAuth();
  const [engine, setEngine] = useState<OfflineEngine | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [syncing, setSyncing] = useState(false);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [version, setVersion] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const scopeKey = user?.tenantId && user?.id ? `${user.tenantId}-${user.id}` : null;

  /* open the user's store */
  useEffect(() => {
    if (!scopeKey || !user || !tenant) return;
    let closed = false;
    let store: IdbStore | null = null;
    let off: (() => void) | undefined;
    IdbStore.open(user.tenantId!, user.id)
      .then(async (s) => {
        store = s;
        const e = new OfflineEngine(s, { tenantId: user.tenantId!, userId: user.id, userName: user.name, deviceId: deviceId() }, browserTransport);
        await e.init();
        await e.prune(7);
        if (closed) return;
        off = e.onChange(() => {
          setVersion((v) => v + 1);
          channel.current?.postMessage({ type: 'changed' });
        });
        setEngine(e);
        setStorageError(null);
      })
      .catch((err) => setStorageError(err?.message ?? 'Offline storage is not available in this browser'));
    try {
      channel.current = new BroadcastChannel(`tablesaas-offline-${scopeKey}`);
      channel.current.onmessage = () => setVersion((v) => v + 1);
    } catch {
      channel.current = null; // very old browsers: other tabs refresh on their own timers
    }
    return () => {
      closed = true;
      off?.();
      channel.current?.close();
      channel.current = null;
      store?.close();
      setEngine(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  /* logout: delete this user's local data only if nothing is waiting to sync */
  useEffect(() => {
    const remove = addLogoutHook(async ({ tenantId, userId }) => {
      if (!engine || !tenantId) return;
      const left = await engine.unsyncedCount();
      if (left === 0) await IdbStore.destroy(tenantId, userId);
    });
    return () => {
      remove();
    };
  }, [engine]);

  useEffect(() => {
    if (!engine) return;
    engine.summary().then(setSummary).catch(() => undefined);
  }, [engine, version]);

  /* connectivity */
  const reportOffline = useCallback(() => setOnline(false), []);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const ok = await probe();
      if (!alive) return;
      setOnline(ok);
      timer = setTimeout(tick, ok ? PROBE_ONLINE_MS : PROBE_OFFLINE_MS);
    };
    const now = () => {
      clearTimeout(timer);
      void tick();
    };
    const goneOffline = () => setOnline(false);
    window.addEventListener('online', now);
    window.addEventListener('offline', goneOffline);
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener('online', now);
      window.removeEventListener('offline', goneOffline);
    };
  }, []);

  // Back online after a session restored from cache: get a real session (and token) first.
  useEffect(() => {
    if (online && offlineSession) void resumeOnline();
  }, [online, offlineSession, resumeOnline]);

  /* synchronisation */
  const busy = useRef(false);
  const syncNow = useCallback(async (force = true) => {
    if (!engine || busy.current) return;
    if (offlineSession || !session.token) {
      const ok = await resumeOnline();
      if (!ok) return;
    }
    busy.current = true;
    setSyncing(true);
    const run = async () => {
      const r = await engine.sync({ force });
      if (r.stop === 'offline') setOnline(false);
      setLastError(r.stop === 'auth' ? 'Sign in again to send waiting records' : r.stop === 'server' ? 'The server reported a temporary problem; retrying automatically' : null);
    };
    try {
      // One tab sends at a time (the server deduplicates anyway); others skip this round.
      const locks: any = (navigator as any).locks;
      if (locks?.request) await locks.request(`tablesaas-sync-${scopeKey}`, { ifAvailable: true }, async (lock: unknown) => (lock ? run() : undefined));
      else await run();
    } catch (e: any) {
      setLastError(e?.message ?? 'Sync failed');
    } finally {
      busy.current = false;
      setSyncing(false);
      setSummary(await engine.summary());
    }
  }, [engine, offlineSession, resumeOnline, scopeKey]);

  useEffect(() => {
    if (!online || !engine) return;
    void syncNow(true); // as soon as the connection is back
    const t = setInterval(() => void syncNow(false), AUTO_SYNC_MS);
    return () => clearInterval(t);
  }, [online, engine, syncNow]);

  // New local work while online: send it promptly.
  useEffect(() => {
    if (online && engine && summary && summary.pending > 0 && !syncing) {
      const t = setTimeout(() => void syncNow(false), 500);
      return () => clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, online]);

  const value = useMemo<OfflineState>(
    () => ({ engine, storageError, online, syncing, summary, version, lastError, syncNow: () => syncNow(true), reportOffline }),
    [engine, storageError, online, syncing, summary, version, lastError, syncNow, reportOffline],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOffline() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useOffline outside OfflineProvider');
  return c;
}
/** For components that also render outside restaurant dashboards (platform console). */
export function useOfflineOptional() {
  return useContext(Ctx);
}
