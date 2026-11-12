# TableSaaS — Production Guide

Install, configure, run, operate and deploy TableSaaS. Every workflow described here was executed and verified during the 2026-11-09 engineering pass (see `TABLESAAS_FINAL_ACCEPTANCE_CHECKLIST.md` for the evidence). No real credentials appear in this document.

---

## A. Installation

### Required software

| Software | Version | Notes |
|---|---|---|
| Node.js | **24 LTS** (verified); 22 LTS also works | Node 20 reached end-of-life in April 2026. `.nvmrc` pins 24. |
| npm | 10+ | Ships with Node |
| MongoDB | 6+ **replica set** | MongoDB Atlas (recommended) or self-hosted replica set |
| Docker | optional | For the single-image deployment (`Dockerfile`) |

### Install dependencies

```bash
npm install                 # root: installs `concurrently` for `npm run dev`
npm run install:all         # server/ and client/
```

### Folder structure

```
tablesaas/
├── Dockerfile, .dockerignore, railway.json   single production image (API + SPA) and Railway config
├── package.json                              root scripts: dev, build, test, typecheck
├── server/                                   Express + TypeScript API, Socket.IO, jobs
│   ├── src/config        env validation + production guard, roles & permissions
│   ├── src/models        Mongoose schemas + tenant-isolation guard plugin
│   ├── src/middleware    JWT auth, tenant resolution, validation, uploads, errors
│   ├── src/routes        auth, platform (super admin), tenant admin, menu, tables/QR, orders, public, …
│   ├── src/services      orders, payments, inventory, analytics, audit, bootstrap
│   ├── src/scripts       superadmin CLI
│   ├── src/bootstrap.ts  production bootstrap (plans + first super admin)
│   ├── src/seed.ts       DEVELOPMENT demo data (refuses to run in production)
│   └── tests/            unit, integration (in-memory MongoDB) and e2e journey
├── client/                                   React 18 + Vite + Tailwind PWA
│   └── src/pages         admin/ (platform), owner/ (restaurant), staff/ (KDS, waiter), store/ (customers)
├── deploy/                                   nginx.conf, Caddyfile, PM2 file, backup script
└── docs/                                     API, architecture, DNS/SSL, backups, security, isolation
```

---

## B. Environment configuration

### Root `.env`
Not read by the application. All runtime configuration lives in `server/.env` and, at build time, `client/.env*`.

### Server variables (`server/.env`, template: `server/.env.example`)

| Variable | Required | Production value / rule |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `PORT` | no | default `4000` (Railway sets it automatically) |
| `MONGODB_URI` | yes | Atlas SRV URI **including a database name**, e.g. `…mongodb.net/tablesaas?retryWrites=true&w=majority` |
| `ROOT_DOMAIN` | yes | your domain, e.g. `example.com` (no scheme, no port) |
| `APP_PROTOCOL` | yes | `https` (enforced in production) |
| `CLIENT_ORIGIN` | yes | `https://example.com` (comma-separated extra origins allowed) |
| `PUBLIC_API_URL` | yes | `https://example.com` (shown to restaurants as their Stripe webhook base) |
| `ALLOW_TENANT_HEADER` | yes | `false` (enforced in production) |
| `JWT_ACCESS_SECRET` | yes | ≥ 64 random chars |
| `JWT_REFRESH_SECRET` | yes | ≥ 64 random chars, different from the access secret |
| `ENCRYPTION_KEY` | yes | exactly 64 hex chars. **Back it up. Never change it on a live system** (it decrypts stored Stripe keys) |
| `ACCESS_TOKEN_TTL` | no | `15m` |
| `REFRESH_TOKEN_TTL_DAYS` | no | `14` |
| `UPLOAD_DIR` | yes | a **persistent** path, e.g. `/data/uploads` |
| `MAX_UPLOAD_MB` | no | `5` |
| `CLIENT_DIST_DIR` | single-service only | `/app/client/dist` in Docker; empty when Nginx/Caddy serves the SPA |
| `LOG_REQUESTS` | no | `true` |
| `SUPERADMIN_EMAIL` | first boot | e.g. `mariam@gmail.com` (planned production value) |
| `SUPERADMIN_PASSWORD` | first boot | ≥ 10 chars, long and random |

The server **refuses to start in production** if any of these hold: placeholder secrets from `.env.example`, secrets shorter than 64 chars, identical JWT secrets, `ALLOW_TENANT_HEADER=true`, `APP_PROTOCOL=http`, a `localhost` root domain, or the placeholder super admin password.

### Generating secrets

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_ACCESS_SECRET (run twice: + JWT_REFRESH_SECRET)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY
```

### Client variables (build time, `client/.env.production`, or Docker build args)

| Variable | Value |
|---|---|
| `VITE_ROOT_DOMAIN` | same as `ROOT_DOMAIN`, e.g. `example.com` (**required**, compiled into the bundle) |
| `VITE_API_URL` | leave **empty** (same-origin API; required for the CSP and cookies to work as designed) |

No secrets are ever placed in client variables; everything in `client/` ends up in the public bundle.

### MongoDB Atlas

1. Create a cluster (M10+ recommended for continuous backup and point-in-time restore).
2. Create a database user with `readWrite` on the TableSaaS database only.
3. **Network access:** allow your host's egress IPs (Railway: enable static outbound IPs, or `0.0.0.0/0` with a strong password).
4. Use a URI that **ends in the database name**: `mongodb+srv://USER:PASS@cluster.xxxx.mongodb.net/tablesaas?retryWrites=true&w=majority`.
5. Use **separate databases for development and production** (e.g. `tablesaas_dev` and `tablesaas`).

> **Action needed for the current setup:** the URI in `server/.env` was verified reachable (Atlas, replica set). It **does not name a database**, so data goes to MongoDB's default `test` database (20 collections exist there). It is also the URI your development server uses. Before going live, either point production at a new database name, which starts empty, or deliberately keep using the existing data. Do not run development against the production database.

Indexes are created automatically at boot. Boot uses `createIndexes()`, which only adds missing indexes and never drops any.

### CORS

Allowed automatically: `ROOT_DOMAIN`, every `*.ROOT_DOMAIN`, every origin listed in `CLIENT_ORIGIN`, and the custom domain of any **active** tenant (looked up in the database, cached for 60 s).

### External service credentials

| Service | Where configured | Required? |
|---|---|---|
| MongoDB | `MONGODB_URI` | yes |
| Stripe (per restaurant) | each restaurant enters its own keys in **Settings → Payments** (encrypted with `ENCRYPTION_KEY`) | only for online card payments; plan must include `online_payments` |
| DNS / TLS | your registrar + host (wildcard `*.domain`) | yes for restaurant subdomains |

---

## C. Development

```bash
# one-time
cp server/.env.example server/.env         # then generate secrets (section B)
cp client/.env.example client/.env         # VITE_ROOT_DOMAIN=localhost
SEED_PASSWORD='a-demo-password' npm run seed   # optional demo restaurant "spice-garden"

# start API (:4000) and web app (:5173) together
npm run dev
```

| Task | Command |
|---|---|
| Start both | `npm run dev` (root) |
| Stop both | `Ctrl+C` once (`concurrently --kill-others` stops both) |
| API only | `npm run dev:server` (or `cd server && npm run dev`) |
| Web app only | `npm run dev:client` (or `cd client && npm run dev`) |
| Typecheck everything | `npm run typecheck` |
| All server tests | `npm test` (unit + integration; first run downloads a MongoDB test binary) |
| End-to-end journey | `npm run build && cd server && npm run e2e` |
| Production builds | `npm run build` |

Open `http://localhost:5173/login` for the platform console and `http://<slug>.localhost:5173/` for a restaurant. Browsers resolve `*.localhost` automatically.

**Logs.** The API prints `[BOOT]`, `[DB]`, `[HTTP] METHOD path status ms host=…`, `[ERROR]` and `[SECURITY]` lines to stdout and stderr. Query strings, request bodies and headers are never logged.

**Restaurant subdomains locally.** Restaurant links and QR codes include the dev port automatically (`http://<slug>.localhost:5173`). Chrome and Edge resolve `*.localhost` themselves (verified); Windows command-line tools do not. See `TABLESAAS_LOCAL_DEVELOPMENT_GUIDE.md`. Phones cannot reach `*.localhost` on your laptop, so scanning with a real phone needs a deployed domain.

### Common development errors

| Symptom | Cause / fix |
|---|---|
| `Invalid environment configuration` at start | a required variable is missing or malformed; the log lists the field |
| `Refusing to start in production with insecure configuration` | see the listed problems; production guard (section B) |
| `Restaurant not found` on `<slug>.localhost` | wrong slug, or `VITE_ROOT_DOMAIN`/`ROOT_DOMAIN` mismatch |
| `MongoServerSelectionError` | Atlas IP allow-list, wrong password, or no network |
| Integration tests slow on first run | mongodb-memory-server downloads a MongoDB binary once (cached afterwards) |

---

## D. Super Admin setup

**How bootstrap works.** On every start, the API:
1. creates the three default plans (Starter, Growth, Pro) **only if there are no plans**;
2. creates a super admin from `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` **only if no super admin exists**.

It never modifies existing plans or accounts. You can run the same steps before first start with `cd server && npm run bootstrap`, or `npm run bootstrap:prod` from a built image.

**First Super Admin.** Set `SUPERADMIN_EMAIL=mariam@gmail.com` and a long random `SUPERADMIN_PASSWORD`, then start the server. The log prints `[BOOT] created super admin …`.

**Sign in.** Open `https://<ROOT_DOMAIN>/login`. Super-admin sign-in is refused on restaurant subdomains. Change the password via the key icon at the bottom of the sidebar.

**Additional super admins or password reset** (password read from the environment, never from the command line):

```bash
cd server
SUPERADMIN_NEW_PASSWORD='…' npm run superadmin -- --email second@example.com --name "Second Admin"
SUPERADMIN_NEW_PASSWORD='…' npm run superadmin -- --email mariam@gmail.com --reset-password   # also signs out all sessions
```

**Managing restaurants** (Restaurants → a restaurant):
- edit the name, business type, contact details, currency, time zone and default language;
- **Suspend** or **Reactivate**: suspension takes the storefront offline immediately and signs out all staff;
- **Accounts**: list every staff account; reset passwords, unlock locked accounts, deactivate or reactivate (owners are handled by suspension);
- **Feature entitlements**: per-restaurant overrides on top of the plan;
- **Custom domain**: storefront only; staff always sign in on `<slug>.<ROOT_DOMAIN>`.

**Managing subscriptions.**
- **Plans** page: create or edit price, trial length, limits and features.
- On a restaurant: change plan, **Renew** (n months), **Extend trial**, **Mark past due / expired**.
- An hourly job expires lapsed trials and moves lapsed paid periods to `past_due`, then to `expired` after a 7-day grace period. Expired restaurants become read-only and their storefront goes offline.
- Subscription billing is **recorded manually** by the super admin. There is no automated platform billing provider.

---

## E. Restaurant creation — complete workflow

1. **Sign in as Super Admin** at `https://<ROOT_DOMAIN>/login`.
2. **Create a restaurant:** Restaurants → **New restaurant**. Enter the name, the subdomain (permanent, because it is printed on QR codes), type, plan, currency and contact details.
3. **Create the administrator in the same form:** owner name, email and a temporary password (at least 10 characters). Share it securely. The restaurant URL is shown on success.
4. **Configure details:** on the restaurant page, edit contact details, time zone and language.
5. **Sign in as the restaurant administrator** at `https://<slug>.<ROOT_DOMAIN>/login`, then change the temporary password via the key icon.
6. **Branding:** Dashboard → **Branding**: logo, favicon, hero and cover images (PNG/JPEG/WEBP, ≤ 5 MB), colours, fonts, hero text, about text and social links → **Publish changes**.
7. **Profile and opening hours:** **Settings → General / Ordering & tax**: address, phone, opening hours, tax, service charge, order types.
8. **Menu categories:** **Menu → + Category** (optional subcategory, kitchen station, time schedule). Reorder with the arrows.
9. **Menu items:** **Menu → + Dish**: name (EN/UR/AR), description, price, promo price, options and add-ons, tags, featured flag.
10. **Images:** after the first save, upload up to 8 photos per dish in the same dialog.
11. **Availability:** use the **Available** toggle on each dish card (unavailable dishes show "Sold out" and cannot be ordered), or turn on stock tracking. Archive removes a dish but keeps its history.
12. **QR codes:** **Tables & QR → Add tables** (one, or several at once with a prefix).
13. **Download and test:** download each table's PNG or SVG, or **Print all (PDF)**. **Regenerate** invalidates a printed code immediately.
14. **Open the public menu as a customer:** scan the QR with a phone. The restaurant's branded menu opens with the table pre-selected, no login required. Orders appear live on the restaurant's Orders, Kitchen and Waiter screens.

Staff accounts for waiters, kitchen and cashiers: **Staff & roles → Add staff**. Only the owner can grant permissions they hold. Other managers can only grant permissions they themselves have.

---

## F. Deployment

TableSaaS needs **one domain with wildcard DNS**. The platform console is served at `example.com` and restaurants at `*.example.com`. A host's own generated domain (e.g. `*.up.railway.app`) cannot provide the wildcard.

### Option 1 — Single Docker image (Railway, Render, Fly, any Docker host)

The `Dockerfile` builds the SPA and the API and serves both from one Node process, with a health check at `/api/health`.

```bash
docker build --build-arg VITE_ROOT_DOMAIN=example.com -t tablesaas .
docker run -d --name tablesaas -p 4000:4000 --env-file server/.env.production \
  -v tablesaas-uploads:/data/uploads --restart unless-stopped tablesaas
```

**Railway** (CLI is installed and signed in on this machine):

```bash
railway init --name tablesaas            # new project
railway add --service tablesaas
railway link                             # select the project/service
# Variables: all of section B, plus VITE_ROOT_DOMAIN (used as a build arg)
railway variables --set NODE_ENV=production --set ROOT_DOMAIN=example.com --set VITE_ROOT_DOMAIN=example.com ...
railway volume add --mount-path /data/uploads
railway up                               # builds the Dockerfile (railway.json)
railway domain                           # then add custom domains in the dashboard:
#   example.com and *.example.com → follow Railway's DNS instructions (CNAME/TXT records at your registrar)
```

HTTPS certificates for the apex and wildcard domains are issued by Railway once its DNS records verify.

### Option 2 — VPS with Nginx/Caddy + PM2

Follow `docs/DEPLOYMENT.md` and `docs/DNS_SSL.md`, using `deploy/nginx.conf` or `deploy/Caddyfile`. Build with `npm run build`, run `pm2 start deploy/ecosystem.config.cjs`, and leave `CLIENT_DIST_DIR` empty (the proxy serves `client/dist`). The proxy **must preserve the `Host` header**; tenant resolution depends on it.

### Storage

Uploaded images are written to `UPLOAD_DIR`, namespaced per tenant. That directory **must be persistent** (Docker or Railway volume, VPS disk) and included in backups. No object storage (S3/R2) integration exists. Running more than one API instance requires shared storage. See `docs/DEPLOYMENT.md` §7.

### Production startup and post-deployment verification

1. `GET https://example.com/api/health` → `{"status":"ok","db":"connected"}`.
2. Sign in at `https://example.com/login` as the super admin.
3. Run the end-to-end journey against the live site. It creates two clearly labelled `e2e-…` test restaurants and **suspends them at the end**:
   ```bash
   cd server
   E2E_BASE_URL=https://example.com E2E_ROOT_DOMAIN=example.com \
   E2E_SA_EMAIL=mariam@gmail.com E2E_SA_PASSWORD='…' npm run e2e
   ```
4. Scan a printed QR code with a real phone over mobile data.

### Backups

See `docs/BACKUP_RECOVERY.md`. Use Atlas continuous backup, plus `deploy/backup.sh` for `mongodump` and the uploads directory. Store `ENCRYPTION_KEY` separately (password manager or secrets vault).

---

## G. Troubleshooting (real issues found and fixed during this pass)

| Symptom | Cause | Resolution |
|---|---|---|
| `npm run build` (server) failed with TS7030/TS7006 | handlers with inconsistent returns | fixed; `npm run build` passes |
| Orders and Settings pages went blank | `useEffect` returned `null`, which React called as a cleanup function | fixed in Orders, Settings and Menu |
| Fonts stopped loading after the PWA installed | the service worker fetches Google Fonts, which the CSP `connect-src` blocked | CSP updated in `app.ts`, `nginx.conf`, `Caddyfile` |
| Integration tests hung forever | socket test teardown race | fixed; the suite runs in ~60 s |
| Bulk "add tables" failed or created partial batches after deletions | labels numbered from the table count | free labels are now computed; no dummy label needed |
| Promo end and reservation times shifted by several hours on each save | UTC/local mix-up in `datetime-local` inputs | local-time formatting helper |
| Page wider than a phone screen (dashboard, restaurant page, reserve) | grid items with `min-width:auto` | `min-w-0` on cards and inputs |
| Password reset did not end an attacker's session | refresh tokens were kept | every revocation now clears refresh tokens |
| Login returns 401 for a correct password | account locked after 8 failures (15 min) | wait, or Super Admin → Accounts → Unlock |
| Storefront shows "Temporarily unavailable" | restaurant suspended or subscription expired | Super Admin → Reactivate / Renew |
| Changes to `VITE_ROOT_DOMAIN` have no effect | it is compiled at build time | rebuild the client or image |
