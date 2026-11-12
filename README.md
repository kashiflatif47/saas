# TableSaaS — Multi-Tenant Restaurant & Hotel Management Platform

One deployment serves any number of independent restaurants, cafés and hotels. Each tenant gets its own subdomain (`<slug>.yourdomain.com`), branded storefront with QR table ordering, staff dashboard, kitchen display, payments, inventory and analytics. All of it is configured from the database through the Super Admin console. Onboarding a new tenant needs no developer.

> **Start with [`TABLESAAS_PRODUCTION_GUIDE.md`](TABLESAAS_PRODUCTION_GUIDE.md)** (install, configure, operate, deploy). Verification evidence is in [`TABLESAAS_FINAL_ACCEPTANCE_CHECKLIST.md`](TABLESAAS_FINAL_ACCEPTANCE_CHECKLIST.md) and deployment status in [`TABLESAAS_DEPLOYMENT_REPORT.md`](TABLESAAS_DEPLOYMENT_REPORT.md).

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + TypeScript, Vite, Tailwind CSS, React Router, PWA (vite-plugin-pwa / Workbox) |
| Backend | Node.js 24 LTS, Express 4 + TypeScript, Zod validation |
| Database | MongoDB 6+ with Mongoose 8 (single shared cluster, strict tenant isolation) |
| Real-time | Socket.IO 4 (tenant-scoped rooms) |
| Tests | `node:test` + Supertest + mongodb-memory-server + socket.io-client |

## Repository layout

```
tablesaas/
├── server/                     Express API + Socket.IO
│   ├── src/
│   │   ├── config/             env validation, roles & permissions, feature flags
│   │   ├── lib/                pure logic: pricing, order state machine, subdomains, crypto, CSV
│   │   ├── models/             Mongoose schemas + tenant-scope guard plugin + indexes
│   │   ├── middleware/         auth (JWT), tenant resolution, RBAC, validation, uploads, errors
│   │   ├── services/           orders, payments (cash + Stripe), inventory, analytics, audit, notify
│   │   ├── routes/             auth, platform (super admin), tenant admin, menu, tables/QR,
│   │   │                       orders/kitchen, public storefront, inventory & business, analytics, webhooks
│   │   ├── sockets/            Socket.IO auth + room model
│   │   ├── jobs/               subscription expiry sweep
│   │   ├── app.ts / server.ts  wiring & bootstrap
│   │   └── seed.ts             plans + super admin + one demo tenant
│   ├── tests/unit/             pure-logic tests (pricing, state machines, crypto, RBAC…)
│   ├── tests/integration/      tenant isolation + full end-to-end workflow tests
│   └── .env.example
├── client/                     React PWA (platform console, tenant dashboard, KDS, waiter, storefront)
│   ├── src/pages/admin/        Super admin: overview, restaurants, plans, audit
│   ├── src/pages/owner/        Dashboard, orders, menu, tables & QR, branding, settings, staff,
│   │                           inventory, payments, analytics, reservations, customers, feedback, coupons
│   ├── src/pages/staff/        Kitchen display, waiter floor view
│   ├── src/pages/store/        Customer storefront: menu, cart/checkout, QR landing, tracking, reservations
│   └── public/icons/           PWA icons
├── deploy/                     nginx, Caddy, PM2, docker-compose examples
└── docs/                       API, deployment, DNS/SSL, backup, security audit, isolation report…
```

## Quick start (local development)

Prerequisites: **Node.js 24 LTS** (22 also works), **MongoDB 6+** (local, Docker, or Atlas).

```bash
# 1. MongoDB (skip if you already have one)
docker compose -f deploy/docker-compose.dev.yml up -d

# 2. API
cd server
cp .env.example .env
# Generate secrets and paste them into .env:
node -e "console.log('JWT_ACCESS_SECRET='+require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('JWT_REFRESH_SECRET='+require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))"
npm install
SEED_PASSWORD='a-demo-password' npm run seed   # DEV ONLY: plans, super admin, demo tenant "spice-garden"
npm run dev           # http://localhost:4000

# 3. Web app (new terminal)
cd client
cp .env.example .env  # VITE_ROOT_DOMAIN=localhost
npm install
npm run dev           # http://localhost:5173
```

Open:

| URL | What |
|---|---|
| `http://localhost:5173/login` | Super admin console (email/password from `SUPERADMIN_*` in `.env`) |
| `http://spice-garden.localhost:5173/` | Demo restaurant storefront |
| `http://spice-garden.localhost:5173/login` | Demo staff login (`owner@spicegarden.example` etc., password = `SEED_PASSWORD`) |

Modern browsers resolve `*.localhost` to 127.0.0.1 automatically, so no hosts-file edits are needed. The Vite dev server proxies `/api`, `/socket.io` and `/uploads` to the API and keeps the original Host header, so subdomain tenant resolution works in development exactly as in production.

To try QR ordering, open **Tables & QR** in the demo dashboard, copy a table link (`/t/<token>`) and open it in another browser or on your phone.

## Tests

```bash
cd server
npm run test:unit         # pure logic: runs anywhere, no database needed
npm run test:integration  # downloads a MongoDB binary once (mongodb-memory-server), then runs
npm test                  # both
npm run build && npm --prefix ../client run build && npm run e2e   # end-to-end journey on the built app (in-memory MongoDB)
npm run typecheck         # tsc on src + tests
cd ../client && npm run build   # tsc + vite production build
```

The integration suites cover tenant isolation (API, database guard, QR tokens, uploads, Socket.IO, analytics, audit) and the full restaurant workflow: onboarding → staff → RBAC → menu → QR → customer order → server-side pricing → accept → kitchen routing → item states → partial cash payments → refunds → analytics reconciliation → CSV/PDF export → coupons → stock restore on cancel → purchase orders → reservations double-booking → Stripe webhook signature verification → subscription expiry and suspension.

## Production

Production uses `npm run bootstrap` (plans + first super admin), never `npm run seed`. A single Docker image (`Dockerfile`, `railway.json`) serves the API and the SPA. Full steps are in [`TABLESAAS_PRODUCTION_GUIDE.md`](TABLESAAS_PRODUCTION_GUIDE.md) §F.


See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (server, process manager, reverse proxy), [`docs/DNS_SSL.md`](docs/DNS_SSL.md) (wildcard DNS + wildcard certificate) and [`docs/BACKUP_RECOVERY.md`](docs/BACKUP_RECOVERY.md).

## Documentation index

| Doc | Purpose |
|---|---|
| [VERIFICATION_STATUS.md](docs/VERIFICATION_STATUS.md) | What was executed vs. what you must run |
| [API.md](docs/API.md) | Every endpoint, auth model, socket events |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Tenancy model, data model, money, order/payment state machines |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production install, env, proxy, scaling |
| [DNS_SSL.md](docs/DNS_SSL.md) | Wildcard DNS and wildcard TLS certificates, custom domains |
| [BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md) | Backups, point-in-time restore, single-tenant restore |
| [SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) | Threat model, controls, residual risks |
| [TENANT_ISOLATION_REPORT.md](docs/TENANT_ISOLATION_REPORT.md) | Isolation layers and the tests that prove them |
| [EXTERNAL_REQUIREMENTS.md](docs/EXTERNAL_REQUIREMENTS.md) | Credentials and infrastructure you must supply |
