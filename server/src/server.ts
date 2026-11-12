import http from 'node:http';
import mongoose from 'mongoose';
import { env } from './config/env';
import { connectDb } from './db/connect';
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
