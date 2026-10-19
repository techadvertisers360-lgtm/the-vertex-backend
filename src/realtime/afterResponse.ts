import type { NextFunction, Request, Response } from 'express';
import { waitUntil } from '@vercel/functions';
import { env } from '../config/env';
import { runTick } from '../jobs/tick';
import { logger } from '../lib/misc';
import { drainPush } from '../services/push';
import { drainRealtime } from './relay';
import { supabaseTransport } from './supabase';

/**
 * Serverless background work (D-042, D-046, D-047). Nothing runs between requests on Vercel, so after a response:
 *  - state-changing requests: deliver pending realtime events to Supabase and Web Push to phones;
 *  - any request, at most once a minute per instance: one worker cycle (lead-sheet sync, reminders, jobs, messages)
 *    — so the app keeps itself up to date while people use it, even without the external cron. The cron tick is
 *    still the guarantee for quiet hours. Every unit of work is claimed (leases / SKIP LOCKED), so instances and the
 *    cron never double up. `waitUntil` keeps the function alive for it; elsewhere it simply runs.
 */
const transport = env.REALTIME_PROVIDER === 'supabase' ? supabaseTransport() : null;

export const AUTO_TICK_EVERY_MS = 60_000;
let lastTick = 0;
let ticking = false;

function background(work: Promise<unknown>, what: string) {
  try {
    waitUntil(work.catch((err) => logger.error({ err }, `${what} failed`)));
  } catch (err) {
    logger.error({ err }, `${what} could not start`);
  }
}

function maybeTick() {
  const now = Date.now();
  if (ticking || now - lastTick < AUTO_TICK_EVERY_MS) return;
  lastTick = now;
  ticking = true;
  background(
    runTick({ workerId: `auto-${process.env.VERCEL_REGION ?? 'local'}-${process.pid}`, budgetMs: 25_000, transport: transport ?? undefined }).finally(() => {
      ticking = false;
    }),
    'auto tick',
  );
}

export function relayAfterResponse(opts: { autoTick: boolean }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        background(Promise.all([transport ? drainRealtime(transport, 8_000) : 0, drainPush(8_000)]), 'post-response relay');
      }
      // The cron endpoint runs its own cycle.
      if (opts.autoTick && !req.path.startsWith('/api/cron')) maybeTick();
    });
    next();
  };
}
