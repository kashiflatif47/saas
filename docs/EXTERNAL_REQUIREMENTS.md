# External credentials and infrastructure you must provide

Nothing below is faked or pre-filled. Each item is either required to run, or required only to enable the named feature.

## Required to run

| Item | Used for | Where to set | Notes |
|---|---|---|---|
| MongoDB 6+ connection string | All data | `server/.env` → `MONGODB_URI` | Atlas recommended (replica set, backups, PITR) |
| Domain name + DNS access | Tenant subdomains | DNS provider | Wildcard `*` A record, see DNS_SSL.md |
| Wildcard TLS certificate | HTTPS for `*.example.com` | Caddy or certbot | Needs a DNS-provider API token for the DNS-01 challenge |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Sessions | `server/.env` | ≥32 chars random, different values |
| `ENCRYPTION_KEY` | Encrypting tenant payment secrets | `server/.env` | 64 hex chars. **Back it up** |
| Super admin email/password | First platform login | `server/.env` → `SUPERADMIN_*` | Created on first boot if no super admin exists |
| Linux server / container host | Running API + serving SPA | your cloud | 1 vCPU / 1 GB is enough to start |

## Optional, per feature

| Feature | What's needed | Who provides it | How it's enabled |
|---|---|---|---|
| **Online card payments (Stripe)** | Each restaurant's own Stripe account: publishable key, secret (or restricted) key, webhook signing secret. Plan must include `online_payments` | The restaurant owner | Dashboard → Settings → Payments → save keys → **Verify with Stripe** (live API call). Add webhook endpoint `https://<your-domain>/api/webhooks/stripe/<tenantId>` (shown in the UI) with `payment_intent.succeeded`, `payment_intent.payment_failed`, `refund.updated`. Until verified, customers do not see "Pay online". Stripe must support the tenant's currency |
| Local payment gateways (JazzCash, Easypaisa, PayFast, HyperPay, Tap…) | Merchant credentials + API docs | Restaurant/platform | **Not implemented.** The provider interface (`OnlineProvider` in `services/paymentService.ts`) is ready: implement `createIntent`, `refund`, `verifyCredentials` and add a signed webhook route like the Stripe one |
| Platform subscription billing (charging restaurants automatically) | Billing provider (Stripe Billing, etc.) | Platform owner | **Not automated.** Subscriptions are managed by the super admin (renew/extend/suspend). Payment collection from restaurants happens outside the app |
| Object storage for uploads (multi-server) | S3/R2/GCS bucket + credentials | Platform owner | Replace `storeTenantImage` / `deleteTenantImage` in `middleware/upload.ts` |
| Email / SMS / WhatsApp notifications | Provider (SES, Twilio, WhatsApp Cloud API…) | Platform owner | **Not implemented.** In-app and real-time notifications are built in. Hook a sender into `services/notify.ts` |
| Redis | Multi-instance Socket.IO + shared rate limits | Platform owner | See DEPLOYMENT.md §7 |
| Google Fonts | Theme fonts | n/a (public CDN) | Loaded from fonts.googleapis.com. Self-host if required by policy |

## What happens without them

- No Stripe keys: cash and card-terminal payments work fully, and online payment is hidden. The API returns `PROVIDER_NOT_CONFIGURED` if called.
- No email/SMS: staff see notifications in the dashboard bell and via live sockets. Customers track orders on the live tracking page.
