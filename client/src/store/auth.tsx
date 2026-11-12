import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, isNetworkFailure, refreshSession, session } from '../api/client';
import { clearSessionCache, loadSessionCache, saveSessionCache } from '../offline/browser';
import { applyTheme, currentTenantSlug } from '../lib/util';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
  tenantId: string | null;
  assignedTableIds: string[];
  stationIds: string[];
}
export interface SessionTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  branding: any;
  settings: any;
  subscription: { status: string; trialEndsAt?: string; currentPeriodEnd?: string };
  features: string[];
}

interface AuthState {
  ready: boolean;
  user: SessionUser | null;
  tenant: SessionTenant | null;
  permissions: string[];
  can: (...p: string[]) => boolean;
  hasFeature: (f: string) => boolean;
  login: (email: string, password: string, tenantSlug?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  /** True when the user was restored from this device's cached session because the server was unreachable. */
  offlineSession: boolean;
  /** Re-establishes a real session once the server is reachable again (returns false if it has ended). */
  resumeOnline: () => Promise<boolean>;
}

/* Logout hooks let the offline layer clean up the device (it decides what is safe to delete). */
const logoutHooks = new Set<(u: { tenantId: string | null; userId: string }) => Promise<void> | void>();
export function addLogoutHook(fn: (u: { tenantId: string | null; userId: string }) => Promise<void> | void) {
  logoutHooks.add(fn);
  return () => logoutHooks.delete(fn);
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tenant, setTenant] = useState<SessionTenant | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [offlineSession, setOfflineSession] = useState(false);

  const apply = useCallback((j: any, fromCache = false) => {
    setUser(j.user);
    setTenant(j.tenant);
    setPermissions(j.permissions ?? []);
    setOfflineSession(fromCache);
    if (j.tenant?.branding?.theme) applyTheme(j.tenant.branding.theme);
    // Restaurant staff only: remember the session (never the tokens) for refreshes while offline.
    if (!fromCache && j.user?.tenantId) void saveSessionCache(j);
  }, []);

  useEffect(() => {
    session.onLost(() => {
      void clearSessionCache(); // the server ended this session: it must not be resumed offline
      setUser(null);
      setTenant(null);
      setPermissions([]);
    });
    // Only staff/admin pages can have a session; customer storefront pages skip the probe entirely.
    const needsSession = !currentTenantSlug() || /^\/(login|dashboard|admin)(\/|$)/.test(window.location.pathname);
    if (!needsSession) {
      setReady(true);
      return;
    }
    refreshSession()
      .then((j) => j && apply(j))
      .catch(async (e) => {
        // Server unreachable: continue with this device's cached session (offline mode), if recent enough.
        if (!isNetworkFailure(e)) return;
        const cached = await loadSessionCache();
        if (cached) apply(cached, true);
      })
      .finally(() => setReady(true));
  }, [apply]);

  const login = useCallback(
    async (email: string, password: string, tenantSlug?: string) => {
      const j = await api.post('/api/auth/login', { email, password, tenantSlug });
      session.set(j.accessToken);
      apply(j);
    },
    [apply],
  );

  const resumeOnline = useCallback(async () => {
    try {
      const j = await refreshSession();
      if (j) {
        apply(j);
        return true;
      }
      // The server answered: this session is over (expired or revoked). Queued work stays on the device.
      await clearSessionCache();
      setUser(null);
      setTenant(null);
      setPermissions([]);
      setOfflineSession(false);
      return false;
    } catch {
      return false; // still unreachable
    }
  }, [apply]);

  const logout = useCallback(async () => {
    if (user) for (const h of logoutHooks) await Promise.resolve(h({ tenantId: user.tenantId, userId: user.id })).catch(() => undefined);
    await clearSessionCache();
    await api.post('/api/auth/logout').catch(() => undefined);
    session.set(null);
    setUser(null);
    setTenant(null);
    setPermissions([]);
    setOfflineSession(false);
  }, [user]);

  const refreshMe = useCallback(async () => apply(await api.get('/api/auth/me')), [apply]);

  const can = useCallback((...p: string[]) => p.some((x) => permissions.includes(x)), [permissions]);
  const hasFeature = useCallback((f: string) => !!tenant?.features?.includes(f), [tenant]);

  return <Ctx.Provider value={{ ready, user, tenant, permissions, can, hasFeature, login, logout, refreshMe, offlineSession, resumeOnline }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}
