import type { Role } from '@prisma/client';
import { prisma, type Db } from '../lib/prisma';
import { ForbiddenError } from '../lib/errors';
import type { Actor } from './audit';

/**
 * Object-scope rules shared across modules (spec §22). Every function either returns quietly or
 * throws ForbiddenError (→ 403 + AUTHZ_DENIED audit).
 */

export function deny(recordType: string, recordId: string | undefined, rule: string, message?: string): never {
  throw new ForbiddenError({ recordType, recordId, rule }, message);
}

export function requireRoleIn(actor: Actor, roles: Role[], recordType: string, recordId?: string): void {
  if (!actor.role || !roles.includes(actor.role)) deny(recordType, recordId, `role:${roles.join('|')}`);
}

/** Doctor "own patient": the doctor has (or had) an appointment with the patient. */
export async function isDoctorsOwnPatient(doctorId: string, patientId: string, db: Db = prisma): Promise<boolean> {
  const n = await db.appointment.count({ where: { doctorId, patientId } });
  return n > 0;
}

/** Approved and unexpired Manager approval for another Doctor's patient history (spec §4, §10). */
export async function hasApprovedHistoryAccess(doctorId: string, patientId: string, db: Db = prisma): Promise<boolean> {
  const n = await db.historyAccessRequest.count({
    where: { doctorId, patientId, status: 'APPROVED', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
  });
  return n > 0;
}

export async function doctorCanSeePatient(doctorId: string, patientId: string, db: Db = prisma): Promise<boolean> {
  return (await isDoctorsOwnPatient(doctorId, patientId, db)) || (await hasApprovedHistoryAccess(doctorId, patientId, db));
}

/** Lead member may only touch leads on sheets currently assigned to them. */
export async function memberHasSheet(memberId: string, sheetId: string, db: Db = prisma): Promise<boolean> {
  const n = await db.sheetAssignment.count({ where: { memberId, sheetId, unassignedAt: null } });
  return n > 0;
}

export async function assertMemberSheet(actor: Actor, sheetId: string, db: Db = prisma): Promise<void> {
  if (actor.role !== 'LEAD_MEMBER' || !actor.id || !(await memberHasSheet(actor.id, sheetId, db))) {
    deny('MetaSheet', sheetId, 'lead:assigned_sheet');
  }
}

/** Assistant may only act on procedure tasks currently assigned to them. */
export async function assertAssignedProcedure(actor: Actor, procedureTaskId: string, db: Db = prisma) {
  const t = await db.procedureTask.findUnique({ where: { id: procedureTaskId } });
  if (!t || actor.role !== 'ASSISTANT' || t.assistantId !== actor.id) {
    deny('ProcedureTask', procedureTaskId, 'assistant:assigned_procedure');
  }
  return t;
}

/** Assistant may only act on their own active room assignments. */
export async function assertOwnRoomAssignment(actor: Actor, assignmentId: string, db: Db = prisma) {
  const a = await db.roomAssignment.findUnique({ where: { id: assignmentId } });
  if (!a || actor.role !== 'ASSISTANT' || a.assistantId !== actor.id || a.unassignedAt) {
    deny('RoomAssignment', assignmentId, 'assistant:assigned_room');
  }
  return a;
}
