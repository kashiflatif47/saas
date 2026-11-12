import { API_URL, refreshAccessToken, session } from '../api/client';
import { NetworkError, type Transport } from './types';

/** Stable per-browser device id (not a secret; identifies which till recorded an operation). */
export function deviceId(): string {
  const k = 'tablesaas:device';
  try {
    let v = localStorage.getItem(k);
    if (!v) {
      const b = new Uint8Array(8);
      crypto.getRandomValues(b);
      v = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(k, v);
    }
    return v;
  } catch {
    return 'nostorage';
  }
}

async function post(body: unknown, timeoutMs: number) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Tenant-Host': window.location.host };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  try {
    return await fetch(`${API_URL}/api/staff/sync`, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new NetworkError('Server unreachable');
  }
}

/**
 * Sends one queued operation. Connectivity problems (and a gateway reporting the API down) throw NetworkError;
 * every answer from the API is returned as-is so the engine can classify it. A 401 first renews the session
 * from the refresh cookie once.
 */
export const browserTransport: Transport = async (op) => {
  let r = await post(op, 20_000);
  if (r.status === 401 && (await refreshAccessToken())) r = await post(op, 20_000);
  const body = await r.json().catch(() => null);
  if (r.status >= 500 && r.status <= 504 && !body?.error?.code) throw new NetworkError('Server unavailable');
  if (r.ok) return { ok: true, data: body };
  return { ok: false, httpStatus: r.status, code: body?.error?.code ?? 'ERROR', message: body?.error?.message ?? `Request failed (${r.status})`, details: body?.error?.details };
};

/* -------------------------------------------------------------- cached session (no secrets) */

const SESSION_DB = 'tablesaas-session';
/** A cached session older than this cannot be used offline: someone must sign in online again. */
export const OFFLINE_SESSION_MAX_AGE_MS = 24 * 3600_000;

function sessionDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const r = indexedDB.open(SESSION_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('session');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * Remembers who is signed in on this site (user, restaurant, permissions) so a refresh while offline keeps the
 * POS usable. Access and refresh tokens are NEVER stored here; syncing needs a real online session again.
 */
export async function saveSessionCache(payload: { user: any; tenant: any; permissions: string[] }) {
  try {
    const db = await sessionDb();
    const t = db.transaction('session', 'readwrite');
    t.objectStore('session').put({ user: payload.user, tenant: payload.tenant, permissions: payload.permissions, host: location.host, savedAt: Date.now() }, 'current');
    await new Promise((res) => (t.oncomplete = res));
    db.close();
  } catch {
    /* offline mode unavailable in this browser: online use is unaffected */
  }
}

export async function loadSessionCache(): Promise<{ user: any; tenant: any; permissions: string[]; savedAt: number } | null> {
  try {
    const db = await sessionDb();
    const v: any = await new Promise((res, rej) => {
      const r = db.transaction('session', 'readonly').objectStore('session').get('current');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    if (!v || v.host !== location.host || Date.now() - v.savedAt > OFFLINE_SESSION_MAX_AGE_MS) return null;
    return v;
  } catch {
    return null;
  }
}

export async function clearSessionCache() {
  try {
    const db = await sessionDb();
    const t = db.transaction('session', 'readwrite');
    t.objectStore('session').delete('current');
    await new Promise((res) => (t.oncomplete = res));
    db.close();
  } catch {
    /* nothing cached */
  }
}
