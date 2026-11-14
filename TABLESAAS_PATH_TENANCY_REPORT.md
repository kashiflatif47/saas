# TableSaaS — Path-based restaurant URLs (`/r/<slug>`)

**Date:** 2026-11-12 · **Status:** implemented and tested locally, **not deployed, not committed**

## Why

Hostinger's managed Node.js hosting only sends the root domain to the Express app. A restaurant subdomain
(`hahha.nftloyal.shop`) went to Hostinger's PHP/hcdn default site, so `/api/health` returned Hostinger's 404.
Restaurants now live under the one domain that does reach the app:

| Site | URL |
|---|---|
| Platform | `https://nftloyal.shop/`, `/admin`, `/admin/tenants`, `/admin/plans` |
| Storefront | `https://nftloyal.shop/r/<slug>` (`/t/<qr-token>`, `/order/<id>`, `/reserve`, `/unsubscribe`) |
| Staff sign-in | `https://nftloyal.shop/r/<slug>/login` |
| Dashboard | `https://nftloyal.shop/r/<slug>/dashboard/...` (all existing modules) |

No DNS, subdomain or Hostinger setup is needed per restaurant. Existing tenant records and slugs are unchanged.

## Design

**Routing (client).** `client/src/lib/site.ts` parses the URL once into a *site context*: `platform`, `path`
(`/r/<slug>`), `subdomain` (legacy), `custom` (custom domain) or `invalid`. For `path` sites, `/r/<slug>`
becomes the React Router `basename`, so every existing route, `<Link>`, `navigate()` and redirect stays the
same and automatically stays inside the restaurant. Slugs are validated with the server's slug rules (a full
hostname is never treated as a slug). Uppercase slugs are lowercased.

**Public API.** The client still calls `/api/public/<x>`. On a path site, the API client rewrites that to
`/api/public/tenants/<slug>/<x>`. The server resolves the restaurant from the path with the same rules as before
(exists, not suspended, subscription allows operation). Host-based resolution (subdomains, custom domains) is
kept. `ALLOW_TENANT_HEADER` is unchanged and still refused in production.

**Staff authorization** still comes only from the verified JWT plus the user record in MongoDB. Path sites also
send `X-Tenant-Context: <slug>`. It can only *refuse* a request (403 when it differs from the JWT's tenant); it
never grants access.

**Refresh sessions on a shared host.** Every session has its own cookie scope:

| Session | Cookie | Path |
|---|---|---|
| Super admin / subdomain restaurant | `rt` (unchanged) | `/api/auth` |
| Path restaurant `<slug>` | `trt` | `/api/auth/tenants/<slug>` |

New endpoints: `POST /api/auth/tenants/<slug>/{login,refresh,logout}`. The browser only sends a restaurant's
cookie to that restaurant's endpoints. The server still checks the token hash, expiry, user, and that the
user's **real** tenant (from MongoDB) is the restaurant in the URL. Logging out ends only that one session.
Cookies stay HttpOnly, SameSite=Lax, and Secure in production. The cookie scope after login or a password
change is taken from the user's tenant in the DB, never from client input.

**Offline.** The cached session (IndexedDB, no tokens) now uses one slot per restaurant, and a payload is
rejected unless it belongs to the current site. Offline order queues were already per tenantId+userId.

**PWA.** `/r/<slug>/manifest.webmanifest` is served with `start_url`/`id` set to `/r/<slug>/`. This way a
tablet that installs the app from a restaurant opens that restaurant, not the platform.

**SPA fallback.** `/r/<unknown>` still returns the app (which shows "Restaurant not found") but with HTTP 404.
`/r/UPPER` redirects 301 to lowercase.

## Configuration

- Server: new `TENANT_URL_MODE` (`path` default | `subdomain`). **No production env change required.** No
  secrets, `ROOT_DOMAIN`, `MONGODB_URI` or `CLIENT_DIST_DIR` changes.
- Client: `client/.env.production` (new, non-secret) sets `VITE_ROOT_DOMAIN=nftloyal.shop` and
  `VITE_TENANT_URL_MODE=path` for every production build. `.gitignore` gained `!client/.env.production` so the
  file can be committed. The client build that was in `client/dist` before this change had been built with
  `localhost`, which on nftloyal.shop makes the app behave as a storefront-only "custom domain". The Vite config
  now warns if a production build has a localhost root.

## Hostinger capability check (live, read-only probes on 2026-11-12)

- `GET https://nftloyal.shop/api/health` → 200 `{"status":"ok","db":"connected"}`. Express serves the root domain.
- Socket.IO polling handshake → 200 with `"upgrades":["websocket"]`.
- WebSocket upgrade → **`101 Switching Protocols`** through `Server: hcdn`. WebSockets work on the current plan.
- Uptime ≈ 3.8 h at probe time, so the process is long-lived and the in-process job worker (`setInterval`)
  runs. Jobs are stored in MongoDB, so after a restart they resume where they left off. Not verified: whether
  Hostinger idles the process during long periods without traffic. If it does, scheduled jobs pause until the
  next request wakes the app.
- Socket rooms and the tenant cache are in-process, so this assumes **one** Node.js instance (true for this plan).

## Tests

| Command | Result |
|---|---|
| `npm --prefix server run typecheck` | pass |
| `npm --prefix server test` | **188 / 188 pass** (157 existing + 31 new) |
| `npm --prefix server run build` | pass (`server/dist/server.js`) |
| `npm --prefix client run typecheck` | pass |
| `npm --prefix client run build` | pass; bundle contains `nftloyal.shop` |

New: `server/tests/integration/pathTenancy.test.ts` (17 tests), `server/tests/unit/clientSite.test.ts` (11 tests),
and URL/slug tests in `server/tests/unit/core.test.ts`. One existing URL assertion was updated to the new
default URL format, and a separate test now covers subdomain mode.

**Not covered automatically:** clicking through the React UI in a real browser. The project has no browser
test runner and none was added. The routing logic is unit-tested and the app type-checks and builds. Do a
manual pass before you deploy (checklist below).

## Manual acceptance checklist (after deploying)

1. `https://nftloyal.shop/admin` → sign in as super admin → Restaurants → create "Hahha". The toast and the list
   show `https://nftloyal.shop/r/hahha`.
2. Open `/r/hahha` (storefront), `/r/hahha/login`, then `/r/hahha/dashboard`. Reload on `/r/hahha/dashboard/orders`.
3. Tables & QR → scan or open a QR → `/r/hahha/t/<token>` → order → tracking page updates live.
4. Create `pizza` and sign in at `/r/pizza/login` in another tab. Both dashboards stay signed in, and signing out
   of one leaves the other (and `/admin`) signed in.
5. `/r/does-not-exist` shows "Restaurant not found".
6. Optional: remove the manually created `hahha.nftloyal.shop` subdomain in Hostinger (no longer used).

## Files

Backups of every modified file: `_backup_path_tenancy_20261112/` (same relative paths).

Server: `src/lib/subdomain.ts`, `src/lib/appUrl.ts`, `src/config/env.ts`, `src/middleware/tenant.ts`,
`src/routes/auth.ts`, `src/app.ts`, `src/routes/superadmin.ts`, `src/seed.ts`, `.env.example`, tests.
Client: `src/lib/site.ts` (new), `src/lib/util.ts`, `src/api/client.ts`, `src/main.tsx`, `src/App.tsx`,
`src/store/auth.tsx`, `src/offline/browser.ts`, `src/offline/idbStore.ts` (comment),
`src/pages/store/TenantNotFound.tsx` (new), `Storefront.tsx`, `TableLanding.tsx`, `auth/Login.tsx`,
`admin/Tenants.tsx`, `admin/TenantAccounts.tsx`, `vite.config.ts`, `.env.example`, `.env.production` (new).
Root: `.gitignore`.
