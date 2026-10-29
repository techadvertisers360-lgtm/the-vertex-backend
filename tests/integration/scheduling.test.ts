import { beforeAll, describe, expect, it } from 'vitest';
import { addDaysStr, atClinicMinute, clinicDateStr, dateOnly } from '../../src/lib/time';
import { bookAppointment, cancelAppointment, rescheduleAppointment, SlotUnavailableError, type BookInput } from '../../src/services/scheduling';
import type { Actor } from '../../src/services/audit';
import { agentFor, call, makeUser, prisma, uniquePhone } from './helpers';
import { normalizePhone } from '../../src/lib/phone';

const ROOMS = [
  { code: 'C01', kind: 'CONSULT' as const, sortOrder: 1 },
  { code: 'C02', kind: 'CONSULT' as const, sortOrder: 2 },
  { code: 'C03', kind: 'CONSULT' as const, sortOrder: 3 },
  { code: 'P01', kind: 'PROCEDURE' as const, sortOrder: 4 },
  { code: 'P02', kind: 'PROCEDURE' as const, sortOrder: 5 },
  { code: 'P03', kind: 'PROCEDURE' as const, sortOrder: 6 },
];

// A date a few days ahead so nothing is "in the past".
const D = addDaysStr(clinicDateStr(new Date()), 3);
const at = (hhmm: string, date = D) => atClinicMinute(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

let actor: Actor;

async function doctorWithHours() {
  const doctor = await makeUser('DOCTOR');
  const manager = await makeUser('MANAGER');
  for (let weekday = 1; weekday <= 7; weekday++) {
    await prisma.doctorSchedule.create({ data: { doctorId: doctor.id, weekday, startMinute: 9 * 60, endMinute: 21 * 60, effectiveFrom: dateOnly('2026-01-01'), createdById: manager.id } });
  }
  return doctor;
}

async function patient() {
  return prisma.patient.create({ data: { name: 'Sched Patient', phone: normalizePhone(uniquePhone())!, createdById: actor.id!, whatsappConsent: true } });
}

function req(doctorId: string, patientId: string, start: Date, extra: Partial<BookInput> = {}): BookInput {
  return { doctorId, patientId, type: 'CONSULTATION', start, durationMin: 20, source: 'RECEPTION', ...extra };
}

/** Consult rooms are clinic-wide; occupy all three so rooms do not interfere unless a test wants them to. */
async function freeRoomsOnly() {
  await prisma.roomReservation.updateMany({ where: { status: 'ACTIVE', startAt: { gte: at('00:00') } }, data: { status: 'CANCELLED' } });
}

beforeAll(async () => {
  for (const r of ROOMS) await prisma.room.upsert({ where: { code: r.code }, update: {}, create: { ...r, name: r.code } });
  const rec = await makeUser('RECEPTIONIST');
  actor = { id: rec.id, role: 'RECEPTIONIST', displayName: rec.displayName };
});

describe('final-save checks (spec §6, §25)', () => {
  it('concurrent bookings of the same Doctor slot: exactly one wins, the other gets 409 with alternatives', async () => {
    await freeRoomsOnly();
    const doctor = await doctorWithHours();
    const [p1, p2] = [await patient(), await patient()];
    const results = await Promise.allSettled([
      bookAppointment(actor, req(doctor.id, p1.id, at('10:00'))),
      bookAppointment(actor, req(doctor.id, p2.id, at('10:00'))),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBeInstanceOf(SlotUnavailableError);
    const details = (failed[0]!.reason as SlotUnavailableError).details as { suggestions: { start: Date }[] };
    expect(details.suggestions[0]!.start.toISOString()).toBe(at('10:30').toISOString()); // consult end 10:20 + 10
    expect(await prisma.appointment.count({ where: { doctorId: doctor.id, status: 'CONFIRMED' } })).toBe(1);
  });

  it('concurrent bookings by different Doctors for the last free room: only one gets it', async () => {
    await freeRoomsOnly();
    const [d1, d2] = [await doctorWithHours(), await doctorWithHours()];
    // C01 and C02 are occupied at 11:00, leaving only C03.
    await prisma.roomReservation.createMany({
      data: (await prisma.room.findMany({ where: { code: { in: ['C01', 'C02'] } } })).map((r) => ({ roomId: r.id, startAt: at('11:00'), endAt: at('11:30') })),
    });
    const results = await Promise.allSettled([
      bookAppointment(actor, req(d1.id, (await patient()).id, at('11:00'))),
      bookAppointment(actor, req(d2.id, (await patient()).id, at('11:00'))),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const err = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as SlotUnavailableError;
    expect((err.details as { conflicts: { code: string }[] }).conflicts[0]!.code).toBe('NO_ROOM');
  });

  it('Doctor leave blocks the final save even if the form showed the slot earlier', async () => {
    await freeRoomsOnly();
    const doctor = await doctorWithHours();
    await prisma.doctorAvailabilityException.create({ data: { doctorId: doctor.id, kind: 'LEAVE', date: dateOnly(D), status: 'APPROVED', requestedById: doctor.id } });
    const err = await bookAppointment(actor, req(doctor.id, (await patient()).id, at('12:00'))).catch((e) => e);
    expect(err).toBeInstanceOf(SlotUnavailableError);
    const d = err.details as { conflicts: { code: string }[]; suggestions: { start: Date }[] };
    expect(d.conflicts[0]!.code).toBe('DOCTOR_ON_LEAVE');
    expect(clinicDateStr(new Date(d.suggestions[0]!.start))).toBe(addDaysStr(D, 1));
  });

  it('alternate hours: not bookable while pending, bookable after Manager approval', async () => {
    await freeRoomsOnly();
    const doctor = await doctorWithHours();
    const day = addDaysStr(D, 1);
    const ex = await prisma.doctorAvailabilityException.create({
      data: { doctorId: doctor.id, kind: 'ALTERNATE_HOURS', date: dateOnly(day), startMinute: 6 * 60, endMinute: 8 * 60, status: 'PENDING', requestedById: doctor.id },
    });
    const pending = await bookAppointment(actor, req(doctor.id, (await patient()).id, at('07:00', day))).catch((e) => e);
    expect((pending.details as { conflicts: { code: string }[] }).conflicts[0]!.code).toBe('ALTERNATE_PENDING');
    await prisma.doctorAvailabilityException.update({ where: { id: ex.id }, data: { status: 'APPROVED' } });
    const ok = await bookAppointment(actor, req(doctor.id, (await patient()).id, at('07:00', day)));
    expect(ok.appointment.status).toBe('CONFIRMED');
  });

  it('a future planned procedure occupies the Doctor and room for other bookings (source label)', async () => {
    await freeRoomsOnly();
    const doctor = await doctorWithHours();
    const p = await patient();
    await bookAppointment(actor, { ...req(doctor.id, p.id, at('15:00')), type: 'PROCEDURE', durationMin: 60, source: 'DOCTOR_PLAN', treatmentPlanItemId: `plan-item-${Date.now()}` });
    const err = await bookAppointment(actor, req(doctor.id, (await patient()).id, at('15:30'))).catch((e) => e);
    const d = err.details as { conflicts: { code: string; source?: string }[]; suggestions: { start: Date; reason: { code: string } }[] };
    expect(d.conflicts[0]).toMatchObject({ code: 'DOCTOR_BUSY', source: 'planned_procedure' });
    expect(new Date(d.suggestions[0]!.start).toISOString()).toBe(at('16:20').toISOString());
    expect(d.suggestions[0]!.reason.code).toBe('AFTER_PROCEDURE');
  });

  it('booking with the same idempotency key returns the original appointment', async () => {
    await freeRoomsOnly();
    const doctor = await doctorWithHours();
    const p = await patient();
    const key = `book-${Date.now()}`;
    const a = await bookAppointment(actor, req(doctor.id, p.id, at('13:00'), { idempotencyKey: key }));
    const b = await bookAppointment(actor, req(doctor.id, p.id, at('13:00'), { idempotencyKey: key }));
    expect(b.replayed).toBe(true);
    expect(b.appointment.id).toBe(a.appointment.id);
    expect(await prisma.appointment.count({ where: { doctorId: doctor.id } })).toBe(1);
  });
});

describe('reschedule & cancel (spec §6)', () => {
  it('reschedule saves the new slot, releases the old one atomically, and records history', async () => {
    await freeRoomsOnly();
    const doctor = await doctorWithHours();
    const p = await patient();
    const { appointment } = await bookAppointment(actor, req(doctor.id, p.id, at('16:00')));
    const r = await rescheduleAppointment(actor, appointment.id, { start: at('17:00'), reason: 'Patient request', requestedById: actor.id! });
    expect(r.appointment.rescheduledFromId).toBe(appointment.id);
    const old = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(old.status).toBe('RESCHEDULED');
    expect(await prisma.roomReservation.count({ where: { appointmentId: appointment.id, status: 'ACTIVE' } })).toBe(0);
    const hist = await prisma.rescheduleHistory.findFirstOrThrow({ where: { oldAppointmentId: appointment.id } });
    expect(hist.newAppointmentId).toBe(r.appointment.id);
    // old 16:00 slot is free again
    const again = await bookAppointment(actor, req(doctor.id, (await patient()).id, at('16:00')));
    expect(again.appointment.status).toBe('CONFIRMED');
  });

  it('reschedule into a taken slot fails and leaves the original booking untouched', async () => {
    await freeRoomsOnly();
    const doctor = await doctorWithHours();
    const a = await bookAppointment(actor, req(doctor.id, (await patient()).id, at('18:00')));
    await bookAppointment(actor, req(doctor.id, (await patient()).id, at('19:00')));
    const err = await rescheduleAppointment(actor, a.appointment.id, { start: at('19:00'), reason: 'x', requestedById: actor.id! }).catch((e) => e);
    expect(err).toBeInstanceOf(SlotUnavailableError);
    const still = await prisma.appointment.findUniqueOrThrow({ where: { id: a.appointment.id } });
    expect(still.status).toBe('CONFIRMED');
    expect(await prisma.roomReservation.count({ where: { appointmentId: a.appointment.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('reschedule can move within its own buffer window (old booking excluded from conflicts)', async () => {
    await freeRoomsOnly();
    const doctor = await doctorWithHours();
    const a = await bookAppointment(actor, req(doctor.id, (await patient()).id, at('09:00')));
    const r = await rescheduleAppointment(actor, a.appointment.id, { start: at('09:10'), reason: 'shift 10 min', requestedById: actor.id! });
    expect(r.appointment.startAt.toISOString()).toBe(at('09:10').toISOString());
  });

  it('cancel requires a reason, records who cancelled, and releases the slot', async () => {
    await freeRoomsOnly();
    const doctor = await doctorWithHours();
    const a = await bookAppointment(actor, req(doctor.id, (await patient()).id, at('20:00')));
    await expect(cancelAppointment(actor, a.appointment.id, '  ')).rejects.toThrow(/reason/);
    await cancelAppointment(actor, a.appointment.id, 'Patient cannot come');
    const c = await prisma.appointment.findUniqueOrThrow({ where: { id: a.appointment.id } });
    expect(c.status).toBe('CANCELLED');
    expect(c.cancelledById).toBe(actor.id);
    expect(c.cancelReason).toBe('Patient cannot come');
    const again = await bookAppointment(actor, req(doctor.id, (await patient()).id, at('20:00')));
    expect(again.appointment.status).toBe('CONFIRMED');
  });
});

describe('D-073 — patient seen before the booked time', () => {
  it('a consultation sent to Reception before its start frees that time for the Doctor and the room', async () => {
    await freeRoomsOnly();
    const doctor = await doctorWithHours();
    const [p1, p2] = [await patient(), await patient()];
    const first = await bookAppointment(actor, req(doctor.id, p1.id, at('20:30')));
    await expect(bookAppointment(actor, req(doctor.id, p2.id, at('20:30')))).rejects.toBeInstanceOf(SlotUnavailableError);
    // came early: checked in and seen at 20:15, sent to Reception at 20:20
    await prisma.appointment.update({ where: { id: first.appointment.id }, data: { status: 'RECEPTION', checkedInAt: at('20:15'), sentToReceptionAt: at('20:20') } });
    const second = await bookAppointment(actor, req(doctor.id, p2.id, at('20:30')));
    expect(second.appointment.status).toBe('CONFIRMED');
  });
});

describe('scheduling read API', () => {
  it('slots endpoint hides leave dates and offers next available', async () => {
    const doctor = await doctorWithHours();
    await prisma.doctorAvailabilityException.create({ data: { doctorId: doctor.id, kind: 'LEAVE', date: dateOnly(addDaysStr(D, 5)), status: 'APPROVED', requestedById: doctor.id } });
    const { agent } = await agentFor('RECEPTIONIST');
    const res = await call(agent).get(`/api/scheduling/slots?doctorId=${doctor.id}&type=CONSULTATION&date=${addDaysStr(D, 5)}`);
    expect(res.status).toBe(200);
    expect(res.body.slots).toHaveLength(0);
    expect(res.body.nextAvailable.length).toBeGreaterThan(0);
  });

  it('Office Boy cannot query scheduling (no patient-adjacent data)', async () => {
    const { agent } = await agentFor('OFFICE_BOY');
    expect((await call(agent).get('/api/scheduling/doctors')).status).toBe(403);
  });
});
