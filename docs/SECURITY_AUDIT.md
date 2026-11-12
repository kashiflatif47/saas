# Security audit report

Scope: `server/` API, Socket.IO, uploads, payments, and the `client/` SPA. Method: design review of every route and service against OWASP ASVS L2 and the OWASP API Top 10 (2023), plus automated tests (unit tests executed; integration tests written and must be run, see VERIFICATION_STATUS.md).

## Threat model summary

| Actor | Goal | Primary controls |
|---|---|---|
| Customer / anonymous | Read other tenants' data, tamper with prices, fake payments, spam orders | Host-based tenant resolution, server-side pricing, signed webhooks only, rate limits, secret tracking tokens |
| Staff of tenant A | Access tenant B; escalate role | JWT tenant claim is the only tenant source, host/tenant match, model-level tenant guard, RBAC per route, owner-only privileges |
| Compromised staff account | Abuse | Short-lived access tokens, rotating refresh tokens with reuse detection, deactivation revokes sessions, audit log |
| Platform operator mistake | Cross-tenant query bug | Mongoose plugin throws on any tenant-scoped query without `tenantId` |

## Findings and controls

| # | Area (OWASP) | Control implemented | Status |
|---|---|---|---|
| 1 | **API1 BOLA / IDOR** | Every tenant query filters by `tenantId` from the JWT. Mongoose `tenantScopePlugin` rejects find/update/delete/aggregate without `tenantId`. IDs validated as ObjectIds. Cross-tenant IDs return 404 (no existence oracle) | Implemented, integration-tested |
| 2 | **API2 Broken auth** | bcrypt (cost 12). Access JWT 15 min, HS256 pinned. Refresh token: random 256-bit, stored **hashed**, rotated on use, reuse → revoke all sessions, httpOnly + SameSite=Lax + Secure (prod) + **host-only**. Login rate limit 20/15 min/IP. Lockout after 8 failures. `tokenVersion` bump on password change, role change, deactivation and tenant suspension | Implemented |
| 3 | **API3 Property-level authz / mass assignment** | All bodies parsed by Zod schemas (unknown keys stripped). `tenantId` is immutable at schema level and stripped from updates. Owner role cannot be assigned or changed. Only the owner manages admins | Implemented, tested (`tenantId` override test) |
| 4 | **API4 Resource consumption** | JSON limit 1 MB. Uploads 5 MB, max 8 files. Pagination capped at 200. Public order 15/min/IP, forms 20/15 min. Export row caps (50k CSV, 5k PDF). Analytics range capped at 3 years | Implemented. Use Redis-backed limits when running multiple instances |
| 5 | **API5 Function-level authz** | `can(...)` permission middleware on every staff route. Per-transition order permissions. Super admin routes behind `requireSuperAdmin`. Super admins cannot call tenant staff APIs | Implemented, tested |
| 6 | **API6 Business flows** | Prices, discounts, tax and service computed server-side from DB. Coupon usage atomic (`usedCount < usageLimit`). Stock reserved atomically with compensating rollback. Overpayment and over-refund rejected. Orders never auto-marked paid | Implemented, tested |
| 7 | **API7 SSRF** | The only outbound call is to `https://api.stripe.com` with fixed paths. No user-supplied URLs fetched | N/A by design |
| 8 | **API8 Misconfiguration** | Helmet headers, `x-powered-by` off, strict CORS (root domain, its subdomains and configured origins only), env validated at boot (rejects short secrets), errors hide stack traces in production, `ALLOW_TENANT_HEADER` dev-only | Implemented |
| 9 | **Injection** | Mongo operator keys (`$…`, dotted, `__proto__`) stripped from body and query. Regex search input escaped. Zod types prevent object injection into filters | Implemented |
| 10 | **Payments integrity** | Stripe webhooks verified with HMAC-SHA256, constant-time compare and 5-minute replay window. Amount, currency and tenant metadata must match the pending record. Idempotent processing. Provider secrets AES-256-GCM encrypted at rest, never returned by the API, `select:false` | Implemented, unit- and integration-tested |
| 11 | **File upload** | Type by magic bytes (PNG/JPEG/WEBP/ICO only; SVG rejected to prevent stored XSS). Random filenames. Stored under `uploads/<tenantId>/…`. Deletion confined to the tenant's directory (path-traversal guard). Static serving with `dotfiles: deny`, no index | Implemented, tested |
| 12 | **XSS** | React escapes all output. No `dangerouslySetInnerHTML`. Tenant-supplied colours validated as `#RRGGBB` before becoming CSS variables. Social links must be URLs | Implemented |
| 13 | **CSV injection** | Cells starting with `= + - @ \t \r` are prefixed with `'` | Implemented, unit-tested |
| 14 | **Real-time** | Socket handshake requires a valid staff JWT (checked against DB `tokenVersion`) or an order id + secret tracking token. Rooms are tenant-prefixed server-side. Client can only join stations under its own tenant prefix | Implemented, tested |
| 15 | **Audit** | Logins, provisioning, suspensions, subscription changes, settings/branding/payment config changes, staff changes, menu changes, order transitions, payments and refunds, inventory operations are all recorded with actor, IP and timestamp | Implemented |
| 16 | **Sensitive data exposure** | `passwordHash`, `refreshTokens`, `trackingToken`, `clientSecret`, provider secrets are `select:false`. Public tracking strips customer PII | Implemented |
| 17 | **PWA cache** | Service worker caches only static assets and images. `/api`, `/socket.io` are never cached, so there are no stale or replayed transactions offline | Implemented |

## Residual risks and recommendations

1. **Run `npm audit`** after the first install and keep dependencies patched (Dependabot/Renovate).
2. **MFA for super admins and owners**: not implemented. Recommended next step (TOTP).
3. **CSRF**: API auth uses a Bearer header (not cookies), so state-changing endpoints are not CSRF-exposed. `/api/auth/refresh` uses a SameSite=Lax cookie and only returns a token to same-site JavaScript (CORS-restricted). Keep CORS strict.
4. **Rate limiting** is in-memory per instance. Use a Redis store when scaling horizontally.
5. **Content-Security-Policy** for the SPA should be set at the proxy (sample in `deploy/nginx.conf`). Adjust `connect-src`/`frame-src` for Stripe (`js.stripe.com`, `api.stripe.com`).
6. **Uploads on local disk**: move to object storage with private buckets and a CDN for multi-instance deployments.
7. **Penetration test** by a third party before handling real payments at scale.
8. **Backups of `ENCRYPTION_KEY`**: see BACKUP_RECOVERY.md.
