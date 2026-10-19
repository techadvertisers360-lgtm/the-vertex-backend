import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { agentFor, app, call, loginAs, makeUser, prisma, TEST_PASSWORD, uid, type Agent } from './helpers';

/** D-043 — hidden developer: manages every account, never listed, "view as" any staff user read-only. */

let dev: { user: { id: string; email: string | null }; agent: Agent };
let devApi: ReturnType<typeof call>;
const saved = { ...env };
afterEach(() => {
  Object.assign(env, saved);
});

beforeAll(async () => {
  dev = await agentFor('DEVELOPER');
  devApi = call(dev.agent);
});

const newAccount = (role: string, extra: Record<string, unknown> = {}) => ({
  displayName: `Dev Made ${role} ${uid()}`,
  role,
  memberCode: `T-${uid().slice(-8).toUpperCase()}`,
  password: 'Temp-pass-123',
  ...extra,
});

describe('D-043 — developer manages every account', () => {
  it('creates leadership and staff accounts, edits and disables them; new accounts must change their password', async () => {
    for (const role of ['MD', 'MANAGER', 'MARKETING_DIRECTOR', 'MARKETING_LEAD', 'RECEPTIONIST', 'ASSISTANT', 'OFFICE_BOY', 'LEAD_MEMBER']) {
      const r = await devApi.post('/api/users', newAccount(role));
      expect(r.status, role).toBe(201);
      expect(r.body).toMatchObject({ role, mustChangePassword: true });
    }
    const doc = await devApi.post('/api/users', newAccount('DOCTOR', { specialty: 'Dermatology' }));
    expect(doc.status).toBe(201);
    expect((await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doc.body.id } })).specialty).toBe('Dermatology');

    const mgr = await devApi.post('/api/users', newAccount('MANAGER'));
    const edit = await devApi.patch(`/api/users/${mgr.body.id}`, { displayName: 'Ayesha Khan', title: 'Clinic Manager', role: 'MD' });
    expect(edit.body).toMatchObject({ displayName: 'Ayesha Khan', title: 'Clinic Manager', role: 'MD' });
    expect((await devApi.patch(`/api/users/${mgr.body.id}`, { active: false })).body.active).toBe(false);

    // nobody can create or touch a developer through the app — not even the developer
    expect((await devApi.post('/api/users', newAccount('DEVELOPER'))).status).toBe(403);
    const md = call((await agentFor('MD')).agent);
    expect((await md.patch(`/api/users/${dev.user.id}`, { active: false })).status).toBe(403);
    expect((await md.post(`/api/users/${dev.user.id}/password`, { password: 'Another-pass-1' })).status).toBe(403);
  });

  it('the developer never appears in any list', async () => {
    const md = call((await agentFor('MD')).agent);
    const users = await md.get('/api/users');
    expect(users.body.items.some((u: { id: string }) => u.id === dev.user.id)).toBe(false);
    expect((await md.get('/api/users?role=DEVELOPER')).body.items).toEqual([]);
    const lookups = await md.get('/api/manager/audit/lookups');
    if (lookups.status === 200) expect(lookups.body.users.some((u: { id: string }) => u.id === dev.user.id)).toBe(false);
    const mgr = call((await agentFor('MANAGER')).agent);
    const staff = await mgr.get('/api/manager/staff');
    expect(JSON.stringify(staff.body)).not.toContain(dev.user.id);
    const list = await devApi.get('/api/developer/users');
    expect(list.status).toBe(200);
    expect(list.body.items.some((u: { id: string }) => u.id === dev.user.id)).toBe(false);
    for (const role of ['MANAGER', 'MD', 'RECEPTIONIST'] as const) expect((await call((await agentFor(role)).agent).get('/api/developer/users')).status).toBe(403);
  });
});

describe('D-043 — temporary password and changing my own password', () => {
  it('a temporary password ends sessions and forces a change; the change needs the current password', async () => {
    const u = await makeUser('RECEPTIONIST');
    const old = await loginAs(u.email!);
    const set = await devApi.post(`/api/users/${u.id}/password`, { password: 'Temp-pass-456' });
    expect(set.status).toBe(200);
    expect((await call(old).get('/api/me')).status).toBe(401); // old session ended
    expect((await request(app).post('/api/auth/login').set('x-vh-client', 'web').send({ identifier: u.email, password: TEST_PASSWORD })).status).toBe(401);

    const agent = await loginAs(u.email!, 'Temp-pass-456');
    const api = call(agent);
    expect((await api.get('/api/me')).body.user.mustChangePassword).toBe(true);
    expect((await api.post('/api/me/password', { currentPassword: 'wrong-one-1', newPassword: 'Mine-pass-789' })).status).toBe(422);
    expect((await api.post('/api/me/password', { currentPassword: 'Temp-pass-456', newPassword: 'short' })).status).toBe(422);
    const ok = await api.post('/api/me/password', { currentPassword: 'Temp-pass-456', newPassword: 'Mine-pass-789' });
    expect(ok.status).toBe(200);
    expect((await api.get('/api/me')).body.user.mustChangePassword).toBe(false); // still signed in with the fresh session
    expect((await request(app).post('/api/auth/login').set('x-vh-client', 'web').send({ identifier: u.email, password: 'Temp-pass-456' })).status).toBe(401);
    await loginAs(u.email!, 'Mine-pass-789');
    expect(await prisma.auditEvent.count({ where: { action: 'PASSWORD_CHANGED', recordId: u.id } })).toBe(1);
    const setEv = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'USER_PASSWORD_SET', recordId: u.id } });
    expect(JSON.stringify(setEv, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('Temp-pass-456');
  });
});

describe('D-043 — "view as": their tabs, data and live channel, read-only, audited as the developer', () => {
  it('shows the user’s own screens, refuses every write, and returns to the developer', async () => {
    const r = await makeUser('RECEPTIONIST');
    const start = await devApi.post('/api/developer/view-as', { userId: r.id });
    expect(start.body).toMatchObject({ ok: true, home: '/reception' });

    const me = await devApi.get('/api/me');
    expect(me.body).toMatchObject({ user: { id: r.id, role: 'RECEPTIONIST' }, viewAs: { by: 'Developer' }, home: '/reception' });
    expect(me.body.nav.map((n: { path: string }) => n.path)).toContain('/reception/tracker');
    expect((await devApi.get('/api/reception/tracker')).status).toBe(200); // reads work with their permissions

    const write = await devApi.post('/api/attendance/check-in');
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('VIEW_ONLY');
    expect((await devApi.post('/api/me/password', { currentPassword: 'x', newPassword: 'Whatever-123' })).body.error.code).toBe('VIEW_ONLY');
    expect(await prisma.attendance.count({ where: { userId: r.id } })).toBe(0);

    // their private live channel
    env.REALTIME_PROVIDER = 'supabase';
    env.SUPABASE_JWT_SECRET = 'test-jwt-secret-test-jwt-secret-0123456789';
    expect((await devApi.get('/api/realtime/token')).body.topic).toBe(`user:${r.id}`);
    Object.assign(env, saved);

    // survives the 15-minute token refresh
    const refreshed = await dev.agent.post('/api/auth/refresh').set('x-vh-client', 'web').send({});
    expect(refreshed.status).toBe(200);
    expect((await devApi.get('/api/me')).body.user.id).toBe(r.id);

    // denials while viewing are audited as the developer, on behalf of the viewed user
    await devApi.get('/api/inventory/stock');
    const denied = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'AUTHZ_DENIED', onBehalfOfId: r.id }, orderBy: { id: 'desc' } });
    expect(denied).toMatchObject({ actorId: dev.user.id, actorRole: 'DEVELOPER' });
    const started = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'VIEW_AS_STARTED', recordId: r.id } });
    expect(started.actorId).toBe(dev.user.id);

    expect((await devApi.post('/api/me/stop-view-as')).status).toBe(200);
    const back = await devApi.get('/api/me');
    expect(back.body).toMatchObject({ user: { id: dev.user.id, role: 'DEVELOPER' }, viewAs: null, home: '/developer' });
  });

  it('cannot view as a disabled user or another developer; nobody else can start view-as', async () => {
    const off = await makeUser('ASSISTANT', { active: false });
    expect((await devApi.post('/api/developer/view-as', { userId: off.id })).status).toBe(422);
    const dev2 = await makeUser('DEVELOPER');
    expect((await devApi.post('/api/developer/view-as', { userId: dev2.id })).status).toBe(404);
    const target = await makeUser('RECEPTIONIST');
    expect((await call((await agentFor('MD')).agent).post('/api/developer/view-as', { userId: target.id })).status).toBe(403);
    expect((await call((await agentFor('MANAGER')).agent).post('/api/me/stop-view-as')).body).toEqual({ ok: true, viewAs: null });
  });
});
