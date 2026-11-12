# TableSaaS — Final Acceptance Checklist

Status values: **VERIFIED** (executed with evidence), **TESTED** (automated test passes), **IMPLEMENTED** (code complete, not independently exercised), **BLOCKED BY EXTERNAL ACCESS**, **NOT APPLICABLE**.
Evidence keys: `UT` unit tests · `IT` integration tests · `E2E` `npm run e2e` journey (built server + built SPA over real HTTP) · `BR` headless-Chrome check at 390/820/1366 px. All runs on 2026-11-09, Node 24.19.0.

## Acceptance criteria

| Requirement | Status | Evidence |
|---|---|---|
| Frontend builds successfully | VERIFIED | `client: npm run build` passes |
| Backend builds successfully | VERIFIED | `server: npm run build` passes (failed with 4 TS errors before this pass) |
| TypeScript checks pass | VERIFIED | `npm run typecheck` (server src + tests, client) |
| Relevant tests pass | VERIFIED | 67/67 `npm test`; 20/20 E2E |
| Authentication works | VERIFIED | E2E steps 3, 4, 7, 15, 17, 19; IT |
| Super Admin bootstrap works | VERIFIED | E2E step 3 (created from env at boot); IT "bootstrap never overwrites…", "default plans…" |
| Super Admin permissions are secure | VERIFIED | IT tenant staff → platform 403; E2E step 16 |
| Restaurant creation works | VERIFIED | E2E step 5 (incl. duplicate subdomain → 409) |
| Restaurant administrator login works | VERIFIED | E2E step 7 |
| Tenant isolation works | VERIFIED | IT isolation suite (15) + E2E step 16 across two independent tenants |
| Restaurant profile updates persist | VERIFIED | E2E step 8 (reload) and step 15 (fresh session) |
| Menu category management works | VERIFIED | E2E step 10 (create, reorder); BR menu pages |
| Menu item management works | VERIFIED | E2E step 10 (variants, add-ons, availability, validation) |
| Image upload works | VERIFIED (local disk) | E2E steps 8–10: upload, served back, magic-byte and size rejection. Production needs a persistent volume (documented) |
| QR generation works | VERIFIED | E2E step 11: PNG/SVG/PDF; PNG **decoded** with jsQR to the exact tenant URL |
| Public QR menu works | VERIFIED | E2E step 12 (no login, branding, availability, no recipe leakage); BR QR landing |
| QR scanned by a real phone | BLOCKED BY EXTERNAL ACCESS | needs a deployed domain; decode-and-open equivalent VERIFIED |
| Mobile experience works | VERIFIED | BR: 27 states, 0 overflow, 0 console errors (after fixing 5 defects) |
| APIs work correctly | VERIFIED | every client API path maps to a server route (audited); IT + E2E |
| No fake production success responses | VERIFIED | online pay without a provider → 400 (E2E 14); webhook signature required (IT) |
| No critical broken buttons or routes | VERIFIED | BR found and fixed crashing Orders/Settings pages; all navigated pages render |
| Production environment documented | VERIFIED | Guide §B; `server/.env.example`; production config guard (UT) |
| Deployment instructions complete | IMPLEMENTED | Guide §F (Docker/Railway, VPS); Railway CLI commands checked against CLI help; image not built locally (no Docker) |
| TABLESAAS_PRODUCTION_GUIDE.md created | VERIFIED | project root |
| Remaining external dependencies listed | VERIFIED | Deployment report → "Remaining external actions" |
| Application deployed and live-verified | BLOCKED BY EXTERNAL ACCESS | owner chose not to deploy now; no domain chosen |

## Defects found and fixed in this pass

| # | Severity | Defect | Fix | Evidence |
|---|---|---|---|---|
| 1 | Critical | Server did not compile (4 TS errors), so no production build | return-type fixes | build passes |
| 2 | Critical | Orders and Settings pages crashed to a blank screen (`useEffect` returned `null`) | block-bodied effects (7 sites) | BR |
| 3 | High | Privilege escalation: any `staff:manage` holder could grant any permission, including to themselves | grant only held permissions; no self role/permission changes; same-tenant assignment checks | IT |
| 4 | High | Password reset, deactivation and suspension left refresh tokens valid, so stolen sessions survived | all revocations clear refresh tokens; refresh checks tenant status and host | IT, E2E 18–19 |
| 5 | High | Boot ran `syncIndexes()`, which **drops** undeclared indexes on the production DB | non-destructive `createIndexes()` | code review |
| 6 | High | Production could boot with placeholder secrets, header tenancy or plain HTTP | production config guard | UT |
| 7 | High | Seed created a superadmin with a hardcoded weak password; no production bootstrap | production `bootstrap`, `superadmin` CLI, seed refuses production | IT |
| 8 | High | Custom domains rendered the **platform console**, and their CORS was never allowed | storefront-only routing; DB-backed CORS | IT |
| 9 | High | CSP blocked fonts once the PWA service worker installed (nginx/Caddy configs too) | `connect-src` updated in all three | BR |
| 10 | Medium | Bulk "add tables" needed a dummy label and failed or partially inserted after deletions | free-label allocation; 409 on duplicates | IT, E2E 11 |
| 11 | Medium | Promo-end and reservation times shifted by the UTC offset on every save | local datetime helper | code review |
| 12 | Medium | Invalid order transition returned 403 instead of 400 | validate target first | IT |
| 13 | Medium | Subscription access flapped between period end and the hourly sweep | shared `GRACE_DAYS` rule | UT |
| 14 | Medium | MRR counted trials, expired and suspended tenants | paying subscriptions only | IT |
| 15 | Medium | Super admin could not edit restaurant details or manage tenant accounts | API + UI (details card, accounts card) | IT, E2E 6, BR |
| 16 | Medium | Change-password was unreachable for super admins and most roles | sidebar modal for every user | BR |
| 17 | Medium | Horizontal overflow on phones (dashboard, restaurant page, reserve) | `min-w-0` fixes | BR |
| 18 | Medium | Socket.IO isolation test hung the suite; 3 orderFlow tests failed (test-code defects) | listener race and teardown fixed; guarded lookups; valid names. Assertions unchanged | IT |
| 19 | Low | No request logging; no SPA serving for single-service hosting; no Dockerfile | access log (no query strings), `CLIENT_DIST_DIR`, Dockerfile, `railway.json` | E2E |
| 20 | Low | Hover-only controls invisible on touch; Reserve link hidden on phones; no empty-menu state; no "no plans" hint | UI fixes | BR |
| 21 | Low | Tracking tokens compared without a timing-safe check on sockets | `timingSafeEqual` | code review |

## Known lower-severity items (not blocking production)

| Item | Impact | Why not blocking |
|---|---|---|
| Uploads use local disk, no S3/R2 integration | single instance only; must use a persistent volume | correct for one instance; documented |
| Platform subscription billing is recorded manually (no billing provider) | super admin renews plans by hand | intended operating model; no fake payments |
| Stripe online payments not verified against a real Stripe account | card payments unproven live | cash and card-terminal flows verified; Stripe needs per-restaurant accounts |
| Category images supported by the API but not shown or uploadable in the UI | none for customers | optional feature |
| QR URLs omit the dev port (`:5173`) | development-only inconvenience | production uses standard ports |
| Theme fonts other than Fraunces/Inter fall back to system fonts | cosmetic | branding still applies colours and layout |
