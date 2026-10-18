import type { VerificationStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { clinicDateStr, clinicDayBounds } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { notifyRoles, notifyUsers } from '../../services/notifications';

/**
 * Report verification (spec §14 "Room verification"): the Manager reviews Assistant room checklists and Office Boy
 * rounds — Verify / Return / Escalate. Reports stay immutable; each decision is a new append-only
 * ReportVerification row. A report with a problem stays a dashboard highlight until it is verified.
 */
export type ReportType = 'RoomChecklistReport' | 'OfficeRound';

type Verif = { id: string; reportId: string; status: VerificationStatus; comment: string | null; verifiedById: string; createdAt: Date };

async function verificationsFor(type: ReportType, ids: string[]) {
  const rows = await prisma.reportVerification.findMany({ where: { reportType: type, reportId: { in: ids } }, orderBy: { createdAt: 'asc' } });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.verifiedById))] } }, select: { id: true, displayName: true } });
  return (id: string) =>
    rows
      .filter((r) => r.reportId === id)
      .map((r: Verif) => ({ status: r.status, comment: r.comment, at: r.createdAt, by: users.find((u) => u.id === r.verifiedById)?.displayName ?? null }));
}

const dayRange = (date?: string) => {
  const b = clinicDayBounds(date ?? clinicDateStr(new Date()));
  return { gte: b.start, lt: b.end };
};

export async function roomReports(filter: { scope: 'open' | 'day'; date?: string }) {
  const where = filter.scope === 'day' ? { submittedAt: dayRange(filter.date) } : {};
  const rows = await prisma.roomChecklistReport.findMany({ where, orderBy: { submittedAt: 'desc' }, take: 300 });
  const hist = await verificationsFor('RoomChecklistReport', rows.map((r) => r.id));
  const [rooms, users] = await Promise.all([
    prisma.room.findMany({ select: { id: true, code: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.assistantId))] } }, select: { id: true, displayName: true } }),
  ]);
  const items = rows.map((r) => {
    const history = hist(r.id);
    const latest = history.at(-1)?.status ?? null;
    const issue = !r.machineOk || !r.roomNeat || !r.disinfected || !r.stockOk;
    return {
      id: r.id,
      type: 'RoomChecklistReport' as const,
      kind: r.kind,
      roomCode: rooms.find((x) => x.id === r.roomId)?.code ?? null,
      staffName: users.find((u) => u.id === r.assistantId)?.displayName ?? null,
      submittedAt: r.submittedAt,
      checks: [
        { label: 'Machine', ok: r.machineOk, note: r.machineIssue },
        { label: 'Room neat', ok: r.roomNeat, note: null },
        { label: 'Disinfected', ok: r.disinfected, note: null },
        { label: 'Stock', ok: r.stockOk, note: r.stockNotes },
      ],
      demandSkipped: r.demandSkipped,
      attachmentIds: (r.attachmentIds as string[] | null) ?? [],
      issue,
      latestStatus: latest,
      history,
    };
  });
  return { items: filter.scope === 'open' ? items.filter((i) => i.latestStatus !== 'VERIFIED') : items };
}

export async function officeRounds(filter: { scope: 'open' | 'day'; date?: string }) {
  const where = filter.scope === 'day' ? { submittedAt: dayRange(filter.date) } : { submittedAt: { not: null } };
  const rows = await prisma.officeRound.findMany({ where, orderBy: { submittedAt: 'desc' }, take: 300 });
  const hist = await verificationsFor('OfficeRound', rows.map((r) => r.id));
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.officeBoyId))] } }, select: { id: true, displayName: true } });
  const items = rows
    .filter((r) => r.submittedAt)
    .map((r) => {
      const a = (r.areas ?? {}) as { items?: { name: string; clean: boolean; note: string | null }[]; stockNotes?: string | null };
      const history = hist(r.id);
      const issue = r.cleanlinessOk === false || r.stockOk === false || !!r.issues;
      return {
        id: r.id,
        type: 'OfficeRound' as const,
        kind: r.kind,
        seq: r.seq,
        roomCode: null,
        staffName: users.find((u) => u.id === r.officeBoyId)?.displayName ?? null,
        submittedAt: r.submittedAt!,
        checks: [...(a.items ?? []).map((x) => ({ label: x.name, ok: x.clean, note: x.note })), { label: 'Stock', ok: r.stockOk ?? true, note: a.stockNotes ?? null }],
        issues: r.issues,
        attachmentIds: (r.attachmentIds as string[] | null) ?? [],
        issue,
        latestStatus: history.at(-1)?.status ?? null,
        history,
      };
    });
  return { items: filter.scope === 'open' ? items.filter((i) => i.latestStatus !== 'VERIFIED') : items };
}

export async function verifyReport(actor: Actor, type: ReportType, id: string, input: { status: 'VERIFIED' | 'RETURNED' | 'ESCALATED'; comment?: string }) {
  if (input.status !== 'VERIFIED' && !input.comment?.trim()) throw new ValidationError('Return / Escalate ke liye comment zaroori hai.');
  return prisma.$transaction(async (tx) => {
    const report =
      type === 'RoomChecklistReport'
        ? await tx.roomChecklistReport.findUnique({ where: { id }, select: { id: true, assistantId: true, assignmentId: true, kind: true } })
        : await tx.officeRound.findUnique({ where: { id }, select: { id: true, officeBoyId: true, submittedAt: true, kind: true } });
    if (!report) throw new NotFoundError('Report');
    if ('submittedAt' in report && !report.submittedAt) throw new ConflictError('NOT_SUBMITTED', 'Report abhi jama nahi hui.');
    const last = await tx.reportVerification.findFirst({ where: { reportType: type, reportId: id }, orderBy: { createdAt: 'desc' } });
    if (last?.status === 'VERIFIED') throw new ConflictError('ALREADY_VERIFIED', 'Yeh report verify ho chuki hai.');
    const v = await tx.reportVerification.create({ data: { reportType: type, reportId: id, status: input.status, comment: input.comment?.trim() || null, verifiedById: actor.id! } });
    await audit(tx, actor, { action: `REPORT_${input.status}`, recordType: type, recordId: id, after: { status: input.status }, reason: input.comment });
    const staffId = 'assistantId' in report ? report.assistantId : report.officeBoyId;
    if (input.status === 'VERIFIED' && type === 'RoomChecklistReport') {
      await tx.workflowTask.updateMany({ where: { idempotencyKey: `roomreport:${id}`, status: { in: ['PENDING', 'IN_PROGRESS', 'BLOCKED'] } }, data: { status: 'COMPLETED', completedAt: new Date(), completedById: actor.id } });
    }
    if (input.status === 'RETURNED') {
      await notifyUsers(tx, [staffId], {
        type: 'REPORT_RETURNED',
        subject: `${type === 'RoomChecklistReport' ? 'Room report' : 'Round report'} wapas: Manager ka comment`,
        body: input.comment!.trim(),
        recordType: type === 'RoomChecklistReport' ? 'RoomAssignment' : 'OfficeRound',
        recordId: 'assignmentId' in report ? report.assignmentId : id,
        sender: actor,
        priority: 1,
        dedupeKey: `verification:${v.id}`,
      });
    }
    if (input.status === 'ESCALATED') {
      await notifyRoles(tx, ['MD'], { type: 'REPORT_ESCALATED', subject: `Escalation: ${type === 'RoomChecklistReport' ? 'room' : 'office round'} report`, body: input.comment!.trim(), recordType: type, recordId: id, sender: actor, priority: 2, dedupeKey: `verification:${v.id}` });
    }
    return { id: v.id, status: v.status };
  });
}

/** Count used by the dashboard: reports not yet verified. */
export async function openReportCounts() {
  const [rooms, rounds] = await Promise.all([roomReports({ scope: 'open' }), officeRounds({ scope: 'open' })]);
  return {
    pending: rooms.items.length + rounds.items.length,
    withIssue: [...rooms.items, ...rounds.items].filter((r) => r.issue),
  };
}

