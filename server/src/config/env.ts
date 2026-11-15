import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/tablesaas'),
  ROOT_DOMAIN: z.string().min(1).default('localhost'),
  APP_PROTOCOL: z.enum(['http', 'https']).default('http'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(14),
  /** 64 hex chars (32 bytes) used to encrypt per-tenant payment provider secrets at rest. */
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars'),
  UPLOAD_DIR: z.string().default('uploads'),
  MAX_UPLOAD_MB: z.coerce.number().default(5),
  /** Local development only: allow X-Tenant-Slug header when subdomains are unavailable. */
  ALLOW_TENANT_HEADER: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  SUPERADMIN_EMAIL: z.string().email().optional(),
  SUPERADMIN_PASSWORD: z.string().min(10).optional(),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  /**
   * Optional port appended to generated restaurant/platform URLs and QR codes (e.g. 5173).
   * Leave empty: in development the port the browser uses is detected per request; in production
   * URLs have no port (80/443).
   */
  APP_PUBLIC_PORT: z
    .string()
    .regex(/^\d{0,5}$/, 'APP_PUBLIC_PORT must be a port number')
    .default(''),
  /**
   * Optional: absolute or relative path to the built client (client/dist). When set, this process also
   * serves the SPA (single-service deployments, e.g. a PaaS behind a wildcard domain). Leave empty when
   * a reverse proxy (Nginx/Caddy) serves client/dist itself.
   */
  CLIENT_DIST_DIR: z.string().default(''),
  /**
   * How restaurant URLs are generated (links, QR codes, unsubscribe links):
   *  - `path` (default): https://ROOT_DOMAIN/r/<slug> — one domain, no DNS or hosting setup per restaurant;
   *  - `subdomain`: https://<slug>.ROOT_DOMAIN — needs wildcard DNS + a host that routes every subdomain here.
   * Requests that arrive on a restaurant subdomain or custom domain are still served in both modes.
   */
  TENANT_URL_MODE: z.enum(['path', 'subdomain']).default('path'),
  /*
   * Media storage (see docs/STORAGE_AND_BACKUP.md). Uploaded images must live OUTSIDE the deployment folder.
   * Credentials can be set here (they then take precedence and cannot be changed in the console) or in the
   * platform console (stored encrypted with ENCRYPTION_KEY). Secrets are never sent to browsers or logged.
   */
  STORAGE_DEFAULT_PROVIDER: z.enum(['', 'cloudinary', 's3', 'local']).default(''),
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  CLOUDINARY_FOLDER: z.string().default('tablesaas'),
  /** API base (only for tests or an approved proxy). */
  CLOUDINARY_API_BASE_URL: z.string().default('https://api.cloudinary.com'),
  S3_ENDPOINT: z.string().default(''), // e.g. https://<account>.r2.cloudflarestorage.com or https://s3.eu-central-1.amazonaws.com
  S3_REGION: z.string().default(''), // "auto" for Cloudflare R2
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_PUBLIC_BASE_URL: z.string().default(''), // CDN / public bucket URL; empty = served through signed redirects
  S3_FORCE_PATH_STYLE: z.string().default('true').transform((v) => v !== 'false'),
  S3_PRIVATE: z.string().default('false').transform((v) => v === 'true'),
  /** Production only: confirms UPLOAD_DIR is a persistent folder outside the app that the host keeps across releases. */
  LOCAL_UPLOADS_PERSISTENT: z.string().default('false').transform((v) => v === 'true'),
  /** Request access log (method, path, status, duration — never bodies or headers). */
  LOG_REQUESTS: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
});

export type Env = z.infer<typeof schema>;

/** Values shipped in .env.example — booting production with any of them is refused. */
const PLACEHOLDER_SECRETS = [/^replace-with/i, /^0{64}$/, /change-this/i, /^changeme/i];

/**
 * Production-only safety checks. Returns a list of problems (empty = OK).
 * Exported for unit tests.
 */
export function productionProblems(e: Env): string[] {
  if (e.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  const isPlaceholder = (v?: string) => !!v && PLACEHOLDER_SECRETS.some((re) => re.test(v));
  for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY'] as const) {
    if (isPlaceholder(e[k])) problems.push(`${k} still has the example placeholder value`);
  }
  if (e.JWT_ACCESS_SECRET.length < 64) problems.push('JWT_ACCESS_SECRET must be at least 64 chars in production');
  if (e.JWT_REFRESH_SECRET.length < 64) problems.push('JWT_REFRESH_SECRET must be at least 64 chars in production');
  if (e.JWT_ACCESS_SECRET === e.JWT_REFRESH_SECRET) problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  if (e.ALLOW_TENANT_HEADER) problems.push('ALLOW_TENANT_HEADER must be false in production');
  if (e.APP_PROTOCOL !== 'https') problems.push('APP_PROTOCOL must be https in production');
  if (/^(localhost|127\.)/.test(e.ROOT_DOMAIN)) problems.push('ROOT_DOMAIN must be your real domain in production');
  if (isPlaceholder(e.SUPERADMIN_PASSWORD)) problems.push('SUPERADMIN_PASSWORD still has the example placeholder value');
  return problems;
}

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast: never boot with insecure or missing configuration.
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}
const prodIssues = productionProblems(parsed.data);
if (prodIssues.length) {
  console.error('Refusing to start in production with insecure configuration:\n  - ' + prodIssues.join('\n  - '));
  throw new Error('Insecure production configuration');
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
