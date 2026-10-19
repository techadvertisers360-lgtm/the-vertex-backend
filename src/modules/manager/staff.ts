import type { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { clinicDate, clinicDateStr } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { notifyUsers } from '../../services/notifications';
import { deny } from '../../services/scope';
import { getSetting, updateSetting } from '../../services/settings';

/**
 * Staff arrival review (spec §14): uniform, hair, nails, rating and comment/improvement note for staff who checked in
 * today. One review per attendance. The comment goes only to that staff member (notification + own list).
 */
const REVIEWED_ROLES: Role[] = ['RECEPTIONIST', 'DOCTOR', 'ASSISTANT', 'OFFICE_BOY', 'LEAD_MEMBER'];

export async function staffToday() {
  const today = clinicDate(new Date());
  const attendance = await prisma.attendance.findMany({ where: { date: today } });
  const [users, reviews, rooms, assignments, tasks] = await Promise.all([
    prisma.user.findMany({ where: { active: true, role: { in: REVIEWED_ROLES } }, select: { id: true, displayName: true, role: true, memberCode: true, attendanceRequired: true }, orderBy: [{ role: 'asc' }, { displayName: 'asc' }] }),
    prisma.staffReview.findMany({ where: { attendanceId: { in: attendance.map((a) => a.id) } } }),
    prisma.room.findMany({ select: { id: true, code: true } }),
    prisma.roomAssignment.findMany({ where: { date: today, unassignedAt: null } }),
    prisma.procedureTask.findMany({ where: { status: { in: ['PENDING', 'IN_PROGRESS', 'BLOCKED'] } }, select: { assistantId: true } }),
  ]);
  return {
    date: clinicDateStr(new Date()),
    items: users.map((u) => {
      const a = attendance.find((x) => x.userId === u.id) ?? null;
      const review = a ? (reviews.find((r) => r.attendanceId === a.id) ?? null) : null;
      return {
        ...u,
        attendance: a ? { id: a.id, checkInAt: a.checkInAt, checkOutAt: a.checkOutAt } : null,
        review: review && { id: review.id, uniformOk: review.uniformOk, hairOk: review.hairOk, nailsOk: review.nailsOk, rating: review.rating, comment: review.comment, improvementNote: review.improvementNote, createdAt: review.createdAt },
        rooms: u.role === 'ASSISTANT' ? assignments.filter((x) => x.assistantId === u.id).map((x) => ({ assignmentId: x.id, code: rooms.find((r) => r.id === x.roomId)?.code ?? '', acceptedAt: x.acceptedAt })) : [],
        busy: u.role === 'ASSISTANT' ? tasks.some((t) => t.assistantId === u.id) : false,
      };
    }),
  };
}

export interface ReviewInput {
  uniformOk: boolean;
  hairOk: boolean;
  nailsOk: boolean;
  rating: number;
  comment?: string;
  improvementNote?: string;
}

export async function reviewArrival(actor: Actor, staffId: string, input: ReviewInput) {
  if (staffId === actor.id) deny('User', staffId, 'review:not_self');
  const needsNote = !input.uniformOk || !input.hairOk || !input.nailsOk || input.rating <= 2;
  return prisma.$transaction(async (tx) => {
    const staff = await tx.user.findUnique({ where: { id: staffId }, select: { id: true, role: true, active: true, displayName: true } });
    if (!staff || !staff.active || !REVIEWED_ROLES.includes(staff.role)) throw new NotFoundError('Staff');
    const att = await tx.attendance.findUnique({ where: { userId_date: { userId: staffId, date: clinicDate(new Date()) } } });
    if (!att) throw new ConflictError('NOT_CHECKED_IN', `${staff.displayName} ne aaj check-in nahi kiya.`);
    if (await tx.staffReview.findFirst({ where: { attendanceId: att.id } })) throw new ConflictError('ALREADY_REVIEWED', 'Aaj ka arrival review ho chuka hai.');
    if (needsNote && !input.improvementNote?.trim()) throw new ValidationError('Improvement note likhein (kya behtar karna hai).');
    const r = await tx.staffReview.create({
      data: { staffId, attendanceId: att.id, reviewerId: actor.id!, uniformOk: input.uniformOk, hairOk: input.hairOk, nailsOk: input.nailsOk, rating: input.rating, comment: input.comment?.trim() || null, improvementNote: input.improvementNote?.trim() || null },
    });
    await audit(tx, actor, { action: 'STAFF_ARRIVAL_REVIEWED', recordType: 'StaffReview', recordId: r.id, after: { staffId, rating: r.rating, uniformOk: r.uniformOk, hairOk: r.hairOk, nailsOk: r.nailsOk } });
    const parts = [!r.uniformOk && 'uniform', !r.hairOk && 'hair', !r.nailsOk && 'nails'].filter(Boolean);
    await notifyUsers(tx, [staffId], {
      type: 'STAFF_REVIEW',
      subject: `Arrival review: ${r.rating}/5`,
      body: [parts.length ? `Dhyan dein: ${parts.join(', ')}` : 'Uniform, hair, nails theek', r.comment, r.improvementNote && `Improvement: ${r.improvementNote}`].filter(Boolean).join(' · '),
      recordType: 'StaffReview',
      recordId: r.id,
      sender: actor,
      dedupeKey: `review:${r.id}`,
    });
    return r;
  });
}

/** Staff see only their own reviews (spec §14 "comment appears only to relevant staff"). */
export async function myReviews(actor: Actor) {
  const rows = await prisma.staffReview.findMany({ where: { staffId: actor.id! }, orderBy: { createdAt: 'desc' }, take: 30 });
  return { items: rows.map((r) => ({ id: r.id, uniformOk: r.uniformOk, hairOk: r.hairOk, nailsOk: r.nailsOk, rating: r.rating, comment: r.comment, improvementNote: r.improvementNote, createdAt: r.createdAt })) };
}

// ───────────── Office Boy areas / duties (client answer 11a: Manager-editable list) ─────────────

export async function officeAreas() {
  return { areas: await getSetting('officeBoy.areas') };
}

export async function setOfficeAreas(actor: Actor, areas: string[]) {
  const clean = areas.map((a) => a.trim()).filter(Boolean);
  if (!clean.length) throw new ValidationError('Kam az kam ek area rakhein.');
  if (new Set(clean.map((a) => a.toLowerCase())).size !== clean.length) throw new ValidationError('Ek area ek hi dafa likhein.');
  await updateSetting(actor, 'officeBoy.areas', clean, true);
  return { areas: clean };
}

// ───────────── Assistants for room assignment / replacement ─────────────

export async function assistants() {
  const today = clinicDate(new Date());
  const [users, attendance, tasks] = await Promise.all([
    prisma.user.findMany({ where: { role: 'ASSISTANT', active: true }, select: { id: true, displayName: true }, orderBy: { displayName: 'asc' } }),
    prisma.attendance.findMany({ where: { date: today } }),
    prisma.procedureTask.findMany({ where: { status: { in: ['PENDING', 'IN_PROGRESS', 'BLOCKED'] } }, select: { assistantId: true } }),
  ]);
  return {
    items: users.map((u) => {
      const a = attendance.find((x) => x.userId === u.id);
      const onDuty = !!a && !a.checkOutAt;
      const busy = tasks.some((t) => t.assistantId === u.id);
      return { ...u, onDuty, busy, available: onDuty && !busy };
    }),
  };
}
