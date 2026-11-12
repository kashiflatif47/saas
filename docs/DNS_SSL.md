# DNS and wildcard SSL

Every tenant is served at `https://<slug>.example.com`. You need **one wildcard DNS record** and **one wildcard certificate**. No per-tenant DNS work is needed when you onboard a restaurant.

## 1. DNS records

At your DNS provider (Cloudflare, Route 53, Namecheap…), with `203.0.113.10` as your server IP:

| Type | Name | Value | Purpose |
|---|---|---|---|
| A | `@` | 203.0.113.10 | platform console `example.com` |
| A | `*` | 203.0.113.10 | **all tenant subdomains** |
| A | `www` | 203.0.113.10 | optional |
| AAAA | `@` and `*` | your IPv6 | if available |

With Cloudflare, set the wildcard to "DNS only" (grey cloud) unless your plan proxies wildcards, and use "Full (strict)" TLS.

Verify: `dig +short anything.example.com` returns your IP.

## 2. Wildcard certificate

Let's Encrypt issues wildcards **only via the DNS-01 challenge**, so the issuer needs API access to your DNS.

### Option A: Caddy (automatic)

Build Caddy with your DNS provider module (e.g. Cloudflare):

```bash
xcaddy build --with github.com/caddy-dns/cloudflare
```

Create an API token with `Zone.DNS:Edit` for the zone and set `CLOUDFLARE_API_TOKEN` in Caddy's environment. `deploy/Caddyfile` already requests `example.com, *.example.com` with `tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN} }`. Caddy renews automatically.

### Option B: certbot + Nginx

```bash
sudo apt install certbot python3-certbot-dns-cloudflare
echo "dns_cloudflare_api_token = <token>" | sudo tee /root/.cf.ini && sudo chmod 600 /root/.cf.ini
sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/.cf.ini \
  -d example.com -d '*.example.com' --preferred-challenges dns-01
```

Certificates land in `/etc/letsencrypt/live/example.com/`. `deploy/nginx.conf` references them. Renewal runs from the certbot systemd timer. Add a deploy hook to reload nginx:

```bash
echo -e '#!/bin/sh\nsystemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

Other DNS providers have equivalent plugins (`certbot-dns-route53`, `-digitalocean`, …) or use `acme.sh`.

## 3. Application settings

`ROOT_DOMAIN=example.com`, `APP_PROTOCOL=https` (server) and `VITE_ROOT_DOMAIN=example.com` (client build). Refresh cookies are host-only, so a staff session on one tenant's subdomain is never sent to another tenant's subdomain. Sign-in is also refused when the login host and the requested tenant differ.

## 4. Reserved subdomains

`www, api, admin, app, static, cdn, assets, mail, smtp, ftp, dashboard, superadmin, status, docs, help, support, billing, ws, socket` cannot be assigned to tenants (`server/src/lib/subdomain.ts`).

## 5. Custom domains (optional, per tenant)

1. The restaurant creates `CNAME menu.theirdomain.com → <slug>.example.com` (or an A record to your IP).
2. Issue a certificate for that hostname: Caddy on-demand TLS (`on_demand_tls` with an `ask` endpoint) or certbot HTTP-01.
3. Super admin → Restaurant → **Custom domain** → save `menu.theirdomain.com`.
4. Add the origin to `CLIENT_ORIGIN` (comma separated) so CORS allows it, or keep the SPA same-origin via the proxy.

The API resolves tenants by `customDomain` when the host is not a subdomain of `ROOT_DOMAIN`.
