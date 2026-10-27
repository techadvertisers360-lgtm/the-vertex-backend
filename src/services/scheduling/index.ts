import type { Appointment, AppointmentSource, AppointmentType, RoomKind } from '@prisma/client';
import { prisma, TX_MAX_WAIT_MS, TX_TIMEOUT_MS, type Tx } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { addDaysStr, addMinutes, ceilToStep, clinicDateStr, clinicDayBounds, dateOnly, dateOnlyStr } from '../../lib/time';
import { audit, type Actor } from '../audit';
import { OCCUPYING_STATUSES, transitionAppointment } from '../appointmentStatus';
import { getSetting } from '../settings';
import {
  buildDoctorDay,
  checkSlot,
  listDaySlots,
  roomKindsFor,
  suggest,
  type CheckResult,
  type Conflict,
  type EngineData,
  type SlotRequest,
  type Suggestion,
} from './engine';

export * from './engine';

const PAST_GRACE_MIN = 10;

export async function engineConfig(db: Tx | typeof prisma = prisma) {
  return {
    consultBufferMin: await getSetting('scheduling.consultBufferMin', db),
    procedureBufferMin: await getSetting('scheduling.procedureBufferMin', db),
    slotStepMin: await getSetting('scheduling.slotStepMin', db),
    horizonDays: await getSetting('scheduling.searchHorizonDays', db),
    pastGraceMin: PAST_GRACE_MIN,
  };
}

/** Duration: per-service override, else the type default setting (spec §26 #1). */
export async function resolveDuration(db: Tx | typeof prisma, type: AppointmentType, serviceId?: string | null): Promise<number> {
  if (serviceId) {
    const svc = await db.service.findUnique({ where: { id: serviceId } });
    if (!svc || !svc.active) throw new ValidationError('Service nahi mili.');
    if (svc.type !== type) throw new ValidationError('Service ka type appointment type se match nahi karta.');
    if (svc.durationMin) return svc.durationMin;
  }
  return type === 'PROCEDURE' ? getSetting('scheduling.procedureDurationMin', db) : getSetting('scheduling.consultDurationMin', db);
}

export interface LoadOptions {
  doctorId: string;
  type: AppointmentType;
  fromDate: string; // clinic-local date
  days?: number;
  excludeAppointmentIds?: string[];
  now?: Date;
}

/**
 * Build the engine input from the DB. When called inside a booking transaction (after the locks are taken)
 * the data is the authoritative state for the final check.
 */
export async function loadEngineData(db: Tx | typeof prisma, o: LoadOptions): Promise<EngineData & { roomCodes: Map<string, string> }> {
  const config = await engineConfig(db);
  const now = o.now ?? new Date();
  const days = o.days ?? config.horizonDays;
  const from = o.fromDate;
  const to = addDaysStr(from, days + 1);
  const rangeStart = clinicDayBounds(addDaysStr(from, -1)).start;
  const rangeEnd = clinicDayBounds(to).end;
  const exclude = o.excludeAppointmentIds ?? [];
  const cleanMin = await getSetting('sla.roomCleanMinutes', db);

  const [schedules, exceptions, appts, rooms] = await Promise.all([
    db.doctorSchedule.findMany({ where: { doctorId: o.doctorId, active: true } }),
    db.doctorAvailabilityException.findMany({
      where: { doctorId: o.doctorId, date: { gte: dateOnly(addDaysStr(from, -1)), lte: dateOnly(to) }, status: { in: ['APPROVED', 'PENDING'] } },
    }),
    db.appointment.findMany({
      where: {
        doctorId: o.doctorId,
        status: { in: OCCUPYING_STATUSES },
        startAt: { lt: rangeEnd },
        endAt: { gt: new Date(rangeStart.getTime() - 60 * 60_000) },
        ...(exclude.length ? { id: { notIn: exclude } } : {}),
      },
      select: { id: true, startAt: true, endAt: true, type: true, status: true, treatmentPlanItemId: true, sentToReceptionAt: true, doneAt: true },
    }),
    db.room.findMany({ where: { kind: { in: roomKindsFor(o.type) }, active: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
  ]);

  // Consultation rooms the Manager assigned to Doctors (D-049): this Doctor's own room first, rooms assigned to other
  // Doctors last — the engine takes the first free room in this order, so a free assigned room is always used.
  // Consultation + Procedure rooms (D-063) come after the dedicated rooms, so they stay free for the other type.
  const shared = (k: RoomKind) => (k === 'CONSULT_PROCEDURE' ? 1 : 0);
  if (o.type === 'CONSULTATION') {
    const owners = await db.doctorProfile.findMany({ where: { defaultRoomId: { not: null } }, select: { userId: true, defaultRoomId: true } });
    const mine = owners.find((x) => x.userId === o.doctorId)?.defaultRoomId ?? null;
    const others = new Set(owners.filter((x) => x.userId !== o.doctorId).map((x) => x.defaultRoomId));
    const rank = (r: { id: string; kind: RoomKind }) => (r.id === mine ? 0 : others.has(r.id) ? 3 : 1 + shared(r.kind));
    rooms.sort((a, b) => rank(a) - rank(b)); // stable: keeps sortOrder within each group
  } else {
    rooms.sort((a, b) => shared(a.kind) - shared(b.kind));
  }
  const reservations = await db.roomReservation.findMany({
    where: {
      roomId: { in: rooms.map((r) => r.id) },
      OR: [{ status: 'ACTIVE', startAt: { lt: rangeEnd }, endAt: { gt: rangeStart } }, { status: 'AWAITING_CLEAN' }],
      ...(exclude.length ? { NOT: { appointmentId: { in: exclude } } } : {}),
    },
    include: { appointment: { select: { status: true, treatmentPlanItemId: true } } },
  });

  const dayMap = new Map<string, ReturnType<typeof buildDoctorDay>>();
  const scheduleRows = schedules.map((s) => ({
    weekday: s.weekday,
    startMinute: s.startMinute,
    endMinute: s.endMinute,
    effectiveFrom: dateOnlyStr(s.effectiveFrom),
    effectiveTo: s.effectiveTo ? dateOnlyStr(s.effectiveTo) : null,
    active: s.active,
  }));
  const exceptionRows = exceptions.map((e) => ({ kind: e.kind, status: e.status, date: dateOnlyStr(e.date), startMinute: e.startMinute, endMinute: e.endMinute }));
  for (let i = -1; i <= days + 1; i++) {
    const date = addDaysStr(from, i);
    dayMap.set(date, buildDoctorDay(date, scheduleRows, exceptionRows));
  }

  const overrunEnd = ceilToStep(addMinutes(now, 1), config.slotStepMin);
  const doctorBusy = appts.map((a) => {
    let end = a.endAt;
    // Consultation finished early (sent to Reception / done) frees the Doctor from that moment.
    const finishedAt = a.sentToReceptionAt ?? a.doneAt;
    if (finishedAt && finishedAt < end && finishedAt > a.startAt) end = finishedAt;
    // In-progress visit running past its scheduled end keeps the Doctor busy until now.
    if ((a.status === 'WITH_DOCTOR' || a.status === 'PROCEDURE') && end < now) end = overrunEnd;
    return { id: a.id, start: a.startAt, end, type: a.type, source: a.treatmentPlanItemId ? ('planned_procedure' as const) : ('appointment' as const) };
  });

  const roomBusy = reservations.map((r) => {
    let end = r.endAt;
    let source: 'appointment' | 'planned_procedure' | 'awaiting_clean' = r.appointment?.treatmentPlanItemId ? 'planned_procedure' : 'appointment';
    if (r.status === 'AWAITING_CLEAN') {
      // Room stays occupied until clean evidence; assume at least the cleaning SLA from now.
      const minEnd = addMinutes(now, cleanMin);
      if (end < minEnd) end = minEnd;
      source = 'awaiting_clean';
    } else if (r.appointment && (r.appointment.status === 'WITH_DOCTOR' || r.appointment.status === 'PROCEDURE') && end < now) {
      end = overrunEnd;
    }
    return { roomId: r.roomId, start: r.startAt, end, source, refId: r.appointmentId ?? r.procedureTaskId ?? r.id };
  });

  return {
    now,
    doctorId: o.doctorId,
    days: dayMap,
    doctorBusy,
    rooms: rooms.map((r) => ({ id: r.id, code: r.code, kind: r.kind })),
    roomBusy,
    config,
    roomCodes: new Map(rooms.map((r) => [r.id, r.code])),
  };
}

/**
 * Lock the Doctor row and every room of the needed kinds, in a fixed order (doctors by id, then rooms by id),
 * so concurrent bookings that could collide serialize and cannot double-book (spec §6 row 10).
 */
export async function lockForScheduling(tx: Tx, doctorIds: string[], kinds: RoomKind[]): Promise<void> {
  for (const doctorId of [...new Set(doctorIds)].sort()) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM doctor_profiles WHERE userId = ${doctorId} FOR UPDATE`;
    if (!rows.length) throw new ValidationError('Doctor nahi mila.');
  }
  // Consultation + Procedure rooms serve both types, so every booking also locks them (same sorted order → no deadlock).
  for (const kind of [...new Set<RoomKind>([...kinds, 'CONSULT_PROCEDURE'])].sort()) {
    await tx.$queryRaw`SELECT id FROM rooms WHERE kind = ${kind} ORDER BY id FOR UPDATE`;
  }
}

export const TX_OPTS = { isolationLevel: 'ReadCommitted' as const, timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS };

/** Human message for the primary conflict (spec §24 wording). */
export function conflictMessage(conflicts: Conflict[]): string {
  const c = conflicts[0];
  switch (c?.code) {
    case 'DOCTOR_ON_LEAVE':
      return 'Doctor us waqt chutti par hain. Agla available date/time chunein.';
    case 'ALTERNATE_PENDING':
      return 'Yeh alternate time abhi Manager approval pending hai — booking nahi ho sakti.';
    case 'OUTSIDE_HOURS':
      return 'Doctor is waqt available nahi hain.';
    case 'DOCTOR_BUSY':
      return c.source === 'planned_procedure' ? 'Doctor is waqt planned procedure mein hain.' : 'Doctor is waqt doosri appointment mein hain.';
    case 'NO_ROOM':
      return 'Is waqt koi compatible room free nahi. Agla free room/time chunein.';
    case 'ROOM_BUSY':
      return 'Yeh room is waqt busy hai.';
    case 'ROOM_TYPE_MISMATCH':
      return 'Room type appointment type se match nahi karta.';
    case 'PAST':
      return 'Guzra hua waqt book nahi ho sakta.';
    default:
      return 'Yeh slot available nahi.';
  }
}

export function presentSuggestions(s: Suggestion[], roomCodes: Map<string, string>) {
  return s.map((x) => ({ start: x.start, end: x.end, roomId: x.roomId, roomCode: roomCodes.get(x.roomId) ?? null, reason: x.reason }));
}

export function presentConflicts(c: Conflict[], roomCodes: Map<string, string>) {
  return c.map((k) => {
    if (k.code === 'NO_ROOM') return { ...k, rooms: k.rooms.map((r) => ({ ...r, roomCode: roomCodes.get(r.roomId) ?? null })) };
    if (k.code === 'ROOM_BUSY' || k.code === 'ROOM_TYPE_MISMATCH') return { ...k, roomCode: roomCodes.get(k.roomId) ?? null };
    return k;
  });
}

export class SlotUnavailableError extends ConflictError {
  constructor(conflicts: Conflict[], suggestions: Suggestion[], roomCodes: Map<string, string>) {
    super('SLOT_UNAVAILABLE', conflictMessage(conflicts), {
      conflicts: presentConflicts(conflicts, roomCodes),
      suggestions: presentSuggestions(suggestions, roomCodes),
    });
  }
}

async function assertDoctor(db: Tx | typeof prisma, doctorId: string): Promise<void> {
  const d = await db.user.findUnique({ where: { id: doctorId }, select: { role: true, active: true } });
  if (!d || d.role !== 'DOCTOR' || !d.active) throw new ValidationError('Doctor nahi mila ya active nahi.');
}

/** Read-only check for the booking form (not authoritative — final save re-checks under lock). */
export async function checkAvailability(input: { doctorId: string; type: AppointmentType; start: Date; serviceId?: string | null; durationMin?: number; roomId?: string; excludeAppointmentId?: string }) {
  await assertDoctor(prisma, input.doctorId);
  const durationMin = input.durationMin ?? (await resolveDuration(prisma, input.type, input.serviceId));
  const data = await loadEngineData(prisma, {
    doctorId: input.doctorId,
    type: input.type,
    fromDate: clinicDateStr(input.start),
    excludeAppointmentIds: input.excludeAppointmentId ? [input.excludeAppointmentId] : [],
  });
  const req: SlotRequest = { type: input.type, start: input.start, durationMin, roomId: input.roomId };
  const res = checkSlot(data, req);
  return res.ok
    ? { ok: true as const, start: res.start, end: res.end, roomId: res.roomId, roomCode: data.roomCodes.get(res.roomId) ?? null }
    : { ok: false as const, message: conflictMessage(res.conflicts), conflicts: presentConflicts(res.conflicts, data.roomCodes), suggestions: presentSuggestions(suggest(data, req), data.roomCodes) };
}

export async function daySlots(input: { doctorId: string; type: AppointmentType; date: string; serviceId?: string | null }) {
  await assertDoctor(prisma, input.doctorId);
  const durationMin = await resolveDuration(prisma, input.type, input.serviceId);
  const data = await loadEngineData(prisma, { doctorId: input.doctorId, type: input.type, fromDate: input.date, days: 1 });
  const out = listDaySlots(data, input.date, input.type, durationMin);
  const empty = out.slots.length === 0;
  let next: ReturnType<typeof presentSuggestions> = [];
  if (empty) {
    // Doctor unavailable / fully booked: offer next available date/time (spec §6 row 2, §24).
    const full = await loadEngineData(prisma, { doctorId: input.doctorId, type: input.type, fromDate: input.date });
    const day = full.days.get(input.date);
    const probe = day?.windows[0]?.start ?? clinicDayBounds(input.date).start;
    next = presentSuggestions(suggest(full, { type: input.type, start: probe, durationMin }, 3), full.roomCodes);
  }
  return { ...out, durationMin, slots: out.slots.map((s) => ({ ...s, roomCode: data.roomCodes.get(s.roomId) ?? null })), nextAvailable: next };
}

export interface BookInput {
  patientId: string;
  doctorId: string;
  type: AppointmentType;
  serviceId?: string | null;
  reason?: string | null;
  start: Date;
  durationMin?: number;
  roomId?: string;
  source: AppointmentSource;
  leadId?: string | null;
  leadMemberId?: string | null;
  sheetId?: string | null;
  treatmentPlanItemId?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Authoritative booking inside the caller's transaction: lock → reload → check → create appointment +
 * room reservation + status history + audit. Throws SlotUnavailableError (409) with fresh alternatives.
 * Use `bookAppointment` for a standalone transaction.
 */
export async function bookInTx(tx: Tx, actor: Actor, input: BookInput): Promise<{ appointment: Appointment; replayed: boolean }> {
  if (input.idempotencyKey) {
    const existing = await tx.appointment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return { appointment: existing, replayed: true };
  }
  await assertDoctor(tx, input.doctorId);
  const patient = await tx.patient.findUnique({ where: { id: input.patientId }, select: { id: true } });
  if (!patient) throw new NotFoundError('Patient');

  await lockForScheduling(tx, [input.doctorId], roomKindsFor(input.type));
  const durationMin = input.durationMin ?? (await resolveDuration(tx, input.type, input.serviceId));
  const data = await loadEngineData(tx, { doctorId: input.doctorId, type: input.type, fromDate: clinicDateStr(input.start) });
  const req: SlotRequest = { type: input.type, start: input.start, durationMin, roomId: input.roomId };
  const res: CheckResult = checkSlot(data, req);
  if (!res.ok) throw new SlotUnavailableError(res.conflicts, suggest(data, req), data.roomCodes);

  const appointment = await tx.appointment.create({
    data: {
      patientId: input.patientId,
      doctorId: input.doctorId,
      type: input.type,
      serviceId: input.serviceId ?? null,
      reason: input.reason ?? null,
      startAt: res.start,
      endAt: res.end,
      roomId: res.roomId,
      status: 'CONFIRMED',
      source: input.source,
      createdById: actor.id!,
      leadId: input.leadId ?? null,
      leadMemberId: input.leadMemberId ?? null,
      sheetId: input.sheetId ?? null,
      treatmentPlanItemId: input.treatmentPlanItemId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });
  await tx.roomReservation.create({ data: { roomId: res.roomId, appointmentId: appointment.id, startAt: res.start, endAt: res.end } });
  await tx.appointmentStatusHistory.create({ data: { appointmentId: appointment.id, fromStatus: null, toStatus: 'CONFIRMED', actorId: actor.id } });
  await audit(tx, actor, { action: 'APPOINTMENT_CREATED', recordType: 'Appointment', recordId: appointment.id, after: appointment });
  return { appointment, replayed: false };
}

export async function bookAppointment(actor: Actor, input: BookInput, afterCreate?: (tx: Tx, a: Appointment) => Promise<void>) {
  return prisma.$transaction(async (tx) => {
    const r = await bookInTx(tx, actor, input);
    if (!r.replayed && afterCreate) await afterCreate(tx, r.appointment);
    return r;
  }, TX_OPTS);
}

export interface RescheduleInput {
  start: Date;
  roomId?: string;
  reason: string;
  requestedById: string;
  approvedById?: string | null;
}

/**
 * Atomic reschedule (spec §6): verify the new Doctor + room slot (excluding the old booking), save the new
 * appointment, then release the old slot — all in one transaction. Old → RESCHEDULED; history row written.
 */
export async function rescheduleInTx(tx: Tx, actor: Actor, appointmentId: string, input: RescheduleInput) {
  const old = await tx.appointment.findUnique({ where: { id: appointmentId } });
  if (!old) throw new NotFoundError('Appointment');
  if (old.status !== 'CONFIRMED' && old.status !== 'DRAFT') {
    throw new ConflictError('NOT_RESCHEDULABLE', 'Sirf confirmed (check-in se pehle) appointment reschedule ho sakti hai.');
  }
  await lockForScheduling(tx, [old.doctorId], roomKindsFor(old.type));
  const fresh = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  if (fresh.status !== old.status) throw new ConflictError('STATUS_CHANGED', 'Is appointment ka status abhi badal gaya. Refresh karein.');

  const durationMin = Math.round((old.endAt.getTime() - old.startAt.getTime()) / 60_000);
  const data = await loadEngineData(tx, { doctorId: old.doctorId, type: old.type, fromDate: clinicDateStr(input.start), excludeAppointmentIds: [old.id] });
  const req: SlotRequest = { type: old.type, start: input.start, durationMin, roomId: input.roomId };
  const res = checkSlot(data, req);
  if (!res.ok) throw new SlotUnavailableError(res.conflicts, suggest(data, req), data.roomCodes);

  // Plan-item link moves to the new appointment (unique column), lineage kept via rescheduledFromId.
  const planItemId = old.treatmentPlanItemId;
  if (planItemId) await tx.appointment.update({ where: { id: old.id }, data: { treatmentPlanItemId: null } });

  const created = await tx.appointment.create({
    data: {
      patientId: old.patientId,
      doctorId: old.doctorId,
      type: old.type,
      serviceId: old.serviceId,
      reason: old.reason,
      startAt: res.start,
      endAt: res.end,
      roomId: res.roomId,
      status: 'CONFIRMED',
      source: old.source,
      createdById: actor.id!,
      leadId: old.leadId,
      leadMemberId: old.leadMemberId,
      sheetId: old.sheetId,
      treatmentPlanItemId: planItemId,
      rescheduledFromId: old.id,
    },
  });
  await tx.roomReservation.create({ data: { roomId: res.roomId, appointmentId: created.id, startAt: res.start, endAt: res.end } });
  await tx.appointmentStatusHistory.create({ data: { appointmentId: created.id, fromStatus: null, toStatus: 'CONFIRMED', actorId: actor.id, reason: `Rescheduled from ${old.id}` } });

  await transitionAppointment(tx, actor, old, 'RESCHEDULED', { reason: input.reason });
  await tx.roomReservation.updateMany({ where: { appointmentId: old.id, status: 'ACTIVE' }, data: { status: 'RELEASED', releasedAt: new Date() } });
  await tx.rescheduleHistory.create({
    data: {
      oldAppointmentId: old.id,
      newAppointmentId: created.id,
      oldStartAt: old.startAt,
      newStartAt: created.startAt,
      oldRoomId: old.roomId,
      newRoomId: created.roomId,
      requestedById: input.requestedById,
      approvedById: input.approvedById ?? null,
      reason: input.reason,
    },
  });
  await audit(tx, actor, {
    action: 'APPOINTMENT_RESCHEDULED',
    recordType: 'Appointment',
    recordId: old.id,
    before: { startAt: old.startAt, roomId: old.roomId },
    after: { newAppointmentId: created.id, startAt: created.startAt, roomId: created.roomId },
    reason: input.reason,
  });
  return { old, appointment: created };
}

export async function rescheduleAppointment(actor: Actor, appointmentId: string, input: RescheduleInput, after?: (tx: Tx, r: { old: Appointment; appointment: Appointment }) => Promise<void>) {
  return prisma.$transaction(async (tx) => {
    const r = await rescheduleInTx(tx, actor, appointmentId, input);
    if (after) await after(tx, r);
    return r;
  }, TX_OPTS);
}

/** Cancel with reason + actor; releases the slot (spec §6). Lead "Not Interested" is a lead outcome, not this. */
export async function cancelInTx(tx: Tx, actor: Actor, appointmentId: string, reason: string) {
  if (!reason.trim()) throw new ValidationError('Cancel reason zaroori hai.');
  const appt = await tx.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) throw new NotFoundError('Appointment');
  await transitionAppointment(tx, actor, appt, 'CANCELLED', {
    reason,
    data: { cancelledAt: new Date(), cancelledById: actor.id, cancelReason: reason, hiddenFromQueueAt: new Date() },
  });
  await tx.roomReservation.updateMany({ where: { appointmentId, status: 'ACTIVE' }, data: { status: 'CANCELLED', releasedAt: new Date() } });
  return appt;
}

export async function cancelAppointment(actor: Actor, appointmentId: string, reason: string, after?: (tx: Tx, a: Appointment) => Promise<void>) {
  return prisma.$transaction(async (tx) => {
    const a = await cancelInTx(tx, actor, appointmentId, reason);
    if (after) await after(tx, a);
    return a;
  }, TX_OPTS);
}
