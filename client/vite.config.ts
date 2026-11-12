import { createLogger, defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * When a browser tab with live updates is closed or navigates away, its Socket.IO WebSocket drops mid-write and
 * Vite logs "ws proxy socket error: ECONNRESET/ECONNABORTED/EPIPE". That is a normal client disconnect, not a
 * fault, so only that exact case is filtered; every other proxy error is still printed.
 */
const logger = createLogger();
const logError = logger.error.bind(logger);
const CLIENT_GONE = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE']);
logger.error = (msg, options) => {
  const code = (options?.error as { code?: string } | undefined)?.code;
  if (msg.includes('ws proxy socket error') && code && CLIENT_GONE.has(code)) return;
  logError(msg, options);
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const root = (env.VITE_ROOT_DOMAIN || 'localhost').toLowerCase();
  const apiTarget = env.VITE_DEV_API_TARGET || 'http://localhost:4000';
  if (mode === 'production' && root === 'localhost') {
    // With a localhost root, the real domain would be treated as a restaurant "custom domain" (storefront only):
    // the platform console and every /r/<slug> page would be unreachable.
    logger.warn('\n[tablesaas] WARNING: VITE_ROOT_DOMAIN is "localhost" in a production build. Set it to the real domain (client/.env.production).\n');
  }
  return {
  customLogger: logger,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'TableSaaS — Restaurant OS',
        short_name: 'TableSaaS',
        description: 'Ordering, kitchen display, staff and analytics for restaurants and hotels',
        theme_color: '#1C1917',
        background_color: '#FAFAF9',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Safe offline: cache the app shell and static assets only. API calls are NEVER cached,
        // so orders, payments and stock are always live (no stale or replayed transactions).
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//, /^\/uploads\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          { urlPattern: ({ url }) => url.pathname.startsWith('/uploads/'), handler: 'StaleWhileRevalidate', options: { cacheName: 'tenant-images', expiration: { maxEntries: 300, maxAgeSeconds: 7 * 86400 } } },
          { urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com', handler: 'CacheFirst', options: { cacheName: 'fonts', expiration: { maxEntries: 30, maxAgeSeconds: 365 * 86400 } } },
        ],
      },
    }),
  ],
  server: {
    port: Number(env.VITE_DEV_PORT || 5173),
    strictPort: true, // generated restaurant links and QR codes use this port; never silently move to 5174
    // Loopback only by default ("::" + IPv4 fallback would publish the dev server to the whole network).
    // Browsers resolve every *.localhost name to loopback themselves (RFC 6761). Set VITE_DEV_HOST=0.0.0.0
    // only if you deliberately want other devices on your network to reach the dev server.
    host: env.VITE_DEV_HOST || 'localhost',
    // DNS-rebinding protection stays ON: only the platform host and its restaurant subdomains are accepted.
    // A leading dot allows the domain and all of its subdomains (localhost, brost.localhost, …).
    allowedHosts: ['localhost', '.localhost', ...(root !== 'localhost' ? [root, `.${root}`] : [])],
    // Same-origin API in development: the browser calls /api on its own host (brost.localhost:5173) and Vite
    // forwards to the API, KEEPING the original Host header (changeOrigin: false) so the API resolves the tenant
    // from it. This also keeps auth cookies host-only per restaurant (no cross-site cookies, no CORS needed).
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/uploads': { target: apiTarget, changeOrigin: false },
      '/socket.io': { target: apiTarget, ws: true, changeOrigin: false },
    },
  },
  preview: {
    port: 4173,
    host: env.VITE_DEV_HOST || 'localhost',
    allowedHosts: ['localhost', '.localhost', ...(root !== 'localhost' ? [root, `.${root}`] : [])],
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/uploads': { target: apiTarget, changeOrigin: false },
      '/socket.io': { target: apiTarget, ws: true, changeOrigin: false },
    },
  },
  };
});
