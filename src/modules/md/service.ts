import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { addDaysStr, clinicDate, clinicDateStr, clinicDayBounds, dateOnly, dateOnlyStr, formatClinic } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { notifyRoles } from '../../services/notifications';
import { getSetting } from '../../services/settings';
import { leaveImpact } from '../doctor/service';
import { doctorsToday } from '../reception/service';

/**
 * MD (Usama Sufain, spec §15): overview + urgent highlights only. Routine completions are visible in reports and
 * never generate MD notifications (no spam). Approvals reuse the owning modules' decision endpoints.
 */
type Severity = 'danger' | 'warning' | 'info';
interface Highlight {
  key: string;
  kind: 'stock_demand' | 'leadership_leave' | 'complaint' | 'leave_impact' | 'ops_issue' | 'damage';
  severity: Severity;
  title: string;
  detail: string;
  href: string;
  at: Date;
}

export async function dashboard(actor: Actor) {
  const now = new Date();
  const today = clinicDateStr(now);
  const b = clinicDayBounds(today);
  const slaHours = await getSetting('complaint.slaHours');
  const limit = BigInt(await getSetting('stock.managerApprovalLimitPaisa'));
  const [appts, doctors, attendance, staff, demands, leaves, damage, complaints, payments, escalatedReports, impacts] = await Promise.all([
    prisma.appointment.groupBy({ by: ['status'], where: { startAt: { gte: b.start, lt: b.end } }, _count: { _all: true } }),
    doctorsToday(),
    prisma.attendance.findMany({ where: { date: clinicDate(now) } }),
    prisma.user.count({ where: { active: true, role: { in: ['RECEPTIONIST', 'DOCTOR', 'ASSISTANT', 'OFFICE_BOY', 'LEAD_MEMBER', 'MANAGER'] } } }),
    prisma.stockDemand.findMany({ where: { status: 'PENDING_MD' }, select: { id: true, estimatedTotalPaisa: true, requesterRole: true, forwardedToMdAt: true, createdAt: true, reason: true } }),
    prisma.leaveRequest.findMany({ where: { approverRole: 'MD', status: { in: ['PENDING', 'IN_REVIEW'] }, requesterId: { not: actor.id! } }, select: { id: true, requesterId: true, requesterRole: true, kind: true, startAt: true, createdAt: true } }),
    prisma.damageReport.findMany({ where: { approverRole: 'MD', status: 'PENDING' }, select: { id: true, quantity: true, createdAt: true, itemId: true } }),
    prisma.complaint.findMany({ where: { status: { in: ['PENDING', 'IN_REVIEW', 'IN_PROGRESS', 'NEED_DETAILS'] }, recipients: { some: { userId: actor.id! } } }, select: { id: true, subject: true, source: true, escalatedToMdAt: true, createdAt: true } }),
    prisma.payment.aggregate({ where: { receivedAt: { gte: b.start, lt: b.end } }, _sum: { amountPaisa: true }, _count: { _all: true } }),
    prisma.reportVerification.findMany({ where: { status: 'ESCALATED' }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.doctorAvailabilityException.findMany({ where: { kind: { in: ['LEAVE', 'ABSENT'] }, status: 'APPROVED', impactResolvedAt: null } }),
  ]);
  const names = await prisma.user.findMany({ where: { id: { in: [...new Set([...leaves.map((l) => l.requesterId), ...impacts.map((i) => i.doctorId)])] } }, select: { id: true, displayName: true } });
  const nm = (id: string) => names.find((u) => u.id === id)?.displayName ?? '—';
  const h: Highlight[] = [];

  for (const d of demands) {
    h.push({ key: `demand:${d.id}`, kind: 'stock_demand', severity: d.estimatedTotalPaisa > limit ? 'danger' : 'warning', title: `Stock demand ${d.estimatedTotalPaisa > limit ? 'above Rs ' + Number(limit) / 100 : '(Manager raised)'}: Rs ${Number(d.estimatedTotalPaisa) / 100}`, detail: d.reason, href: '/md/approvals', at: d.forwardedToMdAt ?? d.createdAt });
  }
  for (const l of leaves) {
    h.push({ key: `leave:${l.id}`, kind: 'leadership_leave', severity: 'warning', title: `${l.kind === 'LEAVE' ? 'Leave' : 'Early leave'}: ${nm(l.requesterId)}`, detail: formatClinic(l.startAt), href: `/md/approvals?tab=leave&id=${l.id}`, at: l.createdAt });
  }
  for (const d of damage) h.push({ key: `damage:${d.id}`, kind: 'damage', severity: 'warning', title: `Damage write-off (Manager reported) × ${d.quantity}`, detail: 'MD approval', href: '/md/approvals?tab=damage', at: d.createdAt });
  // Serious complaints: escalated, patient complaints, or past the response target.
  for (const c of complaints) {
    const late = now.getTime() - c.createdAt.getTime() > slaHours * 3_600_000;
    if (!c.escalatedToMdAt && c.source !== 'PATIENT' && !late) continue;
    h.push({ key: `complaint:${c.id}`, kind: 'complaint', severity: 'danger', title: `${c.escalatedToMdAt ? 'Escalation' : late ? 'Complaint overdue' : 'Patient complaint'}: ${c.subject}`, detail: c.source.toLowerCase(), href: `/md/escalations?id=${c.id}`, at: c.escalatedToMdAt ?? c.createdAt });
  }
  // Doctor leave impact with patients still affected (escalate if unresolved, spec §15)
  for (const ex of impacts) {
    const imp = await leaveImpact(ex.doctorId, { date: dateOnlyStr(ex.date), startMinute: ex.startMinute ?? undefined, endMinute: ex.endMinute ?? undefined });
    if (!imp.count) continue;
    h.push({ key: `impact:${ex.id}`, kind: 'leave_impact', severity: dateOnlyStr(ex.date) <= addDaysStr(today, 2) ? 'danger' : 'warning', title: `Doctor leave: ${nm(ex.doctorId)} ${dateOnlyStr(ex.date)}`, detail: `${imp.count} patient abhi reschedule nahi hue`, href: '/md/escalations?tab=impacts', at: ex.createdAt });
  }
  // Unresolved ops issues: reports the Manager escalated and nobody has verified since.
  const seen = new Set<string>();
  for (const r of escalatedReports) {
    if (seen.has(r.reportId)) continue;
    seen.add(r.reportId);
    const later = await prisma.reportVerification.findFirst({ where: { reportType: r.reportType, reportId: r.reportId, createdAt: { gt: r.createdAt } } });
    if (later?.status === 'VERIFIED') continue;
    h.push({ key: `ops:${r.reportId}`, kind: 'ops_issue', severity: 'danger', title: `Escalated ${r.reportType === 'RoomChecklistReport' ? 'room' : 'office round'} issue`, detail: r.comment ?? '', href: '/md/escalations?tab=ops', at: r.createdAt });
  }
  const order: Record<Severity, number> = { danger: 0, warning: 1, info: 2 };
  h.sort((x, y) => order[x.severity] - order[y.severity] || y.at.getTime() - x.at.getTime());

  const by = Object.fromEntries(appts.map((a) => [a.status, a._count._all]));
  return {
    date: today,
    cards: {
      patients: { total: appts.filter((a) => !['CANCELLED', 'RESCHEDULED'].includes(a.status)).reduce((s, a) => s + a._count._all, 0), done: by.DONE ?? 0, inClinic: (by.CHECKED_IN ?? 0) + (by.WAITING ?? 0) + (by.WITH_DOCTOR ?? 0) + (by.RECEPTION ?? 0) + (by.PROCEDURE ?? 0) },
      doctors: { working: doctors.items.filter((d) => d.windows.length && !d.onLeave).length, onLeave: doctors.items.filter((d) => d.onLeave).length },
      staff: { present: attendance.filter((a) => !a.checkOutAt).length, checkedIn: attendance.length, total: staff },
      approvals: { total: demands.length + leaves.length + damage.length },
      complaints: { open: complaints.length },
      cash: { todayPaisa: payments._sum.amountPaisa ?? 0n, receipts: payments._count._all },
    },
    highlights: h,
  };
}

/** Approval Center list (spec §15): stock demands, leadership leave, damage write-offs — all pending the MD. */
export async function approvals(actor: Actor) {
  const [demands, leaves, damage] = await Promise.all([
    prisma.stockDemand.count({ where: { status: 'PENDING_MD' } }),
    prisma.leaveRequest.findMany({ where: { approverRole: 'MD', requesterId: { not: actor.id! } }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.damageReport.count({ where: { approverRole: 'MD', status: 'PENDING' } }),
  ]);
  return { counts: { demands, leave: leaves.filter((l) => ['PENDING', 'IN_REVIEW'].includes(l.status)).length, damage } };
}

/** Full history of one record for the approval detail: every audit event (actor, time, action, reason). */
export async function history(recordType: string, recordId: string) {
  const rows = await prisma.auditEvent.findMany({ where: { recordType, recordId }, orderBy: { id: 'asc' }, take: 200 });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } });
  return { items: rows.map((r) => ({ id: r.id.toString(), at: r.createdAt, action: r.action, actor: r.actorRole === 'DEVELOPER' ? 'System Developer' : r.actorId ? (users.find((u) => u.id === r.actorId)?.displayName ?? null) : 'System', actorRole: r.actorRole, reason: r.reason })) };
}

/** Doctor leave impacts the MD watches; "nudge" re-alerts the Managers (spec §15 "escalate if unresolved"). */
export async function leaveImpacts() {
  const rows = await prisma.doctorAvailabilityException.findMany({ where: { kind: { in: ['LEAVE', 'ABSENT'] }, status: 'APPROVED', impactResolvedAt: null }, orderBy: { date: 'asc' } });
  const doctors = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.doctorId) } }, select: { id: true, displayName: true } });
  const items = [];
  for (const ex of rows) {
    const imp = await leaveImpact(ex.doctorId, { date: dateOnlyStr(ex.date), startMinute: ex.startMinute ?? undefined, endMinute: ex.endMinute ?? undefined });
    items.push({ id: ex.id, date: dateOnlyStr(ex.date), kind: ex.kind, reason: ex.reason, doctorName: doctors.find((d) => d.id === ex.doctorId)?.displayName ?? null, createdAt: ex.createdAt, pending: imp.count, patients: imp.items.map((i) => ({ id: i.id, name: i.patient.name, startAt: i.startAt, source: i.source })) });
  }
  return { items };
}

export async function nudgeLeaveImpact(actor: Actor, id: string, note: string) {
  const ex = await prisma.doctorAvailabilityException.findUnique({ where: { id } });
  if (!ex || ex.kind === 'ALTERNATE_HOURS') throw new NotFoundError('Leave');
  if (!note.trim()) throw new ValidationError('Manager ke liye note likhein.');
  return prisma.$transaction(async (tx) => {
    await audit(tx, actor, { action: 'LEAVE_IMPACT_ESCALATED', recordType: 'DoctorAvailabilityException', recordId: id, reason: note });
    await notifyRoles(tx, ['MANAGER'], { type: 'MD_ESCALATION', subject: `MD: Doctor leave ${dateOnlyStr(ex.date)} — patients abhi pending`, body: note, recordType: 'DoctorAvailabilityException', recordId: id, sender: actor, priority: 2, dedupeKey: `impact:${id}:nudge:${Date.now()}` });
    return { ok: true };
  });
}

/** Escalated room / round reports (Manager → MD) with their decision history. */
export async function escalatedReports() {
  const rows = await prisma.reportVerification.findMany({ where: { status: 'ESCALATED' }, orderBy: { createdAt: 'desc' }, take: 100 });
  const ids = [...new Set(rows.map((r) => r.reportId))];
  const all = await prisma.reportVerification.findMany({ where: { reportId: { in: ids } }, orderBy: { createdAt: 'asc' } });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(all.map((r) => r.verifiedById))] } }, select: { id: true, displayName: true } });
  return {
    items: ids.map((id) => {
      const hist = all.filter((r) => r.reportId === id);
      return { reportId: id, reportType: hist[0]!.reportType, latest: hist.at(-1)!.status, history: hist.map((r) => ({ status: r.status, comment: r.comment, by: users.find((u) => u.id === r.verifiedById)?.displayName ?? null, at: r.createdAt })) };
    }),
  };
}

// ───────────── Reports with drill-down (spec §15) ─────────────

/** Staff attendance + arrival reviews for a date range; drill-down per person per day. */
export async function staffReport(from: string, to: string, userId?: string) {
  const [att, reviews, users] = await Promise.all([
    prisma.attendance.findMany({ where: { date: { gte: dateOnly(from), lte: dateOnly(to) }, ...(userId ? { userId } : {}) }, orderBy: [{ date: 'asc' }] }),
    prisma.staffReview.findMany({ where: { createdAt: { gte: clinicDayBounds(from).start, lt: clinicDayBounds(to).end }, ...(userId ? { staffId: userId } : {}) } }),
    prisma.user.findMany({ where: { active: true, role: { notIn: ['MD'] }, ...(userId ? { id: userId } : {}) }, select: { id: true, displayName: true, role: true } }),
  ]);
  const people = users.map((u) => {
    const mine = att.filter((a) => a.userId === u.id);
    const rv = reviews.filter((r) => r.staffId === u.id);
    return {
      user: u,
      daysPresent: mine.length,
      avgRating: rv.length ? Math.round((rv.reduce((s, r) => s + r.rating, 0) / rv.length) * 10) / 10 : null,
      reviewIssues: rv.filter((r) => !r.uniformOk || !r.hairOk || !r.nailsOk).length,
      days: userId ? mine.map((a) => ({ date: dateOnlyStr(a.date), checkInAt: a.checkInAt, checkOutAt: a.checkOutAt, review: rv.find((r) => r.attendanceId === a.id) ?? null })) : undefined,
    };
  });
  return { from, to, items: people.sort((a, b) => a.user.role.localeCompare(b.user.role) || a.user.displayName.localeCompare(b.user.displayName)) };
}

/** Purchases (goods receipts) by vendor and demand; drill-down to receipt lines. */
export async function purchaseReport(from: string, to: string) {
  const receipts = await prisma.goodsReceipt.findMany({ where: { receivedAt: { gte: clinicDayBounds(from).start, lt: clinicDayBounds(to).end } }, include: { lines: true }, orderBy: { receivedAt: 'desc' } });
  const [vendors, demands, items] = await Promise.all([
    prisma.vendor.findMany({ select: { id: true, name: true } }),
    prisma.stockDemand.findMany({ where: { id: { in: receipts.map((r) => r.demandId).filter((x): x is string => !!x) } }, select: { id: true, demandNumber: true, approverRole: true } }),
    prisma.stockItem.findMany({ select: { id: true, name: true, baseUnit: true } }),
  ]);
  const rows = receipts.map((r) => ({
    id: r.id,
    receivedAt: r.receivedAt,
    vendor: vendors.find((v) => v.id === r.vendorId)?.name ?? null,
    vendorId: r.vendorId,
    vendorInvoiceNo: r.vendorInvoiceNo,
    demand: demands.find((d) => d.id === r.demandId) ?? null,
    totalPaisa: r.totalPaisa,
    lines: r.lines.map((l) => ({ item: items.find((i) => i.id === l.itemId)?.name ?? '—', unit: items.find((i) => i.id === l.itemId)?.baseUnit ?? '', quantity: l.quantity, unitCostPaisa: l.unitCostPaisa, lotNo: l.lotNo, expiryDate: l.expiryDate ? dateOnlyStr(l.expiryDate) : null })),
  }));
  const byVendor = vendors
    .map((v) => ({ vendorId: v.id, vendor: v.name, receipts: rows.filter((r) => r.vendorId === v.id).length, totalPaisa: rows.filter((r) => r.vendorId === v.id).reduce((s, r) => s + r.totalPaisa, 0n) }))
    .filter((v) => v.receipts);
  return { from, to, totalPaisa: rows.reduce((s, r) => s + r.totalPaisa, 0n), byVendor, receipts: rows };
}

const COMPLETED_ACTIONS: Record<string, string> = {
  ROOM_CLEANED: 'Procedures completed (room clean)',
  REPORT_VERIFIED: 'Room / round reports verified',
  ROOM_CHECKLIST_SUBMITTED: 'Room checklists submitted',
  OFFICE_ROUND_SUBMITTED: 'Office Boy rounds',
  FOLLOWUP_COMPLETED: 'Patient follow-ups',
  INVOICE_CLOSED: 'Visits closed (Patient Done)',
  GOODS_RECEIVED: 'Goods received',
  CASH_CLOSED: 'Cash closings',
  STAFF_ARRIVAL_REVIEWED: 'Arrival reviews',
  AFTERCARE_SENT: 'Aftercare sent',
};

/** Completed routine actions — visible here, never notified to the MD (spec §15 "without notification spam"). */
export async function completedActions(from: string, to: string, action?: string) {
  const where = { createdAt: { gte: clinicDayBounds(from).start, lt: clinicDayBounds(to).end }, action: action ? action : { in: Object.keys(COMPLETED_ACTIONS) } };
  if (action && !COMPLETED_ACTIONS[action]) throw new ValidationError('Unknown action.');
  const counts = await prisma.auditEvent.groupBy({ by: ['action'], where, _count: { _all: true } });
  const detail = action ? await prisma.auditEvent.findMany({ where, orderBy: { id: 'desc' }, take: 200 }) : [];
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(detail.map((d) => d.actorId).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } });
  return {
    from,
    to,
    summary: Object.entries(COMPLETED_ACTIONS).map(([k, label]) => ({ action: k, label, count: counts.find((c) => c.action === k)?._count._all ?? 0 })),
    items: detail.map((d) => ({ id: d.id.toString(), at: d.createdAt, action: d.action, recordType: d.recordType, recordId: d.recordId, actor: d.actorRole === 'DEVELOPER' ? 'System Developer' : d.actorId ? (users.find((u) => u.id === d.actorId)?.displayName ?? null) : 'System' })),
  };
}
