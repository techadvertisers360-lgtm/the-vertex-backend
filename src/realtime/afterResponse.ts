import type { NextFunction, Request, Response } from 'express';
import { waitUntil } from '@vercel/functions';
import { logger } from '../lib/misc';
import { env } from '../config/env';
import { drainPush } from '../services/push';
import { drainRealtime } from './relay';
import { supabaseTransport } from './supabase';

/**
 * Serverless relay trigger (D-042): after a state-changing request has been answered (its transaction committed),
 * deliver pending realtime events to Supabase and Web Push to phones (D-046). `waitUntil` keeps the function alive for this background work on
 * Vercel; elsewhere it simply runs. Anything missed is delivered by the next request or the cron tick.
 */
const transport = env.REALTIME_PROVIDER === 'supabase' ? supabaseTransport() : null;

export function relayAfterResponse(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    res.on('finish', () => {
      try {
        const work = Promise.all([transport ? drainRealtime(transport, 8_000) : 0, drainPush(8_000)]);
        waitUntil(work.catch((err) => logger.error({ err }, 'post-response relay failed')));
      } catch (err) {
        logger.error({ err }, 'post-response relay could not start');
      }
    });
  }
  next();
}
