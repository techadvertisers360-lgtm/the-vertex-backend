import { describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import { z } from 'zod';
import { route } from '../../src/middleware/route';
import { errorHandler } from '../../src/middleware/error';
import { agentFor, app, call, lastAudit, loginAs, makeUser, newKey, prisma, TEST_PASSWORD } from './helpers';
import { sha256 } from '../../src/lib/misc';
import { notifyUsers } from '../../src/services/notifications';

describe('liveness', () => {
  it('GET / says the API is running (no auth, no data); /health still answers', async () => {
    const root = await request(app).get('/');
    expect(root.status).toBe(200);
    expect(root.body).toMatchObject({ status: 'ok', service: 'Vertex Health API' });
    expect(Math.abs(Date.parse(root.body.time) - Date.now())).toBeLessThan(60_000);
    expect(Object.keys(root.body).sort()).toEqual(['service', 'status', 'time']);
    expect((await request(app).get('/health')).body).toEqual({ ok: true });
  });
});

describe('auth & sessions (spec §2)', () => {
  it('login sets httpOnly cookies and /me returns role-specific nav from the server', async () => {
    const user = await makeUser('RECEPTIONIST');
    const res = await request(app).post('/api/auth/login').set('x-vh-client', 'web').send({ identifier: user.email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookies.some((c) => c.startsWith('vh_at=') && /HttpOnly/i.test(c))).toBe(true);
    expect(cookies.some((c) => c.startsWith('vh_rt=') && /HttpOnly/i.test(c) && /Path=\/api\/auth/i.test(c))).toBe(true);
    expect(res.body.home).toBe('/reception');
    expect(res.body.nav.map((n: { key: string }) => n.key)).toContain('billing');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('wrong password → 401 and LOGIN_FAILED audit', async () => {
    const user = await makeUser('ASSISTANT');
    const res = await request(app).post('/api/auth/login').set('x-vh-client', 'web').send({ identifier: user.email, password: 'nope-nope-1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await lastAudit('LOGIN_FAILED', user.id))?.actorId).toBe(user.id);
  });

  it('role change applies on the very next API request', async () => {
    const md = await agentFor('MD');
    const target = await makeUser('RECEPTIONIST');
    const t = await loginAs(target.email!);
    expect((await call(t).get('/api/me')).status).toBe(200);
    const r = await call(md.agent).patch(`/api/users/${target.id}`, { role: 'ASSISTANT' });
    expect(r.status).toBe(200);
    const after = await call(t).get('/api/me');
    expect(after.status).toBe(401); // old session invalidated; must sign in again
    const again = await loginAs(target.email!);
    expect((await call(again).get('/api/me')).body.user.role).toBe('ASSISTANT');
  });

  it('disabled account is rejected on the next request with a clear message', async () => {
    const md = await agentFor('MD');
    const target = await makeUser('OFFICE_BOY');
    const t = await loginAs(target.email!);
    await call(md.agent).patch(`/api/users/${target.id}`, { active: false });
    const res = await call(t).get('/api/me');
    expect(res.status).toBe(401);
    const login = await request(app).post('/api/auth/login').set('x-vh-client', 'web').send({ identifier: target.email, password: TEST_PASSWORD });
    expect(login.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('refresh rotates the token; replaying an old refresh token revokes all sessions', async () => {
    const user = await makeUser('MANAGER');
    const agent = await loginAs(user.email!);
    const first = await call(agent).post('/api/auth/refresh');
    expect(first.status).toBe(200);
    const sessions = await prisma.session.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.revokedAt).not.toBeNull();

    // Steal-and-replay simulation: present the original (rotated) refresh token.
    const stolen = `replayed-token-${newKey()}`;
    await prisma.session.update({ where: { id: sessions[0]!.id }, data: { refreshTokenHash: sha256(stolen) } });
    const replay = await request(app).post('/api/auth/refresh').set('x-vh-client', 'web').set('Cookie', `vh_rt=${stolen}`);
    expect(replay.status).toBe(401);
    const active = await prisma.session.count({ where: { userId: user.id, revokedAt: null } });
    expect(active).toBe(0);
  });

  it('D-044: self-service password reset is off — forgot / reset refuse and send nothing', async () => {
    const user = await makeUser('DOCTOR');
    await prisma.user.update({ where: { id: user.id }, data: { phone: '92300' + String(Date.now()).slice(-7) } });
    const forgot = await request(app).post('/api/auth/forgot').set('x-vh-client', 'web').send({ identifier: user.email });
    expect(forgot.status).toBe(403);
    expect(forgot.body.error.code).toBe('PASSWORD_ADMIN_ONLY');
    expect(await prisma.messageOutbox.count({ where: { recipientUserId: user.id, template: 'password_reset' } })).toBe(0);
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
    const reset = await request(app).post('/api/auth/reset').set('x-vh-client', 'web').send({ token: 'x'.repeat(40), password: 'NewPass123' });
    expect(reset.status).toBe(403);
    await loginAs(user.email!); // the given password still works
  });

  it('state-changing requests without the client header are rejected (CSRF guard)', async () => {
    const { agent } = await agentFor('MANAGER');
    const res = await agent.post('/api/notifications/read-all');
    expect(res.body.error.code).toBe('CSRF_HEADER_MISSING');
  });
});

describe('RBAC + authorization audit (spec §4, §22)', () => {
  it('endpoint permission denial returns 403 and writes AUTHZ_DENIED', async () => {
    const { user, agent } = await agentFor('OFFICE_BOY');
    const res = await call(agent).get('/api/settings');
    expect(res.status).toBe(403);
    const ev = await prisma.auditEvent.findFirst({ where: { action: 'AUTHZ_DENIED', actorId: user.id }, orderBy: { id: 'desc' } });
    expect(ev).not.toBeNull();
  });

  it('only Hamza Zafar / MD may create Lead members; Manager cannot', async () => {
    const mgr = await agentFor('MANAGER');
    const hamza = await agentFor('MARKETING_DIRECTOR');
    const body = { displayName: 'New Lead', role: 'LEAD_MEMBER', memberCode: `LM-${Date.now() % 100000}`, password: 'Lead12345' };
    expect((await call(mgr.agent).post('/api/users', body)).status).toBe(403);
    const ok = await call(hamza.agent).post('/api/users', body);
    expect(ok.status).toBe(201);
    expect(await prisma.leadMemberProfile.count({ where: { userId: ok.body.id } })).toBe(1);
    // Hamza cannot create clinical staff
    expect((await call(hamza.agent).post('/api/users', { ...body, role: 'DOCTOR', memberCode: undefined, email: `d${Date.now()}@x.test` })).status).toBe(403);
  });

  it('Manager cannot create MD or change own role', async () => {
    const mgr = await agentFor('MANAGER');
    expect((await call(mgr.agent).post('/api/users', { displayName: 'Xavier MD', role: 'MD', email: `md${Date.now()}@x.test`, password: 'Abcd12345' })).status).toBe(403);
    expect((await call(mgr.agent).patch(`/api/users/${mgr.user.id}`, { role: 'MD' })).status).toBe(403);
  });
});

describe('audit is append-only (spec §22)', () => {
  it('DB rejects UPDATE and DELETE on audit_events', async () => {
    const ev = await prisma.auditEvent.create({ data: { action: 'TEST', recordType: 'Test' } });
    await expect(prisma.auditEvent.update({ where: { id: ev.id }, data: { action: 'HACKED' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.delete({ where: { id: ev.id } })).rejects.toThrow(/append-only/);
  });

  it('DB rejects hard-deleting patients', async () => {
    const creator = await makeUser('RECEPTIONIST');
    const p = await prisma.patient.create({ data: { name: 'Del Test', phone: '92' + String(Date.now()).slice(-10), createdById: creator.id } });
    await expect(prisma.patient.delete({ where: { id: p.id } })).rejects.toThrow(/cannot be deleted/);
  });
});

describe('notifications (spec §3, §22)', () => {
  it('read filter is applied in the query; mark-read removes from unread but keeps history', async () => {
    const { user, agent } = await agentFor('MANAGER');
    await notifyUsers(prisma, [user.id], { type: 'TEST', subject: 'One' });
    await notifyUsers(prisma, [user.id], { type: 'TEST', subject: 'Two' });
    const unread = await call(agent).get('/api/notifications?filter=unread');
    expect(unread.body.items).toHaveLength(2);
    expect(unread.body.unreadCount).toBe(2);
    await call(agent).post(`/api/notifications/${unread.body.items[0].id}/read`);
    const after = await call(agent).get('/api/notifications?filter=unread');
    expect(after.body.items).toHaveLength(1);
    expect(after.body.unreadCount).toBe(1);
    const all = await call(agent).get('/api/notifications?filter=all');
    expect(all.body.items).toHaveLength(2);
    const read = await call(agent).get('/api/notifications?filter=read');
    expect(read.body.items.map((n: { subject: string }) => n.subject)).toEqual([unread.body.items[0].subject]);
  });

  it('dedupe key prevents duplicate notifications', async () => {
    const user = await makeUser('MANAGER');
    await notifyUsers(prisma, [user.id], { type: 'X', subject: 'Once', dedupeKey: 'checkin:abc' });
    await notifyUsers(prisma, [user.id], { type: 'X', subject: 'Once', dedupeKey: 'checkin:abc' });
    expect(await prisma.notification.count({ where: { recipientId: user.id } })).toBe(1);
  });

  it("cannot mark another user's notification", async () => {
    const other = await makeUser('MANAGER');
    await notifyUsers(prisma, [other.id], { type: 'X', subject: 'Private' });
    const n = await prisma.notification.findFirstOrThrow({ where: { recipientId: other.id } });
    const { agent } = await agentFor('MANAGER');
    expect((await call(agent).post(`/api/notifications/${n.id}/read`)).status).toBe(404);
  });
});

describe('settings (spec §26)', () => {
  it('Manager can edit a setting; change is validated and audited; confirm clears placeholder flag', async () => {
    const { agent } = await agentFor('MANAGER');
    const bad = await call(agent).put('/api/settings/scheduling.consultDurationMin', { value: 'twenty' });
    expect(bad.status).toBe(422);
    const ok = await call(agent).put('/api/settings/scheduling.consultDurationMin', { value: 25, confirm: true });
    expect(ok.status).toBe(200);
    const list = await call(agent).get('/api/settings');
    const s = list.body.items.find((i: { key: string }) => i.key === 'scheduling.consultDurationMin');
    expect(s.value).toBe(25);
    expect(s.isPlaceholder).toBe(false);
    expect(await lastAudit('SETTING_UPDATED', 'scheduling.consultDurationMin')).not.toBeNull();
    await call(agent).put('/api/settings/scheduling.consultDurationMin', { value: 20 });
  });
});

describe('idempotency middleware (spec §22)', () => {
  it('runs the handler once per key, replays the response, and rejects key reuse with a different body', async () => {
    const user = await makeUser('RECEPTIONIST');
    let executions = 0;
    const probe = express();
    probe.use(express.json());
    probe.use((req, _res, next) => {
      req.user = { id: user.id, role: user.role, displayName: user.displayName, sessionId: 'probe' };
      req.actor = { id: user.id, role: user.role, displayName: user.displayName };
      next();
    });
    probe.post(
      '/pay',
      route({ permission: 'reception:billing', idempotent: true, body: z.object({ amount: z.number() }) }, async ({ body }) => {
        executions += 1;
        return { receipt: `R-${executions}`, amount: body.amount };
      }),
    );
    probe.use(errorHandler);

    const key = newKey();
    const a = await request(probe).post('/pay').set('Idempotency-Key', key).send({ amount: 500 });
    const b = await request(probe).post('/pay').set('Idempotency-Key', key).send({ amount: 500 });
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(executions).toBe(1);

    const c = await request(probe).post('/pay').set('Idempotency-Key', key).send({ amount: 999 });
    expect(c.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const missing = await request(probe).post('/pay').send({ amount: 1 });
    expect(missing.status).toBe(422);
    expect(executions).toBe(1);
  });
});

describe('files (spec §22)', () => {
  it('upload to a procedure task the assistant is not assigned to is denied', async () => {
    const asst = await agentFor('ASSISTANT');
    const other = await makeUser('ASSISTANT');
    const doctor = await makeUser('DOCTOR');
    const rec = await makeUser('RECEPTIONIST');
    const patient = await prisma.patient.create({ data: { name: 'P', phone: '92' + String(Date.now()).slice(-10), createdById: rec.id } });
    const task = await prisma.procedureTask.create({ data: { planItemId: `fake-${Date.now()}`, patientId: patient.id, doctorId: doctor.id, assistantId: other.id } });
    const res = await call(asst.agent).post('/api/files/dev-upload', { route: 'consentForm', recordType: 'ProcedureTask', recordId: task.id, fileName: 'c.pdf', mime: 'application/pdf', size: 1000 });
    expect(res.status).toBe(403);
  });

  it('assigned assistant uploads consent; office boy cannot read it; manager can', async () => {
    const asst = await agentFor('ASSISTANT');
    const doctor = await makeUser('DOCTOR');
    const rec = await makeUser('RECEPTIONIST');
    const patient = await prisma.patient.create({ data: { name: 'P2', phone: '92' + String(Date.now() + 7).slice(-10), createdById: rec.id } });
    const task = await prisma.procedureTask.create({ data: { planItemId: `fake2-${Date.now()}`, patientId: patient.id, doctorId: doctor.id, assistantId: asst.user.id } });
    const up = await call(asst.agent).post('/api/files/dev-upload', { route: 'consentForm', recordType: 'ProcedureTask', recordId: task.id, fileName: 'c.pdf', mime: 'application/pdf', size: 1000 });
    expect(up.status).toBe(201);
    const att = await prisma.attachment.findUniqueOrThrow({ where: { id: up.body.attachmentId } });
    expect(att.isPrivate).toBe(true);
    expect(att.publicUrl).toBeNull();

    const ob = await agentFor('OFFICE_BOY');
    expect((await call(ob.agent).get(`/api/files/${att.id}/url`)).status).toBe(403);
    const mgr = await agentFor('MANAGER');
    expect((await call(mgr.agent).get(`/api/files/${att.id}/url`)).status).toBe(200);
  });
});
