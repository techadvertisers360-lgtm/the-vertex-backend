import webpush, { WebPushError } from 'web-push';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { notifyUsers } from '../../src/services/notifications';
import { drainPush, pushContent, relayPush, setPushSender } from '../../src/services/push';
import { agentFor, call, makeUser, prisma, uid } from './helpers';

/** D-046 — Web Push: device subscriptions, relay from the outbox after commit, privacy of lock-screen text. */

const keys = webpush.generateVAPIDKeys();
const saved = { ...env };
let sent: { endpoint: string; payload: { title: string; body: string; url: string; tag: string; urgent: boolean }; urgency?: string }[] = [];
let failWith: Record<string, number> = {};

const sub = (tag = uid()) => ({ endpoint: `https://push.example.test/send/${tag}`, keys: { p256dh: 'BPk' + 'x'.repeat(84), auth: 'auth-secret-1234' } });

beforeAll(() => {
  setPushSender(async (s, body, opts) => {
    if (failWith[s.endpoint]) throw new WebPushError('push failed', failWith[s.endpoint]!, {}, '', s.endpoint);
    sent.push({ endpoint: s.endpoint, payload: JSON.parse(body), urgency: opts.urgency });
  });
});
afterAll(() => setPushSender(null));
beforeEach(async () => {
  Object.assign(env, { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:dev@vertex.test' });
  sent = [];
  failWith = {};
  // earlier tests' outbox rows must not be pushed here
  await prisma.realtimeEvent.updateMany({ where: { pushedAt: null }, data: { pushedAt: new Date() } });
});
afterEach(() => {
  Object.assign(env, saved);
});

describe('D-046 — this device: subscribe, several devices, remove, test', () => {
  it('stores one row per device, moves a device to whoever signs in on it, removes on request', async () => {
    const a = await agentFor('RECEPTIONIST');
    const b = await agentFor('DOCTOR');
    const api = call(a.agent);
    const cfg = await api.get('/api/push/config');
    expect(cfg.body).toMatchObject({ enabled: true, publicKey: keys.publicKey, devices: 0 });
    expect(JSON.stringify(cfg.body)).not.toContain(keys.privateKey);

    const phone = sub('phone');
    const laptop = sub('laptop');
    expect((await api.post('/api/push/subscriptions', { subscription: phone, userAgent: 'iPhone' })).body).toEqual({ ok: true, devices: 1 });
    expect((await api.post('/api/push/subscriptions', { subscription: laptop })).body.devices).toBe(2);
    expect((await api.post('/api/push/subscriptions', { subscription: phone })).body.devices).toBe(2); // same device again
    // the doctor signs in on the same phone: the device now belongs to the doctor
    await call(b.agent).post('/api/push/subscriptions', { subscription: phone });
    expect(await prisma.pushSubscription.count({ where: { userId: a.user.id } })).toBe(1);

    const test = await api.post('/api/push/test');
    expect(test.body).toMatchObject({ sent: 1, devices: 1 });
    expect(sent[0]).toMatchObject({ endpoint: laptop.endpoint, payload: { title: 'The Vertex Health — test' } });

    expect((await api.post('/api/push/subscriptions/remove', { endpoint: laptop.endpoint })).body).toEqual({ ok: true, removed: 1, devices: 0 });
    // someone else's device cannot be removed
    expect((await api.post('/api/push/subscriptions/remove', { endpoint: phone.endpoint })).body.removed).toBe(0);
    expect((await api.post('/api/push/subscriptions', { subscription: { ...sub(), endpoint: 'http://insecure.test/x' } })).status).toBe(422);
  });

  it('without VAPID keys push is off and subscribing is refused; in-app notifications are unaffected', async () => {
    Object.assign(env, { VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined, VAPID_SUBJECT: undefined });
    const api = call((await agentFor('MANAGER')).agent);
    expect((await api.get('/api/push/config')).body).toMatchObject({ enabled: false, publicKey: null });
    expect((await api.post('/api/push/subscriptions', { subscription: sub() })).status).toBe(422);
    expect(await relayPush()).toBe(0);
  });
});

describe('D-046 — every notification is pushed once, after commit, with the exact record to open', () => {
  it('pushes to all of the recipient’s devices; urgent ones are high urgency; never twice', async () => {
    const doc = await makeUser('DOCTOR');
    await prisma.pushSubscription.createMany({
      data: ['d1', 'd2'].map((t) => ({ userId: doc.id, endpointHash: `${t}${uid()}`.padEnd(64, '0').slice(0, 64), endpoint: `https://push.example.test/${t}/${uid()}`, p256dh: 'p', auth: 'a' })),
    });
    await prisma.$transaction((tx) =>
      notifyUsers(tx, [doc.id], { type: 'PATIENT_WAITING', subject: 'Patient waiting: Sana Malik', body: 'Arrived 10:42 AM · appointment 10:30 AM', recordType: 'Appointment', recordId: 'appt-1', priority: 2 }),
    );
    const note = await prisma.notification.findFirstOrThrow({ where: { recipientId: doc.id, type: 'PATIENT_WAITING' } });

    expect(await drainPush()).toBeGreaterThanOrEqual(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.payload).toEqual({ title: 'Patient waiting: Sana Malik', body: 'Arrived 10:42 AM · appointment 10:30 AM', url: `/n/${note.id}`, tag: `n:${note.id}`, urgent: true });
    expect(sent[0]!.urgency).toBe('high');
    expect(await relayPush()).toBe(0);
    expect(sent).toHaveLength(2);

    // a rolled-back business change pushes nothing
    await prisma
      .$transaction(async (tx) => {
        await notifyUsers(tx, [doc.id], { type: 'PATIENT_WAITING', subject: 'Rolled back', recordType: 'Appointment', recordId: 'x' });
        throw new Error('rollback');
      })
      .catch(() => undefined);
    await drainPush();
    expect(sent.some((s) => s.payload.title === 'Rolled back')).toBe(false);
  });

  it('dead devices are removed; disabled users get nothing; stale rows are not pushed late', async () => {
    const u = await makeUser('MANAGER');
    const dead = `https://push.example.test/dead/${uid()}`;
    const ok = `https://push.example.test/ok/${uid()}`;
    for (const endpoint of [dead, ok]) await prisma.pushSubscription.create({ data: { userId: u.id, endpointHash: uid().padEnd(64, '0').slice(0, 64), endpoint, p256dh: 'p', auth: 'a' } });
    failWith[dead] = 410;
    await prisma.$transaction((tx) => notifyUsers(tx, [u.id], { type: 'SLA_CONSENT', subject: 'Consent pending: Ali', body: 'Assistant — 12 min se consent upload nahi hua.', recordType: 'ProcedureTask', recordId: 't1', priority: 2 }));
    await drainPush();
    expect(sent.map((s) => s.endpoint)).toEqual([ok]);
    expect(await prisma.pushSubscription.count({ where: { userId: u.id } })).toBe(1);

    const off = await makeUser('ASSISTANT', { active: false });
    await prisma.pushSubscription.create({ data: { userId: off.id, endpointHash: uid().padEnd(64, '0').slice(0, 64), endpoint: `https://push.example.test/off/${uid()}`, p256dh: 'p', auth: 'a' } });
    await prisma.$transaction((tx) => notifyUsers(tx, [off.id], { type: 'ROOM_ASSIGNED', subject: 'Room 2 assign hua' }));
    sent = [];
    await drainPush();
    expect(sent).toHaveLength(0);

    await prisma.$transaction((tx) => notifyUsers(tx, [u.id], { type: 'ROOM_ISSUE', subject: 'Old one' }));
    await prisma.realtimeEvent.updateMany({ where: { pushedAt: null }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    await drainPush();
    expect(sent).toHaveLength(0);
  });

  it('the tap target: GET /notifications/:id returns my notification only', async () => {
    const a = await agentFor('RECEPTIONIST');
    const other = await makeUser('RECEPTIONIST');
    await prisma.$transaction((tx) => notifyUsers(tx, [a.user.id, other.id], { type: 'ROOM_ISSUE', subject: 'Room 3', recordType: 'RoomChecklistReport', recordId: 'r-1' }));
    const mine = await prisma.notification.findFirstOrThrow({ where: { recipientId: a.user.id, subject: 'Room 3' } });
    const theirs = await prisma.notification.findFirstOrThrow({ where: { recipientId: other.id, subject: 'Room 3' } });
    const api = call(a.agent);
    expect((await api.get(`/api/notifications/${mine.id}`)).body).toMatchObject({ id: mine.id, recordType: 'RoomChecklistReport', recordId: 'r-1' });
    expect((await api.get(`/api/notifications/${theirs.id}`)).status).toBe(404);
  });
});

describe('D-046 — lock-screen text never carries clinical details', () => {
  it('patient notifications show only name / time / room; complaint text is replaced', () => {
    const base = { id: 'n1', priority: 0 };
    expect(pushContent({ ...base, type: 'PROCEDURE_REMINDER', subject: '2 din baad procedure: Sana', body: 'Laser hair removal · session 3 · Room 2', recordType: 'UpcomingProcedure' }).body).toBe('Kholne ke liye tap karein');
    expect(pushContent({ ...base, type: 'PATIENT_DONE', subject: 'Patient done: Sana', body: 'Aftercare / medication guidance bhejein', recordType: 'Appointment' }).body).toBe('Kholne ke liye tap karein');
    expect(pushContent({ ...base, type: 'PATIENT_COMPLAINT', subject: 'Complaint: burn after laser', body: 'skin reaction', recordType: 'Complaint' })).toMatchObject({ title: 'Patient complaint', body: 'Kholne ke liye tap karein' });
    expect(pushContent({ ...base, type: 'COMPLAINT_ESCALATED', subject: 'Escalation: allergic reaction', body: 'x', recordType: 'Complaint' }).title).toBe('Complaint escalation');
    expect(pushContent({ ...base, type: 'PATIENT_WAITING', subject: 'Patient waiting: Sana', body: 'Arrived 10:42 AM · appointment 10:30 AM', recordType: 'Appointment' }).body).toContain('10:42');
    // non-patient notices keep their text
    expect(pushContent({ ...base, type: 'STOCK_DEMAND_MD', subject: 'Demand approval: Rs 25,000', body: 'Gloves, masks', recordType: 'StockDemand', priority: 2 })).toMatchObject({ body: 'Gloves, masks', urgent: true });
  });
});
