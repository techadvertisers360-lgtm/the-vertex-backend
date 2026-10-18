import { prisma } from '../lib/prisma';
import { addMinutes } from '../lib/time';
import { audit, systemActor } from '../services/audit';
import { notifyRoles } from '../services/notifications';
import { getSetting } from '../services/settings';

/**
 * Procedure SLA watchers (spec §12): consent not uploaded N min after assignment, and room not cleaned N min after
 * the procedure ended, alert the Manager once each. The alert timestamp is the claim (updateMany on null), so
 * overlapping ticks never alert twice.
 */
export async function runConsentAlerts(now = new Date()): Promise<number> {
  const mins = await getSetting('sla.consentMinutes');
  const late = await prisma.procedureTask.findMany({
    where: { status: { in: ['PENDING', 'IN_PROGRESS'] }, consentAttachmentId: null, consentAlertAt: null, assignedAt: { lte: addMinutes(now, -mins) } },
    take: 100,
  });
  let n = 0;
  for (const t of late) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.procedureTask.updateMany({ where: { id: t.id, consentAlertAt: null, consentAttachmentId: null }, data: { consentAlertAt: now } });
      if (!count) return;
      const [p, a] = await Promise.all([
        tx.patient.findUnique({ where: { id: t.patientId }, select: { name: true } }),
        t.assistantId ? tx.user.findUnique({ where: { id: t.assistantId }, select: { displayName: true } }) : null,
      ]);
      await notifyRoles(tx, ['MANAGER'], { type: 'SLA_CONSENT', subject: `Consent pending: ${p?.name ?? 'patient'}`, body: `${a?.displayName ?? 'Assistant'} — ${mins} min se consent upload nahi hua.`, recordType: 'ProcedureTask', recordId: t.id, priority: 2, dedupeKey: `procedure:${t.id}:consent-sla` });
      await audit(tx, systemActor, { action: 'SLA_CONSENT_ALERT', recordType: 'ProcedureTask', recordId: t.id });
      n += 1;
    });
  }
  return n;
}

export async function runCleanAlerts(now = new Date()): Promise<number> {
  const mins = await getSetting('sla.roomCleanMinutes');
  const late = await prisma.procedureTask.findMany({
    where: { status: { in: ['IN_PROGRESS', 'BLOCKED'] }, endedAt: { not: null, lte: addMinutes(now, -mins) }, cleanedAt: null, cleanAlertAt: null },
    take: 100,
  });
  let n = 0;
  for (const t of late) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.procedureTask.updateMany({ where: { id: t.id, cleanAlertAt: null, cleanedAt: null }, data: { cleanAlertAt: now } });
      if (!count) return;
      const room = t.roomId ? await tx.room.findUnique({ where: { id: t.roomId }, select: { code: true } }) : null;
      await notifyRoles(tx, ['MANAGER'], { type: 'SLA_ROOM_CLEAN', subject: `Room ${room?.code ?? ''} clean pending`, body: `Procedure khatam hue ${mins} min ho gaye, room clean evidence nahi aayi.`, recordType: 'ProcedureTask', recordId: t.id, priority: 2, dedupeKey: `procedure:${t.id}:clean-sla` });
      await audit(tx, systemActor, { action: 'SLA_CLEAN_ALERT', recordType: 'ProcedureTask', recordId: t.id });
      n += 1;
    });
  }
  return n;
}
