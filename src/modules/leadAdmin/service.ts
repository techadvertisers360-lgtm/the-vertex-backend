import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { parseSpreadsheetId } from '../../services/googleSheets';
import type { ColumnMap } from '../leadSync/parse';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
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
  const openLeads = await prisma.lead.groupBy({ by: ['assignedMemberId'], where: { status: { notIn: ['BOOKED', 'NOT_INTERESTED'] } }, _count: { _all: true } });
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
    prisma.metaSheet.findMany({ orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] }),
    prisma.sheetAssignment.findMany({ orderBy: { assignedAt: 'desc' } }),
    prisma.user.findMany({ where: { role: { in: ['LEAD_MEMBER', 'MD', 'MARKETING_DIRECTOR'] } }, select: { id: true, displayName: true, memberCode: true, active: true } }),
    prisma.lead.groupBy({ by: ['sheetId'], _count: { _all: true } }),
  ]);
  const name = (id: string | null) => users.find((u) => u.id === id) ?? null;
  return {
    items: rows.map(({ syncLeaseOwner: _o, syncLeaseUntil, ...s }) => {
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

/** Validate the Google source fields; the spreadsheet ID may be pasted as the full sheet URL. */
async function source(tx: Tx, input: SheetSource, selfId?: string) {
  if (input.googleSheetId === undefined && input.tabName === undefined && input.columnMap === undefined) return {};
  const raw = input.googleSheetId?.trim() ?? '';
  const googleSheetId = raw ? parseSpreadsheetId(raw) : null;
  if (raw && !googleSheetId) throw new ValidationError('Google Sheet link / ID samajh nahi aaya — poora sheet link paste karein.');
  const tabName = input.tabName?.trim() || null;
  if (googleSheetId && !tabName) throw new ValidationError('Tab ka naam likhein (sheet ke neeche wala tab).');
  if (googleSheetId && !input.columnMap) throw new ValidationError('Name aur phone columns likhein.');
  if (googleSheetId) {
    const clash = await tx.metaSheet.findFirst({ where: { googleSheetId, tabName, ...(selfId ? { id: { not: selfId } } : {}) }, select: { title: true } });
    if (clash) throw new ConflictError('SHEET_SOURCE_EXISTS', `Yeh Google Sheet tab pehle se "${clash.title}" se link hai.`);
  }
  return { googleSheetId, tabName: googleSheetId ? tabName : null, columnMap: googleSheetId && input.columnMap ? (input.columnMap as Prisma.InputJsonValue) : Prisma.JsonNull };
}

export async function createSheet(actor: Actor, input: { externalId: string; title: string; campaign: string } & SheetSource) {
  const externalId = input.externalId.trim();
  if (!externalId || !input.title.trim() || !input.campaign.trim()) throw new ValidationError('Sheet ID, title aur campaign likhein.');
  return prisma.$transaction(async (tx) => {
    if (await tx.metaSheet.findUnique({ where: { externalId } })) throw new ConflictError('SHEET_EXISTS', 'Yeh sheet ID pehle se link hai.');
    const s = await tx.metaSheet.create({ data: { externalId, title: input.title.trim(), campaign: input.campaign.trim(), createdById: actor.id!, ...(await source(tx, input)) } });
    await audit(tx, actor, { action: 'SHEET_CREATED', recordType: 'MetaSheet', recordId: s.id, after: s });
    return s;
  });
}

/**
 * Edit a sheet. Changing the Google Sheet / tab restarts reading from row 2 (already-imported ids are skipped).
 * The id column cannot change once leads were imported, because it defines each lead's import key.
 */
export async function updateSheet(actor: Actor, id: string, input: { title?: string; campaign?: string; active?: boolean } & SheetSource) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.metaSheet.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Sheet');
    const src = await source(tx, input, id);
    if ('googleSheetId' in src && src.googleSheetId && before.columnMap) {
      const oldId = (before.columnMap as ColumnMap).id?.trim() || null;
      const newId = input.columnMap?.id?.trim() || null;
      const imported = await tx.lead.count({ where: { sheetId: id, externalRowId: { not: null } } });
      if (imported && oldId !== newId) throw new ValidationError('Leads import ho chuke hain — lead ID column ab badla nahi ja sakta (duplicates ban jayenge).');
    }
    const sourceChanged = 'googleSheetId' in src && (src.googleSheetId !== before.googleSheetId || src.tabName !== before.tabName);
    const s = await tx.metaSheet.update({
      where: { id },
      data: { title: input.title?.trim(), campaign: input.campaign?.trim(), active: input.active, ...src, ...(sourceChanged ? { syncCursorRow: 1, consecutiveFailures: 0, lastSyncError: null, lastSyncStatus: null } : {}) },
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
    if (!sheet) throw new NotFoundError('Sheet');
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
