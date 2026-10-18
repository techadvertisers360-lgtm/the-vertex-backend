import type { Appointment } from '@prisma/client';
import type { Tx } from '../lib/prisma';
import { formatClinic } from '../lib/time';
import type { Actor } from './audit';
import { enqueueMessage } from './messaging';
import { notifyRoles, notifyUsers } from './notifications';
import { journeyChanged } from './tracker';

/** The single set of appointment facts every party receives (spec §20 "same appointment facts"). */
export async function appointmentFacts(tx: Tx, a: Appointment) {
  const [patient, doctor, room, service] = await Promise.all([
    tx.patient.findUniqueOrThrow({ where: { id: a.patientId }, select: { id: true, name: true, phone: true, whatsappConsent: true } }),
    tx.user.findUniqueOrThrow({ where: { id: a.doctorId }, select: { id: true, displayName: true, phone: true } }),
    a.roomId ? tx.room.findUnique({ where: { id: a.roomId }, select: { code: true } }) : null,
    a.serviceId ? tx.service.findUnique({ where: { id: a.serviceId }, select: { name: true } }) : null,
  ]);
  return {
    patient,
    doctor,
    payload: {
      appointmentId: a.id,
      patientName: patient.name,
      doctorName: doctor.displayName,
      when: formatClinic(a.startAt),
      startAt: a.startAt,
      type: a.type === 'PROCEDURE' ? 'Procedure' : 'Consultation',
      service: service?.name ?? null,
      reason: a.reason,
      room: room?.code ?? null,
      location: 'The Vertex Health',
    },
  };
}

type Event = 'confirmed' | 'rescheduled' | 'cancelled';

const SUBJECT: Record<Event, string> = {
  confirmed: 'Nayi appointment confirm',
  rescheduled: 'Appointment reschedule hui',
  cancelled: 'Appointment cancel hui',
};

/**
 * Patient + Doctor get the same booking details by WhatsApp (outbox, delivery tracked); Doctor and Reception
 * get in-app notices; the linked Lead Member is informed when someone else changed their booking.
 * Idempotency keys are per appointment + event + recipient, so retries never duplicate messages.
 */
export async function announceAppointment(tx: Tx, actor: Actor, a: Appointment, event: Event, extra: { reason?: string; previousStartAt?: Date } = {}) {
  const { patient, doctor, payload } = await appointmentFacts(tx, a);
  const full = { ...payload, event, reason: extra.reason ?? payload.reason, previousWhen: extra.previousStartAt ? formatClinic(extra.previousStartAt) : null };
  const template = `appointment_${event}`;

  if (patient.whatsappConsent) {
    await enqueueMessage(tx, {
      template,
      toPhone: patient.phone,
      patientId: patient.id,
      payload: full,
      relatedType: 'Appointment',
      relatedId: a.id,
      idempotencyKey: `appointment:${a.id}:${event}:patient`,
      createdById: actor.id,
    });
  }
  if (doctor.phone) {
    await enqueueMessage(tx, {
      template,
      toPhone: doctor.phone,
      recipientUserId: doctor.id,
      payload: full,
      relatedType: 'Appointment',
      relatedId: a.id,
      idempotencyKey: `appointment:${a.id}:${event}:doctor`,
      createdById: actor.id,
    });
  }

  const body = `${payload.patientName} · ${payload.doctorName} · ${payload.when} · ${payload.type}${payload.service ? ` (${payload.service})` : ''}${payload.room ? ` · Room ${payload.room}` : ''}`;
  const n = { type: `APPOINTMENT_${event.toUpperCase()}`, subject: SUBJECT[event], body, recordType: 'Appointment', recordId: a.id, sender: actor, actionLabel: 'Open appointment' };
  await notifyUsers(tx, [doctor.id], { ...n, dedupeKey: `appointment:${a.id}:${event}:doctor` });
  await notifyRoles(tx, ['RECEPTIONIST'], { ...n, dedupeKey: `appointment:${a.id}:${event}:reception` });
  if (a.leadMemberId && a.leadMemberId !== actor.id) {
    await notifyUsers(tx, [a.leadMemberId], { ...n, dedupeKey: `appointment:${a.id}:${event}:lead` });
  }
  await journeyChanged(tx, a);
}
