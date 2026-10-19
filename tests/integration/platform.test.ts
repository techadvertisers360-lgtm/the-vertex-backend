import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { normalizePhone } from '../../src/lib/phone';
import { enqueueMessage } from '../../src/services/messaging';
import { publish, roleRoom, userRoom } from '../../src/services/realtime';
import { relayPending } from '../../src/realtime/relay';
import { supabaseTransport } from '../../src/realtime/supabase';
import { agentFor, app, call, makeUser, prisma, uid, uniquePhone } from './helpers';

/** D-042 — serverless mode: Supabase broadcast relay, per-user realtime token, CRON_SECRET-protected worker tick. */

const saved = { ...env };
afterEach(() => {
  Object.assign(env, saved);
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { messages: { topic: string; event: string; payload: unknown; private: boolean }[] };
}

/** Fake Supabase Broadcast endpoint. */
function fakeSupabase(status = 202) {
  const calls: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function clearBacklog() {
  await prisma.realtimeEvent.updateMany({ where: { deliveredAt: null }, data: { deliveredAt: new Date() } });
}

describe('D-042 — Supabase Realtime Broadcast relay', () => {
  beforeAll(clearBacklog);

  it('sends each committed event once to private per-user topics; role rooms fan out to active users of the role', async () => {
    await clearBacklog();
    const a = await makeUser('RECEPTIONIST');
    const b = await makeUser('RECEPTIONIST');
    const off = await makeUser('RECEPTIONIST', { active: false });
    const doc = await makeUser('DOCTOR');
    await prisma.$transaction(async (tx) => {
      await publish(tx, [userRoom(doc.id)], 'queue:changed', { x: 1 });
      await publish(tx, [roleRoom('RECEPTIONIST')], 'tracker:changed', {});
    });
    const f = fakeSupabase();
    const t = supabaseTransport({ url: 'https://proj.supabase.co/', secretKey: 'sb_secret_test', fetchImpl: f.fetchImpl });
    expect(await relayPending(t)).toBe(2);
    expect(f.calls[0]!.url).toBe('https://proj.supabase.co/realtime/v1/api/broadcast');
    expect(f.calls[0]!.headers.apikey).toBe('sb_secret_test');
    const msgs = f.calls.flatMap((c) => c.body.messages);
    expect(msgs.every((m) => m.private === true)).toBe(true);
    expect(msgs).toContainEqual({ topic: `user:${doc.id}`, event: 'queue:changed', payload: { x: 1 }, private: true });
    const trackerTopics = msgs.filter((m) => m.event === 'tracker:changed').map((m) => m.topic);
    expect(trackerTopics).toEqual(expect.arrayContaining([`user:${a.id}`, `user:${b.id}`]));
    expect(trackerTopics).not.toContain(`user:${off.id}`);
    expect(msgs.some((m) => m.topic.startsWith('role:'))).toBe(false);
    expect(await relayPending(t)).toBe(0); // already delivered
  });

  it('a failed send keeps events queued for the next relay; parallel relays never double-send', async () => {
    await clearBacklog();
    const u = await makeUser('MANAGER');
    await prisma.$transaction((tx) => publish(tx, [userRoom(u.id)], 'notification:new', { id: 'n1' }));
    const down = fakeSupabase(503);
    await expect(relayPending(supabaseTransport({ url: 'https://p.supabase.co', secretKey: 'k', fetchImpl: down.fetchImpl }))).rejects.toThrow(/503/);
    expect(await prisma.realtimeEvent.count({ where: { room: userRoom(u.id), deliveredAt: null } })).toBe(1);

    for (let i = 0; i < 30; i++) await prisma.$transaction((tx) => publish(tx, [userRoom(u.id)], 'queue:changed', { i }));
    const up = fakeSupabase();
    const t = supabaseTransport({ url: 'https://p.supabase.co', secretKey: 'k', fetchImpl: up.fetchImpl });
    const counts = await Promise.all([relayPending(t, 10), relayPending(t, 10), relayPending(t, 10), relayPending(t, 10)]);
    let rest = 0;
    for (let n = 1; n; ) {
      n = await relayPending(t, 10);
      rest += n;
    }
    expect(counts.reduce((x, y) => x + y, 0) + rest).toBe(31);
    const sent = up.calls.flatMap((c) => c.body.messages).filter((m) => m.topic === `user:${u.id}`);
    expect(sent).toHaveLength(31);
    expect(new Set(sent.map((m) => JSON.stringify(m.payload))).size).toBe(31);
  });
});

describe('D-042 — realtime token: only your own private channel, short-lived, session-checked', () => {
  it('issues a token whose sub is the caller and whose topic is user:<caller>', async () => {
    env.REALTIME_PROVIDER = 'supabase';
    env.SUPABASE_JWT_SECRET = 'test-jwt-secret-test-jwt-secret-0123456789';
    env.REALTIME_TOKEN_TTL_SEC = 300;
    const { user, agent } = await agentFor('LEAD_MEMBER');
    const r = await call(agent).get('/api/realtime/token');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provider: 'supabase', topic: `user:${user.id}` });
    const claims = jwt.verify(r.body.token, env.SUPABASE_JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    expect(claims).toMatchObject({ sub: user.id, role: 'authenticated', aud: 'authenticated' });
    expect(claims.exp! - claims.iat!).toBe(300);
    expect(() => jwt.verify(r.body.token, 'another-secret')).toThrow();

    expect((await request(app).get('/api/realtime/token')).status).toBe(401); // no session
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    expect((await call(agent).get('/api/realtime/token')).status).toBe(401); // disabled → no new token
  });

  it('local mode answers socketio (no token)', async () => {
    const { agent } = await agentFor('DOCTOR');
    expect((await call(agent).get('/api/realtime/token')).body).toEqual({ provider: 'socketio' });
  });
});

describe('D-042 — /api/cron/tick (external scheduler)', () => {
  const SECRET = 'cron-secret-for-tests-0123456789abcdef';

  it('is disabled without CRON_SECRET and refuses a wrong secret', async () => {
    env.CRON_SECRET = undefined;
    expect((await request(app).get('/api/cron/tick')).status).toBe(404);
    env.CRON_SECRET = SECRET;
    expect((await request(app).get('/api/cron/tick')).status).toBe(401);
    expect((await request(app).get('/api/cron/tick').set('authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(app).post('/api/cron/tick').set('x-cron-secret', 'nope')).status).toBe(401);
  });

  it('runs one worker cycle with the right secret (GET or POST); overlapping ticks never send twice', async () => {
    env.CRON_SECRET = SECRET;
    const receptionist = await makeUser('RECEPTIONIST');
    const p = await prisma.patient.create({ data: { name: `Cron ${uid()}`, phone: normalizePhone(uniquePhone())!, createdById: receptionist.id, whatsappConsent: true } });
    const m = await enqueueMessage(prisma, { template: 'visit_thanks', toPhone: p.phone, patientId: p.id, payload: { patientName: p.name }, idempotencyKey: `cron:${uid()}` });
    const [g, q] = await Promise.all([
      request(app).get('/api/cron/tick').set('authorization', `Bearer ${SECRET}`),
      request(app).post('/api/cron/tick').set('x-cron-secret', SECRET),
    ]);
    expect(g.status).toBe(200);
    expect(q.status).toBe(200);
    expect(g.body).toMatchObject({ ok: true, watchers: 'ok' });
    const after = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: m.id } });
    expect(after.status).toBe('DELIVERED');
    expect(after.retryCount).toBe(1); // sent exactly once
    expect(await prisma.auditEvent.count({ where: { action: 'MESSAGE_SENT', recordId: m.id } })).toBe(1);
  }, 120_000);
});
