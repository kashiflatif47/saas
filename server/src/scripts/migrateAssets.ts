/**
 * Copies existing images to permanent storage and verifies them (see services/mediaMigration.ts).
 * Safe by design: originals are never deleted; a record's reference changes only after a verified copy;
 * missing originals are reported, never replaced.
 *
 *   npm run assets:migrate -- --to cloudinary --dry-run          # report only, nothing written
 *   npm run assets:migrate -- --to s3 [--tenant lzzat] [--assets] [--report migration-report.json]
 *   production build: npm run assets:migrate:prod -- --to cloudinary
 *
 *   --assets  also copy images already on another provider (switching provider); addresses stay the same.
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { connectDb } from '../db/connect';
import { Tenant } from '../models/platform';
import { migrateTenantMedia, type MigrationEntry } from '../services/mediaMigration';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const to = arg('to');
  if (to !== 'cloudinary' && to !== 's3' && to !== 'local') throw new Error('Usage: --to cloudinary|s3 [--tenant <slug>] [--dry-run] [--assets] [--report <file>]');
  const dryRun = process.argv.includes('--dry-run');
  await connectDb(env.MONGODB_URI);
  const slug = arg('tenant');
  const tenants = await Tenant.find(slug ? { slug } : {}).select('slug').lean();
  if (!tenants.length) throw new Error(slug ? `No restaurant "${slug}"` : 'No restaurants found');
  const report: (MigrationEntry & { restaurant: string })[] = [];
  for (const t of tenants) {
    for (const e of await migrateTenantMedia({ tenantId: t._id, to, dryRun, includeAssets: process.argv.includes('--assets') })) {
      report.push({ restaurant: t.slug, ...e });
      console.info(`[${t.slug}] ${e.status.padEnd(13)} ${e.record}  ${e.from}${e.to ? ` → ${e.to}` : ''}${e.reason ? `  (${e.reason})` : ''}`);
    }
  }
  const count = (s: string) => report.filter((r) => r.status === s).length;
  console.info(`\n${dryRun ? 'DRY RUN — nothing was changed. ' : ''}migrated ${count('migrated')} · would migrate ${count('would-migrate')} · missing ${count('missing')} · failed ${count('failed')} · skipped ${count('skipped')}`);
  console.info('Original files were not deleted.');
  const out = arg('report');
  if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), to, dryRun, report }, null, 2));
  await mongoose.disconnect();
  process.exit(count('failed') ? 2 : 0);
}

main().catch(async (e) => {
  console.error('[MIGRATE] failed:', e.message);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
