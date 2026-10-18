import type { ChecklistKind } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ConflictError, ValidationError } from '../../lib/errors';
import { clinicDate, clinicDateStr, dateOnly } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { notifyRoles, notifyUsers } from '../../services/notifications';
import { publish, userRoom } from '../../services/realtime';
import { assertOwnRoomAssignment } from '../../services/scope';
import { getSetting } from '../../services/settings';
import { blockCheckout, registerCheckoutGuard } from '../attendance/service';

/**
 * Room duty (spec §6, §12): the Manager assigns 1–N rooms per Assistant per day; the Assistant accepts each
 * room, submits an opening and a closing checklist (immutable once submitted), and cannot check out until every
 * accepted room is closed. Reports go to the Manager for verification; the Assistant cannot reopen them.
 */

const dayOf = (date?: string) => (date ? dateOnly(date) : clinicDate(new Date()));

/** Manager sets an Assistant's rooms for a day. Rooms already held by another Assistant that day are refused. */
export async function assignRooms(actor: Actor, input: { assistantId: string; roomIds: string[]; date?: string }) {
  const max = await getSetting('rooms.maxPerAssistant');
  const roomIds = [...new Set(input.roomIds)];
  if (roomIds.length < 1 || roomIds.length > max) throw new ValidationError(`Ek Assistant ko 1 se ${max} rooms diye ja sakte hain.`);
  const date = dayOf(input.date);
  if (clinicDateStr(date) < clinicDateStr(new Date())) throw new ValidationError('Guzra hua din nahi chuna ja sakta.');
  return prisma.$transaction(async (tx) => {
    const a = await tx.user.findUnique({ where: { id: input.assistantId }, select: { role: true, active: true, displayName: true } });
    if (!a || a.role !== 'ASSISTANT' || !a.active) throw new ValidationError('Assistant nahi mila.');
    const rooms = await tx.room.findMany({ where: { id: { in: roomIds }, active: true } });
    if (rooms.length !== roomIds.length) throw new ValidationError('Room nahi mila.');
    const held = await tx.roomAssignment.findMany({ where: { date, roomId: { in: roomIds }, unassignedAt: null, assistantId: { not: input.assistantId } } });
    if (held.length) {
      const codes = rooms.filter((r) => held.some((h) => h.roomId === r.id)).map((r) => r.code);
      throw new ConflictError('ROOM_ALREADY_ASSIGNED', `Room ${codes.join(', ')} aaj doosre Assistant ke paas hai.`);
    }
    const current = await tx.roomAssignment.findMany({ where: { date, assistantId: input.assistantId, unassignedAt: null }, include: { reports: true } });
    const now = new Date();
    // Rooms removed from the set are unassigned, unless the Assistant already reported on them (history is kept).
    for (const c of current.filter((c) => !roomIds.includes(c.roomId))) {
      if (c.reports.length) throw new ConflictError('ROOM_REPORTED', 'Jis room ki report jama ho chuki ho use hataya nahi ja sakta.');
      await tx.roomAssignment.update({ where: { id: c.id }, data: { unassignedAt: now } });
    }
    const added = [];
    for (const r of rooms.filter((r) => !current.some((c) => c.roomId === r.id))) {
      added.push(await tx.roomAssignment.create({ data: { assistantId: input.assistantId, roomId: r.id, date, assignedById: actor.id! } }));
    }
    await audit(tx, actor, { action: 'ROOMS_ASSIGNED', recordType: 'User', recordId: input.assistantId, before: { roomIds: current.map((c) => c.roomId) }, after: { roomIds, date: clinicDateStr(date) } });
    for (const n of added) {
      const room = rooms.find((r) => r.id === n.roomId)!;
      await notifyUsers(tx, [input.assistantId], { type: 'ROOM_ASSIGNED', subject: `Room ${room.code} assign hua`, body: `${clinicDateStr(date)} · accept karein aur opening checklist jama karein`, recordType: 'RoomAssignment', recordId: n.id, sender: actor, actionLabel: 'Accept', dedupeKey: `room:${n.id}:assigned` });
    }
    await publish(tx, [userRoom(input.assistantId)], 'queue:changed', {});
    return listAssignments(tx, clinicDateStr(date));
  });
}

/** Manager overview of a day's room duty. */
export async function listAssignments(db: Tx | typeof prisma = prisma, date?: string) {
  const d = dayOf(date);
  const rows = await db.roomAssignment.findMany({ where: { date: d, unassignedAt: null }, include: { reports: { select: { id: true, kind: true, submittedAt: true } } }, orderBy: { createdAt: 'asc' } });
  const [rooms, users] = await Promise.all([
    db.room.findMany({ select: { id: true, code: true, name: true, kind: true } }),
    db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.assistantId))] } }, select: { id: true, displayName: true } }),
  ]);
  return {
    date: clinicDateStr(d),
    rooms: rooms.map((r) => ({ id: r.id, code: r.code, name: r.name, kind: r.kind })).sort((x, y) => x.code.localeCompare(y.code)),
    maxPerAssistant: await getSetting('rooms.maxPerAssistant', db),
    items: rows.map((r) => ({ id: r.id, room: rooms.find((x) => x.id === r.roomId) ?? null, assistantId: r.assistantId, assistantName: users.find((u) => u.id === r.assistantId)?.displayName ?? null, acceptedAt: r.acceptedAt, reports: r.reports })),
  };
}

/** Assistant: today's rooms and their checklist state. Report contents are not returned (spec §12). */
export async function myRooms(actor: Actor) {
  const rows = await prisma.roomAssignment.findMany({ where: { assistantId: actor.id!, date: clinicDate(new Date()), unassignedAt: null }, include: { reports: { select: { kind: true, submittedAt: true } } }, orderBy: { createdAt: 'asc' } });
  const rooms = await prisma.room.findMany({ where: { id: { in: rows.map((r) => r.roomId) } }, select: { id: true, code: true, name: true, kind: true } });
  return {
    items: rows.map((r) => ({
      id: r.id,
      room: rooms.find((x) => x.id === r.roomId)!,
      acceptedAt: r.acceptedAt,
      openingAt: r.reports.find((x) => x.kind === 'OPENING')?.submittedAt ?? null,
      closingAt: r.reports.find((x) => x.kind === 'CLOSING')?.submittedAt ?? null,
    })),
  };
}

export async function acceptRoom(actor: Actor, assignmentId: string) {
  return prisma.$transaction(async (tx) => {
    const a = await assertOwnRoomAssignment(actor, assignmentId, tx);
    if (clinicDateStr(a.date) !== clinicDateStr(new Date())) throw new ConflictError('NOT_TODAY', 'Sirf aaj ka room accept ho sakta hai.');
    if (a.acceptedAt) return a;
    const out = await tx.roomAssignment.update({ where: { id: a.id }, data: { acceptedAt: new Date() } });
    await audit(tx, actor, { action: 'ROOM_ACCEPTED', recordType: 'RoomAssignment', recordId: a.id });
    return out;
  });
}

export interface ChecklistInput {
  kind: ChecklistKind;
  machineOk: boolean;
  machineIssue?: string;
  roomNeat: boolean;
  disinfected: boolean;
  stockOk: boolean;
  stockNotes?: string;
  demandSkipped: boolean;
  attachmentIds: string[];
}

/**
 * Opening / closing checklist. One per kind per assignment (DB-unique + immutable trigger). Creates the Manager's
 * verification task; issues (machine fault, untidy, not disinfected, stock short) also alert the Manager at once.
 */
export async function submitChecklist(actor: Actor, assignmentId: string, input: ChecklistInput) {
  if (!input.machineOk && !input.machineIssue?.trim()) throw new ValidationError('Machine ka masla likhein.');
  if (!input.stockOk && !input.stockNotes?.trim()) throw new ValidationError('Kaunsa stock kam hai, likhein.');
  return prisma.$transaction(async (tx) => {
    const a = await assertOwnRoomAssignment(actor, assignmentId, tx);
    if (clinicDateStr(a.date) !== clinicDateStr(new Date())) throw new ConflictError('NOT_TODAY', 'Sirf aaj ki checklist.');
    if (!a.acceptedAt) throw new ConflictError('ROOM_NOT_ACCEPTED', 'Pehle room accept karein.');
    const existing = await tx.roomChecklistReport.findMany({ where: { assignmentId: a.id } });
    if (existing.some((r) => r.kind === input.kind)) throw new ConflictError('CHECKLIST_SUBMITTED', `${input.kind === 'OPENING' ? 'Opening' : 'Closing'} checklist jama ho chuki hai.`);
    if (input.kind === 'CLOSING' && !existing.some((r) => r.kind === 'OPENING')) throw new ConflictError('OPENING_MISSING', 'Pehle opening checklist jama karein.');
    if (input.attachmentIds.length) {
      const atts = await tx.attachment.findMany({ where: { id: { in: input.attachmentIds }, recordType: 'RoomAssignment', recordId: a.id, route: { in: ['roomChecklistPhoto', 'machineIssuePhoto'] } } });
      if (atts.length !== new Set(input.attachmentIds).size) throw new ValidationError('Photo is room ke saath nahi mili — dobara upload karein.');
    }
    if (input.kind === 'CLOSING') {
      const busy = await tx.roomReservation.findFirst({ where: { roomId: a.roomId, status: { in: ['ACTIVE', 'AWAITING_CLEAN'] }, procedureTaskId: { not: null } } });
      if (busy) throw new ConflictError('ROOM_IN_USE', 'Room mein procedure / cleaning abhi baqi hai.');
    }
    const report = await tx.roomChecklistReport.create({
      data: {
        assignmentId: a.id,
        roomId: a.roomId,
        assistantId: actor.id!,
        kind: input.kind,
        machineOk: input.machineOk,
        machineIssue: input.machineIssue?.trim() || null,
        roomNeat: input.roomNeat,
        disinfected: input.disinfected,
        stockOk: input.stockOk,
        stockNotes: input.stockNotes?.trim() || null,
        demandSkipped: input.demandSkipped,
        attachmentIds: input.attachmentIds,
      },
    });
    const room = await tx.room.findUniqueOrThrow({ where: { id: a.roomId }, select: { code: true } });
    await tx.workflowTask.create({
      data: { type: 'MANAGER_ROOM_VERIFICATION', title: `Verify ${input.kind.toLowerCase()} · Room ${room.code} · ${actor.displayName}`, roomId: a.roomId, assignedRole: 'MANAGER', payload: { reportId: report.id, kind: input.kind }, idempotencyKey: `roomreport:${report.id}` },
    });
    await audit(tx, actor, { action: 'ROOM_CHECKLIST_SUBMITTED', recordType: 'RoomChecklistReport', recordId: report.id, after: { kind: input.kind, roomId: a.roomId } });
    const issues = [
      !input.machineOk && `machine: ${input.machineIssue!.trim()}`,
      !input.roomNeat && 'room saaf nahi',
      !input.disinfected && 'disinfect nahi hua',
      !input.stockOk && `stock: ${input.stockNotes!.trim()}`,
    ].filter(Boolean);
    if (issues.length) {
      await notifyRoles(tx, ['MANAGER'], { type: 'ROOM_ISSUE', subject: `Room ${room.code}: ${input.kind.toLowerCase()} issue`, body: issues.join(' · '), recordType: 'RoomChecklistReport', recordId: report.id, sender: actor, priority: 1, actionLabel: 'Verify' });
    }
    await publish(tx, [userRoom(actor.id!)], 'queue:changed', {});
    return { id: report.id, kind: report.kind, submittedAt: report.submittedAt };
  });
}

/** Check-out gate (spec §12): every accepted room must have its closing checklist, and no procedure may be open. */
registerCheckoutGuard('ASSISTANT', async (tx, actor) => {
  const open = await tx.procedureTask.findFirst({ where: { assistantId: actor.id!, status: { in: ['PENDING', 'IN_PROGRESS', 'BLOCKED'] } } });
  if (open) blockCheckout('PROCEDURE_OPEN', 'Pehle apna procedure mukammal karein (room clean tak).', { procedureTaskId: open.id });
  const rows = await tx.roomAssignment.findMany({ where: { assistantId: actor.id!, date: clinicDate(new Date()), unassignedAt: null, acceptedAt: { not: null } }, include: { reports: { select: { kind: true } } } });
  const pending = rows.filter((r) => !r.reports.some((x) => x.kind === 'CLOSING'));
  if (pending.length) {
    const rooms = await tx.room.findMany({ where: { id: { in: pending.map((p) => p.roomId) } }, select: { code: true } });
    blockCheckout('ROOM_CLOSING_PENDING', `Pehle room closing complete karein: ${rooms.map((r) => r.code).join(', ')}`, { rooms: rooms.map((r) => r.code) });
  }
});

