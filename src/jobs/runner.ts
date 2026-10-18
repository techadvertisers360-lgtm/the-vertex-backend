import type { Job, Prisma } from '@prisma/client';
import { prisma, type Db } from '../lib/prisma';
import { logger, toJsonSafe } from '../lib/misc';

/**
 * DB-backed job queue. Jobs are scheduled with a deterministic idempotency key
 * (e.g. `procedure:<itemId>:reminder_2d`), so re-scheduling or duplicate scheduler runs never create twins (spec §19).
 */
export type JobHandler = (job: Job) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export async function scheduleJob(
  db: Db,
  type: string,
  runAt: Date,
  idempotencyKey: string,
  payload?: Record<string, unknown>,
): Promise<Job> {
  return db.job.upsert({
    where: { idempotencyKey },
    update: {},
    create: { type, runAt, idempotencyKey, payload: payload ? (toJsonSafe(payload) as Prisma.InputJsonValue) : undefined },
  });
}

/** Cancel a pending job (e.g. old reminder when a procedure is rescheduled). */
export async function cancelJob(db: Db, idempotencyKey: string): Promise<void> {
  await db.job.updateMany({ where: { idempotencyKey, status: 'PENDING' }, data: { status: 'CANCELLED' } });
}

const MAX_ATTEMPTS = 5;

export async function claimDueJobs(workerId: string, batch = 20, now = new Date()): Promise<Job[]> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM jobs WHERE status = 'PENDING' AND runAt <= ${now}
      ORDER BY runAt ASC LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    await tx.job.updateMany({ where: { id: { in: ids } }, data: { status: 'RUNNING', lockedAt: now, lockedBy: workerId, attempts: { increment: 1 } } });
    return tx.job.findMany({ where: { id: { in: ids } } });
  });
}

export async function runJob(job: Job): Promise<void> {
  const handler = handlers.get(job.type);
  if (!handler) {
    await prisma.job.update({ where: { id: job.id }, data: { status: 'FAILED', lastError: `No handler for ${job.type}` } });
    return;
  }
  try {
    await handler(job);
    await prisma.job.update({ where: { id: job.id }, data: { status: 'DONE', completedAt: new Date(), lockedAt: null, lockedBy: null } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, job: job.id, type: job.type }, 'job failed');
    const failed = job.attempts >= MAX_ATTEMPTS;
    await prisma.job.update({
      where: { id: job.id },
      data: failed
        ? { status: 'FAILED', lastError: msg, lockedAt: null, lockedBy: null }
        : { status: 'PENDING', lastError: msg, lockedAt: null, lockedBy: null, runAt: new Date(Date.now() + 60_000 * job.attempts) },
    });
  }
}

export async function runDueJobsOnce(workerId: string, now = new Date()): Promise<number> {
  const jobs = await claimDueJobs(workerId, 20, now);
  for (const j of jobs) await runJob(j);
  return jobs.length;
}

/** Jobs stuck RUNNING (crashed worker) go back to PENDING after 10 minutes. */
export async function recoverStuckJobs(): Promise<void> {
  await prisma.job.updateMany({
    where: { status: 'RUNNING', lockedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    data: { status: 'PENDING', lockedAt: null, lockedBy: null },
  });
}
