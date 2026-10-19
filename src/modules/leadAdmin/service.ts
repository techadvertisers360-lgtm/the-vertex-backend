import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { parseSpreadsheetId } from '../../services/googleSheets';
import type { ColumnMap } from '../leadSync/parse';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { DEV_NOTIFIED_MSG, reportIssue } from '../../services/devIssues';
import { inspectSheet, problemText, type Inspection } from '../leadSync/service';
import { audit, type Actor } from '../../services/audit';
import { notifyUsers } from '../../services/notifications';
import { publish, userRoom } from '../../services/realtime';
import { createUser, updateUser } from '../users/service';

/**
 * Lead Team administration (spec §2, §7, §16): only Hamza Zafar (MARKETING_DIRECTOR) and Usama Sufain (MD) create /
 * disable Lead members and add / assign Meta sheets (permission `leads:admin`, enforced again in users service).
 * A member sees only the sheets currently assigned to them (D-020). One member owns a sheet at a time (D-038).
 */

export async function members() {
  const [rows, assignments, sheets] = await Promise.all([
    prisma.user.findMany({ where: { role: 'LEAD_MEMBER' }, select: { id: true, displayName: true, memberCode: true, email: true, phone: true, active: true, createdAt: true }, orderBy: [{ active: 'desc' }, { memberCode: 'asc' }] }),
    prisma.sheetAssignment.findMany({ where: { unassignedAt: null } }),
    prisma.metaSheet.findMany({ select: { id: true, title: true, campaign: true, active: true } }),
  ]);
  const openLeads = await prisma.lead.groupBy({ by: ['assignedMemberId'], where: { status: { notIn: ['BOOKED', 'NOT_INTERESTED'] }, sheet: { deletedAt: null } }, _count: { _all: true } });
  return {
    items: rows.map((m) => ({
      ...m,
      sheets: assignments.filter((a) => a.memberId === m.id).map((a) => sheets.find((s) => s.id === a.sheetId)).filter(Boolean),
      openLeads: openLeads.find((o) => o.assignedMemberId === m.id)?._count._all ?? 0,
    })),
    nextMemberCode: await nextMemberCode(),
  };
}

async function nextMemberCode() {
  const codes = await prisma.user.findMany({ where: { memberCode: { startsWith: 'LM-' } }, select: { memberCode: true } });
  const max = codes.reduce((m, c) => Math.max(m, Number(c.memberCode!.slice(3)) || 0), 0);
  return `LM-${String(max + 1).padStart(3, '0')}`;
}

export async function addMember(actor: Actor, input: { displayName: string; memberCode?: string; phone?: string; email?: string; password: string }) {
  const memberCode = (input.memberCode?.trim() || (await nextMemberCode())).toUpperCase();
  if (!input.phone && !input.email) throw new ValidationError('Phone ya email mein se ek zaroori hai (contact).');
  return createUser(actor, { displayName: input.displayName, role: 'LEAD_MEMBER', memberCode, phone: input.phone, email: input.email, password: input.password, title: 'Lead Team Member' });
}

/** Disable / enable or change contact. Disabling ends sessions (users service) — the member's sheets stay listed for reassignment. */
export async function updateMember(actor: Actor, id: string, input: { displayName?: string; phone?: string | null; email?: string | null; active?: boolean }) {
  const u = await prisma.user.findUnique({ where: { id }, select: { role: true } });
  if (!u || u.role !== 'LEAD_MEMBER') throw new NotFoundError('Lead member');
  return updateUser(actor, id, input);
}

// ───────────── Meta sheets ─────────────

export async function sheets() {
  const [rows, assignments, users, leadCounts] = await Promise.all([
    prisma.metaSheet.findMany({ where: { deletedAt: null }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] }),
    prisma.sheetAssignment.findMany({ orderBy: { assignedAt: 'desc' } }),
    prisma.user.findMany({ where: { role: { in: ['LEAD_MEMBER', 'MD', 'MARKETING_DIRECTOR'] } }, select: { id: true, displayName: true, memberCode: true, active: true } }),
    prisma.lead.groupBy({ by: ['sheetId'], _count: { _all: true } }),
  ]);
  const name = (id: string | null) => users.find((u) => u.id === id) ?? null;
  return {
    // The sync error text is for the developer only (D-045).
    items: rows.map(({ syncLeaseOwner: _o, syncLeaseUntil, lastSyncError: _err, ...s }) => {
      const current = assignments.find((a) => a.sheetId === s.id && !a.unassignedAt) ?? null;
      return {
        ...s,
        syncing: !!syncLeaseUntil && syncLeaseUntil > new Date(),
        createdBy: name(s.createdById)?.displayName ?? null,
        leads: leadCounts.find((l) => l.sheetId === s.id)?._count._all ?? 0,
        member: current ? { ...name(current.memberId), assignedAt: current.assignedAt, assignedBy: name(current.assignedById)?.displayName ?? null } : null,
        history: assignments.filter((a) => a.sheetId === s.id).map((a) => ({ member: name(a.memberId)?.displayName ?? null, assignedAt: a.assignedAt, unassignedAt: a.unassignedAt, by: name(a.assignedById)?.displayName ?? null })),
      };
    }),
  };
}

export interface SheetSource {
  googleSheetId?: string | null;
  tabName?: string | null;
  columnMap?: ColumnMap | null;
}

type ResolvedSource =
  | { kind: 'unchanged' }
  | { kind: 'unlink' }
  | { kind: 'link'; googleSheetId: string; tabName: string; columnMap: ColumnMap; inspection: Inspection | null };

/**
 * Work out the Google source before the transaction (D-045): only the sheet link is needed — the tab and columns are
 * detected from the sheet. An explicit tab + column map (API) is still accepted. If the sheet cannot be read the
 * full reason goes to the developer and the person linking sees a neutral message.
 */
async function resolveSource(actor: Actor, input: SheetSource, before?: { googleSheetId: string | null }): Promise<ResolvedSource> {
  if (input.googleSheetId === undefined && input.tabName === undefined && input.columnMap === undefined) return { kind: 'unchanged' };
  const raw = input.googleSheetId?.trim() ?? '';
  if (!raw) return { kind: 'unlink' };
  const googleSheetId = parseSpreadsheetId(raw);
  if (!googleSheetId) throw new ValidationError('Yeh Google Sheet ka link nahi lagta — browser se poora sheet link copy karke paste karein.');
  const tabName = input.tabName?.trim() || null;
  if (before && googleSheetId === before.googleSheetId && !tabName && !input.columnMap) return { kind: 'unchanged' };
  if (tabName && input.columnMap) return { kind: 'link', googleSheetId, tabName, columnMap: input.columnMap, inspection: null };
  try {
    const inspection = await inspectSheet(googleSheetId, { tabName, columnMap: input.columnMap ?? null });
    return { kind: 'link', googleSheetId, tabName: inspection.tabName, columnMap: inspection.columnMap, inspection };
  } catch (err) {
    await reportIssue(actor, { area: 'Lead sheet', tried: `Sheet link karna — ${raw.slice(0, 200)}`, reason: problemText(err), context: { googleSheetId } });
    throw new AppError(422, 'SHEET_LINK_FAILED', DEV_NOTIFIED_MSG);
  }
}

async function sourceData(tx: Tx, src: ResolvedSource, selfId?: string) {
  if (src.kind === 'unchanged') return {};
  if (src.kind === 'unlink') return { googleSheetId: null, tabName: null, columnMap: Prisma.JsonNull };
  const clash = await tx.metaSheet.findFirst({ where: { googleSheetId: src.googleSheetId, tabName: src.tabName, ...(selfId ? { id: { not: selfId } } : {}) }, select: { title: true } });
  if (clash) throw new ConflictError('SHEET_SOURCE_EXISTS', `Yeh Google Sheet pehle se "${clash.title}" se link hai.`);
  return { googleSheetId: src.googleSheetId, tabName: src.tabName, columnMap: src.columnMap as Prisma.InputJsonValue };
}

/** A free sheet / form identifier: Meta's form id when the sheet has one, else one made from the spreadsheet. */
async function freeExternalId(tx: Tx, wanted: string) {
  const base = wanted.slice(0, 180);
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!(await tx.metaSheet.findUnique({ where: { externalId: id }, select: { id: true } }))) return id;
  }
}

/** Link a sheet. With a Google link, title / campaign / sheet id are optional — they come from the sheet itself. */
export async function createSheet(actor: Actor, input: { externalId?: string; title?: string; campaign?: string } & SheetSource) {
  const src = await resolveSource(actor, input);
  const found = src.kind === 'link' ? src.inspection : null;
  const title = input.title?.trim() || found?.title || '';
  const campaign = input.campaign?.trim() || found?.campaign || found?.title || '';
  const wantedId = input.externalId?.trim() || (src.kind === 'link' ? found?.formId || `GS-${src.googleSheetId.slice(0, 10)}-${src.tabName}` : '');
  if (!wantedId || !title || !campaign) throw new ValidationError('Google Sheet ka link paste karein.');
  return prisma.$transaction(async (tx) => {
    let externalId = wantedId;
    if (input.externalId?.trim()) {
      if (await tx.metaSheet.findUnique({ where: { externalId } })) throw new ConflictError('SHEET_EXISTS', 'Yeh sheet ID pehle se link hai.');
    } else externalId = await freeExternalId(tx, wantedId);
    const s = await tx.metaSheet.create({ data: { externalId, title, campaign, createdById: actor.id!, ...(await sourceData(tx, src)) } });
    await audit(tx, actor, { action: 'SHEET_CREATED', recordType: 'MetaSheet', recordId: s.id, after: s });
    return s;
  });
}

/**
 * Edit a sheet. Changing the Google Sheet / tab restarts reading from row 2 (already-imported ids are skipped).
 * The id column cannot change once leads were imported, because it defines each lead's import key.
 */
export async function updateSheet(actor: Actor, id: string, input: { title?: string; campaign?: string; active?: boolean } & SheetSource) {
  const current = await prisma.metaSheet.findUnique({ where: { id }, select: { googleSheetId: true } });
  if (!current) throw new NotFoundError('Sheet');
  const resolved = await resolveSource(actor, input, current);
  return prisma.$transaction(async (tx) => {
    const before = await tx.metaSheet.findUnique({ where: { id } });
    if (!before || before.deletedAt) throw new NotFoundError('Sheet');
    const src = await sourceData(tx, resolved, id);
    if (resolved.kind === 'link' && before.columnMap) {
      const oldId = (before.columnMap as ColumnMap).id?.trim() || null;
      const newId = resolved.columnMap.id?.trim() || null;
      const imported = await tx.lead.count({ where: { sheetId: id, externalRowId: { not: null } } });
      if (imported && oldId !== newId) throw new ValidationError('Leads import ho chuke hain — lead ID column ab badla nahi ja sakta (duplicates ban jayenge).');
    }
    const sourceChanged = 'googleSheetId' in src && (src.googleSheetId !== before.googleSheetId || src.tabName !== before.tabName);
    const s = await tx.metaSheet.update({
      where: { id },
      data: { title: input.title?.trim() || undefined, campaign: input.campaign?.trim() || undefined, active: input.active, ...src, ...(sourceChanged ? { syncCursorRow: 1, consecutiveFailures: 0, lastSyncError: null, lastSyncStatus: null } : {}) },
    });
    await audit(tx, actor, { action: 'SHEET_UPDATED', recordType: 'MetaSheet', recordId: id, before, after: s });
    return s;
  });
}

/**
 * Assign a sheet to a member (replaces the current owner). Workable leads and their pending callbacks move to the
 * new member so follow-ups are not lost; bookings keep their original attribution (spec §8, D-038).
 */
export async function assignSheet(actor: Actor, sheetId: string, memberId: string) {
  return prisma.$transaction(async (tx) => {
    const sheet = await tx.metaSheet.findUnique({ where: { id: sheetId } });
    if (!sheet || sheet.deletedAt) throw new NotFoundError('Sheet');
    const m = await tx.user.findUnique({ where: { id: memberId }, select: { id: true, role: true, active: true, displayName: true } });
    if (!m || m.role !== 'LEAD_MEMBER' || !m.active) throw new ValidationError('Active Lead member chunein.');
    const current = await tx.sheetAssignment.findFirst({ where: { sheetId, unassignedAt: null } });
    if (current?.memberId === memberId) return { sheetId, memberId, moved: 0 };
    const now = new Date();
    if (current) await tx.sheetAssignment.update({ where: { id: current.id }, data: { unassignedAt: now, unassignedById: actor.id } });
    await tx.sheetAssignment.create({ data: { sheetId, memberId, assignedById: actor.id! } });
    let moved = 0;
    if (current) {
      const workable = await tx.lead.findMany({ where: { sheetId, assignedMemberId: current.memberId, status: { notIn: ['BOOKED', 'NOT_INTERESTED'] } }, select: { id: true } });
      moved = workable.length;
      if (moved) {
        await tx.lead.updateMany({ where: { id: { in: workable.map((l) => l.id) } }, data: { assignedMemberId: memberId } });
        await tx.leadCallback.updateMany({ where: { leadId: { in: workable.map((l) => l.id) }, status: { in: ['PENDING', 'DUE'] } }, data: { memberId } });
      }
      await publish(tx, [userRoom(current.memberId)], 'queue:changed', {});
    }
    await audit(tx, actor, { action: 'SHEET_ASSIGNED', recordType: 'MetaSheet', recordId: sheetId, before: { memberId: current?.memberId ?? null }, after: { memberId, movedLeads: moved } });
    await notifyUsers(tx, [memberId], { type: 'SHEET_ASSIGNED', subject: `Nayi sheet: ${sheet.title}`, body: `${sheet.campaign}${moved ? ` · ${moved} leads` : ''}`, recordType: 'MetaSheet', recordId: sheetId, sender: actor, dedupeKey: `sheet:${sheetId}:${memberId}:${now.getTime()}` });
    return { sheetId, memberId, moved };
  });
}

/**
 * Delete a sheet (D-047): the lead team stops seeing it and all its leads at once (the member's assignment ends —
 * members only ever see leads of sheets assigned to them), pending callbacks are cancelled, syncing stops and the
 * Google link is released so the same sheet can be linked again. Leads, their call history and booking attribution
 * stay in the database (no hard deletes of history); the sheet disappears from every list.
 */
export async function deleteSheet(actor: Actor, sheetId: string) {
  return prisma.$transaction(async (tx) => {
    const sheet = await tx.metaSheet.findUnique({ where: { id: sheetId } });
    if (!sheet || sheet.deletedAt) throw new NotFoundError('Sheet');
    const now = new Date();
    const current = await tx.sheetAssignment.findFirst({ where: { sheetId, unassignedAt: null } });
    if (current) await tx.sheetAssignment.update({ where: { id: current.id }, data: { unassignedAt: now, unassignedById: actor.id } });
    const callbacks = await tx.leadCallback.updateMany({ where: { lead: { sheetId }, status: { in: ['PENDING', 'DUE'] } }, data: { status: 'CANCELLED' } });
    const leads = await tx.lead.count({ where: { sheetId } });
    const after = await tx.metaSheet.update({
      where: { id: sheetId },
      data: { deletedAt: now, deletedById: actor.id, active: false, googleSheetId: null, tabName: null, syncLeaseUntil: null, syncLeaseOwner: null },
    });
    await audit(tx, actor, { action: 'SHEET_DELETED', recordType: 'MetaSheet', recordId: sheetId, before: sheet, after: { ...after, hiddenLeads: leads, cancelledCallbacks: callbacks.count, memberId: current?.memberId ?? null } });
    if (current) await publish(tx, [userRoom(current.memberId)], 'queue:changed', {});
    return { sheetId, hiddenLeads: leads, cancelledCallbacks: callbacks.count };
  });
}

export async function unassignSheet(actor: Actor, sheetId: string) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.sheetAssignment.findFirst({ where: { sheetId, unassignedAt: null } });
    if (!current) throw new ConflictError('NOT_ASSIGNED', 'Sheet kisi member ke paas nahi.');
    await tx.sheetAssignment.update({ where: { id: current.id }, data: { unassignedAt: new Date(), unassignedById: actor.id } });
    await audit(tx, actor, { action: 'SHEET_UNASSIGNED', recordType: 'MetaSheet', recordId: sheetId, before: { memberId: current.memberId } });
    await publish(tx, [userRoom(current.memberId)], 'queue:changed', {});
    return { sheetId };
  });
}
