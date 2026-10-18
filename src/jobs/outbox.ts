import type { MessageOutbox, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../lib/prisma';
import { logger } from '../lib/misc';
import { clinicDateStr, local } from '../lib/time';
import { audit, systemActor, type Actor } from '../services/audit';
import { notifyRoles } from '../services/notifications';
import { getProvider, type SendResult } from '../services/providers';
import { getSetting } from '../services/settings';
import { renderMessage, templateLabel, templateVariables } from '../services/messageTemplates';

/**
 * Message outbox delivery (spec §20, §23): consent / opt-out, quiet hours, provider + template configuration,
 * retries with exponential backoff, terminal failure → Manager alert + open MANAGER_MESSAGE_FAILURE task.
 * Rows are claimed with SKIP LOCKED so several workers never send the same message twice.
 */
export async function claimDueMessages(workerId: string, batch = 20): Promise<MessageOutbox[]> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM message_outbox
      WHERE status = 'QUEUED' AND nextAttemptAt <= NOW(3)
      ORDER BY nextAttemptAt ASC
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    await tx.messageOutbox.updateMany({ where: { id: { in: ids } }, data: { status: 'SENDING' } });
    logger.debug({ workerId, n: ids.length }, 'claimed messages');
    return tx.messageOutbox.findMany({ where: { id: { in: ids } } });
  });
}

/** Quiet hours apply to patient-facing messages only. Returns the next allowed instant, or null if allowed now. */
export async function quietHoursDelay(msg: Pick<MessageOutbox, 'patientId'>, now: Date): Promise<Date | null> {
  if (!msg.patientId) return null;
  const start = await getSetting('notify.quietHoursStart');
  const end = await getSetting('notify.quietHoursEnd');
  if (!start || !end || start === end) return null;
  const l = local(now);
  const m = l.hour * 60 + l.minute;
  const toMin = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3));
  const s = toMin(start);
  const e = toMin(end);
  const inQuiet = s < e ? m >= s && m < e : m >= s || m < e;
  if (!inQuiet) return null;
  const addMin = (e - m + 1440) % 1440;
  return l.plus({ minutes: addMin }).startOf('minute').toUTC().toJSDate();
}

/**
 * Terminal failure (retries exhausted, permanent provider error, configuration error, or a provider FAILED receipt):
 * the row is marked FAILED, audited, the Manager (`notify.terminalFailureRoles`) is alerted and an open
 * MANAGER_MESSAGE_FAILURE task stays on the dashboard until the message is retried or handled by phone.
 */
export async function markTerminal(
  tx: Tx,
  msg: MessageOutbox,
  f: { error: string; errorClass: string; attempts?: number; providerResponse?: unknown; now: Date; actor?: Actor },
): Promise<void> {
  await tx.messageOutbox.update({
    where: { id: msg.id },
    data: {
      status: 'FAILED',
      terminal: true,
      failedAt: f.now,
      retryCount: f.attempts ?? msg.retryCount,
      lastError: f.error,
      errorClass: f.errorClass,
      ...(f.providerResponse !== undefined ? { providerResponse: f.providerResponse as Prisma.InputJsonValue } : {}),
    },
  });
  await audit(tx, f.actor ?? systemActor, { action: 'MESSAGE_FAILED', recordType: 'MessageOutbox', recordId: msg.id, after: { template: msg.template, attempts: f.attempts ?? msg.retryCount, error: f.error, errorClass: f.errorClass } });
  const who = msg.patientId ? ((await tx.patient.findUnique({ where: { id: msg.patientId }, select: { name: true } }))?.name ?? msg.toPhone) : msg.toPhone;
  await tx.workflowTask.upsert({
    where: { idempotencyKey: `message:${msg.id}:failure` },
    update: { status: 'PENDING', completedAt: null, completedById: null, payload: { error: f.error } },
    create: {
      type: 'MANAGER_MESSAGE_FAILURE',
      title: `Message fail: ${templateLabel(msg.template)} — ${who}`,
      patientId: msg.patientId,
      appointmentId: msg.relatedType === 'Appointment' ? msg.relatedId : null,
      assignedRole: 'MANAGER',
      idempotencyKey: `message:${msg.id}:failure`,
      payload: { messageId: msg.id, error: f.error },
    },
  });
  const roles = (await getSetting('notify.terminalFailureRoles', tx)) as ('MANAGER' | 'MD')[];
  // Configuration errors hit every message: alert once per reason per clinic day instead of once per message.
  const dedupeKey = f.errorClass === 'config' ? `message_config:${f.error.slice(0, 60)}:${clinicDateStr(f.now)}` : `message_failed:${msg.id}`;
  await notifyRoles(tx, roles, {
    type: 'MESSAGE_FAILED',
    subject: f.errorClass === 'config' ? 'WhatsApp setup masla — messages nahi ja rahe' : `Message fail: ${templateLabel(msg.template)} — ${who}`,
    body: `${msg.toPhone} · ${f.error}. Message log se retry karein ya call karein.`,
    recordType: 'MessageOutbox',
    recordId: msg.id,
    actionLabel: 'Retry / call',
    priority: 2,
    dedupeKey,
  });
}

/** Reasons a queued message must not go out any more (checked again right before sending). */
async function cancelReason(msg: MessageOutbox): Promise<{ reason: string; errorClass: string } | null> {
  if (msg.patientId) {
    const p = await prisma.patient.findUnique({ where: { id: msg.patientId }, select: { whatsappConsent: true, whatsappOptOutAt: true } });
    if (!p || !p.whatsappConsent) return { reason: 'Patient ne WhatsApp consent nahi diya', errorClass: 'consent' };
    if (p.whatsappOptOutAt) return { reason: 'Patient opted out (STOP)', errorClass: 'opt_out' };
  }
  // A reminder for a procedure that was cancelled / rescheduled meanwhile is never sent (spec §19 "old reminder cancel").
  if (msg.template === 'procedure_reminder' && msg.relatedType === 'Appointment' && msg.relatedId) {
    const a = await prisma.appointment.findUnique({ where: { id: msg.relatedId }, select: { status: true } });
    if (!a || a.status !== 'CONFIRMED') return { reason: `Appointment ab active nahi (${a?.status.toLowerCase() ?? 'missing'})`, errorClass: 'superseded' };
  }
  return null;
}

export async function deliverMessage(msg: MessageOutbox, now = new Date()): Promise<void> {
  const cancel = await cancelReason(msg);
  if (cancel) {
    await prisma.messageOutbox.update({ where: { id: msg.id }, data: { status: 'CANCELLED', lastError: cancel.reason, errorClass: cancel.errorClass, terminal: true } });
    return;
  }
  const delayUntil = await quietHoursDelay(msg, now);
  if (delayUntil) {
    await prisma.messageOutbox.update({ where: { id: msg.id }, data: { status: 'QUEUED', nextAttemptAt: delayUntil, lastError: 'Quiet hours — baad mein jayega', errorClass: 'quiet_hours' } });
    return;
  }

  const providerId = await getSetting('whatsapp.provider');
  const provider = getProvider(providerId);
  const templates = await getSetting('whatsapp.templates');
  const senderNumber = await getSetting('whatsapp.senderNumber');
  const providerTemplate = templates[msg.template];
  const configError = !provider
    ? `WhatsApp provider "${providerId}" install nahi (Settings: whatsapp.provider)`
    : provider.id !== 'console' && !senderNumber.trim()
      ? 'Sender number set nahi (Settings: whatsapp.senderNumber)'
      : provider.requiresTemplates && !providerTemplate
        ? `Approved template mapping nahi: ${msg.template} (Settings: whatsapp.templates)`
        : null;
  if (configError) {
    await prisma.$transaction((tx) => markTerminal(tx, msg, { error: configError, errorClass: 'config', attempts: msg.retryCount + 1, now }));
    return;
  }

  let result: SendResult;
  try {
    result = await provider!.send(msg, { senderNumber, providerTemplate, variables: templateVariables(msg.template, msg.payload), text: renderMessage(msg.template, msg.payload) });
  } catch (err) {
    result = { ok: false, errorClass: 'transient', error: err instanceof Error ? err.message : String(err) };
  }

  if (result.ok) {
    const instant = provider!.id === 'console';
    await prisma.$transaction(async (tx) => {
      await tx.messageOutbox.update({
        where: { id: msg.id },
        data: {
          status: instant ? 'DELIVERED' : 'SENT',
          sentAt: now,
          deliveredAt: instant ? now : null,
          retryCount: msg.retryCount + 1,
          providerMessageId: result.providerMessageId ?? null,
          providerResponse: (result.response ?? {}) as Prisma.InputJsonValue,
          lastError: null,
          errorClass: null,
        },
      });
      await audit(tx, systemActor, { action: 'MESSAGE_SENT', recordType: 'MessageOutbox', recordId: msg.id, after: { template: msg.template, provider: provider!.id } });
    });
    return;
  }

  const maxRetries = await getSetting('notify.maxRetries');
  const base = await getSetting('notify.retryBaseSec');
  const attempts = msg.retryCount + 1;
  const terminal = result.errorClass === 'permanent' || attempts > maxRetries;
  await prisma.$transaction(async (tx) => {
    if (terminal) {
      await markTerminal(tx, msg, { error: result.error ?? 'delivery failed', errorClass: result.errorClass ?? 'transient', attempts, providerResponse: result.response ?? {}, now });
      return;
    }
    await tx.messageOutbox.update({
      where: { id: msg.id },
      data: { status: 'QUEUED', retryCount: attempts, nextAttemptAt: new Date(now.getTime() + base * 1000 * 2 ** (attempts - 1)), lastError: result.error ?? 'unknown', errorClass: result.errorClass ?? 'transient' },
    });
  });
}

export async function runOutboxOnce(workerId: string): Promise<number> {
  const msgs = await claimDueMessages(workerId);
  for (const m of msgs) {
    try {
      await deliverMessage(m);
    } catch (err) {
      logger.error({ err, id: m.id }, 'deliverMessage crashed; requeueing');
      await prisma.messageOutbox.update({ where: { id: m.id }, data: { status: 'QUEUED', nextAttemptAt: new Date(Date.now() + 60_000) } });
    }
  }
  return msgs.length;
}

/** Messages stuck in SENDING (worker crashed mid-send) are requeued after 5 minutes. */
export async function recoverStuckMessages(): Promise<void> {
  await prisma.messageOutbox.updateMany({
    where: { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
    data: { status: 'QUEUED' },
  });
}
