import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import type { RealtimeTransport, RelayEvent } from './relay';

/**
 * Supabase Realtime Broadcast transport for serverless hosting (D-042). The database stays on MySQL; Supabase only
 * carries live events. Every user has one PRIVATE channel `user:<id>`; role rooms are fanned out to the channels
 * of the role's active users. Messages are sent with the server-only secret key over the Broadcast REST API.
 * Clients join only with a short-lived JWT from GET /api/realtime/token, and a Supabase RLS policy on
 * realtime.messages allows a token to read `user:<its own sub>` only (docs/VERCEL_SUPABASE_SETUP.md).
 */
export const userTopic = (userId: string) => `user:${userId}`;

type Fetch = typeof fetch;

export function supabaseTransport(opts: { url?: string; secretKey?: string; fetchImpl?: Fetch } = {}): RealtimeTransport {
  const url = (opts.url ?? env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const key = opts.secretKey ?? env.SUPABASE_SECRET_KEY ?? '';
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name: 'supabase',
    async send(events: RelayEvent[]) {
      if (!url || !key) throw new Error('Supabase Realtime is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY)');
      const roles = [...new Set(events.filter((e) => e.room.startsWith('role:')).map((e) => e.room.slice(5)))] as Role[];
      const members = roles.length ? await prisma.user.findMany({ where: { role: { in: roles }, active: true }, select: { id: true, role: true } }) : [];
      const messages = events.flatMap((e) => {
        const topics = e.room.startsWith('user:') ? [e.room] : e.room.startsWith('role:') ? members.filter((m) => m.role === e.room.slice(5)).map((m) => userTopic(m.id)) : [];
        return topics.map((topic) => ({ topic, event: e.event, payload: e.payload ?? {}, private: true }));
      });
      for (let i = 0; i < messages.length; i += 100) {
        const res = await doFetch(`${url}/realtime/v1/api/broadcast`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: key, ...(key.split('.').length === 3 ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ messages: messages.slice(i, i + 100) }),
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error(`Supabase broadcast failed: HTTP ${res.status}`);
      }
    },
  };
}

/**
 * Short-lived token for the browser to join its own private channel. Signed with the project's JWT secret,
 * `sub` = our user id, role `authenticated` (required for RLS), expires after REALTIME_TOKEN_TTL_SEC.
 */
export function issueRealtimeToken(userId: string, now = Date.now()) {
  if (!env.SUPABASE_JWT_SECRET) throw new Error('SUPABASE_JWT_SECRET is not configured');
  const iat = Math.floor(now / 1000);
  const exp = iat + env.REALTIME_TOKEN_TTL_SEC;
  const token = jwt.sign({ sub: userId, role: 'authenticated', aud: 'authenticated', iat, exp }, env.SUPABASE_JWT_SECRET, { algorithm: 'HS256' });
  return { token, topic: userTopic(userId), expiresAt: new Date(exp * 1000).toISOString() };
}
