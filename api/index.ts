import { createApp } from '../src/app';

/**
 * Vercel serverless entry (D-042): the Express app without listen() or Socket.IO. vercel.json rewrites every path
 * here. Live updates go through Supabase Realtime (REALTIME_PROVIDER=supabase); the worker cycle runs via
 * /api/cron/tick. Locally `npm run dev` (src/server.ts) still serves REST + Socket.IO.
 */
export default createApp();
