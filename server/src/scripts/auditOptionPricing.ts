/**
 * READ-ONLY report of dishes whose option pricing needs the owner's review (see services/optionAudit.ts).
 * It never writes to the database: fix flagged dishes in Menu → edit dish, where the editor explains each choice.
 *
 *   npm run audit:option-pricing            (development, tsx)
 *   npm run audit:option-pricing:prod       (production build)
 *   add --json for machine-readable output
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { connectDb } from '../db/connect';
import { Product } from '../models/menu';
import { Tenant } from '../models/platform';
import { runCrossTenant } from '../models/tenantScope';
import { auditProducts } from '../services/optionAudit';

async function main() {
  await connectDb(env.MONGODB_URI);
  // Read-only queries only (find + lean).
  const products = await runCrossTenant(() => Product.find({ isArchived: false, 'variants.0': { $exists: true } }).lean().exec());
  const tenants = new Map((await Tenant.find().select('slug settings.currencyDecimals').lean()).map((t: any) => [String(t._id), t]));
  const byTenant = new Map<string, any[]>();
  for (const p of products as any[]) byTenant.set(String(p.tenantId), [...(byTenant.get(String(p.tenantId)) ?? []), p]);

  const report: any[] = [];
  for (const [tid, list] of byTenant) {
    const t: any = tenants.get(tid);
    const dec = t?.settings?.currencyDecimals ?? 2;
    const fmt = (n: number | null) => (n == null ? '—' : (n / 10 ** dec).toFixed(dec));
    for (const r of auditProducts(list)) {
      report.push({ restaurant: t?.slug ?? tid, ...r });
      if (process.argv.includes('--json')) continue;
      console.info(`\n[${t?.slug ?? tid}] ${r.name}  (${r.flags.join(', ')})`);
      console.info(`  base price: ${fmt(r.basePrice)}${r.implicitRequired ? '  · "must choose an option" was never set explicitly (old dish)' : ''}`);
      for (const o of r.options) console.info(`  - ${o.name}: stored ${fmt(o.storedAmount)} → customer pays ${fmt(o.customerPays)}`);
      for (const p of r.problems) console.info(`  ! ${p}`);
    }
  }
  if (process.argv.includes('--json')) console.info(JSON.stringify(report, null, 2));
  else console.info(`\n${report.length} dish(es) need review. Nothing was changed.`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('[AUDIT] failed', e);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
