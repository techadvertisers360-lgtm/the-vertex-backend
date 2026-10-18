import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../lib/prisma';
import { atClinicMinute, clinicDate, clinicDateStr, clinicDayBounds, formatClinic } from '../lib/time';
import { audit, systemActor } from '../services/audit';
import { enqueueMessage } from '../services/messaging';
import { notifyRoles, notifyUsers } from '../services/notifications';
import { publish, roleRoom, userRoom } from '../services/realtime';
import { getSetting } from '../services/settings';

/**
 * Spec §19 / §23 — future procedure reminders and procedure-day task release. Both are worker watchers that run
 * every tick; each unit of work is claimed with a deterministic key, so overlapping ticks, several workers or a
 * restarted worker never send a reminder twice or release a task twice.
 *
 * Reminder: each PROCEDURE appointment (one per plan item / session — never combined per patient) gets one reminder
 * when it is `procedure.reminderDaysBefore` (2) days away: WhatsApp to patient and Doctor (delivery tracked in the
 * outbox), an in-app notice to the Doctor, a Manager stock-check task, and the Reception upcoming list shows it.
 * Claim: a `jobs` row keyed `procedure:<appointmentId>:reminder_2d`. A rescheduled session is a new appointment,
 * so it gets its own reminder; the old one's unsent messages and open stock check are cancelled.
 *
 * Release: on the session date at `procedure.taskReleaseTime`, each planned session becomes a ProcedureTask
 * (no Assistant yet — Reception assigns at check-in). If its booked room has no Assistant on room duty, the
 * Manager and Reception are alerted once (MANAGER_ASSIGNMENT_MISSING task until resolved).
 */

const ACTIVE_APPT = ['CONFIRMED', 'CHECKED_IN', 'WAITING', 'PROCEDURE'] as const;
const reminderKey = (appointmentId: string) => `procedure:${appointmentId}:reminder_2d`;
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

async function sessionFacts(tx: Tx, appointmentId: string) {
  const a = await tx.appointment.findUniqueOrThrow({
    where: { id: appointmentId },
    include: { patient: { select: { id: true, name: true, phone: true } } },
  });
  const [doctor, room, item, service] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: a.doctorId }, select: { id: true, displayName: true, phone: true } }),
    a.roomId ? tx.room.findUnique({ where: { id: a.roomId }, select: { id: true, code: true } }) : null,
    a.treatmentPlanItemId ? tx.treatmentPlanItem.findUnique({ where: { id: a.treatmentPlanItemId }, select: { id: true, procedureName: true, sessionNumber: true } }) : null,
    a.serviceId ? tx.service.findUnique({ where: { id: a.serviceId }, select: { name: true } }) : null,
  ]);
  const procedure = item?.procedureName ?? service?.name ?? 'Procedure';
  return { a, doctor, room, item, procedure };
}

async function sendReminder(tx: Tx, appointmentId: string, now: Date, days: number) {
  const { a, doctor, room, item, procedure } = await sessionFacts(tx, appointmentId);
  const dueAt = new Date(a.startAt.getTime() - days * 86_400_000);
  // Claim first: a duplicate run fails here on the unique key and the whole transaction rolls back.
  await tx.job.create({
    data: { type: 'procedure_reminder', runAt: dueAt, status: 'DONE', attempts: 1, completedAt: now, idempotencyKey: reminderKey(a.id), payload: { appointmentId: a.id, late: now.getTime() - dueAt.getTime() > 15 * 60_000 } },
  });
  const when = formatClinic(a.startAt);
  const payload = { appointmentId: a.id, patientName: a.patient.name, procedure, session: item?.sessionNumber ?? null, when, startAt: a.startAt, doctorName: doctor.displayName, room: room?.code ?? null, location: 'The Vertex Health' };

  // Patient: always queued so the log shows the outcome (the outbox cancels it if there is no consent / opt-out).
  await enqueueMessage(tx, { template: 'procedure_reminder', toPhone: a.patient.phone, patientId: a.patient.id, payload, relatedType: 'Appointment', relatedId: a.id, idempotencyKey: `${reminderKey(a.id)}:patient` });
  if (doctor.phone) {
    await enqueueMessage(tx, { template: 'procedure_reminder', toPhone: doctor.phone, recipientUserId: doctor.id, payload, relatedType: 'Appointment', relatedId: a.id, idempotencyKey: `${reminderKey(a.id)}:doctor` });
  }
  const line = `${a.patient.name} · ${procedure}${item ? ` (session ${item.sessionNumber})` : ''} · ${when}${room ? ` · Room ${room.code}` : ''}`;
  await notifyUsers(tx, [doctor.id], { type: 'PROCEDURE_REMINDER', subject: `${days} din baad procedure: ${a.patient.name}`, body: line, recordType: 'UpcomingProcedure', recordId: a.id, dedupeKey: `${reminderKey(a.id)}:doctor` });

  const task = await tx.workflowTask.upsert({
    where: { idempotencyKey: `procedure:${a.id}:stock_check` },
    update: {},
    create: {
      type: 'MANAGER_STOCK_CHECK',
      title: `Stock check: ${procedure} — ${a.patient.name}`,
      patientId: a.patient.id,
      appointmentId: a.id,
      planItemId: item?.id ?? null,
      roomId: room?.id ?? null,
      assignedRole: 'MANAGER',
      dueAt: a.startAt,
      idempotencyKey: `procedure:${a.id}:stock_check`,
      payload: { procedure, session: item?.sessionNumber ?? null, when, doctorName: doctor.displayName, room: room?.code ?? null },
    },
  });
  await notifyRoles(tx, ['MANAGER'], {
    type: 'STOCK_CHECK',
    subject: `Stock check: ${procedure} (${formatClinic(a.startAt, 'dd LLL')})`,
    body: `${line} · ${doctor.displayName}`,
    recordType: 'WorkflowTask',
    recordId: task.id,
    actionLabel: 'Stock dekhein',
    dedupeKey: `procedure:${a.id}:stock_check`,
  });
  await publish(tx, [roleRoom('RECEPTIONIST'), roleRoom('MANAGER')], 'queue:changed', { upcoming: true });
  await audit(tx, systemActor, { action: 'PROCEDURE_REMINDER_SENT', recordType: 'Appointment', recordId: a.id, after: { procedure, startAt: a.startAt, dueAt } });
}

export async function runProcedureReminders(now = new Date()): Promise<number> {
  const days = await getSetting('procedure.reminderDaysBefore');
  const due = await prisma.appointment.findMany({
    where: { type: 'PROCEDURE', status: 'CONFIRMED', startAt: { gt: now, lte: new Date(now.getTime() + days * 86_400_000) } },
    select: { id: true },
    orderBy: { startAt: 'asc' },
    take: 200,
  });
  const claimed = new Set(
    due.length ? (await prisma.job.findMany({ where: { idempotencyKey: { in: due.map((a) => reminderKey(a.id)) } }, select: { idempotencyKey: true } })).map((j) => j.idempotencyKey) : [],
  );
  let n = 0;
  for (const a of due.filter((x) => !claimed.has(reminderKey(x.id)))) {
    try {
      await prisma.$transaction((tx) => sendReminder(tx, a.id, now, days));
      n++;
    } catch (err) {
      if (!isUnique(err)) throw err;
    }
  }
  // Stock checks for procedures that were cancelled / rescheduled meanwhile are no longer needed.
  const stale = await prisma.workflowTask.findMany({ where: { type: 'MANAGER_STOCK_CHECK', status: { in: ['PENDING', 'IN_PROGRESS'] } }, select: { id: true, appointmentId: true } });
  if (stale.length) {
    const gone = await prisma.appointment.findMany({ where: { id: { in: stale.map((t) => t.appointmentId!).filter(Boolean) }, status: { in: ['CANCELLED', 'RESCHEDULED'] } }, select: { id: true } });
    if (gone.length) {
      await prisma.workflowTask.updateMany({ where: { id: { in: stale.filter((t) => gone.some((g) => g.id === t.appointmentId)).map((t) => t.id) } }, data: { status: 'CANCELLED', completedAt: now } });
    }
  }
  return n;
}

// ───────────── Procedure-day release ─────────────

async function releaseSession(tx: Tx, appointmentId: string, now: Date): Promise<boolean> {
  const { a, room, item, procedure } = await sessionFacts(tx, appointmentId);
  if (!item) return false;
  const live = await tx.treatmentPlanItem.findUnique({ where: { id: item.id }, select: { status: true, version: { select: { versionNo: true, plan: { select: { currentVersionNo: true, patientId: true, doctorId: true } } } } } });
  if (!live || ['DONE', 'CANCELLED', 'SUPERSEDED'].includes(live.status) || live.version.versionNo !== live.version.plan.currentVersionNo) return false;

  const existing = await tx.procedureTask.findUnique({ where: { planItemId: item.id } });
  if (existing && (existing.assistantId || existing.status !== 'CANCELLED')) return false; // already released / assigned
  const data = { appointmentId: a.id, patientId: live.version.plan.patientId, doctorId: live.version.plan.doctorId, roomId: a.roomId, status: 'PENDING' as const, currentStep: 'ACCEPT' as const, releasedAt: now };
  // A session that was rescheduled after an earlier release reuses its (cancelled, never-assigned) task row.
  const task = existing
    ? await tx.procedureTask.update({ where: { id: existing.id, status: 'CANCELLED', assistantId: null }, data })
    : await tx.procedureTask.create({ data: { planItemId: item.id, ...data } });
  await audit(tx, systemActor, { action: 'PROCEDURE_RELEASED', recordType: 'ProcedureTask', recordId: task.id, after: { appointmentId: a.id, planItemId: item.id, roomId: a.roomId } });

  const duty = a.roomId ? await tx.roomAssignment.findFirst({ where: { roomId: a.roomId, date: clinicDate(now), unassignedAt: null }, select: { assistantId: true } }) : null;
  const line = `${a.patient.name} · ${procedure} (session ${item.sessionNumber}) · ${formatClinic(a.startAt, 'h:mm a')}${room ? ` · Room ${room.code}` : ''}`;
  if (duty) {
    await notifyUsers(tx, [duty.assistantId], { type: 'PROCEDURE_PLANNED_TODAY', subject: `Aaj planned procedure: ${a.patient.name}`, body: `${line} — patient check-in ke baad Reception assign karegi`, recordType: 'PlannedProcedure', recordId: task.id, dedupeKey: `procedure:${item.id}:released:${clinicDateStr(now)}` });
    await publish(tx, [userRoom(duty.assistantId)], 'queue:changed', {});
  } else {
    const missing = room ? `Room ${room.code} par aaj koi Assistant duty par nahi` : 'Session ka procedure room set nahi';
    await tx.workflowTask.upsert({
      where: { idempotencyKey: `procedure:${item.id}:assignment_missing:${clinicDateStr(now)}` },
      update: {},
      create: { type: 'MANAGER_ASSIGNMENT_MISSING', title: `Assignment missing: ${a.patient.name} — ${procedure}`, patientId: a.patient.id, appointmentId: a.id, planItemId: item.id, roomId: a.roomId, assignedRole: 'MANAGER', dueAt: a.startAt, idempotencyKey: `procedure:${item.id}:assignment_missing:${clinicDateStr(now)}`, payload: { reason: missing } },
    });
    await notifyRoles(tx, ['MANAGER', 'RECEPTIONIST'], {
      type: 'ASSIGNMENT_MISSING',
      subject: `Assistant / room assignment missing: ${a.patient.name}`,
      body: `${line} — ${missing}.`,
      recordType: 'ProcedureTask',
      recordId: task.id,
      actionLabel: 'Assign',
      priority: 2,
      dedupeKey: `procedure:${item.id}:assignment_missing:${clinicDateStr(now)}`,
    });
  }
  await publish(tx, [roleRoom('RECEPTIONIST'), roleRoom('MANAGER')], 'tracker:changed', {});
  return true;
}

const toMinute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export async function runProcedureDayRelease(now = new Date()): Promise<number> {
  // Released-but-unassigned tasks whose session was cancelled / rescheduled leave the queues (row kept for history).
  const orphan = await prisma.procedureTask.findMany({ where: { releasedAt: { not: null }, assistantId: null, status: 'PENDING' }, select: { id: true, appointmentId: true } });
  if (orphan.length) {
    const live = new Set((await prisma.appointment.findMany({ where: { id: { in: orphan.map((t) => t.appointmentId!).filter(Boolean) }, status: { in: [...ACTIVE_APPT] } }, select: { id: true } })).map((a) => a.id));
    const dead = orphan.filter((t) => !t.appointmentId || !live.has(t.appointmentId));
    for (const t of dead) {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.procedureTask.updateMany({ where: { id: t.id, assistantId: null, status: 'PENDING' }, data: { status: 'CANCELLED' } });
        if (count) await audit(tx, systemActor, { action: 'PROCEDURE_RELEASE_CANCELLED', recordType: 'ProcedureTask', recordId: t.id, reason: 'Session cancel / reschedule' });
      });
    }
  }
  await resolveAssignmentMissing(now);

  const today = clinicDateStr(now);
  if (now < atClinicMinute(today, toMinute(await getSetting('procedure.taskReleaseTime')))) return 0;
  const b = clinicDayBounds(today);
  const sessions = await prisma.appointment.findMany({
    where: { startAt: { gte: b.start, lt: b.end }, source: 'DOCTOR_PLAN', treatmentPlanItemId: { not: null }, status: { in: ['CONFIRMED', 'CHECKED_IN', 'WAITING'] } },
    select: { id: true, treatmentPlanItemId: true },
  });
  if (!sessions.length) return 0;
  const tasks = await prisma.procedureTask.findMany({ where: { planItemId: { in: sessions.map((s) => s.treatmentPlanItemId!) } }, select: { planItemId: true, status: true, assistantId: true } });
  const pending = sessions.filter((s) => {
    const t = tasks.find((x) => x.planItemId === s.treatmentPlanItemId);
    return !t || (t.status === 'CANCELLED' && !t.assistantId);
  });
  let n = 0;
  for (const s of pending) {
    try {
      if (await prisma.$transaction((tx) => releaseSession(tx, s.id, now))) n++;
    } catch (err) {
      if (!isUnique(err) && !(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025')) throw err;
    }
  }
  return n;
}

/** Close assignment-missing tasks once the room has an Assistant on duty, Reception assigned one, or the session ended. */
async function resolveAssignmentMissing(now: Date) {
  const open = await prisma.workflowTask.findMany({ where: { type: 'MANAGER_ASSIGNMENT_MISSING', status: { in: ['PENDING', 'IN_PROGRESS'] } }, select: { id: true, planItemId: true, roomId: true, appointmentId: true } });
  if (!open.length) return;
  const [tasks, duty, appts] = await Promise.all([
    prisma.procedureTask.findMany({ where: { planItemId: { in: open.map((o) => o.planItemId!).filter(Boolean) } }, select: { planItemId: true, assistantId: true, status: true } }),
    prisma.roomAssignment.findMany({ where: { date: clinicDate(now), unassignedAt: null, roomId: { in: open.map((o) => o.roomId!).filter(Boolean) } }, select: { roomId: true } }),
    prisma.appointment.findMany({ where: { id: { in: open.map((o) => o.appointmentId!).filter(Boolean) } }, select: { id: true, status: true, roomId: true } }),
  ]);
  const done = open.filter((o) => {
    const t = tasks.find((x) => x.planItemId === o.planItemId);
    const a = appts.find((x) => x.id === o.appointmentId);
    return !!t?.assistantId || t?.status === 'CANCELLED' || !a || !ACTIVE_APPT.includes(a.status as (typeof ACTIVE_APPT)[number]) || (!!a.roomId && duty.some((d) => d.roomId === a.roomId));
  });
  if (done.length) await prisma.workflowTask.updateMany({ where: { id: { in: done.map((d) => d.id) } }, data: { status: 'COMPLETED', completedAt: now } });
}
