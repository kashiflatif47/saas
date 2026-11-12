# Production deployment guide

Target: one Linux VM (Ubuntu 22.04/24.04) running the API under PM2, Caddy or Nginx serving the SPA and proxying the API, and MongoDB Atlas (recommended) or a self-hosted replica set. Scale out later behind a load balancer.

## 1. Prerequisites

- A domain, e.g. `example.com`. Tenants live at `*.example.com`. The platform console lives at `example.com` (or `admin.example.com`, which is reserved).
- DNS records and a wildcard certificate. Follow **DNS_SSL.md** first.
- Node.js 20 LTS, PM2, Caddy **or** Nginx + certbot.
- MongoDB 6+ **replica set** (Atlas M10+ recommended for automated backups and point-in-time restore).

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm i -g pm2
```

## 2. Get the code and build

```bash
sudo mkdir -p /srv/tablesaas && sudo chown $USER /srv/tablesaas
cd /srv/tablesaas && unzip ~/tablesaas.zip -d . && cd tablesaas
cd server && npm ci || npm install    # first install creates package-lock.json, commit it
npm run typecheck && npm test && npm run build
cd ../client && npm ci || npm install
echo "VITE_ROOT_DOMAIN=example.com" > .env.production
echo "VITE_API_URL=" >> .env.production          # same-origin via proxy (recommended)
npm run build                                       # outputs client/dist
```

## 3. Configure the API (`server/.env`)

```ini
NODE_ENV=production
PORT=4000
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster0.xxxx.mongodb.net/tablesaas?retryWrites=true&w=majority
ROOT_DOMAIN=example.com
APP_PROTOCOL=https
CLIENT_ORIGIN=https://example.com
PUBLIC_API_URL=https://example.com
ALLOW_TENANT_HEADER=false
JWT_ACCESS_SECRET=<96 hex chars>
JWT_REFRESH_SECRET=<different 96 hex chars>
ENCRYPTION_KEY=<64 hex chars — BACK THIS UP; losing it makes stored payment keys unrecoverable>
UPLOAD_DIR=/srv/tablesaas/uploads
SUPERADMIN_EMAIL=you@example.com
SUPERADMIN_PASSWORD=<long random — change after first login>
```

`chmod 600 server/.env`. The server refuses to start with missing or short secrets.

## 4. Run the API with PM2

```bash
cd /srv/tablesaas/tablesaas
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup     # follow the printed command
```

`deploy/ecosystem.config.cjs` runs **one** instance by default. Before running several instances, see §7.

Seed plans once (optional demo tenant): `cd server && npm run seed`. Delete the demo tenant from the database before going live if you do not want it.

## 5. Reverse proxy

**Caddy** (simplest; can issue the wildcard cert itself with a DNS plugin): see `deploy/Caddyfile`.
**Nginx**: see `deploy/nginx.conf`, using certbot's wildcard cert from DNS_SSL.md.

Both:
- serve `client/dist` for every host (`example.com` and `*.example.com`) with SPA fallback to `index.html`
- proxy `/api/`, `/socket.io/` (WebSocket upgrade) and `/uploads/` to `127.0.0.1:4000`, **preserving `Host`**, because tenant resolution depends on it
- set `X-Forwarded-For` / `X-Forwarded-Proto` (the app sets `trust proxy = 1`)

## 6. Smoke test

```bash
curl -s https://example.com/api/health          # {"status":"ok",...}
```

1. Sign in at `https://example.com/login` as super admin and change your password.
2. Plans → confirm pricing. Restaurants → **New restaurant** → note the URL.
3. Open `https://<slug>.example.com/login` as the owner. Add a category, a dish, a table. Print the QR.
4. Scan the QR with a phone, place an order, accept it on the dashboard, mark it ready on the KDS, collect cash, complete it. Check that Analytics shows the sale.

## 7. Scaling out

| Concern | Single instance | Multiple instances |
|---|---|---|
| Socket.IO fan-out | in-process | add `@socket.io/redis-adapter` in `src/sockets/index.ts`, enable sticky sessions at the LB |
| Tenant resolver cache (30 s) | in-process | fine as is (short TTL), or move to Redis for instant suspension propagation |
| Rate limits | in-memory | use `rate-limit-redis` store |
| Uploads | local disk | move to S3/R2/GCS (replace `storeTenantImage`/`deleteTenantImage`), or a shared volume |
| Subscription sweep | runs hourly | safe on every instance (conditional updates) |

## 8. Updating

```bash
cd /srv/tablesaas/tablesaas && git pull   # or unzip a new release
cd server && npm ci && npm test && npm run build && pm2 reload tablesaas-api
cd ../client && npm ci && npm run build   # Caddy/Nginx serve the new dist immediately
```

Indexes are synced on boot (`syncIndexes`). For very large collections, build new indexes manually during a maintenance window first.

## 9. Monitoring

- `pm2 logs tablesaas-api`. Errors are logged with method and URL. Tenant-scope violations are logged with a `[SECURITY]` prefix: alert on these.
- Uptime check on `/api/health`.
- MongoDB Atlas alerts (connections, replication lag, disk).
