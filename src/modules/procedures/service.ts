import type { ProcedureStep, ProcedureTask, UploadRoute } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ConflictError, LockedError, NotFoundError, ValidationError } from '../../lib/errors';
import { addDaysStr, addMinutes, clinicDate, clinicDateStr, clinicDayBounds, formatClinic, overlaps } from '../../lib/time';
import { audit, systemActor, type Actor } from '../../services/audit';
import { transitionAppointment } from '../../services/appointmentStatus';
import { notifyRoles, notifyUsers } from '../../services/notifications';
import { publish, userRoom } from '../../services/realtime';
import { getSetting } from '../../services/settings';
import { lockForScheduling, resolveDuration, TX_OPTS } from '../../services/scheduling';
import { roomKindsFor } from '../../services/scheduling/engine';
import { assertAssignedProcedure, deny } from '../../services/scope';
import { deductUsage, type UsageLine } from '../../services/stock';
import { journeyChanged } from '../../services/tracker';

/**
 * Procedure workflow (spec §9 same-day assignment, §12 Assistant steps, §19 procedure day).
 * Steps: ACCEPT → CONSENT → BEFORE_PHOTO → START → FINISH → AFTER_PHOTO → ITEMS_USED → SEND_TO_RECEPTION → ROOM_CLEAN → DONE.
 * The patient goes back to Reception at SEND_TO_RECEPTION; the room stays blocked until ROOM_CLEAN (D-034).
 * Every step is guarded on the current step (optimistic), so double taps and stale screens cannot skip or repeat.
 */
export const STEP_ORDER: ProcedureStep[] = ['ACCEPT', 'CONSENT', 'BEFORE_PHOTO', 'START', 'FINISH', 'AFTER_PHOTO', 'ITEMS_USED', 'SEND_TO_RECEPTION', 'ROOM_CLEAN', 'DONE'];
const ACTIVE_TASK = ['PENDING', 'IN_PROGRESS', 'BLOCKED'] as const;

const next = (s: ProcedureStep): ProcedureStep => STEP_ORDER[STEP_ORDER.indexOf(s) + 1] ?? 'DONE';

async function advance(tx: Tx, task: ProcedureTask, expected: ProcedureStep, data: Record<string, unknown> = {}) {
  if (task.currentStep !== expected) {
    throw new ConflictError('WRONG_STEP', `Yeh qadam abhi nahi — current step: ${task.currentStep.replace('_', ' ').toLowerCase()}.`, { currentStep: task.currentStep });
  }
  const { count } = await tx.procedureTask.updateMany({ where: { id: task.id, currentStep: expected }, data: { ...data, currentStep: next(expected) } });
  if (!count) throw new ConflictError('STEP_CHANGED', 'Task abhi update hua — refresh karein.');
  return tx.procedureTask.findUniqueOrThrow({ where: { id: task.id } });
}

async function requireAttachment(tx: Tx, taskId: string, attachmentId: string, route: UploadRoute) {
  const a = await tx.attachment.findUnique({ where: { id: attachmentId } });
  if (!a || a.recordType !== 'ProcedureTask' || a.recordId !== taskId || a.route !== route) {
    throw new ValidationError('Upload is task ke saath nahi mila — dobara upload karein.');
  }
  return a;
}

async function liveUpdate(tx: Tx, task: Pick<ProcedureTask, 'assistantId' | 'appointmentId'>) {
  if (task.assistantId) await publish(tx, [userRoom(task.assistantId)], 'queue:changed', {});
  if (task.appointmentId) {
    const a = await tx.appointment.findUnique({ where: { id: task.appointmentId }, select: { id: true, doctorId: true, status: true } });
    if (a) await journeyChanged(tx, a);
  }
}

// ───────────── Reception: what needs an Assistant + room ─────────────

/**
 * Same-day plan items of today's visits (after the Doctor sends the patient to Reception) and today's planned
 * sessions whose patient has checked in. Each needs a free Assistant and a free procedure room.
 */
export async function pendingAssignments() {
  const b = clinicDayBounds(clinicDateStr(new Date()));
  const visits = await prisma.appointment.findMany({
    where: { startAt: { gte: b.start, lt: b.end }, status: { in: ['RECEPTION', 'PROCEDURE'] }, source: { not: 'DOCTOR_PLAN' } },
    select: { id: true, doctorId: true, patient: { select: { id: true, name: true } } },
  });
  const plans = await prisma.treatmentPlan.findMany({ where: { appointmentId: { in: visits.map((v) => v.id) }, currentVersionNo: { gt: 0 } } });
  const sameDay = [];
  for (const plan of plans) {
    const v = await prisma.treatmentPlanVersion.findUniqueOrThrow({ where: { planId_versionNo: { planId: plan.id, versionNo: plan.currentVersionNo } }, include: { items: { where: { sameDay: true, status: 'PLANNED' } } } });
    const visit = visits.find((x) => x.id === plan.appointmentId)!;
    const inv = await prisma.invoice.findUnique({ where: { appointmentId: visit.id }, select: { paidPaisa: true } });
    for (const it of v.items) {
      sameDay.push({
        kind: 'same_day' as const,
        planItemId: it.id,
        appointmentId: visit.id,
        patient: visit.patient,
        doctorId: visit.doctorId,
        procedureName: it.procedureName,
        sessionNumber: it.sessionNumber,
        bookedRoomId: null as string | null,
        advanceRequiredPaisa: v.advanceRequestedPaisa,
        paidPaisa: inv?.paidPaisa ?? 0n,
        paymentOk: (inv?.paidPaisa ?? 0n) >= v.advanceRequestedPaisa,
      });
    }
  }
  const sessions = await prisma.appointment.findMany({
    where: { startAt: { gte: b.start, lt: b.end }, source: 'DOCTOR_PLAN', status: { in: ['CHECKED_IN', 'WAITING'] }, treatmentPlanItemId: { not: null } },
    select: { id: true, doctorId: true, roomId: true, treatmentPlanItemId: true, patient: { select: { id: true, name: true } } },
  });
  // Released (procedure-day) tasks still need an Assistant: only tasks with one leave this list.
  const existing = await prisma.procedureTask.findMany({ where: { planItemId: { in: sessions.map((s) => s.treatmentPlanItemId!) }, assistantId: { not: null } }, select: { planItemId: true } });
  const items = await prisma.treatmentPlanItem.findMany({ where: { id: { in: sessions.map((s) => s.treatmentPlanItemId!) } } });
  const sessionRows = sessions
    .filter((s) => !existing.some((e) => e.planItemId === s.treatmentPlanItemId))
    .map((s) => {
      const it = items.find((i) => i.id === s.treatmentPlanItemId)!;
      return { kind: 'session' as const, planItemId: it.id, appointmentId: s.id, patient: s.patient, doctorId: s.doctorId, procedureName: it.procedureName, sessionNumber: it.sessionNumber, bookedRoomId: s.roomId, advanceRequiredPaisa: 0n, paidPaisa: 0n, paymentOk: true };
    });
  const all = [...sameDay, ...sessionRows];
  const doctors = await prisma.user.findMany({ where: { id: { in: [...new Set(all.flatMap((a) => a.doctorId ?? []))] } }, select: { id: true, displayName: true } });
  return { items: all.map((a) => ({ ...a, doctorName: doctors.find((d) => d.id === a.doctorId)?.displayName ?? null })) };
}

/** Active procedure tasks for the Reception / Manager tracker (assigned ones; released sessions are in plannedToday). */
export async function activeTasks() {
  const tasks = await prisma.procedureTask.findMany({ where: { status: { in: [...ACTIVE_TASK] }, assistantId: { not: null } }, orderBy: { assignedAt: 'asc' } });
  return { items: await decorateTasks(tasks) };
}

/**
 * Today's released planned sessions (spec §19 procedure-day release) not yet given to an Assistant, with the
 * room's duty Assistant and whether the assignment is missing. `assistantId` limits it to that Assistant's rooms.
 */
export async function plannedToday(assistantId?: string) {
  const now = new Date();
  const b = clinicDayBounds(clinicDateStr(now));
  const tasks = await prisma.procedureTask.findMany({ where: { releasedAt: { gte: b.start, lt: b.end }, assistantId: null, status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  const duty = await prisma.roomAssignment.findMany({ where: { date: clinicDate(now), unassignedAt: null }, select: { roomId: true, assistantId: true } });
  const mine = assistantId ? tasks.filter((t) => duty.some((d) => d.assistantId === assistantId && d.roomId === t.roomId)) : tasks;
  const [appts, users, patients, rooms, items] = await Promise.all([
    prisma.appointment.findMany({ where: { id: { in: mine.map((t) => t.appointmentId!).filter(Boolean) } }, select: { id: true, startAt: true, status: true } }),
    prisma.user.findMany({ where: { id: { in: [...mine.flatMap((t) => t.doctorId ?? []), ...duty.map((d) => d.assistantId)] } }, select: { id: true, displayName: true } }),
    prisma.patient.findMany({ where: { id: { in: mine.map((t) => t.patientId) } }, select: { id: true, name: true } }),
    prisma.room.findMany({ select: { id: true, code: true } }),
    prisma.treatmentPlanItem.findMany({ where: { id: { in: mine.map((t) => t.planItemId) } }, select: { id: true, procedureName: true, sessionNumber: true } }),
  ]);
  const name = (id: string | null | undefined) => (id ? (users.find((u) => u.id === id)?.displayName ?? null) : null);
  return {
    items: mine
      .map((t) => {
        const a = appts.find((x) => x.id === t.appointmentId);
        const dutyAssistantId = duty.find((d) => d.roomId === t.roomId)?.assistantId ?? null;
        return {
          id: t.id,
          planItemId: t.planItemId,
          appointmentId: t.appointmentId,
          startAt: a?.startAt ?? null,
          appointmentStatus: a?.status ?? null,
          patient: patients.find((p) => p.id === t.patientId) ?? null,
          procedure: items.find((i) => i.id === t.planItemId) ?? null,
          doctorName: name(t.doctorId),
          roomCode: rooms.find((r) => r.id === t.roomId)?.code ?? null,
          dutyAssistantId,
          dutyAssistantName: name(dutyAssistantId),
          assignmentMissing: !t.roomId || !dutyAssistantId,
          releasedAt: t.releasedAt,
        };
      })
      .sort((x, y) => (x.startAt?.getTime() ?? 0) - (y.startAt?.getTime() ?? 0)),
  };
}

async function decorateTasks(tasks: ProcedureTask[]) {
  const [users, patients, rooms, items] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: tasks.flatMap((t) => [t.assistantId, t.doctorId].filter((x): x is string => !!x)) } }, select: { id: true, displayName: true } }),
    prisma.patient.findMany({ where: { id: { in: tasks.map((t) => t.patientId) } }, select: { id: true, name: true } }),
    prisma.room.findMany({ select: { id: true, code: true } }),
    prisma.treatmentPlanItem.findMany({ where: { id: { in: tasks.map((t) => t.planItemId) } }, select: { id: true, procedureName: true, sessionNumber: true } }),
  ]);
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? null) : null);
  return tasks.map((t) => ({
    id: t.id,
    status: t.status,
    currentStep: t.currentStep,
    assignedAt: t.assignedAt,
    acceptedAt: t.acceptedAt,
    consentAt: t.consentAt,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    itemsUsedAt: t.itemsUsedAt,
    sentToReceptionAt: t.sentToReceptionAt,
    sentToReceptionAuto: t.sentToReceptionAuto,
    cleanedAt: t.cleanedAt,
    appointmentId: t.appointmentId,
    patient: patients.find((p) => p.id === t.patientId) ?? null,
    procedure: items.find((i) => i.id === t.planItemId) ?? null,
    assistantId: t.assistantId,
    assistantName: name(t.assistantId),
    doctorName: name(t.doctorId),
    roomCode: rooms.find((r) => r.id === t.roomId)?.code ?? null,
    beforePhotoSkipped: t.beforePhotoSkipped,
    afterPhotoSkipped: t.afterPhotoSkipped,
  }));
}

async function durationFor(itemId: string) {
  const it = await prisma.treatmentPlanItem.findUniqueOrThrow({ where: { id: itemId } });
  return resolveDuration(prisma, 'PROCEDURE', it.serviceId);
}

const PROCEDURE_ROOM_KINDS = roomKindsFor('PROCEDURE');

async function busyRoomIds(db: Tx | typeof prisma, from: Date, to: Date) {
  const res = await db.roomReservation.findMany({ where: { status: { in: ['ACTIVE', 'AWAITING_CLEAN'] }, room: { kind: { in: PROCEDURE_ROOM_KINDS } }, OR: [{ status: 'AWAITING_CLEAN' }, { startAt: { lt: to }, endAt: { gt: from } }] }, select: { roomId: true, startAt: true, endAt: true, status: true, appointmentId: true } });
  return res.filter((r) => r.status === 'AWAITING_CLEAN' || overlaps(r.startAt, r.endAt, from, to));
}

/** Free, checked-in Assistants (no active task) and free procedure rooms for the next `duration` minutes. */
export async function assignOptions(planItemId: string) {
  const durationMin = await durationFor(planItemId);
  const now = new Date();
  const until = addMinutes(now, durationMin);
  const today = clinicDate(now);
  const [assistants, rooms, busy, ownBooking] = await Promise.all([
    prisma.user.findMany({ where: { role: 'ASSISTANT', active: true }, select: { id: true, displayName: true, attendanceRequired: true } }),
    prisma.room.findMany({ where: { kind: { in: PROCEDURE_ROOM_KINDS }, active: true }, orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }], select: { id: true, code: true, name: true } }),
    busyRoomIds(prisma, now, until),
    prisma.appointment.findUnique({ where: { treatmentPlanItemId: planItemId }, select: { id: true, roomId: true } }),
  ]);
  // On duty = checked in and not out, or check-in switched off for them (D-049).
  const checkedIn = await prisma.attendance.findMany({ where: { date: today, userId: { in: assistants.map((a) => a.id) }, checkOutAt: null }, select: { userId: true } });
  const onDuty = [...checkedIn, ...assistants.filter((a) => !a.attendanceRequired).map((a) => ({ userId: a.id }))];
  const busyAssistants = await prisma.procedureTask.findMany({ where: { assistantId: { in: assistants.map((a) => a.id) }, status: { in: [...ACTIVE_TASK] } }, select: { assistantId: true } });
  return {
    durationMin,
    assistants: assistants.map((a) => ({
      ...a,
      onDuty: onDuty.some((o) => o.userId === a.id),
      busy: busyAssistants.some((b) => b.assistantId === a.id),
      available: onDuty.some((o) => o.userId === a.id) && !busyAssistants.some((b) => b.assistantId === a.id),
    })),
    rooms: rooms.map((r) => {
      // the session's own booked reservation does not make its room "busy" for itself
      const blockers = busy.filter((x) => x.roomId === r.id && x.appointmentId !== ownBooking?.id);
      return { ...r, free: blockers.length === 0, preferred: ownBooking?.roomId === r.id };
    }),
  };
}

/**
 * Assign Assistant + procedure room (spec §9 "free Assistant + correct free procedure room"). Same-day items
 * require the requested advance to be paid first. Rooms are locked like bookings, so two receptionists cannot
 * give the same room away twice. Creates the Assistant's procedure task and reserves the room until clean.
 */
export async function assign(actor: Actor, input: { planItemId: string; assistantId: string; roomId: string }) {
  const durationMin = await durationFor(input.planItemId);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.procedureTask.findUnique({ where: { planItemId: input.planItemId } });
    if (existing?.assistantId) return { task: existing, replayed: true };
    await lockForScheduling(tx, [], ['PROCEDURE']);

    const item = await tx.treatmentPlanItem.findUnique({ where: { id: input.planItemId }, include: { version: { include: { plan: true } } } });
    if (!item) throw new NotFoundError('Plan item');
    if (['DONE', 'CANCELLED', 'SUPERSEDED'].includes(item.status)) throw new ConflictError('ITEM_CLOSED', 'Yeh procedure ab plan mein active nahi.');
    const plan = item.version.plan;
    if (item.version.versionNo !== plan.currentVersionNo) throw new ConflictError('ITEM_SUPERSEDED', 'Plan badal chuka hai — naya plan dekhein.');

    let appointment;
    if (item.sameDay) {
      appointment = await tx.appointment.findUniqueOrThrow({ where: { id: plan.appointmentId } });
      if (!['RECEPTION', 'PROCEDURE'].includes(appointment.status)) throw new ConflictError('NOT_AT_RECEPTION', 'Patient abhi Reception par nahi.');
      if (clinicDateStr(appointment.startAt) !== clinicDateStr(new Date())) throw new ConflictError('NOT_TODAY', 'Same-day procedure sirf usi din.');
      const inv = await tx.invoice.findUnique({ where: { appointmentId: appointment.id } });
      const paid = inv?.paidPaisa ?? 0n;
      if (paid < item.version.advanceRequestedPaisa) {
        throw new LockedError('PAYMENT_REQUIRED', `Pehle advance payment lein (Rs ${Number(item.version.advanceRequestedPaisa - paid) / 100} baqi).`);
      }
    } else {
      appointment = await tx.appointment.findUnique({ where: { treatmentPlanItemId: item.id } });
      if (!appointment || !['CHECKED_IN', 'WAITING'].includes(appointment.status)) throw new ConflictError('NOT_CHECKED_IN', 'Session ka patient pehle check-in ho.');
    }

    const assistant = await tx.user.findUnique({ where: { id: input.assistantId }, select: { id: true, role: true, active: true, displayName: true, attendanceRequired: true } });
    if (!assistant || assistant.role !== 'ASSISTANT' || !assistant.active) throw new ValidationError('Assistant nahi mila.');
    const now = new Date();
    if (assistant.attendanceRequired && !(await tx.attendance.findFirst({ where: { userId: assistant.id, date: clinicDate(now), checkOutAt: null } }))) throw new ConflictError('ASSISTANT_NOT_ON_DUTY', `${assistant.displayName} ne aaj check-in nahi kiya.`);
    if (await tx.procedureTask.findFirst({ where: { assistantId: assistant.id, status: { in: [...ACTIVE_TASK] } } })) throw new ConflictError('ASSISTANT_BUSY', `${assistant.displayName} abhi doosre procedure par hain.`);

    const room = await tx.room.findUnique({ where: { id: input.roomId } });
    if (!room || !PROCEDURE_ROOM_KINDS.includes(room.kind) || !room.active) throw new ValidationError('Procedure room chunein.');
    const until = addMinutes(now, durationMin);
    const blockers = (await busyRoomIds(tx, now, until)).filter((r) => r.roomId === room.id && r.appointmentId !== appointment!.id);
    if (blockers.length) throw new ConflictError('ROOM_BUSY', `Room ${room.code} abhi free nahi. Doosra room chunein.`);

    // A planned session's own slot reservation is replaced by the live procedure reservation.
    if (!item.sameDay) await tx.roomReservation.updateMany({ where: { appointmentId: appointment.id, status: 'ACTIVE' }, data: { status: 'RELEASED', releasedAt: now } });

    const taskData = { appointmentId: appointment.id, patientId: plan.patientId, doctorId: plan.doctorId, roomId: room.id, assistantId: assistant.id, assignedAt: now, status: 'PENDING' as const, currentStep: 'ACCEPT' as const };
    // A session released on its procedure day (spec §19) already has its task row: it is completed here, not duplicated.
    const task = existing
      ? await tx.procedureTask.update({ where: { id: existing.id, assistantId: null }, data: taskData })
      : await tx.procedureTask.create({ data: { planItemId: item.id, ...taskData } });
    await tx.workflowTask.updateMany({ where: { type: 'MANAGER_ASSIGNMENT_MISSING', planItemId: item.id, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'COMPLETED', completedAt: now, completedById: actor.id } });
    await tx.procedureTaskAssignment.create({ data: { procedureTaskId: task.id, assistantId: assistant.id, assignedById: actor.id!, reason: 'Initial assignment' } });
    await tx.roomReservation.create({ data: { roomId: room.id, procedureTaskId: task.id, startAt: now, endAt: until } });
    if (item.status === 'PLANNED') await tx.treatmentPlanItem.update({ where: { id: item.id }, data: { status: 'SCHEDULED' } });
    if (appointment.status !== 'PROCEDURE') await transitionAppointment(tx, actor, appointment, 'PROCEDURE', { reason: `Procedure assigned: ${item.procedureName}` });
    await audit(tx, actor, { action: 'PROCEDURE_ASSIGNED', recordType: 'ProcedureTask', recordId: task.id, after: { planItemId: item.id, assistantId: assistant.id, roomId: room.id, appointmentId: appointment.id } });

    const patient = await tx.patient.findUniqueOrThrow({ where: { id: plan.patientId }, select: { name: true } });
    const doctor = plan.doctorId ? await tx.user.findUniqueOrThrow({ where: { id: plan.doctorId }, select: { displayName: true } }) : null;
    const body = `${patient.name} · ${item.procedureName}${doctor ? ` · ${doctor.displayName}` : ''} · Room ${room.code} · ab (${formatClinic(now, 'h:mm a')})`;
    await notifyUsers(tx, [assistant.id], { type: 'PROCEDURE_ASSIGNED', subject: `Naya procedure: ${patient.name}`, body, recordType: 'ProcedureTask', recordId: task.id, sender: actor, priority: 1, actionLabel: 'Accept', dedupeKey: `procedure:${task.id}:assigned` });
    if (plan.doctorId) await notifyUsers(tx, [plan.doctorId], { type: 'PROCEDURE_ASSIGNED', subject: `Procedure assigned: ${patient.name}`, body, recordType: 'Appointment', recordId: appointment.id, sender: actor, dedupeKey: `procedure:${task.id}:doctor` });
    await liveUpdate(tx, task);
    return { task, replayed: false };
  }, TX_OPTS);
}

/** Future planned sessions (spec §9 "Reception upcoming list", §19). */
export async function upcoming(days = 14) {
  const today = clinicDateStr(new Date());
  const from = clinicDayBounds(addDaysStr(today, 1)).start;
  const to = clinicDayBounds(addDaysStr(today, days)).end;
  const rows = await prisma.appointment.findMany({
    where: { source: 'DOCTOR_PLAN', status: 'CONFIRMED', startAt: { gte: from, lt: to } },
    select: { id: true, startAt: true, endAt: true, roomId: true, doctorId: true, treatmentPlanItemId: true, patient: { select: { id: true, name: true, phone: true } } },
    orderBy: { startAt: 'asc' },
  });
  const [items, doctors, rooms, reminders] = await Promise.all([
    prisma.treatmentPlanItem.findMany({ where: { id: { in: rows.map((r) => r.treatmentPlanItemId!).filter(Boolean) } }, select: { id: true, procedureName: true, sessionNumber: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.doctorId ?? []))] } }, select: { id: true, displayName: true } }),
    prisma.room.findMany({ select: { id: true, code: true } }),
    prisma.messageOutbox.findMany({ where: { relatedType: 'Appointment', relatedId: { in: rows.map((r) => r.id) }, template: 'procedure_reminder' }, select: { relatedId: true, status: true, patientId: true } }),
  ]);
  const stockChecks = await prisma.workflowTask.findMany({ where: { type: 'MANAGER_STOCK_CHECK', appointmentId: { in: rows.map((r) => r.id) } }, select: { appointmentId: true, status: true } });
  return {
    items: rows.map((r) => ({
      ...r,
      procedure: items.find((i) => i.id === r.treatmentPlanItemId) ?? null,
      doctorName: doctors.find((d) => d.id === r.doctorId)?.displayName ?? null,
      roomCode: rooms.find((x) => x.id === r.roomId)?.code ?? null,
      reminderStatus: reminders.find((m) => m.relatedId === r.id && m.patientId)?.status ?? null,
      doctorReminderStatus: reminders.find((m) => m.relatedId === r.id && !m.patientId)?.status ?? null,
      stockCheck: stockChecks.find((c) => c.appointmentId === r.id)?.status ?? null,
    })),
  };
}

// ───────────── Assistant steps (spec §12) ─────────────

export async function myProcedures(actor: Actor) {
  const tasks = await prisma.procedureTask.findMany({ where: { assistantId: actor.id!, status: { in: [...ACTIVE_TASK] } }, orderBy: { assignedAt: 'asc' } });
  return { items: await decorateTasks(tasks) };
}

/** Assigned procedure only: patient name, procedure, Doctor and room — nothing else about the patient (spec §12). */
export async function procedureDetail(actor: Actor, taskId: string) {
  const t = await assertAssignedProcedure(actor, taskId);
  const [view] = await decorateTasks([t]);
  const uploads = await prisma.attachment.findMany({ where: { recordType: 'ProcedureTask', recordId: t.id }, orderBy: { createdAt: 'asc' }, select: { id: true, route: true, fileName: true, mime: true, createdAt: true } });
  const used = await prisma.stockTransaction.findMany({ where: { procedureTaskId: t.id, type: 'USAGE' }, select: { itemId: true, quantity: true, item: { select: { name: true, baseUnit: true } } } });
  const autoMin = await getSetting('procedure.autoSendToReceptionMinutes');
  const autoSendAt = t.currentStep === 'SEND_TO_RECEPTION' && t.itemsUsedAt ? addMinutes(t.itemsUsedAt, autoMin) : null;
  return { ...view, autoSendAt, uploads, itemsUsed: used.map((u) => ({ itemId: u.itemId, name: u.item.name, unit: u.item.baseUnit, quantity: -u.quantity })), beforePhotoSkipReason: t.beforePhotoSkipReason, afterPhotoSkipReason: t.afterPhotoSkipReason };
}

async function withTask<T>(actor: Actor, taskId: string, fn: (tx: Tx, t: ProcedureTask) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    const t = await assertAssignedProcedure(actor, taskId, tx);
    if (t.status === 'COMPLETED' || t.status === 'CANCELLED') throw new ConflictError('TASK_CLOSED', 'Yeh task mukammal ho chuka hai.');
    const out = await fn(tx, t);
    const fresh = await tx.procedureTask.findUniqueOrThrow({ where: { id: taskId } });
    await liveUpdate(tx, fresh);
    return out;
  }, TX_OPTS);
}

export async function acceptProcedure(actor: Actor, taskId: string) {
  return withTask(actor, taskId, async (tx, t) => {
    const r = await advance(tx, t, 'ACCEPT', { acceptedAt: new Date(), status: 'IN_PROGRESS' });
    await audit(tx, actor, { action: 'PROCEDURE_ACCEPTED', recordType: 'ProcedureTask', recordId: t.id });
    return r;
  });
}

/** Consent gate: the signed consent must be uploaded to this task (spec §4). */
export async function recordConsent(actor: Actor, taskId: string, attachmentId: string) {
  return withTask(actor, taskId, async (tx, t) => {
    await requireAttachment(tx, t.id, attachmentId, 'consentForm');
    const r = await advance(tx, t, 'CONSENT', { consentAttachmentId: attachmentId, consentAt: new Date() });
    await audit(tx, actor, { action: 'CONSENT_UPLOADED', recordType: 'ProcedureTask', recordId: t.id, after: { attachmentId } });
    return r;
  });
}

/**
 * Photos may be skipped only when the patient declines — the reason is stored (spec §4, §12).
 * Several photos and/or videos may be saved per step (D-082); the first is kept as the step's main attachment.
 */
export async function recordPhoto(actor: Actor, taskId: string, which: 'before' | 'after', input: { attachmentId?: string; attachmentIds?: string[]; skipReason?: string }) {
  const ids = [...new Set([...(input.attachmentIds ?? []), ...(input.attachmentId ? [input.attachmentId] : [])])];
  if (!ids.length && !input.skipReason?.trim()) throw new ValidationError('Photo upload karein, ya patient ke inkar ki wajah likh kar Skip karein.');
  return withTask(actor, taskId, async (tx, t) => {
    for (const id of ids) await requireAttachment(tx, t.id, id, which === 'before' ? 'beforePhoto' : 'afterPhoto');
    const main = ids[0] ?? null;
    const data =
      which === 'before'
        ? { beforePhotoAttachmentId: main, beforePhotoSkipped: !main, beforePhotoSkipReason: main ? null : input.skipReason!.trim() }
        : { afterPhotoAttachmentId: main, afterPhotoSkipped: !main, afterPhotoSkipReason: main ? null : input.skipReason!.trim() };
    const r = await advance(tx, t, which === 'before' ? 'BEFORE_PHOTO' : 'AFTER_PHOTO', data);
    await audit(tx, actor, {
      action: main ? `${which.toUpperCase()}_PHOTO_UPLOADED` : `${which.toUpperCase()}_PHOTO_SKIPPED`,
      recordType: 'ProcedureTask',
      recordId: t.id,
      after: main ? { attachmentIds: ids } : undefined,
      reason: main ? undefined : input.skipReason,
    });
    return r;
  });
}

export async function startProcedure(actor: Actor, taskId: string) {
  return withTask(actor, taskId, async (tx, t) => {
    // Re-checked at the server regardless of step order (spec §24 "Server rejects start without consent").
    if (!t.consentAttachmentId) throw new LockedError('CONSENT_REQUIRED', 'Signed consent upload karein — us ke baghair procedure start nahi ho sakta.');
    const r = await advance(tx, t, 'START', { startedAt: new Date() });
    await tx.treatmentPlanItem.update({ where: { id: t.planItemId }, data: { status: 'IN_PROGRESS' } });
    await audit(tx, actor, { action: 'PROCEDURE_STARTED', recordType: 'ProcedureTask', recordId: t.id });
    return r;
  });
}

export async function finishProcedure(actor: Actor, taskId: string) {
  return withTask(actor, taskId, async (tx, t) => {
    const now = new Date();
    const r = await advance(tx, t, 'FINISH', { endedAt: now });
    // Room stays occupied until the clean evidence (spec §12 "Room not freed").
    await tx.roomReservation.updateMany({ where: { procedureTaskId: t.id, status: 'ACTIVE' }, data: { status: 'AWAITING_CLEAN' } });
    await audit(tx, actor, { action: 'PROCEDURE_FINISHED', recordType: 'ProcedureTask', recordId: t.id });
    return r;
  });
}

export async function recordItemsUsed(actor: Actor, taskId: string, input: { lines: UsageLine[]; evidenceAttachmentIds: string[]; noItems?: boolean }) {
  if (!input.noItems && !input.lines.length) throw new ValidationError('Istemal hone wale items chunein (ya "koi item istemal nahi" confirm karein).');
  if (input.lines.length && !input.evidenceAttachmentIds.length) throw new ValidationError('Items ki evidence photo upload karein.');
  const ids = input.lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw new ValidationError('Ek item ek hi dafa likhein.');
  return withTask(actor, taskId, async (tx, t) => {
    for (const id of input.evidenceAttachmentIds) await requireAttachment(tx, t.id, id, 'itemsUsedEvidence');
    // Step guard first: a repeated submit fails here and nothing is deducted twice (spec §25 #16).
    const r = await advance(tx, t, 'ITEMS_USED', { itemsUsedAt: new Date() });
    for (const line of input.lines) await deductUsage(tx, actor, t.id, line);
    await audit(tx, actor, { action: 'ITEMS_USED_RECORDED', recordType: 'ProcedureTask', recordId: t.id, after: { lines: input.lines, evidence: input.evidenceAttachmentIds, noItems: !!input.noItems } });
    return r;
  });
}

/**
 * Patient leaves the procedure room for Reception (D-034, client change 2026-10-18). Runs right after items used,
 * from the Assistant's "Send to Reception" button or, if not pressed in time, from the safety-net watcher (auto).
 * The procedure is clinically complete here (plan item DONE); the room stays AWAITING_CLEAN until the clean photo.
 */
async function releasePatient(tx: Tx, actor: Actor, t: ProcedureTask, auto: boolean) {
  const now = new Date();
  const { count } = await tx.procedureTask.updateMany({ where: { id: t.id, currentStep: 'SEND_TO_RECEPTION', sentToReceptionAt: null }, data: { currentStep: 'ROOM_CLEAN', sentToReceptionAt: now, sentToReceptionAuto: auto } });
  if (!count) return false;
  await tx.treatmentPlanItem.update({ where: { id: t.planItemId }, data: { status: 'DONE' } });
  const [patient, room, assistant] = await Promise.all([
    tx.patient.findUniqueOrThrow({ where: { id: t.patientId }, select: { name: true } }),
    t.roomId ? tx.room.findUnique({ where: { id: t.roomId }, select: { code: true } }) : null,
    t.assistantId ? tx.user.findUnique({ where: { id: t.assistantId }, select: { displayName: true } }) : null,
  ]);
  if (t.appointmentId) {
    // Another procedure of the same visit still running keeps the patient in the procedure stage.
    const others = await tx.procedureTask.count({ where: { appointmentId: t.appointmentId, id: { not: t.id }, status: { in: [...ACTIVE_TASK] }, sentToReceptionAt: null } });
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: t.appointmentId } });
    if (!others && appt.status === 'PROCEDURE') await transitionAppointment(tx, actor, appt, 'RECEPTION', { reason: auto ? 'Procedure complete — auto-sent to Reception' : 'Procedure complete — sent to Reception' });
    await notifyRoles(tx, ['RECEPTIONIST'], {
      type: 'PATIENT_RETURNING',
      subject: `Patient ${patient.name} Reception aa raha hai — ${room?.code ?? 'room'}, ${assistant?.displayName ?? 'Assistant'}`,
      body: auto ? 'Auto-sent: Assistant ne waqt par button nahi dabaya.' : `${actor.displayName} ne Reception bheja.`,
      recordType: 'Appointment',
      recordId: t.appointmentId,
      sender: auto ? undefined : actor,
      priority: 1,
      actionLabel: 'Billing',
      dedupeKey: `procedure:${t.id}:returning`,
    });
  }
  await audit(tx, actor, { action: 'PATIENT_SENT_TO_RECEPTION', recordType: 'ProcedureTask', recordId: t.id, after: { auto, mode: auto ? 'auto-sent' : 'button', appointmentId: t.appointmentId, roomId: t.roomId, assistantId: t.assistantId } });
  return true;
}

export async function sendToReception(actor: Actor, taskId: string) {
  return withTask(actor, taskId, async (tx, t) => {
    if (t.currentStep !== 'SEND_TO_RECEPTION') throw new ConflictError('WRONG_STEP', `Yeh qadam abhi nahi — current step: ${t.currentStep.replace(/_/g, ' ').toLowerCase()}.`, { currentStep: t.currentStep });
    if (!(await releasePatient(tx, actor, t, false))) throw new ConflictError('STEP_CHANGED', 'Task abhi update hua — refresh karein.');
    return tx.procedureTask.findUniqueOrThrow({ where: { id: t.id } });
  });
}

/** Safety net: send the patient automatically `procedure.autoSendToReceptionMinutes` after items used (D-034). */
export async function runAutoSendToReception(now = new Date()): Promise<number> {
  const mins = await getSetting('procedure.autoSendToReceptionMinutes');
  const due = await prisma.procedureTask.findMany({
    where: { currentStep: 'SEND_TO_RECEPTION', sentToReceptionAt: null, status: { in: [...ACTIVE_TASK] }, itemsUsedAt: { lte: addMinutes(now, -mins) } },
    take: 100,
  });
  let n = 0;
  for (const t of due) {
    const sent = await prisma.$transaction(async (tx) => {
      const ok = await releasePatient(tx, systemActor, t, true);
      if (ok) await liveUpdate(tx, (await tx.procedureTask.findUniqueOrThrow({ where: { id: t.id } })));
      return ok;
    }, TX_OPTS);
    if (sent) n += 1;
  }
  return n;
}

/** Clean evidence frees the room (spec §12). The patient was already sent to Reception at the previous step. */
export async function recordClean(actor: Actor, taskId: string, attachmentId: string) {
  return withTask(actor, taskId, async (tx, t) => {
    await requireAttachment(tx, t.id, attachmentId, 'roomCleanPhoto');
    const now = new Date();
    const r = await advance(tx, t, 'ROOM_CLEAN', { cleanAttachmentId: attachmentId, cleanedAt: now, status: 'COMPLETED' });
    await tx.roomReservation.updateMany({ where: { procedureTaskId: t.id, status: { in: ['ACTIVE', 'AWAITING_CLEAN'] } }, data: { status: 'RELEASED', releasedAt: now } });
    await tx.procedureTaskAssignment.updateMany({ where: { procedureTaskId: t.id, endedAt: null }, data: { endedAt: now } });
    await audit(tx, actor, { action: 'ROOM_CLEANED', recordType: 'ProcedureTask', recordId: t.id, after: { attachmentId } });
    return r;
  });
}

/** Assistant raises an emergency; the Manager assigns a replacement (spec §12). */
export async function raiseEmergency(actor: Actor, taskId: string, reason: string) {
  if (reason.trim().length < 3) throw new ValidationError('Emergency ki wajah likhein.');
  return withTask(actor, taskId, async (tx, t) => {
    await tx.procedureTask.update({ where: { id: t.id }, data: { status: 'BLOCKED' } });
    await audit(tx, actor, { action: 'PROCEDURE_EMERGENCY', recordType: 'ProcedureTask', recordId: t.id, reason });
    await notifyRoles(tx, ['MANAGER'], { type: 'ASSISTANT_EMERGENCY', subject: `Emergency: ${actor.displayName}`, body: reason, recordType: 'ProcedureTask', recordId: t.id, sender: actor, priority: 2, actionLabel: 'Replacement assign karein' });
    return tx.procedureTask.findUniqueOrThrow({ where: { id: t.id } });
  });
}

/** Replacement resumes the same task at its current step; consent/photos/items are kept; audit names both (spec §25 #18). */
export async function replaceAssistant(actor: Actor, taskId: string, newAssistantId: string, reason: string) {
  if (reason.trim().length < 3) throw new ValidationError('Replacement ki wajah likhein.');
  return prisma.$transaction(async (tx) => {
    const t = await tx.procedureTask.findUnique({ where: { id: taskId } });
    if (!t) throw new NotFoundError('Procedure task');
    if (!ACTIVE_TASK.includes(t.status as (typeof ACTIVE_TASK)[number])) throw new ConflictError('TASK_CLOSED', 'Task active nahi.');
    if (t.assistantId === newAssistantId) throw new ValidationError('Naya Assistant chunein.');
    const a = await tx.user.findUnique({ where: { id: newAssistantId }, select: { role: true, active: true, displayName: true, attendanceRequired: true } });
    if (!a || a.role !== 'ASSISTANT' || !a.active) throw new ValidationError('Assistant nahi mila.');
    if (a.attendanceRequired && !(await tx.attendance.findFirst({ where: { userId: newAssistantId, date: clinicDate(new Date()), checkOutAt: null } }))) throw new ConflictError('ASSISTANT_NOT_ON_DUTY', `${a.displayName} ne aaj check-in nahi kiya.`);
    if (await tx.procedureTask.findFirst({ where: { assistantId: newAssistantId, status: { in: [...ACTIVE_TASK] } } })) throw new ConflictError('ASSISTANT_BUSY', `${a.displayName} abhi doosre procedure par hain.`);
    const now = new Date();
    await tx.procedureTaskAssignment.updateMany({ where: { procedureTaskId: t.id, endedAt: null }, data: { endedAt: now } });
    await tx.procedureTaskAssignment.create({ data: { procedureTaskId: t.id, assistantId: newAssistantId, assignedById: actor.id!, reason, resumedAtStep: t.currentStep } });
    const updated = await tx.procedureTask.update({ where: { id: t.id }, data: { assistantId: newAssistantId, status: t.currentStep === 'ACCEPT' ? 'PENDING' : 'IN_PROGRESS' } });
    await audit(tx, actor, { action: 'ASSISTANT_REPLACED', recordType: 'ProcedureTask', recordId: t.id, before: { assistantId: t.assistantId }, after: { assistantId: newAssistantId, resumedAtStep: t.currentStep }, reason });
    await notifyUsers(tx, [newAssistantId], { type: 'PROCEDURE_ASSIGNED', subject: 'Replacement procedure assign hua', body: `Step: ${t.currentStep.replace('_', ' ').toLowerCase()} se jaari rakhein`, recordType: 'ProcedureTask', recordId: t.id, sender: actor, priority: 1 });
    if (t.assistantId) await notifyUsers(tx, [t.assistantId], { type: 'PROCEDURE_REASSIGNED', subject: 'Procedure doosre Assistant ko de diya gaya', body: reason, recordType: 'ProcedureTask', recordId: t.id, sender: actor });
    if (t.assistantId) await publish(tx, [userRoom(t.assistantId)], 'queue:changed', {});
    await liveUpdate(tx, updated);
    return updated;
  });
}

export { deny };
