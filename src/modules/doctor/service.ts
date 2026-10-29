import type { AvailabilityKind, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { phoneSearchFragment } from '../../lib/phone';
import { addMinutes, atClinicMinute, clinicDateStr, clinicDayBounds, dateOnly, dateOnlyStr, overlaps } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { transitionAppointment } from '../../services/appointmentStatus';
import { enqueueMessage } from '../../services/messaging';
import { notifyRoles, notifyUsers } from '../../services/notifications';
import { bookInTx, cancelInTx, resolveDuration, SlotUnavailableError, TX_OPTS } from '../../services/scheduling';
import { deny, hasApprovedHistoryAccess, isDoctorsOwnPatient } from '../../services/scope';
import { getSetting } from '../../services/settings';
import { journeyChanged } from '../../services/tracker';
import { computePlanMoney } from './plan';

// ───────────── Scope ─────────────

/** The appointment must belong to this Doctor (spec §10: own queue only). */
async function ownAppointment(actor: Actor, appointmentId: string, db: Tx | typeof prisma = prisma) {
  const a = await db.appointment.findUnique({ where: { id: appointmentId } });
  if (!a) throw new NotFoundError('Appointment');
  if (a.doctorId !== actor.id) deny('Appointment', appointmentId, 'doctor:own_appointment');
  return a;
}

// ───────────── Queue (spec §10) ─────────────

const patientMini = { id: true, name: true, ageYears: true, gender: true } as const;

export async function queue(actor: Actor, date?: string) {
  const d = date ?? clinicDateStr(new Date());
  const b = clinicDayBounds(d);
  const rows = await prisma.appointment.findMany({
    where: { doctorId: actor.id!, startAt: { gte: b.start, lt: b.end }, status: { notIn: ['CANCELLED', 'RESCHEDULED'] } },
    select: {
      id: true,
      startAt: true,
      endAt: true,
      type: true,
      status: true,
      reason: true,
      roomId: true,
      checkedInAt: true,
      acceptedAt: true,
      sentToReceptionAt: true,
      doneAt: true,
      patient: { select: patientMini },
      vitals: { orderBy: { createdAt: 'desc' }, take: 1, select: { bpSystolic: true, bpDiastolic: true, glucoseMgDl: true, weightGrams: true, heightMm: true, skipped: true, createdAt: true } },
    },
    orderBy: [{ checkedInAt: 'asc' }, { startAt: 'asc' }],
  });
  const rooms = await prisma.room.findMany({ select: { id: true, code: true } });
  return {
    date: d,
    items: rows.map(({ vitals, ...r }) => ({ ...r, vitals: vitals[0] ?? null, roomCode: rooms.find((x) => x.id === r.roomId)?.code ?? null })),
  };
}

/** Accept: With Doctor + consultation timer starts; Reception is told (spec §10, §20). */
export async function accept(actor: Actor, appointmentId: string) {
  return prisma.$transaction(async (tx) => {
    const a = await ownAppointment(actor, appointmentId, tx);
    if (!['CHECKED_IN', 'WAITING'].includes(a.status)) throw new ConflictError('NOT_WAITING', 'Patient abhi check-in / waiting mein nahi.');
    const now = new Date();
    await transitionAppointment(tx, actor, a, 'WITH_DOCTOR', { data: { acceptedAt: now } });
    const p = await tx.patient.findUniqueOrThrow({ where: { id: a.patientId }, select: { name: true } });
    const room = a.roomId ? await tx.room.findUnique({ where: { id: a.roomId }, select: { code: true } }) : null;
    await notifyRoles(tx, ['RECEPTIONIST'], {
      type: 'PATIENT_ACCEPTED',
      subject: `Doctor ne accept kiya: ${p.name}`,
      body: `Consultation timer shuru · ${actor.displayName}${room ? ` · Room ${room.code}` : ''}`,
      recordType: 'Appointment',
      recordId: a.id,
      sender: actor,
      actionLabel: 'Patient ko room bhejein',
      dedupeKey: `appointment:${a.id}:accepted`,
    });
    await journeyChanged(tx, { ...a, status: 'WITH_DOCTOR' });
    return tx.appointment.findUniqueOrThrow({ where: { id: a.id } });
  });
}

// ───────────── History (spec §10, §22) — never product cost, never delete ─────────────

export async function myPatients(actor: Actor, q?: string) {
  const where: Prisma.PatientWhereInput = { appointments: { some: { doctorId: actor.id! } } };
  if (q?.trim()) {
    const frag = phoneSearchFragment(q);
    where.OR = [{ name: { contains: q.trim() } }, ...(frag ? [{ phone: { contains: frag } }] : [])];
  }
  const rows = await prisma.patient.findMany({ where, select: { ...patientMini, phone: true }, take: 100, orderBy: { name: 'asc' } });
  return { items: rows };
}

/**
 * Date-wise history, view-only. A Doctor sees their own visits with their own patients; another Doctor's visits
 * (or a patient they never treated) only with an approved, unexpired Manager access request. Before approval
 * nothing about the patient is returned (403, audited).
 */
export async function patientHistory(actor: Actor, patientId: string) {
  const own = await isDoctorsOwnPatient(actor.id!, patientId);
  const approved = await hasApprovedHistoryAccess(actor.id!, patientId);
  if (!own && !approved) deny('Patient', patientId, 'doctor:history_requires_manager_approval');
  const patient = await prisma.patient.findUniqueOrThrow({ where: { id: patientId }, select: { ...patientMini, phone: true } });
  const visits = await prisma.appointment.findMany({
    where: { patientId, ...(approved ? {} : { doctorId: actor.id! }), status: { notIn: ['CANCELLED', 'RESCHEDULED'] } },
    select: {
      id: true,
      startAt: true,
      type: true,
      status: true,
      reason: true,
      doctorId: true,
      vitals: { select: { bpSystolic: true, bpDiastolic: true, glucoseMgDl: true, weightGrams: true, heightMm: true, skipped: true, createdAt: true } },
    },
    orderBy: { startAt: 'desc' },
  });
  const ids = visits.map((v) => v.id);
  const [plans, invoices, tasks, doctors] = await Promise.all([
    prisma.treatmentPlan.findMany({
      where: { appointmentId: { in: ids } },
      select: {
        appointmentId: true,
        currentVersionNo: true,
        versions: {
          orderBy: { versionNo: 'desc' },
          take: 1,
          select: { versionNo: true, consultationReason: true, grandTotalPaisa: true, items: { select: { sessionNumber: true, procedureName: true, sameDay: true, scheduledStart: true, status: true }, orderBy: { sessionNumber: 'asc' } } },
        },
      },
    }),
    prisma.invoice.findMany({ where: { appointmentId: { in: ids } }, select: { id: true, appointmentId: true } }),
    prisma.procedureTask.findMany({ where: { appointmentId: { in: ids } }, select: { id: true, appointmentId: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(visits.flatMap((v) => v.doctorId ?? []))] } }, select: { id: true, displayName: true } }),
  ]);
  // Clinical documents (prescription, consent, before/after) — metadata only; opened through /api/files (scope-checked).
  const attachments = await prisma.attachment.findMany({
    where: {
      OR: [
        { recordType: 'Invoice', recordId: { in: invoices.map((i) => i.id) } },
        { recordType: 'ProcedureTask', recordId: { in: tasks.map((t) => t.id) } },
      ],
      route: { in: ['prescriptionPhoto', 'consentForm', 'beforePhoto', 'afterPhoto'] },
    },
    select: { id: true, route: true, fileName: true, createdAt: true, recordType: true, recordId: true },
  });
  if (approved && !own) {
    await audit(prisma, actor, { action: 'HISTORY_VIEWED_WITH_APPROVAL', recordType: 'Patient', recordId: patientId });
  }
  return {
    patient,
    access: own ? 'own' : 'approved',
    visits: visits.map((v) => {
      const invoiceIds = invoices.filter((i) => i.appointmentId === v.id).map((i) => i.id);
      const taskIds = tasks.filter((t) => t.appointmentId === v.id).map((t) => t.id);
      const plan = plans.find((p) => p.appointmentId === v.id)?.versions[0] ?? null;
      return {
        ...v,
        doctorName: doctors.find((d) => d.id === v.doctorId)?.displayName ?? null,
        plan,
        documents: attachments.filter((a) => (a.recordType === 'Invoice' && invoiceIds.includes(a.recordId)) || (a.recordType === 'ProcedureTask' && taskIds.includes(a.recordId))),
      };
    }),
  };
}

// ───────────── Other-Doctor history access (spec §4, §10) ─────────────

/** Request by phone + reason. Returns no patient data; Manager decides. One request per patient on that number. */
export async function requestHistoryAccess(actor: Actor, phone: string, reason: string) {
  if (reason.trim().length < 5) throw new ValidationError('Access ki wajah likhein.');
  const frag = phoneSearchFragment(phone);
  if (!frag || frag.length < 10) throw new ValidationError('Patient ka poora phone number likhein.');
  return prisma.$transaction(async (tx) => {
    const patients = await tx.patient.findMany({ where: { phone: frag, mergedIntoId: null }, select: { id: true } });
    if (!patients.length) throw new NotFoundError('Is number par patient');
    const created = [];
    for (const p of patients) {
      if (await isDoctorsOwnPatient(actor.id!, p.id, tx)) continue;
      const open = await tx.historyAccessRequest.findFirst({ where: { doctorId: actor.id!, patientId: p.id, status: 'PENDING' } });
      if (open) {
        created.push(open);
        continue;
      }
      const r = await tx.historyAccessRequest.create({ data: { doctorId: actor.id!, patientId: p.id, reason } });
      await audit(tx, actor, { action: 'HISTORY_ACCESS_REQUESTED', recordType: 'HistoryAccessRequest', recordId: r.id, reason });
      await notifyRoles(tx, ['MANAGER'], {
        type: 'HISTORY_ACCESS_REQUEST',
        subject: `History access request: ${actor.displayName}`,
        body: reason,
        recordType: 'HistoryAccessRequest',
        recordId: r.id,
        sender: actor,
        actionLabel: 'Approve / reject',
        dedupeKey: `history:${r.id}`,
      });
      created.push(r);
    }
    if (!created.length) throw new ConflictError('OWN_PATIENT', 'Yeh aap ka apna patient hai — "My Patients" se history kholen.');
    return { requests: created.map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt })) };
  });
}

export async function myHistoryRequests(actor: Actor) {
  const rows = await prisma.historyAccessRequest.findMany({ where: { doctorId: actor.id! }, orderBy: { createdAt: 'desc' }, take: 100 });
  const approvedIds = rows.filter((r) => r.status === 'APPROVED').map((r) => r.patientId);
  const names = await prisma.patient.findMany({ where: { id: { in: approvedIds } }, select: { id: true, name: true } });
  const now = new Date();
  return {
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      decisionReason: r.decisionReason,
      expiresAt: r.expiresAt,
      active: r.status === 'APPROVED' && (!r.expiresAt || r.expiresAt > now),
      // Identity only after approval (spec §22).
      patientId: r.status === 'APPROVED' ? r.patientId : null,
      patientName: r.status === 'APPROVED' ? (names.find((n) => n.id === r.patientId)?.name ?? null) : null,
    })),
  };
}

// ───────────── Treatment plan (spec §10, §19) ─────────────

export interface PlanItemInput {
  serviceId?: string;
  procedureName: string;
  sameDay: boolean;
  start?: Date; // required for future items
  roomId?: string;
  pricePaisa: number;
  discountPaisa: number;
}

export interface PlanInput {
  consultationReason: string;
  consultationFeePaisa: number;
  consultationFeeWaived: boolean;
  consultationDiscountPaisa: number;
  items: PlanItemInput[];
  totalDiscountPaisa: number;
  advanceRequestedPaisa: number;
  installmentCount: number;
  firstInstallmentDate?: string;
  installmentIntervalDays?: number;
}

const PLAN_EDITABLE = ['WITH_DOCTOR', 'RECEPTION'] as const;

/**
 * Save the plan as a new immutable version. Future items are booked as procedure appointments through the
 * scheduling engine (occupying Doctor + procedure room, spec §6 row 9) in the same transaction; a slot conflict
 * rolls everything back and names the item. Bookings of the previous version are released.
 */
export async function savePlan(actor: Actor, appointmentId: string, input: PlanInput) {
  const today = clinicDateStr(new Date());
  const limits = { maxItems: await getSetting('plan.maxItems'), maxInstallments: await getSetting('plan.maxInstallments') };
  const money = computePlanMoney(
    {
      consultationFeePaisa: BigInt(input.consultationFeePaisa),
      consultationFeeWaived: input.consultationFeeWaived,
      consultationDiscountPaisa: BigInt(input.consultationDiscountPaisa),
      items: input.items.map((i) => ({ pricePaisa: BigInt(i.pricePaisa), discountPaisa: BigInt(i.discountPaisa) })),
      totalDiscountPaisa: BigInt(input.totalDiscountPaisa),
      advanceRequestedPaisa: BigInt(input.advanceRequestedPaisa),
      installmentCount: input.installmentCount,
      firstInstallmentDate: input.firstInstallmentDate,
      installmentIntervalDays: input.installmentIntervalDays,
    },
    limits,
    today,
  );
  input.items.forEach((it, idx) => {
    if (!it.procedureName.trim()) throw new ValidationError(`Item ${idx + 1}: procedure ka naam likhein.`);
    if (!it.sameDay && !it.start) throw new ValidationError(`Item ${idx + 1}: future session ki date/time chunein.`);
  });

  return prisma.$transaction(async (tx) => {
    const a = await ownAppointment(actor, appointmentId, tx);
    if (!(PLAN_EDITABLE as readonly string[]).includes(a.status)) throw new ConflictError('PLAN_LOCKED', 'Plan sirf consultation ke dauran ya Reception bhejne ke foran baad badla ja sakta hai.');
    if (await tx.invoice.findUnique({ where: { appointmentId } })) throw new ConflictError('PLAN_LOCKED', 'Invoice ban chuki hai — plan ab nahi badla ja sakta. Naye plan ke liye nayi consultation.');

    const plan = (await tx.treatmentPlan.findUnique({ where: { appointmentId } })) ?? (await tx.treatmentPlan.create({ data: { patientId: a.patientId, doctorId: actor.id!, appointmentId } }));
    // Release the previous version's future bookings (replaced by this version).
    if (plan.currentVersionNo > 0) {
      const prev = await tx.treatmentPlanVersion.findUniqueOrThrow({ where: { planId_versionNo: { planId: plan.id, versionNo: plan.currentVersionNo } }, include: { items: true } });
      for (const it of prev.items) {
        const booked = await tx.appointment.findUnique({ where: { treatmentPlanItemId: it.id } });
        if (booked && ['CONFIRMED', 'DRAFT'].includes(booked.status)) await cancelInTx(tx, actor, booked.id, 'Treatment plan revised');
        if (['PLANNED', 'SCHEDULED'].includes(it.status)) await tx.treatmentPlanItem.update({ where: { id: it.id }, data: { status: 'SUPERSEDED' } });
      }
    }
    const versionNo = plan.currentVersionNo + 1;
    const now = new Date();
    const version = await tx.treatmentPlanVersion.create({
      data: {
        planId: plan.id,
        versionNo,
        consultationReason: input.consultationReason,
        consultationFeePaisa: BigInt(input.consultationFeePaisa),
        consultationFeeWaived: input.consultationFeeWaived,
        consultationDiscountPaisa: BigInt(input.consultationDiscountPaisa),
        itemsSubtotalPaisa: money.itemsSubtotalPaisa,
        itemsDiscountPaisa: money.itemsDiscountPaisa,
        totalDiscountPaisa: money.totalDiscountPaisa,
        grandTotalPaisa: money.grandTotalPaisa,
        advanceRequestedPaisa: money.advanceRequestedPaisa,
        balancePaisa: money.balancePaisa,
        installmentCount: money.installments.length,
        createdById: actor.id!,
        installments: { create: money.installments.map((x) => ({ seq: x.seq, dueDate: dateOnly(x.dueDate), amountPaisa: x.amountPaisa })) },
      },
    });

    const items = [];
    for (const [idx, it] of input.items.entries()) {
      const durationMin = await resolveDuration(tx, 'PROCEDURE', it.serviceId);
      const start = it.sameDay ? now : it.start!;
      const item = await tx.treatmentPlanItem.create({
        data: {
          versionId: version.id,
          sessionNumber: idx + 1,
          serviceId: it.serviceId ?? null,
          procedureName: it.procedureName.trim(),
          sameDay: it.sameDay,
          scheduledStart: start,
          scheduledEnd: addMinutes(start, durationMin),
          roomId: it.roomId ?? null,
          pricePaisa: BigInt(it.pricePaisa),
          discountPaisa: BigInt(it.discountPaisa),
          status: it.sameDay ? 'PLANNED' : 'SCHEDULED',
        },
      });
      if (!it.sameDay) {
        // Each future session is its own dated booking (spec §5, §19) — reminders/tasks are per item.
        try {
          const { appointment } = await bookInTx(tx, actor, {
            patientId: a.patientId,
            doctorId: actor.id!,
            type: 'PROCEDURE',
            serviceId: it.serviceId ?? null,
            reason: `${it.procedureName} — session ${idx + 1}`,
            start: it.start!,
            durationMin,
            roomId: it.roomId,
            source: 'DOCTOR_PLAN',
            treatmentPlanItemId: item.id,
            leadId: a.leadId,
            leadMemberId: a.leadMemberId,
            sheetId: a.sheetId,
          });
          await tx.treatmentPlanItem.update({ where: { id: item.id }, data: { roomId: appointment.roomId, scheduledStart: appointment.startAt, scheduledEnd: appointment.endAt } });
        } catch (e) {
          if (e instanceof SlotUnavailableError) {
            throw new ConflictError('SLOT_UNAVAILABLE', `Item ${idx + 1} (${it.procedureName}): ${e.message}`, { ...(e.details as object), itemIndex: idx });
          }
          throw e;
        }
      }
      items.push(item);
    }
    await tx.treatmentPlan.update({ where: { id: plan.id }, data: { currentVersionNo: versionNo } });
    await audit(tx, actor, {
      action: versionNo === 1 ? 'TREATMENT_PLAN_CREATED' : 'TREATMENT_PLAN_REVISED',
      recordType: 'TreatmentPlan',
      recordId: plan.id,
      after: { versionNo, grandTotal: money.grandTotalPaisa, advance: money.advanceRequestedPaisa, balance: money.balancePaisa, items: items.length, installments: money.installments.length },
    });
    return planView(tx, plan.id);
  }, TX_OPTS);
}

async function planView(db: Tx | typeof prisma, planId: string) {
  const plan = await db.treatmentPlan.findUniqueOrThrow({ where: { id: planId } });
  if (plan.currentVersionNo === 0) return { planId, version: null };
  const version = await db.treatmentPlanVersion.findUniqueOrThrow({
    where: { planId_versionNo: { planId, versionNo: plan.currentVersionNo } },
    include: { items: { orderBy: { sessionNumber: 'asc' } }, installments: { orderBy: { seq: 'asc' } } },
  });
  const rooms = await db.room.findMany({ select: { id: true, code: true } });
  return {
    planId,
    version: {
      ...version,
      items: version.items.map((i) => ({ ...i, roomCode: rooms.find((r) => r.id === i.roomId)?.code ?? null })),
      installments: version.installments.map((i) => ({ ...i, dueDate: dateOnlyStr(i.dueDate) })),
    },
  };
}

export async function getConsultation(actor: Actor, appointmentId: string) {
  const a = await ownAppointment(actor, appointmentId);
  const [patient, vitals, plan, room] = await Promise.all([
    prisma.patient.findUniqueOrThrow({ where: { id: a.patientId }, select: { ...patientMini, phone: true } }),
    prisma.vitals.findMany({ where: { appointmentId }, orderBy: { createdAt: 'desc' } }),
    prisma.treatmentPlan.findUnique({ where: { appointmentId } }),
    a.roomId ? prisma.room.findUnique({ where: { id: a.roomId }, select: { code: true } }) : null,
  ]);
  return {
    appointment: { ...a, roomCode: room?.code ?? null },
    patient,
    vitals,
    plan: plan ? await planView(prisma, plan.id) : null,
    invoiceExists: !!(await prisma.invoice.findUnique({ where: { appointmentId }, select: { id: true } })),
  };
}

/** Send to Reception (spec §10): requires a saved plan; Reception gets a collection task and the charges. */
export async function sendToReception(actor: Actor, appointmentId: string) {
  return prisma.$transaction(async (tx) => {
    const a = await ownAppointment(actor, appointmentId, tx);
    if (a.status !== 'WITH_DOCTOR') throw new ConflictError('NOT_WITH_DOCTOR', 'Pehle patient accept karein.');
    const plan = await tx.treatmentPlan.findUnique({ where: { appointmentId } });
    if (!plan || plan.currentVersionNo === 0) throw new ConflictError('PLAN_REQUIRED', 'Reception bhejne se pehle consultation reason aur charges (plan) save karein.');
    const version = await tx.treatmentPlanVersion.findUniqueOrThrow({ where: { planId_versionNo: { planId: plan.id, versionNo: plan.currentVersionNo } }, include: { items: true } });
    const now = new Date();
    await transitionAppointment(tx, actor, a, 'RECEPTION', { data: { sentToReceptionAt: now } });
    const p = await tx.patient.findUniqueOrThrow({ where: { id: a.patientId }, select: { name: true } });
    const sameDay = version.items.filter((i) => i.sameDay).length;
    const future = version.items.length - sameDay;
    await tx.workflowTask.upsert({
      where: { idempotencyKey: `appointment:${a.id}:collection` },
      update: {},
      create: {
        type: 'RECEPTION_COLLECTION',
        title: `Collection: ${p.name}`,
        patientId: a.patientId,
        appointmentId: a.id,
        assignedRole: 'RECEPTIONIST',
        idempotencyKey: `appointment:${a.id}:collection`,
        payload: { planVersionId: version.id, sameDayItems: sameDay, futureItems: future },
      },
    });
    await notifyRoles(tx, ['RECEPTIONIST'], {
      type: 'SENT_TO_RECEPTION',
      subject: `Consultation complete: ${p.name}`,
      body: `Total Rs ${Number(version.grandTotalPaisa) / 100} · advance Rs ${Number(version.advanceRequestedPaisa) / 100}${sameDay ? ` · ${sameDay} same-day procedure` : ''}${future ? ` · ${future} future session` : ''}`,
      recordType: 'Appointment',
      recordId: a.id,
      sender: actor,
      actionLabel: 'Billing',
      dedupeKey: `appointment:${a.id}:sent`,
    });
    await audit(tx, actor, { action: 'SENT_TO_RECEPTION', recordType: 'Appointment', recordId: a.id, after: { planVersionId: version.id } });
    await journeyChanged(tx, { ...a, status: 'RECEPTION' });
    return tx.appointment.findUniqueOrThrow({ where: { id: a.id } });
  });
}

// ───────────── Leave / availability (spec §10, §11) ─────────────

export interface AvailabilityInput {
  kind: AvailabilityKind;
  date: string;
  startMinute?: number;
  endMinute?: number;
  reason?: string;
}

function validateAvailability(i: AvailabilityInput) {
  const today = clinicDateStr(new Date());
  if (i.date < today) throw new ValidationError('Guzri hui date ke liye nahi.');
  const partial = i.startMinute !== undefined || i.endMinute !== undefined;
  if (i.kind === 'ALTERNATE_HOURS' && !partial) throw new ValidationError('Alternate hours ke liye start aur end time chunein.');
  if (partial && (i.startMinute === undefined || i.endMinute === undefined || i.endMinute <= i.startMinute)) throw new ValidationError('End time start ke baad hona chahiye.');
}

/** Appointments and planned procedures affected by leave/absence on a date (spec §11: shown to Doctor + Manager). */
export async function leaveImpact(doctorId: string, i: Pick<AvailabilityInput, 'date' | 'startMinute' | 'endMinute'>) {
  const day = clinicDayBounds(i.date);
  const from = i.startMinute !== undefined ? atClinicMinute(i.date, i.startMinute) : day.start;
  const to = i.endMinute !== undefined ? atClinicMinute(i.date, i.endMinute) : day.end;
  const rows = await prisma.appointment.findMany({
    where: { doctorId, status: { in: ['CONFIRMED', 'DRAFT', 'CHECKED_IN', 'WAITING'] }, startAt: { lt: to }, endAt: { gt: from } },
    select: { id: true, startAt: true, endAt: true, type: true, treatmentPlanItemId: true, patient: { select: { id: true, name: true, phone: true } } },
    orderBy: { startAt: 'asc' },
  });
  const affected = rows.filter((r) => overlaps(r.startAt, r.endAt, from, to));
  return { count: affected.length, items: affected.map((r) => ({ ...r, source: r.treatmentPlanItemId ? 'planned_procedure' : 'appointment' })) };
}

/**
 * LEAVE / ABSENT confirm immediately (new slots hidden; existing bookings stay for the Manager to resolve).
 * ALTERNATE_HOURS stay PENDING until the Manager approves — never bookable before that (spec §4).
 */
export async function setAvailability(actor: Actor, input: AvailabilityInput) {
  validateAvailability(input);
  const impact = input.kind === 'ALTERNATE_HOURS' ? { count: 0, items: [] } : await leaveImpact(actor.id!, input);
  return prisma.$transaction(async (tx) => {
    const ex = await tx.doctorAvailabilityException.create({
      data: {
        doctorId: actor.id!,
        kind: input.kind,
        date: dateOnly(input.date),
        startMinute: input.startMinute ?? null,
        endMinute: input.endMinute ?? null,
        reason: input.reason ?? null,
        status: input.kind === 'ALTERNATE_HOURS' ? 'PENDING' : 'APPROVED',
        requestedById: actor.id!,
      },
    });
    await audit(tx, actor, { action: `DOCTOR_${input.kind}_SET`, recordType: 'DoctorAvailabilityException', recordId: ex.id, after: { ...ex, impactCount: impact.count } });
    const when = `${input.date}${input.startMinute !== undefined ? ` ${String(Math.floor(input.startMinute / 60)).padStart(2, '0')}:${String(input.startMinute % 60).padStart(2, '0')}–${String(Math.floor(input.endMinute! / 60)).padStart(2, '0')}:${String(input.endMinute! % 60).padStart(2, '0')}` : ' (full day)'}`;
    if (input.kind === 'ALTERNATE_HOURS') {
      await notifyRoles(tx, ['MANAGER'], {
        type: 'ALTERNATE_HOURS_REQUEST',
        subject: `Alternate hours approval: ${actor.displayName}`,
        body: `${when}${input.reason ? ` · ${input.reason}` : ''}`,
        recordType: 'DoctorAvailabilityException',
        recordId: ex.id,
        sender: actor,
        actionLabel: 'Approve / reject',
        dedupeKey: `availability:${ex.id}`,
      });
    } else {
      await notifyRoles(tx, ['MANAGER'], {
        type: 'DOCTOR_LEAVE',
        subject: `${input.kind === 'LEAVE' ? 'Leave' : 'Absent'}: ${actor.displayName} — ${impact.count} patient${impact.count === 1 ? '' : 's'} affected`,
        body: when,
        recordType: 'DoctorAvailabilityException',
        recordId: ex.id,
        sender: actor,
        priority: impact.count ? 2 : 0,
        actionLabel: 'Resolve impact',
        dedupeKey: `availability:${ex.id}`,
      });
      if (impact.count) {
        await tx.workflowTask.create({
          data: {
            type: 'MANAGER_LEAVE_IMPACT',
            title: `Leave impact: ${actor.displayName} ${input.date} (${impact.count})`,
            assignedRole: 'MANAGER',
            idempotencyKey: `availability:${ex.id}:impact`,
            payload: { exceptionId: ex.id, appointmentIds: impact.items.map((x) => x.id) },
          },
        });
      }
    }
    return { exception: ex, impact };
  });
}

export async function myAvailability(actor: Actor) {
  const [schedules, exceptions] = await Promise.all([
    prisma.doctorSchedule.findMany({ where: { doctorId: actor.id!, active: true }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] }),
    prisma.doctorAvailabilityException.findMany({ where: { doctorId: actor.id!, date: { gte: dateOnly(clinicDateStr(new Date())) } }, orderBy: { date: 'asc' } }),
  ]);
  return { schedules, exceptions: exceptions.map((e) => ({ ...e, date: dateOnlyStr(e.date) })) };
}

// ───────────── Aftercare (spec §10) ─────────────

export async function aftercareQueue(actor: Actor) {
  const tasks = await prisma.workflowTask.findMany({
    where: { type: 'DOCTOR_AFTERCARE', assignedUserId: actor.id!, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    orderBy: { createdAt: 'asc' },
  });
  const patients = await prisma.patient.findMany({ where: { id: { in: tasks.map((t) => t.patientId!).filter(Boolean) } }, select: { id: true, name: true, whatsappConsent: true } });
  return { items: tasks.map((t) => ({ ...t, patient: patients.find((p) => p.id === t.patientId) ?? null })) };
}

export async function sendAftercare(actor: Actor, appointmentId: string, input: { skip: boolean; content?: string }) {
  if (!input.skip && !input.content?.trim()) throw new ValidationError('Aftercare / medication guidance likhein ya Skip karein.');
  return prisma.$transaction(async (tx) => {
    const a = await ownAppointment(actor, appointmentId, tx);
    if (a.status !== 'DONE') throw new ConflictError('NOT_DONE', 'Aftercare patient Done hone ke baad.');
    if (await tx.aftercare.findUnique({ where: { appointmentId } })) throw new ConflictError('AFTERCARE_DONE', 'Aftercare pehle hi bheja / skip ho chuka hai.');
    const p = await tx.patient.findUniqueOrThrow({ where: { id: a.patientId }, select: { name: true, phone: true, whatsappConsent: true } });
    let outboxId: string | null = null;
    if (!input.skip && p.whatsappConsent) {
      const m = await enqueueMessage(tx, {
        template: 'aftercare',
        toPhone: p.phone,
        patientId: a.patientId,
        payload: { patientName: p.name, doctorName: actor.displayName, guidance: input.content },
        relatedType: 'Appointment',
        relatedId: a.id,
        idempotencyKey: `appointment:${a.id}:aftercare`,
        createdById: actor.id,
      });
      outboxId = m.id;
    }
    const row = await tx.aftercare.create({ data: { appointmentId, doctorId: actor.id!, skipped: input.skip, content: input.skip ? null : input.content!, outboxId } });
    await tx.workflowTask.updateMany({ where: { idempotencyKey: `appointment:${a.id}:aftercare`, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'COMPLETED', completedAt: new Date(), completedById: actor.id } });
    await audit(tx, actor, { action: input.skip ? 'AFTERCARE_SKIPPED' : 'AFTERCARE_SENT', recordType: 'Appointment', recordId: a.id, after: { aftercareId: row.id, outboxId, noConsent: !input.skip && !p.whatsappConsent } });
    return { aftercare: row, delivered: !!outboxId, noConsent: !input.skip && !p.whatsappConsent };
  });
}

// ───────────── Manager decisions used by this phase (screens in Phase 8) ─────────────

export async function decideHistoryAccess(actor: Actor, id: string, approve: boolean, reason?: string) {
  if (!approve && !reason?.trim()) throw new ValidationError('Reject ki wajah likhein.');
  const hours = await getSetting('history.accessHours');
  return prisma.$transaction(async (tx) => {
    const r = await tx.historyAccessRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundError('Request');
    if (r.status !== 'PENDING') throw new ConflictError('ALREADY_DECIDED', 'Is request par faisla ho chuka hai.');
    const updated = await tx.historyAccessRequest.update({
      where: { id },
      data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: actor.id, decidedAt: new Date(), decisionReason: reason ?? null, expiresAt: approve ? new Date(Date.now() + hours * 3600_000) : null },
    });
    await audit(tx, actor, { action: approve ? 'HISTORY_ACCESS_APPROVED' : 'HISTORY_ACCESS_REJECTED', recordType: 'HistoryAccessRequest', recordId: id, reason });
    await notifyUsers(tx, [r.doctorId], { type: 'HISTORY_ACCESS_DECIDED', subject: `History access ${approve ? 'approved' : 'rejected'}`, body: reason, recordType: 'HistoryAccessRequest', recordId: id, sender: actor });
    return updated;
  });
}

export async function decideAlternateHours(actor: Actor, id: string, approve: boolean, reason?: string) {
  if (!approve && !reason?.trim()) throw new ValidationError('Reject ki wajah likhein.');
  return prisma.$transaction(async (tx) => {
    const ex = await tx.doctorAvailabilityException.findUnique({ where: { id } });
    if (!ex || ex.kind !== 'ALTERNATE_HOURS') throw new NotFoundError('Alternate hours request');
    if (ex.status !== 'PENDING') throw new ConflictError('ALREADY_DECIDED', 'Is request par faisla ho chuka hai.');
    const updated = await tx.doctorAvailabilityException.update({ where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: actor.id, decidedAt: new Date(), decisionReason: reason ?? null } });
    await audit(tx, actor, { action: approve ? 'ALTERNATE_HOURS_APPROVED' : 'ALTERNATE_HOURS_REJECTED', recordType: 'DoctorAvailabilityException', recordId: id, reason });
    await notifyUsers(tx, [ex.doctorId], { type: 'ALTERNATE_HOURS_DECIDED', subject: `Alternate hours ${approve ? 'approved — ab booking open' : 'rejected'}`, body: `${dateOnlyStr(ex.date)}${reason ? ` · ${reason}` : ''}`, recordType: 'DoctorAvailabilityException', recordId: id, sender: actor });
    return { ...updated, date: dateOnlyStr(updated.date) };
  });
}

export async function pendingApprovals() {
  const [history, alternate] = await Promise.all([
    prisma.historyAccessRequest.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } }),
    prisma.doctorAvailabilityException.findMany({ where: { kind: 'ALTERNATE_HOURS', status: 'PENDING' }, orderBy: { date: 'asc' } }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: [...history.map((h) => h.doctorId), ...alternate.map((a) => a.doctorId)] } }, select: { id: true, displayName: true } });
  const patients = await prisma.patient.findMany({ where: { id: { in: history.map((h) => h.patientId) } }, select: { id: true, name: true, phone: true } });
  const doc = (id: string) => users.find((u) => u.id === id)?.displayName ?? null;
  return {
    historyAccess: history.map((h) => ({ ...h, doctorName: doc(h.doctorId), patient: patients.find((p) => p.id === h.patientId) ?? null })),
    alternateHours: alternate.map((a) => ({ ...a, date: dateOnlyStr(a.date), doctorName: doc(a.doctorId) })),
  };
}

