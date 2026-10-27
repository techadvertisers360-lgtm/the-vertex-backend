import type { AppointmentStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { normalizePhone } from '../../lib/phone';
import { audit, type Actor } from '../../services/audit';
import { publish, userRoom } from '../../services/realtime';
import { requireRoleIn } from '../../services/scope';
import { hashPassword, validatePasswordStrength } from '../../auth/service';
import { assertCanManageRole } from '../users/service';

/**
 * Manager adds, edits and removes Doctors (client 2026-10-27, D-064) — an exception to D-044 like Lead members: the
 * Manager gives a new Doctor's first password. "Remove" switches the account off; a Doctor is never deleted because
 * appointments, plans and history stay linked to them. Password resets stay with the developer (D-044).
 */

const ACTIVE: AppointmentStatus[] = ['DRAFT', 'CONFIRMED'];

const doctorSelect = {
  id: true,
  displayName: true,
  email: true,
  phone: true,
  memberCode: true,
  title: true,
  active: true,
  isDemo: true,
  createdAt: true,
  doctorProfile: { select: { specialty: true, defaultRoomId: true } },
} as const;

async function gate(actor: Actor) {
  requireRoleIn(actor, ['MANAGER'], 'User');
  await assertCanManageRole(actor, 'DOCTOR');
}

const duplicate = (e: unknown) => {
  if ((e as { code?: string }).code === 'P2002') throw new ConflictError('DUPLICATE_USER', 'Yeh email/phone/Member ID pehle se kisi account par hai.');
  throw e;
};

export async function listDoctors(actor: Actor) {
  await gate(actor);
  const now = new Date();
  const [doctors, ahead, rooms] = await Promise.all([
    prisma.user.findMany({ where: { role: 'DOCTOR' }, select: doctorSelect, orderBy: [{ active: 'desc' }, { displayName: 'asc' }] }),
    prisma.appointment.groupBy({ by: ['doctorId'], where: { status: { in: ACTIVE }, startAt: { gte: now } }, _count: { _all: true } }),
    prisma.room.findMany({ select: { id: true, code: true } }),
  ]);
  return {
    items: doctors.map(({ doctorProfile, ...d }) => ({
      ...d,
      specialty: doctorProfile?.specialty ?? null,
      roomCode: rooms.find((r) => r.id === doctorProfile?.defaultRoomId)?.code ?? null,
      bookingsAhead: ahead.find((a) => a.doctorId === d.id)?._count._all ?? 0,
    })),
  };
}

export interface DoctorInput {
  displayName: string;
  specialty?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  memberCode?: string | null;
}

function contact(input: Partial<DoctorInput>) {
  const phone = input.phone === undefined ? undefined : input.phone ? normalizePhone(input.phone) : null;
  if (input.phone && !phone) throw new ValidationError('Phone number durust nahi hai.');
  return {
    phone,
    email: input.email === undefined ? undefined : input.email?.trim().toLowerCase() || null,
    memberCode: input.memberCode === undefined ? undefined : input.memberCode?.trim().toUpperCase() || null,
  };
}

export async function createDoctor(actor: Actor, input: DoctorInput & { password: string }) {
  await gate(actor);
  validatePasswordStrength(input.password);
  const c = contact(input);
  if (!c.email && !c.phone && !c.memberCode) throw new ValidationError('Login ke liye email, phone ya Member ID mein se kam az kam ek zaroori hai.');
  const passwordHash = await hashPassword(input.password);
  return prisma
    .$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { displayName: input.displayName.trim(), role: 'DOCTOR', ...c, title: input.title?.trim() || null, passwordHash, mustChangePassword: false, createdById: actor.id },
        select: doctorSelect,
      });
      await tx.doctorProfile.create({ data: { userId: user.id, specialty: input.specialty?.trim() || null } });
      await audit(tx, actor, { action: 'USER_CREATED', recordType: 'User', recordId: user.id, after: { ...user, specialty: input.specialty ?? null } });
      return { id: user.id, displayName: user.displayName };
    })
    .catch(duplicate);
}

export async function updateDoctor(actor: Actor, id: string, input: Partial<DoctorInput>) {
  await gate(actor);
  const before = await prisma.user.findUnique({ where: { id }, select: { ...doctorSelect, role: true } });
  if (!before || before.role !== 'DOCTOR') throw new NotFoundError('Doctor');
  const c = contact(input);
  const next = { email: c.email === undefined ? before.email : c.email, phone: c.phone === undefined ? before.phone : c.phone, memberCode: c.memberCode === undefined ? before.memberCode : c.memberCode };
  if (!next.email && !next.phone && !next.memberCode) throw new ValidationError('Login ke liye email, phone ya Member ID mein se kam az kam ek zaroori hai.');
  return prisma
    .$transaction(async (tx) => {
      const after = await tx.user.update({
        where: { id },
        data: { displayName: input.displayName?.trim(), ...c, title: input.title === undefined ? undefined : input.title?.trim() || null },
        select: doctorSelect,
      });
      if (input.specialty !== undefined) {
        const specialty = input.specialty?.trim() || null;
        await tx.doctorProfile.upsert({ where: { userId: id }, create: { userId: id, specialty }, update: { specialty } });
      }
      await audit(tx, actor, { action: 'USER_UPDATED', recordType: 'User', recordId: id, before, after: { ...after, specialty: input.specialty ?? before.doctorProfile?.specialty ?? null } });
      return { id, displayName: after.displayName };
    })
    .catch(duplicate);
}

/**
 * Switch a Doctor off ("remove") or back on. A Doctor with bookings ahead cannot be switched off — the Manager
 * reschedules those patients first (nothing is moved silently). Switching off ends their sessions at once and frees
 * their assigned room.
 */
export async function setDoctorActive(actor: Actor, id: string, active: boolean) {
  await gate(actor);
  return prisma.$transaction(async (tx) => {
    await tx.doctorProfile.upsert({ where: { userId: id }, create: { userId: id }, update: {} });
    await tx.$queryRaw`SELECT id FROM doctor_profiles WHERE userId = ${id} FOR UPDATE`; // same lock as a booking
    const before = await tx.user.findUnique({ where: { id }, select: { role: true, active: true, displayName: true } });
    if (!before || before.role !== 'DOCTOR') throw new NotFoundError('Doctor');
    if (before.active === active) return { id, active };
    if (!active) {
      const ahead = await tx.appointment.count({ where: { doctorId: id, status: { in: ACTIVE }, startAt: { gte: new Date() } } });
      if (ahead) throw new ConflictError('DOCTOR_HAS_BOOKINGS', `${before.displayName} ki aage ${ahead} booking(s) hain — pehle unhein doosre Doctor / waqt par le jayein.`);
      await tx.doctorProfile.update({ where: { userId: id }, data: { defaultRoomId: null } });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await publish(tx, [userRoom(id)], 'session:revoked', { reason: 'ACCOUNT_DISABLED' });
    }
    await tx.user.update({ where: { id }, data: { active, tokenVersion: { increment: 1 } } });
    await audit(tx, actor, { action: 'USER_ACCESS_CHANGED', recordType: 'User', recordId: id, before: { active: before.active }, after: { active } });
    return { id, active };
  });
}
