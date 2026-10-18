import type { AdRequestKind, LeaveKind, Prisma, RequestStatus, Role } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { audit, type Actor } from '../../services/audit';
import { formatClinic } from '../../lib/time';
import { claimAttachments } from '../../services/files';
import { notifyUsers } from '../../services/notifications';
import { deny } from '../../services/scope';
import { mySheetIds } from '../leads/service';

const REASON_REQUIRED: RequestStatus[] = ['REJECTED', 'RETURNED_FOR_CORRECTION', 'NEED_DETAILS'];

async function activeUserIds(tx: Tx, roles: Role[]): Promise<string[]> {
  const users = await tx.user.findMany({ where: { role: { in: roles }, active: true }, select: { id: true } });
  return users.map((u) => u.id);
}

async function addThread(tx: Tx, threadType: string, threadId: string, authorId: string, body: string, statusChange?: RequestStatus | null, attachmentIds?: string[]) {
  return tx.threadMessage.create({
    data: { threadType, threadId, authorId, body, statusChange: statusChange ?? null, attachmentIds: attachmentIds?.length ? attachmentIds : undefined },
  });
}

export async function getThread(threadType: string, threadId: string) {
  const msgs = await prisma.threadMessage.findMany({ where: { threadType, threadId }, orderBy: { createdAt: 'asc' } });
  const authors = await prisma.user.findMany({ where: { id: { in: [...new Set(msgs.map((m) => m.authorId))] } }, select: { id: true, displayName: true, role: true } });
  return msgs.map((m) => ({ ...m, author: authors.find((a) => a.id === m.authorId) ?? null }));
}

// ───────────── Leave / early leave (spec §21; D-013) ─────────────

/**
 * Approver routing: Manager's own leave → MD (Manager cannot approve own leave); every other staff / Lead
 * member → Manager. Lead member requests also notify Hamza Zafar + Muaz Tahir (clinic decision D-013).
 * Doctors use the leave/availability workflow (spec §11) instead.
 */
export function leaveApproverRole(requester: Role): Role {
  if (requester === 'DOCTOR') throw new ValidationError('Doctor leave "Leave & Availability" se darj karein (patient impact check ke saath).');
  // MD leave needs no approval (D-021): recorded as approved on creation, informational notice only.
  if (requester === 'MD' || requester === 'MANAGER' || requester === 'MARKETING_DIRECTOR' || requester === 'MARKETING_LEAD') return 'MD';
  return 'MANAGER';
}

export interface LeaveInput {
  kind: LeaveKind;
  startAt: Date;
  endAt: Date;
  reason: string;
  coveragePlan?: string;
}

function validateLeave(i: LeaveInput) {
  if (i.endAt <= i.startAt) throw new ValidationError('Leave ka end time start ke baad hona chahiye.');
  if (!i.reason.trim()) throw new ValidationError('Leave ki wajah likhein.');
}

/** Spec §20: date / time, reason and (when given) coverage in every leave notice. */
export function leaveSummary(r: { kind: LeaveKind; startAt: Date; endAt: Date; reason: string; coveragePlan: string | null }): string {
  const sameDay = formatClinic(r.startAt, 'dd LLL yyyy') === formatClinic(r.endAt, 'dd LLL yyyy');
  const when = sameDay ? `${formatClinic(r.startAt, 'dd LLL yyyy, h:mm a')}–${formatClinic(r.endAt, 'h:mm a')}` : `${formatClinic(r.startAt)} → ${formatClinic(r.endAt)}`;
  return `${when} · ${r.reason}${r.coveragePlan ? ` · Coverage: ${r.coveragePlan}` : ''}`;
}

async function leaveWatchers(tx: Tx, requesterRole: Role, approverRole: Role): Promise<string[]> {
  const approvers = await activeUserIds(tx, [approverRole]);
  const extra = requesterRole === 'LEAD_MEMBER' ? await activeUserIds(tx, ['MARKETING_DIRECTOR', 'MARKETING_LEAD']) : [];
  return [...approvers, ...extra];
}

export async function createLeave(actor: Actor, input: LeaveInput) {
  validateLeave(input);
  const approverRole = leaveApproverRole(actor.role!);
  if (actor.role === 'MD') return createMdLeave(actor, input);
  return prisma.$transaction(async (tx) => {
    const req = await tx.leaveRequest.create({
      data: { requesterId: actor.id!, requesterRole: actor.role!, kind: input.kind, startAt: input.startAt, endAt: input.endAt, reason: input.reason, coveragePlan: input.coveragePlan ?? null, approverRole },
    });
    await addThread(tx, 'LeaveRequest', req.id, actor.id!, input.reason, 'PENDING');
    await audit(tx, actor, { action: 'LEAVE_REQUESTED', recordType: 'LeaveRequest', recordId: req.id, after: req });
    await notifyUsers(tx, await leaveWatchers(tx, actor.role!, approverRole), {
      type: input.kind === 'LEAVE' ? 'LEAVE_REQUESTED' : 'EARLY_LEAVE_REQUESTED',
      subject: `${input.kind === 'LEAVE' ? 'Leave' : 'Early leave'} request: ${actor.displayName}`,
      body: leaveSummary(req),
      recordType: 'LeaveRequest',
      recordId: req.id,
      sender: actor,
      actionLabel: 'Review',
      dedupeKey: `leave:${req.id}:requested`,
    });
    return req;
  });
}

/** MD's own leave: no approval; recorded as APPROVED and announced to the Manager and Hamza Zafar (D-021). */
async function createMdLeave(actor: Actor, input: LeaveInput) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const req = await tx.leaveRequest.create({
      data: {
        requesterId: actor.id!,
        requesterRole: 'MD',
        kind: input.kind,
        startAt: input.startAt,
        endAt: input.endAt,
        reason: input.reason,
        coveragePlan: input.coveragePlan ?? null,
        approverRole: 'MD',
        status: 'APPROVED',
        decidedAt: now,
        decisionReason: 'MD leave — no approval required (informational)',
      },
    });
    await addThread(tx, 'LeaveRequest', req.id, actor.id!, input.reason, 'APPROVED');
    await audit(tx, actor, { action: 'LEAVE_RECORDED_NO_APPROVAL', recordType: 'LeaveRequest', recordId: req.id, after: req });
    await notifyUsers(tx, await activeUserIds(tx, ['MANAGER', 'MARKETING_DIRECTOR']), {
      type: 'LEAVE_INFO',
      subject: `MD ${input.kind === 'LEAVE' ? 'leave' : 'early leave'} (info): ${actor.displayName}`,
      body: input.reason,
      recordType: 'LeaveRequest',
      recordId: req.id,
      sender: actor,
      dedupeKey: `leave:${req.id}:info`,
    });
    return req;
  });
}

/** Display names for inbox rows (who asked / raised it). */
async function nameMap(ids: (string | null | undefined)[]) {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(ids.filter((x): x is string => !!x))] } }, select: { id: true, displayName: true, role: true } });
  return (id: string | null | undefined) => users.find((u) => u.id === id) ?? null;
}

export async function listLeave(actor: Actor, box: 'mine' | 'inbox', status?: RequestStatus) {
  const marketingWatcher = actor.role === 'MARKETING_DIRECTOR' || actor.role === 'MARKETING_LEAD';
  const where: Prisma.LeaveRequestWhereInput =
    box === 'mine'
      ? { requesterId: actor.id! }
      : marketingWatcher
        ? { OR: [{ approverRole: actor.role! }, { requesterRole: 'LEAD_MEMBER' }], requesterId: { not: actor.id! } } // D-013 watchers
        : { approverRole: actor.role!, requesterId: { not: actor.id! } };
  if (status) where.status = status;
  const rows = await prisma.leaveRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
  const who = await nameMap(rows.map((r) => r.requesterId));
  return rows.map((r) => ({ ...r, requester: who(r.requesterId) }));
}

async function leaveInScope(actor: Actor, id: string, db: Tx | typeof prisma = prisma) {
  const r = await db.leaveRequest.findUnique({ where: { id } });
  if (!r) throw new NotFoundError('Leave request');
  const watchersExtra = r.requesterRole === 'LEAD_MEMBER' && (actor.role === 'MARKETING_DIRECTOR' || actor.role === 'MARKETING_LEAD');
  if (r.requesterId !== actor.id && r.approverRole !== actor.role && !watchersExtra) deny('LeaveRequest', id, 'leave:party');
  return r;
}

export async function getLeave(actor: Actor, id: string) {
  const r = await leaveInScope(actor, id);
  const who = await nameMap([r.requesterId]);
  return { ...r, requester: who(r.requesterId), thread: await getThread('LeaveRequest', id) };
}

export async function decideLeave(actor: Actor, id: string, status: RequestStatus, reason?: string) {
  if (!['IN_REVIEW', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION'].includes(status)) throw new ValidationError('Invalid decision.');
  if (REASON_REQUIRED.includes(status) && !reason?.trim()) throw new ValidationError('Reject / Return ke liye wajah zaroori hai.');
  return prisma.$transaction(async (tx) => {
    const r = await tx.leaveRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundError('Leave request');
    if (r.approverRole !== actor.role) deny('LeaveRequest', id, 'leave:approver_role');
    if (r.requesterId === actor.id) deny('LeaveRequest', id, 'leave:no_self_approval');
    if (!['PENDING', 'IN_REVIEW'].includes(r.status)) throw new ConflictError('ALREADY_DECIDED', 'Is request par faisla ho chuka hai.');
    const { count } = await tx.leaveRequest.updateMany({
      where: { id, status: r.status },
      data: { status, decidedById: actor.id, decidedAt: new Date(), decisionReason: reason ?? null },
    });
    if (!count) throw new ConflictError('STATUS_CHANGED', 'Request ka status abhi badla gaya. Refresh karein.');
    await addThread(tx, 'LeaveRequest', id, actor.id!, reason ?? status, status);
    await audit(tx, actor, { action: `LEAVE_${status}`, recordType: 'LeaveRequest', recordId: id, before: { status: r.status }, after: { status }, reason });
    const recipients = [r.requesterId, ...(r.requesterRole === 'LEAD_MEMBER' ? await activeUserIds(tx, ['MARKETING_DIRECTOR', 'MARKETING_LEAD']) : [])];
    await notifyUsers(tx, recipients, {
      type: 'LEAVE_DECIDED',
      subject: `Leave request ${status.replace(/_/g, ' ').toLowerCase()}`,
      body: reason,
      recordType: 'LeaveRequest',
      recordId: id,
      sender: actor,
    });
    return tx.leaveRequest.findUniqueOrThrow({ where: { id } });
  });
}

/** Requester corrects a returned request and resubmits it. */
export async function resubmitLeave(actor: Actor, id: string, input: LeaveInput) {
  validateLeave(input);
  return prisma.$transaction(async (tx) => {
    const r = await tx.leaveRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundError('Leave request');
    if (r.requesterId !== actor.id) deny('LeaveRequest', id, 'leave:owner');
    if (r.status !== 'RETURNED_FOR_CORRECTION') throw new ConflictError('NOT_RETURNED', 'Sirf "Return for Correction" wali request dobara bheji ja sakti hai.');
    const updated = await tx.leaveRequest.update({
      where: { id },
      data: { kind: input.kind, startAt: input.startAt, endAt: input.endAt, reason: input.reason, coveragePlan: input.coveragePlan ?? null, status: 'PENDING', decidedById: null, decidedAt: null },
    });
    await addThread(tx, 'LeaveRequest', id, actor.id!, `Resubmitted: ${input.reason}`, 'PENDING');
    await audit(tx, actor, { action: 'LEAVE_RESUBMITTED', recordType: 'LeaveRequest', recordId: id, before: r, after: updated });
    await notifyUsers(tx, await leaveWatchers(tx, r.requesterRole, r.approverRole), {
      type: 'LEAVE_REQUESTED',
      subject: `Leave request resubmitted: ${actor.displayName}`,
      recordType: 'LeaveRequest',
      recordId: id,
      sender: actor,
    });
    return updated;
  });
}

// ───────────── Complaints (spec §21; D-019) ─────────────

export type ComplaintRecipient = 'MANAGER' | 'MD' | 'HAMZA';
const RECIPIENT_ROLE: Record<ComplaintRecipient, Role> = { MANAGER: 'MANAGER', MD: 'MD', HAMZA: 'MARKETING_DIRECTOR' };

/**
 * Recipient routing:
 *  - Manager's complaint → MD and Hamza Zafar (spec §20/§21);
 *  - Lead member → selected recipient + Hamza Zafar + Muaz Tahir (§21 selection and §7 "dono ko"; D-019);
 *  - other staff → the recipient they select among Manager / MD / Hamza.
 */
export async function complaintRecipients(tx: Tx, actor: Actor, selected?: ComplaintRecipient): Promise<string[]> {
  if (actor.role === 'MANAGER') return activeUserIds(tx, ['MD', 'MARKETING_DIRECTOR']);
  if (!selected) throw new ValidationError('Complaint kis ko bhejni hai: Manager, MD ya Hamza?');
  if (actor.role === 'MARKETING_DIRECTOR' && selected === 'HAMZA') throw new ValidationError('Apni complaint Manager ya MD ko bhejein.');
  const roles: Role[] = [RECIPIENT_ROLE[selected]];
  if (actor.role === 'LEAD_MEMBER') roles.push('MARKETING_DIRECTOR', 'MARKETING_LEAD');
  return (await activeUserIds(tx, roles)).filter((id) => id !== actor.id);
}

export interface ComplaintInput {
  subject: string;
  detail: string;
  recipient?: ComplaintRecipient;
  attachmentIds?: string[];
}

export async function createComplaint(actor: Actor, input: ComplaintInput) {
  return prisma.$transaction(async (tx) => {
    const recipients = await complaintRecipients(tx, actor, input.recipient);
    if (!recipients.length) throw new ValidationError('Is recipient ke liye koi active user nahi mila.');
    const c = await tx.complaint.create({
      data: {
        source: actor.role === 'LEAD_MEMBER' ? 'LEAD' : actor.role === 'MANAGER' ? 'MANAGER' : 'STAFF',
        raisedById: actor.id,
        subject: input.subject,
        detail: input.detail,
        recipients: { create: recipients.map((userId) => ({ userId })) },
      },
    });
    await claimAttachments(tx, actor, input.attachmentIds ?? [], ['complaintAttachment'], 'Complaint', c.id);
    await addThread(tx, 'Complaint', c.id, actor.id!, input.detail, 'PENDING', input.attachmentIds);
    await audit(tx, actor, { action: 'COMPLAINT_CREATED', recordType: 'Complaint', recordId: c.id, after: { ...c, recipients } });
    await notifyUsers(tx, recipients, {
      type: 'COMPLAINT_RECEIVED',
      subject: `Complaint: ${input.subject}`,
      body: `${actor.displayName}: ${input.detail.slice(0, 200)}`,
      recordType: 'Complaint',
      recordId: c.id,
      sender: actor,
      actionLabel: 'Review',
      priority: 1,
      dedupeKey: `complaint:${c.id}:created`,
    });
    return c;
  });
}

async function complaintParty(actor: Actor, id: string, db: Tx | typeof prisma = prisma) {
  const c = await db.complaint.findUnique({ where: { id }, include: { recipients: { select: { userId: true } } } });
  if (!c) throw new NotFoundError('Complaint');
  const isRecipient = c.recipients.some((r) => r.userId === actor.id);
  // Patient complaints (spec §9) go to the Manager inbox; Managers and MD see them.
  const patientInbox = c.source === 'PATIENT' && (actor.role === 'MANAGER' || actor.role === 'MD');
  if (c.raisedById !== actor.id && !isRecipient && !patientInbox) deny('Complaint', id, 'complaint:party');
  return { c, isRecipient: isRecipient || patientInbox };
}

export async function listComplaints(actor: Actor, box: 'mine' | 'inbox', status?: RequestStatus) {
  const where: Prisma.ComplaintWhereInput =
    box === 'mine'
      ? { raisedById: actor.id }
      : actor.role === 'MANAGER' || actor.role === 'MD'
        ? { OR: [{ recipients: { some: { userId: actor.id! } } }, { source: 'PATIENT' }] }
        : { recipients: { some: { userId: actor.id! } } };
  if (status) where.status = status;
  const rows = await prisma.complaint.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: { recipients: { select: { userId: true } } } });
  const who = await nameMap(rows.map((r) => r.raisedById));
  const patients = await prisma.patient.findMany({ where: { id: { in: rows.map((r) => r.patientId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  return rows.map((r) => ({ ...r, raisedBy: who(r.raisedById), patientName: patients.find((p) => p.id === r.patientId)?.name ?? null }));
}

export async function getComplaint(actor: Actor, id: string) {
  const { c, isRecipient } = await complaintParty(actor, id);
  const who = await nameMap([c.raisedById]);
  const patient = c.patientId ? await prisma.patient.findUnique({ where: { id: c.patientId }, select: { name: true, phone: true } }) : null;
  return { ...c, canAct: isRecipient, raisedBy: who(c.raisedById), patient, thread: await getThread('Complaint', id) };
}

const COMPLAINT_STATUSES: RequestStatus[] = ['IN_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'];

/** Reply on the shared thread; recipients may also change status (reason required for Reject). */
export async function replyComplaint(actor: Actor, id: string, body: string, status?: RequestStatus, attachmentIds: string[] = []) {
  if (!body.trim()) throw new ValidationError('Message likhein.');
  return prisma.$transaction(async (tx) => {
    const { c, isRecipient } = await complaintParty(actor, id, tx);
    if (status) {
      if (!isRecipient) deny('Complaint', id, 'complaint:status_by_recipient');
      if (!COMPLAINT_STATUSES.includes(status)) throw new ValidationError('Invalid status.');
      await tx.complaint.update({ where: { id }, data: { status, resolvedAt: status === 'RESOLVED' ? new Date() : null } });
      await audit(tx, actor, { action: `COMPLAINT_${status}`, recordType: 'Complaint', recordId: id, before: { status: c.status }, after: { status }, reason: body });
    }
    await claimAttachments(tx, actor, attachmentIds, ['complaintAttachment'], 'Complaint', id);
    const msg = await addThread(tx, 'Complaint', id, actor.id!, body, status, attachmentIds);
    const parties = [c.raisedById, ...c.recipients.map((r) => r.userId)].filter((x): x is string => !!x);
    await notifyUsers(tx, parties, { type: 'COMPLAINT_UPDATED', subject: `Complaint update: ${c.subject}`, body, recordType: 'Complaint', recordId: id, sender: actor });
    return msg;
  });
}

/**
 * Manager escalates a complaint (spec §9/§14/§16): to the MD (default), or an operational issue to Hamza Zafar
 * (Marketing & Development Director). The target is added as a recipient; history stays on the thread.
 */
export async function escalateComplaint(actor: Actor, id: string, reason: string, to: 'MD' | 'HAMZA' = 'MD') {
  if (actor.role !== 'MANAGER') deny('Complaint', id, 'complaint:escalate_manager');
  if (!reason.trim()) throw new ValidationError('Escalation ki wajah likhein.');
  return prisma.$transaction(async (tx) => {
    const { c, isRecipient } = await complaintParty(actor, id, tx);
    if (!isRecipient) deny('Complaint', id, 'complaint:escalate_recipient');
    if (to === 'MD' && c.escalatedToMdAt) throw new ConflictError('ALREADY_ESCALATED', 'Complaint pehle hi MD ko escalate ho chuki hai.');
    const targets = await activeUserIds(tx, [to === 'MD' ? 'MD' : 'MARKETING_DIRECTOR']);
    for (const userId of targets) await tx.complaintRecipient.upsert({ where: { complaintId_userId: { complaintId: id, userId } }, update: {}, create: { complaintId: id, userId } });
    await tx.complaint.update({ where: { id }, data: { status: 'IN_REVIEW', ...(to === 'MD' ? { escalatedToMdAt: new Date() } : {}) } });
    await addThread(tx, 'Complaint', id, actor.id!, `Escalated to ${to === 'MD' ? 'MD' : 'Hamza Zafar'}: ${reason}`, 'IN_REVIEW');
    await audit(tx, actor, { action: 'COMPLAINT_ESCALATED', recordType: 'Complaint', recordId: id, after: { to }, reason });
    await notifyUsers(tx, targets, { type: 'COMPLAINT_ESCALATED', subject: `Escalation: ${c.subject}`, body: reason, recordType: 'Complaint', recordId: id, sender: actor, priority: 2, dedupeKey: `complaint:${id}:escalated:${to}` });
  });
}

/** MD / Hamza hand a complaint to the Manager to act on (spec §15 "delegate to Manager"); they stay on the thread. */
export async function delegateComplaint(actor: Actor, id: string, note: string) {
  if (actor.role !== 'MD' && actor.role !== 'MARKETING_DIRECTOR') deny('Complaint', id, 'complaint:delegate_leadership');
  if (!note.trim()) throw new ValidationError('Manager ke liye hidayat likhein.');
  return prisma.$transaction(async (tx) => {
    const { c, isRecipient } = await complaintParty(actor, id, tx);
    if (!isRecipient) deny('Complaint', id, 'complaint:delegate_recipient');
    if (['RESOLVED', 'REJECTED'].includes(c.status)) throw new ConflictError('COMPLAINT_CLOSED', 'Complaint band ho chuki hai.');
    const managers = await activeUserIds(tx, ['MANAGER']);
    for (const userId of managers) await tx.complaintRecipient.upsert({ where: { complaintId_userId: { complaintId: id, userId } }, update: {}, create: { complaintId: id, userId } });
    await tx.complaint.update({ where: { id }, data: { status: 'IN_PROGRESS' } });
    await addThread(tx, 'Complaint', id, actor.id!, `Delegated to Manager: ${note}`, 'IN_PROGRESS');
    await audit(tx, actor, { action: 'COMPLAINT_DELEGATED', recordType: 'Complaint', recordId: id, reason: note });
    await notifyUsers(tx, managers, { type: 'COMPLAINT_DELEGATED', subject: `${actor.displayName} ne complaint di: ${c.subject}`, body: note, recordType: 'Complaint', recordId: id, sender: actor, priority: 1, dedupeKey: `complaint:${id}:delegated:${Date.now()}` });
  });
}

// ───────────── Ad / Issue requests (spec §7, §16, §17) ─────────────

const MARKETING: Role[] = ['MARKETING_LEAD', 'MARKETING_DIRECTOR'];
const isMarketing = (a: Actor) => !!a.role && MARKETING.includes(a.role);
const AD_STATUSES: RequestStatus[] = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'NEED_DETAILS'];

export interface AdRequestInput {
  kind: AdRequestKind;
  sheetId?: string;
  campaign?: string;
  detail: string;
  reason?: string;
  attachmentIds?: string[];
}

/** One request, one id, shared by Muaz and Hamza; either can reply on the same thread (spec §17). */
export async function createAdRequest(actor: Actor, input: AdRequestInput) {
  if (input.sheetId && !(await mySheetIds(actor.id!)).includes(input.sheetId)) deny('MetaSheet', input.sheetId, 'lead:assigned_sheet');
  return prisma.$transaction(async (tx) => {
    const sheet = input.sheetId ? await tx.metaSheet.findUnique({ where: { id: input.sheetId }, select: { campaign: true } }) : null;
    const r = await tx.adRequest.create({
      data: { requesterId: actor.id!, sheetId: input.sheetId ?? null, campaign: input.campaign ?? sheet?.campaign ?? null, kind: input.kind, detail: input.detail, reason: input.reason ?? null },
    });
    await claimAttachments(tx, actor, input.attachmentIds ?? [], ['requestAttachment'], 'AdRequest', r.id);
    await addThread(tx, 'AdRequest', r.id, actor.id!, input.detail, 'PENDING', input.attachmentIds);
    await audit(tx, actor, { action: 'AD_REQUEST_CREATED', recordType: 'AdRequest', recordId: r.id, after: r });
    await notifyUsers(tx, await activeUserIds(tx, MARKETING), {
      type: 'AD_REQUEST',
      subject: `${input.kind.replace(/_/g, ' ')} request: ${r.campaign ?? 'general'}`,
      body: `${actor.displayName}: ${input.detail.slice(0, 200)}`,
      recordType: 'AdRequest',
      recordId: r.id,
      sender: actor,
      actionLabel: 'Open thread',
      dedupeKey: `adrequest:${r.id}:created`,
    });
    return r;
  });
}

async function adParty(actor: Actor, id: string, db: Tx | typeof prisma = prisma) {
  const r = await db.adRequest.findUnique({ where: { id } });
  if (!r) throw new NotFoundError('Request');
  if (r.requesterId !== actor.id && !isMarketing(actor)) deny('AdRequest', id, 'adrequest:party');
  return r;
}

export async function listAdRequests(actor: Actor, status?: RequestStatus) {
  const where: Prisma.AdRequestWhereInput = isMarketing(actor) ? {} : { requesterId: actor.id! };
  if (status) where.status = status;
  return prisma.adRequest.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 });
}

export async function getAdRequest(actor: Actor, id: string) {
  const r = await adParty(actor, id);
  return { ...r, thread: await getThread('AdRequest', id) };
}

export async function replyAdRequest(actor: Actor, id: string, body: string, status?: RequestStatus, attachmentIds: string[] = []) {
  if (!body.trim()) throw new ValidationError('Message likhein.');
  return prisma.$transaction(async (tx) => {
    const r = await adParty(actor, id, tx);
    let next: RequestStatus | undefined;
    if (status) {
      if (!isMarketing(actor)) deny('AdRequest', id, 'adrequest:status_by_marketing');
      if (!AD_STATUSES.includes(status)) throw new ValidationError('Invalid status.');
      next = status;
    } else if (!isMarketing(actor) && r.status === 'NEED_DETAILS') {
      next = 'PENDING'; // requester supplied the missing details
    }
    if (next && next !== r.status) {
      await tx.adRequest.update({ where: { id }, data: { status: next } });
      await audit(tx, actor, { action: `AD_REQUEST_${next}`, recordType: 'AdRequest', recordId: id, before: { status: r.status }, after: { status: next }, reason: body });
    } else {
      await tx.adRequest.update({ where: { id }, data: { updatedAt: new Date() } });
    }
    await claimAttachments(tx, actor, attachmentIds, isMarketing(actor) ? ['requestAttachment', 'adCreative'] : ['requestAttachment'], 'AdRequest', id);
    const msg = await addThread(tx, 'AdRequest', id, actor.id!, body, next ?? null, attachmentIds);
    // Sender and co-recipient(s) are all notified.
    await notifyUsers(tx, [r.requesterId, ...(await activeUserIds(tx, MARKETING))], {
      type: 'AD_REQUEST_REPLY',
      subject: `Request update${next ? `: ${next.replace(/_/g, ' ').toLowerCase()}` : ''}`,
      body,
      recordType: 'AdRequest',
      recordId: id,
      sender: actor,
    });
    return msg;
  });
}
