import type { Prisma, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { clinicDayBounds } from '../../lib/time';
import type { Actor } from '../../services/audit';

/**
 * Audit / history search (spec §14, §22): by date, actor, role, patient, appointment, request and stock item.
 * Shows action, actor, before/after and reason. Confidential clinical content is masked for non-clinical roles
 * (spec "restrict confidential clinical content by role", D-036).
 */
const CLINICAL_KEYS = new Set(['consultationReason', 'diagnosis', 'notes', 'clinicalNotes', 'content', 'bpSystolic', 'bpDiastolic', 'pulse', 'temperature', 'weightKg', 'bloodSugar', 'spo2', 'allergies', 'medicalHistory', 'prescription']);
const CLINICAL_RECORDS = new Set(['TreatmentPlan', 'TreatmentPlanVersion', 'Vitals', 'Aftercare', 'Consultation']);
const MASK = '[restricted]';

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, CLINICAL_KEYS.has(k) ? MASK : redact(x)]));
  return v;
}

export interface AuditFilter {
  from?: string;
  to?: string;
  actorId?: string;
  role?: Role;
  action?: string;
  recordType?: string;
  recordId?: string;
  patientId?: string;
  appointmentId?: string;
  stockItemId?: string;
  requestId?: string;
  cursor?: string;
  limit?: number;
}

/** Every record id that belongs to a patient's journey, so "search by patient" finds all of them. */
async function patientRecordIds(patientId: string) {
  const [appts, invoices, plans, tasks, followups, complaints] = await Promise.all([
    prisma.appointment.findMany({ where: { patientId }, select: { id: true } }),
    prisma.invoice.findMany({ where: { patientId }, select: { id: true } }),
    prisma.treatmentPlan.findMany({ where: { patientId }, select: { id: true } }),
    prisma.procedureTask.findMany({ where: { patientId }, select: { id: true } }),
    prisma.followUp.findMany({ where: { patientId }, select: { id: true } }),
    prisma.complaint.findMany({ where: { patientId }, select: { id: true } }),
  ]);
  return [patientId, ...appts, ...invoices, ...plans, ...tasks, ...followups, ...complaints].map((x) => (typeof x === 'string' ? x : x.id));
}

export async function search(actor: Actor, f: AuditFilter) {
  const where: Prisma.AuditEventWhereInput = {};
  if (f.from || f.to) where.createdAt = { ...(f.from ? { gte: clinicDayBounds(f.from).start } : {}), ...(f.to ? { lt: clinicDayBounds(f.to).end } : {}) };
  if (f.actorId) where.actorId = f.actorId;
  if (f.role) where.actorRole = f.role;
  if (f.action) where.action = { contains: f.action.toUpperCase() };
  if (f.recordType) where.recordType = f.recordType;
  const ids: string[] = [];
  if (f.recordId) ids.push(f.recordId);
  if (f.appointmentId) {
    const inv = await prisma.invoice.findMany({ where: { appointmentId: f.appointmentId }, select: { id: true } });
    const tasks = await prisma.procedureTask.findMany({ where: { appointmentId: f.appointmentId }, select: { id: true } });
    ids.push(f.appointmentId, ...inv.map((i) => i.id), ...tasks.map((t) => t.id));
  }
  if (f.patientId) ids.push(...(await patientRecordIds(f.patientId)));
  if (f.stockItemId) ids.push(f.stockItemId);
  if (f.requestId) ids.push(f.requestId);
  if (ids.length) where.recordId = { in: [...new Set(ids)] };
  if (f.cursor) where.id = { lt: BigInt(f.cursor) };
  const limit = Math.min(f.limit ?? 50, 100);
  const rows = await prisma.auditEvent.findMany({ where, orderBy: { id: 'desc' }, take: limit + 1 });
  const page = rows.slice(0, limit);
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(page.flatMap((r) => [r.actorId, r.onBehalfOfId]).filter((x): x is string => !!x))] } },
    select: { id: true, displayName: true },
  });
  const nameOf = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? null) : null);
  const clinicalReader = actor.role === 'DOCTOR';
  return {
    items: page.map((r) => {
      const mask = !clinicalReader;
      const wholeRecord = mask && CLINICAL_RECORDS.has(r.recordType);
      return {
        id: r.id.toString(),
        at: r.createdAt,
        action: r.action,
        recordType: r.recordType,
        recordId: r.recordId,
        actorId: r.actorId,
        // The hidden developer is shown as "System Developer" (D-043), with the person whose screens were in view.
        actorName: r.actorRole === 'DEVELOPER' ? `System Developer${r.onBehalfOfId ? ` (as ${nameOf(r.onBehalfOfId) ?? 'user'})` : ''}` : r.actorId ? nameOf(r.actorId) : 'System',
        actorRole: r.actorRole,
        reason: r.reason,
        before: wholeRecord ? (r.before ? MASK : null) : mask ? redact(r.before) : r.before,
        after: wholeRecord ? (r.after ? MASK : null) : mask ? redact(r.after) : r.after,
        restricted: wholeRecord,
      };
    }),
    nextCursor: rows.length > limit ? page.at(-1)!.id.toString() : null,
  };
}

/** Filter helpers for the search screen (people and stock items by name). */
export async function lookups() {
  const [users, items] = await Promise.all([
    prisma.user.findMany({ where: { role: { not: 'DEVELOPER' } }, select: { id: true, displayName: true, role: true, active: true }, orderBy: { displayName: 'asc' } }),
    prisma.stockItem.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  return { users, stockItems: items };
}
