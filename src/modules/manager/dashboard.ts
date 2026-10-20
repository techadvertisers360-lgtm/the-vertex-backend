import { prisma } from '../../lib/prisma';
import { addDaysStr, addMinutes, clinicDate, clinicDateStr, clinicDayBounds, dateOnly, dateOnlyStr, formatClinic } from '../../lib/time';
import type { Actor } from '../../services/audit';
import { getSetting } from '../../services/settings';
import { doctorsToday } from '../reception/service';
import { officeRounds, roomReports } from './reports';

/**
 * Manager dashboard (spec §14): summary cards from source records, and highlights that stay until resolved —
 * leave impact, room/machine issue, complaint, overdue task/report and pending approval. Each highlight links to
 * the screen that resolves it.
 */
export type Severity = 'danger' | 'warning' | 'info';
export interface Highlight {
  key: string;
  kind: 'leave_impact' | 'room_issue' | 'round_issue' | 'complaint' | 'overdue' | 'approval' | 'emergency' | 'stock_check' | 'assignment_missing' | 'message_failure';
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
  const tomorrow = dateOnly(addDaysStr(today, 1));

  const [apptCounts, doctors, attendance, staff, roomsAssigned, complaints, leave, historyReq, altHours, reschedules, demands, followDue, followTomorrow, payments, procTasks] = await Promise.all([
    prisma.appointment.groupBy({ by: ['status'], where: { startAt: { gte: b.start, lt: b.end } }, _count: { _all: true } }),
    doctorsToday(),
    prisma.attendance.findMany({ where: { date: clinicDate(now) } }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, role: true, displayName: true } }),
    prisma.roomAssignment.count({ where: { date: clinicDate(now), unassignedAt: null } }),
    prisma.complaint.findMany({ where: { status: { in: ['PENDING', 'IN_REVIEW'] }, OR: [{ recipients: { some: { userId: actor.id! } } }, { source: 'PATIENT' }] }, select: { id: true, subject: true, createdAt: true, source: true } }),
    prisma.leaveRequest.findMany({ where: { approverRole: 'MANAGER', status: { in: ['PENDING', 'IN_REVIEW'] }, requesterId: { not: actor.id! } }, select: { id: true, requesterId: true, kind: true, startAt: true, createdAt: true } }),
    prisma.historyAccessRequest.count({ where: { status: 'PENDING' } }),
    prisma.doctorAvailabilityException.count({ where: { kind: 'ALTERNATE_HOURS', status: 'PENDING' } }),
    prisma.rescheduleRequest.findMany({ where: { status: { in: ['PENDING', 'IN_REVIEW'] } }, select: { id: true, createdAt: true, reason: true } }),
    prisma.stockDemand.count({ where: { status: 'PENDING_MANAGER' } }),
    prisma.followUp.count({ where: { status: { in: ['PENDING', 'IN_PROGRESS'] }, dueDate: { lte: dateOnly(today) } } }),
    prisma.followUp.count({ where: { status: { in: ['PENDING', 'IN_PROGRESS'] }, dueDate: tomorrow } }),
    prisma.payment.groupBy({ by: ['method'], where: { receivedAt: { gte: b.start, lt: b.end } }, _sum: { amountPaisa: true } }),
    prisma.procedureTask.findMany({ where: { status: { in: ['PENDING', 'IN_PROGRESS', 'BLOCKED'] }, assistantId: { not: null } }, select: { id: true, status: true, consentAlertAt: true, cleanAlertAt: true, assistantId: true, roomId: true, assignedAt: true } }),
  ]);

  // Low stock: ledger sum ≤ minimum
  const [items, sums] = await Promise.all([prisma.stockItem.findMany({ where: { active: true }, select: { id: true, name: true, minQty: true } }), prisma.stockTransaction.groupBy({ by: ['itemId'], _sum: { quantity: true } })]);
  const lowStock = items.filter((i) => (sums.find((s) => s.itemId === i.id)?._sum.quantity ?? 0) <= i.minQty);

  const name = (id: string | null) => (id ? (staff.find((u) => u.id === id)?.displayName ?? '—') : '—');
  const present = attendance.filter((a) => !a.checkOutAt);
  const roleOf = (id: string) => staff.find((u) => u.id === id)?.role;
  const highlights: Highlight[] = [];

  // Leave impact still unresolved
  const leaves = await prisma.doctorAvailabilityException.findMany({ where: { kind: { in: ['LEAVE', 'ABSENT'] }, status: 'APPROVED', impactResolvedAt: null } });
  const impactTasks = await prisma.workflowTask.findMany({ where: { type: 'MANAGER_LEAVE_IMPACT', status: { in: ['PENDING', 'IN_PROGRESS'] } }, select: { idempotencyKey: true } });
  for (const l of leaves.filter((x) => impactTasks.some((t) => t.idempotencyKey === `availability:${x.id}:impact`))) {
    highlights.push({ key: `leave:${l.id}`, kind: 'leave_impact', severity: 'danger', title: `Doctor leave impact: ${name(l.doctorId)}`, detail: `${dateOnlyStr(l.date)} — booked patients reschedule / cancel karein`, href: '/manager/schedule', at: l.createdAt });
  }
  // Room / machine issues and office round issues not yet verified
  const [rr, orr] = await Promise.all([roomReports({ scope: 'open' }), officeRounds({ scope: 'open' })]);
  for (const r of rr.items.filter((x) => x.issue)) {
    const bad = r.checks.filter((c) => !c.ok).map((c) => (c.note ? `${c.label}: ${c.note}` : c.label));
    highlights.push({ key: `room:${r.id}`, kind: 'room_issue', severity: r.checks[0]!.ok ? 'warning' : 'danger', title: `Room ${r.roomCode} ${r.kind.toLowerCase()} issue — ${r.staffName}`, detail: bad.join(' · '), href: '/manager/rooms', at: r.submittedAt });
  }
  for (const r of orr.items.filter((x) => x.issue)) {
    const bad = r.checks.filter((c) => !c.ok).map((c) => (c.note ? `${c.label}: ${c.note}` : c.label));
    highlights.push({ key: `round:${r.id}`, kind: 'round_issue', severity: 'warning', title: `Office round issue — ${r.staffName}`, detail: [...bad, r.issues].filter(Boolean).join(' · '), href: '/manager/rooms?tab=rounds', at: r.submittedAt });
  }
  // Complaints
  for (const c of complaints) highlights.push({ key: `complaint:${c.id}`, kind: 'complaint', severity: c.source === 'PATIENT' ? 'danger' : 'warning', title: `Complaint: ${c.subject}`, detail: c.source.toLowerCase(), href: `/manager/requests?tab=complaints&id=${c.id}`, at: c.createdAt });
  // Emergencies and SLA-overdue procedures
  const rooms = await prisma.room.findMany({ select: { id: true, code: true } });
  for (const t of procTasks) {
    const room = rooms.find((r) => r.id === t.roomId)?.code ?? '';
    if (t.status === 'BLOCKED') highlights.push({ key: `emergency:${t.id}`, kind: 'emergency', severity: 'danger', title: `Assistant emergency — ${name(t.assistantId)}`, detail: `Room ${room} · replacement assign karein`, href: '/manager/rooms?tab=procedures', at: t.assignedAt ?? now });
    else if (t.cleanAlertAt) highlights.push({ key: `clean:${t.id}`, kind: 'overdue', severity: 'danger', title: `Room ${room} clean overdue`, detail: name(t.assistantId), href: '/manager/rooms?tab=procedures', at: t.cleanAlertAt });
    else if (t.consentAlertAt) highlights.push({ key: `consent:${t.id}`, kind: 'overdue', severity: 'danger', title: `Consent pending — Room ${room}`, detail: name(t.assistantId), href: '/manager/rooms?tab=procedures', at: t.consentAlertAt });
  }
  // Missed Office Boy rounds (due more than one interval ago and not sent)
  const interval = await getSetting('officeBoy.roundIntervalMin');
  const missed = await prisma.officeRound.findMany({ where: { submittedAt: null, status: 'PENDING', dueAt: { gte: b.start, lt: addMinutes(now, -interval) } }, select: { id: true, officeBoyId: true, dueAt: true, kind: true } });
  for (const m of missed) highlights.push({ key: `missed:${m.id}`, kind: 'overdue', severity: 'warning', title: `Office round overdue — ${name(m.officeBoyId)}`, detail: `Due ${formatClinic(m.dueAt, 'h:mm a')}`, href: '/manager/rooms?tab=rounds', at: m.dueAt });
  // Overdue follow-ups (older than today)
  const lateFollow = await prisma.followUp.count({ where: { status: { in: ['PENDING', 'IN_PROGRESS'] }, dueDate: { lt: dateOnly(today) } } });
  if (lateFollow) highlights.push({ key: 'followups:late', kind: 'overdue', severity: 'warning', title: `${lateFollow} patient follow-up overdue`, detail: 'Pichle dinon ke patients abhi call nahi hue', href: '/manager/followups', at: now });
  // Spec §19 / §20: procedure stock checks (2 days before), procedure-day assignment missing, failed messages.
  const opsTasks = await prisma.workflowTask.findMany({
    where: { type: { in: ['MANAGER_STOCK_CHECK', 'MANAGER_ASSIGNMENT_MISSING', 'MANAGER_MESSAGE_FAILURE'] }, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    select: { id: true, type: true, title: true, dueAt: true, createdAt: true, payload: true },
    orderBy: { dueAt: 'asc' },
  });
  for (const t of opsTasks.filter((x) => x.type === 'MANAGER_ASSIGNMENT_MISSING')) {
    highlights.push({ key: `assign:${t.id}`, kind: 'assignment_missing', severity: 'danger', title: t.title, detail: `${(t.payload as { reason?: string } | null)?.reason ?? ''}${t.dueAt ? ` · ${formatClinic(t.dueAt, 'h:mm a')}` : ''}`, href: '/manager/staff?tab=rooms', at: t.createdAt });
  }
  for (const t of opsTasks.filter((x) => x.type === 'MANAGER_STOCK_CHECK')) {
    const p = (t.payload ?? {}) as { when?: string; doctorName?: string };
    highlights.push({ key: `stockcheck:${t.id}`, kind: 'stock_check', severity: 'warning', title: t.title, detail: [p.when, p.doctorName].filter(Boolean).join(' · '), href: '/manager/stock?tab=checks', at: t.createdAt });
  }
  const failures = opsTasks.filter((x) => x.type === 'MANAGER_MESSAGE_FAILURE');
  if (failures.length) highlights.push({ key: 'messages:failed', kind: 'message_failure', severity: 'danger', title: `${failures.length} message${failures.length === 1 ? '' : 's'} fail`, detail: 'Message log se retry karein ya patient ko call karein', href: '/manager/messages?status=FAILED', at: failures[failures.length - 1]!.createdAt });
  // Pending approvals
  const approvals = [
    { n: leave.length, title: 'leave / early leave request', href: '/manager/requests?tab=leave' },
    { n: reschedules.length, title: 'reschedule request', href: '/manager/schedule?tab=requests' },
    { n: historyReq, title: 'history access request', href: '/manager/approvals' },
    { n: altHours, title: 'alternate hours request', href: '/manager/approvals?tab=alternate' },
    { n: demands, title: 'stock demand', href: '/manager/stock' },
    { n: await prisma.stockIntake.count({ where: { status: 'PENDING' } }), title: 'stock entry to verify', href: '/manager/stock?tab=verify' },
  ];
  for (const a of approvals.filter((x) => x.n)) highlights.push({ key: `approval:${a.href}`, kind: 'approval', severity: 'info', title: `${a.n} ${a.title}${a.n === 1 ? '' : 's'} pending`, detail: 'Approval chahiye', href: a.href, at: now });

  const order: Record<Severity, number> = { danger: 0, warning: 1, info: 2 };
  highlights.sort((x, y) => order[x.severity] - order[y.severity] || y.at.getTime() - x.at.getTime());

  const byStatus = Object.fromEntries(apptCounts.map((c) => [c.status, c._count._all]));
  const totalPaid = payments.reduce((s, p) => s + (p._sum.amountPaisa ?? 0n), 0n);
  return {
    date: today,
    cards: {
      patients: { total: apptCounts.filter((c) => !['CANCELLED', 'RESCHEDULED'].includes(c.status)).reduce((s, c) => s + c._count._all, 0), byStatus },
      doctors: { working: doctors.items.filter((d) => d.windows.length && !d.onLeave).length, onLeave: doctors.items.filter((d) => d.onLeave).length, waiting: doctors.items.reduce((s, d) => s + d.waiting, 0) },
      rooms: { assigned: roomsAssigned, procedureLive: procTasks.length },
      staff: {
        present: present.filter((a) => roleOf(a.userId) !== 'LEAD_MEMBER').length,
        leadPresent: present.filter((a) => roleOf(a.userId) === 'LEAD_MEMBER').length,
        reviewed: await prisma.staffReview.count({ where: { attendanceId: { in: attendance.map((a) => a.id) } } }),
        checkedIn: attendance.length,
      },
      verification: { pending: rr.items.length + orr.items.length, withIssue: rr.items.filter((x) => x.issue).length + orr.items.filter((x) => x.issue).length },
      requests: { complaints: complaints.length, leave: leave.length },
      stock: { low: lowStock.length, demandsPending: demands, lowItems: lowStock.slice(0, 5).map((i) => i.name) },
      cash: { totalPaisa: totalPaid, byMethod: Object.fromEntries(payments.map((p) => [p.method, p._sum.amountPaisa ?? 0n])) },
      followups: { due: followDue, tomorrow: followTomorrow },
      approvals: { total: leave.length + reschedules.length + historyReq + altHours + demands },
    },
    highlights,
  };
}
