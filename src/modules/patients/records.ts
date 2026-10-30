import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError } from '../../lib/errors';
import { phoneSearchFragment } from '../../lib/phone';
import { audit, type Actor } from '../../services/audit';

/**
 * Patient Records for Manager and MD (client 2026-10-30, D-078): every patient the clinic has seen, searchable, and one
 * patient's complete history A to Z — every visit (also cancelled / rescheduled), its timeline, vitals, treatment plan,
 * procedures (Assistant, room, consent, before/after photos, items used), invoice with payments, prescription,
 * feedback, follow-up and aftercare, plus pharmacy counter sales. View only; no product cost. Opening a record is
 * audited. Photos open through /api/files (scope-checked, audited).
 */

export async function listPatients(q: { q?: string; cursor?: string; limit: number }) {
  const where: Prisma.PatientWhereInput = { mergedIntoId: null };
  const text = q.q?.trim();
  if (text) {
    const frag = phoneSearchFragment(text);
    where.OR = [{ name: { contains: text } }, ...(frag ? [{ phone: { contains: frag } }] : [])];
  }
  const rows = await prisma.patient.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: { id: true, name: true, phone: true, ageYears: true, gender: true, createdAt: true },
  });
  const page = rows.slice(0, q.limit);
  const ids = page.map((p) => p.id);
  const [visits, invoices] = await Promise.all([
    prisma.appointment.groupBy({
      by: ['patientId'],
      where: { patientId: { in: ids }, status: { notIn: ['CANCELLED', 'RESCHEDULED'] } },
      _count: { _all: true },
      _min: { startAt: true },
      _max: { startAt: true },
    }),
    prisma.invoice.groupBy({ by: ['patientId'], where: { patientId: { in: ids } }, _sum: { paidPaisa: true } }),
  ]);
  return {
    total: await prisma.patient.count({ where }),
    items: page.map((p) => {
      const v = visits.find((x) => x.patientId === p.id);
      return {
        ...p,
        visits: v?._count._all ?? 0,
        firstVisitAt: v?._min.startAt ?? null,
        lastVisitAt: v?._max.startAt ?? null,
        paidPaisa: invoices.find((x) => x.patientId === p.id)?._sum.paidPaisa ?? 0n,
      };
    }),
    nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
  };
}

const DOCUMENT_ROUTES = ['prescriptionPhoto', 'consentForm', 'beforePhoto', 'afterPhoto', 'itemsUsedEvidence'] as const;

export async function patientRecord(actor: Actor, patientId: string) {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { id: true, name: true, phone: true, ageYears: true, gender: true, contactConsent: true, whatsappConsent: true, createdById: true, createdAt: true, mergedIntoId: true },
  });
  if (!patient) throw new NotFoundError('Patient');
  // Records merged into this patient are part of the same history.
  const merged = await prisma.patient.findMany({ where: { mergedIntoId: patientId }, select: { id: true } });
  const patientIds = [patientId, ...merged.map((m) => m.id)];

  const appts = await prisma.appointment.findMany({
    where: { patientId: { in: patientIds } },
    orderBy: { startAt: 'desc' },
    select: {
      id: true,
      startAt: true,
      endAt: true,
      type: true,
      status: true,
      source: true,
      reason: true,
      doctorId: true,
      serviceId: true,
      roomId: true,
      leadMemberId: true,
      createdById: true,
      treatmentPlanItemId: true,
      cancelReason: true,
      checkedInAt: true,
      acceptedAt: true,
      sentToReceptionAt: true,
      doneAt: true,
      createdAt: true,
      history: { orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, actorId: true, reason: true, createdAt: true } },
      vitals: { orderBy: { createdAt: 'desc' }, select: { bpSystolic: true, bpDiastolic: true, glucoseMgDl: true, weightGrams: true, heightMm: true, skipped: true, skipReason: true, createdAt: true } },
    },
  });
  const apptIds = appts.map((a) => a.id);

  const [plans, tasks, invoices, feedback, followUps, aftercare] = await Promise.all([
    prisma.treatmentPlan.findMany({
      where: { patientId: { in: patientIds } },
      select: {
        id: true,
        appointmentId: true,
        doctorId: true,
        currentVersionNo: true,
        versions: {
          orderBy: { versionNo: 'asc' },
          select: {
            versionNo: true,
            consultationReason: true,
            consultationFeePaisa: true,
            consultationFeeWaived: true,
            itemsSubtotalPaisa: true,
            itemsDiscountPaisa: true,
            totalDiscountPaisa: true,
            grandTotalPaisa: true,
            advanceRequestedPaisa: true,
            balancePaisa: true,
            installmentCount: true,
            createdById: true,
            createdAt: true,
            items: { orderBy: { sessionNumber: 'asc' }, select: { id: true, sessionNumber: true, procedureName: true, sameDay: true, scheduledStart: true, pricePaisa: true, discountPaisa: true, status: true } },
            installments: { orderBy: { seq: 'asc' }, select: { seq: true, dueDate: true, amountPaisa: true } },
          },
        },
      },
    }),
    prisma.procedureTask.findMany({
      where: { patientId: { in: patientIds } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        planItemId: true,
        appointmentId: true,
        doctorId: true,
        roomId: true,
        assistantId: true,
        status: true,
        currentStep: true,
        assignedAt: true,
        acceptedAt: true,
        consentAttachmentId: true,
        consentAt: true,
        beforePhotoAttachmentId: true,
        beforePhotoSkipped: true,
        beforePhotoSkipReason: true,
        startedAt: true,
        endedAt: true,
        afterPhotoAttachmentId: true,
        afterPhotoSkipped: true,
        afterPhotoSkipReason: true,
        sentToReceptionAt: true,
        assignments: { orderBy: { startedAt: 'asc' }, select: { assistantId: true, reason: true, startedAt: true, endedAt: true } },
      },
    }),
    prisma.invoice.findMany({
      where: { OR: [{ patientId: { in: patientIds } }, { appointmentId: { in: apptIds } }] },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        number: true,
        kind: true,
        appointmentId: true,
        status: true,
        subtotalPaisa: true,
        discountPaisa: true,
        totalPaisa: true,
        paidPaisa: true,
        balancePaisa: true,
        prescriptionAttachmentId: true,
        closedAt: true,
        createdAt: true,
        lines: { orderBy: { createdAt: 'asc' }, select: { id: true, description: true, quantity: true, unitPricePaisa: true, discountPaisa: true, lineTotalPaisa: true, reversesLineId: true, reason: true } },
        payments: { orderBy: { receivedAt: 'asc' }, select: { receiptNo: true, amountPaisa: true, method: true, reference: true, cashierId: true, receivedAt: true } },
      },
    }),
    prisma.feedback.findMany({ where: { appointmentId: { in: apptIds } }, select: { appointmentId: true, skipped: true, doctorRating: true, staffRating: true, clinicRating: true, suggestion: true, submittedAt: true } }),
    prisma.followUp.findMany({ where: { appointmentId: { in: apptIds } }, select: { appointmentId: true, dueDate: true, doctorRating: true, staffRating: true, clinicRating: true, issue: true, suggestion: true, status: true, completedAt: true } }),
    prisma.aftercare.findMany({ where: { appointmentId: { in: apptIds } }, select: { appointmentId: true, skipped: true, content: true, createdAt: true } }),
  ]);

  const taskIds = tasks.map((t) => t.id);
  const [used, attachments] = await Promise.all([
    // Items used in each procedure — names and quantities only, never cost.
    prisma.stockTransaction.findMany({
      where: { procedureTaskId: { in: taskIds } },
      select: { procedureTaskId: true, quantity: true, reason: true, item: { select: { name: true, baseUnit: true } } },
    }),
    prisma.attachment.findMany({
      where: {
        OR: [
          { recordType: 'ProcedureTask', recordId: { in: taskIds } },
          { recordType: 'Invoice', recordId: { in: invoices.map((i) => i.id) } },
        ],
        route: { in: [...DOCUMENT_ROUTES] },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, route: true, fileName: true, mime: true, recordType: true, recordId: true, createdAt: true },
    }),
  ]);

  const userIds = new Set<string>([patient.createdById]);
  for (const a of appts) {
    for (const id of [a.doctorId, a.leadMemberId, a.createdById, ...a.history.map((h) => h.actorId)]) if (id) userIds.add(id);
  }
  for (const t of tasks) for (const id of [t.doctorId, t.assistantId, ...t.assignments.map((x) => x.assistantId)]) if (id) userIds.add(id);
  for (const p of plans) {
    if (p.doctorId) userIds.add(p.doctorId);
    for (const v of p.versions) userIds.add(v.createdById);
  }
  for (const i of invoices) for (const p of i.payments) userIds.add(p.cashierId);
  const roomIds = [...new Set([...appts.map((a) => a.roomId), ...tasks.map((t) => t.roomId)].filter((x): x is string => !!x))];
  const serviceIds = [...new Set(appts.map((a) => a.serviceId).filter((x): x is string => !!x))];
  const [users, rooms, services] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, displayName: true, role: true } }),
    prisma.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, code: true } }),
    prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true } }),
  ]);
  const who = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? null) : null);
  const room = (id: string | null) => (id ? (rooms.find((r) => r.id === id)?.code ?? null) : null);

  const planItems = plans.flatMap((p) => p.versions.flatMap((v) => v.items));
  const procedure = (t: (typeof tasks)[number]) => {
    const item = planItems.find((i) => i.id === t.planItemId);
    return {
      id: t.id,
      appointmentId: t.appointmentId,
      procedureName: item?.procedureName ?? 'Procedure',
      sessionNumber: item?.sessionNumber ?? null,
      status: t.status,
      currentStep: t.currentStep,
      doctorName: who(t.doctorId),
      assistantName: who(t.assistantId),
      assistants: t.assignments.map((x) => ({ name: who(x.assistantId), reason: x.reason, startedAt: x.startedAt, endedAt: x.endedAt })),
      roomCode: room(t.roomId),
      assignedAt: t.assignedAt,
      acceptedAt: t.acceptedAt,
      consentAt: t.consentAt,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      sentToReceptionAt: t.sentToReceptionAt,
      consentAttachmentId: t.consentAttachmentId,
      beforePhotoAttachmentId: t.beforePhotoAttachmentId,
      beforePhotoSkipReason: t.beforePhotoSkipped ? (t.beforePhotoSkipReason ?? 'Skipped') : null,
      afterPhotoAttachmentId: t.afterPhotoAttachmentId,
      afterPhotoSkipReason: t.afterPhotoSkipped ? (t.afterPhotoSkipReason ?? 'Skipped') : null,
      itemsUsed: used.filter((u) => u.procedureTaskId === t.id).map((u) => ({ name: u.item.name, quantity: -u.quantity, unit: u.item.baseUnit, reason: u.reason })),
      documents: attachments.filter((a) => a.recordType === 'ProcedureTask' && a.recordId === t.id),
    };
  };
  const invoiceView = (i: (typeof invoices)[number]) => ({
    id: i.id,
    number: i.number,
    kind: i.kind,
    status: i.status,
    subtotalPaisa: i.subtotalPaisa,
    discountPaisa: i.discountPaisa,
    totalPaisa: i.totalPaisa,
    paidPaisa: i.paidPaisa,
    balancePaisa: i.balancePaisa,
    closedAt: i.closedAt,
    createdAt: i.createdAt,
    lines: i.lines,
    payments: i.payments.map(({ cashierId, ...p }) => ({ ...p, cashierName: who(cashierId) })),
    prescriptionAttachmentId: i.prescriptionAttachmentId,
    documents: attachments.filter((a) => a.recordType === 'Invoice' && a.recordId === i.id),
  });

  const visits = appts.map((a) => {
    const plan = plans.find((p) => p.appointmentId === a.id);
    // A procedure belongs to the visit it happened in: same-day ones to the consultation, later sessions to their own booking.
    const own = tasks.filter((t) => t.appointmentId === a.id);
    const inv = invoices.find((i) => i.appointmentId === a.id);
    return {
      id: a.id,
      startAt: a.startAt,
      endAt: a.endAt,
      type: a.type,
      status: a.status,
      source: a.source,
      reason: a.reason,
      service: services.find((s) => s.id === a.serviceId)?.name ?? null,
      doctorName: who(a.doctorId),
      roomCode: room(a.roomId),
      bookedBy: who(a.createdById),
      leadMemberName: who(a.leadMemberId),
      session: a.treatmentPlanItemId ? (planItems.find((i) => i.id === a.treatmentPlanItemId)?.sessionNumber ?? null) : null,
      cancelReason: a.cancelReason,
      checkedInAt: a.checkedInAt,
      acceptedAt: a.acceptedAt,
      sentToReceptionAt: a.sentToReceptionAt,
      doneAt: a.doneAt,
      timeline: a.history.map((h) => ({ from: h.fromStatus, to: h.toStatus, by: who(h.actorId), reason: h.reason, at: h.createdAt })),
      vitals: a.vitals,
      plan: plan
        ? {
            doctorName: who(plan.doctorId),
            currentVersionNo: plan.currentVersionNo,
            versions: plan.versions.map(({ createdById, ...v }) => ({ ...v, createdBy: who(createdById) })),
          }
        : null,
      procedures: own.map(procedure),
      invoice: inv ? invoiceView(inv) : null,
      feedback: feedback.find((f) => f.appointmentId === a.id) ?? null,
      followUp: followUps.find((f) => f.appointmentId === a.id) ?? null,
      aftercare: aftercare.find((f) => f.appointmentId === a.id) ?? null,
    };
  });

  const counted = appts.filter((a) => a.status !== 'CANCELLED' && a.status !== 'RESCHEDULED');
  const summary = {
    visits: counted.length,
    consultations: counted.filter((a) => a.type === 'CONSULTATION').length,
    proceduresDone: tasks.filter((t) => t.status === 'COMPLETED').length,
    cancelled: appts.length - counted.length,
    firstVisitAt: counted.at(-1)?.startAt ?? null,
    lastVisitAt: counted[0]?.startAt ?? null,
    billedPaisa: invoices.reduce((s, i) => s + i.totalPaisa, 0n),
    paidPaisa: invoices.reduce((s, i) => s + i.paidPaisa, 0n),
    balancePaisa: invoices.reduce((s, i) => s + i.balancePaisa, 0n),
  };

  await audit(prisma, actor, { action: 'PATIENT_RECORD_VIEWED', recordType: 'Patient', recordId: patientId });
  return {
    patient: { ...patient, createdBy: who(patient.createdById), mergedPatients: merged.length },
    summary,
    visits,
    // Procedures without a visit of this patient (should not happen, kept so nothing is hidden).
    otherProcedures: tasks.filter((t) => !t.appointmentId || !apptIds.includes(t.appointmentId)).map(procedure),
    // Pharmacy counter sales and any invoice not tied to a visit.
    otherInvoices: invoices.filter((i) => !i.appointmentId || !apptIds.includes(i.appointmentId)).map(invoiceView),
  };
}
