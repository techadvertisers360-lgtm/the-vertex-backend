import { logger } from '../lib/misc';
import { runSheetSync } from '../modules/leadSync/service';
import { drainRealtime, pruneRealtime, type RealtimeTransport } from '../realtime/relay';
import { drainPush } from '../services/push';
import { registerAllJobs, runWatchersOnce } from './index';
import { recoverStuckMessages, runOutboxOnce } from './outbox';
import { recoverStuckJobs, runDueJobsOnce } from './runner';

/**
 * One full worker cycle (D-042), used by the serverless cron endpoint (/api/cron/tick, every minute) — the local
 * `npm run worker` runs the same pieces on its own timers. Everything here is already idempotent and claimed per
 * unit (deterministic keys, SKIP LOCKED, sheet leases), so overlapping ticks or a tick next to a worker are safe.
 * `budgetMs` keeps the cycle inside the host's function time limit; unfinished work continues on the next tick.
 */
export interface TickResult {
  ms: number;
  watchers: 'ok';
  jobs: number;
  messages: number;
  sheetsSynced: number;
  realtime: number;
  pushed: number;
  pruned: number;
  stoppedEarly: boolean;
}

let registered = false;

export async function runTick(opts: { workerId: string; budgetMs?: number; transport?: RealtimeTransport; now?: Date }): Promise<TickResult> {
  if (!registered) {
    registerAllJobs();
    registered = true;
  }
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? 45_000);
  const left = () => deadline - Date.now();
  const r: TickResult = { ms: 0, watchers: 'ok', jobs: 0, messages: 0, sheetsSynced: 0, realtime: 0, pushed: 0, pruned: 0, stoppedEarly: false };

  await recoverStuckJobs();
  await recoverStuckMessages();
  await runWatchersOnce(opts.now ?? new Date());
  for (let n = 1; n > 0 && left() > 5_000; r.jobs += n) n = await runDueJobsOnce(opts.workerId);
  for (let n = 1; n > 0 && left() > 5_000; r.messages += n) n = await runOutboxOnce(opts.workerId);
  if (left() > 15_000) {
    try {
      r.sheetsSynced = await runSheetSync(new Date(), opts.workerId);
    } catch (err) {
      logger.error({ err }, 'sheet sync in tick failed');
    }
  }
  if (opts.transport) r.realtime = await drainRealtime(opts.transport, Math.max(1_000, Math.min(10_000, left())));
  r.pushed = await drainPush(Math.max(1_000, Math.min(8_000, left())));
  r.pruned = await pruneRealtime();
  r.stoppedEarly = left() <= 5_000;
  r.ms = Date.now() - started;
  return r;
}
