import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { addMinutes, clinicDateStr } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { transitionAppointment } from '../../services/appointmentStatus';
import { announceAppointment } from '../../services/bookingMessages';
import { bookInTx, daySlots, resolveDuration, TX_OPTS } from '../../services/scheduling';
import { checkInTx } from './service';

/**
 * Walk-in desk (client 2026-10-29, D-075): a patient (old or new) walks in and says what they want.
 *  - CONSULTATION / PROCEDURE_DOCTOR: booked at the Doctor's earliest free slot today and checked in at once, so the
 *    patient is in the Doctor's queue; the normal Doctor → Reception → invoice flow follows.
 *  - PROCEDURE_ASSISTANT: no consultation. A same-day procedure (price = service price, Reception may change it) is
 *    put on a one-line plan; Reception may name a Doctor of record or leave it empty (D-076); the patient is at Reception and the
 *    procedure waits for an Assistant + room (same Assign flow as every same-day procedure). The Doctor's calendar is
 *    not taken. The invoice comes from that plan; closing it still needs the prescription photo (spec §4 lock 4).
 * Pharmacy-only walk-ins use the counter sale (D-061).
 */
export type WalkInIntent = 'CONSULTATION' | 'PROCEDURE_DOCTOR' | 'PROCEDURE_ASSISTANT';

export interface WalkInInput {
  patientId: string;
  intent: WalkInIntent;
  doctorId?: string;
  serviceId?: string;
  pricePaisa?: number;
  reason?: string;
}

export async function walkIn(actor: Actor, input: WalkInInput, idempotencyKey: string) {
  const key = `walkin:${idempotencyKey}`;
  const replay = await prisma.appointment.findUnique({ where: { idempotencyKey: key } });
  if (replay) return result(replay.id, true);
  if (input.intent !== 'CONSULTATION' && !input.serviceId) throw new ValidationError('Procedure chunein.');
  if (input.intent === 'PROCEDURE_ASSISTANT') return assistantProcedure(actor, input, key);
  if (!input.doctorId) throw new ValidationError('Doctor chunein.');
  const doctorId = input.doctorId;

  // Doctor sees the patient: the earliest free slot today, then check-in in the same transaction.
  const type = input.intent === 'CONSULTATION' ? 'CONSULTATION' : 'PROCEDURE';
  const today = clinicDateStr(new Date());
  const day = await daySlots({ doctorId, type, date: today, serviceId: input.serviceId });
  const first = day.slots[0];
  if (!first) {
    const next = day.nextAvailable[0];
    throw new ConflictError('NO_SLOT_TODAY', `Doctor ke paas aaj koi khaali waqt nahi.${next ? ' Agla khaali waqt neeche hai — wahan appointment book karein.' : ''}`, { nextAvailable: day.nextAvailable });
  }
  const id = await prisma.$transaction(async (tx) => {
    const { appointment } = await bookInTx(tx, actor, {
      patientId: input.patientId,
      doctorId,
      type,
      serviceId: input.serviceId ?? null,
      reason: input.reason?.trim() || 'Walk-in',
      start: first.start,
      source: 'RECEPTION',
      idempotencyKey: key,
    });
    await checkInTx(tx, actor, appointment.id);
    await announceAppointment(tx, actor, appointment, 'confirmed');
    await audit(tx, actor, { action: 'WALK_IN', recordType: 'Appointment', recordId: appointment.id, after: { intent: input.intent, startAt: appointment.startAt } });
    return appointment.id;
  }, TX_OPTS);
  return result(id, false);
}

async function assistantProcedure(actor: Actor, input: WalkInInput, key: string) {
  if (input.pricePaisa !== undefined && (!Number.isSafeInteger(input.pricePaisa) || input.pricePaisa < 0)) throw new ValidationError('Amount sahi likhein.');
  const id = await prisma.$transaction(async (tx) => {
    const [patient, doctor, svc] = await Promise.all([
      tx.patient.findUnique({ where: { id: input.patientId }, select: { id: true } }),
      input.doctorId ? tx.user.findUnique({ where: { id: input.doctorId }, select: { role: true, active: true } }) : null,
      tx.service.findUnique({ where: { id: input.serviceId! } }),
    ]);
    if (!patient) throw new NotFoundError('Patient');
    if (input.doctorId && (!doctor || doctor.role !== 'DOCTOR' || !doctor.active)) throw new ValidationError('Doctor chunein.');
    const doctorId = input.doctorId ?? null;
    if (!svc || !svc.active || svc.type !== 'PROCEDURE') throw new ValidationError('Procedure chunein.');
    const price = BigInt(input.pricePaisa ?? Number(svc.defaultPricePaisa ?? 0n));
    const now = new Date();
    const end = addMinutes(now, await resolveDuration(tx, 'PROCEDURE', svc.id));

    // Seen by nobody yet: `sentToReceptionAt = start` keeps the Doctor of record's calendar free (D-073).
    const appt = await tx.appointment.create({
      data: { patientId: patient.id, doctorId, type: 'PROCEDURE', serviceId: svc.id, reason: input.reason?.trim() || `Walk-in: ${svc.name}`, startAt: now, endAt: end, status: 'CONFIRMED', source: 'RECEPTION', createdById: actor.id!, idempotencyKey: key },
    });
    await tx.appointmentStatusHistory.create({ data: { appointmentId: appt.id, fromStatus: null, toStatus: 'CONFIRMED', actorId: actor.id, reason: 'Walk-in' } });
    await audit(tx, actor, { action: 'APPOINTMENT_CREATED', recordType: 'Appointment', recordId: appt.id, after: appt });
    await transitionAppointment(tx, actor, appt, 'CHECKED_IN', { data: { checkedInAt: now, checkedInById: actor.id } });
    await transitionAppointment(tx, actor, { id: appt.id, status: 'CHECKED_IN' }, 'RECEPTION', { reason: 'Walk-in procedure — Assistant karega', data: { sentToReceptionAt: now } });

    const plan = await tx.treatmentPlan.create({ data: { patientId: patient.id, doctorId, appointmentId: appt.id, currentVersionNo: 1 } });
    const version = await tx.treatmentPlanVersion.create({
      data: {
        planId: plan.id,
        versionNo: 1,
        consultationReason: 'Walk-in procedure (Reception) — consultation nahi hui',
        consultationFeePaisa: 0n,
        consultationFeeWaived: true,
        itemsSubtotalPaisa: price,
        itemsDiscountPaisa: 0n,
        totalDiscountPaisa: 0n,
        grandTotalPaisa: price,
        advanceRequestedPaisa: 0n,
        balancePaisa: price,
        installmentCount: 0,
        createdById: actor.id!,
      },
    });
    const item = await tx.treatmentPlanItem.create({
      data: { versionId: version.id, sessionNumber: 1, serviceId: svc.id, procedureName: svc.name, sameDay: true, scheduledStart: now, scheduledEnd: end, pricePaisa: price },
    });
    await audit(tx, actor, {
      action: 'WALK_IN',
      recordType: 'Appointment',
      recordId: appt.id,
      after: { intent: input.intent, planItemId: item.id, serviceId: svc.id, pricePaisa: price, servicePricePaisa: svc.defaultPricePaisa },
    });
    return appt.id;
  }, TX_OPTS);
  return result(id, false);
}

/** What the desk shows next: the appointment, and for an Assistant procedure the plan item to assign. */
async function result(appointmentId: string, replayed: boolean) {
  const a = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId }, select: { id: true, startAt: true, status: true, type: true, doctorId: true } });
  const plan = await prisma.treatmentPlan.findUnique({ where: { appointmentId }, select: { id: true, currentVersionNo: true } });
  const item =
    plan && a.status === 'RECEPTION'
      ? await prisma.treatmentPlanItem.findFirst({ where: { version: { planId: plan.id, versionNo: plan.currentVersionNo }, sameDay: true, status: 'PLANNED' }, select: { id: true } })
      : null;
  return { appointment: a, planItemId: item?.id ?? null, replayed };
}
