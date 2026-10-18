import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { attachRealtime, type RealtimeHandle } from '../../src/realtime/server';
import { notifyUsers } from '../../src/services/notifications';
import { agentFor, app, call, makeUser, prisma, TEST_PASSWORD } from './helpers';

let server: Server;
let rt: RealtimeHandle;
let url: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = createServer(app);
  rt = attachRealtime(server, { relayMs: 100, revalidateMs: 60_000 });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const s of sockets) s.close();
  await rt.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function cookieFor(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').set('x-vh-client', 'web').send({ identifier: email, password: TEST_PASSWORD });
  return ([] as string[]).concat(res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
}

function open(cookie: string): Promise<{ socket: Socket; hello: { unreadCount: number } }> {
  return new Promise((resolve, reject) => {
    const socket = connect(url, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie }, reconnection: false });
    sockets.push(socket);
    socket.on('hello', (hello) => resolve({ socket, hello }));
    socket.on('connect_error', (e) => reject(e));
  });
}

function next<T>(socket: Socket, event: string, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (p: T) => {
      clearTimeout(t);
      resolve(p);
    });
  });
}

describe('Socket.IO realtime (D-024)', () => {
  it('rejects a handshake without a valid session cookie', async () => {
    await expect(open('vh_at=not-a-token')).rejects.toThrow(/UNAUTHENTICATED/);
    await expect(open('')).rejects.toThrow(/UNAUTHENTICATED/);
  });

  it('authenticates with the session cookie and pushes only to the recipient’s own room', async () => {
    const a = await makeUser('MANAGER');
    const b = await makeUser('MANAGER');
    const sa = await open(await cookieFor(a.email!));
    const sb = await open(await cookieFor(b.email!));
    expect(sa.hello.unreadCount).toBe(0);

    let bGot = false;
    sb.socket.on('notification:new', () => (bGot = true));
    const got = next<{ subject: string; urgent: boolean }>(sa.socket, 'notification:new');
    await notifyUsers(prisma, [a.id], { type: 'TEST', subject: 'Staff check-in', priority: 0 });
    const payload = await got;
    expect(payload.subject).toBe('Staff check-in');
    expect(payload.urgent).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect(bGot).toBe(false);

    const urgent = next<{ urgent: boolean }>(sa.socket, 'notification:new');
    await notifyUsers(prisma, [a.id], { type: 'TEST', subject: 'Consent overdue', priority: 2 });
    expect((await urgent).urgent).toBe(true);
  });

  it('events are delivered only after commit (rolled-back transaction emits nothing)', async () => {
    const a = await makeUser('MANAGER');
    const s = await open(await cookieFor(a.email!));
    let count = 0;
    s.socket.on('notification:new', () => (count += 1));
    await prisma
      .$transaction(async (tx) => {
        await notifyUsers(tx, [a.id], { type: 'TEST', subject: 'Should vanish' });
        throw new Error('rollback');
      })
      .catch(() => undefined);
    await notifyUsers(prisma, [a.id], { type: 'TEST', subject: 'Committed' });
    await new Promise((r) => setTimeout(r, 600));
    expect(count).toBe(1);
  });

  it('a deduplicated notification is not pushed twice', async () => {
    const a = await makeUser('MANAGER');
    const s = await open(await cookieFor(a.email!));
    let count = 0;
    s.socket.on('notification:new', () => (count += 1));
    await notifyUsers(prisma, [a.id], { type: 'X', subject: 'Once', dedupeKey: `rt:${a.id}` });
    await notifyUsers(prisma, [a.id], { type: 'X', subject: 'Once', dedupeKey: `rt:${a.id}` });
    await new Promise((r) => setTimeout(r, 600));
    expect(count).toBe(1);
  });

  it('disabling the account drops the live socket immediately', async () => {
    const md = await agentFor('MD');
    const target = await makeUser('RECEPTIONIST');
    const s = await open(await cookieFor(target.email!));
    const revoked = next(s.socket, 'session:revoked');
    const disconnected = next(s.socket, 'disconnect');
    await call(md.agent).patch(`/api/users/${target.id}`, { active: false });
    await revoked;
    await disconnected;
    // and cannot reconnect
    await expect(open(await cookieFor(target.email!).catch(() => ''))).rejects.toThrow();
  });

  it('periodic re-validation drops sockets whose session was revoked (e.g. logout elsewhere)', async () => {
    const u = await makeUser('ASSISTANT');
    const s = await open(await cookieFor(u.email!));
    await prisma.session.updateMany({ where: { userId: u.id }, data: { revokedAt: new Date() } });
    const disconnected = next(s.socket, 'disconnect');
    expect(await rt.revalidateOnce()).toBeGreaterThanOrEqual(1);
    await disconnected;
  });
});

describe('MD leave (D-021, clinic-confirmed)', () => {
  it('needs no approval and informs the Manager and Hamza Zafar', async () => {
    const md = await agentFor('MD');
    await makeUser('MANAGER');
    await makeUser('MARKETING_DIRECTOR');
    const start = new Date(Date.now() + 86400_000);
    const res = await call(md.agent).post('/api/requests/leave', { kind: 'LEAVE', startAt: start.toISOString(), endAt: new Date(start.getTime() + 8 * 3600_000).toISOString(), reason: 'Conference' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('APPROVED');
    const informed = await prisma.notification.findMany({ where: { recordId: res.body.id, type: 'LEAVE_INFO' }, select: { recipientId: true } });
    const roles = await prisma.user.findMany({ where: { id: { in: informed.map((n) => n.recipientId) } }, select: { role: true } });
    expect(new Set(roles.map((r) => r.role))).toEqual(new Set(['MANAGER', 'MARKETING_DIRECTOR']));
  });

  it('Hamza Zafar and Muaz Tahir leave is approved by the MD', async () => {
    for (const role of ['MARKETING_DIRECTOR', 'MARKETING_LEAD'] as const) {
      const u = await agentFor(role);
      const start = new Date(Date.now() + 86400_000);
      const res = await call(u.agent).post('/api/requests/leave', { kind: 'EARLY_LEAVE', startAt: start.toISOString(), endAt: new Date(start.getTime() + 3600_000).toISOString(), reason: 'Appointment' });
      expect(res.body.approverRole).toBe('MD');
      expect(res.body.status).toBe('PENDING');
    }
  });
});
