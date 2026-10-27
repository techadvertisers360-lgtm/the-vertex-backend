import request from 'supertest';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { createApp } from '../../src/app';
import { prisma } from '../../src/lib/prisma';
import { normalizePhone } from '../../src/lib/phone';

export const app = createApp();
export { prisma };

export const TEST_PASSWORD = 'Test@12345';
let hashed: string | null = null;

let seq = 0;
export function uid(prefix = 't'): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}${Math.floor(Math.random() * 1e4)}`;
}

/** A 03xx phone unique within the test run. */
export function uniquePhone(): string {
  const n = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  return `03${n}`;
}

export async function makeUser(role: Role, overrides: { displayName?: string; active?: boolean } = {}) {
  hashed ??= await bcrypt.hash(TEST_PASSWORD, 4);
  const tag = uid(role.toLowerCase());
  const user = await prisma.user.create({
    data: {
      displayName: overrides.displayName ?? `Test ${role} ${tag}`,
      role,
      email: `${tag}@test.local`,
      passwordHash: hashed,
      active: overrides.active ?? true,
    },
  });
  if (role === 'DOCTOR') await prisma.doctorProfile.create({ data: { userId: user.id } });
  return user;
}

export type Agent = ReturnType<typeof request.agent>;

/** Supertest agent with the CSRF header pre-set and cookies kept between calls. */
export async function loginAs(email: string, password = TEST_PASSWORD): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('x-vh-client', 'web').send({ identifier: email, password });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export async function agentFor(role: Role) {
  const user = await makeUser(role);
  const agent = await loginAs(user.email!);
  return { user, agent };
}

/** Request builder that always sends the client header. */
export function call(agent: Agent) {
  return {
    get: (url: string) => agent.get(url).set('x-vh-client', 'web'),
    post: (url: string, body?: object, idemKey?: string) => {
      const r = agent.post(url).set('x-vh-client', 'web');
      if (idemKey) r.set('Idempotency-Key', idemKey);
      return r.send(body ?? {});
    },
    put: (url: string, body?: object) => agent.put(url).set('x-vh-client', 'web').send(body ?? {}),
    patch: (url: string, body?: object) => agent.patch(url).set('x-vh-client', 'web').send(body ?? {}),
    delete: (url: string) => agent.delete(url).set('x-vh-client', 'web'),
  };
}

export const newKey = () => randomUUID();

const ROOM_DEFS = [
  { code: 'C01', kind: 'CONSULT' as const, sortOrder: 1 },
  { code: 'C02', kind: 'CONSULT' as const, sortOrder: 2 },
  { code: 'C03', kind: 'CONSULT' as const, sortOrder: 3 },
  { code: 'P01', kind: 'PROCEDURE' as const, sortOrder: 4 },
  { code: 'P02', kind: 'PROCEDURE' as const, sortOrder: 5 },
  { code: 'P03', kind: 'PROCEDURE' as const, sortOrder: 6 },
];

export async function ensureRooms() {
  for (const r of ROOM_DEFS) await prisma.room.upsert({ where: { code: r.code }, update: {}, create: { ...r, name: r.code } });
}

/** Cancel every active room reservation from `from` onward so earlier tests/runs cannot block rooms. */
export async function freeRoomsFrom(from: Date) {
  await prisma.roomReservation.updateMany({ where: { status: 'ACTIVE', startAt: { gte: from } }, data: { status: 'CANCELLED' } });
}

/** A Doctor working 09:00–21:00 clinic time every day. */
export async function doctorWithHours() {
  const doctor = await makeUser('DOCTOR');
  await prisma.user.update({ where: { id: doctor.id }, data: { phone: '92' + String(Date.now()).slice(-7) + String(Math.floor(Math.random() * 900) + 100) } });
  for (let weekday = 1; weekday <= 7; weekday++) {
    await prisma.doctorSchedule.create({
      data: { doctorId: doctor.id, weekday, startMinute: 9 * 60, endMinute: 21 * 60, effectiveFrom: new Date('2026-01-01T00:00:00Z'), createdById: doctor.id },
    });
  }
  return doctor;
}

/** A Meta sheet assigned to `memberId`, created by `adminId`. */
export async function makeSheet(memberId: string, adminId: string) {
  const tag = uid('sheet');
  const sheet = await prisma.metaSheet.create({ data: { externalId: `T-${tag}`, title: `Sheet ${tag}`, campaign: `Campaign ${tag}`, createdById: adminId } });
  await prisma.sheetAssignment.create({ data: { sheetId: sheet.id, memberId, assignedById: adminId } });
  return sheet;
}

export async function makeLead(sheetId: string, memberId: string, phoneRaw = uniquePhone(), name = 'Test Lead') {
  return prisma.lead.create({ data: { sheetId, assignedMemberId: memberId, name, phone: normalizePhone(phoneRaw)!, phoneRaw } });
}

export async function lastAudit(action: string, recordId?: string) {
  return prisma.auditEvent.findFirst({ where: { action, ...(recordId ? { recordId } : {}) }, orderBy: { id: 'desc' } });
}
