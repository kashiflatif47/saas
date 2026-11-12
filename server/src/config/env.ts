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
