import { Router, type Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { NotFoundError, UnauthorizedError } from '../../lib/errors';
import { logger } from '../../lib/misc';
import { prisma } from '../../lib/prisma';
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
  if (result.jobs || result.messages || result.sheetsSynced || result.realtime || result.pushed) logger.info(result, 'cron tick');
  res.json({ ok: true, ...result });
}
/**
 * Deployment diagnostics (CRON_SECRET-protected): which settings are present (names / booleans only), and whether
 * the database answers — with Prisma's error code and message when it does not (connection strings stripped).
 */
cronRouter.get('/health', async (req, res) => {
  if (!env.CRON_SECRET) throw new NotFoundError('Endpoint');
  if (!sameSecret(secretFrom(req), env.CRON_SECRET)) throw new UnauthorizedError('Invalid cron secret', 'CRON_UNAUTHORIZED');
  const url = process.env.DATABASE_URL ?? '';
  const started = Date.now();
  let db: { ok: boolean; ms: number; code?: string; error?: string };
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = { ok: true, ms: Date.now() - started };
  } catch (err) {
    const e = err as { code?: string; errorCode?: string; message?: string };
    const message = String(e.message ?? err)
      .replace(/mysql:\/\/\S+/g, 'mysql://***')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' | ')
      .slice(0, 500);
    db = { ok: false, ms: Date.now() - started, code: e.code ?? e.errorCode, error: message };
  }
  res.json({
    ok: db.ok,
    db,
    database: {
      host: (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return 'unparseable DATABASE_URL';
        }
      })(),
      caFromEnv: !!process.env.DATABASE_CA_CERT,
      caLooksLikePem: (process.env.DATABASE_CA_CERT ?? '').includes('BEGIN CERTIFICATE'),
      urlHasSslcertPath: /[?&]sslcert=/.test(url),
      urlHasSslaccept: /[?&]sslaccept=/.test(url),
    },
    settings: Object.fromEntries(
      ['JWT_ACCESS_SECRET', 'FRONTEND_ORIGIN', 'PUBLIC_APP_URL', 'COOKIE_SECURE', 'TRUST_PROXY', 'REALTIME_PROVIDER', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_JWT_SECRET', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'UPLOADTHING_TOKEN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'].map((k) => [k, !!process.env[k]]),
    ),
    realtime: env.REALTIME_PROVIDER,
    node: process.version,
    region: process.env.VERCEL_REGION ?? null,
    time: new Date().toISOString(),
  });
});
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
