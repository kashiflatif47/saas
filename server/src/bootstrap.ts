/**
 * PRODUCTION bootstrap: creates the default subscription plans (only if none exist) and the first super
 * admin from SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD (only if no super admin exists). Creates no
 * restaurants, users, menus or transactions. Idempotent and non-destructive — safe to run on every deploy.
 * (The API server performs the same steps at boot; this command lets you do it before first start.)
 *
 * Usage: npm run bootstrap            (from server/, with server/.env configured)
 */
import mongoose from 'mongoose';
import { env } from './config/env';
import { connectDb } from './db/connect';
import { ensureDefaultPlans, ensureSuperAdmin } from './services/bootstrap';

async function main() {
  await connectDb(env.MONGODB_URI);
  const plans = await ensureDefaultPlans();
  console.info(plans ? `Created ${plans} default plans.` : 'Plans already exist — unchanged.');
  const sa = await ensureSuperAdmin(env.SUPERADMIN_EMAIL, env.SUPERADMIN_PASSWORD);
  console.info(
    {
      created: `Created super admin ${env.SUPERADMIN_EMAIL}. Sign in at the platform root domain /login and change the password.`,
      exists: 'A super admin already exists — unchanged (use `npm run superadmin -- --email … --reset-password` to reset).',
      skipped: 'No super admin exists and SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD are not set — none created.',
    }[sa as 'created' | 'exists' | 'skipped'],
  );
  await mongoose.disconnect();
  if (sa === 'skipped') process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
