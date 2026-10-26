import type { Installment, Invoice } from '@prisma/client';
import { prisma, type Db } from '../lib/prisma';
import { addDaysStr, clinicDateStr, dateOnlyStr, formatClinic } from '../lib/time';
import { audit, systemActor } from './audit';
import { enqueueMessage } from './messaging';
import { notifyRoles } from './notifications';
import { getSetting } from './settings';

/**
 * Installment tracking (clinic decision Q7, D-031). A plan version's installments cover the balance after the
 * advance. Payments are applied first to the up-front part (invoice total − Σ installments), then to
 * installments in due-date order, so each installment's status is derived from the invoice — never stored.
 */
export type InstallmentState = 'PAID' | 'PARTIAL' | 'DUE' | 'OVERDUE' | 'UPCOMING';

export interface InstallmentView {
  id: string;
  seq: number;
  dueDate: string; // clinic date
  amountPaisa: bigint;
  paidPaisa: bigint;
  outstandingPaisa: bigint;
  state: InstallmentState;
}

export function installmentViews(inv: Pick<Invoice, 'totalPaisa' | 'paidPaisa'>, installments: Pick<Installment, 'id' | 'seq' | 'dueDate' | 'amountPaisa'>[], today: string): InstallmentView[] {
  const sorted = [...installments].sort((a, b) => a.seq - b.seq);
  const scheduled = sorted.reduce((s, i) => s + i.amountPaisa, 0n);
  const upfront = inv.totalPaisa > scheduled ? inv.totalPaisa - scheduled : 0n;
  let pool = inv.paidPaisa > upfront ? inv.paidPaisa - upfront : 0n;
  return sorted.map((i) => {
    const paid = pool >= i.amountPaisa ? i.amountPaisa : pool;
    pool -= paid;
    const outstanding = i.amountPaisa - paid;
    const due = dateOnlyStr(i.dueDate);
    const state: InstallmentState = outstanding === 0n ? 'PAID' : due < today ? 'OVERDUE' : due === today ? 'DUE' : paid > 0n ? 'PARTIAL' : 'UPCOMING';
    return { id: i.id, seq: i.seq, dueDate: due, amountPaisa: i.amountPaisa, paidPaisa: paid, outstandingPaisa: outstanding, state };
  });
}

/** Is the invoice's remaining balance covered by unpaid installments? (Required to close with a balance.) */
export function balanceCovered(inv: Pick<Invoice, 'totalPaisa' | 'paidPaisa' | 'balancePaisa'>, installments: Pick<Installment, 'id' | 'seq' | 'dueDate' | 'amountPaisa'>[], today: string): boolean {
  if (inv.balancePaisa <= 0n) return true;
  const outstanding = installmentViews(inv, installments, today).reduce((s, v) => s + v.outstandingPaisa, 0n);
  return outstanding >= inv.balancePaisa;
}

export async function invoiceInstallments(db: Db, inv: Pick<Invoice, 'planVersionId' | 'totalPaisa' | 'paidPaisa'>) {
  if (!inv.planVersionId) return [];
  const rows = await db.installment.findMany({ where: { versionId: inv.planVersionId } });
  return installmentViews(inv, rows, clinicDateStr(new Date()));
}

/**
 * Worker scan: for every invoice with a balance on an installment plan, remind the patient N days before each
 * unpaid installment (and on the due date), and alert the Manager once an installment is overdue.
 * Idempotency keys per installment + event make repeated scans harmless.
 */
export async function runInstallmentReminders(now = new Date()): Promise<number> {
  const today = clinicDateStr(now);
  const daysBefore = await getSetting('installments.reminderDaysBefore');
  const invoices = await prisma.invoice.findMany({
    where: { balancePaisa: { gt: 0n }, planVersionId: { not: null }, status: { in: ['OPEN', 'CLOSED'] } },
    select: { id: true, number: true, totalPaisa: true, paidPaisa: true, balancePaisa: true, planVersionId: true, patientId: true, appointmentId: true },
    take: 500,
  });
  let actions = 0;
  for (const inv of invoices) {
    const installments = await prisma.installment.findMany({ where: { versionId: inv.planVersionId! } });
    const views = installmentViews(inv, installments, today);
    if (!inv.patientId) continue;
    const patient = await prisma.patient.findUnique({ where: { id: inv.patientId }, select: { name: true, phone: true, whatsappConsent: true } });
    if (!patient) continue;
    for (const v of views) {
      if (v.outstandingPaisa === 0n) continue;
      const remindFrom = addDaysStr(v.dueDate, -daysBefore);
      const key = `installment:${v.id}:reminder`;
      if (today >= remindFrom && today <= v.dueDate && patient.whatsappConsent && !(await prisma.messageOutbox.findUnique({ where: { idempotencyKey: key }, select: { id: true } }))) {
        await enqueueMessage(prisma, {
          template: 'installment_reminder',
          toPhone: patient.phone,
          patientId: inv.patientId,
          payload: { patientName: patient.name, invoice: inv.number, installment: v.seq, dueDate: v.dueDate, amountPaisa: v.outstandingPaisa },
          relatedType: 'Invoice',
          relatedId: inv.id,
          idempotencyKey: key,
        });
        actions += 1;
      }
      if (v.state === 'OVERDUE') {
        await notifyRoles(prisma, ['MANAGER'], {
          type: 'INSTALLMENT_OVERDUE',
          subject: `Installment overdue: ${patient.name}`,
          body: `${inv.number} · #${v.seq} due ${formatClinic(new Date(`${v.dueDate}T00:00:00Z`), 'dd LLL yyyy')} · outstanding Rs ${Number(v.outstandingPaisa) / 100}`,
          recordType: 'Invoice',
          recordId: inv.id,
          priority: 1,
          dedupeKey: `installment:${v.id}:overdue`,
        });
      }
    }
  }
  if (actions) await audit(prisma, systemActor, { action: 'INSTALLMENT_REMINDERS_QUEUED', recordType: 'Job', after: { count: actions } });
  return actions;
}
