import { prisma } from '../lib/prisma';
import { formatClinic } from '../lib/time';
import { audit, systemActor } from '../services/audit';
import { notifyUsers } from '../services/notifications';

/**
 * Callback scheduler (spec §7, §23): when a lead's follow-up time arrives, create the in-app reminder exactly once
 * and put the lead in the member's Reminder Queue. The PENDING→DUE status flip is the claim, so overlapping
 * worker ticks or several workers can never remind twice (and the notification dedupe key backs that up).
 */
export async function runCallbackReminders(now = new Date()): Promise<number> {
  const due = await prisma.leadCallback.findMany({ where: { status: 'PENDING', dueAt: { lte: now } }, take: 200, orderBy: { dueAt: 'asc' } });
  let sent = 0;
  for (const cb of due) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.leadCallback.updateMany({ where: { id: cb.id, status: 'PENDING' }, data: { status: 'DUE', remindedAt: now } });
      if (!count) return;
      const lead = await tx.lead.findUnique({ where: { id: cb.leadId }, select: { id: true, name: true, phone: true, status: true } });
      if (!lead) return;
      if (lead.status !== 'BOOKED' && lead.status !== 'NOT_INTERESTED') {
        await tx.lead.update({ where: { id: lead.id }, data: { status: 'FOLLOW_UP_DUE' } });
      }
      await notifyUsers(tx, [cb.memberId], {
        type: 'CALLBACK_DUE',
        subject: `Follow-up due: ${lead.name}`,
        body: `Callback time ${formatClinic(cb.dueAt)} — call ya WhatsApp karein.`,
        recordType: 'Lead',
        recordId: lead.id,
        actionLabel: 'Open lead',
        priority: 1,
        dedupeKey: `callback:${cb.id}:due`,
      });
      await audit(tx, systemActor, { action: 'CALLBACK_REMINDER_SENT', recordType: 'LeadCallback', recordId: cb.id, after: { leadId: lead.id, dueAt: cb.dueAt } });
      sent += 1;
    });
  }
  return sent;
}
