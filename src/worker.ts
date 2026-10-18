import cron from 'node-cron';
import { env } from './config/env';
import { logger } from './lib/misc';
import { prisma } from './lib/prisma';
import { recoverStuckMessages, runOutboxOnce } from './jobs/outbox';
import { recoverStuckJobs, runDueJobsOnce } from './jobs/runner';
import { registerAllJobs, runWatchersOnce } from './jobs/index';
import { runSheetSync } from './modules/leadSync/service';

/**
 * Background worker (separate process: `npm run worker`). Runs whether or not any browser is open (spec §23, §27).
 * Every unit of work is idempotency-keyed, so overlapping ticks or multiple workers are safe.
 */
registerAllJobs();

let busy = false;
async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await runWatchersOnce(new Date());
    while ((await runDueJobsOnce(env.WORKER_ID)) > 0);
    while ((await runOutboxOnce(env.WORKER_ID)) > 0);
  } catch (err) {
    logger.error({ err }, 'worker tick failed');
  } finally {
    busy = false;
  }
}

cron.schedule('*/15 * * * * *', () => void tick(), { timezone: env.APP_TIMEZONE });
// Google Sheets lead sync runs on its own loop so slow Google calls never delay the watchers above (D-039).
let syncing = false;
async function sheetTick(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    await runSheetSync(new Date(), env.WORKER_ID);
  } catch (err) {
    logger.error({ err }, 'sheet sync tick failed');
  } finally {
    syncing = false;
  }
}
cron.schedule('*/30 * * * * *', () => void sheetTick(), { timezone: env.APP_TIMEZONE });

cron.schedule('*/5 * * * *', () => {
  void recoverStuckJobs();
  void recoverStuckMessages();
}, { timezone: env.APP_TIMEZONE });

logger.info({ workerId: env.WORKER_ID, tz: env.APP_TIMEZONE }, 'Vertex Health worker started');
void tick();

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
