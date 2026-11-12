import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env, isProd } from './config/env';
import { corsOriginCheck } from './app.cors';
import { errorHandler, notFoundHandler } from './middleware/error';
import { sanitizeInput, validateQuery, zPage } from './middleware/validate';
import { authenticate, requireSuperAdmin, can } from './middleware/auth';
import { requireActiveSubscription, requireStaffTenant, resolvePublicTenant } from './middleware/tenant';
import { authRouter } from './routes/auth';
import { superAdminRouter } from './routes/superadmin';
import { tenantAdminRouter } from './routes/tenantAdmin';
import { menuRouter } from './routes/menu';
import { tablesRouter } from './routes/tables';
import { ordersRouter, kitchenRouter } from './routes/orders';
import { publicRouter } from './routes/public';
import { inventoryRouter, reservationsRouter, customersRouter, feedbackRouter, couponsRouter } from './routes/business';
import { analyticsRouter } from './routes/analytics';
import { shiftsRouter } from './routes/shifts';
import { operationsReportRouter } from './routes/operationsReport';
import { syncRouter } from './routes/sync';
import { webhooksRouter } from './routes/webhooks';
import { intelligenceRouter, marketingRouter, deliveryRouter } from './routes/growth';
import { Payment } from './models/operations';
import { ah } from './lib/errors';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Nginx/Caddy/load balancer

  if (env.LOG_REQUESTS && env.NODE_ENV !== 'test') {
    // Access log: never logs query strings (order tracking tokens), bodies or headers (credentials).
    app.use((req, res, next) => {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const line = `[HTTP] ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(1)}ms host=${req.hostname}`;
        if (res.statusCode >= 500) console.error(line);
        else console.info(line);
      });
      next();
    });
  }

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // Same policy as deploy/nginx.conf and deploy/Caddyfile, so single-service mode (CLIENT_DIST_DIR)
      // renders identically: blob: for QR previews, Stripe.js for card payments, Google Fonts.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
          scriptSrc: ["'self'", 'https://js.stripe.com'],
          frameSrc: ['https://js.stripe.com', 'https://hooks.stripe.com'],
          connectSrc: ["'self'", 'wss:', 'https://api.stripe.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'], // fonts: fetched by the PWA service worker
          imgSrc: ["'self'", 'data:', 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          formAction: ["'self'"],
          ...(isProd ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      // HSTS only makes sense over HTTPS; the reverse proxy may also set it.
      strictTransportSecurity: isProd && env.APP_PROTOCOL === 'https' ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  app.use(cors({ origin: corsOriginCheck, credentials: true }));
  app.use(compression());

  // Webhooks need the raw body — mount before JSON parsing.
  app.use('/api/webhooks', webhooksRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(sanitizeInput);

  // Uploaded images (tenant-namespaced). In production, serve from object storage/CDN instead.
  app.use('/uploads', express.static(path.resolve(env.UPLOAD_DIR), { maxAge: isProd ? '30d' : 0, index: false, dotfiles: 'deny' }));

  app.get('/api/health', (_req, res) => {
    const dbState = mongoose.connection.readyState; // 1 = connected
    res.setHeader('Cache-Control', 'no-store');
    res.status(dbState === 1 ? 200 : 503).json({
      status: dbState === 1 ? 'ok' : 'degraded',
      db: dbState === 1 ? 'connected' : 'unavailable',
      uptimeSec: Math.round(process.uptime()),
      env: env.NODE_ENV,
      time: new Date().toISOString(),
    });
  });

  app.use('/api/auth', authRouter);

  /* Platform (super admin) */
  app.use('/api/platform', authenticate, requireSuperAdmin, superAdminRouter);

  /* Public storefront — tenant from Host header */
  app.use('/api/public', resolvePublicTenant, publicRouter);

  /* Tenant staff API — tenant from JWT; writes blocked when subscription lapsed */
  const staff = Router();
  staff.use(authenticate, requireStaffTenant, requireActiveSubscription);
  staff.use('/', tenantAdminRouter);
  staff.use('/menu', menuRouter);
  staff.use('/tables', tablesRouter);
  staff.use('/orders', ordersRouter);
  staff.use('/kitchen', kitchenRouter);
  staff.use('/inventory', inventoryRouter);
  staff.use('/reservations', reservationsRouter);
  staff.use('/customers', customersRouter);
  staff.use('/feedback', feedbackRouter);
  staff.use('/coupons', couponsRouter);
  staff.use('/analytics', analyticsRouter);
  staff.use('/analytics', operationsReportRouter);
  staff.use('/shifts', shiftsRouter);
  staff.use('/sync', syncRouter);
  staff.use('/intelligence', intelligenceRouter);
  staff.use('/marketing', marketingRouter);
  staff.use('/delivery', deliveryRouter);
  staff.get('/payments', can('payments:collect', 'analytics:view'), validateQuery(zPage.extend({ status: z.string().optional(), kind: z.string().optional(), method: z.string().optional() })), ah(async (req, res) => {
    const q = (req as any).validQuery;
    const filter: any = { tenantId: req.tenantId };
    for (const k of ['status', 'kind', 'method'] as const) if (q[k]) filter[k] = q[k];
    const [items, total] = await Promise.all([
      Payment.find(filter).populate('orderId', 'orderNumber tableLabel').populate('verifiedBy', 'name').sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      Payment.countDocuments(filter),
    ]);
    res.json({ items, total, page: q.page, limit: q.limit });
  }));
  app.use('/api/staff', staff);

  app.use('/api', notFoundHandler);

  if (env.CLIENT_DIST_DIR) {
    // Single-service mode: serve the built SPA for every non-API path on every host.
    const dist = path.resolve(env.CLIENT_DIST_DIR);
    const indexHtml = path.join(dist, 'index.html');
    if (!fs.existsSync(indexHtml)) throw new Error(`CLIENT_DIST_DIR is set but ${indexHtml} does not exist — build the client first`);
    app.use(
      express.static(dist, {
        index: false,
        dotfiles: 'ignore',
        setHeaders: (res, file) => {
          if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', 'no-cache'); // index.html, sw.js, manifest: always revalidate
        },
      }),
    );
    app.get(/^\/(?!api\/|socket\.io\/|uploads\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use(errorHandler);
  return app;
}
