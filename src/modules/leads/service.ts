import type { AppointmentType, LeadActivityChannel, LeadActivityResult, LeadStatus, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { phoneSearchFragment } from '../../lib/phone';
import { addDaysStr, addMinutes, clinicDateStr, clinicDayBounds } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { announceAppointment } from '../../services/bookingMessages';
import { bookInTx, cancelInTx, rescheduleInTx, TX_OPTS } from '../../services/scheduling';
import { deny } from '../../services/scope';
import { getSetting } from '../../services/settings';
import { createPatient, patientsOnPhone, requirePhone } from '../patients/service';

// ───────────── Scope ─────────────

/** Sheet ids currently assigned to this Lead member (spec §7: only assigned sheets). */
export async function mySheetIds(memberId: string, db: Tx | typeof prisma = prisma): Promise<string[]> {
  const rows = await db.sheetAssignment.findMany({ where: { memberId, unassignedAt: null }, select: { sheetId: true } });
  return rows.map((r) => r.sheetId);
}

async function assertSheet(actor: Actor, sheetId: string, db: Tx | typeof prisma = prisma) {
  if (!(await mySheetIds(actor.id!, db)).includes(sheetId)) deny('MetaSheet', sheetId, 'lead:assigned_sheet');
}

/** Load a lead the member may act on; a lead on a sheet not assigned to them → 403 (audited). */
export async function leadInScope(actor: Actor, leadId: string, db: Tx | typeof prisma = prisma) {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new NotFoundError('Lead');
  if (!(await mySheetIds(actor.id!, db)).includes(lead.sheetId)) deny('Lead', leadId, 'lead:assigned_sheet');
  return lead;
}

/** Appointment the Lead member booked (immutable attribution). */
async function ownBooking(actor: Actor, appointmentId: string, db: Tx | typeof prisma = prisma) {
  const a = await db.appointment.findUnique({ where: { id: appointmentId } });
  if (!a) throw new NotFoundError('Appointment');
  if (a.leadMemberId !== actor.id) deny('Appointment', appointmentId, 'lead:own_booking');
  return a;
}

// ───────────── Sheets ─────────────

export async function listMySheets(actor: Actor) {
  const ids = await mySheetIds(actor.id!);
  if (!ids.length) return [];
  const now = new Date();
  const [sheets, counts, offers] = await Promise.all([
    prisma.metaSheet.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, externalId: true, title: true, campaign: true, createdAt: true }, orderBy: { title: 'asc' } }),
    prisma.lead.groupBy({ by: ['sheetId', 'status'], where: { sheetId: { in: ids } }, _count: { _all: true } }),
    prisma.offer.findMany({
      where: { validFrom: { lte: now }, validTo: { gte: now }, OR: [{ sheetId: { in: ids } }, { sheetId: null }] },
      select: { id: true, title: true, serviceName: true, sheetId: true, validFrom: true, validTo: true, attachmentId: true },
    }),
  ]);
  return sheets.map((s) => {
    const byStatus: Partial<Record<LeadStatus, number>> = {};
    let total = 0;
    for (const c of counts.filter((x) => x.sheetId === s.id)) {
      byStatus[c.status] = c._count._all;
      total += c._count._all;
    }
    return { ...s, leadCount: total, byStatus, activePosters: offers.filter((o) => o.sheetId === s.id || o.sheetId === null) };
  });
}

export async function getMySheet(actor: Actor, sheetId: string) {
  await assertSheet(actor, sheetId);
  const sheets = await listMySheets(actor);
  return sheets.find((s) => s.id === sheetId) ?? (() => { throw new NotFoundError('Sheet'); })();
}

// ───────────── Leads ─────────────

export interface LeadFilter {
  sheetId?: string;
  status?: LeadStatus;
  q?: string;
  due?: boolean;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

const leadRow = {
  id: true,
  name: true,
  phone: true,
  status: true,
  remarks: true,
  nextContactAt: true,
  lastContactAt: true,
  createdAt: true,
  assignedMemberId: true,
  duplicateOfId: true,
  sheet: { select: { id: true, title: true, campaign: true } },
} as const;

export async function listLeads(actor: Actor, f: LeadFilter) {
  const ids = await mySheetIds(actor.id!);
  if (f.sheetId && !ids.includes(f.sheetId)) deny('MetaSheet', f.sheetId, 'lead:assigned_sheet');
  const where: Prisma.LeadWhereInput = { sheetId: f.sheetId ? f.sheetId : { in: ids } };
  if (f.status) where.status = f.status;
  if (f.due) where.nextContactAt = { lte: new Date() };
  if (f.from || f.to) {
    where.createdAt = {
      ...(f.from ? { gte: clinicDayBounds(f.from).start } : {}),
      ...(f.to ? { lt: clinicDayBounds(f.to).end } : {}),
    };
  }
  if (f.q) {
    const frag = phoneSearchFragment(f.q);
    where.OR = [{ name: { contains: f.q.trim() } }, ...(frag ? [{ phone: { contains: frag } }] : [])];
  }
  const items = await prisma.lead.findMany({
    where,
    select: leadRow,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
  const hasMore = items.length > f.limit;
  const page = hasMore ? items.slice(0, f.limit) : items;
  return { items: page, nextCursor: hasMore ? page[page.length - 1]!.id : null };
}

export async function getLead(actor: Actor, leadId: string) {
  await leadInScope(actor, leadId);
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    select: {
      ...leadRow,
      outcome: true,
      activities: { orderBy: { createdAt: 'desc' }, take: 100 },
      callbacks: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
  const appointments = await prisma.appointment.findMany({
    where: { leadId },
    select: { id: true, startAt: true, type: true, status: true, doctorId: true, rescheduledFromId: true, checkedInAt: true },
    orderBy: { startAt: 'desc' },
  });
  return { ...lead, appointments };
}

/** Results that count as a successful contact (spec §8 "Contacted"). */
export const SUCCESSFUL_RESULTS: LeadActivityResult[] = ['CONNECTED', 'REPLIED', 'INTERESTED', 'NOT_INTERESTED', 'CALL_BACK_LATER', 'BOOKED'];
const UNREACHABLE_RESULTS: LeadActivityResult[] = ['NO_ANSWER', 'SWITCHED_OFF', 'WRONG_NUMBER', 'BUSY'];

export interface ActivityInput {
  channel: LeadActivityChannel;
  result?: LeadActivityResult;
  remarks?: string;
  /** Explicit outcome chosen by the member (spec §5 lead statuses). BOOKED only via booking. */
  status?: Extract<LeadStatus, 'NOT_INTERESTED' | 'UNREACHABLE' | 'CONTACTED'>;
}

/** Complete any pending/due callback for the lead (it stays in history with its completion time). */
async function completeCallbacks(tx: Tx, leadId: string, now: Date) {
  await tx.leadCallback.updateMany({ where: { leadId, status: { in: ['PENDING', 'DUE'] } }, data: { status: 'COMPLETED', completedAt: now } });
}

export async function logActivity(actor: Actor, leadId: string, input: ActivityInput) {
  if (input.result === 'BOOKED') throw new ValidationError('BOOKED result sirf booking se set hota hai.');
  if (input.channel !== 'NOTE' && !input.result) throw new ValidationError('Call/WhatsApp ka result chunein.');
  return prisma.$transaction(async (tx) => {
    const lead = await leadInScope(actor, leadId, tx);
    const now = new Date();
    const successful = input.channel !== 'NOTE' && !!input.result && SUCCESSFUL_RESULTS.includes(input.result);
    const activity = await tx.leadActivity.create({
      data: { leadId, actorId: actor.id!, channel: input.channel, result: input.result ?? null, successful, remarks: input.remarks ?? null },
    });

    let status: LeadStatus = lead.status;
    if (lead.status !== 'BOOKED') {
      if (input.status) status = input.status;
      else if (input.result === 'NOT_INTERESTED') status = 'NOT_INTERESTED';
      else if (successful) status = 'CONTACTED';
      else if (input.result && UNREACHABLE_RESULTS.includes(input.result) && lead.status === 'NEW') status = 'UNREACHABLE';
    }
    const contactAttempt = input.channel !== 'NOTE';
    const updated = await tx.lead.update({
      where: { id: leadId },
      data: {
        status,
        remarks: input.remarks ?? lead.remarks,
        ...(contactAttempt ? { lastContactAt: now } : {}),
        // A contact attempt resolves the scheduled follow-up; a new one can be set right after.
        ...(contactAttempt && lead.nextContactAt ? { nextContactAt: null } : {}),
      },
    });
    if (contactAttempt) await completeCallbacks(tx, leadId, now);
    await audit(tx, actor, {
      action: 'LEAD_ACTIVITY_LOGGED',
      recordType: 'Lead',
      recordId: leadId,
      before: { status: lead.status },
      after: { status: updated.status, activityId: activity.id, channel: input.channel, result: input.result },
    });
    return { activity, lead: updated };
  });
}

export type FollowUpPreset = '2h' | '2d' | 'custom';

export async function setFollowUp(actor: Actor, leadId: string, preset: FollowUpPreset, at?: Date) {
  const now = new Date();
  let dueAt: Date;
  if (preset === '2h') dueAt = addMinutes(now, await getSetting('callbacks.twoHourMin'));
  else if (preset === '2d') dueAt = addMinutes(now, 2 * 24 * 60);
  else {
    if (!at) throw new ValidationError('Custom follow-up ke liye date/time chunein.');
    if (at.getTime() <= now.getTime()) throw new ValidationError('Follow-up ka waqt future mein hona chahiye.');
    dueAt = at;
  }
  return prisma.$transaction(async (tx) => {
    const lead = await leadInScope(actor, leadId, tx);
    if (lead.status === 'NOT_INTERESTED') throw new ConflictError('LEAD_CLOSED', 'Not Interested lead par follow-up set nahi ho sakta. Pehle status badlein.');
    // Rescheduling a callback supersedes the old one (kept in history) — the reminder fires once, for the new time.
    const superseded = await tx.leadCallback.updateMany({ where: { leadId, status: { in: ['PENDING', 'DUE'] } }, data: { status: 'SUPERSEDED' } });
    const cb = await tx.leadCallback.create({ data: { leadId, memberId: actor.id!, dueAt, createdById: actor.id! } });
    const updated = await tx.lead.update({
      where: { id: leadId },
      data: { nextContactAt: dueAt, status: lead.status === 'BOOKED' ? 'BOOKED' : 'FOLLOW_UP_DUE' },
    });
    await audit(tx, actor, {
      action: superseded.count ? 'LEAD_FOLLOW_UP_RESCHEDULED' : 'LEAD_FOLLOW_UP_SET',
      recordType: 'Lead',
      recordId: leadId,
      before: { nextContactAt: lead.nextContactAt, status: lead.status },
      after: { nextContactAt: dueAt, callbackId: cb.id, preset, status: updated.status },
    });
    return { callback: cb, lead: updated };
  });
}

/** Reminder queue: due (reminded, not done), overdue, and upcoming callbacks for my leads. */
export async function listCallbacks(actor: Actor, state: 'due' | 'upcoming' | 'all') {
  const ids = await mySheetIds(actor.id!);
  const now = new Date();
  const where: Prisma.LeadCallbackWhereInput = { lead: { sheetId: { in: ids } } };
  if (state === 'due') Object.assign(where, { status: { in: ['PENDING', 'DUE'] }, dueAt: { lte: now } });
  if (state === 'upcoming') Object.assign(where, { status: 'PENDING', dueAt: { gt: now } });
  const rows = await prisma.leadCallback.findMany({
    where,
    include: { lead: { select: { id: true, name: true, phone: true, status: true, sheet: { select: { title: true, campaign: true } } } } },
    orderBy: { dueAt: 'asc' },
    take: 200,
  });
  return rows.map((r) => ({ ...r, overdue: (r.status === 'PENDING' || r.status === 'DUE') && r.dueAt < now }));
}

// ───────────── Booking ─────────────

export interface LeadBookInput {
  patient: { existingPatientId?: string; name?: string; phone?: string; contactConsent?: boolean; whatsappConsent?: boolean; ageYears?: number; gender?: string; confirmSharedPhone?: { reason: string } };
  doctorId: string;
  type: AppointmentType;
  serviceId?: string;
  reason?: string;
  start: Date;
  roomId?: string;
}

/**
 * Lead books directly (spec §7). Scheduling engine runs the final check under lock; on success the booking is
 * attributed immutably to the member, sheet/campaign and lead (spec §8), the lead becomes BOOKED, and Patient,
 * Doctor and Reception receive the same booking details (spec §20).
 */
export async function bookFromLead(actor: Actor, leadId: string, input: LeadBookInput, idempotencyKey: string) {
  return prisma.$transaction(async (tx) => {
    const lead = await leadInScope(actor, leadId, tx);
    const replay = await tx.appointment.findUnique({ where: { idempotencyKey: `lead:${idempotencyKey}` } });
    if (replay) return { appointment: replay, replayed: true };

    let patientId: string;
    if (input.patient.existingPatientId) {
      // The member may only attach a patient registered on the lead's (or entered) phone number.
      const phone = requirePhone(input.patient.phone ?? lead.phone);
      const onPhone = await patientsOnPhone(tx, phone);
      if (!onPhone.some((p) => p.id === input.patient.existingPatientId)) deny('Patient', input.patient.existingPatientId, 'lead:patient_matches_phone');
      patientId = input.patient.existingPatientId;
    } else {
      const p = await createPatient(tx, actor, {
        name: input.patient.name ?? lead.name,
        phone: input.patient.phone ?? lead.phone,
        contactConsent: input.patient.contactConsent ?? false,
        whatsappConsent: input.patient.whatsappConsent ?? false,
        ageYears: input.patient.ageYears,
        gender: input.patient.gender,
        confirmSharedPhone: input.patient.confirmSharedPhone,
      });
      patientId = p.id;
    }

    const { appointment } = await bookInTx(tx, actor, {
      patientId,
      doctorId: input.doctorId,
      type: input.type,
      serviceId: input.serviceId ?? null,
      reason: input.reason ?? null,
      start: input.start,
      roomId: input.roomId,
      source: 'LEAD',
      leadId: lead.id,
      leadMemberId: actor.id,
      sheetId: lead.sheetId,
      idempotencyKey: `lead:${idempotencyKey}`,
    });

    const now = new Date();
    await tx.leadActivity.create({ data: { leadId, actorId: actor.id!, channel: 'NOTE', result: 'BOOKED', successful: true, remarks: `Appointment ${appointment.id}` } });
    await tx.lead.update({ where: { id: leadId }, data: { status: 'BOOKED', outcome: 'BOOKED', nextContactAt: null } });
    await completeCallbacks(tx, leadId, now);
    await audit(tx, actor, { action: 'LEAD_BOOKED', recordType: 'Lead', recordId: leadId, before: { status: lead.status }, after: { status: 'BOOKED', appointmentId: appointment.id } });
    await announceAppointment(tx, actor, appointment, 'confirmed');
    return { appointment, replayed: false };
  }, TX_OPTS);
}

// ───────────── Appointment buckets (spec §7) ─────────────

export type Bucket = 'today' | 'after2' | 'after7' | 'total';

/**
 * Buckets by clinic-local date (docs/DECISIONS.md D-018):
 *  today  = today;  after2 = tomorrow … today+2 ("After Today" = this 2-day list);
 *  after7 = today+3 … today+7;  total = every booking of the member, any date and status.
 */
export function bucketRange(bucket: Bucket, today: string): { start?: Date; end?: Date } {
  switch (bucket) {
    case 'today':
      return clinicDayBounds(today);
    case 'after2':
      return { start: clinicDayBounds(addDaysStr(today, 1)).start, end: clinicDayBounds(addDaysStr(today, 2)).end };
    case 'after7':
      return { start: clinicDayBounds(addDaysStr(today, 3)).start, end: clinicDayBounds(addDaysStr(today, 7)).end };
    case 'total':
      return {};
  }
}

export async function listMyAppointments(actor: Actor, bucket: Bucket, now = new Date()) {
  const today = clinicDateStr(now);
  const r = bucketRange(bucket, today);
  const where: Prisma.AppointmentWhereInput = { leadMemberId: actor.id };
  if (bucket !== 'total') {
    where.startAt = { gte: r.start, lt: r.end };
    where.status = { notIn: ['CANCELLED', 'RESCHEDULED'] };
  }
  const rows = await prisma.appointment.findMany({
    where,
    orderBy: { startAt: bucket === 'total' ? 'desc' : 'asc' },
    take: 500,
    select: {
      id: true,
      startAt: true,
      endAt: true,
      type: true,
      status: true,
      reason: true,
      roomId: true,
      leadId: true,
      sheetId: true,
      rescheduledFromId: true,
      cancelReason: true,
      checkedInAt: true,
      patient: { select: { id: true, name: true, phone: true } },
      doctorId: true,
    },
  });
  const doctors = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((x) => x.doctorId))] } }, select: { id: true, displayName: true } });
  const rooms = await prisma.room.findMany({ select: { id: true, code: true } });
  const counts = await bucketCounts(actor, now);
  return {
    bucket,
    counts,
    items: rows.map((x) => ({
      ...x,
      doctorName: doctors.find((d) => d.id === x.doctorId)?.displayName ?? null,
      roomCode: rooms.find((rm) => rm.id === x.roomId)?.code ?? null,
    })),
  };
}

export async function bucketCounts(actor: Actor, now = new Date()) {
  const today = clinicDateStr(now);
  const active = { leadMemberId: actor.id, status: { notIn: ['CANCELLED', 'RESCHEDULED'] as ('CANCELLED' | 'RESCHEDULED')[] } };
  const count = (b: Exclude<Bucket, 'total'>) => {
    const r = bucketRange(b, today);
    return prisma.appointment.count({ where: { ...active, startAt: { gte: r.start, lt: r.end } } });
  };
  const [t, a2, a7, total, leads] = await Promise.all([
    count('today'),
    count('after2'),
    count('after7'),
    prisma.appointment.count({ where: { leadMemberId: actor.id } }),
    prisma.lead.count({ where: { sheetId: { in: await mySheetIds(actor.id!) } } }),
  ]);
  return { today: t, after2: a2, after7: a7, total, leads };
}

export async function rescheduleOwnBooking(actor: Actor, appointmentId: string, start: Date, reason: string, roomId?: string) {
  if (!reason.trim()) throw new ValidationError('Reschedule ki wajah likhein.');
  return prisma.$transaction(async (tx) => {
    await ownBooking(actor, appointmentId, tx);
    const r = await rescheduleInTx(tx, actor, appointmentId, { start, roomId, reason, requestedById: actor.id! });
    await announceAppointment(tx, actor, r.appointment, 'rescheduled', { reason, previousStartAt: r.old.startAt });
    return r;
  }, TX_OPTS);
}

export async function cancelOwnBooking(actor: Actor, appointmentId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    await ownBooking(actor, appointmentId, tx);
    const a = await cancelInTx(tx, actor, appointmentId, reason);
    const cancelled = await tx.appointment.findUniqueOrThrow({ where: { id: a.id } });
    await announceAppointment(tx, actor, cancelled, 'cancelled', { reason });
    return cancelled;
  }, TX_OPTS);
}
