# TableSaaS — Local Development Guide (multi-restaurant subdomains on your laptop)

Run the whole platform locally, with every restaurant on its own subdomain. You need no domain, no hosting and no hosts-file edits.

| What | URL |
|---|---|
| Platform / Super Admin | `http://localhost:5173` |
| A restaurant (customer menu) | `http://<slug>.localhost:5173`, e.g. `http://the-broast.localhost:5173` |
| A restaurant's staff sign-in | `http://<slug>.localhost:5173/login` |
| A table's QR menu | `http://<slug>.localhost:5173/t/<token>` |
| API (used through Vite; no need to open it) | `http://localhost:4000` |

Every restaurant created in the Super Admin console works at its own subdomain immediately. Nothing is hard-coded and nothing needs configuring per restaurant.

---

## 1. One-time setup

```bash
npm install            # root (concurrently)
npm run install:all    # server + client
```

`server/.env` must contain at least the following. Your existing file already does; keep your real secrets and database URI:

```ini
NODE_ENV=development
PORT=4000
ROOT_DOMAIN=localhost
APP_PROTOCOL=http
CLIENT_ORIGIN=http://localhost:5173
# APP_PUBLIC_PORT=        # leave empty: the dev port is detected automatically
```

`client/.env` is optional. Without it the defaults are right: `VITE_ROOT_DOMAIN=localhost` and an **empty** `VITE_API_URL`. If you create one, copy `client/.env.example` and **keep `VITE_API_URL` empty** (see §6).

## 2. Start and stop

```bash
npm run dev            # from the project root: API on :4000 + web app on :5173
```

Stop both with **Ctrl+C** once.

> **Restart required after this update.** If `npm run dev` was already running, stop it and start it again. Vite only reads its new configuration (secure host rules, loopback binding) at startup.

| Need | Command |
|---|---|
| API only | `npm run dev:server` |
| Web app only | `npm run dev:client` |
| Reach the dev site from another device on your Wi-Fi | `cd client && npm run dev:lan` (opt-in; other devices can't use `*.localhost`, see §7) |

## 3. Create restaurants and open them

1. Open `http://localhost:5173`, which redirects to `/login`. Sign in as the Super Admin (`SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` from `server/.env`, created on first start).
2. **Restaurants → New restaurant.** The **Subdomain** you enter becomes the address, e.g. `brost` → `http://brost.localhost:5173`. The success message and the restaurant page show the exact clickable URL.
3. Click the URL on the restaurant page to open the customer site.
4. Restaurant staff sign in at `http://<slug>.localhost:5173/login` with the owner email and password you set when creating the restaurant.
5. Create as many restaurants as you like. Each subdomain loads only its own data, and each keeps its own sign-in session.

> Your existing restaurant's subdomain is **`the-broast`**, so it lives at **`http://the-broast.localhost:5173`**. `http://brost.localhost:5173` shows "Restaurant not found" until you create a restaurant with the subdomain `brost`.

## 4. QR codes locally

**Tables & QR** on a restaurant dashboard generates codes that encode `http://<slug>.localhost:5173/t/<token>`, using whichever port you're on. Use **Link** (copy), **Download**, or open the URL in your browser. It lands on that restaurant's menu with the table pre-selected.

A **phone cannot open `*.localhost` on your laptop**: on the phone, `localhost` means the phone itself. Test QR codes in your laptop browser, or by decoding the downloaded PNG. Real phone scanning needs a deployed domain.

## 5. Browser support

| Browser | `*.localhost` | Verified here |
|---|---|---|
| Google Chrome | resolves to loopback internally | **yes** |
| Microsoft Edge | resolves to loopback internally | **yes** |
| Firefox | recent versions resolve `*.localhost` to loopback | not installed, **not verified** |
| Windows tools (curl, PowerShell, Node) | **do not** resolve `*.localhost`: "No such host is known" | yes (that's expected) |

**Fallback for a browser that doesn't resolve `*.localhost`** (local only, one line per restaurant): open Notepad **as Administrator**, edit `C:\Windows\System32\drivers\etc\hosts`, and add

```
::1        the-broast.localhost
127.0.0.1  the-broast.localhost
```

The hosts file has no wildcards, so add one pair of lines per restaurant subdomain. Chrome and Edge never need this.

**Command-line testing.** Connect to `localhost` and send the restaurant host in the header, exactly as the browser does:

```bash
curl -H "Host: the-broast.localhost:5173" http://localhost:5173/api/public/storefront
```

## 6. How the routing works (and why `VITE_API_URL` stays empty)

```
browser  http://the-broast.localhost:5173/api/...      (same origin, no CORS)
   │  Host: the-broast.localhost:5173
   ▼
Vite dev server (localhost:5173) ── proxy, Host header preserved ──▶ API (localhost:4000)
                                                                       │
                                     tenant = slug in Host ("the-broast"), checked in the DB
```

- The API reads the restaurant from the hostname. `localhost` itself is the platform: no restaurant, Super Admin only.
- Sign-in sessions are **host-only cookies**. A session on `the-broast.localhost` is never sent to another restaurant's subdomain or to `localhost`. The server also checks that every token matches the host it is used on.
- If `VITE_API_URL=http://localhost:4000` were set, every restaurant page would call the API cross-site. The session cookie would then not be sent, so staff would be signed out on every reload, and all restaurants would share one cookie jar. The proxy avoids both problems with no CORS loosening.
- Vite only accepts the hosts `localhost` and `*.localhost` (plus your `VITE_ROOT_DOMAIN` if you change it). A request carrying any other `Host` header gets **403** (DNS-rebinding protection).

## 7. Verify your setup in one command

With `npm run dev` running:

```bash
cd server
LOCAL_SA_EMAIL=you@example.com LOCAL_SA_PASSWORD='your-super-admin-password' npm run test:local-routing
```

It checks: the platform host, `*.localhost` acceptance and foreign-host rejection, super-admin sign-in, restaurant creation URLs with the port, subdomain → restaurant resolution, unknown slug → 404, owner sign-in and cookie isolation, isolated API calls, and QR URL → decode → customer menu → order.

> It **writes** to the database your dev server uses: it creates two restaurants named `routing-test-<id>-a/-b`, each with a dish, a table and an order, then **suspends** them. Run it against a development database, not data you care about.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "This site can't be reached / refused to connect" on `http://<slug>.localhost` | the address is missing `:5173`. Links generated after this update include it; restart `npm run dev` |
| "Restaurant not found" | no restaurant with that subdomain; check the subdomain on the Super Admin restaurant page |
| "This restaurant is temporarily unavailable" | restaurant suspended or its trial/subscription expired; reactivate or renew it in the Super Admin console |
| `Blocked request. This host ("…") is not allowed.` | you're using a host other than `localhost` / `*.localhost`. Set `VITE_ROOT_DOMAIN` (client) and `ROOT_DOMAIN` (server) to that domain and restart |
| `Error: Port 5173 is already in use` | another `npm run dev` is running; stop it. The port no longer silently moves to 5174, which would have broken generated links |
| `http://127.0.0.1:5173` doesn't load | Vite now listens on loopback via `localhost` (IPv6 `::1` on this laptop); use `http://localhost:5173` |
| Signed out on every reload | `VITE_API_URL` is set in `client/.env`; empty it and restart |
| API keeps restarting / stops responding during edits | `tsx watch` restarts on every save, and a half-saved file can crash it. Save again, or restart `npm run dev` |
| `curl http://<slug>.localhost:...` → "Could not resolve host" | expected on Windows; use the `Host:` header form in §5 |

## 9. Demonstration walkthrough (about 10 minutes)

Use this to show TableSaaS to a client on your laptop. URLs as configured in `client/vite.config.ts` (port 5173) and `server/.env` (port 4000).

1. **Start:** `npm run dev` (project root). Wait for `[BOOT] API listening on :4000` and Vite's `Local: http://localhost:5173/`.
2. **Platform:** open `http://localhost:5173`, sign in as Super Admin, and show **Overview**, **Restaurants** and **Plans**.
3. **Create a demo restaurant:** **Restaurants → New restaurant**, e.g. name *Demo Grill*, subdomain `demo-grill`, plan *Pro*, owner `owner@demo-grill.test` with a temporary password. The success message shows `http://demo-grill.localhost:5173`.
4. **Owner setup:** open `http://demo-grill.localhost:5173/login` in another browser window (or a private window, so the platform session stays separate) and sign in as the owner. In **Branding**, upload a logo and hero photo, pick a preset and **Publish changes**. In **Menu**, add 2 categories and 3–4 dishes with photos, marking one as **Featured** and giving one a promo price.
5. **Tables & QR:** **Add tables → Several at once** (3, prefix `T`). Click **Link** on T1 and paste it into a new tab: the menu opens with **Table T1**.
6. **Order as a guest:** add a dish → **View order** → **Place order** → watch the tracking page.
7. **Run service:** in the owner window, the order arrives with a sound → **Accept** → **Kitchen display** → **Start** → **Ready** → **Orders** → **Mark served** → **Collect payment** → **Complete & close**. The guest's tracking page updates live.
8. **Branding switch:** change the preset in **Branding** and reload the storefront. The same layout appears in the new brand identity.

Run the automated checks before a demo:

```bash
npm run typecheck                       # server + client
cd server && npm test                   # 69 unit + integration tests (in-memory MongoDB)
cd .. && npm run build                  # production builds (server dist + client dist)
cd server && npm run e2e                # 20-step journey on the built app (in-memory MongoDB)
LOCAL_SA_EMAIL=… LOCAL_SA_PASSWORD='…' npm run test:local-routing   # against your running npm run dev
```

> Demo restaurants live in the database your dev server uses. Point development at a development database, and suspend demo restaurants afterwards (Super Admin → restaurant → **Suspend**).
