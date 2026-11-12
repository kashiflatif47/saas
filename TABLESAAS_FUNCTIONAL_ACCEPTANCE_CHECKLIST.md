# TableSaaS — Functional Acceptance Checklist

**Date:** 2026-11-11 · Each line states **how** it was verified in this pass.

**Evidence key**
- **T** = automated server test (`npm test`)
- **E** = E2E journey against the built app (`npm run e2e`)
- **B** = real Chrome, built app, at 390 / 768 / 1024 / 1440 / 1920 px
- **R** = new regression test (`regressions.test.ts`)
- **—** = not verified (reason given)

All automated runs use in-memory MongoDB.

## Super Admin
| Item | Status | Evidence |
|---|---|---|
| Login on platform host; refused on tenant hosts; wrong password refused | ✅ | E, T |
| Session refresh, rotation, logout revokes refresh session | ✅ | E, T |
| Create restaurant + owner account + subdomain (default station, trial) | ✅ | E, T |
| Default menu languages follow the plan | ✅ | R `BUG-002` |
| Edit restaurant details (timezone validated) | ✅ | E, T |
| Suspend → storefront offline, staff signed out, **live sockets closed**; reactivate restores | ✅ | E, R `BUG-012` |
| Subscription plans create/edit; renew, extend trial, set status, feature overrides | ✅ | T |
| Tenant accounts: deactivate, reset password, unlock (sessions + sockets revoked) | ✅ | T, R |
| Platform overview, audit log | ✅ | E, B |
| Platform settings screen, platform user management UI, extended reports | — | Not built (see remaining issues) |

## Restaurant Owner
| Item | Status | Evidence |
|---|---|---|
| Login on own subdomain only | ✅ | E, T |
| Change own password (wrong/short refused, old tokens revoked, new password works) | ✅ | R `COVERAGE` (no test existed before this pass) |
| Dashboard statistics (today, active orders, tables, low stock) | ✅ | E, B |
| Profile, contact, opening hours, settings persist after reload | ✅ | E |
| Settings save on plans without multi-language | ✅ | R `BUG-002`, `BUG-002b` |
| Invalid timezone rejected; stored bad timezone cannot crash pages | ✅ | R `BUG-001`, `BUG-001b` |
| Branding colours/fonts persist; logo/hero upload; non-images and oversize rejected | ✅ | E, T |
| Categories and subcategories create/edit/delete/reorder; max two levels enforced | ✅ | T, R `BUG-007` |
| Dishes: create/edit, photos, variants, add-ons, promo price, availability, featured, archive | ✅ | E, T |
| Plan limits for staff and dishes, on create **and** on reactivate/restore | ✅ | R `BUG-008`, `BUG-013` |
| Plan limit for tables | ⚠️ | Code reviewed only (inactive tables count toward the limit, so no bypass); no automated test |
| Staff create/edit/deactivate; role permissions; no privilege escalation | ✅ | T |
| Profile edits no longer sign the person out; real access changes still do | ✅ | R `BUG-010` |
| Notifications list, mark read, live push | ✅ | T, B |
| Reports and CSV/PDF exports | ✅ | T |

## Customer storefront
| Item | Status | Evidence |
|---|---|---|
| Subdomain routing; public menu without login; correct branding | ✅ | E, B |
| Categories, dishes, images, variants, add-ons, sold-out state | ✅ | E, B |
| Cart add/quantity/remove; estimate; server recomputes prices, taxes, service, coupons | ✅ | T, E, B |
| Checkout creates exactly one order (retry and double click) | ✅ | R `BUG-005`, B |
| Order tracking, live status, option names kept, paid state live | ✅ | B |
| Feedback after service; no duplicate rating form | ✅ | T |
| Reservations | ✅ | T, B |

## QR and tables
| Item | Status | Evidence |
|---|---|---|
| Table create (single/bulk), unique token, PNG/SVG/PDF download | ✅ | E, T |
| QR decodes to this restaurant's host and table | ✅ | E |
| QR landing opens the menu with the table badge | ✅ | B |
| Regenerate invalidates the old QR; a token never resolves on another tenant | ✅ | E, T |
| Real phone scan on a deployed domain | — | Not deployed |

## Order and kitchen workflow
| Item | Status | Evidence |
|---|---|---|
| Pending → accepted/rejected → preparing → ready → delivered → completed; invalid transitions refused | ✅ | T |
| Role-based transition permissions | ✅ | T |
| Item-level kitchen status derives order status | ✅ | T |
| Concurrent accepts applied once; concurrent item updates both succeed | ✅ | R `BUG-004`, `BUG-004b` |
| Kitchen display receives accepted orders live | ✅ | B |
| Staff screens recover after token expiry + reconnect and re-fetch missed orders | ⚠️ | Fix implemented; expiry path not reproduced in a browser |
| Cancellation restores stock and coupon usage | ✅ | T (business-rule question: TS-017) |

## Payments
| Item | Status | Evidence |
|---|---|---|
| Cash / card-terminal recording; never "paid" without real collection | ✅ | E, T |
| No over-collection on concurrent cash payments | ✅ | R `BUG-003` |
| No payments on cancelled/rejected/refunded orders | ✅ | R `BUG-006`, T |
| Refunds (cash), refund limits, payment status independent of order status | ✅ | T |
| Webhook signature verification and idempotency | ✅ | T |
| Online intent reused instead of duplicated | ✅ | R `BUG-011` (network stubbed) |
| Stripe against a real (test-mode) account | — | No credentials (TS-019) |

## Security and tenant isolation
| Item | Status | Evidence |
|---|---|---|
| Cross-tenant API, host/tenant mismatch, forged tokens, NoSQL operators refused | ✅ | E, T |
| Socket.IO events never cross tenants | ✅ | T |
| Revoked staff / suspended tenants lose live sockets | ✅ | R `BUG-012` |
| Account lockout, login rate limit, token revocation on password reset | ✅ | T |
| Uploads tenant-namespaced, magic-byte checked | ✅ | T |

## Configuration and data safety
| Item | Status | Evidence |
|---|---|---|
| Production config guard (placeholders, header tenancy, http, localhost) | ✅ | T |
| Health check reports DB state | ✅ | E |
| Dedicated databases for development and production | ❌ | **Owner decision** (TS-016) |
| Backups | — | Not configured in the repository; Atlas backup settings not inspected (no access) |

## Responsive / browser
| Item | Status | Evidence |
|---|---|---|
| 143 page states (all platform, restaurant and storefront pages × 5 widths + functional visits): 0 horizontal overflow, 0 console errors, 0 error states | ✅ | B |
| Safari/iOS, Firefox, physical phones | — | Not available on this machine |
