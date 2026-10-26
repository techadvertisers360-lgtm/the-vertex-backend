import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentFor, call, prisma } from './helpers';

/** D-062 — clinic location restriction: developer settings, per-user switch, server-side claim on every API call. */

const CLINIC = { latitude: 31.5020747, longitude: 74.4335575 };
const FAR = { latitude: 31.52, longitude: 74.45 }; // about 2.5 km away
const base = { enabled: true, ...CLINIC, radiusM: 200, allowedIps: [] as string[] };
const STOCK = '/api/reception/stock?kind=PHARMACY';
let dev: ReturnType<typeof call>;

beforeAll(async () => {
  dev = call((await agentFor('DEVELOPER')).agent);
});
afterAll(async () => {
  await dev.put('/api/developer/geofence', { ...base, enabled: false });
});

describe('D-062 — geofence', () => {
  it('only the developer reads or changes the settings; every user is listed with the switch off by default', async () => {
    for (const role of ['MD', 'MANAGER', 'RECEPTIONIST'] as const) {
      const api = call((await agentFor(role)).agent);
      expect((await api.get('/api/developer/geofence')).status).toBe(403);
      expect((await api.put('/api/developer/geofence', base)).status).toBe(403);
    }
    const fresh = await agentFor('ASSISTANT');
    const o = await dev.get('/api/developer/geofence');
    expect(o.status).toBe(200);
    expect(o.body.users.find((u: { id: string }) => u.id === fresh.user.id)).toMatchObject({ geofenceRequired: false });
  });

  it('a switched-on user is blocked until on site; outside, bad accuracy and no location are refused and audited', async () => {
    expect((await dev.put('/api/developer/geofence', base)).status).toBe(200);
    const a = await agentFor('RECEPTIONIST');
    const api = call(a.agent);
    expect((await api.get(STOCK)).status).toBe(200); // switch off: free

    expect((await dev.patch(`/api/developer/geofence/users/${a.user.id}`, { required: true })).status).toBe(200);
    const blocked = await api.get(STOCK);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('GEOFENCE_REQUIRED');
    expect((await api.get('/api/me')).status).toBe(200); // profile and the check stay open
    expect((await api.get('/api/geofence/status')).body).toMatchObject({ required: true, claimUntil: null });

    const far = await api.post('/api/geofence/check', { ...FAR, accuracyM: 20 });
    expect(far.body).toMatchObject({ ok: false, reason: 'OUTSIDE' });
    expect(far.body.distanceM).toBeGreaterThan(200);
    expect((await api.post('/api/geofence/check', { ...CLINIC, accuracyM: 900 })).body).toMatchObject({ ok: false, reason: 'LOW_ACCURACY' });
    expect((await api.post('/api/geofence/check', { error: 'denied' })).body).toMatchObject({ ok: false, reason: 'NO_LOCATION' });
    expect((await api.get(STOCK)).status).toBe(403);
    expect(await prisma.auditEvent.count({ where: { action: 'GEOFENCE_BLOCKED', recordId: a.user.id } })).toBe(3);

    const ok = await api.post('/api/geofence/check', { latitude: CLINIC.latitude + 0.0005, longitude: CLINIC.longitude, accuracyM: 30 });
    expect(ok.body).toMatchObject({ ok: true, required: true, by: 'LOCATION' });
    expect((await api.get(STOCK)).status).toBe(200);

    // only the last check is kept, never coordinates
    const u = await prisma.user.findUniqueOrThrow({ where: { id: a.user.id }, select: { geoLastInside: true, geoLastDistanceM: true } });
    expect(u.geoLastInside).toBe(true);
    expect(u.geoLastDistanceM).toBeLessThan(200);
    const logged = await prisma.auditEvent.findMany({ where: { action: 'GEOFENCE_BLOCKED', recordId: a.user.id } });
    expect(JSON.stringify(logged)).not.toContain(String(FAR.latitude));

    // an expired claim blocks again
    await prisma.session.updateMany({ where: { userId: a.user.id }, data: { geoClaimUntil: new Date(Date.now() - 1000) } });
    expect((await api.get(STOCK)).status).toBe(403);

    // switching the user off, or the geofence off, applies on the very next request
    await dev.patch(`/api/developer/geofence/users/${a.user.id}`, { required: false });
    expect((await api.get(STOCK)).status).toBe(200);
    await dev.patch(`/api/developer/geofence/users/${a.user.id}`, { required: true });
    expect((await api.get(STOCK)).status).toBe(403);
    await dev.put('/api/developer/geofence', { ...base, enabled: false });
    expect((await api.get(STOCK)).status).toBe(200);
  });

  it('an allowed clinic IP counts as on site; changing the settings clears old claims', async () => {
    await dev.put('/api/developer/geofence', { ...base, allowedIps: ['127.0.0.1', '::1'] });
    const a = await agentFor('MANAGER');
    const api = call(a.agent);
    await dev.patch(`/api/developer/geofence/users/${a.user.id}`, { required: true });
    expect((await api.post('/api/geofence/check', { error: 'denied' })).body).toMatchObject({ ok: true, by: 'IP' });
    expect((await api.get('/api/manager/dashboard')).status).toBe(200);
    await dev.put('/api/developer/geofence', { ...base, allowedIps: [] });
    expect((await api.get('/api/manager/dashboard')).status).toBe(403);
    expect((await dev.put('/api/developer/geofence', { ...base, allowedIps: ['not-an-ip'] })).status).toBe(422);
  });

  it('the role button sets every user of that role; the result is per user', async () => {
    const a = await agentFor('OFFICE_BOY');
    expect((await dev.post('/api/developer/geofence/role', { role: 'OFFICE_BOY', required: true })).body.count).toBeGreaterThan(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).geofenceRequired).toBe(true);
    await dev.patch(`/api/developer/geofence/users/${a.user.id}`, { required: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).geofenceRequired).toBe(false);
    await dev.post('/api/developer/geofence/role', { role: 'OFFICE_BOY', required: false });
  });
});
