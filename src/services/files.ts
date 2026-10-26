import type { Attachment, Role, UploadRoute } from '@prisma/client';
import { prisma, type Db } from '../lib/prisma';
import { ValidationError } from '../lib/errors';
import type { Actor } from './audit';
import { audit } from './audit';
import { deny, doctorCanSeePatient } from './scope';

/** Attachments uploaded before their parent record exists are parked on the uploader and claimed later. */
export const PENDING = 'Pending';

export interface RouteRule {
  isPrivate: boolean;
  uploaders: Role[];
  /** Record types this route may link to (besides PENDING). */
  recordTypes: string[];
  maxFileSize: '4MB' | '8MB' | '16MB';
  kinds: ('image' | 'pdf')[];
}

export const UPLOAD_RULES: Record<UploadRoute, RouteRule> = {
  consentForm: { isPrivate: true, uploaders: ['ASSISTANT'], recordTypes: ['ProcedureTask'], maxFileSize: '8MB', kinds: ['image', 'pdf'] },
  prescriptionPhoto: { isPrivate: true, uploaders: ['RECEPTIONIST', 'MANAGER'], recordTypes: ['Invoice'], maxFileSize: '8MB', kinds: ['image', 'pdf'] },
  beforePhoto: { isPrivate: true, uploaders: ['ASSISTANT'], recordTypes: ['ProcedureTask'], maxFileSize: '8MB', kinds: ['image'] },
  afterPhoto: { isPrivate: true, uploaders: ['ASSISTANT'], recordTypes: ['ProcedureTask'], maxFileSize: '8MB', kinds: ['image'] },
  itemsUsedEvidence: { isPrivate: true, uploaders: ['ASSISTANT'], recordTypes: ['ProcedureTask'], maxFileSize: '8MB', kinds: ['image'] },
  roomCleanPhoto: { isPrivate: true, uploaders: ['ASSISTANT'], recordTypes: ['ProcedureTask'], maxFileSize: '8MB', kinds: ['image'] },
  roomChecklistPhoto: { isPrivate: true, uploaders: ['ASSISTANT', 'OFFICE_BOY'], recordTypes: ['RoomAssignment', 'OfficeRound'], maxFileSize: '8MB', kinds: ['image'] },
  machineIssuePhoto: { isPrivate: true, uploaders: ['ASSISTANT'], recordTypes: ['RoomAssignment'], maxFileSize: '8MB', kinds: ['image'] },
  damagePhoto: { isPrivate: true, uploaders: ['MANAGER', 'ASSISTANT', 'OFFICE_BOY'], recordTypes: [], maxFileSize: '8MB', kinds: ['image'] },
  adCreative: { isPrivate: false, uploaders: ['MARKETING_LEAD', 'MARKETING_DIRECTOR'], recordTypes: ['AdRequest', 'Offer'], maxFileSize: '16MB', kinds: ['image', 'pdf'] },
  requestAttachment: {
    isPrivate: true,
    uploaders: ['LEAD_MEMBER', 'MARKETING_LEAD', 'MARKETING_DIRECTOR', 'RECEPTIONIST', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER', 'MD', 'DOCTOR'],
    recordTypes: ['AdRequest'],
    maxFileSize: '8MB',
    kinds: ['image', 'pdf'],
  },
  complaintAttachment: {
    isPrivate: true,
    uploaders: ['LEAD_MEMBER', 'RECEPTIONIST', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER', 'MD', 'MARKETING_DIRECTOR', 'MARKETING_LEAD', 'DOCTOR'],
    recordTypes: [],
    maxFileSize: '8MB',
    kinds: ['image', 'pdf'],
  },
  vendorInvoice: { isPrivate: true, uploaders: ['MANAGER'], recordTypes: ['GoodsReceipt'], maxFileSize: '8MB', kinds: ['image', 'pdf'] },
};

export interface UploadTarget {
  recordType: string;
  recordId: string;
}

/**
 * Upload authorization — shared by the UploadThing middleware and the dev stub.
 * Role must be allowed for the route, and the actor must be in scope for the target record.
 */
export async function authorizeUpload(actor: Actor, route: UploadRoute, target: UploadTarget, db: Db = prisma): Promise<void> {
  const rule = UPLOAD_RULES[route];
  if (!actor.role || !rule.uploaders.includes(actor.role)) deny('Attachment', undefined, `upload:${route}:role`);
  if (target.recordType === PENDING) {
    if (target.recordId !== actor.id) deny('Attachment', undefined, `upload:${route}:pending_owner`);
    return;
  }
  if (!rule.recordTypes.includes(target.recordType)) {
    throw new ValidationError(`Route ${route} cannot attach to ${target.recordType}`);
  }
  const { recordType, recordId } = target;
  switch (recordType) {
    case 'ProcedureTask': {
      const t = await db.procedureTask.findUnique({ where: { id: recordId }, select: { assistantId: true, status: true } });
      if (!t || t.assistantId !== actor.id || t.status === 'COMPLETED') deny(recordType, recordId, 'upload:assigned_procedure');
      return;
    }
    case 'RoomAssignment': {
      const a = await db.roomAssignment.findUnique({ where: { id: recordId }, select: { assistantId: true, unassignedAt: true } });
      if (!a || a.assistantId !== actor.id || a.unassignedAt) deny(recordType, recordId, 'upload:assigned_room');
      return;
    }
    case 'OfficeRound': {
      const r = await db.officeRound.findUnique({ where: { id: recordId }, select: { officeBoyId: true, submittedAt: true } });
      if (!r || r.officeBoyId !== actor.id || r.submittedAt) deny(recordType, recordId, 'upload:own_open_round');
      return;
    }
    case 'Invoice': {
      const inv = await db.invoice.findUnique({ where: { id: recordId }, select: { status: true } });
      if (!inv || inv.status !== 'OPEN') deny(recordType, recordId, 'upload:open_invoice');
      return;
    }
    case 'AdRequest': {
      const r = await db.adRequest.findUnique({ where: { id: recordId }, select: { requesterId: true } });
      const marketing = actor.role === 'MARKETING_LEAD' || actor.role === 'MARKETING_DIRECTOR';
      if (!r || (!marketing && r.requesterId !== actor.id)) deny(recordType, recordId, 'upload:ad_request_party');
      return;
    }
    case 'GoodsReceipt': {
      const g = await db.goodsReceipt.findUnique({ where: { id: recordId }, select: { id: true } });
      if (!g) deny(recordType, recordId, 'upload:receipt_exists');
      return;
    }
    default:
      deny(recordType, recordId, 'upload:unknown_record_type');
  }
}

export interface UploadedFileInfo {
  key: string;
  name: string;
  size: number;
  type: string;
  ufsUrl?: string;
}

/** Called from onUploadComplete (or the dev stub). Stores the file key, never a public URL for private files. */
export async function recordUpload(actorId: string, route: UploadRoute, target: UploadTarget, file: UploadedFileInfo): Promise<Attachment> {
  const rule = UPLOAD_RULES[route];
  return prisma.$transaction(async (tx) => {
    const att = await tx.attachment.upsert({
      where: { fileKey: file.key },
      update: {},
      create: {
        fileKey: file.key,
        route,
        fileName: file.name.slice(0, 255),
        mime: file.type || 'application/octet-stream',
        size: file.size,
        isPrivate: rule.isPrivate,
        publicUrl: rule.isPrivate ? null : (file.ufsUrl ?? null),
        uploadedById: actorId,
        recordType: target.recordType,
        recordId: target.recordId,
      },
    });
    const user = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, displayName: true } });
    await audit(tx, { id: actorId, role: user?.role ?? null, displayName: user?.displayName ?? '' }, {
      action: 'FILE_UPLOADED',
      recordType: target.recordType,
      recordId: target.recordId,
      after: { attachmentId: att.id, route, size: file.size, mime: file.type },
    });
    return att;
  });
}

/**
 * Claim attachments parked as PENDING by this actor onto a newly created record (same transaction).
 * Rejects ids that are not the actor's own pending uploads of an allowed route.
 */
export async function claimAttachments(
  tx: Db,
  actor: Actor,
  ids: string[],
  allowedRoutes: UploadRoute[],
  recordType: string,
  recordId: string,
): Promise<void> {
  if (!ids.length) return;
  const rows = await tx.attachment.findMany({ where: { id: { in: ids } } });
  for (const id of ids) {
    const a = rows.find((r) => r.id === id);
    if (!a || a.recordType !== PENDING || a.recordId !== actor.id || !allowedRoutes.includes(a.route)) {
      deny('Attachment', id, 'attachment:claim_own_pending');
    }
  }
  await tx.attachment.updateMany({ where: { id: { in: ids } }, data: { recordType, recordId } });
}

/** Read authorization for GET /api/files/:id/url. */
export async function authorizeRead(actor: Actor, att: Attachment, db: Db = prisma): Promise<void> {
  const r = actor.role;
  const t = att.recordType;
  const id = att.recordId;
  const no = (rule: string): never => deny('Attachment', att.id, `read:${rule}`);
  if (!r || !actor.id) return no('anonymous');
  if (r === 'OFFICE_BOY' && t !== PENDING && t !== 'StockDemand' && t !== 'DamageReport' && t !== 'OfficeRound') return no('office_boy_no_patient_files');

  switch (t) {
    case PENDING:
      if (att.uploadedById !== actor.id) no('pending_owner');
      return;
    case 'ProcedureTask': {
      const task = await db.procedureTask.findUnique({ where: { id }, select: { assistantId: true, patientId: true, status: true } });
      if (!task) return no('missing');
      if (r === 'MANAGER' || r === 'MD') return;
      if (r === 'ASSISTANT' && task.assistantId === actor.id && task.status !== 'COMPLETED') return;
      if (r === 'DOCTOR' && (await doctorCanSeePatient(actor.id, task.patientId, db))) return;
      return no('procedure_scope');
    }
    case 'Invoice': {
      if (r === 'RECEPTIONIST' || r === 'MANAGER' || r === 'MD') return;
      if (r === 'DOCTOR') {
        const inv = await db.invoice.findUnique({ where: { id }, select: { patientId: true } });
        if (inv?.patientId && (await doctorCanSeePatient(actor.id, inv.patientId, db))) return;
      }
      return no('invoice_scope');
    }
    case 'RoomAssignment':
    case 'RoomChecklistReport':
      // Assistant cannot preview a submitted report (spec §12). MD/Hamza have report access (spec §20).
      if (r === 'MANAGER' || r === 'MD' || r === 'MARKETING_DIRECTOR') return;
      return no('room_report_scope');
    case 'Complaint': {
      if (r === 'MANAGER' || r === 'MD') return;
      const c = await db.complaint.findUnique({ where: { id }, select: { raisedById: true, recipients: { select: { userId: true } } } });
      if (c && (c.raisedById === actor.id || c.recipients.some((x) => x.userId === actor.id))) return;
      return no('complaint_party');
    }
    case 'AdRequest': {
      if (r === 'MARKETING_LEAD' || r === 'MARKETING_DIRECTOR') return;
      const a = await db.adRequest.findUnique({ where: { id }, select: { requesterId: true } });
      if (a && a.requesterId === actor.id) return;
      return no('ad_request_party');
    }
    case 'OfficeRound':
      if (r === 'MANAGER' || r === 'MD' || r === 'MARKETING_DIRECTOR') return;
      if (att.uploadedById === actor.id) return;
      return no('office_round_scope');
    case 'Offer':
      return; // published creatives are visible to every signed-in role that sees offers
    case 'GoodsReceipt':
    case 'DamageReport':
    case 'StockDemand':
      if (r === 'MANAGER' || r === 'MD') return;
      if (att.uploadedById === actor.id) return;
      return no('inventory_scope');
    default:
      return no('unknown_record_type');
  }
}
