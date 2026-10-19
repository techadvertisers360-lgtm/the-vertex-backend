import type { Request, Response } from 'express';

/**
 * Vercel serverless entry (D-042): the Express app without listen() or Socket.IO. vercel.json rewrites every path
 * here. Live updates go through Supabase Realtime (REALTIME_PROVIDER=supabase); the worker cycle runs via
 * /api/cron/tick. Locally `npm run dev` (src/server.ts) still serves REST + Socket.IO.
 *
 * If the app cannot start (usually a missing / invalid environment variable), every URL answers a JSON 500 that
 * names the variables to fix — names and rules only, never values — instead of Vercel's bare
 * FUNCTION_INVOCATION_FAILED. The full error is in the Vercel function logs.
 */
type Handler = (req: Request, res: Response) => unknown;

function startupFailure(err: unknown): Handler {
  console.error('Vertex Health API failed to start:', err);
  const env = err instanceof Error && 'problems' in err ? (err as Error & { problems: Record<string, string[]> }).problems : null;
  const body = {
    status: 'error',
    service: 'Vertex Health API',
    error: env ? 'Invalid environment variables — fix them in Vercel → Settings → Environment Variables, then redeploy' : 'Startup failed — see the Vercel function logs',
    ...(env ? { variables: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.join('; ')])) } : {}),
    time: new Date().toISOString(),
  };
  const json = JSON.stringify(body);
  return (_req, res) => {
    // Plain Node response API: works whatever helpers the host adds.
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(json);
  };
}

let handler: Handler;
try {
  // Loaded inside try so a configuration error becomes a readable response instead of a crashed function.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createApp } = require('../src/app') as typeof import('../src/app');
  handler = createApp();
} catch (err) {
  handler = startupFailure(err);
}

export default handler;
