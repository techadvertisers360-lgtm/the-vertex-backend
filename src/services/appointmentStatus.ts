import type { Appointment, AppointmentStatus } from '@prisma/client';
import type { Tx } from '../lib/prisma';
import { ConflictError } from '../lib/errors';
import { audit, type Actor } from './audit';

/**
 * Appointment status machine (spec §5, §9 tracker).
 * Draft → Confirmed → Checked-in → Waiting → With Doctor → Reception → Procedure (if any) → Reception → Done.
 * Cancelled / Rescheduled are separate terminal states.
 */
export const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'RESCHEDULED'],
  CHECKED_IN: ['WAITING', 'WITH_DOCTOR', 'RECEPTION', 'PROCEDURE', 'CANCELLED'],
  WAITING: ['WITH_DOCTOR', 'PROCEDURE', 'CANCELLED'],
  WITH_DOCTOR: ['RECEPTION'],
  RECEPTION: ['PROCEDURE', 'DONE'],
  PROCEDURE: ['RECEPTION', 'DONE'],
  DONE: [],
  CANCELLED: [],
  RESCHEDULED: [],
};

export const ACTIVE_STATUSES: AppointmentStatus[] = ['CONFIRMED', 'CHECKED_IN', 'WAITING', 'WITH_DOCTOR', 'RECEPTION', 'PROCEDURE'];
/** Statuses whose time interval still occupies Doctor/room calendars. */
export const OCCUPYING_STATUSES: AppointmentStatus[] = ['DRAFT', ...ACTIVE_STATUSES, 'DONE'];

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Move an appointment to `to` with an optimistic guard on the current status, plus history + audit,
 * all inside the caller's transaction. Concurrent changes produce 409 STATUS_CHANGED.
 */
export async function transitionAppointment(
  tx: Tx,
  actor: Actor,
  appt: Pick<Appointment, 'id' | 'status'>,
  to: AppointmentStatus,
  opts: { reason?: string; data?: Partial<Pick<Appointment, 'checkedInAt' | 'checkedInById' | 'acceptedAt' | 'sentToReceptionAt' | 'doneAt' | 'hiddenFromQueueAt' | 'cancelledAt' | 'cancelledById' | 'cancelReason'>> } = {},
): Promise<void> {
  if (!canTransition(appt.status, to)) {
    throw new ConflictError('INVALID_STATUS_TRANSITION', `Appointment ${appt.status} se ${to} nahi ho sakta.`, { from: appt.status, to });
  }
  const { count } = await tx.appointment.updateMany({ where: { id: appt.id, status: appt.status }, data: { status: to, ...(opts.data ?? {}) } });
  if (count === 0) throw new ConflictError('STATUS_CHANGED', 'Is appointment ka status abhi kisi aur ne badal diya. Refresh karein.');
  await tx.appointmentStatusHistory.create({ data: { appointmentId: appt.id, fromStatus: appt.status, toStatus: to, actorId: actor.id, reason: opts.reason ?? null } });
  await audit(tx, actor, { action: `APPOINTMENT_${to}`, recordType: 'Appointment', recordId: appt.id, before: { status: appt.status }, after: { status: to, ...(opts.data ?? {}) }, reason: opts.reason });
}
