import type { MessageStatus, Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { clinicDayBounds } from '../../lib/time';
import { audit, systemActor, type Actor } from '../../services/audit';
import { getSetting } from '../../services/settings';
import { getProvider, providerIds } from '../../services/providers';
import { renderMessage, TEMPLATES, templateLabel } from '../../services/messageTemplates';

/**
 * WhatsApp message log for the Manager (spec §20 "message log") plus opt-out handling.
 * Sensitive templates (staff password-reset links) never expose their payload or text.
 */

/** Opt a phone out: every patient on it stops receiving WhatsApp, and their queued messages are cancelled. */
export async function optOutPhone(phone: string, source: string, actor: Actor = systemActor): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const patients = await tx.patient.findMany({ where: { phone, whatsappOptOutAt: null }, select: { id: true } });
    if (!patients.length) return 0;
    const now = new Date();
    const ids = patients.map((p) => p.id);
    await tx.patient.updateMany({ where: { id: { in: ids } }, data: { whatsappOptOutAt: now } });
    await tx.messageOutbox.updateMany({ where: { patientId: { in: ids }, status: 'QUEUED' }, data: { status: 'CANCELLED', terminal: true, lastError: 'Patient opted out (STOP)', errorClass: 'opt_out' } });
    for (const id of ids) await audit(tx, actor, { action: 'PATIENT_WHATSAPP_OPT_OUT', recordType: 'Patient', recordId: id, after: { source } });
    return ids.length;
  });
}

/** Manager records an opt-out, or an opt-in after the patient asked again (consent re-confirmed, reason audited). */
export async function setPatientWhatsapp(actor: Actor, patientId: string, input: { optIn: boolean; reason: string }) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.patient.findUnique({ where: { id: patientId }, select: { id: true, whatsappConsent: true, whatsappOptOutAt: true } });
    if (!p) throw new NotFoundError('Patient');
    const now = new Date();
    const data = input.optIn ? { whatsappConsent: true, whatsappOptOutAt: null } : { whatsappOptOutAt: p.whatsappOptOutAt ?? now };
    const after = await tx.patient.update({ where: { id: patientId }, data, select: { whatsappConsent: true, whatsappOptOutAt: true } });
    if (!input.optIn) await tx.messageOutbox.updateMany({ where: { patientId, status: 'QUEUED' }, data: { status: 'CANCELLED', terminal: true, lastError: 'Patient opted out', errorClass: 'opt_out' } });
    await audit(tx, actor, { action: input.optIn ? 'PATIENT_WHATSAPP_OPT_IN' : 'PATIENT_WHATSAPP_OPT_OUT', recordType: 'Patient', recordId: patientId, before: p, after, reason: input.reason });
    return after;
  });
}

export interface MessageFilter {
  status?: MessageStatus;
  template?: string;
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

export async function listMessages(f: MessageFilter) {
  const where: Prisma.MessageOutboxWhereInput = {};
  if (f.status) where.status = f.status;
  if (f.template) where.template = f.template;
  if (f.from || f.to) where.createdAt = { ...(f.from ? { gte: clinicDayBounds(f.from).start } : {}), ...(f.to ? { lt: clinicDayBounds(f.to).end } : {}) };
  if (f.q?.trim()) {
    const q = f.q.trim();
    const digits = q.replace(/\D/g, '');
    const patients = await prisma.patient.findMany({ where: { name: { contains: q } }, select: { id: true }, take: 50 });
    where.OR = [...(digits.length >= 4 ? [{ toPhone: { contains: digits.startsWith('0') ? digits.slice(1) : digits } }] : []), { patientId: { in: patients.map((p) => p.id) } }];
  }
  const rows = await prisma.messageOutbox.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, f.limit);
  const [patients, users] = await Promise.all([
    prisma.patient.findMany({ where: { id: { in: page.map((r) => r.patientId).filter((x): x is string => !!x) } }, select: { id: true, name: true, whatsappOptOutAt: true } }),
    prisma.user.findMany({ where: { id: { in: page.map((r) => r.recipientUserId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true, role: true } }),
  ]);
  return {
    items: page.map((r) => {
      const patient = patients.find((p) => p.id === r.patientId) ?? null;
      const user = users.find((u) => u.id === r.recipientUserId) ?? null;
      return {
        id: r.id,
        createdAt: r.createdAt,
        template: r.template,
        templateLabel: templateLabel(r.template),
        channel: r.channel,
        toPhone: r.toPhone,
        recipient: patient ? { kind: 'patient' as const, id: patient.id, name: patient.name, optedOut: !!patient.whatsappOptOutAt } : user ? { kind: 'staff' as const, id: user.id, name: user.displayName, role: user.role } : null,
        status: r.status,
        attempts: r.retryCount,
        nextAttemptAt: r.status === 'QUEUED' ? r.nextAttemptAt : null,
        lastError: r.lastError,
        errorClass: r.errorClass,
        sentAt: r.sentAt,
        deliveredAt: r.deliveredAt,
        failedAt: r.failedAt,
        relatedType: r.relatedType,
        relatedId: r.relatedId,
      };
    }),
    nextCursor: rows.length > f.limit ? page[page.length - 1]!.id : null,
  };
}

export async function messageDetail(id: string) {
  const m = await prisma.messageOutbox.findUnique({ where: { id } });
  if (!m) throw new NotFoundError('Message');
  const sensitive = !!TEMPLATES[m.template]?.sensitive;
  const [events, task] = await Promise.all([
    prisma.auditEvent.findMany({ where: { recordType: 'MessageOutbox', recordId: id }, orderBy: { id: 'asc' }, select: { id: true, action: true, actorId: true, createdAt: true, reason: true } }),
    prisma.workflowTask.findUnique({ where: { idempotencyKey: `message:${id}:failure` }, select: { status: true, completedAt: true, completedById: true } }),
  ]);
  const actors = await prisma.user.findMany({ where: { id: { in: events.map((e) => e.actorId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } });
  return {
    id: m.id,
    template: m.template,
    templateLabel: templateLabel(m.template),
    toPhone: m.toPhone,
    status: m.status,
    attempts: m.retryCount,
    lastError: m.lastError,
    errorClass: m.errorClass,
    createdAt: m.createdAt,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt,
    failedAt: m.failedAt,
    nextAttemptAt: m.status === 'QUEUED' ? m.nextAttemptAt : null,
    providerMessageId: m.providerMessageId,
    sensitive,
    text: sensitive ? null : renderMessage(m.template, m.payload),
    payload: sensitive ? null : m.payload,
    providerResponse: sensitive ? null : m.providerResponse,
    patientId: m.patientId,
    relatedType: m.relatedType,
    relatedId: m.relatedId,
    failureTask: task,
    history: events.map((e) => ({ id: String(e.id), action: e.action, at: e.createdAt, reason: e.reason, by: e.actorId ? (actors.find((u) => u.id === e.actorId)?.displayName ?? null) : 'System' })),
  };
}

/** Manual retry of a FAILED message (after fixing setup or the number). Closes its failure task. */
export async function retryMessage(actor: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.messageOutbox.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'QUEUED', terminal: false, nextAttemptAt: new Date(), retryCount: 0, lastError: null, errorClass: null, failedAt: null } });
    if (!count) throw new ConflictError('NOT_FAILED', 'Sirf failed message retry ho sakta hai.');
    await tx.workflowTask.updateMany({ where: { idempotencyKey: `message:${id}:failure`, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'COMPLETED', completedAt: new Date(), completedById: actor.id } });
    await audit(tx, actor, { action: 'MESSAGE_RETRIED', recordType: 'MessageOutbox', recordId: id });
    return { id, status: 'QUEUED' as const };
  });
}

/** Stop a queued message (e.g. wrong number). */
export async function cancelMessage(actor: Actor, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.messageOutbox.updateMany({ where: { id, status: 'QUEUED' }, data: { status: 'CANCELLED', terminal: true, lastError: `Cancelled: ${reason}`, errorClass: 'manual' } });
    if (!count) throw new ConflictError('NOT_QUEUED', 'Sirf queued message cancel ho sakta hai.');
    await audit(tx, actor, { action: 'MESSAGE_CANCELLED', recordType: 'MessageOutbox', recordId: id, reason });
    return { id, status: 'CANCELLED' as const };
  });
}

/** The Manager handled a failed message another way (called the patient): closes the failure task, message stays FAILED. */
export async function markHandled(actor: Actor, id: string, note: string) {
  return prisma.$transaction(async (tx) => {
    const m = await tx.messageOutbox.findUnique({ where: { id }, select: { status: true } });
    if (!m) throw new NotFoundError('Message');
    if (m.status !== 'FAILED') throw new ValidationError('Sirf failed message handled mark hota hai.');
    await tx.workflowTask.updateMany({ where: { idempotencyKey: `message:${id}:failure`, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'COMPLETED', completedAt: new Date(), completedById: actor.id } });
    await audit(tx, actor, { action: 'MESSAGE_HANDLED', recordType: 'MessageOutbox', recordId: id, reason: note });
    return { id };
  });
}

/** Header numbers + configuration check for the log screen (no secrets: webhook secret only as configured yes/no). */
export async function messageSummary(today: string) {
  const b = clinicDayBounds(today);
  const [byStatus, openFailures, providerId, sender, mapping, quietStart, quietEnd, maxRetries, base, roles] = await Promise.all([
    prisma.messageOutbox.groupBy({ by: ['status'], where: { createdAt: { gte: b.start, lt: b.end } }, _count: { _all: true } }),
    prisma.workflowTask.count({ where: { type: 'MANAGER_MESSAGE_FAILURE', status: { in: ['PENDING', 'IN_PROGRESS'] } } }),
    getSetting('whatsapp.provider'),
    getSetting('whatsapp.senderNumber'),
    getSetting('whatsapp.templates'),
    getSetting('notify.quietHoursStart'),
    getSetting('notify.quietHoursEnd'),
    getSetting('notify.maxRetries'),
    getSetting('notify.retryBaseSec'),
    getSetting('notify.terminalFailureRoles'),
  ]);
  const provider = getProvider(providerId);
  return {
    today: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    openFailures,
    config: {
      provider: providerId,
      providerInstalled: !!provider,
      installedProviders: providerIds(),
      mock: providerId === 'console',
      senderNumber: sender,
      quietHours: quietStart && quietEnd ? `${quietStart}–${quietEnd}` : null,
      maxRetries,
      retryBaseSec: base,
      terminalFailureRoles: roles,
      webhookSecretSet: !!env.WHATSAPP_WEBHOOK_SECRET && !env.WHATSAPP_WEBHOOK_SECRET.startsWith('CHANGE_ME'),
      templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, audience: t.audience, variables: t.variables, providerTemplate: mapping[key] ?? null })),
    },
  };
}
