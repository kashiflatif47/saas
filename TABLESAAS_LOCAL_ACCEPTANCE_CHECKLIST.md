# TableSaaS — Local Development Acceptance Checklist

Statuses: **VERIFIED** (executed, evidence listed) · **TESTED** (automated test) · **NOT VERIFIED** (could not be run here, reason given).
Evidence: `LR` = `npm run test:local-routing` through the Vite dev server (9/9) · `CH` = real Chrome via DevTools protocol · `ED` = Microsoft Edge · `UT/IT` = unit/integration tests (69/69) · `E2E` = `npm run e2e` (20/20). Date: 2026-11-09.

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Root cause identified by tracing the full request flow | VERIFIED | portless URLs reproduced in CH on your real restaurant ("refused to connect") vs. working `:5173` URL |
| 2 | Vite accepts `*.localhost` | VERIFIED | LR; CH on `brost`, `restaurant2`, `the-broast` |
| 3 | Vite host validation stays safe (foreign hosts rejected) | VERIFIED | LR: `Host: attacker.example` → 403 |
| 4 | Dev server bound to a local interface only | VERIFIED | `netstat`: Vite on `[::1]:5180` only; LAN access is opt-in (`npm run dev:lan`) |
| 5 | `http://localhost:5173` is the platform / Super Admin | VERIFIED | CH (yours and isolated): `/login` "Platform sign in" → `/admin` |
| 6 | `http://<slug>.localhost:5173` opens without hosts-file edits | VERIFIED (Chrome, Edge) | CH + ED; hosts file unchanged |
| 7 | Tenant resolved dynamically from the hostname (no hard-coded slugs) | VERIFIED | LR (random `routing-test-*` slugs); API log hosts; CH `brost` vs `restaurant2` |
| 8 | Unknown slug → proper not-found | VERIFIED | LR (404 "Restaurant not found"); CH + ED page |
| 9 | Inactive restaurant handled | TESTED | IT/E2E: suspended → storefront 503 "temporarily unavailable", staff signed out |
| 10 | Platform admin access works | VERIFIED | LR; CH sign-in, restaurants list, restaurant page |
| 11 | Restaurant admin authentication works on its subdomain | VERIFIED | LR; CH owner sign-in → dashboard; session survives reload |
| 12 | Sessions isolated per subdomain (host-only cookie; no cross-restaurant reuse) | VERIFIED | LR: cookie has no `Domain`; A's cookie on B → 401; CH: `restaurant2/dashboard` → login |
| 13 | API calls from restaurant subdomains reach `localhost:4000` | VERIFIED | API log shows `host=brost.localhost` etc. via the Vite proxy; LR API steps |
| 14 | CORS without wildcard-credential insecurity | VERIFIED | same-origin via proxy (no CORS needed); server allows only `localhost`/`*.localhost` origins in dev, never `*` with credentials |
| 15 | Tenant data isolation | VERIFIED | LR (B can't read A's dish; B token on A host 403; A's QR 404 on B); IT isolation suite; E2E |
| 16 | Restaurant creation returns the correct local URL | VERIFIED | LR + CH: `http://brost.localhost:5180` on create and on the detail page |
| 17 | No domain stored in restaurant records | VERIFIED | URLs computed per request (`server/src/lib/appUrl.ts`); no schema change |
| 18 | Existing restaurant records keep working | VERIFIED | `the-broast` (your DB) loads at `:5173` in CH + ED, read-only |
| 19 | QR codes use the restaurant's local URL | VERIFIED | LR: Tables link + PNG decoded = `http://<slug>.localhost:<port>/t/<token>`; UT |
| 20 | QR URL opens that restaurant's customer menu, slug preserved | VERIFIED | LR (landing, token, menu, order); CH "Table T1" badge on brost |
| 21 | Production URLs unaffected | TESTED | code path: production never adds a request-derived port; E2E/UT |
| 22 | Forged `Host` header cannot inject a domain into links | TESTED | UT: foreign or malformed hosts contribute nothing |
| 23 | Local env configured; secrets and MongoDB untouched and unprinted | VERIFIED | `server/.env` unchanged; env validated with values masked |
| 24 | Root `npm run dev` workflow works | VERIFIED | same scripts (`tsx watch` + Vite) exercised on alternate ports; your running `npm run dev` serves `the-broast` |
| 25 | Browser console free of errors | VERIFIED | CH: 0 errors except intended 404s on the not-found page |
| 26 | Backend logs free of errors | VERIFIED | 0 5xx, 0 `[ERROR]`, 0 `[SECURITY]`; harmless WebSocket-disconnect noise filtered in Vite |
| 27 | Typecheck, builds, all tests pass after changes | VERIFIED | typecheck ✓ · build ✓ · 69/69 · E2E 20/20 · LR 9/9 |
| 28 | Firefox `*.localhost` | NOT VERIFIED | Firefox not installed; hosts-file fallback documented |
| 29 | Scanning a local QR with a real phone | NOT VERIFIED (by design) | phones cannot reach `*.localhost` on the laptop; laptop-browser and decode tests VERIFIED |
| 30 | Docs created | VERIFIED | `TABLESAAS_LOCAL_DEVELOPMENT_GUIDE.md`, `TABLESAAS_LOCAL_ROUTING_REPORT.md`, this file |
