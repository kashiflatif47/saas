import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

/** Loads a GET endpoint with loading/error state. Pass null to skip. */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const ctrl = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError(null);
    try {
      const d = await api.get<T>(path, c.signal);
      if (!c.signal.aborted) setData(d);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? 'Failed to load');
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    load();
    return () => ctrl.current?.abort();
  }, [load]);

  return { data, setData, error, loading, reload: load };
}

/** Wraps an async action with pending state and toast-friendly error capture. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const run = useCallback(
    async (...a: A) => {
      setPending(true);
      try {
        return await fn(...a);
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  return { run, pending };
}
