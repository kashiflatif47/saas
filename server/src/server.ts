import http from 'node:http';
import path from 'node:path';
import mongoose from 'mongoose';
import { env } from './config/env';
import { connectDb } from './db/connect';
import { storageStatus } from './services/media';
import { createApp } from './app';
import { initSockets } from './sockets';
import { startSubscriptionJob } from './jobs/subscriptions';
import { startWorker } from './jobs/queue';
import { registerAllJobs, scheduleRecurring } from './jobs/handlers';
import { ensureDefaultPlans, ensureSuperAdmin } from './services/bootstrap';

async function main() {
  await connectDb(env.MONGODB_URI);
  const plans = await ensureDefaultPlans();
  if (plans) console.info(`[BOOT] created ${plans} default subscription plans (edit them in the platform console)`);
  const sa = await ensureSuperAdmin(env.SUPERADMIN_EMAIL, env.SUPERADMIN_PASSWORD);
  if (sa === 'created') console.info(`[BOOT] created super admin ${env.SUPERADMIN_EMAIL} — change the password after first login`);
  if (sa === 'skipped') console.warn('[BOOT] no super admin exists and SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD are not set — see TABLESAAS_PRODUCTION_GUIDE.md');
  if (env.NODE_ENV === 'production' && !path.isAbsolute(env.UPLOAD_DIR)) {
    // Uploaded logos and dish photos live in this folder. Inside the app folder they can be lost when a
    // deployment replaces it; the records keep pointing at files that no longer exist.
    console.warn(`[BOOT] UPLOAD_DIR="${env.UPLOAD_DIR}" resolves to ${path.resolve(env.UPLOAD_DIR)} (inside the app). Set UPLOAD_DIR to an absolute folder outside the deployment so uploads survive redeploys.`);
  }
  // Permanent media storage: say plainly where new uploads go (never secrets).
  const media = await storageStatus();
  if (media.defaultProvider) console.info(`[BOOT] image uploads go to: ${media.defaultProvider}${media.defaultProvider === 'local' && !media.local.persistent ? ' (development folder)' : ''}`);
  else console.warn('[BOOT] no permanent image storage configured: uploads are refused until Cloudinary or S3-compatible storage is set up (platform console → Storage, or CLOUDINARY_* / S3_* variables). Linked https images still work.');
  const app = createApp();
  const server = http.createServer(app);
  const io = initSockets(server);
  const job = startSubscriptionJob();
  // Persistent job worker (campaigns, journeys, forecasts, segments, delivery timeouts/delays, cleanup).
  registerAllJobs();
  const worker = startWorker(() => scheduleRecurring());
  server.listen(env.PORT, () => console.info(`[BOOT] API listening on :${env.PORT} (root domain ${env.ROOT_DOMAIN})`));

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.info(`[BOOT] ${sig} received, shutting down`);
    clearInterval(job);
    clearInterval(worker);
    // Stop accepting connections, close sockets, then the DB. Force-exit if draining takes too long.
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    await new Promise<void>((r) => io.close(() => r()));
    await mongoose.disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (e) => console.error('[PROCESS] unhandled rejection', e));

main().catch((e) => {
  console.error('[BOOT] fatal', e);
  process.exit(1);
});
