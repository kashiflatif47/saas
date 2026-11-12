import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import { Job } from '../models/growth';

/**
 * Persistent job queue (MongoDB). Replaces in-memory timers for business operations:
 *  - jobs survive restarts; a job left "running" by a crashed process is reclaimed when its lease expires;
 *  - `key` makes scheduling idempotent: the same key is enqueued at most once, ever;
 *  - claiming is a single atomic findOneAndUpdate, so two workers (or two server instances) never run the
 *    same job at the same time;
 *  - failures are retried with exponential backoff up to maxAttempts, then kept as "failed" with the error;
 *  - every job carries its tenantId and handlers only touch that tenant's data.
 */
export type JobHandler = (job: { _id: Types.ObjectId; tenantId?: Types.ObjectId | null; payload: any; attempts: number; key?: string }) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();
export const WORKER_ID = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
const LEASE_MS = 5 * 60_000;

export function registerJob(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export async function enqueueJob(spec: { type: string; tenantId?: Types.ObjectId | string | null; runAt?: Date; payload?: unknown; key?: string; maxAttempts?: number }) {
  const doc = { type: spec.type, tenantId: spec.tenantId ?? null, runAt: spec.runAt ?? new Date(), payload: spec.payload ?? {}, status: 'queued', attempts: 0, maxAttempts: spec.maxAttempts ?? 5 };
  if (!spec.key) return Job.create(doc);
  try {
    await Job.updateOne({ key: spec.key }, { $setOnInsert: { ...doc, key: spec.key } }, { upsert: true });
  } catch (e: any) {
    if (e?.code !== 11000) throw e; // two schedulers raced on the same key: one job exists, which is the point
  }
  return Job.findOne({ key: spec.key }).lean();
}

export function backoffMs(attempt: number) {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}

/** Claims the next due job (or a running job whose lease expired after a crash). */
async function claim(now: Date, types?: string[]) {
  return Job.findOneAndUpdate(
    {
      ...(types ? { type: { $in: types } } : {}),
      $or: [{ status: 'queued', runAt: { $lte: now } }, { status: 'running', lockedUntil: { $lt: now } }],
    },
    { $set: { status: 'running', lockedBy: WORKER_ID, lockedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, new: true },
  ).lean();
}

/** Runs due jobs until none are left (or `max` were run). Used by the worker loop and by tests. */
export async function runDueJobs(opts: { max?: number; now?: () => Date; types?: string[] } = {}) {
  const now = opts.now ?? (() => new Date());
  let ran = 0;
  for (; ran < (opts.max ?? 100); ran++) {
    const job = await claim(now(), opts.types);
    if (!job) break;
    const handler = handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
      const result = await handler(job as any);
      await Job.updateOne({ _id: job._id, lockedBy: WORKER_ID }, { $set: { status: 'done', result: result ?? null, finishedAt: new Date(), lastError: null }, $unset: { lockedUntil: 1 } });
    } catch (e: any) {
      const failed = job.attempts >= job.maxAttempts;
      await Job.updateOne(
        { _id: job._id, lockedBy: WORKER_ID },
        { $set: { status: failed ? 'failed' : 'queued', lastError: String(e?.message ?? e).slice(0, 500), runAt: new Date(now().getTime() + backoffMs(job.attempts)), ...(failed ? { finishedAt: new Date() } : {}) }, $unset: { lockedUntil: 1 } },
      );
      if (failed) console.error('[JOB] failed permanently', job.type, String(job._id), e?.message);
    }
  }
  return ran;
}

/** Background worker: polls for due jobs; `scheduler` enqueues recurring work (idempotent keys). */
export function startWorker(scheduler: () => Promise<void>, intervalMs = 5_000) {
  let busy = false;
  let lastSchedule = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (Date.now() - lastSchedule > 60_000) {
        lastSchedule = Date.now();
        await scheduler().catch((e) => console.error('[JOB] scheduler error', e?.message ?? e));
      }
      await runDueJobs();
    } catch (e: any) {
      console.error('[JOB] worker error', e?.message ?? e);
    } finally {
      busy = false;
    }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 2_000);
  return t;
}
