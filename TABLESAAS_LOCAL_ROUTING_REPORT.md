# TableSaaS — Local Routing Report

**Date:** 2026-11-09 · **Scope:** local development only (no domain, hosting or deployment).
**Result:** every restaurant created in the Super Admin console opens at `http://<slug>.localhost:5173` in Chrome and Edge, with **no hosts-file edits**. All checks below were run on this laptop (Windows 11, Node 24.19.0, Vite 6.4.6).

## Root cause

The request flow (browser → Vite dev server → proxy → API → tenant lookup) was traced end to end. Tenant resolution itself was correct: the Vite proxy preserved the `Host` header, and the API mapped `the-broast.localhost` → `the-broast`. The failure was in the **links the app generated**:

1. **Restaurant URLs and QR codes had no port** (primary cause). The server built every restaurant address as `${APP_PROTOCOL}://${slug}.${ROOT_DOMAIN}` = `http://the-broast.localhost`, which is port 80, where nothing listens. That affected five places: the Super Admin "open restaurant" link, the "Provisioned at …" message, the owner's Settings storefront address, the Tables "Link" button, and every QR code (PNG, SVG, printable PDF). Only the dashboard's "View storefront" worked, because it was built client-side with the browser's port.
   **Reproduced in Chrome on your real restaurant:** `http://the-broast.localhost/` → *"This site can't be reached — the-broast.localhost refused to connect"*; `http://the-broast.localhost:5173/` → the storefront loads.
2. **Windows does not resolve `*.localhost`; browsers do.** `dns.lookup('brost.localhost')` and the Windows resolver both return *"No such host is known"*, and the hosts file has no entries. Chrome and Edge map any `*.localhost` name to loopback internally (RFC 6761), so subdomains work in the browser but not in curl, PowerShell or Node. Testing with those tools looks like a DNS failure even when the app is fine.
3. **Your restaurant's subdomain is `the-broast`, not `brost`.** The dev database holds one restaurant, `the-broast` (active, trial). `http://brost.localhost:5173` correctly shows "Restaurant not found".

### Related problems fixed in the same flow
- **Vite host validation was disabled:** `allowedHosts: true` accepted any `Host` header (no DNS-rebinding protection), and `vite --host` exposed the dev server to the whole local network. Now only `localhost` / `*.localhost` (plus a configured `VITE_ROOT_DOMAIN`) are accepted, foreign hosts get 403, and Vite listens on loopback only.
- **Port drift:** Vite silently moved to 5174 when 5173 was busy, which made generated links point at the wrong server. Now `strictPort` is on.
- **Anonymous session probe logged a 401 console error** on every login page. A request without any session cookie now gets `204 No Content`; an invalid, revoked or replayed cookie still gets 401 and revocation.
- **React Router v7 warnings** on every page: opted in to the v7 behaviour (no relative links exist, so no change in navigation).
- **Vite logged `ws proxy socket error: ECONNRESET/ECONNABORTED`** whenever a dashboard tab closed (normal WebSocket disconnects). Only those harmless codes are filtered; other proxy errors still print.

## Files changed and why

| File | Change |
|---|---|
| `server/src/lib/appUrl.ts` (new) | Builds platform and restaurant URLs **per request**. Port = `APP_PUBLIC_PORT` if set; otherwise, outside production, the port of the browser-facing host (only when that host is `ROOT_DOMAIN` or a subdomain of it, and only the digits); production never adds a port. Nothing is stored in the DB |
| `server/src/routes/tables.ts` | QR PNG/SVG/PDF and table links use the new builder |
| `server/src/routes/superadmin.ts` | Restaurant URL on create and on the detail page |
| `server/src/routes/tenantAdmin.ts` | Owner's storefront address |
| `server/src/config/env.ts` | Optional `APP_PUBLIC_PORT` (digits only) |
| `server/src/routes/auth.ts` | `/refresh` with no cookie → 204 (no session) instead of a 401 console error |
| `server/src/seed.ts` | Demo URL printed with the dev port |
| `client/vite.config.ts` | Restricted `allowedHosts`; loopback binding; `strictPort`; overridable `VITE_DEV_PORT` / `VITE_DEV_API_TARGET` / `VITE_DEV_HOST`; Host-preserving proxy for `/api`, `/uploads`, `/socket.io` (dev and preview); harmless WebSocket-disconnect log filter |
| `client/package.json` | `dev` = `vite` (loopback); new opt-in `dev:lan` |
| `client/src/api/client.ts` | Treats 204 from `/refresh` as "no session" |
| `client/src/main.tsx` | React Router v7 future flags |
| `server/.env.example`, `client/.env.example` | Documented local settings; why `VITE_API_URL` stays empty |
| `server/tests/e2e/local-routing.ts` (new), `server/package.json` | `npm run test:local-routing` against your running dev server |
| `server/tests/unit/core.test.ts`, `server/tests/integration/hardening.test.ts`, `server/tests/e2e/journey.ts` | URL builder tests (incl. forged-host rejection), 204/401 refresh test, journey expects port-correct URLs |
| `TABLESAAS_PRODUCTION_GUIDE.md` | Local-subdomain note updated |

No database schema changes. No new packages. Existing restaurant records work unchanged.

## Local environment configuration

`server/.env`: **no changes were needed or made.** It is already correct for local subdomains (`NODE_ENV=development`, `ROOT_DOMAIN=localhost`, `APP_PROTOCOL=http`, `CLIENT_ORIGIN=http://localhost:5173`); secrets and the MongoDB URI were left untouched and never printed. `client/.env` does not exist, and the defaults are correct (`VITE_ROOT_DOMAIN=localhost`, empty `VITE_API_URL`). `ALLOW_TENANT_HEADER=true` in your dev `.env` is no longer needed now that subdomains work, but it is harmless locally (production refuses it).

## Commands to start

```bash
# from the project root (stop any running `npm run dev` first so Vite picks up its new config)
npm run dev
```

Then open `http://localhost:5173` (platform) and `http://<slug>.localhost:5173` (each restaurant).

## URLs tested and results

**A. Isolated full test.** The real `npm run dev` code path (tsx watch API + Vite) on ports 4100/5180 with a throwaway in-memory database, so no test data was written to your Atlas database. Restaurants `brost` and `restaurant2` were created through the Super Admin API. Real Chrome:

| URL | Result |
|---|---|
| `http://localhost:5180/` | → `/login`, "Platform sign in"; Super Admin signs in → `/admin` |
| Super Admin → Brost restaurant page link | `http://brost.localhost:5180/` |
| `http://brost.localhost:5180/` | "Brost Grill" + its dish |
| `http://restaurant2.localhost:5180/` | "Restaurant Two" + its own dish only |
| `http://does-not-exist.localhost:5180/` | "Restaurant not found" |
| `http://brost.localhost:5180/t/<token>` (QR URL) | Brost menu with the "Table T1" badge |
| `http://brost.localhost:5180/login` → owner sign-in | `/dashboard` "Brost Grill"; Tables page renders the QR image; session survives reload |
| `http://restaurant2.localhost:5180/dashboard` (same browser) | redirected to `/login`: Brost's session does not leak |
| `http://localhost:5180/admin` | Super Admin still signed in (independent session) |

Browser console: **0 errors** on all pages except the two intended 404s on the unknown-restaurant page. Phone-width (390 px) layouts have no horizontal overflow. API log: 212 requests with the correct tenant host on each (`brost.localhost`, `restaurant2.localhost`, …), **0 5xx, 0 `[ERROR]`, 0 `[SECURITY]`**.

**B. Your running dev stack on :5173 and your real database (read-only, no sign-in, no writes):**

| URL | Browser | Result |
|---|---|---|
| `http://localhost:5173/` | Chrome | Platform sign-in |
| `http://the-broast.localhost:5173/` | Chrome, **Edge** | "The broast" storefront (no dishes yet: empty-menu message) |
| `http://the-broast.localhost:5173/login` | Chrome | "Signing in to the-broast" |
| `http://brost.localhost:5173/` | Chrome, **Edge** | "Restaurant not found" (no such slug) |
| `http://the-broast.localhost/` (old generated URL) | Chrome | "refused to connect" (the original bug) |

## Tests actually passed

| Check | Result |
|---|---|
| `npm run typecheck` (server src + tests, client) | pass |
| `npm test` (server unit + integration) | **69/69** (2 new) |
| `npm run build` (server + client) | pass |
| `npm run e2e` (built app, 20-step business journey, port-correct URL and QR assertions) | **20/20** |
| `npm run test:local-routing` through the Vite dev server (`*.localhost` acceptance, foreign host 403, URLs with port, slug resolution, unknown slug 404, owner login, host-only cookie, cookie replay on another subdomain → 401, isolation, QR decode → menu → order) | **9/9** (run twice) |
| Real Chrome via DevTools protocol (14 page states) + Edge (2 pages) | pass, as listed above |

## Genuine remaining limitations

1. **Phones cannot open `*.localhost`** URLs from QR codes; on a phone, `localhost` is the phone itself. Local QR testing happens in the laptop browser (verified) or by decoding the PNG (verified). Phone scanning needs a reachable domain, which is out of scope here.
2. **Firefox was not verified** (not installed). Recent versions resolve `*.localhost`; if yours doesn't, use the per-restaurant hosts-file lines in the guide (§5).
3. **Windows command-line tools don't resolve `*.localhost`.** Use `curl -H "Host: <slug>.localhost:5173" http://localhost:5173/...`.
4. **Your running `npm run dev` must be restarted once** to load the new Vite configuration. Until then it runs the old config (any host accepted, LAN-exposed); the corrected URLs already work, because the API hot-reloaded.
5. While I was editing, your API watcher's server stopped after a hot reload. I restarted it by touching `server/src/server.ts`; it is healthy on :4000 again.
