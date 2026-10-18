import { Prisma, type Attendance, type OfficeRound } from '@prisma/client';
import { prisma, type Db, type Tx } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { clinicDate, clinicDateStr, clinicDayBounds, formatClinic } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { notifyRoles, notifyUsers } from '../../services/notifications';
import { publish, userRoom } from '../../services/realtime';
import { deny } from '../../services/scope';
import { getSetting } from '../../services/settings';
import { blockCheckout, registerCheckinHook, registerCheckoutGuard } from '../attendance/service';
import { FINAL_SEQ, roundSchedule } from './schedule';

/**
 * Office Boy duty (spec §13): first clinic check at check-in, a round every 2 hours, the 9:40 PM final report,
 * and check-out only after the final report. Office Boy payloads never contain patient data (spec §4, §22).
 */

async function scheduleFor(db: Db, a: Pick<Attendance, 'checkInAt'>) {
  const [anchor, shiftStart, intervalMin, finalTime] = await Promise.all([
    getSetting('officeBoy.roundAnchor', db),
    getSetting('officeBoy.shiftStart', db),
    getSetting('officeBoy.roundIntervalMin', db),
    getSetting('officeBoy.finalReportTime', db),
  ]);
  return roundSchedule({ checkInAt: a.checkInAt, anchor, shiftStart, intervalMin, finalTime });
}

/** An approved early leave starting today opens the final report early (D-035). */
async function earlyLeaveToday(db: Db, userId: string, now: Date) {
  const b = clinicDayBounds(clinicDateStr(now));
  return db.leaveRequest.findFirst({ where: { requesterId: userId, kind: 'EARLY_LEAVE', status: 'APPROVED', startAt: { gte: b.start, lt: b.end } } });
}

/** '21:40' → '9:40 PM' for messages. */
export function twelveHour(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2));
  return `${h % 12 || 12}:${hhmm.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`;
}

const LABEL = { FIRST_CHECK: 'First clinic check', ROUND: 'Round', FINAL: 'Final report' } as const;

/**
 * Create every round that is due by `now` for this shift (idempotent: unique attendanceId+seq, so app refreshes,
 * overlapping worker ticks or several workers never duplicate a round). Each new round reminds the Office Boy.
 */
export async function ensureDueRounds(a: Attendance, now = new Date()): Promise<number> {
  if (a.checkOutAt) return 0; // no reminders after check-out (spec §23)
  const plan = await scheduleFor(prisma, a);
  const early = await earlyLeaveToday(prisma, a.userId, now);
  const have = new Set((await prisma.officeRound.findMany({ where: { attendanceId: a.id }, select: { seq: true } })).map((r) => r.seq));
  let created = 0;
  for (const r of plan) {
    const due = r.kind === 'FINAL' && early && r.dueAt > now ? now : r.dueAt;
    if (due > now || have.has(r.seq)) continue;
    try {
      await prisma.$transaction(async (tx) => {
        const row = await tx.officeRound.create({ data: { officeBoyId: a.userId, attendanceId: a.id, seq: r.seq, kind: r.kind, dueAt: due } });
        const title = r.kind === 'ROUND' ? `${LABEL.ROUND} ${r.seq - 1}` : LABEL[r.kind];
        await notifyUsers(tx, [a.userId], {
          type: 'OFFICE_ROUND_DUE',
          subject: `${title} — checklist kholen`,
          body: r.kind === 'FINAL' ? 'Final cleanliness, stock, unresolved issues aur demands review. Check-out se pehle zaroori.' : 'Cleanliness, stock aur assigned areas check karein.',
          recordType: 'OfficeRound',
          recordId: row.id,
          priority: r.kind === 'FINAL' ? 1 : 0,
          actionLabel: 'Open checklist',
          dedupeKey: `officeround:${a.id}:${r.seq}`,
        });
        await publish(tx, [userRoom(a.userId)], 'queue:changed', {});
      });
      created += 1;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // already created
      throw e;
    }
  }
  return created;
}

/** Worker scan: today's open Office Boy shifts. */
export async function runOfficeRounds(now = new Date()): Promise<number> {
  const boys = await prisma.user.findMany({ where: { role: 'OFFICE_BOY', active: true }, select: { id: true } });
  const open = await prisma.attendance.findMany({ where: { date: clinicDate(now), checkOutAt: null, userId: { in: boys.map((b) => b.id) } } });
  let n = 0;
  for (const a of open) n += await ensureDueRounds(a, now);
  return n;
}

registerCheckinHook('OFFICE_BOY', async (tx: Tx, actor, attendance) => {
  // First clinic check starts with check-in (spec §13); later rounds are created when due.
  const row = await tx.officeRound.create({ data: { officeBoyId: actor.id!, attendanceId: attendance.id, seq: 1, kind: 'FIRST_CHECK', dueAt: attendance.checkInAt } });
  await notifyUsers(tx, [actor.id!], { type: 'OFFICE_ROUND_DUE', subject: 'First clinic check — checklist kholen', body: 'Cleanliness, stock, assigned areas aur missing items check karein.', recordType: 'OfficeRound', recordId: row.id, actionLabel: 'Open checklist', dedupeKey: `officeround:${attendance.id}:1` });
});

registerCheckoutGuard('OFFICE_BOY', async (tx, _actor, attendanceId) => {
  const final = await tx.officeRound.findUnique({ where: { attendanceId_seq: { attendanceId, seq: FINAL_SEQ } } });
  if (!final?.submittedAt) {
    const time = await getSetting('officeBoy.finalReportTime', tx);
    blockCheckout('FINAL_REPORT_PENDING', `Pehle ${twelveHour(time)} wali final report complete karein. Phir check-out karein.`);
  }
  // Rounds still open at check-out are closed as missed; history stays (spec §13 "active task clear").
  await tx.officeRound.updateMany({ where: { attendanceId, submittedAt: null }, data: { status: 'CANCELLED' } });
});

function view(r: OfficeRound) {
  return { id: r.id, seq: r.seq, kind: r.kind, dueAt: r.dueAt, submittedAt: r.submittedAt, status: r.status, cleanlinessOk: r.cleanlinessOk, stockOk: r.stockOk, issues: r.issues };
}

/** Office Boy dashboard: own attendance, today's rounds, areas, next round time. No patient data. */
export async function today(actor: Actor) {
  const now = new Date();
  const att = await prisma.attendance.findUnique({ where: { userId_date: { userId: actor.id!, date: clinicDate(now) } } });
  const areas = await getSetting('officeBoy.areas');
  if (!att) return { attendance: null, rounds: [], areas, nextRoundAt: null, finalTime: await getSetting('officeBoy.finalReportTime') };
  await ensureDueRounds(att, now);
  const rounds = await prisma.officeRound.findMany({ where: { attendanceId: att.id }, orderBy: { seq: 'asc' } });
  const plan = await scheduleFor(prisma, att);
  const next = att.checkOutAt ? null : plan.find((p) => p.dueAt > now && !rounds.some((r) => r.seq === p.seq));
  return {
    attendance: { id: att.id, checkInAt: att.checkInAt, checkOutAt: att.checkOutAt },
    rounds: rounds.map(view),
    areas,
    nextRoundAt: next?.dueAt ?? null,
    nextRoundKind: next?.kind ?? null,
    finalTime: await getSetting('officeBoy.finalReportTime'),
  };
}

export interface RoundInput {
  areas: { name: string; clean: boolean; note?: string }[];
  stockOk: boolean;
  stockNotes?: string;
  issues?: string;
  demandsReviewed?: boolean;
  attachmentIds: string[];
}

/** Submit one round's report (immutable once submitted). Issues reach the Manager at once (spec §13). */
export async function submitRound(actor: Actor, roundId: string, input: RoundInput) {
  const areas = await getSetting('officeBoy.areas');
  const names = input.areas.map((a) => a.name);
  if (new Set(names).size !== names.length || names.some((n) => !areas.includes(n))) throw new ValidationError('Areas list sahi nahi — page refresh karein.');
  if (areas.some((a) => !names.includes(a))) throw new ValidationError('Har area ka result likhein.');
  const dirty = input.areas.filter((a) => !a.clean);
  if (dirty.some((a) => !a.note?.trim())) throw new ValidationError('Jo area saaf nahi us ka masla likhein.');
  if (!input.stockOk && !input.stockNotes?.trim()) throw new ValidationError('Kaunsa stock kam hai, likhein.');
  const photoRequired = await getSetting('officeBoy.photoRequiredOnIssue');
  const hasIssue = dirty.length > 0 || !input.stockOk || !!input.issues?.trim();
  if (photoRequired && hasIssue && !input.attachmentIds.length) throw new ValidationError('Masle ki photo upload karein.');

  return prisma.$transaction(async (tx) => {
    const r = await tx.officeRound.findUnique({ where: { id: roundId } });
    if (!r || r.officeBoyId !== actor.id) deny('OfficeRound', roundId, 'officeboy:own_round');
    if (r.submittedAt) throw new ConflictError('ROUND_SUBMITTED', 'Yeh report jama ho chuki hai.');
    if (r.status === 'CANCELLED') throw new ConflictError('ROUND_CLOSED', 'Shift khatam — yeh round band ho chuka hai.');
    if (r.kind === 'FINAL' && !input.demandsReviewed) throw new ValidationError('Final report mein apni stock demands review karein.');
    if (input.attachmentIds.length) {
      const n = await tx.attachment.count({ where: { id: { in: input.attachmentIds }, recordType: 'OfficeRound', recordId: r.id } });
      if (n !== new Set(input.attachmentIds).size) throw new ValidationError('Photo is round ke saath nahi mili — dobara upload karein.');
    }
    const now = new Date();
    const { count } = await tx.officeRound.updateMany({
      where: { id: r.id, submittedAt: null },
      data: {
        submittedAt: now,
        status: 'COMPLETED',
        cleanlinessOk: dirty.length === 0,
        stockOk: input.stockOk,
        areas: { items: input.areas.map((a) => ({ name: a.name, clean: a.clean, note: a.note?.trim() || null })), stockNotes: input.stockNotes?.trim() || null, demandsReviewed: input.demandsReviewed ?? null },
        issues: input.issues?.trim() || null,
        attachmentIds: input.attachmentIds,
      },
    });
    if (!count) throw new ConflictError('ROUND_SUBMITTED', 'Yeh report jama ho chuki hai.');
    await audit(tx, actor, { action: 'OFFICE_ROUND_SUBMITTED', recordType: 'OfficeRound', recordId: r.id, after: { kind: r.kind, seq: r.seq, cleanlinessOk: dirty.length === 0, stockOk: input.stockOk, issue: hasIssue } });
    if (hasIssue) {
      const parts = [
        ...dirty.map((a) => `${a.name}: ${a.note!.trim()}`),
        !input.stockOk && `Stock: ${input.stockNotes!.trim()}`,
        input.issues?.trim() && `Issue: ${input.issues.trim()}`,
      ].filter(Boolean);
      await notifyRoles(tx, ['MANAGER'], {
        type: 'OFFICE_ROUND_ISSUE',
        subject: `${LABEL[r.kind]}${r.kind === 'ROUND' ? ` ${r.seq - 1}` : ''}: issue — ${actor.displayName}`,
        body: parts.join(' · '),
        recordType: 'OfficeRound',
        recordId: r.id,
        sender: actor,
        priority: 1,
        actionLabel: 'Review',
        dedupeKey: `officeround:${r.id}:issue`,
      });
    }
    await publish(tx, [userRoom(actor.id!)], 'queue:changed', {});
    return view((await tx.officeRound.findUniqueOrThrow({ where: { id: r.id } })));
  });
}

/** Manager / MD view of a shift's rounds (screens in Phase 8). */
export async function roundsFor(date?: string) {
  const d = date ? new Date(`${date}T12:00:00Z`) : new Date();
  const rows = await prisma.officeRound.findMany({ where: { dueAt: { gte: clinicDayBounds(clinicDateStr(d)).start, lt: clinicDayBounds(clinicDateStr(d)).end } }, orderBy: [{ officeBoyId: 'asc' }, { seq: 'asc' }] });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.officeBoyId))] } }, select: { id: true, displayName: true } });
  return { items: rows.map((r) => ({ ...view(r), areas: r.areas, attachmentIds: r.attachmentIds, officeBoyName: users.find((u) => u.id === r.officeBoyId)?.displayName ?? null, dueLabel: formatClinic(r.dueAt, 'h:mm a') })) };
}

export async function getRound(actor: Actor, id: string) {
  const r = await prisma.officeRound.findUnique({ where: { id } });
  if (!r) throw new NotFoundError('Round');
  if (r.officeBoyId !== actor.id) deny('OfficeRound', id, 'officeboy:own_round');
  return view(r);
}

