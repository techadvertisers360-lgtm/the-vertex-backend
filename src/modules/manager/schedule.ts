import { prisma, type Tx } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { clinicDateStr, dateOnly, dateOnlyStr, formatClinic } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { announceAppointment } from '../../services/bookingMessages';
import { notifyUsers } from '../../services/notifications';
import { cancelAppointment, rescheduleAppointment } from '../../services/scheduling';
import { leaveImpact } from '../doctor/service';

/**
 * Manager scheduling (spec §6, §14): Doctor leave impact, reschedule requests and Manager reschedule / cancel.
 * A reschedule happens only after the Manager records patient and Doctor confirmation (spec §25 #14); the
 * scheduling engine re-checks the new slot inside the transaction and the old slot is released only on success.
 */

async function apptCard(ids: string[]) {
  const rows = await prisma.appointment.findMany({
    where: { id: { in: ids } },
    select: { id: true, startAt: true, endAt: true, type: true, status: true, roomId: true, doctorId: true, leadMemberId: true, treatmentPlanItemId: true, source: true, patient: { select: { id: true, name: true, phone: true } } },
  });
  const [users, rooms, items] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.doctorId, r.leadMemberId].filter((x): x is string => !!x)))] } }, select: { id: true, displayName: true } }),
    prisma.room.findMany({ select: { id: true, code: true } }),
    prisma.treatmentPlanItem.findMany({ where: { id: { in: rows.map((r) => r.treatmentPlanItemId).filter((x): x is string => !!x) } }, select: { id: true, procedureName: true, sessionNumber: true } }),
  ]);
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? null) : null);
  return rows.map((r) => ({
    ...r,
    doctorName: name(r.doctorId),
    leadMemberName: name(r.leadMemberId),
    roomCode: rooms.find((x) => x.id === r.roomId)?.code ?? null,
    plannedProcedure: items.find((i) => i.id === r.treatmentPlanItemId) ?? null,
  }));
}

/** Doctor leave/absence with patients still booked inside it (spec §11, §14). Stays listed until resolved. */
export async function leaveImpacts() {
  const rows = await prisma.doctorAvailabilityException.findMany({ where: { kind: { in: ['LEAVE', 'ABSENT'] }, status: 'APPROVED', impactResolvedAt: null }, orderBy: { date: 'asc' } });
  const doctors = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.doctorId) } }, select: { id: true, displayName: true } });
  const out = [];
  for (const ex of rows) {
    const date = dateOnlyStr(ex.date);
    const impact = await leaveImpact(ex.doctorId, { date, startMinute: ex.startMinute ?? undefined, endMinute: ex.endMinute ?? undefined });
    out.push({
      id: ex.id,
      kind: ex.kind,
      date,
      startMinute: ex.startMinute,
      endMinute: ex.endMinute,
      reason: ex.reason,
      doctorId: ex.doctorId,
      doctorName: doctors.find((d) => d.id === ex.doctorId)?.displayName ?? null,
      createdAt: ex.createdAt,
      affected: await apptCard(impact.items.map((i) => i.id)),
    });
  }
  return { items: out };
}

/** Close a leave impact once no affected patient is left (spec §14 "issue remains pending until complete"). */
export async function resolveLeaveImpact(actor: Actor, id: string) {
  const ex = await prisma.doctorAvailabilityException.findUnique({ where: { id } });
  if (!ex || ex.kind === 'ALTERNATE_HOURS') throw new NotFoundError('Leave');
  if (ex.impactResolvedAt) return { id, resolved: true };
  const impact = await leaveImpact(ex.doctorId, { date: dateOnlyStr(ex.date), startMinute: ex.startMinute ?? undefined, endMinute: ex.endMinute ?? undefined });
  if (impact.count) throw new ConflictError('IMPACT_PENDING', `Abhi ${impact.count} patient is leave mein booked hain — pehle reschedule ya cancel karein.`, { count: impact.count });
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.doctorAvailabilityException.updateMany({ where: { id, impactResolvedAt: null }, data: { impactResolvedAt: new Date() } });
    if (!count) return;
    await tx.workflowTask.updateMany({ where: { idempotencyKey: `availability:${id}:impact`, status: { in: ['PENDING', 'IN_PROGRESS', 'BLOCKED'] } }, data: { status: 'COMPLETED', completedAt: new Date(), completedById: actor.id } });
    await audit(tx, actor, { action: 'LEAVE_IMPACT_RESOLVED', recordType: 'DoctorAvailabilityException', recordId: id });
  });
  return { id, resolved: true };
}

export interface ManagerRescheduleInput {
  start: Date;
  roomId?: string;
  reason: string;
  patientConfirmed: boolean;
  doctorConfirmed: boolean;
  requestId?: string;
}

/**
 * Manager reschedule (spec §6 row "Manager reschedule"): new slot verified by the engine, old slot released,
 * history written, and patient / Doctor / Reception / linked Lead informed. Requires both confirmations.
 */
export async function managerReschedule(actor: Actor, appointmentId: string, input: ManagerRescheduleInput) {
  if (!input.patientConfirmed || !input.doctorConfirmed) throw new ValidationError('Patient aur Doctor dono ki confirmation record karein — phir reschedule hoga.');
  if (input.reason.trim().length < 2) throw new ValidationError('Reschedule ki wajah likhein.');
  const r = await rescheduleAppointment(
    actor,
    appointmentId,
    { start: input.start, roomId: input.roomId, reason: input.reason.trim(), requestedById: actor.id!, approvedById: actor.id },
    async (tx: Tx, res) => {
      if (input.requestId) {
        const req = await tx.rescheduleRequest.findUnique({ where: { id: input.requestId } });
        if (!req || req.appointmentId !== appointmentId) throw new ValidationError('Request is appointment ki nahi.');
        if (!['PENDING', 'IN_REVIEW'].includes(req.status)) throw new ConflictError('ALREADY_DECIDED', 'Is request par faisla ho chuka hai.');
        await tx.rescheduleRequest.update({ where: { id: req.id }, data: { status: 'APPROVED', patientConfirmed: true, doctorConfirmed: true, decidedById: actor.id, decidedAt: new Date(), decisionReason: input.reason.trim(), newAppointmentId: res.appointment.id } });
        if (req.requestedById !== actor.id) {
          await notifyUsers(tx, [req.requestedById], { type: 'RESCHEDULE_APPROVED', subject: 'Reschedule approve hua', body: `Nayi date: ${formatClinic(res.appointment.startAt)}`, recordType: 'Appointment', recordId: res.appointment.id, sender: actor, dedupeKey: `reschedule:${req.id}:approved` });
        }
      } else {
        // a direct Manager reschedule closes any open request for the same appointment
        await tx.rescheduleRequest.updateMany({ where: { appointmentId, status: { in: ['PENDING', 'IN_REVIEW'] } }, data: { status: 'APPROVED', patientConfirmed: true, doctorConfirmed: true, decidedById: actor.id, decidedAt: new Date(), decisionReason: input.reason.trim(), newAppointmentId: res.appointment.id } });
      }
      await audit(tx, actor, { action: 'RESCHEDULE_CONFIRMED', recordType: 'Appointment', recordId: appointmentId, after: { patientConfirmed: true, doctorConfirmed: true, newAppointmentId: res.appointment.id, requestId: input.requestId ?? null } });
      await announceAppointment(tx, actor, res.appointment, 'rescheduled', { reason: input.reason.trim(), previousStartAt: res.old.startAt });
    },
  );
  return { appointment: r.appointment, previousStartAt: r.old.startAt };
}

export async function managerCancel(actor: Actor, appointmentId: string, reason: string) {
  if (reason.trim().length < 2) throw new ValidationError('Cancel ki wajah likhein.');
  return cancelAppointment(actor, appointmentId, reason.trim(), async (tx, a) => {
    await tx.rescheduleRequest.updateMany({ where: { appointmentId, status: { in: ['PENDING', 'IN_REVIEW'] } }, data: { status: 'REJECTED', decidedById: actor.id, decidedAt: new Date(), decisionReason: `Appointment cancelled: ${reason.trim()}` } });
    const cancelled = await tx.appointment.findUniqueOrThrow({ where: { id: a.id } });
    await announceAppointment(tx, actor, cancelled, 'cancelled', { reason: reason.trim() });
  });
}

export async function rescheduleRequests() {
  const rows = await prisma.rescheduleRequest.findMany({ where: { status: { in: ['PENDING', 'IN_REVIEW'] } }, orderBy: { createdAt: 'asc' } });
  const [cards, users] = await Promise.all([apptCard(rows.map((r) => r.appointmentId)), prisma.user.findMany({ where: { id: { in: rows.map((r) => r.requestedById) } }, select: { id: true, displayName: true, role: true } })]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      requestedStartAt: r.requestedStartAt,
      status: r.status,
      createdAt: r.createdAt,
      requestedBy: users.find((u) => u.id === r.requestedById) ?? null,
      appointment: cards.find((c) => c.id === r.appointmentId) ?? null,
    })),
  };
}

export async function rejectRescheduleRequest(actor: Actor, id: string, reason: string) {
  if (reason.trim().length < 2) throw new ValidationError('Reject ki wajah likhein.');
  return prisma.$transaction(async (tx) => {
    const r = await tx.rescheduleRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundError('Reschedule request');
    const { count } = await tx.rescheduleRequest.updateMany({ where: { id, status: { in: ['PENDING', 'IN_REVIEW'] } }, data: { status: 'REJECTED', decidedById: actor.id, decidedAt: new Date(), decisionReason: reason.trim() } });
    if (!count) throw new ConflictError('ALREADY_DECIDED', 'Is request par faisla ho chuka hai.');
    await audit(tx, actor, { action: 'RESCHEDULE_REJECTED', recordType: 'RescheduleRequest', recordId: id, reason: reason.trim() });
    if (r.requestedById !== actor.id) await notifyUsers(tx, [r.requestedById], { type: 'RESCHEDULE_REJECTED', subject: 'Reschedule request reject hui', body: reason.trim(), recordType: 'Appointment', recordId: r.appointmentId, sender: actor, dedupeKey: `reschedule:${id}:rejected` });
    return { id, status: 'REJECTED' as const };
  });
}

/** Upcoming appointments for a Doctor/day, for the schedule screen. */
export async function doctorDay(doctorId: string, date?: string) {
  const d = date ?? clinicDateStr(new Date());
  const from = dateOnly(d);
  const rows = await prisma.appointment.findMany({
    where: { doctorId, startAt: { gte: new Date(from.getTime() - 6 * 3600_000), lt: new Date(from.getTime() + 30 * 3600_000) }, status: { notIn: ['CANCELLED', 'RESCHEDULED'] } },
    select: { id: true },
  });
  return { date: d, items: (await apptCard(rows.map((r) => r.id))).filter((a) => clinicDateStr(a.startAt) === d).sort((a, b) => a.startAt.getTime() - b.startAt.getTime()) };
}
