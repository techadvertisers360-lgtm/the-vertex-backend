import { Router, type Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { NotFoundError, UnauthorizedError } from '../../lib/errors';
import { logger } from '../../lib/misc';
import { route } from '../../middleware/route';
import { runTick } from '../../jobs/tick';
import { issueRealtimeToken, supabaseTransport } from '../../realtime/supabase';

/**
 * Platform endpoints for serverless hosting (D-042).
 *  - /api/cron/tick: the worker cycle, called every minute by an external scheduler with the CRON_SECRET.
 *  - /api/realtime/token: short-lived token to join the caller's own private Supabase channel.
 */
export const cronRouter = Router();

function secretFrom(req: Request): string | undefined {
  const auth = req.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.get('x-cron-secret') ?? undefined;
}

/** Constant-time compare (hash both sides so lengths match). */
function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function tick(req: Request, res: import('express').Response) {
  if (!env.CRON_SECRET) throw new NotFoundError('Endpoint');
  if (!sameSecret(secretFrom(req), env.CRON_SECRET)) throw new UnauthorizedError('Invalid cron secret', 'CRON_UNAUTHORIZED');
  const result = await runTick({
    workerId: `cron-${process.env.VERCEL_REGION ?? 'local'}-${process.pid}`,
    budgetMs: 25_000, // fits cron-job.org's 30 s request timeout; leftovers continue next minute
    transport: env.REALTIME_PROVIDER === 'supabase' ? supabaseTransport() : undefined,
  });
  if (result.jobs || result.messages || result.sheetsSynced || result.realtime) logger.info(result, 'cron tick');
  res.json({ ok: true, ...result });
}
cronRouter.get('/tick', tick);
cronRouter.post('/tick', tick);

export const realtimeRouter = Router();
realtimeRouter.get(
  '/token',
  // Every role holds notifications:own; requireAuth has already reloaded the session (active, token version).
  route({ permission: 'notifications:own' }, async ({ actor }) =>
    env.REALTIME_PROVIDER === 'supabase' ? { provider: 'supabase' as const, ...issueRealtimeToken(actor.id!) } : { provider: 'socketio' as const },
  ),
);
