import type { AppointmentStatus, PaymentMethod, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ConflictError, LockedError, NotFoundError, ValidationError } from '../../lib/errors';
import { formatNumber, nextSequence, randomToken } from '../../lib/misc';
import { phoneSearchFragment } from '../../lib/phone';
import { addDaysStr, clinicDateStr, clinicDayBounds, dateOnly, dateOnlyStr, formatClinic, local } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { transitionAppointment } from '../../services/appointmentStatus';
import { announceAppointment } from '../../services/bookingMessages';
import { enqueueMessage } from '../../services/messaging';
import { notifyRoles, notifyUsers } from '../../services/notifications';
import { bookInTx, buildDoctorDay, cancelInTx, TX_OPTS } from '../../services/scheduling';
import { getSetting } from '../../services/settings';
import { journeyChanged } from '../../services/tracker';
import { env } from '../../config/env';
import { createPatient, type NewPatientInput } from '../patients/service';
import { balanceCovered, invoiceInstallments } from '../../services/installments';

// ───────────── Projections (front-desk data only — no clinical notes / history) ─────────────

const patientCard = { id: true, name: true, phone: true, ageYears: true, gender: true, contactConsent: true, whatsappConsent: true, createdAt: true } as const;

const apptRow = {
  id: true,
  startAt: true,
  endAt: true,
  type: true,
  status: true,
  reason: true,
  source: true,
  roomId: true,
  doctorId: true,
  serviceId: true,
  leadMemberId: true,
  checkedInAt: true,
  acceptedAt: true,
  sentToReceptionAt: true,
  doneAt: true,
  updatedAt: true,
  patient: { select: patientCard },
} as const;

type ApptRow = Prisma.AppointmentGetPayload<{ select: typeof apptRow }>;

async function decorate(rows: ApptRow[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.doctorId, r.leadMemberId].filter((x): x is string => !!x)))];
  const [users, rooms, services, invoices, vitals, history] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }),
    prisma.room.findMany({ select: { id: true, code: true } }),
    prisma.service.findMany({ select: { id: true, name: true } }),
    prisma.invoice.findMany({ where: { appointmentId: { in: rows.map((r) => r.id) } }, select: { id: true, appointmentId: true, status: true, totalPaisa: true, paidPaisa: true, balancePaisa: true } }),
    prisma.vitals.groupBy({ by: ['appointmentId', 'skipped'], where: { appointmentId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }),
    prisma.appointmentStatusHistory.groupBy({ by: ['appointmentId'], where: { appointmentId: { in: rows.map((r) => r.id) } }, _max: { createdAt: true } }),
  ]);
  // Live procedure step + Assistant for patients in a procedure (spec §9 tracker "current owner").
  const tasks = await prisma.procedureTask.findMany({
    where: { appointmentId: { in: rows.filter((r) => r.status === 'PROCEDURE').map((r) => r.id) }, status: { in: ['PENDING', 'IN_PROGRESS', 'BLOCKED'] } },
    select: { id: true, appointmentId: true, currentStep: true, status: true, roomId: true, assistantId: true, updatedAt: true },
  });
  const assistants = await prisma.user.findMany({ where: { id: { in: tasks.map((t) => t.assistantId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } });
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? assistants.find((u) => u.id === id)?.displayName ?? null) : null);
  const stage = (r: ApptRow): { label: string; owner: string } => {
    const t = tasks.find((x) => x.appointmentId === r.id);
    if (!t) return stageOf(r.status);
    const step = t.status === 'BLOCKED' ? 'emergency — Manager replacement' : t.currentStep.replace(/_/g, ' ').toLowerCase();
    return { label: `Procedure · ${step}`, owner: name(t.assistantId) ?? 'Assistant' };
  };
  const roomOf = (r: ApptRow) => tasks.find((x) => x.appointmentId === r.id)?.roomId ?? r.roomId;
  return rows.map((r) => ({
    ...r,
    doctorName: name(r.doctorId),
    leadMemberName: name(r.leadMemberId),
    roomCode: rooms.find((x) => x.id === roomOf(r))?.code ?? null,
    serviceName: services.find((s) => s.id === r.serviceId)?.name ?? null,
    invoice: invoices.find((i) => i.appointmentId === r.id) ?? null,
    vitalsRecorded: vitals.some((v) => v.appointmentId === r.id),
    vitalsStatus: vitals.some((v) => v.appointmentId === r.id && !v.skipped) ? ('recorded' as const) : vitals.some((v) => v.appointmentId === r.id) ? ('skipped' as const) : null,
    stage: stage(r),
    procedureTaskId: tasks.find((x) => x.appointmentId === r.id)?.id ?? null,
    lastUpdateAt: [history.find((h) => h.appointmentId === r.id)?._max.createdAt ?? r.updatedAt, tasks.find((x) => x.appointmentId === r.id)?.updatedAt].filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0]!,
  }));
}

/** Tracker stage label + current owner (spec §3, §9). */
export function stageOf(status: AppointmentStatus): { label: string; owner: 'Reception' | 'Doctor' | 'Assistant' | '—' } {
  switch (status) {
    case 'DRAFT':
    case 'CONFIRMED':
      return { label: 'Booked — not arrived', owner: 'Reception' };
    case 'CHECKED_IN':
      return { label: 'Checked-in (vitals)', owner: 'Reception' };
    case 'WAITING':
      return { label: 'Waiting for Doctor', owner: 'Doctor' };
    case 'WITH_DOCTOR':
      return { label: 'With Doctor', owner: 'Doctor' };
    case 'RECEPTION':
      return { label: 'Sent to Reception', owner: 'Reception' };
    case 'PROCEDURE':
      return { label: 'Procedure', owner: 'Assistant' };
    case 'DONE':
      return { label: 'Done', owner: '—' };
    default:
      return { label: status.charAt(0) + status.slice(1).toLowerCase(), owner: '—' };
  }
}

// ───────────── Search & patients ─────────────

export async function search(q: string) {
  const term = q.trim();
  if (term.length < 2) return { items: [] };
  const frag = phoneSearchFragment(term);
  const patients = await prisma.patient.findMany({
    where: { mergedIntoId: null, OR: [{ name: { contains: term } }, ...(frag ? [{ phone: { contains: frag } }] : [])] },
    select: patientCard,
    take: 25,
    orderBy: { createdAt: 'desc' },
  });
  const now = new Date();
  const appts = await prisma.appointment.findMany({
    where: { patientId: { in: patients.map((p) => p.id) } },
    select: { id: true, patientId: true, startAt: true, status: true, type: true },
    orderBy: { startAt: 'desc' },
  });
  return {
    items: patients.map((p) => {
      const mine = appts.filter((a) => a.patientId === p.id);
      const upcoming = mine.filter((a) => a.startAt >= clinicDayBounds(clinicDateStr(now)).start && ['CONFIRMED', 'CHECKED_IN', 'WAITING', 'WITH_DOCTOR', 'RECEPTION', 'PROCEDURE'].includes(a.status));
      return {
        ...p,
        upcoming: upcoming.sort((a, b) => a.startAt.getTime() - b.startAt.getTime()).slice(0, 3),
        previousVisits: mine.filter((a) => a.status === 'DONE').length,
        lastVisitAt: mine.find((a) => a.status === 'DONE')?.startAt ?? null,
      };
    }),
  };
}

export async function newPatient(actor: Actor, input: NewPatientInput) {
  return prisma.$transaction((tx) => createPatient(tx, actor, input));
}

export async function patientDetail(id: string) {
  const p = await prisma.patient.findUnique({ where: { id }, select: patientCard });
  if (!p) throw new NotFoundError('Patient');
  const rows = await prisma.appointment.findMany({ where: { patientId: id }, select: apptRow, orderBy: { startAt: 'desc' }, take: 50 });
  // Outstanding balance + installment schedule on the patient file (clinic decision Q7).
  const open = await prisma.invoice.findMany({
    where: { patientId: id, balancePaisa: { gt: 0n }, status: { in: ['OPEN', 'CLOSED'] } },
    select: { id: true, number: true, status: true, totalPaisa: true, paidPaisa: true, balancePaisa: true, planVersionId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const balances = await Promise.all(open.map(async (inv) => ({ ...inv, installments: await invoiceInstallments(prisma, inv) })));
  return {
    ...p,
    appointments: await decorate(rows),
    outstandingPaisa: open.reduce((s, i) => s + i.balancePaisa, 0n),
    balances,
  };
}

// ───────────── Today / tracker ─────────────

export interface ListFilter {
  date?: string;
  status?: AppointmentStatus;
  doctorId?: string;
  q?: string;
  active?: boolean;
}

export async function listAppointments(f: ListFilter) {
  const date = f.date ?? clinicDateStr(new Date());
  const b = clinicDayBounds(date);
  const where: Prisma.AppointmentWhereInput = { startAt: { gte: b.start, lt: b.end } };
  if (f.status) where.status = f.status;
  else if (f.active) where.status = { in: ['CONFIRMED', 'CHECKED_IN', 'WAITING', 'WITH_DOCTOR', 'RECEPTION', 'PROCEDURE'] };
  else where.status = { notIn: ['RESCHEDULED'] };
  if (f.doctorId) where.doctorId = f.doctorId;
  if (f.q?.trim()) {
    const frag = phoneSearchFragment(f.q);
    where.patient = { OR: [{ name: { contains: f.q.trim() } }, ...(frag ? [{ phone: { contains: frag } }] : [])] };
  }
  const rows = await prisma.appointment.findMany({ where, select: apptRow, orderBy: { startAt: 'asc' } });
  return { date, items: await decorate(rows) };
}

/** Active patient journey (spec §3): only patients not yet Done/Cancelled and not hidden from the queue. */
export async function tracker(date?: string) {
  const d = date ?? clinicDateStr(new Date());
  const b = clinicDayBounds(d);
  const rows = await prisma.appointment.findMany({
    where: { startAt: { gte: b.start, lt: b.end }, status: { in: ['CHECKED_IN', 'WAITING', 'WITH_DOCTOR', 'RECEPTION', 'PROCEDURE'] }, hiddenFromQueueAt: null },
    select: apptRow,
    orderBy: [{ checkedInAt: 'asc' }, { startAt: 'asc' }],
  });
  const items = await decorate(rows);
  const counts = await prisma.appointment.groupBy({ by: ['status'], where: { startAt: { gte: b.start, lt: b.end } }, _count: { _all: true } });
  return { date: d, items, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) };
}

export async function doctorsToday() {
  const today = clinicDateStr(new Date());
  const doctors = await prisma.user.findMany({ where: { role: 'DOCTOR', active: true }, select: { id: true, displayName: true, doctorProfile: { select: { specialty: true } } }, orderBy: { displayName: 'asc' } });
  const ids = doctors.map((d) => d.id);
  const [schedules, exceptions, appts] = await Promise.all([
    prisma.doctorSchedule.findMany({ where: { doctorId: { in: ids }, active: true } }),
    prisma.doctorAvailabilityException.findMany({ where: { doctorId: { in: ids }, date: dateOnly(today), status: { in: ['APPROVED', 'PENDING'] } } }),
    prisma.appointment.groupBy({ by: ['doctorId', 'status'], where: { doctorId: { in: ids }, startAt: { gte: clinicDayBounds(today).start, lt: clinicDayBounds(today).end } }, _count: { _all: true } }),
  ]);
  return {
    date: today,
    items: doctors.map((d) => {
      const day = buildDoctorDay(
        today,
        schedules.filter((s) => s.doctorId === d.id).map((s) => ({ weekday: s.weekday, startMinute: s.startMinute, endMinute: s.endMinute, effectiveFrom: dateOnlyStr(s.effectiveFrom), effectiveTo: s.effectiveTo ? dateOnlyStr(s.effectiveTo) : null, active: s.active })),
        exceptions.filter((e) => e.doctorId === d.id).map((e) => ({ kind: e.kind, status: e.status, date: dateOnlyStr(e.date), startMinute: e.startMinute, endMinute: e.endMinute })),
      );
      const mine = appts.filter((a) => a.doctorId === d.id);
      const count = (s: AppointmentStatus[]) => mine.filter((a) => s.includes(a.status)).reduce((n, a) => n + a._count._all, 0);
      return {
        ...d,
        windows: day.windows,
        onLeave: day.leave.length > 0,
        leave: day.leave,
        waiting: count(['CHECKED_IN', 'WAITING']),
        withDoctor: count(['WITH_DOCTOR']),
        booked: count(['CONFIRMED', 'CHECKED_IN', 'WAITING', 'WITH_DOCTOR', 'RECEPTION', 'PROCEDURE', 'DONE']),
      };
    }),
  };
}

// ───────────── Booking (walk-in / phone) ─────────────

export interface ReceptionBookInput {
  patientId: string;
  doctorId: string;
  type: 'CONSULTATION' | 'PROCEDURE';
  serviceId?: string;
  reason?: string;
  start: Date;
  roomId?: string;
}

export async function book(actor: Actor, input: ReceptionBookInput, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    const r = await bookInTx(tx, actor, { ...input, serviceId: input.serviceId ?? null, reason: input.reason ?? null, source: 'RECEPTION', idempotencyKey: `reception:${idempotencyKey}` });
    if (!r.replayed) await announceAppointment(tx, actor, r.appointment, 'confirmed');
    return r;
  }, TX_OPTS);
}

/**
 * Reception may cancel before arrival with a mandatory reason (clinic decision Q6, D-026). Patient, Doctor and
 * the linked Lead member are informed via announceAppointment; the Manager is informed too.
 */
export async function cancel(actor: Actor, appointmentId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.appointment.findUnique({ where: { id: appointmentId }, include: { patient: { select: { name: true } } } });
    if (!before) throw new NotFoundError('Appointment');
    if (!['CONFIRMED', 'DRAFT'].includes(before.status)) {
      throw new ConflictError('NOT_CANCELLABLE', 'Sirf aane se pehle (check-in se pehle) wali appointment Reception cancel kar sakti hai.');
    }
    const a = await cancelInTx(tx, actor, appointmentId, reason);
    const fresh = await tx.appointment.findUniqueOrThrow({ where: { id: a.id } });
    await announceAppointment(tx, actor, fresh, 'cancelled', { reason });
    await notifyRoles(tx, ['MANAGER'], {
      type: 'APPOINTMENT_CANCELLED',
      subject: `Reception cancel: ${before.patient.name}`,
      body: `${formatClinic(before.startAt)} · ${reason}`,
      recordType: 'Appointment',
      recordId: fresh.id,
      sender: actor,
      dedupeKey: `appointment:${fresh.id}:cancelled:manager`,
    });
    return fresh;
  }, TX_OPTS);
}

// ───────────── Check-in & vitals (spec §9, §20) ─────────────

export async function checkIn(actor: Actor, appointmentId: string) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const a = await tx.appointment.findUnique({ where: { id: appointmentId }, include: { patient: { select: { name: true } } } });
    if (!a) throw new NotFoundError('Appointment');
    if (clinicDateStr(a.startAt) !== clinicDateStr(now)) {
      throw new ConflictError('NOT_TODAY', `Yeh appointment ${formatClinic(a.startAt, 'dd LLL')} ki hai — sirf usi din check-in ho sakta hai. Reschedule request bhejein.`);
    }
    await transitionAppointment(tx, actor, a, 'CHECKED_IN', { data: { checkedInAt: now, checkedInById: actor.id } });
    const doctorNotice = { recordType: 'Appointment', recordId: a.id, sender: actor, actionLabel: 'Open queue' };
    await notifyUsers(tx, [a.doctorId], { ...doctorNotice, type: 'PATIENT_WAITING', subject: `Patient waiting: ${a.patient.name}`, body: `Arrived ${formatClinic(now, 'h:mm a')} · appointment ${formatClinic(a.startAt, 'h:mm a')}`, dedupeKey: `checkin:${a.id}:doctor` });
    if (a.leadMemberId) {
      await notifyUsers(tx, [a.leadMemberId], { ...doctorNotice, actionLabel: 'Open appointment', type: 'PATIENT_CHECKED_IN', subject: `Patient checked in: ${a.patient.name}`, body: formatClinic(now), dedupeKey: `checkin:${a.id}:lead` });
    }
    await journeyChanged(tx, { ...a, status: 'CHECKED_IN' });
    return tx.appointment.findUniqueOrThrow({ where: { id: a.id } });
  });
}

export interface VitalsInput {
  skip?: boolean;
  skipReason?: string;
  bpSystolic?: number;
  bpDiastolic?: number;
  glucoseMgDl?: number;
  weightKg?: number;
  heightCm?: number;
}

/** Vitals are optional: save or Skip both move the patient to the Doctor's waiting queue (spec §9). */
export async function recordVitals(actor: Actor, appointmentId: string, v: VitalsInput) {
  const hasValue = [v.bpSystolic, v.bpDiastolic, v.glucoseMgDl, v.weightKg, v.heightCm].some((x) => x !== undefined);
  if (!v.skip && !hasValue) throw new ValidationError('Koi vital likhein ya Skip karein.');
  if ((v.bpSystolic === undefined) !== (v.bpDiastolic === undefined)) throw new ValidationError('BP ke dono values (systolic/diastolic) likhein.');
  return prisma.$transaction(async (tx) => {
    const a = await tx.appointment.findUnique({ where: { id: appointmentId } });
    if (!a) throw new NotFoundError('Appointment');
    if (!['CHECKED_IN', 'WAITING'].includes(a.status)) throw new ConflictError('VITALS_NOT_ALLOWED', 'Vitals sirf check-in ke baad aur Doctor ke accept karne se pehle.');
    const row = await tx.vitals.create({
      data: {
        appointmentId,
        skipped: !!v.skip,
        skipReason: v.skip ? (v.skipReason ?? null) : null,
        bpSystolic: v.skip ? null : (v.bpSystolic ?? null),
        bpDiastolic: v.skip ? null : (v.bpDiastolic ?? null),
        glucoseMgDl: v.skip ? null : (v.glucoseMgDl ?? null),
        weightGrams: v.skip || v.weightKg === undefined ? null : Math.round(v.weightKg * 1000),
        heightMm: v.skip || v.heightCm === undefined ? null : Math.round(v.heightCm * 10),
        enteredById: actor.id!,
      },
    });
    await audit(tx, actor, { action: v.skip ? 'VITALS_SKIPPED' : 'VITALS_RECORDED', recordType: 'Appointment', recordId: appointmentId, after: row, reason: v.skipReason });
    if (a.status === 'CHECKED_IN') await transitionAppointment(tx, actor, a, 'WAITING');
    await journeyChanged(tx, { ...a, status: 'WAITING' });
    return row;
  });
}

// ───────────── Billing (spec §9, §5 invoice / payment) ─────────────

async function invoiceNumber(tx: Tx): Promise<string> {
  const prefix = await getSetting('invoice.numberPrefix', tx);
  const year = local(new Date()).year;
  return formatNumber(prefix, year, await nextSequence(tx, `invoice:${year}`));
}

/**
 * Invoice lines come from the Doctor's latest immutable plan version (charges set by the Doctor); when no plan
 * exists, from the configured service price only. Reception never invents or edits clinical charges.
 */
async function buildLines(tx: Tx, appointmentId: string) {
  const plan = await tx.treatmentPlan.findUnique({ where: { appointmentId } });
  const lines: { description: string; planItemId: string | null; unitPricePaisa: bigint; discountPaisa: bigint; lineTotalPaisa: bigint }[] = [];
  let planVersionId: string | null = null;
  let extraDiscount = 0n;
  if (plan && plan.currentVersionNo > 0) {
    const v = await tx.treatmentPlanVersion.findUniqueOrThrow({ where: { planId_versionNo: { planId: plan.id, versionNo: plan.currentVersionNo } }, include: { items: { orderBy: { sessionNumber: 'asc' } } } });
    planVersionId = v.id;
    if (!v.consultationFeeWaived && v.consultationFeePaisa > 0n) {
      lines.push({ description: 'Consultation fee', planItemId: null, unitPricePaisa: v.consultationFeePaisa, discountPaisa: v.consultationDiscountPaisa, lineTotalPaisa: v.consultationFeePaisa - v.consultationDiscountPaisa });
    }
    for (const it of v.items) {
      lines.push({ description: `${it.procedureName} (session ${it.sessionNumber}${it.sameDay ? ', today' : `, ${formatClinic(it.scheduledStart, 'dd LLL')}`})`, planItemId: it.id, unitPricePaisa: it.pricePaisa, discountPaisa: it.discountPaisa, lineTotalPaisa: it.pricePaisa - it.discountPaisa });
    }
    extraDiscount = v.totalDiscountPaisa;
  } else {
    const a = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId }, select: { serviceId: true } });
    const svc = a.serviceId ? await tx.service.findUnique({ where: { id: a.serviceId } }) : null;
    if (svc?.defaultPricePaisa) lines.push({ description: svc.name, planItemId: null, unitPricePaisa: svc.defaultPricePaisa, discountPaisa: 0n, lineTotalPaisa: svc.defaultPricePaisa });
  }
  const subtotal = lines.reduce((s, l) => s + l.unitPricePaisa, 0n);
  const lineDiscounts = lines.reduce((s, l) => s + l.discountPaisa, 0n);
  const total = lines.reduce((s, l) => s + l.lineTotalPaisa, 0n) - extraDiscount;
  return { lines, planVersionId, subtotal, discount: lineDiscounts + extraDiscount, total: total < 0n ? 0n : total };
}

const BILLABLE: AppointmentStatus[] = ['RECEPTION', 'PROCEDURE'];

/** Open (or return) the invoice for a visit. One invoice per appointment (unique). */
export async function openInvoice(actor: Actor, appointmentId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.invoice.findUnique({ where: { appointmentId } });
    if (existing) return existing;
    const a = await tx.appointment.findUnique({ where: { id: appointmentId } });
    if (!a) throw new NotFoundError('Appointment');
    if (!BILLABLE.includes(a.status)) throw new ConflictError('NOT_AT_RECEPTION', 'Invoice tab banti hai jab Doctor patient ko Reception bhej de.');
    const b = await buildLines(tx, appointmentId);
    const inv = await tx.invoice.create({
      data: {
        number: await invoiceNumber(tx),
        patientId: a.patientId,
        appointmentId,
        planVersionId: b.planVersionId,
        subtotalPaisa: b.subtotal,
        discountPaisa: b.discount,
        totalPaisa: b.total,
        paidPaisa: 0n,
        balancePaisa: b.total,
        createdById: actor.id!,
        lines: { create: b.lines.map((l) => ({ ...l, quantity: 1 })) },
      },
    });
    await audit(tx, actor, { action: 'INVOICE_OPENED', recordType: 'Invoice', recordId: inv.id, after: { ...inv, lines: b.lines } });
    return inv;
  });
}

export async function invoiceDetail(invoiceId: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { lines: true, payments: { orderBy: { receivedAt: 'asc' } } } });
  if (!inv) throw new NotFoundError('Invoice');
  const [appt, prescription, feedback, installments, banks] = await Promise.all([
    prisma.appointment.findUniqueOrThrow({ where: { id: inv.appointmentId }, select: apptRow }),
    prisma.attachment.findFirst({ where: { recordType: 'Invoice', recordId: inv.id, route: 'prescriptionPhoto' }, select: { id: true, fileName: true, createdAt: true } }),
    prisma.feedback.findUnique({ where: { appointmentId: inv.appointmentId }, select: { skipped: true, submittedAt: true, doctorRating: true, staffRating: true, clinicRating: true } }),
    invoiceInstallments(prisma, inv),
    prisma.bankAccount.findMany({ where: { active: true }, select: { id: true, name: true, bankName: true } }),
  ]);
  const [decorated] = await decorate([appt]);
  const covered = inv.balancePaisa <= 0n || installments.reduce((s, v) => s + v.outstandingPaisa, 0n) >= inv.balancePaisa;
  const blockers = [
    ...(!prescription ? ['Prescription upload required'] : []),
    ...(decorated!.status === 'PROCEDURE' ? ['Procedure abhi chal raha hai — patient ke wapas aane ka intezar karein.'] : []),
    ...(!covered ? [BALANCE_NOT_SCHEDULED_MSG] : []),
  ];
  return {
    ...inv,
    // Pharmacy lines cancelled by a reversal line are marked (D-048); lines in the order they were added.
    lines: [...inv.lines].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map((l) => ({ ...l, reversed: inv.lines.some((r) => r.reversesLineId === l.id) })),
    appointment: decorated,
    prescription,
    feedback,
    installments,
    bankAccounts: banks,
    canClose: inv.status === 'OPEN' && blockers.length === 0 && decorated!.status === 'RECEPTION',
    closeBlockers: blockers,
  };
}

const BALANCE_NOT_SCHEDULED_MSG = 'Baqi balance installment schedule mein nahi — pehle payment lein ya Doctor plan mein installments hon.';

export interface PaymentInput {
  amountPaisa: number;
  method: PaymentMethod;
  reference?: string;
  bankAccountId?: string;
}

/**
 * Record a payment exactly once (spec §22, §24 "Payment save retry"): the invoice row is locked, the amount may
 * not exceed the balance, and the Idempotency-Key is stored on the payment (unique) so a retry returns the
 * original receipt. Ledger entries and invoice totals change in the same transaction.
 */
export async function recordPayment(actor: Actor, invoiceId: string, p: PaymentInput, idempotencyKey: string) {
  if (!Number.isSafeInteger(p.amountPaisa) || p.amountPaisa <= 0) throw new ValidationError('Amount sahi likhein.');
  if (p.method !== 'CASH' && !p.bankAccountId) throw new ValidationError('Bank / card / cheque payment ke liye bank account chunein.');
  if ((p.method === 'CHEQUE' || p.method === 'BANK_ONLINE') && !p.reference?.trim()) throw new ValidationError('Cheque number / transaction reference likhein.');
  const key = `payment:${idempotencyKey}`;
  return prisma.$transaction(async (tx) => {
    const replay = await tx.payment.findUnique({ where: { idempotencyKey: key } });
    if (replay) return { payment: replay, replayed: true };
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundError('Invoice');
    if (inv.status !== 'OPEN') throw new ConflictError('INVOICE_CLOSED', 'Invoice close ho chuki hai.');
    const amount = BigInt(p.amountPaisa);
    if (amount > inv.balancePaisa) throw new ValidationError(`Amount balance (${Number(inv.balancePaisa) / 100} Rs) se zyada hai.`);
    if (p.bankAccountId && !(await tx.bankAccount.findFirst({ where: { id: p.bankAccountId, active: true } }))) throw new ValidationError('Bank account nahi mila.');
    const year = local(new Date()).year;
    const payment = await tx.payment.create({
      data: {
        receiptNo: formatNumber('VH-RCP', year, await nextSequence(tx, `receipt:${year}`)),
        invoiceId,
        amountPaisa: amount,
        method: p.method,
        reference: p.reference?.trim() || null,
        bankAccountId: p.method === 'CASH' ? null : p.bankAccountId!,
        cashierId: actor.id!,
        idempotencyKey: key,
      },
    });
    await tx.ledgerEntry.create({
      data: {
        account: p.method === 'CASH' ? 'CASH_IN_HAND' : 'BANK',
        bankAccountId: p.method === 'CASH' ? null : p.bankAccountId!,
        amountPaisa: amount,
        refType: 'Payment',
        refId: payment.id,
        memo: `Invoice ${inv.number} · ${p.method}`,
        actorId: actor.id!,
      },
    });
    const updated = await tx.invoice.update({ where: { id: invoiceId }, data: { paidPaisa: inv.paidPaisa + amount, balancePaisa: inv.balancePaisa - amount } });
    await audit(tx, actor, { action: 'PAYMENT_RECEIVED', recordType: 'Invoice', recordId: invoiceId, before: { paid: inv.paidPaisa, balance: inv.balancePaisa }, after: { paymentId: payment.id, receiptNo: payment.receiptNo, amount, method: p.method, paid: updated.paidPaisa, balance: updated.balancePaisa } });
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: inv.appointmentId }, select: { id: true, doctorId: true, status: true } });
    await journeyChanged(tx, appt);
    return { payment, replayed: false };
  });
}

export interface FeedbackInput {
  skip?: boolean;
  doctorRating?: number;
  staffRating?: number;
  clinicRating?: number;
  suggestion?: string;
}

/** Feedback at the desk (or Skip). Skipping never blocks invoice close (spec §4, §9). */
export async function saveFeedback(actor: Actor, appointmentId: string, f: FeedbackInput) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.appointment.findUnique({ where: { id: appointmentId }, select: { id: true, patientId: true } });
    if (!a) throw new NotFoundError('Appointment');
    const existing = await tx.feedback.findUnique({ where: { appointmentId } });
    if (existing?.submittedAt) throw new ConflictError('FEEDBACK_DONE', 'Feedback pehle hi save ho chuka hai.');
    const data = f.skip
      ? { skipped: true, doctorRating: null, staffRating: null, clinicRating: null, suggestion: null, submittedAt: null }
      : { skipped: false, doctorRating: f.doctorRating ?? null, staffRating: f.staffRating ?? null, clinicRating: f.clinicRating ?? null, suggestion: f.suggestion ?? null, submittedAt: new Date() };
    const row = existing
      ? await tx.feedback.update({ where: { id: existing.id }, data })
      : await tx.feedback.create({ data: { appointmentId, patientId: a.patientId, token: randomToken(24), ...data } });
    await audit(tx, actor, { action: f.skip ? 'FEEDBACK_SKIPPED' : 'FEEDBACK_SAVED', recordType: 'Appointment', recordId: appointmentId, after: { feedbackId: row.id, skipped: row.skipped } });
    return row;
  });
}

/**
 * Close the invoice → Patient Done (spec §9). Locked until the prescription-pad photo is uploaded (spec §4).
 * On close: appointment DONE + hidden from the active queue, Doctor told "patient done" (aftercare task),
 * patient thanked (with the feedback link if not given at the desk), Manager follow-up created for tomorrow.
 */
export async function closeInvoice(actor: Actor, invoiceId: string) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundError('Invoice');
    if (inv.status !== 'OPEN') throw new ConflictError('INVOICE_CLOSED', 'Invoice pehle hi close ho chuki hai.');
    const prescription = await tx.attachment.findFirst({ where: { recordType: 'Invoice', recordId: invoiceId, route: 'prescriptionPhoto' } });
    if (!prescription) throw new LockedError('PRESCRIPTION_REQUIRED', 'Prescription upload required');
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: inv.appointmentId }, include: { patient: { select: { id: true, name: true, phone: true, whatsappConsent: true } } } });
    if (appt.status === 'PROCEDURE') throw new LockedError('PROCEDURE_IN_PROGRESS', 'Procedure abhi chal raha hai — patient ke wapas aane ka intezar karein.');
    // Close with a balance only when the installment schedule covers it (clinic decision Q7).
    if (inv.balancePaisa > 0n) {
      const schedule = inv.planVersionId ? await tx.installment.findMany({ where: { versionId: inv.planVersionId } }) : [];
      if (!balanceCovered(inv, schedule, clinicDateStr(now))) throw new LockedError('BALANCE_NOT_SCHEDULED', BALANCE_NOT_SCHEDULED_MSG);
    }

    await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'CLOSED', closedAt: now, closedById: actor.id, prescriptionAttachmentId: prescription.id } });
    await transitionAppointment(tx, actor, appt, 'DONE', { data: { doneAt: now, hiddenFromQueueAt: now } });
    await audit(tx, actor, { action: 'INVOICE_CLOSED', recordType: 'Invoice', recordId: invoiceId, before: { status: 'OPEN' }, after: { status: 'CLOSED', paid: inv.paidPaisa, balance: inv.balancePaisa, prescriptionAttachmentId: prescription.id } });

    // Feedback link for the thanks message, unless given / skipped at the desk.
    let feedback = await tx.feedback.findUnique({ where: { appointmentId: appt.id } });
    feedback ??= await tx.feedback.create({ data: { appointmentId: appt.id, patientId: appt.patientId, token: randomToken(24) } });
    const askFeedback = !feedback.submittedAt && !feedback.skipped;

    await notifyUsers(tx, [appt.doctorId], { type: 'PATIENT_DONE', subject: `Patient done: ${appt.patient.name}`, body: 'Aftercare / medication guidance bhejein ya Skip karein.', recordType: 'Appointment', recordId: appt.id, sender: actor, actionLabel: 'Aftercare', dedupeKey: `done:${appt.id}:doctor` });
    await tx.workflowTask.upsert({
      where: { idempotencyKey: `appointment:${appt.id}:aftercare` },
      update: {},
      create: { type: 'DOCTOR_AFTERCARE', title: `Aftercare: ${appt.patient.name}`, patientId: appt.patientId, appointmentId: appt.id, assignedRole: 'DOCTOR', assignedUserId: appt.doctorId, idempotencyKey: `appointment:${appt.id}:aftercare` },
    });
    if (appt.patient.whatsappConsent) {
      await enqueueMessage(tx, {
        template: 'visit_thanks',
        toPhone: appt.patient.phone,
        patientId: appt.patientId,
        payload: { patientName: appt.patient.name, feedbackLink: askFeedback ? `${env.PUBLIC_APP_URL}/f/${feedback.token}` : null },
        relatedType: 'Appointment',
        relatedId: appt.id,
        idempotencyKey: `appointment:${appt.id}:thanks`,
        createdById: actor.id,
      });
    }
    // Manager calls "yesterday's patients" (spec §14).
    await tx.followUp.upsert({
      where: { appointmentId: appt.id },
      update: {},
      create: { patientId: appt.patientId, appointmentId: appt.id, dueDate: dateOnly(addDaysStr(clinicDateStr(now), 1)) },
    });
    await journeyChanged(tx, { ...appt, status: 'DONE' });
    return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  });
}

export async function doneList(date?: string) {
  const d = date ?? clinicDateStr(new Date());
  const b = clinicDayBounds(d);
  const rows = await prisma.appointment.findMany({ where: { status: 'DONE', doneAt: { gte: b.start, lt: b.end } }, select: apptRow, orderBy: { doneAt: 'desc' } });
  return { date: d, items: await decorate(rows) };
}

// ───────────── Patient complaint & reschedule request ─────────────

export async function patientComplaint(actor: Actor, input: { patientId: string; appointmentId?: string; subject: string; detail: string }) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.patient.findUnique({ where: { id: input.patientId }, select: { name: true } });
    if (!p) throw new NotFoundError('Patient');
    const managers = await tx.user.findMany({ where: { role: 'MANAGER', active: true }, select: { id: true } });
    const c = await tx.complaint.create({
      data: {
        source: 'PATIENT',
        raisedById: actor.id,
        patientId: input.patientId,
        appointmentId: input.appointmentId ?? null,
        subject: input.subject,
        detail: input.detail,
        recipients: { create: managers.map((m) => ({ userId: m.id })) },
      },
    });
    await tx.threadMessage.create({ data: { threadType: 'Complaint', threadId: c.id, authorId: actor.id!, body: input.detail, statusChange: 'PENDING' } });
    await audit(tx, actor, { action: 'PATIENT_COMPLAINT_CREATED', recordType: 'Complaint', recordId: c.id, after: c });
    await notifyRoles(tx, ['MANAGER'], { type: 'PATIENT_COMPLAINT', subject: `Patient complaint: ${p.name}`, body: input.subject, recordType: 'Complaint', recordId: c.id, sender: actor, priority: 1, actionLabel: 'Review', dedupeKey: `complaint:${c.id}:patient` });
    return c;
  });
}

export async function rescheduleRequest(actor: Actor, appointmentId: string, input: { requestedStartAt?: Date; reason: string }) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.appointment.findUnique({ where: { id: appointmentId }, include: { patient: { select: { name: true } } } });
    if (!a) throw new NotFoundError('Appointment');
    if (!['CONFIRMED', 'DRAFT'].includes(a.status)) throw new ConflictError('NOT_RESCHEDULABLE', 'Sirf check-in se pehle wali appointment reschedule ho sakti hai.');
    const open = await tx.rescheduleRequest.findFirst({ where: { appointmentId, status: { in: ['PENDING', 'IN_REVIEW'] } } });
    if (open) throw new ConflictError('REQUEST_EXISTS', 'Is appointment ki reschedule request pehle se Manager ke paas hai.');
    const r = await tx.rescheduleRequest.create({ data: { appointmentId, requestedById: actor.id!, requestedStartAt: input.requestedStartAt ?? null, reason: input.reason } });
    await audit(tx, actor, { action: 'RESCHEDULE_REQUESTED', recordType: 'Appointment', recordId: appointmentId, after: r, reason: input.reason });
    await notifyRoles(tx, ['MANAGER'], {
      type: 'RESCHEDULE_REQUEST',
      subject: `Reschedule request: ${a.patient.name}`,
      body: `${formatClinic(a.startAt)}${input.requestedStartAt ? ` → ${formatClinic(input.requestedStartAt)}` : ''} · ${input.reason}`,
      recordType: 'RescheduleRequest',
      recordId: r.id,
      sender: actor,
      actionLabel: 'Review',
      dedupeKey: `reschedule:${r.id}`,
    });
    return r;
  });
}

export async function bankAccounts() {
  return prisma.bankAccount.findMany({ where: { active: true }, select: { id: true, name: true, bankName: true } });
}
