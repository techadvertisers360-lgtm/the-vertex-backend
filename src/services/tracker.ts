import type { Appointment } from '@prisma/client';
import type { Db } from '../lib/prisma';
import { publish, roleRoom, userRoom } from './realtime';

/**
 * Live-update fan-out for anything that changes the patient journey (spec §3 active tracker, §10 Doctor queue).
 * Reception + Manager trackers refetch on `tracker:changed`; the Doctor's queue refetches on `queue:changed`.
 * Payloads carry ids only — clients refetch through the API, so role scoping still applies.
 */
export async function journeyChanged(db: Db, appt: Pick<Appointment, 'id' | 'doctorId' | 'status'>): Promise<void> {
  await publish(db, [roleRoom('RECEPTIONIST'), roleRoom('MANAGER')], 'tracker:changed', { appointmentId: appt.id, status: appt.status });
  await publish(db, [userRoom(appt.doctorId)], 'queue:changed', { appointmentId: appt.id, status: appt.status });
}
