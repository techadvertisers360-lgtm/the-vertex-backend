import type { Role } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ConflictError, LockedError } from '../../lib/errors';
import { clinicDate, formatClinic } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { notifyRoles } from '../../services/notifications';

/**
 * Staff attendance (spec §9, §12, §13): check-in / check-out timestamps; every check-in notifies the Manager
 * separately (spec §20, one notification per person). Role-specific check-out gates are registered by the
 * Assistant (room closing, §12) and Office Boy (final report, §13) modules.
 */
export type CheckoutGuard = (tx: Tx, actor: Actor, attendanceId: string) => Promise<void>;
export type CheckinHook = (tx: Tx, actor: Actor, attendance: { id: string; checkInAt: Date }) => Promise<void>;

const checkoutGuards = new Map<Role, CheckoutGuard[]>();
const checkinHooks = new Map<Role, CheckinHook[]>();

export function registerCheckoutGuard(role: Role, guard: CheckoutGuard): void {
  checkoutGuards.set(role, [...(checkoutGuards.get(role) ?? []), guard]);
}
export function registerCheckinHook(role: Role, hook: CheckinHook): void {
  checkinHooks.set(role, [...(checkinHooks.get(role) ?? []), hook]);
}

export async function today(actor: Actor) {
  return prisma.attendance.findUnique({ where: { userId_date: { userId: actor.id!, date: clinicDate(new Date()) } } });
}

/** Check-in / check-out switched off for this person by the developer (D-049): the app treats them as on duty. */
async function assertAttendanceOn(actor: Actor) {
  const u = await prisma.user.findUnique({ where: { id: actor.id! }, select: { attendanceRequired: true } });
  if (u && !u.attendanceRequired) throw new ConflictError('ATTENDANCE_OFF', 'Aap ke liye check-in / check-out band hai — iski zaroorat nahi.');
}

export async function checkIn(actor: Actor) {
  await assertAttendanceOn(actor);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const date = clinicDate(now);
    const existing = await tx.attendance.findUnique({ where: { userId_date: { userId: actor.id!, date } } });
    if (existing) throw new ConflictError('ALREADY_CHECKED_IN', `Aap aaj ${formatClinic(existing.checkInAt, 'h:mm a')} par check-in kar chuke hain.`);
    const a = await tx.attendance.create({ data: { userId: actor.id!, date, checkInAt: now } });
    await audit(tx, actor, { action: 'STAFF_CHECK_IN', recordType: 'Attendance', recordId: a.id, after: a });
    if (actor.role !== 'MANAGER') {
      await notifyRoles(tx, ['MANAGER'], {
        type: 'STAFF_CHECK_IN',
        subject: `Check-in: ${actor.displayName}`,
        body: `${actor.role?.replace(/_/g, ' ').toLowerCase()} · ${formatClinic(now, 'h:mm a')}`,
        recordType: 'Attendance',
        recordId: a.id,
        actionLabel: 'Review / assign',
        sender: actor,
        dedupeKey: `checkin:${a.id}`,
      });
    }
    for (const hook of checkinHooks.get(actor.role!) ?? []) await hook(tx, actor, a);
    return a;
  });
}

export async function checkOut(actor: Actor) {
  await assertAttendanceOn(actor);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const a = await tx.attendance.findUnique({ where: { userId_date: { userId: actor.id!, date: clinicDate(now) } } });
    if (!a) throw new ConflictError('NOT_CHECKED_IN', 'Pehle check-in karein.');
    if (a.checkOutAt) throw new ConflictError('ALREADY_CHECKED_OUT', 'Aap check-out kar chuke hain.');
    for (const guard of checkoutGuards.get(actor.role!) ?? []) await guard(tx, actor, a.id);
    const out = await tx.attendance.update({ where: { id: a.id }, data: { checkOutAt: now } });
    await audit(tx, actor, { action: 'STAFF_CHECK_OUT', recordType: 'Attendance', recordId: a.id, before: { checkOutAt: null }, after: { checkOutAt: now } });
    return out;
  });
}

/** Helper for guards: a uniform 423 with the exact next action (spec §24). */
export function blockCheckout(code: string, message: string, details?: unknown): never {
  throw new LockedError(code, message, details);
}
