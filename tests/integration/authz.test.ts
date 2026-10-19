import { beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { API_MOUNTS } from '../../src/app';
import { hasPermission, type Permission } from '../../src/auth/permissions';
import { normalizePhone } from '../../src/lib/phone';
import { addMinutes } from '../../src/lib/time';
import { agentFor, call, makeLead, makeSheet, makeUser, prisma, uid, uniquePhone, type Agent } from './helpers';

/**
 * Spec §25 (last item) and §24 "Permission denied": every critical API checks role and record scope on the server —
 * hidden UI is never the control. The first suite walks EVERY authenticated route of the real app and calls it as
 * every role that lacks the route's permission; the server must answer 403 (FORBIDDEN) before touching any data.
 */

const ROLES: Role[] = ['LEAD_MEMBER', 'RECEPTIONIST', 'DOCTOR', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER', 'MD', 'MARKETING_DIRECTOR', 'MARKETING_LEAD', 'DEVELOPER'];

/** Raw handlers (not built with route()) and why they are safe for every signed-in role. */
const RAW_ALLOWED: Record<string, string> = {
  'GET /me/': 'own session only (role-specific nav comes from the server)',
  'GET /files/:id/content': 'checks files:read itself, then the same record-scope rule as /files/:id/url',
  'POST /me/password': 'own password only; needs the current password',
  'POST /me/stop-view-as': 'leaves developer view-as for the own session only (no-op otherwise)',
};

interface RouteInfo {
  method: string;
  path: string;
  permissions: Permission[] | null;
}

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: { routePermissions?: Permission[] } }[] } };

function collect(): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const [mount, router] of API_MOUNTS) {
    for (const layer of (router as unknown as { stack: Layer[] }).stack) {
      if (!layer.route) continue;
      const perms = layer.route.stack.map((l) => l.handle.routePermissions).find(Boolean) ?? null;
      for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: `${mount}${layer.route.path}`, permissions: perms });
    }
  }
  return out;
}

const routes = collect();
const agents = new Map<Role, ReturnType<typeof call>>();

beforeAll(async () => {
  for (const role of ROLES) agents.set(role, call((await agentFor(role)).agent));
});

function send(api: ReturnType<typeof call>, method: string, path: string) {
  const url = `/api${path.replace(/:[A-Za-z]+/g, 'zz-not-a-real-id')}`;
  if (method === 'GET') return api.get(url);
  if (method === 'POST') return api.post(url, {}, 'authz-test-key-123');
  if (method === 'PUT') return api.put(url, {});
  return api.patch(url, {});
}

describe('§25 / §24 — the server rejects hidden-UI actions for every role on every route', () => {
  it('every authenticated route declares a permission (or is an allow-listed raw handler)', () => {
    expect(routes.length).toBeGreaterThan(150);
    const unguarded = routes.filter((r) => !r.permissions && !RAW_ALLOWED[`${r.method} ${r.path}`]);
    expect(unguarded).toEqual([]);
    expect(routes.every((r) => !r.permissions || r.permissions.length > 0)).toBe(true);
  });

  it('a role without the permission gets 403 on every route, before validation or data access', async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const r of routes.filter((x) => x.permissions)) {
      for (const role of ROLES) {
        if (r.permissions!.some((p) => hasPermission(role, p))) continue;
        const res = await send(agents.get(role)!, r.method, r.path);
        checked++;
        if (res.status !== 403 || res.body?.error?.code !== 'FORBIDDEN') failures.push(`${role} ${r.method} ${r.path} → ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(1000);
  }, 300_000);

  it('denials are audited with the endpoint and the missing permission', async () => {
    const ob = (await agentFor('OFFICE_BOY')) as { user: { id: string }; agent: Agent };
    expect((await call(ob.agent).get('/api/inventory/stock')).status).toBe(403);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'AUTHZ_DENIED', actorId: ob.user.id }, orderBy: { id: 'desc' } });
    expect(ev.recordType).toBe('Endpoint');
    expect(ev.recordId).toContain('/inventory');
    expect(JSON.stringify(ev.after ?? ev.reason ?? '')).toMatch(/permission/);
  });
});

describe('§25 — record scope is enforced even when the role has the permission', () => {
  it('Lead member: another member’s lead and sheet are refused (403, audited)', async () => {
    const admin = await makeUser('MD');
    const a = await agentFor('LEAD_MEMBER');
    const b = await agentFor('LEAD_MEMBER');
    const sheetB = await makeSheet(b.user.id, admin.id);
    const leadB = await makeLead(sheetB.id, b.user.id);
    const api = call(a.agent);
    expect((await api.get(`/api/lead/leads/${leadB.id}`)).status).toBe(403);
    expect((await api.post(`/api/lead/leads/${leadB.id}/activities`, { channel: 'CALL', result: 'NO_ANSWER' })).status).toBe(403);
    expect((await api.get(`/api/lead/sheets/${sheetB.id}`)).status).toBe(403);
    expect(await prisma.auditEvent.count({ where: { action: 'AUTHZ_DENIED', actorId: a.user.id } })).toBeGreaterThanOrEqual(3);
  });

  it('Doctor: another Doctor’s appointment cannot be accepted or read', async () => {
    const d1 = await agentFor('DOCTOR');
    const d2 = await makeUser('DOCTOR');
    const receptionist = await makeUser('RECEPTIONIST');
    const p = await prisma.patient.create({ data: { name: `Scope ${uid()}`, phone: normalizePhone(uniquePhone())!, createdById: receptionist.id } });
    const now = new Date();
    const appt = await prisma.appointment.create({ data: { patientId: p.id, doctorId: d2.id, type: 'CONSULTATION', startAt: now, endAt: addMinutes(now, 20), status: 'WAITING', source: 'RECEPTION', createdById: receptionist.id, checkedInAt: now } });
    const api = call(d1.agent);
    expect((await api.post(`/api/doctor/appointments/${appt.id}/accept`)).status).toBe(403);
    expect((await api.get(`/api/doctor/appointments/${appt.id}`)).status).toBe(403);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe('WAITING');
  });

  it('Assistant: a procedure task assigned to someone else is refused', async () => {
    const other = await prisma.procedureTask.findFirst({ where: { assistantId: { not: null } }, select: { id: true } });
    if (!other) return; // assistant.test creates tasks; nothing to probe in an empty DB
    const a = await agentFor('ASSISTANT');
    const api = call(a.agent);
    expect((await api.get(`/api/assistant/procedures/${other.id}`)).status).toBe(403);
    expect((await api.post(`/api/assistant/procedures/${other.id}/accept`)).status).toBe(403);
  });
});
