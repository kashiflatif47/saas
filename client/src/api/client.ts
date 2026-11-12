import { downloadBlob } from '../lib/util';

export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: any) {
    super(message);
  }
}

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;
let refreshing: Promise<boolean> | null = null;

export const session = {
  get token() {
    return accessToken;
  },
  set(token: string | null) {
    accessToken = token;
  },
  onLost(cb: () => void) {
    onSessionLost = cb;
  },
};

async function refresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch(`${API_URL}/api/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Tenant-Host': window.location.host } })
      .then(async (r) => {
        if (!r.ok || r.status === 204) return false;
        const j = await r.json();
        accessToken = j.accessToken;
        return true;
      })
      .catch(() => false)
      .finally(() => setTimeout(() => (refreshing = null), 0));
  }
  return refreshing;
}

/** Renews the in-memory access token from the refresh cookie (shared with in-flight API retries). */
export const refreshAccessToken = () => refresh();

/**
 * True when the server could not be reached (no connection, DNS, refused, or a proxy/gateway reporting the API
 * down). Such failures are NOT answers from TableSaaS: offline mode takes over instead of showing an error.
 */
export function isNetworkFailure(e: unknown): boolean {
  if (e instanceof TypeError) return true; // fetch() rejects with TypeError when offline
  if (e instanceof ApiError) return e.code === 'NETWORK' || (e.status >= 500 && e.status <= 504 && !e.code);
  return (e as any)?.name === 'NetworkError';
}

/** Session probe. Returns null when signed out; THROWS (code NETWORK) when the server cannot be reached. */
export async function refreshSession(): Promise<any | null> {
  let r: Response;
  try {
    r = await fetch(`${API_URL}/api/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Tenant-Host': window.location.host } });
  } catch {
    throw new ApiError(0, 'No connection to the server', 'NETWORK');
  }
  if (r.status >= 500 && r.status <= 504) {
    const body = await r.clone().json().catch(() => null);
    if (!body?.error?.code) throw new ApiError(r.status, 'The server is not reachable', 'NETWORK');
  }
  if (!r.ok || r.status === 204) return null; // 204 = no session cookie
  const j = await r.json();
  accessToken = j.accessToken;
  return j;
}

type Opts = { method?: string; body?: unknown; raw?: boolean; form?: FormData; signal?: AbortSignal; retry?: boolean };

export async function request<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Tenant-Host': window.location.host };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      credentials: 'include',
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      signal: opts.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, 'No connection to the server', 'NETWORK');
  }
  if (res.status === 401 && accessToken && opts.retry !== false && !path.startsWith('/api/auth/')) {
    if (await refresh()) return request<T>(path, { ...opts, retry: false });
    accessToken = null;
    onSessionLost?.();
  }
  if (!res.ok) {
    let j: any = {};
    try {
      j = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const details = j?.error?.details;
    const fieldMsg = details?.fieldErrors ? Object.entries(details.fieldErrors).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`).join('; ') : '';
    throw new ApiError(res.status, j?.error?.message ? `${j.error.message}${fieldMsg ? ` — ${fieldMsg}` : ''}` : `Request failed (${res.status})`, j?.error?.code, details);
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T = any>(p: string, signal?: AbortSignal) => request<T>(p, { signal }),
  post: <T = any>(p: string, body?: unknown) => request<T>(p, { method: 'POST', body: body ?? {} }),
  patch: <T = any>(p: string, body: unknown) => request<T>(p, { method: 'PATCH', body }),
  put: <T = any>(p: string, body: unknown) => request<T>(p, { method: 'PUT', body }),
  del: <T = any>(p: string, body?: unknown) => request<T>(p, { method: 'DELETE', body }),
  upload: <T = any>(p: string, files: File | File[], field = 'file') => {
    const fd = new FormData();
    (Array.isArray(files) ? files : [files]).forEach((f) => fd.append(field, f));
    return request<T>(p, { method: 'POST', form: fd });
  },
  /** Downloads a file response (CSV/PDF/PNG) through the authenticated client. */
  async download(p: string, fallbackName: string) {
    const res = await request<Response>(p, { raw: true });
    const cd = res.headers.get('content-disposition') ?? '';
    const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
    const blob = await res.blob();
    downloadBlob(blob, name);
  },
  async blobUrl(p: string) {
    const res = await request<Response>(p, { raw: true });
    return URL.createObjectURL(await res.blob());
  },
};

export const assetUrl = (u?: string | null) => (!u ? '' : u.startsWith('http') ? u : `${API_URL}${u}`);

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
