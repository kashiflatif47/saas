> **Superseded (2026-11-09).** Everything below describes the original sandbox build, where nothing could be run. Builds, typechecks, 67 server tests, a 20-step end-to-end journey and real-browser checks have since been executed and pass. See [`../TABLESAAS_FINAL_ACCEPTANCE_CHECKLIST.md`](../TABLESAAS_FINAL_ACCEPTANCE_CHECKLIST.md) and [`../TABLESAAS_DEPLOYMENT_REPORT.md`](../TABLESAAS_DEPLOYMENT_REPORT.md).

# Verification status — read before deploying

This project was written in a sandboxed build environment **with no network access to the npm registry and no MongoDB server**. Nothing could be installed. This document records exactly what was verified there and what you must run yourself. Nothing here claims a check passed unless it actually ran.

## What was executed and passed in the build environment

| Check | How | Result |
|---|---|---|
| Server unit tests (21 tests) | `tsx --test tests/unit/*.test.ts` (Node 22) | **21 / 21 passed**: pricing and tax/discount maths in minor units, coupon rules, tax-inclusive extraction, no float drift, order and item state machines, derived parent status, independent payment status, subdomain parsing and reserved/foreign host rejection, AES-256-GCM secret encryption plus tamper detection, Stripe webhook signature verification (valid, stale, modified body, wrong secret), image magic-byte sniffing, CSV escaping and formula-injection guard, role permissions and overrides |
| Server type-level check | `tsc --strict` against stub declarations for the uninstalled packages | No errors in project code. Stubs typed third-party APIs as `any`, so this catches typos, wrong imports, missing exports and logic-level type errors in **our** code, but **not** misuse of Express/Mongoose/Socket.IO APIs |
| Client type-level check | Same approach for React/Router/lucide/socket.io-client | No errors in project code, with the same limitation |
| API contract cross-check | Script comparing every `api.*` / `useApi` path in the client with server route definitions | All static client calls match a server route. Dynamic ones (ResourcePage/Audit) were checked by hand |
| PWA icons | Rendered with `sharp` from SVG and visually inspected | OK |

## What was NOT executed (you must run these)

| Check | Command | Why it could not run |
|---|---|---|
| Dependency install + lockfiles | `npm install` in `server/` and `client/` | No registry access. **`package-lock.json` files are therefore not included**; they are generated on first install. Commit them afterwards |
| Server build / real typecheck | `cd server && npm run typecheck && npm run build` | Requires `@types/*`, express, mongoose… |
| Integration tests (tenant isolation + end-to-end workflow, ~30 tests) | `cd server && npm run test:integration` | Requires mongodb-memory-server (downloads a MongoDB binary), supertest, socket.io-client |
| Client production build | `cd client && npm run build` | Requires Vite, Tailwind, React |
| Browser checks: responsive layouts, PWA install, RTL rendering | Manual, or add Playwright | No browser plus running app |
| Real Stripe payment | Configure test keys in Settings → Payments | Needs your Stripe account (see EXTERNAL_REQUIREMENTS.md) |
| Wildcard DNS / TLS | See DNS_SSL.md | Needs your domain and server |

## Recommended first-run sequence

```bash
cd server && npm install && npm run typecheck && npm test && npm run build
cd ../client && npm install && npm run build
```

Expect to fix a small number of compile-level issues on the first real `tsc` run. Typical ones are Mongoose generic typing on `.lean()` results and minor `@types/express` signature differences. The stub check above could not catch those. The logic, routes and data flow are complete. The integration tests are written to fail loudly on any isolation or money-handling regression. Treat a green `npm test` as the acceptance gate before production.

## Feature completeness

Every module in the brief has backend models, validated endpoints, permission checks, and a connected UI. There are no mock data paths in the app. The only seeded data comes from `npm run seed`, which writes real records through the same models. External integrations that need your credentials are implemented against the real provider API but stay **disabled until you configure and verify them**:

- **Stripe online payments**: real REST integration plus signed webhooks. Orders are never marked paid without a verified webhook.
- **Object storage**: uploads go to local disk (tenant-namespaced). Swapping in S3/R2 is a single function (`storeTenantImage`).
- **Email/SMS**: not included. Notifications are in-app plus real-time. Add a provider if you need them (see EXTERNAL_REQUIREMENTS.md).
