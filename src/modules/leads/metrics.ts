import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { addMinutes, clinicDateStr, clinicDayBounds } from '../../lib/time';
import { getSetting } from '../../services/settings';
import { SUCCESSFUL_RESULTS } from './service';

/**
 * Lead Team performance (spec §8). Everything is computed from source records and every total has a
 * drill-down to the exact lead / appointment rows, so "this lead produced this booking / check-in" is visible.
 */
export interface MetricFilter {
  from: string; // clinic date inclusive
  to: string; // clinic date inclusive
  memberId?: string;
  sheetId?: string;
}

export type MetricKey = 'leads' | 'contacted' | 'calls' | 'whatsapp' | 'bookings' | 'checkIns' | 'cancellations' | 'noShows' | 'callbacksDue' | 'callbacksOnTime' | 'callbacksOverdue';

function range(f: MetricFilter) {
  return { gte: clinicDayBounds(f.from).start, lt: clinicDayBounds(f.to).end };
}

/** Leads in scope: on the sheet filter, and (for a member filter) assigned to the member. */
function leadWhere(f: MetricFilter): Prisma.LeadWhereInput {
  return { ...(f.sheetId ? { sheetId: f.sheetId } : {}), ...(f.memberId ? { assignedMemberId: f.memberId } : {}) };
}

/** Bookings = lead-sourced appointments, excluding reschedules (a reschedule is not a new booking). */
function bookingWhere(f: MetricFilter): Prisma.AppointmentWhereInput {
  return {
    source: 'LEAD',
    rescheduledFromId: null,
    createdAt: range(f),
    ...(f.memberId ? { leadMemberId: f.memberId } : {}),
    ...(f.sheetId ? { sheetId: f.sheetId } : {}),
  };
}

function attributedWhere(f: MetricFilter): Prisma.AppointmentWhereInput {
  return { source: 'LEAD', ...(f.memberId ? { leadMemberId: f.memberId } : {}), ...(f.sheetId ? { sheetId: f.sheetId } : {}) };
}

function activityWhere(f: MetricFilter): Prisma.LeadActivityWhereInput {
  return { createdAt: range(f), ...(f.memberId ? { actorId: f.memberId } : {}), ...(f.sheetId ? { lead: { sheetId: f.sheetId } } : {}) };
}

async function where(metric: MetricKey, f: MetricFilter, now: Date) {
  const grace = await getSetting('callbacks.onTimeGraceMin');
  const todayStart = clinicDayBounds(clinicDateStr(now)).start;
  const cbBase: Prisma.LeadCallbackWhereInput = { dueAt: { ...range(f), lte: now }, status: { not: 'SUPERSEDED' }, ...(f.memberId ? { memberId: f.memberId } : {}), ...(f.sheetId ? { lead: { sheetId: f.sheetId } } : {}) };
  switch (metric) {
    case 'leads':
      return { model: 'lead' as const, where: { ...leadWhere(f), createdAt: range(f) } satisfies Prisma.LeadWhereInput };
    case 'contacted':
      return { model: 'activity' as const, where: { ...activityWhere(f), successful: true, channel: { in: ['CALL', 'WHATSAPP'] }, result: { in: SUCCESSFUL_RESULTS } } satisfies Prisma.LeadActivityWhereInput, distinctLead: true };
    case 'calls':
      return { model: 'activity' as const, where: { ...activityWhere(f), channel: 'CALL' } satisfies Prisma.LeadActivityWhereInput };
    case 'whatsapp':
      return { model: 'activity' as const, where: { ...activityWhere(f), channel: 'WHATSAPP' } satisfies Prisma.LeadActivityWhereInput };
    case 'bookings':
      return { model: 'appointment' as const, where: bookingWhere(f) };
    case 'checkIns':
      // Only the final appointment of a reschedule chain is ever checked in, so counting appointments is unique per visit.
      return { model: 'appointment' as const, where: { ...attributedWhere(f), checkedInAt: range(f) } satisfies Prisma.AppointmentWhereInput };
    case 'cancellations':
      return { model: 'appointment' as const, where: { ...attributedWhere(f), status: 'CANCELLED', cancelledAt: range(f) } satisfies Prisma.AppointmentWhereInput };
    case 'noShows':
      return { model: 'appointment' as const, where: { ...attributedWhere(f), status: 'CONFIRMED', checkedInAt: null, startAt: { ...range(f), lt: todayStart } } satisfies Prisma.AppointmentWhereInput };
    case 'callbacksDue':
      return { model: 'callback' as const, where: cbBase, grace, onTime: false };
    case 'callbacksOnTime':
      return { model: 'callback' as const, where: { ...cbBase, status: 'COMPLETED' } satisfies Prisma.LeadCallbackWhereInput, grace, onTime: true };
    case 'callbacksOverdue':
      return { model: 'callback' as const, where: { ...cbBase, status: { in: ['PENDING', 'DUE'] } } satisfies Prisma.LeadCallbackWhereInput, grace, onTime: false };
  }
}

async function count(metric: MetricKey, f: MetricFilter, now: Date): Promise<number> {
  const w = await where(metric, f, now);
  switch (w.model) {
    case 'lead':
      return prisma.lead.count({ where: w.where });
    case 'appointment':
      return prisma.appointment.count({ where: w.where });
    case 'activity':
      if ('distinctLead' in w) return (await prisma.leadActivity.groupBy({ by: ['leadId'], where: w.where })).length;
      return prisma.leadActivity.count({ where: w.where });
    case 'callback': {
      if (!w.onTime) return prisma.leadCallback.count({ where: w.where });
      const rows = await prisma.leadCallback.findMany({ where: w.where, select: { dueAt: true, completedAt: true } });
      return rows.filter((r) => r.completedAt && r.completedAt <= addMinutes(r.dueAt, w.grace)).length;
    }
  }
}

/** Basis-point ratio (integer math): 10000 = 100%. */
function ratioBp(num: number, den: number): number | null {
  return den === 0 ? null : Math.round((num * 10000) / den);
}

export async function computeMetrics(f: MetricFilter, now = new Date()) {
  const keys: MetricKey[] = ['leads', 'contacted', 'calls', 'whatsapp', 'bookings', 'checkIns', 'cancellations', 'noShows', 'callbacksDue', 'callbacksOnTime', 'callbacksOverdue'];
  const values = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await count(k, f, now)] as const))) as Record<MetricKey, number>;
  const lastAction = await prisma.leadActivity.findFirst({ where: activityWhere({ ...f, from: '2000-01-01', to: clinicDateStr(now) }), orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return {
    filter: f,
    ...values,
    conversion: {
      contactedToBookingBp: ratioBp(values.bookings, values.contacted),
      bookingToCheckInBp: ratioBp(values.checkIns, values.bookings),
    },
    followUpCompliance: { due: values.callbacksDue, onTime: values.callbacksOnTime, overdue: values.callbacksOverdue, onTimeBp: ratioBp(values.callbacksOnTime, values.callbacksDue), lastActionAt: lastAction?.createdAt ?? null },
  };
}

/** Rows behind a metric — lead, sheet/campaign, member and (for appointment metrics) the appointment. */
export async function drilldown(metric: MetricKey, f: MetricFilter, now = new Date()) {
  const w = await where(metric, f, now);
  const leadSel = { id: true, name: true, phone: true, status: true, assignedMemberId: true, sheet: { select: { id: true, title: true, campaign: true } } } as const;
  switch (w.model) {
    case 'lead':
      return prisma.lead.findMany({ where: w.where, select: { ...leadSel, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 500 });
    case 'appointment': {
      const rows = await prisma.appointment.findMany({
        where: w.where,
        select: { id: true, startAt: true, status: true, type: true, createdAt: true, checkedInAt: true, cancelledAt: true, leadId: true, leadMemberId: true, sheetId: true, patient: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      const leads = await prisma.lead.findMany({ where: { id: { in: rows.map((r) => r.leadId).filter((x): x is string => !!x) } }, select: leadSel });
      return rows.map((r) => ({ ...r, lead: leads.find((l) => l.id === r.leadId) ?? null }));
    }
    case 'activity':
      return prisma.leadActivity.findMany({ where: w.where, include: { lead: { select: leadSel } }, orderBy: { createdAt: 'desc' }, take: 500 });
    case 'callback': {
      const rows = await prisma.leadCallback.findMany({ where: w.where, include: { lead: { select: leadSel } }, orderBy: { dueAt: 'desc' }, take: 500 });
      return w.onTime ? rows.filter((r) => r.completedAt && r.completedAt <= addMinutes(r.dueAt, w.grace)) : rows;
    }
  }
}

/** Per-member and per-campaign breakdown for Hamza / Muaz / MD / Manager (spec §16–17). */
export async function breakdown(f: Omit<MetricFilter, 'memberId' | 'sheetId'>, now = new Date()) {
  const members = await prisma.user.findMany({ where: { role: 'LEAD_MEMBER' }, select: { id: true, displayName: true, memberCode: true, active: true } });
  const sheets = await prisma.metaSheet.findMany({ select: { id: true, title: true, campaign: true } });
  const byMember = await Promise.all(members.map(async (m) => ({ member: m, metrics: await computeMetrics({ ...f, memberId: m.id }, now) })));
  const bySheet = await Promise.all(sheets.map(async (s) => ({ sheet: s, metrics: await computeMetrics({ ...f, sheetId: s.id }, now) })));
  return { totals: await computeMetrics(f, now), byMember, bySheet };
}
