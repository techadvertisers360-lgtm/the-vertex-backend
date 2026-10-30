import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { addDaysStr, clinicDateStr, clinicDayBounds } from '../../lib/time';

/**
 * Upcoming appointments (client 2026-10-30, D-081): confirmed bookings (not yet arrived) from today on, soonest first.
 *  - Reception: every Doctor (optional Doctor filter), with the patient's phone and who booked.
 *  - Doctor: only their own, patient name / age / gender — no phone, no lead or booking details (spec §22).
 * Cancelled and rescheduled bookings are left out (the new booking of a reschedule is listed).
 */
export interface UpcomingQuery {
  days: number;
  type?: 'CONSULTATION' | 'PROCEDURE';
  doctorId?: string;
}

export async function upcomingAppointments(q: UpcomingQuery, view: 'reception' | 'doctor') {
  const today = clinicDateStr(new Date());
  // From the start of today, so a patient who is late today is still listed until check-in.
  const from = clinicDayBounds(today).start;
  const until = clinicDayBounds(addDaysStr(today, q.days - 1)).end;
  const where: Prisma.AppointmentWhereInput = {
    status: 'CONFIRMED',
    startAt: { gte: from, lt: until },
    ...(q.type ? { type: q.type } : {}),
    ...(q.doctorId ? { doctorId: q.doctorId } : {}),
  };
  const rows = await prisma.appointment.findMany({
    where,
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    take: 500,
    select: {
      id: true,
      startAt: true,
      endAt: true,
      type: true,
      status: true,
      source: true,
      reason: true,
      doctorId: true,
      serviceId: true,
      roomId: true,
      leadMemberId: true,
      createdById: true,
      treatmentPlanItemId: true,
      patient: { select: view === 'reception' ? { id: true, name: true, phone: true, ageYears: true, gender: true } : { id: true, name: true, ageYears: true, gender: true } },
    },
  });
  const ids = (pick: (r: (typeof rows)[number]) => string | null) => [...new Set(rows.map(pick).filter((x): x is string => !!x))];
  const [users, services, rooms, items] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...ids((r) => r.doctorId), ...ids((r) => r.leadMemberId), ...ids((r) => r.createdById)] } }, select: { id: true, displayName: true } }),
    prisma.service.findMany({ where: { id: { in: ids((r) => r.serviceId) } }, select: { id: true, name: true } }),
    prisma.room.findMany({ where: { id: { in: ids((r) => r.roomId) } }, select: { id: true, code: true } }),
    prisma.treatmentPlanItem.findMany({ where: { id: { in: ids((r) => r.treatmentPlanItemId) } }, select: { id: true, procedureName: true, sessionNumber: true } }),
  ]);
  const who = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? null) : null);
  return {
    total: rows.length,
    items: rows.map((r) => {
      const item = items.find((i) => i.id === r.treatmentPlanItemId);
      const base = {
        id: r.id,
        startAt: r.startAt,
        endAt: r.endAt,
        type: r.type,
        status: r.status,
        reason: r.reason,
        patient: r.patient,
        doctorName: who(r.doctorId),
        procedure: item?.procedureName ?? services.find((s) => s.id === r.serviceId)?.name ?? null,
        session: item?.sessionNumber ?? null,
        roomCode: rooms.find((x) => x.id === r.roomId)?.code ?? null,
      };
      return view === 'reception' ? { ...base, doctorId: r.doctorId, source: r.source, bookedBy: who(r.createdById), leadMemberName: who(r.leadMemberId) } : base;
    }),
  };
}
