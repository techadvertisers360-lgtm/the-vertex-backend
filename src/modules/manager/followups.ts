import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { clinicDateStr, dateOnly, dateOnlyStr } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { notifyUsers } from '../../services/notifications';

/**
 * Patient follow-up (spec §14): the day after a visit closes, the Manager calls each patient — Doctor / staff /
 * clinic rating, issue, suggestion. Saved to the patient file and the follow-up report; an issue can be raised as
 * a complaint escalated to the MD. Completed rows leave the pending list (history kept).
 */
export async function list(scope: 'pending' | 'done', date?: string) {
  const today = dateOnly(clinicDateStr(new Date()));
  const where =
    scope === 'pending'
      ? { status: { in: ['PENDING' as const, 'IN_PROGRESS' as const] }, dueDate: { lte: today } }
      : { status: 'COMPLETED' as const, ...(date ? { dueDate: dateOnly(date) } : { completedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }) };
  const rows = await prisma.followUp.findMany({ where, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }], take: 200 });
  const [patients, appts, feedback] = await Promise.all([
    prisma.patient.findMany({ where: { id: { in: rows.map((r) => r.patientId) } }, select: { id: true, name: true, phone: true } }),
    prisma.appointment.findMany({ where: { id: { in: rows.map((r) => r.appointmentId) } }, select: { id: true, startAt: true, doctorId: true, type: true } }),
    prisma.feedback.findMany({ where: { appointmentId: { in: rows.map((r) => r.appointmentId) } }, select: { appointmentId: true, doctorRating: true, staffRating: true, clinicRating: true, suggestion: true, submittedAt: true, skipped: true } }),
  ]);
  const doctors = await prisma.user.findMany({ where: { id: { in: appts.flatMap((a) => a.doctorId ?? []) } }, select: { id: true, displayName: true } });
  return {
    items: rows.map((r) => {
      const a = appts.find((x) => x.id === r.appointmentId);
      return {
        id: r.id,
        dueDate: dateOnlyStr(r.dueDate),
        status: r.status,
        patient: patients.find((p) => p.id === r.patientId) ?? null,
        visit: a ? { id: a.id, startAt: a.startAt, type: a.type, doctorName: doctors.find((d) => d.id === a.doctorId)?.displayName ?? null } : null,
        patientFeedback: feedback.find((f) => f.appointmentId === r.appointmentId) ?? null,
        result: r.status === 'COMPLETED' ? { doctorRating: r.doctorRating, staffRating: r.staffRating, clinicRating: r.clinicRating, issue: r.issue, suggestion: r.suggestion, complaintId: r.complaintId, completedAt: r.completedAt } : null,
      };
    }),
  };
}

export interface FollowUpInput {
  doctorRating?: number;
  staffRating?: number;
  clinicRating?: number;
  issue?: string;
  suggestion?: string;
  escalateToMd?: boolean;
}

export async function complete(actor: Actor, id: string, input: FollowUpInput) {
  if (input.escalateToMd && !input.issue?.trim()) throw new ValidationError('MD ko escalate karne ke liye issue likhein.');
  return prisma.$transaction(async (tx) => {
    const f = await tx.followUp.findUnique({ where: { id } });
    if (!f) throw new NotFoundError('Follow-up');
    if (f.status === 'COMPLETED') throw new ConflictError('ALREADY_DONE', 'Yeh follow-up ho chuka hai.');
    let complaintId: string | null = null;
    if (input.escalateToMd) {
      const p = await tx.patient.findUniqueOrThrow({ where: { id: f.patientId }, select: { name: true } });
      const mds = (await tx.user.findMany({ where: { role: 'MD', active: true }, select: { id: true } })).map((u) => u.id);
      const now = new Date();
      const c = await tx.complaint.create({
        data: {
          source: 'PATIENT',
          raisedById: actor.id,
          patientId: f.patientId,
          appointmentId: f.appointmentId,
          subject: `Follow-up issue: ${p.name}`,
          detail: input.issue!.trim(),
          status: 'IN_REVIEW',
          escalatedToMdAt: now,
          recipients: { create: [...new Set([...mds, actor.id!])].map((userId) => ({ userId })) },
        },
      });
      await tx.threadMessage.create({ data: { threadType: 'Complaint', threadId: c.id, authorId: actor.id!, body: `Patient follow-up issue, escalated to MD: ${input.issue!.trim()}`, statusChange: 'IN_REVIEW' } });
      await audit(tx, actor, { action: 'COMPLAINT_ESCALATED', recordType: 'Complaint', recordId: c.id, reason: 'Patient follow-up' });
      await notifyUsers(tx, mds, { type: 'COMPLAINT_ESCALATED', subject: `Escalation: follow-up issue — ${p.name}`, body: input.issue!.trim(), recordType: 'Complaint', recordId: c.id, sender: actor, priority: 2, dedupeKey: `complaint:${c.id}:escalated` });
      complaintId = c.id;
    }
    const { count } = await tx.followUp.updateMany({
      where: { id, status: { not: 'COMPLETED' } },
      data: {
        doctorRating: input.doctorRating ?? null,
        staffRating: input.staffRating ?? null,
        clinicRating: input.clinicRating ?? null,
        issue: input.issue?.trim() || null,
        suggestion: input.suggestion?.trim() || null,
        complaintId,
        status: 'COMPLETED',
        completedById: actor.id,
        completedAt: new Date(),
      },
    });
    if (!count) throw new ConflictError('ALREADY_DONE', 'Yeh follow-up ho chuka hai.');
    await audit(tx, actor, { action: 'FOLLOWUP_COMPLETED', recordType: 'FollowUp', recordId: id, after: { ...input, complaintId } });
    return { id, status: 'COMPLETED' as const, complaintId };
  });
}
