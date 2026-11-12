/** Imported FIRST by every integration test so env is set before src/config/env.ts loads. */
import crypto from 'node:crypto';

// Must be set before any src module loads env.ts
process.env.NODE_ENV = 'test';
process.env.ROOT_DOMAIN = 'test.local';
process.env.JWT_ACCESS_SECRET = crypto.randomBytes(32).toString('hex');
process.env.JWT_REFRESH_SECRET = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.UPLOAD_DIR = `/tmp/tablesaas-test-uploads-${process.pid}`;
process.env.ALLOW_TENANT_HEADER = 'false';
