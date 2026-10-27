import type { AppointmentStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { addDaysStr, clinicDateStr, clinicMinuteOfDay, dateOnly, dateOnlyStr, local } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { roomKindsFor } from '../../services/scheduling/engine';

/**
 * Doctor weekly hours and consultation room (client 2026-10-20, D-049). The booking engine builds every day from these
 * weekly hours, minus leave / absence, plus approved alternate hours — with no weekly hours a Doctor is never bookable.
 * The Manager sets them here; a change takes effect from a chosen date and earlier hours are kept as history.
 */

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutes = (s: string) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new ValidationError(`Time sahi likhein (HH:MM): ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
};
const ACTIVE: AppointmentStatus[] = ['DRAFT', 'CONFIRMED'];
const CONSULT_ROOM_KINDS = roomKindsFor('CONSULTATION');

export async function list() {
  const today = clinicDateStr(new Date());
  const [doctors, rooms] = await Promise.all([
    prisma.user.findMany({
      where: { role: 'DOCTOR', active: true },
      select: { id: true, displayName: true, doctorProfile: { select: { specialty: true, defaultRoomId: true } } },
      orderBy: { displayName: 'asc' },
    }),
    prisma.room.findMany({ where: { kind: { in: CONSULT_ROOM_KINDS }, active: true }, select: { id: true, code: true, name: true, kind: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
  ]);
  const rows = await prisma.doctorSchedule.findMany({
    where: { doctorId: { in: doctors.map((d) => d.id) }, active: true, OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnly(today) } }] },
    orderBy: [{ effectiveFrom: 'asc' }, { weekday: 'asc' }, { startMinute: 'asc' }],
  });
  return {
    today,
    rooms,
    doctors: doctors.map((d) => {
      const mine = rows.filter((r) => r.doctorId === d.id);
      const current = mine.filter((r) => dateOnlyStr(r.effectiveFrom) <= today);
      const upcoming = mine.filter((r) => dateOnlyStr(r.effectiveFrom) > today);
      const shape = (xs: typeof mine) => xs.map((r) => ({ weekday: r.weekday, start: hhmm(r.startMinute), end: hhmm(r.endMinute) }));
      return {
        id: d.id,
        displayName: d.displayName,
        specialty: d.doctorProfile?.specialty ?? null,
        roomId: d.doctorProfile?.defaultRoomId ?? null,
        roomCode: rooms.find((r) => r.id === d.doctorProfile?.defaultRoomId)?.code ?? null,
        current: shape(current),
        upcoming: upcoming.length ? { from: dateOnlyStr(upcoming[0]!.effectiveFrom), days: shape(upcoming.filter((u) => u.effectiveFrom.getTime() === upcoming[0]!.effectiveFrom.getTime())) } : null,
      };
    }),
  };
}

export interface HoursInput {
  effectiveFrom: string;
  days: { weekday: number; start: string; end: string }[];
}

/**
 * Replace a Doctor's weekly hours from `effectiveFrom` (today or later). Hours that started earlier end the day
 * before; hours that would only start on/after it are switched off. Locks the Doctor like a booking does, so a
 * booking and an hours change never interleave. Returns bookings that now fall outside the hours.
 */
export async function saveHours(actor: Actor, doctorId: string, input: HoursInput) {
  const today = clinicDateStr(new Date());
  if (input.effectiveFrom < today) throw new ValidationError('Tareekh aaj ya aage ki honi chahiye.');
  const windows = input.days.map((d) => {
    if (!Number.isInteger(d.weekday) || d.weekday < 1 || d.weekday > 7) throw new ValidationError('Din sahi chunein.');
    const s = minutes(d.start);
    const e = minutes(d.end);
    if (e <= s) throw new ValidationError(`${d.start}–${d.end}: end time start ke baad ho.`);
    return { weekday: d.weekday, startMinute: s, endMinute: e };
  });
  for (const w of windows) {
    if (windows.some((o) => o !== w && o.weekday === w.weekday && o.startMinute < w.endMinute && w.startMinute < o.endMinute))
      throw new ValidationError('Ek din ke do waqt aapas mein overlap kar rahe hain.');
  }
  const from = dateOnly(input.effectiveFrom);
  const dayBefore = dateOnly(addDaysStr(input.effectiveFrom, -1));

  const result = await prisma.$transaction(async (tx) => {
    const doc = await tx.user.findUnique({ where: { id: doctorId }, select: { role: true, active: true, displayName: true } });
    if (!doc || doc.role !== 'DOCTOR') throw new NotFoundError('Doctor');
    await tx.doctorProfile.upsert({ where: { userId: doctorId }, create: { userId: doctorId }, update: {} });
    await tx.$queryRaw`SELECT id FROM doctor_profiles WHERE userId = ${doctorId} FOR UPDATE`;
    const before = await tx.doctorSchedule.findMany({ where: { doctorId, active: true }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] });
    for (const r of before) {
      if (r.effectiveFrom >= from) await tx.doctorSchedule.update({ where: { id: r.id }, data: { active: false } });
      else if (!r.effectiveTo || r.effectiveTo >= from) await tx.doctorSchedule.update({ where: { id: r.id }, data: { effectiveTo: dayBefore } });
    }
    if (windows.length) await tx.doctorSchedule.createMany({ data: windows.map((w) => ({ doctorId, ...w, effectiveFrom: from, createdById: actor.id! })) });
    await audit(tx, actor, {
      action: 'DOCTOR_HOURS_SET',
      recordType: 'User',
      recordId: doctorId,
      before: before.map((r) => ({ weekday: r.weekday, start: hhmm(r.startMinute), end: hhmm(r.endMinute), from: dateOnlyStr(r.effectiveFrom), to: r.effectiveTo ? dateOnlyStr(r.effectiveTo) : null })),
      after: { from: input.effectiveFrom, days: windows.map((w) => ({ weekday: w.weekday, start: hhmm(w.startMinute), end: hhmm(w.endMinute) })) },
    });
    return { doctor: doc.displayName };
  });

  // Booked visits that the new hours no longer cover — the Manager reschedules them (nothing is moved silently).
  const booked = await prisma.appointment.findMany({
    where: { doctorId, status: { in: ACTIVE }, startAt: { gte: from } },
    select: { id: true, startAt: true, endAt: true, patient: { select: { name: true } } },
    orderBy: { startAt: 'asc' },
    take: 500,
  });
  const outside = booked.filter((a) => {
    const wd = local(a.startAt).weekday;
    const s = clinicMinuteOfDay(a.startAt);
    const e = s + Math.round((a.endAt.getTime() - a.startAt.getTime()) / 60_000);
    return !windows.some((w) => w.weekday === wd && w.startMinute <= s && e <= w.endMinute);
  });
  return { ok: true, doctor: result.doctor, outsideHours: outside.map((a) => ({ id: a.id, startAt: a.startAt, patientName: a.patient.name })) };
}

/** Assign (or clear) the Doctor's consultation room. The booking engine uses it first whenever it is free. */
export async function setRoom(actor: Actor, doctorId: string, roomId: string | null) {
  return prisma.$transaction(async (tx) => {
    const doc = await tx.user.findUnique({ where: { id: doctorId }, select: { role: true } });
    if (!doc || doc.role !== 'DOCTOR') throw new NotFoundError('Doctor');
    if (roomId) {
      const room = await tx.room.findUnique({ where: { id: roomId } });
      if (!room || !room.active || !CONSULT_ROOM_KINDS.includes(room.kind)) throw new ValidationError('Consultation room chunein.');
    }
    const before = await tx.doctorProfile.findUnique({ where: { userId: doctorId }, select: { defaultRoomId: true } });
    await tx.doctorProfile.upsert({ where: { userId: doctorId }, create: { userId: doctorId, defaultRoomId: roomId }, update: { defaultRoomId: roomId } });
    await audit(tx, actor, { action: 'DOCTOR_ROOM_SET', recordType: 'User', recordId: doctorId, before: { roomId: before?.defaultRoomId ?? null }, after: { roomId } });
    return { ok: true, roomId };
  });
}
